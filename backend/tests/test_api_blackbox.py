"""API jako czarna skrzynka: kontrakt, walidacja, błędy, przełączanie misji, trwałość, dane misji."""

import json

import numpy as np
import pytest
from conftest import MISSION_IDS, REPO
from fastapi.testclient import TestClient

GETS = [
    "/api/health",
    "/api/missions",
    "/api/route",
    "/api/state",
    "/api/observations",
    "/api/observations/history",
    "/api/log",
    "/api/spaceweather",
    "/api/link",
    "/api/schedule",
    "/api/report",
    "/api/provenance",
]


@pytest.mark.parametrize("path", GETS)
def test_every_get_endpoint_answers_json(client, path):
    r = client.get(path)
    assert r.status_code == 200, r.text[:300]
    assert r.headers["content-type"].startswith("application/json")
    json.dumps(r.json())


def test_report_works_with_and_without_route(client):
    assert client.get("/api/report").status_code == 200
    client.post("/api/plan")
    r = client.get("/api/report")
    assert r.status_code == 200 and r.json()


def test_ui_files_are_served(client):
    assert "MarSim" in client.get("/").text
    assert client.get("/styles.css").status_code == 200
    assert client.get("/src/main.js").status_code == 200
    assert client.get("/missions/current/mission.json").json()["mission"]["id"] == "mount-sharp"


@pytest.mark.parametrize(
    "path",
    [
        "/missions/current/..%2F..%2F..%2Fbackend%2Fserver.py",
        "/missions/current/%2e%2e%2fmission.json",
        "/missions/nope/mission.json",
        "/missions/current/brak.bin",
        "/src/../backend/server.py",
        "/backend/server.py",
        "/.git/config",
        "/README.md",
    ],
)
def test_no_file_outside_ui_and_mission_dirs(client, path):
    r = client.get(path)
    assert r.status_code == 404, f"{path} → {r.status_code}"


def error_ok(r, status):
    assert r.status_code == status, f"{r.status_code}: {r.text[:300]}"
    body = r.json()
    assert body["ok"] is False and isinstance(body["error"], str) and body["error"]


BAD_REQUESTS = [
    ("/api/plan", {"start": {"x": -5, "y": 10}}),
    ("/api/plan", {"start": {"x": 10, "y": 99999}}),
    ("/api/plan", {"waypoints": []}),
    ("/api/plan", {"waypoints": [{"id": "A", "x": 5000, "y": 10}]}),
    ("/api/plan", {"letter": "ab"}),
    ("/api/plan", {"nieznane": 1}),
    ("/api/eva/start", {"timeScale": 0}),
    ("/api/eva/start", {"timeScale": 1e9}),
    ("/api/eva/timescale", {}),
    ("/api/eva/timescale", {"timeScale": "szybko"}),
    ("/api/eva/inject", {"kind": "wybuch"}),
    ("/api/telemetry", {"id": "EV1"}),
    ("/api/telemetry", {"id": "EV1", "x": 100}),
    ("/api/telemetry", {"id": "EV1", "x": 1e6, "y": 5}),
    ("/api/telemetry", {"id": "EV1", "o2L": -1}),
    ("/api/telemetry", {"id": "EV1", "hr": 400}),
    ("/api/observations", {"kind": "glazy", "x": 100}),
    ("/api/observations", {"kind": "ufo", "x": 100, "y": 100}),
    ("/api/observations", {"kind": "glazy", "x": 100, "y": 100, "radiusM": 0}),
    ("/api/observations", {"kind": "glazy", "x": -1, "y": 100}),
    ("/api/observations", {"kind": "glazy", "x": 100, "y": 100, "source": "kosmita"}),
    ("/api/link/send", {"text": ""}),
    ("/api/link/send", {"text": "x" * 501}),
    ("/api/schedule", {"id": "E 9", "sol": 1, "startLtst": "10:00", "durationH": 2, "crew": ["EV1"]}),
    ("/api/schedule", {"id": "E9", "sol": 1, "startLtst": "25:00", "durationH": 2, "crew": ["EV1"]}),
    ("/api/schedule", {"id": "E9", "sol": 1, "startLtst": "10:00", "durationH": 0, "crew": ["EV1"]}),
    ("/api/schedule", {"id": "E9", "sol": 1, "startLtst": "10:00", "durationH": 2, "crew": []}),
    ("/api/schedule", {"id": "E9", "sol": 1, "startLtst": "10:00", "durationH": 2, "crew": ["EV9"]}),
    ("/api/missions/select", {"id": "../etc"}),
]


@pytest.mark.parametrize("path,body", BAD_REQUESTS)
def test_bad_input_gives_422_never_500(client, path, body):
    error_ok(client.post(path, json=body), 422)


