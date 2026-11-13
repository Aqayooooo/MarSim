"""Niezależne testy API (czarna skrzynka przez FastAPI TestClient) wg docs/KONTRAKT_DANYCH.md i README.

Jedna aplikacja na moduł (baza w katalogu tymczasowym, bez pobierania pogody kosmicznej); przed każdym testem
aktywna jest misja startowa po resecie EVA, więc testy nie zależą od kolejności. Identyfikatory załogi pochodzą
z danych misji (/missions/current/mission.json), nie są wpisane na sztywno.
"""

from __future__ import annotations

import csv
import io
import math
import re
import uuid

import pytest
from fastapi.testclient import TestClient

from backend import __version__
from backend.server import MISSION_HEADER, create_app

FIRST = "mount-sharp"


@pytest.fixture(scope="module")
def api(tmp_path_factory):
    app = create_app(start_loop=False, live_feeds=False, db_dir=tmp_path_factory.mktemp("marsim-db"), mission=FIRST)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def c(api):
    """Klient z czystym stanem: misja startowa aktywna, EVA zresetowana."""
    if api.get("/api/health").json()["mission"] != FIRST:
        assert api.post("/api/missions/select", json={"id": FIRST}).status_code == 200
    assert api.post("/api/eva/reset").status_code == 200
    yield api
    if api.get("/api/health").json()["mission"] != FIRST:
        api.post("/api/missions/select", json={"id": FIRST})


def mission(c) -> dict:
    return c.get("/missions/current/mission.json").json()


def crew_ids(c) -> list[str]:
    return [m["id"] for m in mission(c)["crew"]]


def area(c) -> tuple[float, float]:
    a = mission(c)["area"]
    return a["widthM"], a["heightM"]


def assert_error(r, status):
    assert r.status_code == status, r.text[:400]
    body = r.json()
    assert body["ok"] is False and isinstance(body["error"], str) and body["error"]


def schedule_item(c, **kw) -> dict:
    item = {
        "id": "T-" + uuid.uuid4().hex[:8],
        "sol": 900,
        "startLtst": "10:00",
        "durationH": 2.0,
        "crew": crew_ids(c)[:1],
        "purpose": "test",
    }
    item.update(kw)
    return item


# ================================================================ zdrowie, misje, pliki
def test_health_reports_mission_version_and_session(c):
    h = c.get("/api/health").json()
    assert h["ok"] is True and h["mission"] == FIRST
    assert h["version"] == __version__ and re.fullmatch(r"\d+\.\d+\.\d+", h["version"])
    assert h["synthetic"] is False
    assert isinstance(h["session"], int) and h["session"] >= 1


def test_missions_list_has_both_areas_with_one_active(c):
    body = c.get("/api/missions").json()
    ids = [m["id"] for m in body["missions"]]
    assert {"mount-sharp", "jezero"} <= set(ids)
    assert [m["id"] for m in body["missions"] if m["active"]] == [body["active"]] == [FIRST]
    for m in body["missions"]:
        assert set(m["label"]) == {"pl", "en"}
        assert -90 <= m["center"]["lat"] <= 90 and -180 <= m["center"]["lon"] <= 360


def test_mission_centers_match_readme_coordinates(c):
    centers = {m["id"]: m["center"] for m in c.get("/api/missions").json()["missions"]}
    assert centers["mount-sharp"]["lat"] == pytest.approx(-4.67, abs=0.01)
    assert centers["mount-sharp"]["lon"] == pytest.approx(137.38, abs=0.01)
    assert centers["jezero"]["lat"] == pytest.approx(18.44, abs=0.01)
    assert centers["jezero"]["lon"] == pytest.approx(77.45, abs=0.01)


def test_mission_switch_changes_active_engine_and_back(c):
    r = c.post("/api/missions/select", json={"id": "jezero"})
    assert r.status_code == 200 and r.json() == {"ok": True, "active": "jezero"}
    assert c.get("/api/health").json()["mission"] == "jezero"
    assert c.get("/api/state").json()["missionId"] == "jezero"
    assert mission(c)["mission"]["id"] == "jezero"
    again = c.post("/api/missions/select", json={"id": "jezero"})
    assert again.json()["active"] == "jezero"  # idempotentne
    assert c.post("/api/missions/select", json={"id": FIRST}).json()["active"] == FIRST
    assert c.get("/api/state").json()["missionId"] == FIRST


def test_mission_switch_pauses_running_eva(c):
    c.post("/api/eva/start")
    c.post("/api/missions/select", json={"id": "jezero"})
    c.post("/api/missions/select", json={"id": FIRST})
    assert c.get("/api/state").json()["running"] is False


@pytest.mark.parametrize(
    "body,status", [({"id": "mars-base-x"}, 404), ({"id": "Jezero!"}, 422), ({}, 422), ({"id": "jezero", "x": 1}, 422)]
)
def test_mission_select_validation(c, body, status):
    assert_error(c.post("/api/missions/select", json=body), status)


