"""Niezależne testy silnika EVA na żywo (backend/live/engine.py, checkpoint.py, dtn.py, store.py).

Sprawdzane są niezmienniki wynikające z opisu (README, docs/KONTRAKT_DANYCH.md) i z fizyki:
tlen nigdy ujemny i nierosnący, dawka narastająca z tempem GCR, kolejność faz, powrót do habitatu,
skalowanie czasu, zapis i odtworzenie punktu kontrolnego. Identyfikatory załogi są czytane z konfiguracji.
"""

from __future__ import annotations

import math

import numpy as np
import pytest
from conftest import MISSION_IDS, cells, densify

from backend import missions as mis
from backend.live.engine import EvaEngine
from backend.live.store import Store
from backend.models import radiation, sun
from backend.paths import MISSIONS

ALLOWED = {
    "idle": {"idle", "walking", "stop"},
    "walking": {"walking", "stop", "atTarget"},
    "stop": {"stop", "walking", "atTarget"},
    "atTarget": {"atTarget", "returning"},
    "returning": {"returning", "stop", "done"},
    "done": {"done"},
}


def engine(mission_id: str = "mount-sharp", store: Store | None = None, seed: int | None = 7) -> EvaEngine:
    return EvaEngine(MISSIONS / mission_id, mis.config(mission_id), store=store or Store(":memory:"), live_feeds=False, seed=seed)


def crew_ids(e: EvaEngine) -> list[str]:
    return [c["id"] for c in e.cfg["crew"]]


def o2(e: EvaEngine) -> list[float]:
    return [m["person"].o2_l for m in e.crew]


def run_until(e: EvaEngine, predicate, dt=1.0, limit=5000):
    n = 0
    while not predicate(e) and n < limit:
        e.step(dt)
        n += 1
    assert predicate(e), f"warunek nie spełniony po {n} krokach (faza {e.phase}, t={e.t})"


# ---------------------------------------------------------------- pełne wyjście
@pytest.fixture(scope="module", params=MISSION_IDS)
def full_eva(request):
    """Pełne wyjście: start → punkty trasy → powrót → habitat; ślad stanu po każdym kroku."""
    e = engine(request.param)
    assert e.start(time_scale=120) is None
    planned = dict(e.route)
    trace = []

    def record():
        snap = e.snapshot()
        trace.append(
            {
                "t": e.t,
                "phase": e.phase,
                "crewS": e.crew_s,
                "gap": e.gap,
                "reached": list(e.reached),
                "o2": o2(e),
                "battery": [m["person"].battery_left_wh for m in e.crew],
                "co2abs": [m["person"].co2_absorbed_l for m in e.crew],
                "dose": [m["evaDoseUsv"] for m in e.crew],
                "pos": [(c["x"], c["y"]) for c in snap["crew"]],
                "snap": snap,
            }
        )

    record()
    for _ in range(3000):
        if e.phase == "atTarget":
            break
        e.step(0.5)
        record()
    o2_at_target = o2(e)
    assert e.return_to_habitat()["ok"] is not False
    for _ in range(3000):
        if e.finished:
            break
        e.step(0.5)
        record()
    return e, planned, trace, o2_at_target


def test_full_eva_reaches_all_waypoints_then_habitat(full_eva):
    e, _, trace, _ = full_eva
    wp_ids = [w["id"] for w in e.cfg["waypoints"]]
    assert e.finished and e.phase == "done" and not e.running
    assert e.reached[: len(wp_ids)] == wp_ids
    assert e.reached[-1] == "HAB"
    hab = e.cfg["habitat"]
    for x, y in trace[-1]["pos"]:
        assert math.hypot(x - hab["x"], y - hab["y"]) < 1.0, "cała załoga w śluzie habitatu"


def test_full_eva_phase_sequence_is_legal(full_eva):
    _, _, trace, _ = full_eva
    phases = [s["phase"] for s in trace]
    for a, b in zip(phases, phases[1:]):
        assert b in ALLOWED[a], f"niedozwolone przejście {a} → {b}"
    assert phases[0] == "walking", "po starcie wyjście od razu jest w marszu"
    assert phases[-1] == "done"
    assert {"walking", "stop", "atTarget", "returning"} <= set(phases)


def test_full_eva_time_monotonic_and_bounded_by_scale(full_eva):
    _, _, trace, _ = full_eva
    for a, b in zip(trace, trace[1:]):
        assert 0 <= b["t"] - a["t"] <= 0.5 * 120 + 1e-9