@pytest.mark.parametrize("path", ["/api/plan", "/api/observations", "/api/telemetry", "/api/schedule"])
@pytest.mark.parametrize(
    "raw", ["{", "[]", "null", '"tekst"', '{"x": NaN, "y": NaN, "kind": "glazy", "id": "EV1"}', '{"kind":"glazy","x":Infinity,"y":1}']
)
def test_garbage_body_never_500(client, path, raw):
    r = client.post(path, content=raw, headers={"Content-Type": "application/json"})
    assert r.status_code in (200, 409, 422), f"{path} {raw!r} → {r.status_code} {r.text[:200]}"
    if path == "/api/plan" and raw == "null":
        return
    assert r.status_code != 200, f"{path} przyjął {raw!r}"


def test_schedule_rejects_same_person_twice(client):
    r = client.post("/api/schedule", json={"id": "E9", "sol": 200, "startLtst": "10:00", "durationH": 2, "crew": ["EV1", "EV1"]})
    error_ok(r, 422)


def test_unknown_resources_give_404(client):
    error_ok(client.get("/api/nie-ma"), 404)
    error_ok(client.post("/api/telemetry", json={"id": "EV7", "o2L": 100}), 404)
    error_ok(client.delete("/api/schedule/NIE-MA"), 404)
    error_ok(client.post("/api/missions/select", json={"id": "olympus"}), 404)
    item = {"id": "NIE-MA", "sol": 1, "startLtst": "10:00", "durationH": 2, "crew": ["EV1"]}
    error_ok(client.put("/api/schedule/NIE-MA", json=item), 404)


def test_plan_start_state_flow(client):
    plan = client.post("/api/plan").json()
    assert plan["ok"] and plan["letter"] == "A" and plan["version"] == 1
    assert client.get("/api/route").json()["route"]["lengthM"] == plan["lengthM"]
    started = client.post("/api/eva/start", json={"timeScale": 600}).json()
    assert (started["ok"], started["running"], started["timeScale"]) == (True, True, 600)
    eng = client.app.state.active()
    for _ in range(100):
        eng.step(0.1)
    s = client.get("/api/state").json()
    assert s["running"] and s["t"] == pytest.approx(6000) and s["crewS"] > 0
    assert client.post("/api/eva/pause").json()["running"] is False
    assert client.post("/api/eva/timescale", json={"timeScale": 5}).json()["timeScale"] == 5
    assert client.post("/api/eva/reset").json() == {"ok": True, "running": False, "timeScale": 60.0, "phase": "idle"}
    after = client.get("/api/route").json()
    assert {k: after[k] for k in ("version", "route", "discarded")} == {"version": 0, "route": None, "discarded": []}
    assert [w["id"] for w in after["waypoints"]] == ["WP1", "WP2"]  # po resecie: punkty z konfiguracji misji


def test_return_to_habitat_ends_eva(client):
    error_ok(client.post("/api/eva/return"), 409)  # bez trasy nie ma skąd wracać
    client.post("/api/eva/start", json={"timeScale": 2000})
    eng = client.app.state.active()
    for _ in range(20):
        eng.step(0.1)
    back = client.post("/api/eva/return").json()
    assert back["ok"] and back["letter"] == "B"
    for _ in range(3000):
        if not eng.running:
            break
        eng.step(0.1)
    s = client.get("/api/state").json()
    assert s["finished"] and s["phase"] == "done" and s["reached"][-1] == "HAB"
    error_ok(client.post("/api/eva/start"), 409)
    assert client.post("/api/eva/reset").json()["phase"] == "idle"


def test_start_without_plan_plans_default_route(client):
    assert client.post("/api/eva/start").json()["running"] is True
    assert client.get("/api/route").json()["route"]["letter"] == "A"


def test_custom_plan_and_forbidden_target(client):
    eng = client.app.state.active()
    r = client.post(
        "/api/plan", json={"start": {"x": 301.5, "y": 760.5}, "waypoints": [{"id": "P1", "x": 400.5, "y": 700.5}], "letter": "C"}
    )
    assert r.status_code == 200 and r.json()["letter"] == "C"
    rows, cols = np.nonzero(eng.layers["hazard"] == 2)
    k = len(rows) // 2
    bad = {"id": "ZLE", "x": float((cols[k] + 0.5) * eng.cell), "y": float((rows[k] + 0.5) * eng.cell)}
    r = client.post("/api/plan", json={"waypoints": [bad]})
    error_ok(r, 409)
    assert client.get("/api/route").json()["route"]["letter"] == "C"  # stara trasa zostaje