def test_stale_mission_header_rejected_with_409(c):
    r = c.post("/api/eva/start", headers={MISSION_HEADER: "jezero"})
    assert_error(r, 409)
    assert c.get("/api/state").json()["running"] is False
    ok = c.post("/api/eva/pause", headers={MISSION_HEADER: FIRST})
    assert ok.status_code == 200


def test_mission_files_served_and_traversal_blocked(c):
    m = c.get("/missions/current/mission.json")
    assert m.status_code == 200 and m.json()["contractVersion"] in (1, 2)
    dem = mission(c)["dem"]
    raw = c.get(f"/missions/current/{dem['file']}")
    assert raw.status_code == 200 and len(raw.content) == dem["width"] * dem["height"] * 4
    assert c.get("/missions/jezero/mission.json").json()["mission"]["id"] == "jezero"
    assert_error(c.get("/missions/current/../../backend/server.py"), 404)
    assert_error(c.get("/missions/current/%2e%2e/%2e%2e/README.md"), 404)
    assert_error(c.get("/missions/nope/mission.json"), 404)
    assert_error(c.get("/missions/current/no-such-file.png"), 404)


def test_mission_json_contract_fields(c):
    m = mission(c)
    for key in ("contractVersion", "mission", "area", "dem", "layers", "rover", "waypoints", "crew", "eva"):
        assert key in m
    assert m["area"]["widthM"] == pytest.approx(m["dem"]["width"] * m["dem"]["cellM"])
    assert m["area"]["heightM"] == pytest.approx(m["dem"]["height"] * m["dem"]["cellM"])
    ids = [layer["id"] for layer in m["layers"]]
    assert len(ids) == len(set(ids))
    assert {"optical", "hazards"} <= set(ids)
    w, h = m["area"]["widthM"], m["area"]["heightM"]
    for p in [m["rover"], *m["waypoints"], m["habitat"]]:
        assert 0 <= p["x"] <= w and 0 <= p["y"] <= h


def test_index_page_marks_backend_and_static_assets(c):
    r = c.get("/")
    assert r.status_code == 200 and 'name="marsim-api"' in r.text
    assert c.get("/styles.css").status_code == 200
    assert c.get("/src/main.js").status_code == 200
    assert c.get("/data/demo/mission.json").status_code == 200
    assert c.get("/backend/server.py").status_code == 404, "kod serwera nie jest publiczny"
    assert c.get("/.git/config").status_code == 404


def test_openapi_lists_documented_endpoints(c):
    paths = c.get("/api/openapi.json").json()["paths"]
    for p in (
        "/api/health",
        "/api/plan",
        "/api/state",
        "/api/eva/start",
        "/api/telemetry",
        "/api/schedule",
        "/api/report",
        "/api/link/send",
    ):
        assert p in paths, p


def test_unknown_api_path_gives_json_404(c):
    assert_error(c.get("/api/does-not-exist"), 404)


def test_provenance_lists_sources_with_hashes(c):
    p = c.get("/api/provenance").json()
    assert p["sources"]
    for s in p["sources"]:
        assert s["id"] and s["instrument"]
    hashed = [s for s in p["sources"] if s.get("sha256")]
    assert hashed and all(re.fullmatch(r"[0-9a-f]{64}", s["sha256"]) for s in hashed)


def test_spaceweather_without_live_feeds_says_unavailable(c):
    sw = c.get("/api/spaceweather").json()
    assert sw["available"] is False and sw["summary"]


# ================================================================ plan trasy
def test_plan_default_route_contract(c):
    r = c.post("/api/plan")
    assert r.status_code == 200
    route = r.json()
    m = mission(c)
    assert route["ok"] is True
    assert route["path"][0] == {"x": m["rover"]["x"], "y": m["rover"]["y"]}
    assert len(route["waypointIndex"]) == len(m["waypoints"])
    for i, wp in zip(route["waypointIndex"], m["waypoints"]):
        assert route["path"][i] == {"x": wp["x"], "y": wp["y"]}
    length = sum(math.hypot(b["x"] - a["x"], b["y"] - a["y"]) for a, b in zip(route["path"][:-1], route["path"][1:]))
    assert route["lengthM"] == pytest.approx(length, rel=1e-6)
    assert route["stops"] == len(m["waypoints"])
    assert route["rating"] in ("bezpieczna", "bezpieczna z uwagami")
    assert route["durationH"] > sum(w["stopMin"] for w in m["waypoints"]) / 60
    assert route["o2L"] > 0
    assert route["letter"] == "A"
    assert all(set(p) == {"x", "y"} for p in route.get("expanded", []))


def test_plan_custom_start_waypoints_and_letter(c):
    w, h = area(c)
    body = {
        "start": {"x": 300, "y": 760},
        "waypoints": [{"id": "Q1", "x": 500, "y": 650, "stopMin": 5}],
        "letter": "K",
    }
    route = c.post("/api/plan", json=body).json()
    assert route["ok"] and route["letter"] == "K"
    assert route["path"][0] == {"x": 300, "y": 760}
    assert route["path"][-1] == {"x": 500, "y": 650}
    got = c.get("/api/route").json()
    assert got["version"] == route["version"]
    assert [p["id"] for p in got["waypoints"]] == ["Q1"]
    assert got["route"]["path"] == route["path"]