def test_full_eva_consumables_monotonic_and_non_negative(full_eva):
    _, _, trace, _ = full_eva
    for a, b in zip(trace, trace[1:]):
        for k in range(len(a["o2"])):
            assert 0 <= b["o2"][k] <= a["o2"][k] + 1e-9
            assert 0 <= b["battery"][k] <= a["battery"][k] + 1e-9
            assert b["co2abs"][k] >= a["co2abs"][k] - 1e-9
            assert b["dose"][k] >= a["dose"][k] - 1e-9


def test_full_eva_nominal_plan_keeps_oxygen_reserve(full_eva):
    e, _, trace, _ = full_eva
    reserve = e.cfg["eva"]["o2ReservePct"] / 100
    for m in e.crew:
        assert m["person"].o2_l > reserve * m["person"].o2_capacity_l, f"{m['cfg']['id']} zszedł poniżej rezerwy w planie nominalnym"
    assert not any(a["category"] == "TLEN" for a in e.alerts)


def test_full_eva_outbound_oxygen_close_to_plan_estimate(full_eva):
    """Zużycie tlenu do celu wyjścia powinno być tego samego rzędu co szacunek planera (ostrożny: nachylenie + 2σ)."""
    e, planned, _, o2_at_target = full_eva
    used = [m["cfg"]["o2CapacityL"] - v for m, v in zip(e.crew, o2_at_target)]
    for u in used:
        assert 0.5 * planned["o2L"] < u < 1.5 * planned["o2L"], f"zużyto {u:.0f} L, plan {planned['o2L']:.0f} L"


def test_full_eva_crew_walks_only_on_allowed_cells(full_eva):
    e, _, trace, _ = full_eva
    xy = np.array([p for s in trace for p in s["pos"]])
    rows, cols = cells(e, xy)
    assert not np.any(e.layers["hazard"][rows, cols] == 2)


def test_full_eva_waypoint_reached_only_when_whole_crew_arrives(full_eva):
    e, _, trace, _ = full_eva
    for a, b in zip(trace, trace[1:]):
        if len(b["reached"]) > len(a["reached"]) and len(e.crew) > 1:
            assert b["gap"] == 0
            (x0, y0), *rest = b["pos"]
            for x, y in rest:
                assert math.hypot(x - x0, y - y0) < 0.5


def test_full_eva_stop_lasts_configured_minutes(full_eva):
    e, _, trace, _ = full_eva
    first = e.cfg["waypoints"][0]
    arrived = next(s["t"] for s in trace if first["id"] in s["reached"])
    left = next(s["t"] for s in trace if first["id"] in s["reached"] and s["phase"] == "walking")
    # krok śladu to 60 s misji
    assert first["stopMin"] * 60 - 1 <= left - arrived <= first["stopMin"] * 60 + 61


def test_full_eva_gap_never_exceeds_spacing(full_eva):
    _, _, trace, _ = full_eva
    assert all(0 <= s["gap"] <= 14.0 + 1e-9 for s in trace)


def test_full_eva_dose_matches_gcr_rate(full_eva):
    e, _, trace, _ = full_eva
    hours = trace[-1]["t"] / 3600
    expected = radiation.dose_rate_usv_h() * hours
    for m in e.crew:
        assert m["evaDoseUsv"] == pytest.approx(expected, rel=1e-6)
        assert m["person"].dose_msv == pytest.approx(m["cfg"]["priorDoseMsv"] + expected / 1000, rel=1e-9)


def test_full_eva_cannot_restart_after_finish_and_reset_makes_new_session(full_eva):
    e, _, _, _ = full_eva
    assert e.start() is not None
    assert e.return_to_habitat()["ok"] is False
    session = e.store.session
    e.reset()
    assert e.store.session == session + 1
    assert e.phase == "idle" and e.t == 0 and not e.finished
    assert all(m["person"].o2_l == m["cfg"]["o2CapacityL"] for m in e.crew)


# ---------------------------------------------------------------- czas
def test_time_scale_advances_mission_clock_exactly():
    e = engine()
    e.start(time_scale=60)
    e.step(1.0)
    assert e.t == pytest.approx(60)
    e.time_scale = 300
    e.step(0.5)
    assert e.t == pytest.approx(210)
    snap = e.snapshot()
    assert snap["clockMin"] == pytest.approx(e.start_min + 3.5)


def test_paused_engine_does_not_advance_or_consume():
    e = engine()
    e.start(time_scale=100)
    e.step(1.0)
    e.pause()
    t, before = e.t, o2(e)
    for _ in range(10):
        e.step(1.0)
    assert e.t == t and o2(e) == before
    snap = e.snapshot()
    assert snap["paused"] is True and snap["running"] is False


