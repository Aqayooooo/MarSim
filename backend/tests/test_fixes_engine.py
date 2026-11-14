"""Regresje poprawek: pułapka zgłoszonej przeszkody (P2), budżet tlenu planu i stan końcowy (P3),
zgłoszenie „bezpieczne” (M7) i pełna treść potwierdzenia z Ziemi."""

import math

import pytest

from backend import planning
from backend.live.dtn import FROM_EARTH


def started(e, walk_m: float = 0.0):
    e.plan()
    assert e.start(time_scale=60) is None
    while e.crew_s < walk_m and e.phase == "walking":
        e.step(0.5)
    return e


def finish(e, limit: int = 20000) -> bool:
    for _ in range(limit):
        if e.finished or not e.running:
            break
        e.step(2.0)
    return e.finished


def no_return_alarm(e) -> bool:
    return any("za mało tlenu na powrót" in a["text"] for a in e.alerts)


# ---------- P2: zgłoszona przeszkoda nie więzi załogi ani habitatu ----------
@pytest.mark.parametrize("radius", [20, 50])
def test_obstacle_on_crew_position_does_not_trap(engine, radius):
    e = started(engine, 300)
    p = e.crew_pos(0)
    result = e.add_observation({"kind": "glazy", "x": p["x"], "y": p["y"], "radiusM": radius})
    assert result["replanned"] and not e.route_blocked
    for _ in range(3):
        e.step(1.0)
    assert not no_return_alarm(e)
    route = e.return_to_habitat()
    assert route.get("ok", True), route
    assert finish(e)


def test_route_from_inside_obstacle_leaves_it_by_shortest_way(gale):
    e = started(gale, 300)
    p = e.crew_pos(0)
    radius = 30
    e.add_observation({"kind": "glazy", "x": p["x"], "y": p["y"], "radiusM": radius})
    onward = e.poly.slice(e.crew_s, e.poly.length)
    inside = 0.0
    for a, b in zip(onward[:-1], onward[1:]):
        mid = {"x": (a["x"] + b["x"]) / 2, "y": (a["y"] + b["y"]) / 2}
        if math.hypot(mid["x"] - p["x"], mid["y"] - p["y"]) < radius + planning.OBSTACLE_BUFFER_M:
            inside += math.hypot(b["x"] - a["x"], b["y"] - a["y"])
    assert inside < 1.5 * (radius + planning.OBSTACLE_BUFFER_M)  # wyjście z przeszkody, bez krążenia w niej


@pytest.mark.parametrize("radius", [10, 32])
def test_obstacle_on_habitat_keeps_return_possible(engine, radius):
    e = started(engine, 100)
    h = e.cfg["habitat"]
    e.add_observation({"kind": "glazy", "x": h["x"] + 3, "y": h["y"], "radiusM": radius, "source": "łazik"})
    assert float(e.o2_home[e.rc(h)]) < planning.UNREACHABLE
    for _ in range(3):
        e.step(1.0)
    assert not no_return_alarm(e)
    assert all(c["walkback"]["ok"] for c in e.snapshot()["crew"])
    route = e.return_to_habitat()
    assert route.get("ok", True), route
    assert finish(e)


def test_second_crew_member_inside_obstacle_has_finite_walkback(engine):
    e = started(engine, 200)
    p = e.crew_pos(len(e.crew) - 1)
    e.add_observation({"kind": "glazy", "x": p["x"], "y": p["y"], "radiusM": 20})
    for _ in range(3):
        e.step(1.0)
    walkbacks = [c["walkback"] for c in e.snapshot()["crew"]]
    assert all(w["needL"] < planning.UNREACHABLE for w in walkbacks)
    assert not no_return_alarm(e)


