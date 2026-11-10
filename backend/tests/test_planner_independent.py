"""Planer trasy sprawdzony niezależną implementacją: własny model kosztu + własny Dijkstra na kopcu (czysty Python)."""

import heapq
import math

import numpy as np
import pytest
from conftest import cells, densify


def reference_cost(eng):
    """Koszt O₂ na komórkę przeliczony od zera z warstw i konfiguracji (bez backend.planning)."""
    eva, c0 = eng.cfg["eva"], eng.cfg["crew"][0]
    body, load = c0["bodyKg"], c0["loadKg"]
    slope_up = eng.layers["slope"].astype(np.float64) + 2 * eng.layers["slopeSigma"].astype(np.float64)
    grade = np.tan(np.radians(slope_up))
    speed = np.maximum(eva["walkKmh"] / 3.6 * np.exp(-3.5 * np.abs(grade)), 0.15)
    hazard = eng.layers["hazard"]
    eta = np.where(eng.layers["sand"] > 0.35, 2.1, np.where(hazard == 1, 1.5, 1.1))
    move = eta * (body + load) * (1.5 * speed**2 + 0.35 * speed * grade * 100) * 0.3794
    met = 0.55 * (1.5 * body + 2.0 * (body + load) * (load / body) ** 2 * 0.3794 + np.maximum(0, move)) + 60.0
    o2_per_m = met * 60 / 20100 / 60 / speed * np.where(hazard == 1, 1.6, 1.0)
    cost = o2_per_m * eng.cell
    cost[hazard == 2] = np.inf
    return cost


def reference_dijkstra(cost, start):
    """Dijkstra na 8 sąsiadach: krok po przekątnej tylko, gdy oba pola obok są przejezdne; waga = średni koszt × długość."""
    h, w = cost.shape
    c = cost.tolist()
    inf = math.inf
    dist = [[inf] * w for _ in range(h)]
    dist[start[0]][start[1]] = 0.0
    heap = [(0.0, start[0], start[1])]
    steps = [
        (-1, 0, 1.0),
        (1, 0, 1.0),
        (0, -1, 1.0),
        (0, 1, 1.0),
        (-1, -1, math.sqrt(2)),
        (-1, 1, math.sqrt(2)),
        (1, -1, math.sqrt(2)),
        (1, 1, math.sqrt(2)),
    ]
    while heap:
        d, r, k = heapq.heappop(heap)
        if d > dist[r][k]:
            continue
        here = c[r][k]
        for dr, dk, length in steps:
            rr, kk = r + dr, k + dk
            if not (0 <= rr < h and 0 <= kk < w) or c[rr][kk] == inf:
                continue
            if dr and dk and (c[r][kk] == inf or c[rr][k] == inf):
                continue
            nd = d + (here + c[rr][kk]) * 0.5 * length
            if nd < dist[rr][kk]:
                dist[rr][kk] = nd
                heapq.heappush(heap, (nd, rr, kk))
    return np.array(dist)


def test_cost_model_matches_independent_derivation(engine):
    ref = reference_cost(engine)
    mine = engine.model.cost_array("o2")
    assert np.array_equal(np.isfinite(ref), np.isfinite(mine))
    ok = np.isfinite(ref)
    assert np.allclose(ref[ok], mine[ok], rtol=1e-5)


def test_walkback_field_matches_reference_dijkstra(engine):
    cost = reference_cost(engine)
    hab = engine.rc(engine.cfg["habitat"])
    assert np.isfinite(cost[hab]), "habitat stoi w strefie zakazanej"
    ref = reference_dijkstra(cost, hab)
    field = engine.o2_home.astype(np.float64)
    reachable = np.isfinite(ref)
    assert np.all(field[~reachable] == 9999)
    assert np.allclose(field[reachable], ref[reachable], rtol=1e-4, atol=1e-3)


def test_walkback_file_on_disk_is_current(engine):
    """Plik o2ToHabitat.f32, który czyta interfejs, musi odpowiadać polu liczonemu przez backend."""
    h, w = engine.dem.shape
    on_disk = np.fromfile(engine.dir / "o2ToHabitat.f32", dtype="<f4").reshape(h, w)
    live = engine.o2_home
    reachable = live < 9999
    assert np.allclose(on_disk[reachable], live[reachable], rtol=0.02, atol=0.05)


def test_route_never_enters_forbidden_cells(engine):
    r = engine.plan()
    assert r["ok"]
    xy = densify(r["path"], 0.25)
    rows, cols = cells(engine, xy)
    start = engine.rc(r["path"][0])
    forbidden = (engine.layers["hazard"][rows, cols] == 2) & ~((rows == start[0]) & (cols == start[1]))
    assert forbidden.sum() == 0, f"{forbidden.sum() * 0.25:.1f} m trasy w strefie zakazanej"