def test_large_time_step_equivalent_to_many_small_steps():
    """Przyspieszenie czasu nie zmienia fizyki: jeden krok 1200 s ≈ 120 kroków po 10 s."""
    a, b = engine(seed=3), engine(seed=3)
    a.start(time_scale=1200)
    b.start(time_scale=10)
    a.step(1.0)
    for _ in range(120):
        b.step(1.0)
    assert a.t == pytest.approx(b.t)
    assert a.crew_s == pytest.approx(b.crew_s, rel=1e-6)
    for x, y in zip(o2(a), o2(b)):
        assert x == pytest.approx(y, rel=0.01)


def test_clock_string_follows_start_ltst():
    e = engine()
    e.start(time_scale=60)
    e.step(1.0)  # 60 s misji
    hh, mm = (int(v) for v in e.cfg["startLtst"].split(":"))
    scheduled = e.scheduled_exit()
    if scheduled:
        hh, mm = (int(v) for v in scheduled["startLtst"].split(":"))
    total = hh * 60 + mm + 1
    assert e.snapshot()["clock"] == f"{total // 60 % 24:02d}:{total % 60:02d}"


def test_same_seed_gives_identical_runs():
    a, b = engine(seed=11), engine(seed=11)
    for e in (a, b):
        e.start(time_scale=200)
        for _ in range(8):
            e.step(1.0)
    sa, sb = a.snapshot(), b.snapshot()
    for key in ("t", "crewS", "phase", "crew", "env"):
        assert sa[key] == sb[key], key


# ---------------------------------------------------------------- środowisko w stanie
def test_snapshot_sun_matches_model():
    e = engine("jezero")
    e.start(time_scale=600)
    e.step(1.0)
    snap = e.snapshot()
    hour = snap["clockMin"] / 60
    elev, az = sun.sun_position(e.lat, e.mt.decl, hour)
    sunset = sun.sunset_ltst(e.lat, e.mt.decl)
    assert snap["env"]["sunElevDeg"] == pytest.approx(elev, abs=0.06)
    assert snap["env"]["sunAzDeg"] == pytest.approx(az, abs=0.06)
    assert snap["env"]["daylightLeftH"] == pytest.approx(sunset - hour, abs=0.006)
    assert snap["env"]["sunElevDeg"] > 0, "wyjście w dzień"
    assert snap["env"]["doseUsvh"] == pytest.approx(radiation.dose_rate_usv_h(), abs=0.06)


def test_snapshot_crew_ids_and_fields_come_from_config():
    e = engine()
    snap = e.snapshot()
    assert [c["id"] for c in snap["crew"]] == [i for i in crew_ids(e) if any(m["cfg"]["id"] == i for m in e.crew)]
    for c in snap["crew"]:
        assert c["o2Pct"] == 100 and c["batteryPct"] == 100
        assert c["career"]["limitMsv"] == 600
        assert c["walkback"]["ok"] is True
    assert snap["phase"] == "idle" and snap["paused"] is False


def test_ground_temperature_plausible_for_mars():
    e = engine()
    e.start(time_scale=600)
    e.step(1.0)
    assert -120 < e.snapshot()["env"]["groundTempC"] < 30


# ---------------------------------------------------------------- tlen, telemetria
def test_telemetry_overrides_model_then_expires_after_ttl():
    e = engine()
    e.start(time_scale=10)
    e.step(1.0)
    who = e.crew[0]["cfg"]["id"]
    assert e.apply_telemetry(who, {"o2L": 400.0, "hr": 90})
    e.step(1.0)  # 10 s < TTL
    snap = {c["id"]: c for c in e.snapshot()["crew"]}
    assert snap[who]["source"] == "skafander"
    assert snap[who]["o2L"] == 400.0
    assert snap[who]["hr"] == 90
    for _ in range(8):  # +80 s > 60 s TTL
        e.step(1.0)
    snap = {c["id"]: c for c in e.snapshot()["crew"]}
    assert snap[who]["source"] == "model"
    assert snap[who]["o2L"] < 400.0


def test_unknown_crew_telemetry_rejected():
    e = engine()
    assert e.apply_telemetry("nobody-" + "x" * 5, {"o2L": 10}) is False