def ring_around_crew(e, ring_m: float = 50.0, radius: float = 12.0, count: int = 24) -> dict:
    """Zamknięty pierścień zgłoszonych przeszkód wokół załogi: nie obejmuje załogi, habitatu ani łazika,
    ale odcina jedyne wyjście z „kieszeni” — jak przeszkoda w wąskim przejściu."""
    p = e.crew_pos(0)
    for k in range(count):
        a = 2 * math.pi * k / count
        e.add_observation({"kind": "glazy", "x": p["x"] + ring_m * math.cos(a), "y": p["y"] + ring_m * math.sin(a), "radiusM": radius})
    for target in (e.cfg["habitat"], e.rover):
        assert math.hypot(target["x"] - p["x"], target["y"] - p["y"]) > ring_m + radius + planning.OBSTACLE_BUFFER_M + 20
    return p


def test_obstacle_sealing_pocket_does_not_cut_way_home(gale):
    e = started(gale, 300)
    h = e.cfg["habitat"]
    home = [{"id": "H", "x": h["x"], "y": h["y"], "stopMin": 0}]
    p = e.crew_pos(0)
    free = planning.plan(e.model, p, home, [], e.layers)
    ring_around_crew(e)
    # trasy naprzód zostają ścisłe: pierścień blokuje dalszą drogę do punktów
    assert e.route_blocked
    assert not planning.plan(e.model, p, home, e.obstacles, e.layers, release=e._release())["ok"]
    # ale nie drogę do domu: zapas na powrót jest skończony, trasy awaryjne istnieją
    assert float(e.o2_home[e.rc(p)]) < planning.UNREACHABLE
    assert all(c["walkback"]["needL"] < planning.UNREACHABLE for c in e.snapshot()["crew"])
    assert {"habitat", "rover"} <= set(e._emergency_routes())
    route = e.return_to_habitat()
    assert route.get("ok", True), route
    assert route["throughObstacle"] and not e.route_blocked
    assert route["o2L"] > free["o2L"]  # przejście przez przeszkodę jest drogie
    assert finish(e)


def test_cost_field_without_obstacles_is_unchanged(gale):
    plain = planning.cost_field(gale.model, gale.cfg["habitat"], "o2")
    far = [{"x": 5.0, "y": 5.0, "radiusM": 1.0}]  # w rogu mapy, z dala od wszystkiego
    with_far = planning.cost_field(gale.model, gale.cfg["habitat"], "o2", far)
    mask = ~planning.obstacle_mask(plain.shape, gale.cell, far)
    assert (plain[mask] == with_far[mask]).all()


@pytest.mark.parametrize("fraction", [0.0, 0.3, 0.6, 0.9, 0.97])
def test_boulders_land_ahead_with_clearance_or_are_skipped(engine, fraction):
    e = started(engine)
    while e.crew_s < fraction * e.wp_s[-1] and e.phase == "walking":
        e.step(0.5)
    event = next(ev for ev in e.mission["events"] if ev["id"] == "boulders")
    crew = [e.crew_pos(k) for k in range(len(e.crew))]
    targets = e.waypoints[e.next_wp :]
    count = len(e.obstacles)
    result = e.inject("boulders")
    if result.get("ok") is False:
        assert "Brak miejsca" in result["error"] and len(e.obstacles) == count
    else:
        o = e.obstacles[-1]
        clearance = event["radiusM"] + planning.OBSTACLE_BUFFER_M
        assert all(math.hypot(o["x"] - p["x"], o["y"] - p["y"]) > clearance for p in crew + targets)
        assert not e.route_blocked
    route = e.return_to_habitat()
    assert route.get("ok", True), route


# ---------- P3: budżet tlenu planu i stan końcowy ----------
def long_plan(e):
    """8 punktów: tam i z powrotem między punktami domyślnego planu, z długimi postojami (jak plan z przeglądu)."""
    base = e.cfg["waypoints"]
    return [{"id": f"W{i}", "x": base[i % len(base)]["x"], "y": base[i % len(base)]["y"], "stopMin": 90} for i in range(8)]