def test_route_visits_waypoints_in_order(engine):
    r = engine.plan()
    wps = engine.cfg["waypoints"]
    assert len(r["waypointIndex"]) == len(wps)
    assert r["waypointIndex"] == sorted(r["waypointIndex"])
    for i, wp in zip(r["waypointIndex"], wps):
        assert r["path"][i] == {"x": wp["x"], "y": wp["y"]}
    assert r["path"][0] == {"x": engine.cfg["rover"]["x"], "y": engine.cfg["rover"]["y"]}


def test_reported_length_and_oxygen_are_consistent(engine):
    r = engine.plan()
    length = sum(math.hypot(b["x"] - a["x"], b["y"] - a["y"]) for a, b in zip(r["path"][:-1], r["path"][1:]))
    assert r["lengthM"] == pytest.approx(length, rel=1e-6)
    # tlen z własnego całkowania kosztu wzdłuż trasy (próbka co 0,25 m)
    xy = densify(r["path"], 0.25)
    rows, cols = cells(engine, xy[:-1])
    seg = np.hypot(*np.diff(xy, axis=0).T)
    per_m = reference_cost(engine) / engine.cell
    per_m[~np.isfinite(per_m)] = 0
    walking_o2 = float((per_m[rows, cols] * seg).sum())
    c0 = engine.cfg["crew"][0]
    rest_w = 0.55 * (1.5 * c0["bodyKg"] + 2.0 * (c0["bodyKg"] + c0["loadKg"]) * (c0["loadKg"] / c0["bodyKg"]) ** 2 * 0.3794) + 60
    stop_o2 = sum(w["stopMin"] for w in engine.cfg["waypoints"]) * (rest_w * 60 / 20100 + 0.02)
    assert r["o2L"] == pytest.approx(walking_o2 + stop_o2, rel=0.03)


def test_route_is_close_to_true_optimum(engine):
    """Trasa nie może być wyraźnie droższa niż optimum z niezależnego Dijkstry (4-sąsiedztwo zawyża drogę ≤ √2)."""
    cost = reference_cost(engine)
    pts = [{"x": engine.cfg["rover"]["x"], "y": engine.cfg["rover"]["y"]}] + engine.cfg["waypoints"]
    optimum = 0.0
    for a, b in zip(pts[:-1], pts[1:]):
        optimum += reference_dijkstra(cost, engine.rc(a))[engine.rc(b)]
    r = engine.plan()
    xy = densify(r["path"], 0.25)
    rows, cols = cells(engine, xy[:-1])
    per_m = cost / engine.cell
    per_m[~np.isfinite(per_m)] = 0
    walked = float((per_m[rows, cols] * np.hypot(*np.diff(xy, axis=0).T)).sum())
    assert optimum * 0.90 <= walked <= optimum * 1.01


def test_route_is_not_a_staircase(engine):
    """Trasa ma być bliska linii prostej tam, gdzie teren pozwala — nie liczona „po kratkach”."""
    r = engine.plan()
    pts = [{"x": engine.cfg["rover"]["x"], "y": engine.cfg["rover"]["y"]}] + engine.cfg["waypoints"]
    manhattan = sum(abs(b["x"] - a["x"]) + abs(b["y"] - a["y"]) for a, b in zip(pts[:-1], pts[1:]))
    assert r["lengthM"] < 0.9 * manhattan


def test_obstacle_forces_detour_around_it(engine):
    first = engine.plan()
    first_o2 = first["o2L"]
    mid = engine.poly.at(engine.poly.length * 0.5)
    res = engine.add_observation({"kind": "glazy", "x": mid["x"], "y": mid["y"], "radiusM": 30, "source": "dron"})
    assert res["replanned"]
    new = engine.route
    xy = densify(new["path"], 0.5)
    dist = np.hypot(xy[:, 0] - mid["x"], xy[:, 1] - mid["y"])
    assert dist.min() >= 30, f"nowa trasa przechodzi {dist.min():.1f} m od środka przeszkody o promieniu 30 m"
    assert new["lengthM"] >= first["lengthM"] and new["o2L"] > first_o2
    assert new["letter"] == "B"


def test_waypoint_in_forbidden_zone_is_rejected(engine):
    rows, cols = np.nonzero(engine.layers["hazard"] == 2)
    k = len(rows) // 2
    wp = {"id": "X", "x": (cols[k] + 0.5) * engine.cell, "y": (rows[k] + 0.5) * engine.cell, "stopMin": 0}
    r = engine.plan(waypoints=[wp])
    assert r["ok"] is False and "X" in r["error"]
    assert engine.route is None


def test_alternatives_explain_choice(engine):
    r = engine.plan()
    alts = {a["id"]: a for a in r["alternatives"]}
    assert alts["chosen"]["forbiddenM"] == 0
    if alts.get("shortest", {}).get("ok"):
        assert alts["shortest"]["lengthM"] <= alts["chosen"]["lengthM"] + 1
        assert alts["shortest"]["o2L"] >= alts["chosen"]["o2L"] - 0.2