def test_plan_is_deterministic_and_bumps_version(c):
    a = c.post("/api/plan").json()
    b = c.post("/api/plan").json()
    assert a["path"] == b["path"] and a["o2L"] == b["o2L"] and a["lengthM"] == b["lengthM"]
    assert b["version"] == a["version"] + 1


def test_plan_accepts_waypoints_echoed_with_descriptive_fields(c):
    """UI odsyła punkty z mission.json razem z polami opisowymi (target, view)."""
    wps = mission(c)["waypoints"]
    r = c.post("/api/plan", json={"waypoints": wps})
    assert r.status_code == 200 and r.json()["ok"]


@pytest.mark.parametrize(
    "body",
    [
        {"letter": "a"},
        {"letter": "AB"},
        {"waypoints": []},
        {"waypoints": [{"id": f"W{i}", "x": 400, "y": 400} for i in range(21)]},
        {"waypoints": [{"id": "", "x": 400, "y": 400}]},
        {"waypoints": [{"id": "W", "x": 400, "y": 400, "stopMin": -1}]},
        {"waypoints": [{"id": "W", "x": 400, "y": 400, "stopMin": 601}]},
        {"start": {"x": "abc", "y": 1}},
        {"missionId": "eva-1"},
        {"start": {"x": 1e6, "y": 0}},
    ],
)
def test_plan_validation_errors_are_422(c, body):
    assert_error(c.post("/api/plan", json=body), 422)


def test_plan_point_outside_area_is_422(c):
    w, h = area(c)
    assert_error(c.post("/api/plan", json={"start": {"x": w + 10, "y": 10}}), 422)
    assert_error(c.post("/api/plan", json={"waypoints": [{"id": "W", "x": 10, "y": -1}]}), 422)


def test_plan_goal_in_forbidden_zone_is_409_with_reason(c):
    import numpy as np
    from PIL import Image

    from backend.paths import MISSIONS

    hz = np.array(Image.open(MISSIONS / FIRST / "hazards.png"))
    cell = mission(c)["dem"]["cellM"]
    rows, cols = np.nonzero(hz == 2)
    k = len(rows) // 2
    x, y = (cols[k] + 0.5) * cell, (rows[k] + 0.5) * cell
    r = c.post("/api/plan", json={"waypoints": [{"id": "ZAKAZ", "x": x, "y": y}]})
    assert_error(r, 409)
    assert "ZAKAZ" in r.json()["error"]


def test_plan_rejected_while_running_and_after_start(c):
    c.post("/api/eva/start")
    assert_error(c.post("/api/plan"), 409)
    c.app.state.active().step(0.1)  # bez pętli symulacji: jeden krok, żeby wyjście faktycznie trwało
    c.post("/api/eva/pause")
    assert_error(c.post("/api/plan"), 409)
    c.post("/api/eva/reset")
    assert c.post("/api/plan").status_code == 200


def test_route_before_plan_is_empty(c):
    r = c.get("/api/route").json()
    assert r["route"] is None and r["version"] == 0 and r["discarded"] == []
    assert [w["id"] for w in r["waypoints"]] == [w["id"] for w in mission(c)["waypoints"]]


def test_sensitivity_requires_route_then_returns_variants(c):
    assert_error(c.get("/api/sensitivity"), 409)
    c.post("/api/plan")
    s = c.get("/api/sensitivity").json()
    assert s["ok"] is True
    limits = [v["maxSlopeDeg"] for v in s["variants"]]
    assert min(limits) == 20 and max(limits) == 30 and limits == sorted(limits)
    assert s["currentMaxSlopeDeg"] == mission(c)["eva"]["maxSlopeDeg"]
    iv = s["interval"]
    assert iv["o2L"]["low"] <= iv["o2L"]["mid"] <= iv["o2L"]["high"]
    assert iv["durationH"]["low"] <= iv["durationH"]["mid"] <= iv["durationH"]["high"]
    assert c.get("/api/sensitivity").json() == s, "wynik dla tej samej wersji trasy się nie zmienia"


# ================================================================ sterowanie EVA i stan
def test_state_idle_shape(c):
    s = c.get("/api/state").json()
    assert s["phase"] == "idle" and s["running"] is False and s["paused"] is False and s["finished"] is False
    assert s["t"] == 0
    assert [m["id"] for m in s["crew"]] == crew_ids(c)
    first = next((i for i in c.get("/api/schedule").json()["items"] if i["sol"] == s["sol"]), None)
    assert s["clock"] == (first["startLtst"] if first else mission(c)["mission"]["startClock"])
    for m in s["crew"]:
        assert m["o2Pct"] == 100 and 0 <= m["zone"] <= 2 and m["comms"] in (0, 1, 2)


def test_state_is_idempotent_without_steps(c):
    a = c.get("/api/state").json()
    b = c.get("/api/state").json()
    assert a == b


