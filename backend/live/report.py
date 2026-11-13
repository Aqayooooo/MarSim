"""Raport: analiza zagrożeń, analiza ryzyka (prawdopodobieństwo × skutek, macierz 5×5), skuteczność misji
oraz skrócone podsumowanie danych, na których oparto każdą ocenę (z odwołaniem do pochodzenia danych)."""

from __future__ import annotations

import math
import re

import numpy as np

from backend import planning
from backend.live.engine import WALKBACK_WARNING_H
from backend.models.physiology import G_MARS
from backend.models.sun import fmt_ltst

LIKELIHOOD = {1: "rzadkie", 2: "mało prawdopodobne", 3: "możliwe", 4: "prawdopodobne", 5: "prawie pewne"}
SEVERITY = {1: "pomijalny", 2: "mały", 3: "umiarkowany", 4: "poważny", 5: "krytyczny"}
P_FAIL = {1: 0.002, 2: 0.01, 3: 0.04, 4: 0.12, 5: 0.3}  # wpływ na ukończenie misji (założenie)


def _risk(likelihood: int, severity: int) -> tuple[int, str]:
    risk = likelihood * severity
    return risk, ("wysokie" if risk >= 15 else "średnie" if risk >= 8 else "niskie")


def _polish_number_format(text):
    """Przecinek dziesiętny i typograficzny minus w tekstach raportu."""
    return re.sub(r"(?<=\d)\.(?=\d)", ",", text).replace("-", "−") if isinstance(text, str) else text


def _stops_pl(n: int) -> str:
    """Polska odmiana: 1 przystanek, 2–4 przystanki (poza 12–14), pozostałe przystanków."""
    if n == 1:
        return "przystanek"
    return "przystanki" if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14) else "przystanków"


