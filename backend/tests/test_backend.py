"""Testy backendu MarSim:  python -m pytest backend/tests -q"""
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.models import orbits, physiology, radiation, sun  # noqa: E402
from backend.pipeline import boulders, sand, terrain  # noqa: E402

CFG = json.loads((ROOT / "backend" / "config" / "missions" / "mount-sharp.json").read_text(encoding="utf-8"))
MISSION = ROOT / "data" / "missions" / CFG["id"]


def test_sun_mars24_reference():
    # Przykład kontrolny z Allison & McEwen (2000): 2000-01-06 00:00 UTC → Ls ≈ 277,19°
    m = sun.mars_time(datetime(2000, 1, 6, tzinfo=timezone.utc))
    assert abs(m.ls - 277.19) < 0.05
    el, az = sun.sun_position(0.0, 0.0, 12.0)
    assert el == pytest.approx(90.0, abs=1e-6)


def test_light_time_range():
    d = orbits.earth_mars(datetime(2037, 1, 10, tzinfo=timezone.utc))
    assert 3.0 <= d["oneWayMin"] <= 22.5


def test_metabolic_and_o2_plausible():
    p = physiology.Person("EV1", 78, 125, 520, 520)
    flat = physiology.metabolic_w(p, 0.69, 0)
    uphill = physiology.metabolic_w(p, 0.69, 15)
    assert 200 < flat < 400 and uphill > flat
    assert 0.5 < physiology.o2_l_per_min(flat) < 1.3


def test_slope_sigma_formula():
    dem = np.tile(np.arange(20, dtype=np.float32) * 0.3, (20, 1))   # stała pochyłość 0,1 m/m przy kroku 3 m
    s, sig = terrain.slope_with_sigma(dem, 3.0, 0.2)
    assert s[10, 10] == pytest.approx(math.degrees(math.atan(0.1)), abs=0.01)
    assert sig[10, 10] == pytest.approx(math.degrees(0.2 / (math.sqrt(2) * 3) / 1.01), rel=1e-3)


def test_boulder_shadow_detection_synthetic():
    img = np.full((200, 200), 100.0, np.float32) + np.random.default_rng(1).normal(0, 2, (200, 200))
    # głaz 2 m (8 px) oświetlony z SW, cień na NE (az. słońca 225° → cień w stronę 45°)
    yy, xx = np.mgrid[0:200, 0:200]
    img[(xx - 100) ** 2 + (yy - 100) ** 2 < 16] = 160
    for k in range(10):
        img[(xx - 104 - k * 0.7) ** 2 + (yy - 96 + k * 0.7) ** 2 < 12] = 30
    out = boulders.detect(img, 0.25, 225.0, 40.0)
    assert out, "nie wykryto głazu"
    b = max(out, key=lambda b: b["confidence"])
    assert 1.0 <= b["diameterM"] <= 4.0 and b["heightM"] > 0.5


def test_sand_combine_weights():
    a = np.ones((4, 4), np.float32)
    p, c, w = sand.combine({"darkness": a, "ripples": a, "thermal": None, "imageSmooth": a, "dtmSmooth": a})
    assert np.allclose(p, 1) and "thermal" not in w
    assert radiation.limit_status(300)["level"] == "uwaga"


@pytest.mark.skipif(not (MISSION / "mission.json").exists(), reason="brak danych misji (uruchom backend/build.py)")
def test_engine_full_eva():
    from backend.live import report
    from backend.live.engine import EvaEngine
    e = EvaEngine(MISSION, CFG)
    r = e.plan()
    assert "path" in r and r["lengthM"] > 100
    # trasa nie wchodzi w strefy zakazane
    for p in r["path"]:
        assert e.layers["hazard"][e.rc(p)] < 2 or math.hypot(p["x"] - r["path"][0]["x"], p["y"] - r["path"][0]["y"]) < 6
    e.running, e.time_scale, e.scenario = True, 600, True
    for _ in range(400):
        e.step(0.1)
        if e.next_wp >= len(CFG["waypoints"]):
            break
    s = e.snapshot()
    assert s["reached"], "załoga nie doszła do żadnego punktu"
    assert all(c["o2Pct"] < 100 for c in s["crew"])
    assert "habitat" in s["emergency"]
    rep = report.build(e)
    assert rep["ok"] and rep["hazards"] and rep["summary"]
    assert e.scheduler.evaluate()["items"]


def test_crism_mineral_classes():
    from backend.pipeline import minerals as mnr
    z = np.zeros((2, 3), np.float32)
    p = {k: z.copy() for k in mnr.PARAMS}
    p["OLINDEX3"] = np.array([[0.02, 0.06, 0.12], [np.nan, 0.02, 0.02]], np.float32)
    p["D2300"][1, 1] = 0.02
    p["LCPINDEX2"][1, 2] = 0.02
    cls, conf = mnr.classify(p)
    assert cls.tolist() == [[0, 2, 1], [0, 5, 3]]
    assert conf[0, 2] == pytest.approx(1.0) and 0 < conf[0, 1] < 1