def test_start_without_plan_plans_and_runs(c):
    r = c.post("/api/eva/start", json={"timeScale": 120})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "running": True, "timeScale": 120, "phase": "walking"}
    s = c.get("/api/state").json()
    assert s["routeVersion"] >= 1 and s["running"] is True
    assert c.get("/api/route").json()["route"]["ok"] is True


def test_pause_resume_and_pause_idempotent(c):
    c.post("/api/eva/start")
    app_engine = c.app.state.active()
    app_engine.step(1.0)
    p1 = c.post("/api/eva/pause").json()
    p2 = c.post("/api/eva/pause").json()
    assert p1 == p2 and p1["running"] is False
    s = c.get("/api/state").json()
    assert s["paused"] is True and s["phase"] in ("walking", "stop")
    assert c.post("/api/eva/start").json()["running"] is True


def test_start_with_body_null_and_empty(c):
    assert c.post("/api/eva/start", json={}).status_code == 200
    c.post("/api/eva/reset")
    assert c.post("/api/eva/start").status_code == 200


@pytest.mark.parametrize("scale", [0, -1, 5001, "fast"])
def test_timescale_validation(c, scale):
    assert_error(c.post("/api/eva/timescale", json={"timeScale": scale}), 422)
    assert_error(c.post("/api/eva/start", json={"timeScale": scale}), 422)


def test_timescale_change_applies(c):
    r = c.post("/api/eva/timescale", json={"timeScale": 600})
    assert r.json()["timeScale"] == 600
    assert c.get("/api/state").json()["timeScale"] == 600


def test_reset_starts_new_session_and_clears_state(c):
    c.post("/api/eva/start")
    c.app.state.active().step(1.0)
    session = c.get("/api/health").json()["session"]
    r = c.post("/api/eva/reset").json()
    assert r["running"] is False and r["phase"] == "idle"
    s = c.get("/api/state").json()
    assert s["session"] == session + 1 and s["t"] == 0 and s["routeVersion"] == 0
    assert c.get("/api/observations").json() == {"observations": [], "obstacles": []}


def test_return_requires_route_and_cannot_repeat(c):
    assert_error(c.post("/api/eva/return"), 409)
    c.post("/api/eva/start")
    c.app.state.active().step(1.0)
    r = c.post("/api/eva/return")
    assert r.status_code == 200 and r.json()["waypointIds"][-1] == "HAB"
    assert c.get("/api/state").json()["phase"] == "returning"
    assert_error(c.post("/api/eva/return"), 409)


def test_full_eva_through_api_ends_in_habitat(c):
    c.post("/api/eva/start", json={"timeScale": 600})
    eng = c.app.state.active()
    for _ in range(400):
        if c.get("/api/state").json()["phase"] == "atTarget":
            break
        eng.step(1.0)
    assert c.get("/api/state").json()["phase"] == "atTarget"
    c.post("/api/eva/return")
    for _ in range(400):
        if c.get("/api/state").json()["finished"]:
            break
        eng.step(1.0)
    s = c.get("/api/state").json()
    hab = mission(c)["habitat"]
    assert s["phase"] == "done" and s["running"] is False and s["paused"] is False
    assert all(math.hypot(m["x"] - hab["x"], m["y"] - hab["y"]) < 1 for m in s["crew"])
    assert_error(c.post("/api/eva/start"), 409)
    assert_error(c.post("/api/plan"), 409)


@pytest.mark.parametrize("kind", ["meteor", "", None])
def test_inject_unknown_kind_is_422(c, kind):
    assert_error(c.post("/api/eva/inject", json={"kind": kind}), 422)


def test_inject_boulders_without_route_is_409(c):
    assert_error(c.post("/api/eva/inject", json={"kind": "boulders"}), 409)


def test_inject_sep_and_end(c):
    c.post("/api/eva/start")
    assert c.post("/api/eva/inject", json={"kind": "sep"}).json()["ok"] is True
    s = c.get("/api/state").json()
    assert s["sep"] is True and s["spaceWeather"]["simulatedPfu"] > 0 and s["rover"]["mode"] == "toCrew"
    c.post("/api/eva/inject", json={"kind": "sep-end"})
    assert c.get("/api/state").json()["sep"] is False


def test_inject_link_outage_takes_link_down(c):
    c.post("/api/eva/start")
    c.app.state.active().step(0.5)
    c.post("/api/eva/inject", json={"kind": "link-outage"})
    assert c.get("/api/link").json()["up"] is False


# ================================================================ telemetria
def test_telemetry_valid_switches_source_to_suit(c):
    who = crew_ids(c)[0]
    r = c.post("/api/telemetry", json={"id": who, "o2L": 300, "hr": 88, "batteryPct": 70})
    assert r.status_code == 200 and r.json() == {"ok": True}
    m = next(m for m in c.get("/api/state").json()["crew"] if m["id"] == who)
    assert m["source"] == "skafander" and m["o2L"] == 300 and m["hr"] == 88 and m["batteryPct"] == 70
    assert set(m["telemetryFields"]) == {"o2L", "hr", "batteryPct"}