def _sample_path(path, step=3.0):
    out = []
    for a, b in zip(path[:-1], path[1:]):
        d = math.hypot(b["x"] - a["x"], b["y"] - a["y"])
        n = max(1, int(d // step))
        out += [{"x": a["x"] + (b["x"] - a["x"]) * k / n, "y": a["y"] + (b["y"] - a["y"]) * k / n, "d": d / n} for k in range(n)]
    return out


def build(e) -> dict:
    """e: EvaEngine."""
    r = e.route
    if not r:
        return {"ok": False, "error": "Brak trasy — najpierw wyznacz trasę."}
    L, cell, prov = e.layers, e.cell, e.provenance
    pts = _sample_path(r["path"])
    if not pts:
        pts = [{**r["path"][0], "d": 0.0}]
    rc = [(min(L["hazard"].shape[0] - 1, int(p["y"] // cell)), min(L["hazard"].shape[1] - 1, int(p["x"] // cell))) for p in pts]
    slope = np.array([L["slope"][i] for i in rc])
    sig = np.array([L["slopeSigma"][i] for i in rc])
    sand = np.array([L["sand"][i] for i in rc])
    sconf = np.array([L["sandConfidence"][i] for i in rc])
    comms = np.array([e.comms[i] for i in rc])
    seg = np.array([p["d"] for p in pts])
    eva = e.cfg["eva"]
    k = int(np.argmax(slope))
    near_b = [b for b in e.boulders if b["confidence"] >= 0.5 and min(math.hypot(b["x"] - p["x"], b["y"] - p["y"]) for p in pts[::3]) < 15]
    no_comms = float(seg[comms == 0].sum())
    o2_need = r["o2L"] * 1.1
    cap = min(c["person"].o2_capacity_l for c in e.crew)
    reserve = eva["o2ReservePct"] / 100 * cap
    return_leg = planning.plan(e.model, r["path"][-1], [{"id": "habitat", **e.cfg["habitat"]}], e.obstacles, e.layers)
    end_h = e.start_min / 60 + r["durationH"] + (return_leg["durationH"] if return_leg["ok"] else 24)
    sunset = prov["sun"]["sunsetLtst"]
    temps = [e.temperature_at(r["path"][0], e.start_min / 60), e.temperature_at(r["path"][-1], end_h)]
    sw = e.spaceweather or {}
    dose_eva = e.dose_rate() * r["durationH"]
    beacons_gap = e.beacon_gap_m(r["path"])

    H = []

    def add(hid, name, l, s, basis, mitigation, value):
        risk, level = _risk(l, s)
        H.append(
            {
                "id": hid,
                "hazard": name,
                "likelihood": l,
                "likelihoodText": LIKELIHOOD[l],
                "severity": s,
                "severityText": SEVERITY[s],
                "risk": risk,
                "level": level,
                "value": value,
                "basis": basis,
                "mitigation": mitigation,
            }
        )

    ms, ss = float(slope[k]), float(sig[k])
    add(
        "H1",
        "Strome zbocze (poślizg, upadek)",
        4 if ms + 2 * ss > 20 else 3 if ms + 2 * ss > 15 else 2,
        4,
        f"DTM HiRISE {e.mission['dem']['source']}, σz {e.mission['dem']['sigmaZM']} m",
        f"trasa omija nachylenie+2σ > {eva['maxSlopeDeg']:g}°; kijki, asekuracja",
        f"maks. {ms:.1f}° ±{ss:.1f}° (2σ: {ms + 2 * ss:.1f}°)",
    )
    add(
        "H2",
        "Luźny piasek (zakopanie, wysiłek)",
        3 if sand.max() > 0.45 else 2,
        3,
        "5 wskaźników: ciemność, zmarszczki, THEMIS, gładkość obrazu i DTM",
        "trasa omija piasek > 0,6; uwaga przy 0,35–0,6",
        f"maks. prawdopodobieństwo {sand.max():.2f} (pewność min. {sconf.min():.2f})",
    )
    add(
        "H3",
        "Głazy przy trasie (potknięcie, uszkodzenie skafandra)",
        3 if len(near_b) > 5 else 2 if near_b else 1,
        3,
        "metoda cieni na HiRISE 0,25 m; wykrywalne ≥1 m",
        "omijanie o ≥6 m; mniejsze kamienie niewidoczne z orbity",
        f"{len(near_b)} głazów ≤15 m od trasy" + (f", największy {max(b['diameterM'] for b in near_b):.1f} m" if near_b else ""),
    )
    add(
        "H4",
        "Utrata łączności z habitatem",
        4 if no_comms > 150 else 3 if no_comms > 30 else 1,
        3,
        f"linia widoczności z masztu {e.cfg['habitat']['mastM']} m na DTM",
        "przekaźnik na łaziku; zgłoszenia co 10 min",
        f"{no_comms:.0f} m trasy bez zasięgu ({no_comms / max(seg.sum(), 1) * 100:.0f}%)",
    )
    margin = cap - reserve - o2_need
    o2_likelihood = 1 if margin > 200 else 3 if margin > 50 else 5
    o2_value = f"potrzeba {o2_need:.0f} L, dostępne {cap - reserve:.0f} L ponad rezerwę"
    if e.t > 0 and not e.finished:  # trwające wyjście: liczy się bieżący tlen najsłabszej osoby, nie sam plan
        walkbacks = [(member, e._walkback(member, e.crew_pos(k))) for k, member in enumerate(e.crew)]
        member, walkback = min(walkbacks, key=lambda mw: mw[1]["marginH"])
        person = member["person"]
        if person.o2_l <= eva["o2ReservePct"] / 100 * person.o2_capacity_l or not walkback["ok"]:
            o2_likelihood = 5
        elif walkback["marginH"] < WALKBACK_WARNING_H:
            o2_likelihood = max(o2_likelihood, 4)
        margin = min(margin, walkback["availL"] - walkback["needL"])
        o2_value = (
            f"{member['cfg']['id']}: {person.o2_l / person.o2_capacity_l * 100:.0f}% O₂, "
            f"na powrót potrzeba {walkback['needL']:.0f} L, dostępne {walkback['availL']:.0f} L ponad rezerwę"
        )
    add(
        "H5",
        "Niewystarczający zapas tlenu",
        o2_likelihood,
        5,
        "model wysiłku Pandolfa (0,38 g) dopasowany do średniego wysiłku w EVA Apollo",
        f"granica powrotu pieszego na mapie; rezerwa {eva['o2ReservePct']:g}%",
        o2_value,
    )
    add(
        "H6",
        "Zmrok przed powrotem",
        4 if end_h > sunset - 0.5 else 2 if end_h > sunset - 2 else 1,
        4,
        "położenie Słońca (Allison & McEwen 2000) i cienie z DTM",
        "planowany powrót ≥30 min przed zmierzchem",
        f"koniec ok. {fmt_ltst(end_h)} LTST, zmierzch {fmt_ltst(sunset)}",
    )
    add(
        "H7",
        "Promieniowanie (GCR i burza słoneczna)",
        3 if (sw.get("pfu") or 0) >= 10 else 2,
        4 if (sw.get("pfu") or 0) >= 100 else 3,
        "RAD (Curiosity) 0,64 mSv/sol; DONKI i NOAA SWPC",
        "schron ≤15 min; przerwanie EVA przy S2+",
        f"dawka EVA ok. {dose_eva:.0f} μSv; {sw.get('summary', 'brak danych pogody kosmicznej')}",
    )
    add(
        "H8",
        "Niska temperatura (skafander, baterie)",
        2 if min(temps) > 190 else 3,
        2,
        "model cieplny z bezwładności termicznej (szacunek)",
        "ogrzewanie skafandra; kontrola baterii",
        f"grunt {min(temps) - 273.15:.0f}…{max(temps) - 273.15:.0f} °C",
    )
    add(
        "H9",
        "Utrata dokładnej pozycji",
        3 if beacons_gap > 200 else 2 if beacons_gap > 50 else 1,
        2,
        "nadajniki UWB w linii widoczności + odometria",
        "dodatkowe nadajniki na trasie",
        f"{beacons_gap:.0f} m trasy z < 3 nadajnikami w zasięgu",
    )
    H.sort(key=lambda h: -h["risk"])

    p_success = float(np.prod([1 - P_FAIL[h["likelihood"]] * h["severity"] / 5 for h in H]))
    stops = [r["path"][0]] + e.waypoints  # start trasy i jej punkty (POST /api/plan może podać własne)
    straight = sum(math.hypot(b["x"] - a["x"], b["y"] - a["y"]) for a, b in zip(stops[:-1], stops[1:]))
    effectiveness = {
        "probabilityComplete": round(p_success, 3),
        "routeEfficiency": round(straight / max(r["lengthM"], 1), 2),
        "o2MarginL": round(margin),
        "durationH": round(r["durationH"], 2),
        "waypointsPlanned": len(e.waypoints),
        "note": "Prawdopodobieństwo z macierzy ryzyka (założone wartości), do kalibracji danymi z misji analogowych.",
    }
    matrix = [[sum(1 for h in H if h["likelihood"] == l and h["severity"] == s) for s in range(1, 6)] for l in range(5, 0, -1)]
    top = [h for h in H if h["level"] != "niskie"]
    summary = [
        f"Trasa {r['letter']}: {r['lengthM'] / 1000:.2f} km, {r['durationH'] * 60:.0f} min, "
        f"{r['stops']} {_stops_pl(r['stops'])}, ocena: {r['rating']}.",
        f"Nachylenie maks. {ms:.1f}° ±{ss:.1f}° (DTM HiRISE {e.mission['dem']['year']}, σz {e.mission['dem']['sigmaZM']} m).",
        f"Ryzyka średnie/wysokie: {', '.join(h['hazard'].split(' (')[0] for h in top) or 'brak'}.",
        f"Szansa ukończenia: {p_success * 100:.0f}% · zapas O₂ ponad rezerwę: {margin:.0f} L.",
    ]
    data_basis = [
        {
            "source": s["id"],
            "instrument": s["instrument"],
            "use": s["description"].split(" — ")[-1] if " — " in s["description"] else s["description"],
            "sha256": (s.get("sha256") or "")[:12] or None,
        }
        for s in prov["sources"]
    ]
    reference = e.crew[0]["person"]
    assumptions = [
        {"id": "maxSlope", "value": eva["maxSlopeDeg"], "unit": "°"},
        {"id": "cautionSlope", "value": eva["cautionSlopeDeg"], "unit": "°"},
        {"id": "slopeMargin", "value": planning.SLOPE_SIGMA_MARGIN, "unit": "σ"},
        {"id": "sandForbidden", "value": planning.SAND_FORBIDDEN_THRESHOLD, "unit": ""},
        {"id": "sandCaution", "value": planning.SAND_TERRAIN_THRESHOLD, "unit": ""},
        {"id": "cautionFactor", "value": planning.CAUTION_FACTOR, "unit": "×"},
        {"id": "obstacleBuffer", "value": planning.OBSTACLE_BUFFER_M, "unit": "m"},
        {"id": "o2Reserve", "value": eva["o2ReservePct"], "unit": "%"},
        {"id": "walkSpeed", "value": eva["walkKmh"], "unit": "km/h"},
        {"id": "gravity", "value": round(G_MARS, 2), "unit": "g"},
        {"id": "suitLeak", "value": reference.leak_l_min, "unit": "L/min"},
        {"id": "shelter", "value": eva["shelterMin"], "unit": "min"},
    ]
    summary = [_polish_number_format(line) for line in summary]
    for h in H:
        h["value"] = _polish_number_format(h["value"])
    return {
        "ok": True,
        "routeLetter": r["letter"],
        "summary": summary,
        "hazards": H,
        "riskMatrix": matrix,
        "effectiveness": effectiveness,
        "assumptions": assumptions,
        "uncertainty": planning.route_interval(e.model, e.layers, r["path"], e.waypoints),
        "dataBasis": data_basis,
        "provenance": {
            "pipelineVersion": prov["pipelineVersion"],
            "builtUtc": prov["builtUtc"],
            "checks": prov["checks"],
            "dtmPrecision": prov["dtmPrecision"],
            "outputsHashed": len(prov.get("outputs", {})),
        },
    }
