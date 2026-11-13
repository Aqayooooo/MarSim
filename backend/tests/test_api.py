"""Testy API: walidacja zapytań, zapis w SQLite po restarcie, ochrona plików.   python -m pytest backend/tests -q"""

import sys
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.live.store import Store
from backend.server import create_app


def client(db) -> TestClient:
    return TestClient(create_app(store=Store(db), db_dir=Path(db).parent, start_loop=False, live_feeds=False))


@pytest.fixture()
def api(tmp_path):
    return client(tmp_path / "marsim.db")


def test_health(api):
    r = api.get("/api/health")
    assert r.status_code == 200 and r.json()["ok"] is True


@pytest.mark.parametrize(
    "path,body,needle",
    [
        ("/api/eva/inject", {}, "kind"),
        ("/api/eva/inject", {"kind": "meteor"}, "kind"),
        ("/api/eva/timescale", {"timeScale": -5}, "timeScale"),
        ("/api/observations", {"kind": "glazy", "x": 99999, "y": 10}, "poza obszarem"),
        ("/api/observations", {"kind": "lawa", "x": 10, "y": 10}, "kind"),
        ("/api/schedule", {"id": "EVA-9", "sol": 150, "startLtst": "25:00", "durationH": 2, "crew": ["Bartek"]}, "startLtst"),
        ("/api/schedule", {"id": "EVA-9", "sol": 150, "startLtst": "10:00", "durationH": 2, "crew": ["EV7"]}, "EV7"),
        ("/api/telemetry", {"id": "Bartek", "batteryPct": 140}, "batteryPct"),
        ("/api/plan", {"letter": "AB"}, "letter"),
    ],
)
def test_bad_input_gives_422_with_message(api, path, body, needle):
    r = api.post(path, json=body)
    assert r.status_code == 422, r.text
    j = r.json()
    assert j["ok"] is False and needle in j["error"]


def test_malformed_json_is_not_500(api):
    r = api.post("/api/observations", content=b"{nie-json", headers={"Content-Type": "application/json"})
    assert r.status_code == 422 and r.json()["ok"] is False


def test_unknown_crew_telemetry_404(api):
    r = api.post("/api/telemetry", json={"id": "EV9", "o2L": 100})
    assert r.status_code == 404 and "EV9" in r.json()["error"]