def test_low_oxygen_raises_reserve_alarm_once():
    e = engine()
    e.start(time_scale=10)
    e.step(1.0)
    member = e.crew[-1]
    who = member["cfg"]["id"]
    low = member["cfg"]["o2CapacityL"] * e.cfg["eva"]["o2ReservePct"] / 100 - 5
    e.apply_telemetry(who, {"o2L": low})
    for _ in range(3):
        e.step(1.0)
    oxygen = [a for a in e.alerts if a["category"] == "TLEN" and who in a["text"]]
    assert len(oxygen) == 1
    snap = {c["id"]: c for c in e.snapshot()["crew"]}
    assert snap[who]["walkback"]["ok"] is False
    assert e.snapshot()["reserveH"] < 0


def test_walkback_need_grows_with_distance_from_habitat():
    e = engine()
    hab = e.cfg["habitat"]
    near = float(e.o2_home[e.rc({"x": hab["x"] + 6, "y": hab["y"]})])
    far = max(float(e.o2_home[e.rc(w)]) for w in e.cfg["waypoints"])
    assert 0 <= near < far < 9999


def test_paused_eva_keeps_oxygen_after_many_steps_and_resume_continues():
    e = engine()
    e.start(time_scale=100)
    e.step(1.0)
    e.pause()
    held = o2(e)
    e.step(5.0)
    assert o2(e) == held
    assert e.start() is None
    e.step(1.0)
    assert all(a < b for a, b in zip(o2(e), held))


# ---------------------------------------------------------------- zdarzenia
def test_sep_increases_dose_rate_and_rover_keeps_standoff():
    e = engine()
    e.start(time_scale=120)
    run_until(e, lambda x: x.crew_s > 250)
    e.inject("sep")
    assert e.snapshot()["env"]["doseUsvh"] == pytest.approx(radiation.dose_rate_usv_h(500), abs=0.06)
    before = [m["evaDoseUsv"] for m in e.crew]
    e.step(1.0)  # 120 s
    gained = [m["evaDoseUsv"] - b for m, b in zip(e.crew, before)]
    for g in gained:
        assert g == pytest.approx(radiation.dose_rate_usv_h(500) * 120 / 3600, rel=1e-6)
    for _ in range(30):
        e.step(1.0)
        assert e.rover["s"] <= max(0.0, e.crew_s - 110.0) + 1e-6
    assert e.rover["mode"] == "toCrew" and e.rover["s"] > 0
    e.inject("sep-end")
    assert e.snapshot()["env"]["doseUsvh"] == pytest.approx(radiation.dose_rate_usv_h(), abs=0.06)


def test_obstacle_report_on_route_forces_detour():
    e = engine()
    e.start(time_scale=60)
    e.step(1.0)
    ahead = e.poly.at(e.crew_s + 200)
    result = e.add_observation({"kind": "glazy", "x": ahead["x"], "y": ahead["y"], "radiusM": 20, "source": "dron"})
    assert result["replanned"] is True
    assert e.route["letter"] == "B"
    assert e.discarded
    onward = e.poly.slice(e.crew_s, e.poly.length)
    xy = densify(onward, 0.5)
    clearance = np.hypot(xy[:, 0] - ahead["x"], xy[:, 1] - ahead["y"]).min()
    assert clearance > 20, f"nowa trasa przechodzi {clearance:.1f} m od przeszkody"


def test_safe_report_does_not_add_obstacle_or_replan():
    e = engine()
    e.start(time_scale=60)
    e.step(1.0)
    version = e.route_version
    p = e.poly.at(e.crew_s + 100)
    result = e.add_observation({"kind": "bezpieczne", "x": p["x"], "y": p["y"], "radiusM": 30, "source": "załoga"})
    assert result["replanned"] is False
    assert e.obstacles == [] and e.route_version == version


def test_boulders_injection_needs_route():
    e = engine()
    assert e.inject("boulders")["ok"] is False
    e.start(time_scale=60)
    e.step(1.0)
    r = e.inject("boulders")
    assert r.get("observation") and len(e.obstacles) == 1


def test_scenario_triggers_boulders_after_first_waypoint_then_sep():
    e = engine()
    e.start(time_scale=120, scenario=True)
    run_until(e, lambda x: "sep" in x.fired, dt=0.5, limit=4000)
    first = e.cfg["waypoints"][0]["id"]
    assert first in e.reached
    assert e.fired_at["sep"] >= e.fired_at["boulders"]
    assert e.sep is True and e.obstacles


