"""Silnik EVA na żywo (backend jest źródłem prawdy, UI tylko wyświetla).

Telemetria skafandrów pochodzi z modelu (wysiłek → tlen, CO₂, bateria, tętno). Prawdziwy skafander wysyła te same
pola przez POST /api/telemetry — wtedy model jest pomijany dla tej osoby (pole `source`).

Fazy wyjścia (pole `phase` w stanie): idle → walking/stop → atTarget → returning → done.
"""

from __future__ import annotations

import json
import logging
import math
import random
import threading
import time
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image

from backend import planning
from backend.live import checkpoint, spaceweather
from backend.live.dtn import FROM_EARTH, DtnLink
from backend.live.positioning import Positioner
from backend.live.schedule import Scheduler
from backend.live.store import Store
from backend.models import radiation, sun
from backend.models.physiology import Person, co2_l_per_min, heart_rate, metabolic_w, o2_l_per_min
from backend.pipeline.environment import surface_temperature

log = logging.getLogger("marsim.engine")
MAX_SUBSTEP_S = 10.0  # najdłuższy krok fizyki; przy dużym przyspieszeniu czasu krok jest dzielony
EMERGENCY_REFRESH_S = 120.0  # co ile sekund misji przeliczamy trasy awaryjne
TELEMETRY_TTL_S = 60.0  # po tym czasie bez nowych pomiarów wracamy do modelu
POSITION_REFRESH_S = 2.0
SPACEWEATHER_REFRESH_S = 900
LINK_OUTAGE_S = 1800.0
SEP_SIM_PFU = 500.0  # strumień protonów w symulowanym zdarzeniu SEP (burza S2)
SEP_EFFORT_FACTOR = 1.12  # pośpiech do schronu: większy wysiłek
ROVER_STANDOFF_M = 110.0  # łazik zatrzymuje się tyle metrów za załogą
CREW_SPACING_M = 14.0
WALKBACK_WARNING_H = 0.25  # ostrzeżenie, gdy zapas czasu na powrót pieszo spada poniżej 15 min
SUIT_BASE_POWER_W = 80.0
SUIT_PRESSURE_KPA = 29.6
HABITAT_ID = "HAB"
CHECKPOINT_INTERVAL_S = 5.0  # co ile sekund (czas rzeczywisty) trwające wyjście trafia do bazy


def _f32(p: Path, h: int, w: int) -> np.ndarray:
    return np.fromfile(p, dtype="<f4").reshape(h, w)


def _png(p: Path) -> np.ndarray:
    return np.array(Image.open(p))


def _next_letter(letter: str) -> str:
    """A → B → … → Z → A."""
    return chr((ord(letter) - ord("A") + 1) % 26 + ord("A"))


class Polyline:
    """Łamana z długością narastającą: położenie w odległości s od początku."""

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
        return [self.at(s0)] + [p for p, c in zip(self.pts, self.cum) if s0 < c < s1] + [self.at(s1)]