def test_plan_report_and_obstacle(api):
    r = api.post("/api/plan", json={})
    assert r.status_code == 200 and len(r.json()["path"]) > 2
    rep = api.get("/api/report").json()
    assert rep["ok"] and len(rep["hazards"]) == 9
    p = r.json()["path"][len(r.json()["path"]) // 2]
    o = api.post("/api/observations", json={"kind": "glazy", "x": p["x"], "y": p["y"], "radiusM": 15, "source": "dron"})
    assert o.status_code == 200 and o.json()["observation"]["kind"] == "glazy"


def test_state_survives_restart(tmp_path):
    db = tmp_path / "marsim.db"
    a = client(db)
    item = {"id": "EVA-9", "sol": 160, "startLtst": "10:00", "durationH": 2.5, "crew": ["Bartek"], "purpose": "test"}
    assert a.post("/api/schedule", json=item).status_code == 200
    assert a.post("/api/observations", json={"kind": "piasek", "x": 500, "y": 400, "radiusM": 30}).status_code == 200
    a.app.state.active().store.close()

    b = client(db)  # „restart serwera”: nowy silnik na tym samym pliku bazy
    ids = [i["id"] for i in b.get("/api/schedule").json()["items"]]
    assert "EVA-9" in ids
    hist = b.get("/api/observations/history").json()["observations"]
    assert any(o["kind"] == "piasek" for o in hist)
    events = b.get("/api/log?limit=50").json()
    assert events["session"] >= 2
    assert any(e["kind"] == "zgłoszenie" for e in events["events"])
    assert any(e["kind"] == "harmonogram" for e in events["events"])


def test_delete_missing_schedule_item_404(api):
    r = api.delete("/api/schedule/NIE-MA")
    assert r.status_code == 404 and r.json()["ok"] is False


@pytest.mark.parametrize(
    "path",
    [
        "/.git/config",
        "/backend/config/missions/mount-sharp.json",
        "/backend/server.py",
        "/data/marsim.db",
        "/missions/current/..%2F..%2F..%2Fbackend%2Fserver.py",
    ],
)
def test_project_files_not_served(api, path):
    assert api.get(path).status_code == 404


@pytest.mark.parametrize(
    "path",
    [
        "/",
        "/styles.css",
        "/src/main.js",
        "/src/i18n.js",
        "/vendor/three/three.module.js",
        "/vendor/fonts/fonts.css",
        "/missions/current/mission.json",
    ],
)
def test_ui_files_served(api, path):
    assert api.get(path).status_code == 200


def test_missions_list_and_switch(api):
    r = api.get("/api/missions").json()
    ids = [m["id"] for m in r["missions"]]
    assert r["active"] == "mount-sharp" and {"mount-sharp", "jezero"} <= set(ids)
    assert api.post("/api/missions/select", json={"id": "jezero"}).json()["active"] == "jezero"
    assert api.get("/api/health").json()["mission"] == "jezero"
    m = api.get("/missions/current/mission.json").json()
    assert m["mission"]["id"] == "jezero" and m["area"]["center"]["lat"] > 18
    plan = api.post("/api/plan", json={})
    assert plan.status_code == 200 and plan.json()["lengthM"] > 500
    assert api.get("/api/report").json()["ok"]
    # osobna baza na misję: harmonogram Jezero nie miesza się z Mount Sharp
    api.post("/api/schedule", json={"id": "JZ-1", "sol": 213, "startLtst": "10:00", "durationH": 2, "crew": ["Bartek"]})
    api.post("/api/missions/select", json={"id": "mount-sharp"})
    assert "JZ-1" not in [i["id"] for i in api.get("/api/schedule").json()["items"]]


@pytest.mark.parametrize("body,code", [({"id": "olympus"}, 404), ({"id": "../x"}, 422), ({}, 422)])
def test_mission_select_rejects_bad_ids(api, body, code):
    assert api.post("/api/missions/select", json=body).status_code == code


@pytest.mark.parametrize("mission", ["mount-sharp", "jezero"])
def test_route_never_enters_forbidden_and_explains_alternatives(api, mission):
    api.post("/api/missions/select", json={"id": mission})
    r = api.post("/api/plan", json={}).json()
    alts = {a["id"]: a for a in r["alternatives"]}
    assert set(alts) == {"chosen", "straight", "shortest", "strict"}
    assert alts["chosen"]["forbiddenM"] == 0  # wygładzanie trasy nie może ścinać przez zakaz
    assert alts["chosen"]["maxSlopeUpDeg"] <= 25
    for a in alts.values():
        if a["verdict"] in ("worse", "same"):
            assert a["forbiddenM"] == 0 and a["o2L"] >= alts["chosen"]["o2L"] - 0.5  # wybrana = najmniej O₂ wśród bezpiecznych
        assert a["reasons"], a["id"]
    assert alts["straight"]["verdict"] == "unsafe" and alts["straight"]["forbiddenM"] > 0


def test_ui_files_revalidated(api):
    assert api.get("/src/main.js").headers["cache-control"] == "no-cache"


def test_safe_passage_report_does_not_outlive_eva_reset(api):
    E = api.app.state.active()
    before = E.layers["hazard"].copy()
    ys, xs = np.nonzero(before == 1)
    x, y = (xs[len(xs) // 2] + 0.5) * E.cell, (ys[len(ys) // 2] + 0.5) * E.cell
    assert api.post("/api/observations", json={"kind": "bezpieczne", "x": float(x), "y": float(y), "radiusM": 150}).status_code == 200
    assert (E.layers["hazard"] == 1).sum() < (before == 1).sum()  # w tej sesji: strefa „uwaga” zniesiona
    api.post("/api/eva/reset")
    assert np.array_equal(E.layers["hazard"], before)  # nowa sesja: mapa z potoku
    assert E.model.caution.sum() == (before == 1).sum()


def test_eva_follows_waypoints_from_plan_request(api):
    E = api.app.state.active()
    wps = [{"id": w["id"], "x": w["x"], "y": w["y"]} for w in E.cfg["waypoints"]]
    extra = {"id": "WP3", "x": E.cfg["rover"]["x"] + 60, "y": E.cfg["rover"]["y"] + 40}
    assert api.post("/api/plan", json={"waypoints": wps + [extra]}).status_code == 200
    api.post("/api/eva/start", json={"timeScale": 600})
    for _ in range(4000):
        E.step(1.0)  # wcześniej: IndexError na cfg["waypoints"][2]
        if E.next_wp >= len(E.wp_s):
            break
    assert E.reached == [w["id"] for w in wps] + ["WP3"]
    assert api.get("/api/report").json()["effectiveness"]["waypointsPlanned"] == 3


def test_snapshot_identifies_session_and_backend_html(api):
    before = api.get("/api/state").json()["session"]
    api.post("/api/eva/reset")
    assert api.get("/api/state").json()["session"] == before + 1
    response = api.get("/")
    assert response.status_code == 200
    assert '<meta name="marsim-api" content="' in response.text
    assert response.headers["cache-control"] == "no-cache"
