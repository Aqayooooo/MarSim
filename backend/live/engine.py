"""Silnik EVA na żywo (backend jest źródłem prawdy, UI tylko wyświetla).

Telemetria skafandrów: na razie z modelu (wysiłek → tlen, CO₂, bateria, tętno). Prawdziwy skafander wysyła te same pola
przez POST /api/telemetry — wtedy model jest pomijany dla tej osoby (pole `source`).
"""
from __future__ import annotations

import json
import math
import random
import threading
import time
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image

from backend import planning
from backend.live import report as report_mod
from backend.live import spaceweather
from backend.live.dtn import DtnLink
from backend.live.positioning import Positioner
from backend.live.schedule import Scheduler
from backend.live.store import Store
from backend.models import radiation, sun
from backend.models.physiology import Person, co2_l_per_min, heart_rate, metabolic_w, o2_l_per_min
from backend.pipeline.environment import surface_temperature


def _f32(p: Path, h: int, w: int) -> np.ndarray:
    return np.fromfile(p, dtype="<f4").reshape(h, w)


def _png(p: Path) -> np.ndarray:
    return np.array(Image.open(p))


class Polyline:
    def __init__(self, pts):
        self.pts = pts
        self.cum = [0.0]
        for a, b in zip(pts[:-1], pts[1:]):
            self.cum.append(self.cum[-1] + math.hypot(b["x"] - a["x"], b["y"] - a["y"]))
        self.length = self.cum[-1]

    def at(self, s: float) -> dict:
        s = max(0.0, min(self.length, s))
        lo, hi = 0, len(self.cum) - 1
        while hi - lo > 1:
            m = (lo + hi) // 2
            if self.cum[m] <= s:
                lo = m
            else:
                hi = m
        a, b = self.pts[lo], self.pts[min(lo + 1, len(self.pts) - 1)]
        seg = (self.cum[hi] - self.cum[lo]) or 1.0
        t = (s - self.cum[lo]) / seg
        return {"x": a["x"] + (b["x"] - a["x"]) * t, "y": a["y"] + (b["y"] - a["y"]) * t}

    def slice(self, s0: float, s1: float) -> list[dict]:
        out = [self.at(s0)] + [p for p, c in zip(self.pts, self.cum) if s0 < c < s1] + [self.at(s1)]
        return out


