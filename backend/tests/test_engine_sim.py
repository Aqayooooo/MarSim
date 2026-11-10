"""Symulacja EVA krok po kroku: niezmienniki, zakończenie wyjścia, alarmy, zgłoszenia, telemetria."""

import math
import threading

import numpy as np
import pytest
from conftest import make_engine, run


def start(eng, time_scale=60.0):
    eng.plan()
    eng.running = True
    eng.time_scale = time_scale


def walk_to_end(eng, limit_h=12.0):
    while eng.next_wp < len(eng.wp_s) and eng.t < limit_h * 3600:
        eng.step(0.1)


def test_paused_engine_does_not_advance(engine):
    engine.plan()
    for _ in range(50):
        engine.step(0.5)
    assert engine.t == 0 and engine.crew_s == 0
    assert engine.crew[0]["person"].o2_l == engine.cfg["crew"][0]["o2CapacityL"]


def test_clock_follows_time_scale(engine):
    start(engine, 120.0)
    for _ in range(100):
        engine.step(0.1)
    assert engine.t == pytest.approx(100 * 0.1 * 120.0)
    assert engine.clock_min == pytest.approx(engine.start_min + engine.t / 60)


def test_full_eva_invariants(engine):
    start(engine)
    o2 = [c["person"].o2_l for c in engine.crew]
    s = 0.0
    while engine.next_wp < len(engine.wp_s) and engine.t < 12 * 3600:
        engine.step(0.1)
        assert engine.crew_s >= s - 1e-9
        s = engine.crew_s
        for k, c in enumerate(engine.crew):
            assert 0 <= c["person"].o2_l <= o2[k] + 1e-9
            o2[k] = c["person"].o2_l
    assert engine.reached == [w["id"] for w in engine.cfg["waypoints"]]
    assert engine.crew_s == pytest.approx(engine.poly.length, abs=0.05)


def test_plan_predicts_simulated_time_and_oxygen(engine):
    """Plan (z marginesem 2σ) ma być ostrożny, ale nie oderwany od tego, co wychodzi w symulacji."""
    start(engine)
    planned = dict(engine.route)
    walk_to_end(engine)
    used = engine.cfg["crew"][0]["o2CapacityL"] - engine.crew[0]["person"].o2_l
    last_stop = engine.cfg["waypoints"][-1]["stopMin"]
    simulated_h = engine.t / 3600 + last_stop / 60
    assert simulated_h == pytest.approx(planned["durationH"], rel=0.25)
    assert 0.5 * planned["o2L"] <= used <= 1.1 * planned["o2L"]


def test_arrival_time_does_not_depend_on_time_scale():
    """Ten sam marsz przy ×60 i ×2000 powinien trwać tyle samo czasu misji (różnica najwyżej o krok)."""
    slow, fast = make_engine("mount-sharp"), make_engine("mount-sharp")
    start(slow, 60.0)
    start(fast, 2000.0)
    walk_to_end(slow)
    walk_to_end(fast)
    assert fast.t == pytest.approx(slow.t, rel=0.05)


def test_eva_has_an_end(engine):
    """U celu silnik zgłasza fazę atTarget; po powrocie do habitatu wyjście się kończy: zegar i zużycie zasobów stają."""
    start(engine)
    walk_to_end(engine)
    assert engine.phase == "atTarget" and engine.running  # załoga nadal w skafandrach — czas płynie
    assert "cel wyjścia" in engine.log[-1]["text"]
    route = engine.return_to_habitat()
    assert route["ok"] and engine.phase == "returning"
    assert engine.return_to_habitat()["ok"] is False  # drugi raz: już trwa
    while engine.running and engine.t < 12 * 3600:
        engine.step(0.1)
    assert engine.finished and engine.phase == "done" and not engine.running
    hab, crew = engine.cfg["habitat"], engine.crew_pos(0)
    assert math.hypot(hab["x"] - crew["x"], hab["y"] - crew["y"]) < 0.5
    t, o2 = engine.t, engine.crew[0]["person"].o2_l
    for _ in range(100):
        engine.step(0.1)
    assert engine.t == t and engine.crew[0]["person"].o2_l == o2
    assert engine.start() is not None  # zakończonej EVA nie da się wznowić bez resetu


