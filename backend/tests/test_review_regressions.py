import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import missions, planning
from backend.live import report, spaceweather
from backend.live.dtn import DtnLink
from backend.live.engine import EvaEngine
from backend.live.positioning import Positioner
from backend.live.store import Store
from backend.paths import MISSIONS
from backend.server import create_app


@pytest.fixture
def engine():
    return EvaEngine(MISSIONS / "mount-sharp", missions.config("mount-sharp"), live_feeds=False)


def test_obstacle_blocks_movement_but_consumes_resources(engine):
    e = engine
    e.plan()
    e.running = True
    w = e.waypoints[0]
    e.add_observation(dict(kind="glazy", x=w["x"], y=w["y"], radiusM=40))
    before = e.crew[0]["person"].o2_l
    e.step(1)
    assert e.route_blocked and e.crew_s == 0
    assert e.crew[0]["person"].o2_l < before


def test_home_obstacle_invalidates_walkback(engine):
    e = engine
    h = e.cfg["habitat"]
    e.add_observation(dict(kind="glazy", x=h["x"], y=h["y"], radiusM=32))
    assert not e.snapshot()["crew"][0]["walkback"]["ok"]


def test_goal_in_forbidden_cell_rejected(engine):
    rc = next(zip(*np.nonzero(engine.model.blocked)))
    r = engine.plan(waypoints=[dict(id="bad", **engine.model.to_xy(rc))])
    assert not r["ok"]


def test_stop_consumes_oxygen(engine):
    w = engine.cfg["waypoints"][0]
    a = engine.plan(waypoints=[{**w, "stopMin": 0}])
    b = engine.plan(waypoints=[{**w, "stopMin": 600}])
    assert b["o2L"] > a["o2L"] + 100
    assert b["alternatives"][0]["o2L"] == pytest.approx(b["o2L"], abs=0.2)


def test_short_route_report(engine):
    p = engine.cfg["rover"]
    r = engine.plan(p, [dict(id="near", x=p["x"] + 0.1, y=p["y"] + 0.1)])
    assert r["lengthM"] == pytest.approx(math.sqrt(0.02))
    assert report.build(engine)["ok"]


def test_stationary_odometry_does_not_grow():
    p = Positioner([], np.zeros((10, 10)), 3)
    values = [p.estimate("Bartek", dict(x=2, y=2), 100)["ellipse"]["a"] for _ in range(3)]
    assert values == [4, 4, 4]


def test_missing_noaa_is_unknown():
    r = spaceweather.summarize(dict(errors=["NOAA"], protons10MeV=[]), "test")
    assert r["pfu"] is None and r["stormLevel"] == "brak danych"


def test_outage_does_not_deliver_reply_immediately(engine):
    link = DtnLink(engine.date)
    link.outage_until_s = 5000
    link.send(0, "test", "a", reply="ok")
    assert not link.step(5000)
    delivered = link.step(6500)
    assert any(b.direction == "do Ziemi" for b in delivered)
    assert not any(b.direction == "z Ziemi" for b in delivered)


def test_telemetry_and_schedule_conflicts():
    app = create_app(store=Store(":memory:"), start_loop=False, live_feeds=False)
    api = TestClient(app)
    assert api.post("/api/telemetry", json={"id": "Bartek"}).status_code == 422
    assert api.post("/api/telemetry", json=dict(id="Bartek", hr=211, x=15, y=22)).status_code == 200
    crew = api.get("/api/state").json()["crew"][0]
    assert (crew["hr"], crew["x"], crew["y"]) == (211, 15, 22)
    item = api.get("/api/schedule").json()["items"][0]
    body = {k: item[k] for k in ("id", "sol", "startLtst", "durationH", "crew", "purpose")}
    assert api.post("/api/schedule", json=body).status_code == 409
    assert api.post("/api/eva/reset", headers={"X-MarSim-Mission": "jezero"}).status_code == 409


def test_segment_clear_detects_tiny_corner_intersection():
    from types import SimpleNamespace

    blocked = np.zeros((4, 4), bool)
    blocked[1, 1] = True
    model = SimpleNamespace(cell=1)
    # Only 0.1 mm of the segment lies in the forbidden cell.
    assert not planning._segment_clear(model, dict(x=0.5, y=1.4999), dict(x=2.5, y=3.4999), blocked)
    assert planning._segment_clear(model, dict(x=0.5, y=0.5), dict(x=3.5, y=0.5), blocked)


def test_paused_snapshots_reuse_position_estimate(engine, monkeypatch):
    calls = []
    original = engine.positioner.estimate

    def estimate(*args):
        calls.append(args)
        return original(*args)

    monkeypatch.setattr(engine.positioner, "estimate", estimate)
    first = engine.snapshot()
    for _ in range(10):
        assert engine.snapshot()["crew"][0]["est"] == first["crew"][0]["est"]
    assert len(calls) == len(engine.crew)
    engine.t += 2
    engine.snapshot()
    assert len(calls) == 2 * len(engine.crew)