def test_default_plan_fits_oxygen_budget(engine):
    r = engine.plan()
    assert r["o2Budget"]["ok"] and r["rating"] != "niebezpieczna" and "ratingReason" not in r
    assert r["o2Budget"]["usableL"] == pytest.approx(min(c["o2CapacityL"] for c in engine.cfg["crew"]) * 0.8, abs=0.1)


def test_plan_over_oxygen_budget_is_unsafe_and_cannot_start(engine):
    r = engine.plan(waypoints=long_plan(engine))
    assert r["ok"]
    budget = r["o2Budget"]
    assert not budget["ok"] and budget["needL"] > budget["usableL"]
    assert budget["needL"] >= r["o2L"]  # z powrotem do habitatu
    assert r["rating"] == "niebezpieczna" and r["ratingReason"].startswith("za mało tlenu")
    problem = engine.start()
    assert problem is not None and problem.startswith("Start EVA odrzucony") and not engine.running


def test_start_over_budget_is_409(client):
    eng = client.app.state.active()
    wps = long_plan(eng)
    assert client.post("/api/plan", json={"waypoints": wps}).status_code == 200
    r = client.post("/api/eva/start")
    assert r.status_code == 409 and "za mało tlenu" in r.json()["error"]


def test_reserve_triggers_automatic_return(gale):
    e = started(gale, 200)
    member = e.crew[-1]
    reserve = e.cfg["eva"]["o2ReservePct"] / 100 * member["cfg"]["o2CapacityL"]
    e.apply_telemetry(member["cfg"]["id"], {"o2L": reserve - 1})
    e.step(0.5)
    assert e.returning and e.phase == "returning"
    assert any("automatyczny powrót" in a["text"] for a in e.alerts)


def test_empty_oxygen_stops_eva(gale):
    e = started(gale, 100)
    e.returning = True  # bez automatycznego powrotu: sprawdzamy sam stan końcowy
    e.apply_telemetry(e.crew[0]["cfg"]["id"], {"o2L": 0.0})
    e.step(0.5)
    assert not e.running
    assert any(a["text"].startswith("EVA przerwana: brak tlenu") for a in e.alerts)
    t = e.t
    for _ in range(10):
        e.step(1.0)
    assert e.t == t
    assert e.start() == "EVA przerwana: brak tlenu. Zresetuj symulację."


# ---------- M7: zgłoszenie „bezpieczne” ----------
def test_safe_report_replans_when_route_gets_better(gale):
    e = started(gale, 50)
    p = e.crew_pos(0)
    before = e.poly.length
    result = e.add_observation({"kind": "bezpieczne", "x": p["x"], "y": p["y"], "radiusM": 500})
    assert result["replanned"] and e.poly.length < before
    again = e.add_observation({"kind": "bezpieczne", "x": p["x"], "y": p["y"], "radiusM": 500})
    assert not again["replanned"]  # nic się już nie poprawi


def test_safe_report_removes_overlapping_obstacle(gale):
    e = started(gale, 150)
    ahead = e.poly.at(e.crew_s + 120)
    e.add_observation({"kind": "glazy", "x": ahead["x"], "y": ahead["y"], "radiusM": 20})
    assert len(e.obstacles) == 1
    detour = e.poly.length
    result = e.add_observation({"kind": "bezpieczne", "x": ahead["x"] + 15, "y": ahead["y"], "radiusM": 10})
    assert result["removedObstacles"] == 1 and e.obstacles == []
    assert result["replanned"] and e.poly.length < detour


# ---------- potwierdzenie z Ziemi ----------
def test_earth_reply_contains_full_text(gale):
    text = "x" * 30 + " zużycie O₂ do 123 L " + "y" * 40
    gale.add_log("EVA", text)
    replies = [b.text for b in gale.link.queue if b.direction == FROM_EARTH]
    assert replies[-1] == f"Kontrola misji: przyjęto „{text}”"
