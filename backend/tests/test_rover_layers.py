"""Warstwy z danych łazików i USGS: trasa łazika, zdjęcia Navcam (miniatury), geologia Jezero."""

import json
import math
from pathlib import Path

import pytest
from PIL import Image

from backend.pipeline.rover_track import Window, clip_segment, merge_segments

ROOT = Path(__file__).resolve().parents[2]
MISSIONS = ROOT / "data" / "missions"
WITH_TRACK = [m for m in ("mount-sharp", "jezero") if (MISSIONS / m / "roverTrack.json").exists()]


def test_clip_segment_keeps_inside_part():
    assert clip_segment(-10, 50, 50, 50, 100, 100) == ((0.0, 50.0), (50.0, 50.0))
    assert clip_segment(-10, -10, -5, -5, 100, 100) is None
    (a, b) = clip_segment(50, 50, 150, 150, 100, 100)
    assert a == (50, 50) and b == pytest.approx((100, 100))


def test_merge_touching_segments():
    assert merge_segments([[[0, 0], [1, 0]], [[1, 0], [2, 0]], [[9, 9], [10, 9]]]) == [[[0, 0], [1, 0], [2, 0]], [[9, 9], [10, 9]]]


def test_window_corners_map_to_area_edges():
    area = {"corners": {"nw": [137.0, -4.0], "se": [137.1, -4.1]}, "widthM": 1440, "heightM": 960}
    w = Window(area)
    assert w.xy(137.0, -4.0) == pytest.approx((0, 0))
    assert w.xy(137.1, -4.1) == pytest.approx((1440, 960))


@pytest.mark.parametrize("mission_id", WITH_TRACK)
def test_rover_track_inside_area(mission_id):
    d = MISSIONS / mission_id
    m = json.loads((d / "mission.json").read_text(encoding="utf-8"))
    T = json.loads((d / "roverTrack.json").read_text(encoding="utf-8"))
    W, H = m["area"]["widthM"], m["area"]["heightM"]
    assert any(l["id"] == "rover" and l["vector"]["file"] == "roverTrack.json" for l in m["layers"])
    assert T["segments"] and T["stops"]
    for seg in T["segments"]:
        for x, y in seg:
            assert -0.01 <= x <= W + 0.01 and -0.01 <= y <= H + 0.01
    length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for s in T["segments"] for a, b in zip(s, s[1:]))
    assert length == pytest.approx(T["lengthM"], rel=0.01)
    for s in T["stops"]:
        assert 0 <= s["x"] <= W and 0 <= s["y"] <= H and isinstance(s["sol"], int)


@pytest.mark.parametrize("mission_id", WITH_TRACK)
def test_rover_photos_have_thumbnails_and_geometry(mission_id):
    d = MISSIONS / mission_id
    T = json.loads((d / "roverTrack.json").read_text(encoding="utf-8"))
    for p in T.get("photos", []):
        assert 0 <= p["stop"] < len(T["stops"])
        assert 0 <= p["az"] < 360 and -35 <= p["el"] <= 15 and 0 < p["hfov"] < 120
        thumb = d / p["thumb"]
        assert thumb.exists(), p["thumb"]
        with Image.open(thumb) as im:
            assert im.width <= 320
        assert p["large"].startswith("https://mars.nasa.gov/") and p["credit"]


def test_jezero_geology_layer():
    d = MISSIONS / "jezero"
    if not (d / "geology.png").exists():
        pytest.skip("brak warstwy geologii")
    m = json.loads((d / "mission.json").read_text(encoding="utf-8"))
    layer = next(l for l in m["layers"] if l["id"] == "geology")
    r = layer["raster"]
    im = Image.open(d / r["file"])
    assert im.size == (r["width"], r["height"])
    assert r["width"] * r["cellM"] == m["area"]["widthM"]
    assert set(im.getextrema()) <= set(range(0, 4))
    assert {str(v) for v in range(1, im.getextrema()[1] + 1)} <= set(r["classes"])