def test_inject_requires_route(client):
    error_ok(client.post("/api/eva/inject", json={"kind": "boulders"}), 409)
    client.post("/api/plan")
    r = client.post("/api/eva/inject", json={"kind": "boulders"})
    assert r.status_code == 200 and r.json()["observation"]["kind"] == "glazy"
    assert client.post("/api/eva/inject", json={"kind": "link-outage"}).json() == {"ok": True}
    assert client.get("/api/link").json()["up"] is False


def test_telemetry_overrides_model_then_expires(client):
    client.post("/api/eva/start", json={"timeScale": 10})
    eng = client.app.state.active()
    assert client.post("/api/telemetry", json={"id": "EV2", "o2L": 321.0, "hr": 111, "x": 500.0, "y": 400.0}).json() == {"ok": True}
    eng.step(0.1)
    ev2 = next(c for c in client.get("/api/state").json()["crew"] if c["id"] == "EV2")
    assert ev2["source"] == "skafander" and ev2["o2L"] == 321.0 and ev2["hr"] == 111 and (ev2["x"], ev2["y"]) == (500.0, 400.0)
    for _ in range(100):  # 100 s misji bez nowych pomiarów
        eng.step(0.1)
    ev2 = next(c for c in client.get("/api/state").json()["crew"] if c["id"] == "EV2")
    assert ev2["source"] == "model" and ev2["o2L"] < 321.0 and (ev2["x"], ev2["y"]) != (500.0, 400.0)


def test_telemetry_o2_is_capped_at_capacity(client):
    client.post("/api/telemetry", json={"id": "EV1", "o2L": 4000})
    ev1 = client.get("/api/state").json()["crew"][0]
    assert ev1["o2Pct"] <= 100


def test_observation_flow_and_history(client):
    client.post("/api/plan")
    eng = client.app.state.active()
    mid = eng.poly.at(eng.poly.length / 2)
    r = client.post("/api/observations", json={"kind": "piasek", "x": mid["x"], "y": mid["y"], "radiusM": 25, "source": "łazik"}).json()
    assert r["replanned"] is True and r["route"]["letter"] == "B"
    assert client.get("/api/observations").json()["obstacles"][0]["kind"] == "piasek"
    assert len(client.get("/api/route").json()["discarded"]) == 1
    client.post("/api/eva/reset")
    assert client.get("/api/observations").json() == {"observations": [], "obstacles": []}
    assert len(client.get("/api/observations/history").json()["observations"]) == 1  # audyt zostaje


def test_link_send_and_delivery(client):
    r = client.post("/api/link/send", json={"text": "Habitat do Ziemi"}).json()
    status = client.get("/api/link").json()
    assert r["deliverInMin"] == pytest.approx(status["oneWayMin"], abs=0.11)
    assert status["pendingOut"] == 1 and status["pendingIn"] == 1


def test_schedule_crud_and_log(client):
    base = client.get("/api/schedule").json()
    n = len(base["items"])
    new = {"id": "EVA-9", "sol": 300, "startLtst": "10:00", "durationH": 2.0, "crew": ["EV1"], "purpose": "test"}
    assert len(client.post("/api/schedule", json=new).json()["items"]) == n + 1
    error_ok(client.post("/api/schedule", json=new), 409)
    changed = client.put("/api/schedule/EVA-9", json={**new, "durationH": 9.0}).json()
    assert any("EVA-9" in i for i in changed["issues"])
    error_ok(client.put("/api/schedule/EVA-9", json={**new, "id": "EVA-1"}), 404)
    error_ok(client.put("/api/schedule/EVA-9", json={**new, "crew": ["EV9"]}), 422)
    assert len(client.delete("/api/schedule/EVA-9").json()["items"]) == n
    texts = [e["text"] for e in client.get("/api/log").json()["events"] if e["kind"] == "harmonogram"]
    assert len(texts) == 3, f"dodanie, zmiana i usunięcie powinny być w dzienniku audytu, jest: {texts}"


def test_log_endpoint(client):
    client.post("/api/plan")
    log = client.get("/api/log", params={"limit": 2}).json()
    assert len(log["events"]) == 2 and log["events"][0]["kind"] == "trasa"
    error_ok(client.get("/api/log", params={"limit": 0}), 422)
    error_ok(client.get("/api/log", params={"session": 0}), 422)


def test_mission_switch_isolates_state(client):
    client.post("/api/eva/start")
    assert client.post("/api/missions/select", json={"id": "jezero"}).json() == {"ok": True, "active": "jezero"}
    s = client.get("/api/state").json()
    assert s["missionId"] == "jezero" and s["running"] is False and s["routeVersion"] == 0
    assert client.get("/missions/current/mission.json").json()["mission"]["id"] == "jezero"
    assert client.get("/missions/mount-sharp/mission.json").json()["mission"]["id"] == "mount-sharp"
    assert client.get("/api/health").json()["mission"] == "jezero"
    error_ok(client.post("/api/plan", headers={"X-MarSim-Mission": "mount-sharp"}), 409)
    assert client.post("/api/plan", headers={"X-MarSim-Mission": "jezero"}).status_code == 200
    client.post("/api/missions/select", json={"id": "mount-sharp"})
    back = client.get("/api/state").json()
    assert back["missionId"] == "mount-sharp" and back["running"] is False and back["routeVersion"] == 1


