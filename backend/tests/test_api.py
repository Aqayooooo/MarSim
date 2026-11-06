"""Testy API: walidacja zapytań, zapis w SQLite po restarcie, ochrona plików.   python -m pytest backend/tests -q"""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.live.store import Store  # noqa: E402
from backend.server import create_app  # noqa: E402


def client(db) -> TestClient:
    return TestClient(create_app(store=Store(db), start_loop=False, live_feeds=False))


@pytest.fixture()
def api(tmp_path):
    return client(tmp_path / "marsim.db")


def test_health(api):
    r = api.get("/api/health")
    assert r.status_code == 200 and r.json()["ok"] is True


@pytest.mark.parametrize("path,body,needle", [
    ("/api/eva/inject", {}, "kind"),
    ("/api/eva/inject", {"kind": "meteor"}, "kind"),
    ("/api/eva/timescale", {"timeScale": -5}, "timeScale"),
    ("/api/observations", {"kind": "glazy", "x": 99999, "y": 10}, "poza obszarem"),
    ("/api/observations", {"kind": "lawa", "x": 10, "y": 10}, "kind"),
    ("/api/schedule", {"id": "EVA-9", "sol": 150, "startLtst": "25:00", "durationH": 2, "crew": ["EV1"]}, "startLtst"),
    ("/api/schedule", {"id": "EVA-9", "sol": 150, "startLtst": "10:00", "durationH": 2, "crew": ["EV7"]}, "EV7"),
    ("/api/telemetry", {"id": "EV1", "batteryPct": 140}, "batteryPct"),
    ("/api/plan", {"letter": "AB"}, "letter"),
])
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
    item = {"id": "EVA-9", "sol": 160, "startLtst": "10:00", "durationH": 2.5, "crew": ["EV1"], "purpose": "test"}
    assert a.post("/api/schedule", json=item).status_code == 200
    assert a.post("/api/observations", json={"kind": "piasek", "x": 500, "y": 400, "radiusM": 30}).status_code == 200
    a.app.state.engine.store.close()

    b = client(db)   # „restart serwera”: nowy silnik na tym samym pliku bazy
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


@pytest.mark.parametrize("path", ["/.git/config", "/backend/config/mission.json", "/backend/server.py", "/data/marsim.db",
                                  "/missions/current/..%2F..%2F..%2Fbackend%2Fserver.py"])
def test_project_files_not_served(api, path):
    assert api.get(path).status_code == 404


@pytest.mark.parametrize("path", ["/", "/styles.css", "/src/main.js", "/src/i18n.js", "/vendor/three/three.module.js",
                                  "/vendor/fonts/fonts.css", "/missions/current/mission.json"])
def test_ui_files_served(api, path):
    assert api.get(path).status_code == 200