def test_telemetry_position_requires_both_coordinates_inside_area(c):
    who = crew_ids(c)[0]
    w, h = area(c)
    assert_error(c.post("/api/telemetry", json={"id": who, "x": 100}), 422)
    assert_error(c.post("/api/telemetry", json={"id": who, "x": w + 1, "y": 5}), 422)
    assert c.post("/api/telemetry", json={"id": who, "x": 400, "y": 500}).status_code == 200
    m = next(m for m in c.get("/api/state").json()["crew"] if m["id"] == who)
    assert (m["x"], m["y"]) == (400, 500)


def test_telemetry_o2_over_tank_capacity_is_422(c):
    from backend import missions as mis

    cfg = {m["id"]: m for m in mis.config(FIRST)["crew"]}
    who = crew_ids(c)[-1]
    cap = cfg[who]["o2CapacityL"]
    assert_error(c.post("/api/telemetry", json={"id": who, "o2L": cap + 1}), 422)
    assert c.post("/api/telemetry", json={"id": who, "o2L": cap}).status_code == 200


@pytest.mark.parametrize(
    "body,status",
    [
        ({"id": "nobody-zz", "o2L": 10}, 404),
        ({"id": "__CREW__"}, 422),
        ({"id": "__CREW__", "hr": 19}, 422),
        ({"id": "__CREW__", "hr": 251}, 422),
        ({"id": "__CREW__", "batteryPct": 101}, 422),
        ({"id": "__CREW__", "co2mmHg": -1}, 422),
        ({"id": "__CREW__", "o2L": 10, "temp": 3}, 422),
        ({"o2L": 10}, 422),
        ({"id": "", "o2L": 10}, 422),
    ],
)
def test_telemetry_validation(c, body, status):
    if body.get("id") == "__CREW__":
        body = {**body, "id": crew_ids(c)[0]}
    assert_error(c.post("/api/telemetry", json=body), status)


def test_malformed_json_is_422_not_500(c):
    r = c.post("/api/telemetry", content=b"{not json", headers={"Content-Type": "application/json"})
    assert_error(r, 422)


# ================================================================ zgłoszenia
def test_observation_obstacle_stored_and_listed(c):
    body = {"kind": "glazy", "x": 700, "y": 400, "radiusM": 25, "source": "dron"}
    r = c.post("/api/observations", json=body).json()
    assert r["observation"]["kind"] == "glazy" and r["replanned"] is False
    got = c.get("/api/observations").json()
    assert got["obstacles"] == [{"x": 700, "y": 400, "radiusM": 25, "kind": "glazy", "source": "dron"}]
    hist = c.get("/api/observations/history?limit=1").json()["observations"]
    assert hist[0]["kind"] == "glazy" and hist[0]["x"] == 700


def test_observation_on_planned_route_before_start_replans(c):
    route = c.post("/api/plan").json()
    mid = route["path"][len(route["path"]) // 2]
    r = c.post("/api/observations", json={"kind": "osuwisko", "x": mid["x"], "y": mid["y"], "radiusM": 15}).json()
    assert r["replanned"] is True
    new = c.get("/api/route").json()
    assert new["version"] > route["version"]
    pts = new["route"]["path"]
    # żaden wierzchołek nowej trasy nie leży w przeszkodzie
    assert all(math.hypot(p["x"] - mid["x"], p["y"] - mid["y"]) > 15 for p in pts)


def test_safe_observation_adds_no_obstacle(c):
    r = c.post("/api/observations", json={"kind": "bezpieczne", "x": 600, "y": 500})
    assert r.status_code == 200
    assert c.get("/api/observations").json()["obstacles"] == []


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "lava", "x": 10, "y": 10},
        {"kind": "glazy", "x": 10, "y": 10, "radiusM": 0},
        {"kind": "glazy", "x": 10, "y": 10, "radiusM": 501},
        {"kind": "glazy", "x": 10, "y": 10, "source": "satelita"},
        {"kind": "glazy", "x": -5, "y": 10},
        {"kind": "glazy", "y": 10},
    ],
)
def test_observation_validation(c, body):
    assert_error(c.post("/api/observations", json=body), 422)


def test_observations_history_limit_validation(c):
    assert_error(c.get("/api/observations/history?limit=0"), 422)
    assert_error(c.get("/api/observations/history?limit=5001"), 422)


# ================================================================ dziennik
def test_log_records_actions_with_session_and_verifies(c):
    c.post("/api/plan")
    events = c.get("/api/log?limit=5").json()
    session = c.get("/api/health").json()["session"]
    assert events["session"] == session
    kinds = [e["kind"] for e in events["events"]]
    assert "trasa" in kinds
    ids = [e["id"] for e in events["events"]]
    assert ids == sorted(ids, reverse=True), "najnowsze najpierw"
    v = c.get("/api/log/verify").json()
    assert v["ok"] is True and v["brokenAt"] is None and re.fullmatch(r"[0-9a-f]{64}", v["head"])