class EvaEngine:
    def __init__(self, mission_dir: Path, cfg: dict, store: Store | None = None, live_feeds: bool = True):
        self.dir = mission_dir
        self.cfg = cfg
        self.store = store or Store(":memory:")
        self.mission = json.loads((mission_dir / "mission.json").read_text(encoding="utf-8"))
        self.provenance = json.loads((mission_dir / "provenance.json").read_text(encoding="utf-8"))
        d = self.mission["dem"]
        H, W, self.cell = d["height"], d["width"], d["cellM"]
        self.dem = _f32(mission_dir / "dem.f32", H, W)
        self.layers = {
            "slope": _f32(mission_dir / "slope.f32", H, W), "slopeSigma": _f32(mission_dir / "slopeSigma.f32", H, W),
            "sand": _png(mission_dir / "sand.png") / 255.0, "sandConfidence": _png(mission_dir / "sandConfidence.png") / 255.0,
            "hazard": _png(mission_dir / "hazards.png"),
        }
        self.comms = _png(mission_dir / "comms.png")
        self.o2_home = _f32(mission_dir / "o2ToHabitat.f32", H, W)
        self._hazard0 = self.layers["hazard"].copy()   # mapa z potoku; zgłoszenia „bezpieczne” zmieniają tylko bieżącą sesję
        self.boulders = json.loads((mission_dir / "boulders.json").read_text(encoding="utf-8"))["boulders"]
        self.lat, self.lon = self.mission["area"]["center"]["lat"], self.mission["area"]["center"]["lon"]
        self.date = datetime.fromisoformat(cfg["missionDateUtc"].replace("Z", "+00:00"))
        self.mt = sun.mars_time(self.date)
        c0 = cfg["crew"][0]
        self._ref_mass_kg = c0["bodyKg"] + c0["loadKg"]   # pole o2ToHabitat policzono dla tej osoby
        self.model = self._cost_model()
        self.positioner = Positioner(cfg["uwbBeacons"], self.dem, self.cell)
        self.scheduler = Scheduler(self.store, cfg["crew"], cfg["habitatStores"], self.lat, self.mt.decl,
                                   o2_rate_lh=float(o2_l_per_min(metabolic_w(self.model_person(c0), 0.6, 3)) * 60 + 1.2))
        self.lock = threading.RLock()
        self.spaceweather = None
        if live_feeds:   # pogoda kosmiczna z sieci (w testach wyłączona)
            self._sw_thread = threading.Thread(target=self._refresh_spaceweather, daemon=True)
            self._sw_thread.start()
        self.reset()

    # ---------- pomocnicze ----------
    def model_person(self, c: dict) -> Person:
        return Person(c["id"], c["bodyKg"], c["loadKg"], c["o2CapacityL"], c["o2CapacityL"], battery_wh=c["batteryWh"],
                      battery_left_wh=c["batteryWh"], co2_capacity_l=c["co2CapacityL"], dose_msv=c["priorDoseMsv"])

    def _cost_model(self) -> planning.CostModel:
        return planning.CostModel(self.layers, self.cell, self.cfg["eva"], self.model_person(self.cfg["crew"][0]))

    def rc(self, p) -> tuple[int, int]:
        H, W = self.dem.shape
        return min(H - 1, max(0, int(p["y"] // self.cell))), min(W - 1, max(0, int(p["x"] // self.cell)))

    def _refresh_spaceweather(self):
        while True:
            try:
                self.spaceweather = spaceweather.get()
            except Exception as e:  # brak sieci nie może zatrzymać habitatu
                self.spaceweather = {"available": False, "summary": f"Błąd pobierania: {e}", "pfu": 0.0, "events": []}
            time.sleep(900)

    def dose_rate(self) -> float:
        pfu = self.sim_pfu if self.sep else 0.0
        return radiation.dose_rate_usv_h(pfu)

    def temperature_at(self, p: dict, ltst_h: float) -> float:
        i = self.rc(p)
        sand = self.layers["sand"][i]
        ti = 250 + (1 - sand) * 200           # piasek ~250, skała ~450 J m⁻² K⁻¹ s⁻½ (szacunek)
        albedo = 0.12 + (1 - sand) * 0.1
        return surface_temperature(ltst_h, self.lat, self.mt.decl, sun.solar_flux_top(self.mt.r_au), albedo, ti)

    def beacon_gap_m(self, path) -> float:
        gap = 0.0
        for a, b in zip(path[:-1], path[1:]):
            d = math.hypot(b["x"] - a["x"], b["y"] - a["y"])
            mid = {"x": (a["x"] + b["x"]) / 2, "y": (a["y"] + b["y"]) / 2}
            if sum(self.positioner._los(bc, mid) for bc in self.cfg["uwbBeacons"]) < 3:
                gap += d
        return gap

    # ---------- stan ----------
    def reset(self):
        with self.lock:
            if not np.array_equal(self.layers["hazard"], self._hazard0):   # nowa sesja: mapa zagrożeń bez zgłoszeń z poprzedniej
                self.layers["hazard"] = self._hazard0.copy()
                self.model = self._cost_model()
            self.start_min = int(self.cfg["startLtst"][:2]) * 60 + int(self.cfg["startLtst"][3:])
            self.t = 0.0                    # sekundy misji od startu
            self.running = False
            self.time_scale = 60.0
            self.route = None
            self.route_version = 0
            self.poly = None
            self.wp_s = []
            self.waypoints = list(self.cfg["waypoints"])   # punkty bieżącej trasy (POST /api/plan może podać własne)
            self.crew_s = 0.0
            self.gap = 14.0
            self.next_wp = 0
            self.stop_until = -1.0
            self.reached = []
            self.crew = [{"cfg": c, "person": self.model_person(c), "metabolic": 120.0, "co2mmHg": 0.8, "source": "model",
                          "moved": 0.0, "evaDoseUsv": 0.0, "est": None} for c in self.cfg["crew"]]
            self.rover = {"s": 0.0, "mode": "parked", "x": self.cfg["rover"]["x"], "y": self.cfg["rover"]["y"]}
            self.sep = False
            self.sim_pfu = 0.0
            self.alerts = []
            self.obstacles = []
            self.observations = []
            self.discarded = []
            self.fired = set()
            self.fired_at = {}
            self.scenario = False
            self.emergency = {}
            self._emerg_t = -1e9
            self.link = DtnLink(self.date)
            self.log = []
            session = self.store.new_session()
            self.add_log("EVA", f"Nowa sesja EVA nr {session}", to_earth=False)

    @property
    def clock_min(self) -> float:
        return self.start_min + self.t / 60

    def add_log(self, kind, text, meta=None, to_earth=True):
        entry = {"t": round(self.t), "clock": self.clock_str(), "kind": kind, "text": text, **({"meta": meta} if meta else {})}
        self.log.append(entry)
        self.store.log(kind, text, self.t, entry["clock"], meta)
        if to_earth:
            self.link.send(self.t, kind, text, meta, reply=f"Kontrola misji: przyjęto „{text[:60]}”")
        return entry

    def clock_str(self, m=None):
        m = self.clock_min if m is None else m
        return f"{int(m // 60) % 24:02d}:{int(m % 60):02d}"

    # ---------- trasa ----------
    def plan(self, start=None, waypoints=None, letter="A") -> dict:
        with self.lock:
            start = start or {"x": self.cfg["rover"]["x"], "y": self.cfg["rover"]["y"]}
            waypoints = waypoints or self.cfg["waypoints"]
            r = planning.plan(self.model, start, waypoints, self.obstacles, self.layers)
            if not r["ok"]:
                return r
            r["alternatives"] = planning.alternatives(self.model, start, waypoints, self.obstacles, self.layers, self.comms, r)
            self._set_route({**r, "letter": letter}, waypoints)
            self.add_log("trasa", f"Trasa {letter}: {r['lengthM']:.0f} m, {r['durationH'] * 60:.0f} min, {r['o2L']:.0f} L O₂, {r['rating']}")
            return self.route

    def _set_route(self, r, waypoints):
        self.route = r
        self.route_version += 1
        self.waypoints = list(waypoints)
        self.poly = Polyline(r["path"])
        self.wp_s = [self.poly.cum[i] for i in r["waypointIndex"]]

    def replan_from_crew(self, reason: str) -> dict | None:
        old = self.route
        if not old:
            return None
        pos = self.poly.at(self.crew_s)
        remaining = self.waypoints[self.next_wp:]
        if not remaining:
            return None
        r = planning.plan(self.model, pos, remaining, self.obstacles, self.layers)
        if not r["ok"]:
            self.alert("BRAK TRASY", r["error"])
            return None
        walked = self.poly.slice(0, self.crew_s)
        self.discarded.append(self.poly.slice(self.crew_s, self.poly.length))
        path = walked + r["path"][1:]
        off = len(walked) - 1
        idx = [min(range(len(walked)), key=lambda k: math.hypot(walked[k]["x"] - w["x"], walked[k]["y"] - w["y"])) for w in self.waypoints[:self.next_wp]]
        idx += [i + off for i in r["waypointIndex"]]
        stats = planning.path_stats(self.model, path, self.layers)
        letter = chr(ord(old["letter"]) + 1)
        stop_min = sum(w.get("stopMin", 0) for w in self.waypoints)
        new = {**r, "path": path, "waypointIndex": idx, "lengthM": stats["lengthM"], "durationH": stats["walkH"] + stop_min / 60,
               "o2L": stats["o2L"], "rating": stats["rating"], "uncertainty": stats["uncertainty"], "letter": letter,
               "replanFrom": self.crew_s, "deltaM": stats["lengthM"] - old["lengthM"]}
        self._set_route(new, self.waypoints)
        self.add_log("trasa", f"Nowa trasa {letter} ({reason}): {new['deltaM']:+.0f} m")
        return new

    # ---------- zdarzenia ----------
    def alert(self, category, text, source=None, highlight=None):
        a = {"category": category, "text": text, "source": source, "t": self.t, "clock": self.clock_str(), "highlight": highlight}
        self.alerts.append(a)
        self.add_log("alert", f"{category}: {text}")
        return a

    def add_observation(self, obs: dict) -> dict:
        """Zgłoszenie z terenu (załoga, łazik, dron): zmienia mapę zagrożeń i może wymusić nową trasę."""
        with self.lock:
            obs = {**obs, "id": len(self.observations) + 1, "t": self.t, "clock": self.clock_str()}
            self.observations.append(obs)
            self.store.add_observation(obs)
            kind = obs.get("kind", "glazy")
            r = float(obs.get("radiusM", 20))
            if kind in ("glazy", "piasek", "osuwisko", "inne"):
                self.obstacles.append({"x": obs["x"], "y": obs["y"], "radiusM": r, "kind": kind, "source": obs.get("source", "załoga")})
            elif kind == "bezpieczne":
                H, W = self.dem.shape
                yy, xx = (np.mgrid[0:H, 0:W] + 0.5) * self.cell
                m = np.hypot(xx - obs["x"], yy - obs["y"]) < r
                self.layers["hazard"][m & (self.layers["hazard"] == 1)] = 0
                self.model = self._cost_model()
            self.add_log("zgłoszenie", f"{obs.get('source', 'załoga')}: {kind} ({obs['x']:.0f}, {obs['y']:.0f}) r={r:.0f} m", obs)
            res = None
            if self.route and kind != "bezpieczne" and self._route_hits(obs["x"], obs["y"], r):
                res = self.replan_from_crew(f"zgłoszenie: {kind}")
            return {"observation": obs, "replanned": res is not None, "route": res}

    def _route_hits(self, x, y, r):
        ahead = Polyline(self.poly.slice(self.crew_s, self.poly.length))
        return any(math.hypot(ahead.at(s)["x"] - x, ahead.at(s)["y"] - y) < r + 6 for s in np.arange(0, ahead.length + 3, 3))

    def inject(self, kind: str):
        with self.lock:
            if kind == "boulders" and self.route:
                ev = next(e for e in self.mission["events"] if e["id"] == "boulders")
                p = self.poly.at(min(self.crew_s + ev["aheadM"], self.poly.length - ev["radiusM"] - 10))
                self.alert(ev["alert"]["category"], ev["alert"]["text"].replace("{dist}", str(ev["aheadM"])), ev["source"])
                return self.add_observation({"kind": "glazy", "x": p["x"], "y": p["y"], "radiusM": ev["radiusM"], "source": "dron"})
            if kind == "sep":
                self.sep = True
                self.sim_pfu = 500.0
                self.rover["mode"] = "toCrew"
                self.alert("POGODA KOSMICZNA", "ostrzeżenie SEP · łazik jedzie do załogi", "DONKI (symulacja zdarzenia)", highlight="dose")
                return {"ok": True}
            if kind == "sep-end":
                self.sep = False
                self.sim_pfu = 0.0
                self.add_log("alert", "Koniec alarmu SEP")
                return {"ok": True}
            if kind == "link-outage":
                self.link.outage_until_s = self.t + 1800
                self.add_log("łączność", "Przerwa łącza z Ziemią na 30 min", to_earth=False)
                return {"ok": True}
        return {"ok": False}

    # ---------- krok symulacji ----------
    def step(self, dt_real: float):
        with self.lock:
            delivered = self.link.step(self.t)
            for b in delivered:
                if b.direction == "z Ziemi":
                    self.log.append({"t": round(self.t), "clock": self.clock_str(), "kind": "z Ziemi", "text": b.text})
                    self.store.log("z Ziemi", b.text, self.t, self.clock_str())
            if not self.running:
                return
            dt = dt_real * self.time_scale
            self.t += dt
            dt_min = dt / 60
            # marsz
            if self.poly and self.t / 60 >= self.stop_until and self.next_wp < len(self.wp_s):
                p = self.poly.at(self.crew_s)
                i = self.rc(p)
                v = float(max(0.3, planning.walk_speed_ms(self.layers["slope"][i] + 2 * self.layers["slopeSigma"][i], self.cfg["eva"]["walkKmh"])))
                if self.layers["hazard"][i] == 1:
                    v /= 1.6
                target = self.wp_s[self.next_wp]
                adv = min(target - self.crew_s, v * dt)
                self.crew_s += adv
                for c in self.crew:
                    c["moved"] += adv
                if self.crew_s >= target - 0.01:
                    wp = self.waypoints[self.next_wp]
                    self.reached.append(wp["id"])
                    self.stop_until = self.t / 60 + wp.get("stopMin", 0)
                    self.next_wp += 1
                    self.add_log("punkt", f"{wp['id']} osiągnięty")
                walking = True
            else:
                walking = False
            # telemetria skafandrów (model)
            for k, c in enumerate(self.crew):
                if c["source"] != "model":
                    continue
                pers = c["person"]
                pos = self.crew_pos(k)
                i = self.rc(pos)
                slope = float(self.layers["slope"][i])
                terrain = "sand" if self.layers["sand"][i] > 0.35 else "rough" if self.layers["hazard"][i] == 1 else "rock"
                speed = float(planning.walk_speed_ms(slope, self.cfg["eva"]["walkKmh"])) if walking else 0.0
                met = float(metabolic_w(pers, speed, math.tan(math.radians(slope)) * 100, terrain)) * (1.12 if self.sep else 1.0)
                c["metabolic"] = met * (0.97 + 0.06 * random.random())
                pers.o2_l = max(0.0, pers.o2_l - (o2_l_per_min(c["metabolic"]) + pers.leak_l_min) * dt_min)
                pers.co2_absorbed_l += co2_l_per_min(c["metabolic"]) * dt_min
                sat = min(1.0, pers.co2_absorbed_l / pers.co2_capacity_l)
                c["co2mmHg"] = 0.6 + 7.0 * sat ** 4 + random.gauss(0, 0.05)
                pers.battery_left_wh = max(0.0, pers.battery_left_wh - (80 + 0.06 * c["metabolic"]) * dt / 3600)
                dose = self.dose_rate() * dt / 3600
                c["evaDoseUsv"] += dose
                pers.dose_msv += dose / 1000
            # łazik do załogi (SEP)
            if self.rover["mode"] == "toCrew" and self.poly:
                stop_at = self.crew_s - 110
                spd = self.cfg["rover"]["speedKmh"] / 3.6
                if self.rover["s"] < stop_at:
                    self.rover["s"] = min(stop_at, self.rover["s"] + spd * dt)
                rp = self.poly.at(self.rover["s"])
                self.rover.update(x=rp["x"], y=rp["y"])
            # scenariusz demonstracyjny
            if self.scenario:
                self._scenario()
            # trasy awaryjne co 2 min misji
            if self.t - self._emerg_t > 120:
                self._emerg_t = self.t
                self.emergency = self._emergency_routes()

    def _scenario(self):
        for ev in self.mission["events"]:
            if ev["id"] in self.fired:
                continue
            t = ev["trigger"]
            go = False
            if "afterWaypoint" in t and t["afterWaypoint"] in self.reached:
                i = [w["id"] for w in self.waypoints].index(t["afterWaypoint"])
                go = self.crew_s >= self.wp_s[i] + t.get("afterM", 0)
            if "afterEvent" in t and t["afterEvent"] in self.fired:
                go = self.t / 60 >= self.fired_at[t["afterEvent"]] + t.get("afterMin", 0)
            if go:
                self.fired.add(ev["id"])
                self.fired_at[ev["id"]] = self.t / 60
                self.inject("boulders" if ev["type"] == "obstacle" else "sep")

    def crew_pos(self, k: int) -> dict:
        if not self.poly:
            return {"x": self.cfg["rover"]["x"] + 5 * (k + 1), "y": self.cfg["rover"]["y"]}
        return self.poly.at(max(0.0, self.crew_s - k * self.gap))

    def _emergency_routes(self) -> dict:
        p = self.crew_pos(0)
        out = {}
        for name, tgt in (("habitat", self.cfg["habitat"]), ("rover", {"x": self.rover["x"], "y": self.rover["y"]})):
            r = planning.plan(self.model, p, [{"id": name, "x": tgt["x"], "y": tgt["y"], "stopMin": 0}], self.obstacles, self.layers)
            if r["ok"]:
                out[name] = {"path": r["path"], "lengthM": round(r["lengthM"]), "timeMin": round(r["durationH"] * 60), "o2L": round(r["o2L"], 1)}
        out["computedAt"] = self.clock_str()
        return out

    # ---------- odczyt stanu dla UI ----------
    def snapshot(self) -> dict:
        with self.lock:
            hour = self.clock_min / 60
            el, az = sun.sun_position(self.lat, self.mt.decl, hour)
            sunset = sun.sunset_ltst(self.lat, self.mt.decl)
            crew = []
            worst = None
            for k, c in enumerate(self.crew):
                pers, pos = c["person"], self.crew_pos(k)
                i = self.rc(pos)
                if int(self.t) % 2 == 0 or c["est"] is None:
                    c["est"] = self.positioner.estimate(c["cfg"]["id"], pos, c["moved"])
                need = float(self.o2_home[i]) * (pers.body_kg + pers.load_kg) / self._ref_mass_kg
                avail = pers.o2_l - self.cfg["eva"]["o2ReservePct"] / 100 * pers.o2_capacity_l
                rate_lh = (o2_l_per_min(c["metabolic"]) + pers.leak_l_min) * 60
                margin_h = (avail - need) / max(rate_lh, 1e-6)
                wb = {"needL": round(need, 1), "availL": round(avail, 1), "marginH": round(margin_h, 2), "ok": avail > need}
                if worst is None or margin_h < worst:
                    worst = margin_h
                crew.append({"id": c["cfg"]["id"], "x": round(pos["x"], 1), "y": round(pos["y"], 1), "est": c["est"], "source": c["source"],
                             "o2Pct": round(pers.o2_l / pers.o2_capacity_l * 100, 1), "o2L": round(pers.o2_l, 1),
                             "co2mmHg": round(c["co2mmHg"], 2), "batteryPct": round(pers.battery_left_wh / pers.battery_wh * 100, 1),
                             "pressureKPa": round(29.6 + random.gauss(0, 0.04), 2), "suitTempC": round(20.5 + (c["metabolic"] - 200) / 120 + random.gauss(0, 0.1), 1),
                             "hr": int(heart_rate(c["metabolic"]) + random.gauss(0, 1.5)), "metabolicW": round(c["metabolic"]),
                             "evaDoseUsv": round(c["evaDoseUsv"], 1), "career": radiation.limit_status(pers.dose_msv), "walkback": wb,
                             "comms": int(self.comms[i]), "zone": int(self.layers["hazard"][i])})
            pos0 = self.crew_pos(0)
            sw = self.spaceweather or {}
            return {
                "t": round(self.t, 1), "clockMin": self.clock_min, "clock": self.clock_str(), "sol": self.cfg["sol"], "running": self.running,
                "timeScale": self.time_scale, "routeVersion": self.route_version, "crewS": round(self.crew_s, 2), "gap": self.gap,
                "nextWp": self.next_wp, "reached": self.reached, "sep": self.sep, "crew": crew,
                "rover": {"x": round(self.rover["x"], 1), "y": round(self.rover["y"], 1), "s": round(self.rover["s"], 1), "mode": self.rover["mode"]},
                "reserveH": round(worst if worst is not None else 0, 2),
                "env": {"doseUsvh": round(self.dose_rate(), 1), "windMs": round(6 + 1.5 * math.sin(self.t / 300) + random.gauss(0, 0.3), 1),
                        "groundTempC": round(self.temperature_at(pos0, hour) - 273.15, 1), "tau": 0.5,
                        "sunElevDeg": round(el, 1), "sunAzDeg": round(az, 1), "daylightLeftH": round(sunset - hour, 2), "sunsetLtst": round(sunset, 2)},
                "spaceWeather": {"pfuEarth": sw.get("pfu"), "level": sw.get("stormLevel"), "summary": sw.get("summary"), "source": sw.get("source"),
                                 "simulatedPfu": self.sim_pfu if self.sep else 0},
                "alerts": self.alerts[-3:], "obstacles": self.obstacles, "observations": self.observations[-20:],
                "emergency": self.emergency, "link": self.link.status(self.t), "log": self.log[-30:],
            }