class EvaEngine:
    def __init__(self, mission_dir: Path, cfg: dict, store: Store | None = None, live_feeds: bool = True, seed: int | None = None):
        """seed: ziarno szumu czujników (testy i powtarzalne pokazy); None — losowe."""
        self.dir = mission_dir
        self.cfg = cfg
        self.store = store or Store(":memory:")
        self.rng = random.Random(seed)
        self.mission = json.loads((mission_dir / "mission.json").read_text(encoding="utf-8"))
        self.provenance = json.loads((mission_dir / "provenance.json").read_text(encoding="utf-8"))
        dem = self.mission["dem"]
        rows, cols, self.cell = dem["height"], dem["width"], dem["cellM"]
        self.dem = _f32(mission_dir / "dem.f32", rows, cols)
        self.layers = {
            "slope": _f32(mission_dir / "slope.f32", rows, cols),
            "slopeSigma": _f32(mission_dir / "slopeSigma.f32", rows, cols),
            "sand": _png(mission_dir / "sand.png") / 255.0,
            "sandConfidence": _png(mission_dir / "sandConfidence.png") / 255.0,
            "hazard": _png(mission_dir / "hazards.png"),
        }
        self.comms = _png(mission_dir / "comms.png")
        self._hazard0 = self.layers["hazard"].copy()  # mapa z potoku; zgłoszenia „bezpieczne” zmieniają tylko bieżącą sesję
        self.boulders = json.loads((mission_dir / "boulders.json").read_text(encoding="utf-8"))["boulders"]
        self.lat, self.lon = self.mission["area"]["center"]["lat"], self.mission["area"]["center"]["lon"]
        self.date = datetime.fromisoformat(cfg["missionDateUtc"].replace("Z", "+00:00"))
        self.mt = sun.mars_time(self.date)
        reference = cfg["crew"][0]
        self._ref_mass_kg = reference["bodyKg"] + reference["loadKg"]  # pole kosztu powrotu liczymy dla tej osoby
        self.model = self._cost_model()
        self.positioner = Positioner(cfg["uwbBeacons"], self.dem, self.cell, rng=self.rng)
        typical_o2_lh = float(o2_l_per_min(metabolic_w(self.model_person(reference), 0.6, 3))) * 60 + 1.2
        self.scheduler = Scheduler(
            self.store,
            cfg["crew"],
            cfg["habitatStores"],
            self.lat,
            self.mt.decl,
            o2_rate_lh=typical_o2_lh,
            first_sol=cfg["sol"],
            start_ltst=cfg["startLtst"],
        )
        self.lock = threading.RLock()
        self.spaceweather = None
        if live_feeds:  # pogoda kosmiczna z sieci (w testach wyłączona)
            threading.Thread(target=self._refresh_spaceweather, daemon=True).start()
        self.resumed = False  # wyjście odtworzone z punktu kontrolnego po restarcie serwera
        self._checkpoint_at = 0.0
        saved = self.store.checkpoint_load()
        if not (checkpoint.usable(saved, cfg["id"]) and self._resume(saved)):
            self.reset()

    # ---------- pomocnicze ----------
    def model_person(self, c: dict) -> Person:
        return Person(
            c["id"],
            c["bodyKg"],
            c["loadKg"],
            c["o2CapacityL"],
            c["o2CapacityL"],
            battery_wh=c["batteryWh"],
            battery_left_wh=c["batteryWh"],
            co2_capacity_l=c["co2CapacityL"],
            dose_msv=c["priorDoseMsv"],
        )

    def _cost_model(self) -> planning.CostModel:
        return planning.CostModel(self.layers, self.cell, self.cfg["eva"], self.model_person(self.cfg["crew"][0]))

    def rc(self, p) -> tuple[int, int]:
        rows, cols = self.dem.shape
        return min(rows - 1, max(0, int(p["y"] // self.cell))), min(cols - 1, max(0, int(p["x"] // self.cell)))

    def _refresh_spaceweather(self):
        while True:
            try:
                self.spaceweather = spaceweather.get()
            except Exception as e:  # brak sieci nie może zatrzymać habitatu
                self.spaceweather = {"available": False, "summary": f"Błąd pobierania: {e}", "pfu": 0.0, "events": []}
            time.sleep(SPACEWEATHER_REFRESH_S)

    def dose_rate(self) -> float:
        return radiation.dose_rate_usv_h(self.sim_pfu if self.sep else 0.0)

    def temperature_at(self, p: dict, ltst_h: float) -> float:
        sand = self.layers["sand"][self.rc(p)]
        thermal_inertia = 250 + (1 - sand) * 200  # piasek ~250, skała ~450 J m⁻² K⁻¹ s⁻½ (szacunek)
        albedo = 0.12 + (1 - sand) * 0.1
        return surface_temperature(ltst_h, self.lat, self.mt.decl, sun.solar_flux_top(self.mt.r_au), albedo, thermal_inertia)

    def beacon_gap_m(self, path) -> float:
        """Długość trasy, na której widać mniej niż 3 nadajniki UWB (pozycja tylko z odometrii)."""
        gap = 0.0
        for a, b in zip(path[:-1], path[1:]):
            mid = {"x": (a["x"] + b["x"]) / 2, "y": (a["y"] + b["y"]) / 2}
            if sum(self.positioner.line_of_sight(beacon, mid) for beacon in self.cfg["uwbBeacons"]) < 3:
                gap += math.hypot(b["x"] - a["x"], b["y"] - a["y"])
        return gap

    # ---------- stan ----------
    def reset(self):
        """Nowa sesja EVA: czysty stan, nowy numer sesji w dzienniku."""
        with self.lock:
            self._clear()
            self.resumed = False
            self.store.checkpoint_clear()
            session = self.store.new_session()
            self.add_log("EVA", f"Nowa sesja EVA nr {session}", to_earth=False)

    def _resume(self, saved: dict) -> bool:
        """Odtwarza wyjście przerwane restartem serwera. Zwraca False, gdy punkt kontrolny jest nie do użycia."""
        with self.lock:
            self._clear()
            try:
                checkpoint.restore(self, saved)
            except (KeyError, TypeError, ValueError, IndexError) as e:
                log.warning("Punkt kontrolny EVA odrzucony: %s", e)
                return False
            self.store.resume_session(saved["session"])
            self.resumed = True
            self.add_log("EVA", f"Wznowiono sesję EVA nr {saved['session']} po restarcie serwera (wstrzymana)", to_earth=False)
            return True

    def save_checkpoint(self):
        """Zapisuje trwające wyjście do bazy; po zakończeniu albo przed startem nie ma czego wznawiać."""
        with self.lock:
            self._checkpoint_at = time.monotonic()
            if self.finished or self.t <= 0 or not self.route:
                self.store.checkpoint_clear()
            else:
                self.store.checkpoint_save(checkpoint.capture(self))

    def rebuild_hazards(self):
        """Mapa zagrożeń z potoku + zgłoszenia „bezpieczne” z bieżącej sesji; przelicza model kosztu i pole powrotu."""
        self.layers["hazard"] = self._hazard0.copy()
        for obs in self.observations:
            if obs.get("kind") == "bezpieczne":
                self._mark_safe(obs)
        self.model = self._cost_model()
        self.o2_home = planning.cost_field(self.model, self.cfg["habitat"], "o2", self.obstacles)

    def _mark_safe(self, obs: dict):
        yy, xx = (np.mgrid[0 : self.dem.shape[0], 0 : self.dem.shape[1]] + 0.5) * self.cell
        inside = np.hypot(xx - obs["x"], yy - obs["y"]) < float(obs.get("radiusM", 20))
        self.layers["hazard"][inside & (self.layers["hazard"] == 1)] = 0

    def _clear(self):
        with self.lock:
            if not np.array_equal(self.layers["hazard"], self._hazard0):  # nowa sesja: mapa zagrożeń bez zgłoszeń z poprzedniej
                self.layers["hazard"] = self._hazard0.copy()
                self.model = self._cost_model()
            self.o2_home = planning.cost_field(self.model, self.cfg["habitat"], "o2")
            self.start_min = int(self.cfg["startLtst"][:2]) * 60 + int(self.cfg["startLtst"][3:])
            self.t = 0.0  # sekundy misji od startu
            self.running = False
            self.finished = False  # załoga wróciła do habitatu
            self.returning = False  # trwa powrót do habitatu
            self.route_blocked = False
            self.time_scale = 60.0
            self.route = None
            self.route_version = 0
            self.poly = None
            self.wp_s = []
            self.waypoints = list(self.cfg["waypoints"])  # punkty bieżącej trasy (POST /api/plan może podać własne)
            self.crew_s = 0.0
            self.gap = CREW_SPACING_M
            self.next_wp = 0
            self.stop_until = -1.0  # minuta misji, do której trwa postój
            self.reached = []
            self.crew = [
                {
                    "cfg": c,
                    "person": self.model_person(c),
                    "metabolic": 120.0,
                    "co2mmHg": 0.8,
                    "source": "model",
                    "moved": 0.0,
                    "evaDoseUsv": 0.0,
                    "est": None,
                    "sensors": {"pressureKPa": SUIT_PRESSURE_KPA, "suitTempC": 0.0, "hr": 0.0},
                }
                for c in self.cfg["crew"]
            ]
            self.rover = {"s": 0.0, "mode": "parked", "x": self.cfg["rover"]["x"], "y": self.cfg["rover"]["y"]}
            self.sep = False
            self.sim_pfu = 0.0
            self.wind_noise = 0.0
            self.alerts = []
            self._warned = set()  # ostrzeżenia o tlenie już wysłane w tej sesji
            self.obstacles = []
            self.positioner.reset()
            self.observations = []
            self.discarded = []
            self.fired = set()
            self.fired_at = {}
            self.scenario = False
            self.emergency = {}
            self._emerg_t = -1e9
            self.link = DtnLink(self.date)
            self.log = []

    @property
    def clock_min(self) -> float:
        return self.start_min + self.t / 60

    @property
    def phase(self) -> str:
        if self.finished:
            return "done"
        if not self.route or (self.t == 0 and not self.running):
            return "idle"
        if self.next_wp >= len(self.wp_s):
            return "atTarget"
        if self.returning:
            return "returning"
        return "stop" if self.t / 60 < self.stop_until else "walking"

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

    # ---------- sterowanie ----------
    def start(self, time_scale: float | None = None, scenario: bool | None = None) -> str | None:
        """Rusza (albo wznawia) EVA. Zwraca opis przeszkody albo None, gdy się udało."""
        with self.lock:
            if self.finished:
                return "EVA jest zakończona. Zresetuj symulację, aby zacząć nowe wyjście."
            if not self.route:
                planned = self.plan()
                if not planned["ok"]:
                    return planned["error"]
            if self.route_blocked:
                return "Trasa jest zablokowana. Wyznacz nową trasę."
            self.running = True
            if time_scale is not None:
                self.time_scale = time_scale
            if scenario is not None:
                self.scenario = scenario
            self.add_log("EVA", f"Start EVA ×{self.time_scale:.0f}")
            return None

    def pause(self):
        with self.lock:
            self.running = False
            self.save_checkpoint()

    def apply_telemetry(self, crew_id: str, values: dict) -> bool:
        """Pomiary z prawdziwego skafandra zastępują model dla tej osoby. False: nie ma takiej osoby."""
        with self.lock:
            member = next((c for c in self.crew if c["cfg"]["id"] == crew_id), None)
            if member is None:
                return False
            member["source"] = "skafander"
            member.setdefault("telemetry", {}).update(values)
            member.setdefault("telemetryTimes", {}).update(dict.fromkeys(values, self.t))
            member["telemetryAt"] = self.t
            person = member["person"]
            if "o2L" in values:
                person.o2_l = min(values["o2L"], person.o2_capacity_l)
            if "co2mmHg" in values:
                member["co2mmHg"] = values["co2mmHg"]
            if "batteryPct" in values:
                person.battery_left_wh = person.battery_wh * values["batteryPct"] / 100
            return True

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
            self.returning = False
            self.add_log(
                "trasa", f"Trasa {letter}: {r['lengthM']:.0f} m, {r['durationH'] * 60:.0f} min, {r['o2L']:.0f} L O₂, {r['rating']}"
            )
            return self.route

    def _set_route(self, r, waypoints):
        self.route = r
        self.route_blocked = False
        self.route_version += 1
        r["version"] = self.route_version
        r["waypointIds"] = [w["id"] for w in waypoints]
        self.waypoints = list(waypoints)
        self.poly = Polyline(r["path"])
        self.wp_s = [self.poly.cum[i] for i in r["waypointIndex"]]

    def _extend_route(self, onward: dict, remaining: list[dict], reason: str) -> dict:
        """Skleja przebytą część trasy z nowym planem od pozycji załogi. `remaining`: punkty jeszcze do odwiedzenia."""
        old = self.route
        walked = self.poly.slice(0, self.crew_s)
        self.discarded.append(self.poly.slice(self.crew_s, self.poly.length))
        done = self.waypoints[: self.next_wp]
        nearest = [min(range(len(walked)), key=lambda k: math.hypot(walked[k]["x"] - w["x"], walked[k]["y"] - w["y"])) for w in done]
        path = walked + onward["path"][1:]
        stats = planning.path_stats(self.model, path, self.layers)
        waypoints = done + remaining
        letter = _next_letter(old["letter"])
        new = {
            **onward,
            "path": path,
            "waypointIndex": nearest + [i + len(walked) - 1 for i in onward["waypointIndex"]],
            "lengthM": stats["lengthM"],
            "stops": sum(w["id"] != HABITAT_ID for w in waypoints),
            "durationH": stats["walkH"] + sum(w.get("stopMin", 0) for w in waypoints) / 60,
            "o2L": onward["o2L"] + planning.path_stats(self.model, walked, self.layers)["o2L"],
            "rating": stats["rating"],
            "uncertainty": stats["uncertainty"],
            "letter": letter,
            "replanFrom": self.crew_s,
            "deltaM": stats["lengthM"] - old["lengthM"],
        }
        self._set_route(new, waypoints)
        self.add_log("trasa", f"Nowa trasa {letter} ({reason}): {new['deltaM']:+.0f} m")
        return new

    def replan_from_crew(self, reason: str) -> dict | None:
        """Nowa trasa od bieżącej pozycji załogi do pozostałych punktów (np. po zgłoszeniu przeszkody)."""
        remaining = self.waypoints[self.next_wp :]
        if not self.route or not remaining:
            return None
        onward = planning.plan(self.model, self.poly.at(self.crew_s), remaining, self.obstacles, self.layers)
        if not onward["ok"]:
            self.route_blocked = True
            self.alert("BRAK TRASY", onward["error"])
            return None
        return self._extend_route(onward, remaining, reason)

    def return_to_habitat(self) -> dict:
        """Powrót: trasa od pozycji załogi do habitatu. EVA kończy się po dojściu do śluzy."""
        with self.lock:
            if not self.route:
                return {"ok": False, "error": "Brak trasy — najpierw wyznacz trasę."}
            if self.finished:
                return {"ok": False, "error": "EVA jest zakończona. Zresetuj symulację, aby zacząć nowe wyjście."}
            if self.returning:
                return {"ok": False, "error": "Powrót do habitatu już trwa."}
            habitat = {"id": HABITAT_ID, "x": self.cfg["habitat"]["x"], "y": self.cfg["habitat"]["y"], "stopMin": 0}
            onward = planning.plan(self.model, self.poly.at(self.crew_s), [habitat], self.obstacles, self.layers)
            if not onward["ok"]:
                self.alert("BRAK TRASY", onward["error"])
                return onward
            route = self._extend_route(onward, [habitat], "powrót do habitatu")
            self.returning = True
            self.stop_until = -1.0
            return route

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
            radius = float(obs.get("radiusM", 20))
            source = obs.get("source", "załoga")
            if kind == "bezpieczne":
                self._mark_safe(obs)
                self.model = self._cost_model()
            else:
                self.obstacles.append({"x": obs["x"], "y": obs["y"], "radiusM": radius, "kind": kind, "source": source})
            self.o2_home = planning.cost_field(self.model, self.cfg["habitat"], "o2", self.obstacles)
            self.add_log("zgłoszenie", f"{source}: {kind} ({obs['x']:.0f}, {obs['y']:.0f}) r={radius:.0f} m", obs)
            route = None
            if self.route and kind != "bezpieczne" and self._route_hits(obs["x"], obs["y"], radius):
                route = self.replan_from_crew(f"zgłoszenie: {kind}")
            return {"observation": obs, "replanned": route is not None, "route": route}

    def _route_hits(self, x, y, radius) -> bool:
        """Czy przeszkoda (z zapasem) leży na trasie przed załogą."""
        ahead = Polyline(self.poly.slice(self.crew_s, self.poly.length))
        reach = radius + planning.OBSTACLE_BUFFER_M
        return any(math.hypot(p["x"] - x, p["y"] - y) < reach for p in map(ahead.at, np.arange(0, ahead.length + 3, 3)))

    def inject(self, kind: str) -> dict:
        """Zdarzenie pokazowe: głazy na trasie, burza słoneczna (SEP), jej koniec albo przerwa łącza z Ziemią."""
        with self.lock:
            if kind == "boulders":
                return self._inject_boulders()
            if kind == "sep":
                self.sep = True
                self.sim_pfu = SEP_SIM_PFU
                self.rover["mode"] = "toCrew"
                self.alert("POGODA KOSMICZNA", "ostrzeżenie SEP · łazik jedzie do załogi", "DONKI (symulacja zdarzenia)", highlight="dose")
            elif kind == "sep-end":
                self.sep = False
                self.sim_pfu = 0.0
                self.add_log("alert", "Koniec alarmu SEP")
            elif kind == "link-outage":
                self.link.start_outage(self.t, LINK_OUTAGE_S)
                self.add_log("łączność", f"Przerwa łącza z Ziemią na {LINK_OUTAGE_S / 60:.0f} min", to_earth=False)
            else:
                return {"ok": False, "error": f"Nieznane zdarzenie: {kind}"}
            return {"ok": True}

    def _inject_boulders(self) -> dict:
        event = next((e for e in self.mission["events"] if e["id"] == "boulders"), None)
        if event is None:
            return {"ok": False, "error": "Ta misja nie ma zdarzenia „głazy”"}
        if not self.route or self.next_wp >= len(self.wp_s):
            return {"ok": False, "error": "Zdarzenie wymaga trasy z punktem przed załogą"}
        ahead_s = min(self.crew_s + event["aheadM"], self.poly.length - event["radiusM"] - 10)
        p = self.poly.at(max(ahead_s, self.crew_s))
        self.alert(event["alert"]["category"], event["alert"]["text"].replace("{dist}", str(event["aheadM"])), event["source"])
        return self.add_observation({"kind": "glazy", "x": p["x"], "y": p["y"], "radiusM": event["radiusM"], "source": "dron"})

    # ---------- krok symulacji ----------
    def step(self, dt_real: float):
        """Przesuwa symulację o dt_real sekund czasu rzeczywistego (× przyspieszenie)."""
        with self.lock:
            self._receive_from_earth()
            if not self.running:
                return
            remaining = dt_real * self.time_scale
            while remaining > 1e-9 and self.running:
                dt = min(remaining, MAX_SUBSTEP_S)
                remaining -= dt
                self.t += dt
                walking = self._advance_crew(dt)
                self._update_suits(dt, walking)
                self._advance_rover(dt)
                self._check_oxygen()
                if self.scenario:
                    self._scenario()
            if self.t - self._emerg_t > EMERGENCY_REFRESH_S:
                self._emerg_t = self.t
                self.emergency = self._emergency_routes()
            if self.finished or time.monotonic() - self._checkpoint_at > CHECKPOINT_INTERVAL_S:
                self.save_checkpoint()

    def _receive_from_earth(self):
        for bundle in self.link.step(self.t):
            if bundle.direction == FROM_EARTH:
                self.log.append({"t": round(self.t), "clock": self.clock_str(), "kind": FROM_EARTH, "text": bundle.text})
                self.store.log(FROM_EARTH, bundle.text, self.t, self.clock_str())

    def _advance_crew(self, dt: float) -> bool:
        """Marsz do następnego punktu. Zwraca True, gdy załoga w tym kroku szła."""
        if self.route_blocked or not self.poly or self.t / 60 < self.stop_until or self.next_wp >= len(self.wp_s):
            return False
        cell = self.rc(self.poly.at(self.crew_s))
        slope_up = self.layers["slope"][cell] + 2 * self.layers["slopeSigma"][cell]
        speed = max(0.3, float(planning.walk_speed_ms(slope_up, self.cfg["eva"]["walkKmh"])))
        if self.layers["hazard"][cell] == 1:
            speed /= planning.CAUTION_FACTOR
        target = self.wp_s[self.next_wp]
        advance = min(target - self.crew_s, speed * dt)
        self.crew_s += advance
        for member in self.crew:
            member["moved"] += advance
        if self.crew_s >= target - 0.01:
            self._arrive(self.waypoints[self.next_wp])
        return True

    def _arrive(self, wp: dict):
        self.reached.append(wp["id"])
        self.stop_until = self.t / 60 + wp.get("stopMin", 0)
        self.next_wp += 1
        if wp["id"] == HABITAT_ID and self.returning:
            used = max(c["cfg"]["o2CapacityL"] - c["person"].o2_l for c in self.crew)
            self.running = False
            self.returning = False
            self.finished = True
            self.add_log("EVA", f"EVA zakończona: załoga w habitacie po {self.t / 60:.0f} min, zużycie O₂ do {used:.0f} L")
        elif self.next_wp >= len(self.wp_s):
            self.add_log("punkt", f"{wp['id']} osiągnięty — cel wyjścia, czas zaplanować powrót")
        else:
            self.add_log("punkt", f"{wp['id']} osiągnięty")

    def _update_suits(self, dt: float, walking: bool):
        """Model skafandra: wysiłek → tlen, CO₂, bateria, dawka. Pomiary z prawdziwego skafandra mają pierwszeństwo."""
        dt_min = dt / 60
        dose = self.dose_rate() * dt / 3600
        self.wind_noise = self.rng.gauss(0, 0.3)
        for k, member in enumerate(self.crew):
            times = member.get("telemetryTimes", {})
            measured = {
                key: value for key, value in member.get("telemetry", {}).items() if self.t - times.get(key, -1e9) <= TELEMETRY_TTL_S
            }
            member["telemetry"] = measured
            if not measured:
                member["source"] = "model"
            person = member["person"]
            cell = self.rc(self.crew_pos(k))
            slope = float(self.layers["slope"][cell])
            if self.layers["sand"][cell] > planning.SAND_TERRAIN_THRESHOLD:
                terrain = "sand"
            else:
                terrain = "rough" if self.layers["hazard"][cell] == 1 else "rock"
            speed = float(planning.walk_speed_ms(slope, self.cfg["eva"]["walkKmh"])) if walking else 0.0
            effort = float(metabolic_w(person, speed, math.tan(math.radians(slope)) * 100, terrain))
            if self.sep:
                effort *= SEP_EFFORT_FACTOR
            member["metabolic"] = effort * (0.97 + 0.06 * self.rng.random())
            person.co2_absorbed_l += co2_l_per_min(member["metabolic"]) * dt_min
            if "o2L" not in measured:
                person.o2_l = max(0.0, person.o2_l - (o2_l_per_min(member["metabolic"]) + person.leak_l_min) * dt_min)
            if "batteryPct" not in measured:
                person.battery_left_wh = max(0.0, person.battery_left_wh - (SUIT_BASE_POWER_W + 0.06 * member["metabolic"]) * dt / 3600)
            if "co2mmHg" not in measured:
                saturation = min(1.0, person.co2_absorbed_l / person.co2_capacity_l)
                member["co2mmHg"] = 0.6 + 7.0 * saturation**4 + self.rng.gauss(0, 0.05)
            member["sensors"] = {
                "pressureKPa": SUIT_PRESSURE_KPA + self.rng.gauss(0, 0.04),
                "suitTempC": self.rng.gauss(0, 0.1),
                "hr": self.rng.gauss(0, 1.5),
            }
            member["evaDoseUsv"] += dose
            person.dose_msv += dose / 1000

    def _advance_rover(self, dt: float):
        """Podczas alarmu SEP łazik jedzie trasą załogi i staje tuż za nią."""
        if self.rover["mode"] != "toCrew" or not self.poly:
            return
        stop_at = self.crew_s - ROVER_STANDOFF_M
        if self.rover["s"] < stop_at:
            self.rover["s"] = min(stop_at, self.rover["s"] + self.cfg["rover"]["speedKmh"] / 3.6 * dt)
        position = self.poly.at(self.rover["s"])
        self.rover.update(x=position["x"], y=position["y"])

    def _walkback(self, member: dict, pos: dict) -> dict:
        """Tlen potrzebny na powrót pieszo do habitatu wobec zapasu ponad rezerwę."""
        person = member["person"]
        need = float(self.o2_home[self.rc(pos)]) * (person.body_kg + person.load_kg) / self._ref_mass_kg
        available = person.o2_l - self.cfg["eva"]["o2ReservePct"] / 100 * person.o2_capacity_l
        rate_lh = (o2_l_per_min(member["metabolic"]) + person.leak_l_min) * 60
        return {"needL": need, "availL": available, "marginH": (available - need) / max(rate_lh, 1e-6), "ok": available > need}

    def _warn_once(self, key: tuple, text: str):
        if key not in self._warned:
            self._warned.add(key)
            self.alert("TLEN", text, highlight="o2")

    def _check_oxygen(self):
        """Alarmy tlenu: mały zapas na powrót pieszo, brak zapasu na powrót, zejście poniżej rezerwy."""
        reserve_pct = self.cfg["eva"]["o2ReservePct"]
        for k, member in enumerate(self.crew):
            who = member["cfg"]["id"]
            person = member["person"]
            walkback = self._walkback(member, self.crew_pos(k))
            if person.o2_l <= reserve_pct / 100 * person.o2_capacity_l:
                self._warn_once((who, "reserve"), f"{who}: tlen poniżej rezerwy {reserve_pct}%")
            elif not walkback["ok"]:
                self._warn_once((who, "noReturn"), f"{who}: za mało tlenu na powrót pieszo — wezwij łazik")
            elif walkback["marginH"] < WALKBACK_WARNING_H:
                self._warn_once((who, "margin"), f"{who}: zapas na powrót pieszo poniżej {WALKBACK_WARNING_H * 60:.0f} min — zawróć")

    def _scenario(self):
        """Scenariusz pokazowy z mission.json: zdarzenia po punkcie trasy albo po innym zdarzeniu."""
        for event in self.mission["events"]:
            if event["id"] in self.fired:
                continue
            trigger = event["trigger"]
            due = False
            if trigger.get("afterWaypoint") in self.reached:
                index = [w["id"] for w in self.waypoints].index(trigger["afterWaypoint"])
                due = self.crew_s >= self.wp_s[index] + trigger.get("afterM", 0)
            if trigger.get("afterEvent") in self.fired:
                due = self.t / 60 >= self.fired_at[trigger["afterEvent"]] + trigger.get("afterMin", 0)
            if due:
                self.fired.add(event["id"])
                self.fired_at[event["id"]] = self.t / 60
                self.inject("boulders" if event["type"] == "obstacle" else "sep")

    def crew_pos(self, k: int) -> dict:
        measured = self.crew[k].get("telemetry", {})
        if "x" in measured and "y" in measured:
            return {"x": measured["x"], "y": measured["y"]}
        if not self.poly:
            return {"x": self.cfg["rover"]["x"] + 5 * (k + 1), "y": self.cfg["rover"]["y"]}
        return self.poly.at(max(0.0, self.crew_s - k * self.gap))

    def _emergency_routes(self) -> dict:
        """Najtańsze dojście z pozycji załogi do habitatu i do łazika (jedno przeszukanie grafu dla obu celów)."""
        position = self.crew_pos(0)
        out = {}
        for name, target in (("habitat", self.cfg["habitat"]), ("rover", self.rover)):
            r = planning.plan(
                self.model, position, [{"id": name, "x": target["x"], "y": target["y"], "stopMin": 0}], self.obstacles, self.layers
            )
            if r["ok"]:
                out[name] = {
                    "path": r["path"],
                    "lengthM": round(r["lengthM"]),
                    "timeMin": round(r["durationH"] * 60),
                    "o2L": round(r["o2L"], 1),
                }
        out["computedAt"] = self.clock_str()
        return out

    # ---------- odczyt stanu dla UI ----------
    def _crew_snapshot(self, k: int, member: dict) -> tuple[dict, float]:
        person, pos = member["person"], self.crew_pos(k)
        cell = self.rc(pos)
        if member["est"] is None or self.t - member.get("estAt", -POSITION_REFRESH_S) >= POSITION_REFRESH_S:
            member["est"] = self.positioner.estimate(member["cfg"]["id"], pos, member["moved"])
            member["estAt"] = self.t
        walkback = self._walkback(member, pos)
        sensors, measured = member["sensors"], member.get("telemetry", {})
        return {
            "id": member["cfg"]["id"],
            "x": round(pos["x"], 1),
            "y": round(pos["y"], 1),
            "est": member["est"],
            "source": member["source"],
            "telemetryFields": list(measured),
            "telemetryAgeS": round(self.t - member.get("telemetryAt", self.t), 1),
            "o2Pct": round(person.o2_l / person.o2_capacity_l * 100, 1),
            "o2L": round(person.o2_l, 1),
            "co2mmHg": round(member["co2mmHg"], 2),
            "batteryPct": round(person.battery_left_wh / person.battery_wh * 100, 1),
            "pressureKPa": round(sensors["pressureKPa"], 2),
            "suitTempC": round(20.5 + (member["metabolic"] - 200) / 120 + sensors["suitTempC"], 1),
            "hr": measured.get("hr", int(heart_rate(member["metabolic"]) + sensors["hr"])),
            "metabolicW": round(member["metabolic"]),
            "evaDoseUsv": round(member["evaDoseUsv"], 1),
            "career": radiation.limit_status(person.dose_msv),
            "walkback": {
                "needL": round(walkback["needL"], 1),
                "availL": round(walkback["availL"], 1),
                "marginH": round(walkback["marginH"], 2),
                "ok": walkback["ok"],
            },
            "comms": int(self.comms[cell]),
            "zone": int(self.layers["hazard"][cell]),
        }, walkback["marginH"]

    def snapshot(self) -> dict:
        with self.lock:
            hour = self.clock_min / 60
            elevation, azimuth = sun.sun_position(self.lat, self.mt.decl, hour)
            sunset = sun.sunset_ltst(self.lat, self.mt.decl)
            crew, margins = zip(*(self._crew_snapshot(k, member) for k, member in enumerate(self.crew)))
            weather = self.spaceweather or {}
            return {
                "missionId": self.cfg["id"],
                "session": self.store.session,
                "t": round(self.t, 1),
                "clockMin": self.clock_min,
                "clock": self.clock_str(),
                "sol": self.cfg["sol"],
                "running": self.running,
                "phase": self.phase,
                "finished": self.finished,
                "resumed": self.resumed,
                "timeScale": self.time_scale,
                "routeVersion": self.route_version,
                "crewS": round(self.crew_s, 2),
                "gap": self.gap,
                "nextWp": self.next_wp,
                "reached": self.reached,
                "sep": self.sep,
                "crew": list(crew),
                "rover": {
                    "x": round(self.rover["x"], 1),
                    "y": round(self.rover["y"], 1),
                    "s": round(self.rover["s"], 1),
                    "mode": self.rover["mode"],
                },
                "reserveH": round(min(margins), 2),
                "env": {
                    "doseUsvh": round(self.dose_rate(), 1),
                    "windMs": round(6 + 1.5 * math.sin(self.t / 300) + self.wind_noise, 1),
                    "groundTempC": round(self.temperature_at(self.crew_pos(0), hour) - 273.15, 1),
                    "tau": 0.5,
                    "sunElevDeg": round(elevation, 1),
                    "sunAzDeg": round(azimuth, 1),
                    "daylightLeftH": round(sunset - hour, 2),
                    "sunsetLtst": round(sunset, 2),
                },
                "spaceWeather": {
                    "pfuEarth": weather.get("pfu"),
                    "level": weather.get("stormLevel"),
                    "summary": weather.get("summary"),
                    "source": weather.get("source"),
                    "simulatedPfu": self.sim_pfu if self.sep else 0,
                },
                "alerts": self.alerts[-3:],
                "obstacles": self.obstacles,
                "observations": self.observations[-20:],
                "emergency": self.emergency,
                "link": self.link.status(self.t),
                "log": self.log[-30:],
            }