def test_low_oxygen_raises_alert(gale):
    """Zapas poniżej rezerwy albo ujemny zapas na powrót musi dać alarm — to główna funkcja bezpieczeństwa."""
    start(gale, 600.0)
    for _ in range(4000):
        gale.step(0.1)
        if gale.crew[0]["person"].o2_l < 0.15 * gale.cfg["crew"][0]["o2CapacityL"]:
            break
    snap = gale.snapshot()
    assert snap["crew"][0]["o2Pct"] < 20
    assert snap["crew"][0]["walkback"]["ok"] is False
    texts = " ".join(a["category"] + " " + a["text"] for a in gale.alerts).lower()
    assert "tlen" in texts or "o₂" in texts or "o2" in texts, f"brak alarmu tlenu; alarmy: {gale.alerts}"


def test_snapshot_is_deterministic_when_paused(gale):
    """Dwa odczyty stanu bez upływu czasu powinny być identyczne (szum nie może zależeć od liczby odczytów)."""
    gale.plan()
    a, b = gale.snapshot(), gale.snapshot()
    for key in ("pressureKPa", "suitTempC", "hr"):
        assert a["crew"][0][key] == b["crew"][0][key], key
    assert a["env"]["windMs"] == b["env"]["windMs"]


def test_snapshot_contract(engine):
    engine.plan()
    s = engine.snapshot()
    assert s["missionId"] == engine.cfg["id"] and s["sol"] == engine.cfg["sol"]
    assert {c["id"] for c in s["crew"]} == {c["id"] for c in engine.cfg["crew"]}
    for c in s["crew"]:
        assert 0 <= c["o2Pct"] <= 100 and 0 <= c["batteryPct"] <= 100
        assert c["zone"] in (0, 1, 2)
        assert math.isfinite(c["walkback"]["marginH"])
    assert s["env"]["doseUsvh"] == pytest.approx(26.7, abs=0.05)
    assert -130 < s["env"]["groundTempC"] < 40
    assert 0 < s["env"]["sunElevDeg"] <= 90  # start rano
    import json

    json.dumps(s, default=float)


def test_reset_restores_everything(engine):
    hazard0 = engine.layers["hazard"].copy()
    home0 = engine.o2_home.copy()
    start(engine)
    run(engine, 1200)
    engine.add_observation({"kind": "glazy", "x": 600.0, "y": 500.0, "radiusM": 40})
    caution = np.argwhere(hazard0 == 1)[0]
    engine.add_observation(
        {"kind": "bezpieczne", "x": (caution[1] + 0.5) * engine.cell, "y": (caution[0] + 0.5) * engine.cell, "radiusM": 30}
    )
    assert not np.array_equal(engine.layers["hazard"], hazard0)
    engine.inject("sep")
    engine.reset()
    assert np.array_equal(engine.layers["hazard"], hazard0)
    assert np.allclose(engine.o2_home, home0)
    assert engine.t == 0 and not engine.running and engine.route is None and not engine.sep
    assert engine.obstacles == [] and engine.observations == [] and engine.alerts == []
    assert all(c["person"].o2_l == c["cfg"]["o2CapacityL"] for c in engine.crew)