def test_log_session_filter(c):
    session = c.get("/api/health").json()["session"]
    events = c.get(f"/api/log?session={session}&limit=1000").json()["events"]
    assert events and all(e["session"] == session for e in events)
    assert_error(c.get("/api/log?session=0"), 422)
    assert_error(c.get("/api/log?limit=0"), 422)


def test_log_export_csv_has_bom_header_and_hash_column(c):
    c.post("/api/plan")
    r = c.get("/api/log/export")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"] and FIRST in r.headers["content-disposition"]
    text = r.content.decode("utf-8")
    assert text.startswith("\ufeff")
    rows = list(csv.reader(io.StringIO(text.lstrip("\ufeff"))))
    assert rows[0] == ["id", "utc", "session", "mission_t_s", "clock_ltst", "kind", "text", "meta", "sha256"]
    ids = [int(r[0]) for r in rows[1:]]
    assert ids == sorted(ids), "od najstarszego wpisu"
    assert all(re.fullmatch(r"[0-9a-f]{64}", r[8]) for r in rows[1:])
    session = c.get("/api/health").json()["session"]
    only = list(csv.reader(io.StringIO(c.get(f"/api/log/export?session={session}").content.decode("utf-8").lstrip("\ufeff"))))
    assert all(r[2] == str(session) for r in only[1:])


# ================================================================ łącze z Ziemią
def test_link_status_and_send(c):
    link = c.get("/api/link").json()
    assert 3 <= link["oneWayMin"] <= 22.5
    assert link["distanceMkm"] == pytest.approx(link["oneWayMin"] * 60 * 299_792.458 / 1e6, rel=0.01)
    r = c.post("/api/link/send", json={"text": "Test łącza"}).json()
    assert isinstance(r["id"], int)
    assert r["deliverInMin"] == pytest.approx(link["oneWayMin"], abs=0.2)
    after = c.get("/api/link").json()
    assert after["pendingOut"] >= 1 and any(b["text"] == "Test łącza" for b in after["recent"])


@pytest.mark.parametrize("body", [{"text": ""}, {"text": "x" * 501}, {}, {"text": "a", "kind": "k" * 41}, {"text": "a", "to": "Mars"}])
def test_link_send_validation(c, body):
    assert_error(c.post("/api/link/send", json=body), 422)


# ================================================================ harmonogram
def test_schedule_default_uses_mission_crew_and_rules(c):
    s = c.get("/api/schedule").json()
    known = set(crew_ids(c))
    assert s["rules"] and s["items"]
    for item in s["items"]:
        assert set(item["crew"]) <= known
        h, m = (int(v) for v in item["startLtst"].split(":"))
        end = (h * 60 + m + round(item["durationH"] * 60)) % 1440
        assert item["endLtst"] == f"{end // 60:02d}:{end % 60:02d}"
    keys = [(i["sol"], i["startLtst"]) for i in s["items"]]
    assert keys == sorted(keys)
    d = s["daylight"]
    assert d["sunriseLtst"] + d["sunsetLtst"] == pytest.approx(24, abs=0.011)


def test_schedule_crud_round_trip(c):
    item = schedule_item(c)
    created = c.post("/api/schedule", json=item)
    assert created.status_code == 200
    assert any(i["id"] == item["id"] for i in created.json()["items"])
    assert_error(c.post("/api/schedule", json=item), 409)
    changed = {**item, "durationH": 3.5, "startLtst": "11:15"}
    updated = c.put(f"/api/schedule/{item['id']}", json=changed).json()
    got = next(i for i in updated["items"] if i["id"] == item["id"])
    assert got["durationH"] == 3.5 and got["startLtst"] == "11:15" and got["endLtst"] == "14:45"
    deleted = c.delete(f"/api/schedule/{item['id']}").json()
    assert all(i["id"] != item["id"] for i in deleted["items"])
    assert_error(c.delete(f"/api/schedule/{item['id']}"), 404)
    assert_error(c.put(f"/api/schedule/{item['id']}", json=changed), 404)


def test_schedule_put_with_mismatched_id_is_404(c):
    item = schedule_item(c)
    c.post("/api/schedule", json=item)
    try:
        assert_error(c.put(f"/api/schedule/{item['id']}", json={**item, "id": "OTHER-1"}), 404)
    finally:
        c.delete(f"/api/schedule/{item['id']}")


def test_schedule_consumables_scale_with_crew_and_hours(c):
    crew = crew_ids(c)
    one = schedule_item(c, sol=901, durationH=2.0, crew=crew[:1])
    two = schedule_item(c, sol=903, durationH=4.0, crew=crew[:2])
    try:
        items = {i["id"]: i for i in c.post("/api/schedule", json=one).json()["items"]}
        items = {i["id"]: i for i in c.post("/api/schedule", json=two).json()["items"]}
        a, b = items[one["id"]], items[two["id"]]
        factor = 2 * len(two["crew"]) / len(one["crew"])
        assert b["o2L"] == pytest.approx(a["o2L"] * factor, abs=2)
        assert b["batteryWh"] == pytest.approx(a["batteryWh"] * factor, abs=2)
    finally:
        c.delete(f"/api/schedule/{one['id']}")
        c.delete(f"/api/schedule/{two['id']}")