def test_state_survives_restart_where_promised(tmp_path):
    from backend.server import create_app

    new = {"id": "EVA-9", "sol": 300, "startLtst": "10:00", "durationH": 2.0, "crew": ["EV1"], "purpose": "test"}
    with TestClient(create_app(start_loop=False, live_feeds=False, db_dir=tmp_path)) as c:
        first = c.get("/api/health").json()["session"]
        c.post("/api/schedule", json=new)
        c.post("/api/observations", json={"kind": "glazy", "x": 100, "y": 100})
    with TestClient(create_app(start_loop=False, live_feeds=False, db_dir=tmp_path)) as c:
        assert c.get("/api/health").json()["session"] == first + 1
        assert "EVA-9" in [i["id"] for i in c.get("/api/schedule").json()["items"]]
        assert len(c.get("/api/observations/history").json()["observations"]) == 1
        assert c.get("/api/observations").json()["observations"] == []
    assert sorted(p.name for p in tmp_path.glob("*.db")) == ["marsim-mount-sharp.db"]


def test_versions_agree(client):
    health = client.get("/api/health").json()
    assert client.get("/api/openapi.json").json()["info"]["version"] == health["version"]


# ---------------- dane misji w repozytorium ----------------
@pytest.mark.parametrize("mission_id", MISSION_IDS)
def test_mission_files_are_consistent(mission_id):
    from PIL import Image

    d = REPO / "data" / "missions" / mission_id
    m = json.loads((d / "mission.json").read_text(encoding="utf-8"))
    w, h, cell = m["dem"]["width"], m["dem"]["height"], m["dem"]["cellM"]
    assert (w * cell, h * cell) == (m["area"]["widthM"], m["area"]["heightM"])
    for name in ("dem.f32", "slope.f32", "slopeSigma.f32", "o2ToHabitat.f32", "timeToHabitat.f32"):
        a = np.fromfile(d / name, dtype="<f4")
        assert a.size == w * h, name
        assert np.isfinite(a).all(), f"{name}: wartości nieskończone/NaN"
    slope = np.fromfile(d / "slope.f32", dtype="<f4")
    assert slope.min() >= 0 and slope.max() < 90
    hazard = np.array(Image.open(d / "hazards.png"))
    assert hazard.shape == (h, w) and set(np.unique(hazard)) <= {0, 1, 2}
    for layer in m["layers"]:
        f = layer.get("raster", {}).get("file")
        if f:
            assert (d / f).exists(), f
    for name, p in [("habitat", m["habitat"]), ("rover", m["rover"])] + [(wp["id"], wp) for wp in m["waypoints"]]:
        assert 0 <= p["x"] <= m["area"]["widthM"] and 0 <= p["y"] <= m["area"]["heightM"], name
        assert hazard[int(p["y"] // cell), int(p["x"] // cell)] != 2, f"{name} leży w strefie zakazanej"


@pytest.mark.parametrize("mission_id", MISSION_IDS)
def test_hazard_map_follows_documented_slope_rule(mission_id):
    """Każda komórka, gdzie nachylenie + 2σ przekracza limit, musi być zakazana."""
    from conftest import make_engine

    eng = make_engine(mission_id)
    steep = (eng.layers["slope"] + 2 * eng.layers["slopeSigma"]) > eng.cfg["eva"]["maxSlopeDeg"]
    missed = steep & (eng.layers["hazard"] != 2)
    assert missed.mean() < 0.001, f"{missed.sum()} komórek za stromych, a nie zakazanych"


@pytest.mark.parametrize("mission_id", MISSION_IDS)
def test_static_demo_samples_match_live_backend(mission_id, tmp_path):
    """Wersja bez serwera (GitHub Pages) pokazuje zapisane odpowiedzi backendu — nie mogą odbiegać od żywego."""
    from backend.server import create_app

    sample = REPO / "data" / "missions" / mission_id / "backend"
    with TestClient(create_app(start_loop=False, live_feeds=False, db_dir=tmp_path, mission=mission_id)) as c:
        live = c.post("/api/plan").json()
    saved = json.loads((sample / "plan.json").read_text(encoding="utf-8"))
    saved = saved.get("response", saved)
    assert saved["lengthM"] == pytest.approx(live["lengthM"], rel=0.01)
    assert saved["o2L"] == pytest.approx(live["o2L"], rel=0.01)
