"""Poprawki po przeglądzie z 10.11.2026: koniec EVA z całą załogą, raport i tlen, harmonogram, blokady API."""

import math

import pytest
from conftest import MISSION_IDS, make_engine

from backend.live import report
from backend.live.store import Store


def walk_to_target(e, dt=1.0, limit=100_000):
    for _ in range(limit):
        if e.next_wp >= len(e.wp_s):
            return
        e.step(dt)
    raise AssertionError("załoga nie doszła do celu")


@pytest.mark.parametrize("mission", MISSION_IDS)
def test_eva_ends_when_whole_crew_is_in_habitat(mission):
    e = make_engine(mission)
    e.rng.seed(1)
    assert e.start(600) is None
    walk_to_target(e)
    assert e.return_to_habitat()["ok"]
    assert e.start() is None
    for _ in range(100_000):
        if e.finished:
            break
        e.step(1.0)
    assert e.finished
    hab = e.cfg["habitat"]
    for c in e.snapshot()["crew"]:
        assert math.hypot(c["x"] - hab["x"], c["y"] - hab["y"]) < 0.5, c["id"]


def test_waypoint_is_reached_only_when_last_member_arrives(gale):
    assert gale.start(60) is None
    wp = gale.wp_s[0]
    while gale.crew_s < wp - 0.01:
        gale.step(0.05)
    assert gale.reached == []  # EV1 jest w punkcie, EV2 jeszcze nie
    while not gale.reached:
        gale.step(0.05)
    assert gale.gap == 0.0
    p0, p1 = gale.crew_pos(0), gale.crew_pos(1)
    assert math.hypot(p0["x"] - p1["x"], p0["y"] - p1["y"]) < 0.5


def test_report_shows_current_oxygen_shortage(gale):
    assert gale.start(600) is None
    for _ in range(20):
        gale.step(1.0)
    h5 = next(h for h in report.build(gale)["hazards"] if h["id"] == "H5")
    assert h5["level"] == "niskie"
    cap = gale.crew[1]["person"].o2_capacity_l
    gale.apply_telemetry("EV2", {"o2L": cap * 0.10})
    built = report.build(gale)
    h5 = next(h for h in built["hazards"] if h["id"] == "H5")
    assert h5["likelihood"] == 5 and h5["level"] == "wysokie"
    assert h5["value"].startswith("EV2: 10% O₂")
    assert built["effectiveness"]["o2MarginL"] < 0


def test_schedule_sets_start_time_and_crew_after_reset(client):
    eng = client.app.state.active()
    first = eng.scheduler.items[0]
    assert first["sol"] == eng.cfg["sol"]
    item = {**first, "startLtst": "11:05", "crew": ["EV2"]}
    assert client.put(f"/api/schedule/{first['id']}", json=item).status_code == 200
    assert eng.clock_str() == eng.cfg["startLtst"]  # bieżące wyjście się nie zmienia
    assert client.post("/api/eva/reset").status_code == 200
    state = client.get("/api/state").json()
    assert state["clock"] == "11:05"
    assert [c["id"] for c in state["crew"]] == ["EV2"]


def test_checkpoint_keeps_crew_and_start_of_the_running_eva(tmp_path):
    path = tmp_path / "a.db"
    e = make_engine("mount-sharp", Store(path))
    item = {**e.scheduler.items[0], "startLtst": "10:40", "crew": ["EV1"]}
    e.scheduler.upsert(item)
    e.reset()
    assert e.start(600) is None
    for _ in range(10):
        e.step(1.0)
    e.pause()
    e.scheduler.upsert({**item, "startLtst": "13:00", "crew": ["EV1", "EV2"]})  # zmiana po starcie
    again = make_engine("mount-sharp", Store(path))
    assert again.resumed
    assert [m["cfg"]["id"] for m in again.crew] == ["EV1"]
    assert again.start_min == 10 * 60 + 40


def test_plan_is_refused_during_and_after_eva(client):
    assert client.post("/api/plan").status_code == 200
    assert client.post("/api/eva/start", json={"timeScale": 600}).status_code == 200
    eng = client.app.state.active()
    eng.step(1.0)
    r = client.post("/api/plan", json={"start": {"x": 600, "y": 600}})
    assert r.status_code == 409 and "przed startem" in r.json()["error"]
    eng.finished = True
    assert client.post("/api/plan").status_code == 409


def test_state_reports_pause(client):
    assert client.get("/api/state").json()["paused"] is False
    client.post("/api/eva/start", json={"timeScale": 600})
    client.app.state.active().step(1.0)
    assert client.get("/api/state").json()["paused"] is False
    client.post("/api/eva/pause")
    s = client.get("/api/state").json()
    assert s["paused"] is True and s["phase"] in ("walking", "stop")


def test_scenario_skips_event_whose_waypoint_left_the_route(gale):
    gale.scenario = True
    assert gale.start(600) is None
    while "WP1" not in gale.reached:
        gale.step(1.0)
    gale.waypoints = [{**w, "id": f"X{k}"} for k, w in enumerate(gale.waypoints)]  # trasa bez WP1
    gale.step(1.0)  # dawniej: ValueError: 'WP1' is not in list


def test_telemetry_above_tank_capacity_is_rejected(client):
    cap = client.app.state.active().cfg["crew"][0]["o2CapacityL"]
    r = client.post("/api/telemetry", json={"id": "EV1", "o2L": cap + 1})
    assert r.status_code == 422 and "pojemność" in r.json()["error"]
    assert client.post("/api/telemetry", json={"id": "EV1", "o2L": cap}).status_code == 200