def test_schedule_flags_long_exit_and_night_return(c):
    long_exit = schedule_item(c, sol=950, startLtst="08:00", durationH=9.0)
    late = schedule_item(c, sol=960, startLtst="17:00", durationH=2.0)
    try:
        c.post("/api/schedule", json=long_exit)
        s = c.post("/api/schedule", json=late).json()
        items = {i["id"]: i for i in s["items"]}
        assert any("8 h" in note for note in items[long_exit["id"]]["issues"])
        assert any("zmierzch" in note for note in items[late["id"]]["issues"])
        assert any(long_exit["id"] in issue for issue in s["issues"])
    finally:
        c.delete(f"/api/schedule/{long_exit['id']}")
        c.delete(f"/api/schedule/{late['id']}")


def test_schedule_requires_rest_after_three_consecutive_sols(c):
    who = crew_ids(c)[:1]
    items = [schedule_item(c, sol=970 + k, crew=who) for k in range(4)]
    try:
        for it in items:
            s = c.post("/api/schedule", json=it).json()
        assert any(who[0] in issue and "odpoczynku" in issue for issue in s["issues"])
    finally:
        for it in items:
            c.delete(f"/api/schedule/{it['id']}")


@pytest.mark.parametrize(
    "patch",
    [
        {"startLtst": "24:00"},
        {"startLtst": "9:30"},
        {"durationH": 0},
        {"durationH": 12.5},
        {"sol": -1},
        {"crew": []},
        {"id": "bad id!"},
        {"purpose": "x" * 201},
        {"extra": 1},
    ],
)
def test_schedule_validation(c, patch):
    assert_error(c.post("/api/schedule", json=schedule_item(c, **patch)), 422)


def test_schedule_rejects_unknown_and_duplicate_crew(c):
    assert_error(c.post("/api/schedule", json=schedule_item(c, crew=["nobody-zz"])), 422)
    who = crew_ids(c)[0]
    assert_error(c.post("/api/schedule", json=schedule_item(c, crew=[who, who])), 422)


def test_first_scheduled_exit_on_mission_sol_sets_start_clock_and_crew(c):
    """README: pierwsze wyjście na bieżący sol ustala godzinę startu i załogę EVA; zmiana działa po resecie."""
    sol = c.get("/api/state").json()["sol"]
    who = crew_ids(c)[-1]
    item = schedule_item(c, sol=sol, startLtst="07:45", durationH=1.0, crew=[who])
    c.post("/api/schedule", json=item)
    try:
        assert c.get("/api/state").json()["clock"] != "07:45", "zmiana działa dopiero po resecie"
        c.post("/api/eva/reset")
        s = c.get("/api/state").json()
        assert s["clock"] == "07:45"
        assert [m["id"] for m in s["crew"]] == [who]
    finally:
        c.delete(f"/api/schedule/{item['id']}")
        c.post("/api/eva/reset")
    assert c.get("/api/state").json()["clock"] != "07:45"


# ================================================================ raport
def test_report_without_route_is_not_ok(c):
    r = c.get("/api/report")
    assert r.json()["ok"] is False


def test_report_risk_matrix_consistent(c):
    c.post("/api/plan")
    rep = c.get("/api/report").json()
    assert rep["ok"] is True and rep["routeLetter"] == "A"
    hazards = rep["hazards"]
    assert sorted(h["id"] for h in hazards) == [f"H{i}" for i in range(1, 10)]
    for h in hazards:
        assert 1 <= h["likelihood"] <= 5 and 1 <= h["severity"] <= 5
        assert h["risk"] == h["likelihood"] * h["severity"]
        expected = "wysokie" if h["risk"] >= 15 else "średnie" if h["risk"] >= 8 else "niskie"
        assert h["level"] == expected
    risks = [h["risk"] for h in hazards]
    assert risks == sorted(risks, reverse=True)
    matrix = rep["riskMatrix"]
    assert len(matrix) == 5 and all(len(row) == 5 for row in matrix)
    assert sum(map(sum, matrix)) == len(hazards)
    for h in hazards:  # wiersz 0 = prawdopodobieństwo 5, kolumna 0 = skutek 1
        assert matrix[5 - h["likelihood"]][h["severity"] - 1] >= 1


def test_report_effectiveness_and_uncertainty(c):
    route = c.post("/api/plan").json()
    rep = c.get("/api/report").json()
    eff = rep["effectiveness"]
    assert 0 < eff["probabilityComplete"] <= 1
    assert 0 < eff["routeEfficiency"] <= 1.0
    assert eff["durationH"] == pytest.approx(route["durationH"], abs=0.01)
    assert eff["waypointsPlanned"] == len(mission(c)["waypoints"])
    u = rep["uncertainty"]
    assert u["o2L"]["low"] <= u["o2L"]["mid"] <= u["o2L"]["high"]
    assumptions = {a["id"]: a["value"] for a in rep["assumptions"]}
    assert assumptions["maxSlope"] == mission(c)["eva"]["maxSlopeDeg"]
    assert assumptions["gravity"] == pytest.approx(0.38, abs=0.01)
    assert rep["dataBasis"] and rep["provenance"]["outputsHashed"] > 0