def test_safe_passage_only_clears_caution_not_forbidden(engine):
    forb = np.argwhere(engine.layers["hazard"] == 2)[len(np.argwhere(engine.layers["hazard"] == 2)) // 2]
    before = int((engine.layers["hazard"] == 2).sum())
    engine.add_observation({"kind": "bezpieczne", "x": (forb[1] + 0.5) * engine.cell, "y": (forb[0] + 0.5) * engine.cell, "radiusM": 60})
    assert int((engine.layers["hazard"] == 2).sum()) == before


def test_observation_behind_crew_does_not_replan(gale):
    start(gale)
    run(gale, 1500)
    assert gale.crew_s > 150
    behind = gale.poly.at(gale.crew_s - 120)
    res = gale.add_observation({"kind": "glazy", "x": behind["x"], "y": behind["y"], "radiusM": 15})
    assert res["replanned"] is False and gale.route["letter"] == "A"


def test_many_replans_keep_valid_route_letter(gale):
    start(gale)
    run(gale, 600)
    for _ in range(30):
        assert gale.replan_from_crew("test") is not None
    assert gale.route["letter"].isalpha() and gale.route["letter"].isupper(), repr(gale.route["letter"])


def test_replan_keeps_walked_part_and_waypoints(gale):
    start(gale)
    run(gale, 900)
    walked_m = gale.crew_s
    ahead = gale.poly.at(gale.crew_s + 45)
    res = gale.add_observation({"kind": "glazy", "x": ahead["x"], "y": ahead["y"], "radiusM": 15})
    assert res["replanned"]
    assert gale.poly.at(walked_m)["x"] == pytest.approx(gale.crew_pos(0)["x"], abs=0.5)
    assert len(gale.wp_s) == len(gale.cfg["waypoints"])
    assert gale.wp_s == sorted(gale.wp_s)
    for s, wp in zip(gale.wp_s, gale.cfg["waypoints"]):
        p = gale.poly.at(s)
        assert math.hypot(p["x"] - wp["x"], p["y"] - wp["y"]) < 0.5
    walk_to_end(gale)
    assert gale.reached == [w["id"] for w in gale.cfg["waypoints"]]


def test_inject_boulders_near_route_end_lands_ahead_of_crew(gale):
    start(gale)
    walk_to_end(gale)  # załoga na końcu trasy: nie ma już nic „przed nami”
    assert gale.inject("boulders")["ok"] is False
    assert gale.obstacles == [] and gale.route_blocked is False


def test_inject_without_boulders_event_does_not_crash(gale):
    gale.plan()
    gale.mission["events"] = [e for e in gale.mission["events"] if e["id"] != "boulders"]
    try:
        r = gale.inject("boulders")
    except StopIteration:
        pytest.fail("inject('boulders') rzuca StopIteration, gdy misja nie ma takiego zdarzenia")
    assert r.get("ok") is False


def test_sep_scenario_sends_rover_and_raises_dose(gale):
    start(gale)
    run(gale, 1800)
    base = gale.dose_rate()
    gale.inject("sep")
    assert gale.dose_rate() == pytest.approx(base * 4.0)  # 500 pfu → S2
    run(gale, 600)
    assert gale.rover["mode"] == "toCrew" and gale.rover["s"] > 0
    assert gale.rover["s"] <= gale.crew_s - 110 + 1e-6
    gale.inject("sep-end")
    assert gale.dose_rate() == pytest.approx(base)


def test_demo_scenario_fires_events_in_order(gale):
    start(gale)
    gale.scenario = True
    walk_to_end(gale)
    assert gale.fired == {"boulders", "sep"}
    assert gale.fired_at["sep"] >= gale.fired_at["boulders"] + 3
    assert gale.route["letter"] == "B"


def test_dose_accumulates_at_background_rate(gale):
    start(gale)
    run(gale, 3600)
    assert gale.crew[0]["evaDoseUsv"] == pytest.approx(640 / 24 * gale.t / 3600, rel=1e-6)
    prior = gale.cfg["crew"][0]["priorDoseMsv"]
    assert gale.crew[0]["person"].dose_msv == pytest.approx(prior + gale.crew[0]["evaDoseUsv"] / 1000)


def test_second_crew_member_follows_behind(gale):
    start(gale)
    run(gale, 1200)
    a, b = gale.crew_pos(0), gale.crew_pos(1)
    assert 5 < math.hypot(a["x"] - b["x"], a["y"] - b["y"]) <= gale.gap + 0.5


def test_concurrent_step_snapshot_observation(gale):
    start(gale, 300.0)
    errors = []

    def guard(fn, n):
        try:
            for i in range(n):
                fn(i)
        except Exception as e:
            errors.append(repr(e))

    threads = [
        threading.Thread(target=guard, args=(lambda i: gale.step(0.05), 300)),
        threading.Thread(target=guard, args=(lambda i: gale.snapshot(), 150)),
        threading.Thread(
            target=guard, args=(lambda i: gale.add_observation({"kind": "inne", "x": 100.0 + 13 * i, "y": 100.0 + 7 * i, "radiusM": 5}), 20)
        ),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(120)
    assert not errors, errors
    assert len(gale.observations) == 20
    assert [o["id"] for o in gale.observations] == list(range(1, 21))


def test_return_route_counts_only_real_stops_and_names_waypoints(gale):
    """Trasa powrotna: habitat nie jest „przystankiem”, a identyfikatory punktów idą razem z trasą (dla interfejsu)."""
    start(gale)
    walk_to_end(gale)
    assert gale.route["waypointIds"] == ["WP1", "WP2"] and gale.route["stops"] == 2
    back = gale.return_to_habitat()
    assert back["waypointIds"] == ["WP1", "WP2", "HAB"] and back["stops"] == 2