# ---------------------------------------------------------------- łącze z Ziemią
def test_link_outage_holds_messages_until_restored():
    e = engine()
    e.start(time_scale=60)
    e.step(1.0)
    e.inject("link-outage")
    assert e.link.status(e.t)["up"] is False
    e.add_log("test", "wiadomość w czasie przerwy")
    pending = e.link.status(e.t)["pendingOut"]
    assert pending >= 1
    for _ in range(20):  # 20 min — przerwa trwa 30 min
        e.step(1.0)
    assert e.link.status(e.t)["pendingOut"] >= 1
    delay_min = e.link.status(e.t)["oneWayMin"]
    run_until(e, lambda x: x.link.status(x.t)["pendingOut"] == 0, dt=1.0, limit=int(30 + delay_min + 10))
    assert e.t >= 30 * 60 + delay_min * 60 - 60


def test_message_delivered_after_light_time_and_reply_returns():
    e = engine()
    e.start(time_scale=60)
    bundle = e.link.send(e.t, "test", "ping", reply="pong")
    delay = e.link.status(e.t)["oneWayMin"] * 60
    assert bundle.deliver_s == pytest.approx(e.t + delay, abs=60)
    run_until(e, lambda x: any(entry["text"] == "pong" for entry in x.log), dt=1.0, limit=200)
    assert e.t >= 2 * delay + 120 - 60


# ---------------------------------------------------------------- zapis i wznowienie
def test_checkpoint_round_trip_after_restart(tmp_path):
    db = tmp_path / "marsim-test.db"
    a = engine(store=Store(db))
    a.start(time_scale=120)
    run_until(a, lambda x: x.crew_s > 150)
    a.pause()
    saved = a.snapshot()
    a.store.close()

    b = engine(store=Store(db))
    snap = b.snapshot()
    assert b.resumed is True and snap["resumed"] is True
    assert snap["paused"] is True and snap["running"] is False
    for key in ("t", "crewS", "routeVersion", "session", "nextWp", "reached", "phase"):
        assert snap[key] == saved[key], key
    for ca, cb in zip(saved["crew"], snap["crew"]):
        assert ca["id"] == cb["id"] and ca["o2L"] == cb["o2L"] and ca["batteryPct"] == cb["batteryPct"]
    assert b.route["path"] == a.route["path"]
    t = b.t
    assert b.start() is None
    b.step(1.0)
    assert b.t > t


def test_checkpoint_keeps_observations_and_return_route(tmp_path):
    db = tmp_path / "marsim-test.db"
    a = engine(store=Store(db))
    a.start(time_scale=120)
    run_until(a, lambda x: x.crew_s > 100)
    a.pause()
    p = a.poly.at(a.crew_s + 150)
    a.add_observation({"kind": "glazy", "x": p["x"], "y": p["y"], "radiusM": 15, "source": "załoga"})
    a.return_to_habitat()
    version = a.route_version
    a.store.close()

    b = engine(store=Store(db))
    assert b.returning is True and b.route_version == version
    assert len(b.obstacles) == 1
    assert b.phase == "returning"
    assert b.start() is None
    run_until(b, lambda x: x.finished, dt=1.0, limit=500)


def test_finished_eva_is_not_resumed(tmp_path):
    db = tmp_path / "marsim-test.db"
    a = engine(store=Store(db))
    a.start(time_scale=600)
    run_until(a, lambda x: x.crew_s > 50)
    a.return_to_habitat()
    run_until(a, lambda x: x.finished)
    session = a.store.session
    a.store.close()
    b = engine(store=Store(db))
    assert b.resumed is False and b.phase == "idle"
    assert b.store.session == session + 1


def test_checkpoint_of_other_mission_is_ignored(tmp_path):
    db = tmp_path / "marsim-test.db"
    a = engine("mount-sharp", store=Store(db))
    a.start(time_scale=120)
    a.step(1.0)
    a.pause()
    a.store.close()
    b = engine("jezero", store=Store(db))
    assert b.resumed is False and b.t == 0


def test_event_log_hash_chain_survives_restart(tmp_path):
    db = tmp_path / "marsim-test.db"
    a = engine(store=Store(db))
    a.start(time_scale=120)
    a.step(1.0)
    a.pause()
    a.store.close()
    b = engine(store=Store(db))
    v = b.store.verify_log()
    assert v["ok"] is True and v["checked"] >= 3


def test_tampered_log_is_detected(tmp_path):
    db = tmp_path / "marsim-test.db"
    a = engine(store=Store(db))
    a.start(time_scale=60)
    a.step(1.0)
    a.store.db.execute("UPDATE events SET text = 'zmienione' WHERE id = 2")
    a.store.db.commit()
    v = a.store.verify_log()
    assert v["ok"] is False and v["brokenAt"] == 2