def test_report_summary_uses_polish_decimal_comma(c):
    c.post("/api/plan")
    summary = c.get("/api/report").json()["summary"]
    assert len(summary) == 4
    assert not any(re.search(r"\d\.\d", line) for line in summary)
    assert re.search(r"\d,\d\d km", summary[0])


# ================================================================ strumień
def test_stream_emits_state_events():
    """SSE: pierwsze zdarzenie to pełny stan w formacie data: {...}."""
    import json
    import tempfile
    from pathlib import Path

    import anyio

    from backend import server

    app = server.create_app(start_loop=False, live_feeds=False, db_dir=Path(tempfile.mkdtemp()), mission=FIRST)
    route = next(r for r in app.routes if getattr(r, "path", "") == "/api/stream")

    async def first_event():
        response = await route.endpoint()
        async for chunk in response.body_iterator:
            return chunk

    chunk = anyio.run(first_event)
    assert chunk.startswith("data: ") and chunk.endswith("\n\n")
    state = json.loads(chunk[len("data: ") :])
    assert state["missionId"] == FIRST and "crew" in state and state["phase"] == "idle"


@pytest.mark.parametrize(
    "path,raw",
    [
        ("/api/telemetry", '{"id":"__CREW__","o2L":NaN}'),
        ("/api/telemetry", '{"id":"__CREW__","x":NaN,"y":1}'),
        ("/api/observations", '{"kind":"glazy","x":Infinity,"y":1}'),
        ("/api/eva/timescale", '{"timeScale":NaN}'),
        ("/api/plan", '{"start":{"x":NaN,"y":1}}'),
        ("/api/plan", '{"waypoints":[{"id":"W","x":100,"y":100,"stopMin":Infinity}]}'),
        ("/api/schedule", '{"id":"Z1","sol":5,"startLtst":"10:00","durationH":NaN,"crew":["__CREW__"]}'),
        ("/api/plan", "[]"),
    ],
)
def test_non_finite_and_wrong_shape_bodies_are_422(c, path, raw):
    """JSON z NaN/Infinity (dopuszczalne w Pythonie) albo zły kształt treści: 422, nigdy 500 ani zapis."""
    raw = raw.replace("__CREW__", crew_ids(c)[0])
    r = c.post(path, content=raw.encode(), headers={"Content-Type": "application/json"})
    assert_error(r, 422)
    assert c.get("/api/state").json()["t"] == 0


# ================================================================ restart serwera (ta sama baza)
def test_restart_keeps_schedule_log_and_paused_eva(tmp_path):
    """README: baza SQLite przechowuje dziennik, zgłoszenia, harmonogram i punkt kontrolny; po restarcie EVA jest wstrzymana."""
    first = create_app(start_loop=False, live_feeds=False, db_dir=tmp_path, mission=FIRST)
    with TestClient(first) as a:
        item = schedule_item(a, sol=990)
        assert a.post("/api/schedule", json=item).status_code == 200
        a.post("/api/observations", json={"kind": "piasek", "x": 900, "y": 300, "radiusM": 10})
        a.post("/api/eva/start", json={"timeScale": 300})
        first.state.active().step(1.0)
        a.post("/api/eva/pause")
        before = a.get("/api/state").json()
        head = a.get("/api/log/verify").json()["head"]
    first.state.active().store.close()

    second = create_app(start_loop=False, live_feeds=False, db_dir=tmp_path, mission=FIRST)
    with TestClient(second) as b:
        after = b.get("/api/state").json()
        assert after["resumed"] is True and after["paused"] is True and after["running"] is False
        for key in ("session", "t", "crewS", "routeVersion", "timeScale"):
            assert after[key] == before[key], key
        assert any(i["id"] == item["id"] for i in b.get("/api/schedule").json()["items"])
        assert b.get("/api/observations").json()["obstacles"][0]["kind"] == "piasek"
        v = b.get("/api/log/verify").json()
        assert v["ok"] is True and v["head"] != head, "wznowienie dopisuje wpis do łańcucha"
        assert b.post("/api/eva/start").json()["running"] is True


def test_telemetry_for_known_crew_not_on_this_eva_is_not_called_unknown(c):
    sol = c.get("/api/state").json()["sol"]
    ids = crew_ids(c)
    item = schedule_item(c, sol=sol, startLtst="07:00", durationH=1.0, crew=[ids[-1]])
    c.post("/api/schedule", json=item)
    try:
        c.post("/api/eva/reset")
        assert [m["id"] for m in c.get("/api/state").json()["crew"]] == [ids[-1]]
        r = c.post("/api/telemetry", json={"id": ids[0], "o2L": 100})
        assert r.status_code in (404, 409, 422)
        assert "Nieznany" not in r.json()["error"], r.json()["error"]
    finally:
        c.delete(f"/api/schedule/{item['id']}")
        c.post("/api/eva/reset")
