"""Trwałość: łańcuch skrótów dziennika, eksport CSV, punkt kontrolny EVA i wznowienie po restarcie serwera."""

import csv
import io
import json
import sqlite3

import pytest
from conftest import make_engine
from fastapi.testclient import TestClient

from backend.live import checkpoint
from backend.live.store import GENESIS_HASH, Store, event_hash
from backend.server import create_app, parse_args


def run(engine, mission_seconds: float, step: float = 0.1) -> None:
    for _ in range(int(mission_seconds / (step * engine.time_scale))):
        engine.step(step)


def walking_engine(store: Store, mission_seconds: float = 900):
    engine = make_engine("mount-sharp", store)
    assert engine.start(600) is None
    run(engine, mission_seconds)
    return engine


# ---------------- dziennik: łańcuch skrótów ----------------
def test_log_chain_verifies_and_links_every_entry(tmp_path):
    store = Store(tmp_path / "a.db")
    store.new_session()
    for k in range(5):
        store.log("EVA", f"wpis {k}", mission_t=k * 10.0, clock="09:20", meta={"k": k} if k % 2 else None)
    result = store.verify_log()
    assert result == {"ok": True, "checked": 5, "legacy": 0, "brokenAt": None, "head": result["head"]}
    rows = store.events_oldest_first()
    previous = GENESIS_HASH
    for _id, utc, session, mission_t, clock, kind, text, meta, digest in rows:
        assert digest == event_hash(previous, utc, session, mission_t, clock, kind, text, meta)
        previous = digest
    assert previous == result["head"]


@pytest.mark.parametrize("tamper", ["UPDATE events SET text = 'podmienione' WHERE id = 3", "DELETE FROM events WHERE id = 3"])
def test_log_chain_detects_tampering(tmp_path, tamper):
    path = tmp_path / "a.db"
    store = Store(path)
    for k in range(6):
        store.log("EVA", f"wpis {k}")
    store.close()
    db = sqlite3.connect(path)
    db.execute(tamper)
    db.commit()
    db.close()
    result = Store(path).verify_log()
    assert result["ok"] is False
    assert result["brokenAt"] in (3, 4)  # zmieniony wpis albo pierwszy po usuniętym
    assert result["checked"] == 2


def test_log_chain_continues_after_reopen(tmp_path):
    path = tmp_path / "a.db"
    first = Store(path)
    first.log("EVA", "przed restartem")
    first.close()
    second = Store(path)
    second.log("EVA", "po restarcie")
    assert second.verify_log()["checked"] == 2 and second.verify_log()["ok"]


def test_database_without_hash_column_is_migrated(tmp_path):
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.execute(
        "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, utc TEXT NOT NULL, session INTEGER NOT NULL, "
        "mission_t REAL NOT NULL, clock TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, meta TEXT)"
    )
    db.execute("INSERT INTO events(utc, session, mission_t, kind, text) VALUES('2026-01-01T00:00:00Z', 1, 0, 'EVA', 'stary wpis')")
    db.commit()
    db.close()
    store = Store(path)
    store.log("EVA", "nowy wpis")
    assert store.verify_log() == {"ok": True, "checked": 1, "legacy": 1, "brokenAt": None, "head": store.verify_log()["head"]}
    assert [e["text"] for e in store.events()] == ["nowy wpis", "stary wpis"]


def test_log_endpoints_verify_and_export_csv(client):
    client.post("/api/plan", json={})
    client.post("/api/observations", json={"kind": "inne", "x": 100, "y": 100, "radiusM": 5})
    verify = client.get("/api/log/verify").json()
    assert verify["ok"] and verify["checked"] >= 3
    response = client.get("/api/log/export")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "marsim-" in response.headers["content-disposition"] and response.headers["content-disposition"].endswith('-log.csv"')
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert rows[0] == ["id", "utc", "session", "mission_t_s", "clock_ltst", "kind", "text", "meta", "sha256"]
    assert len(rows) - 1 == verify["checked"]
    assert [int(r[0]) for r in rows[1:]] == sorted(int(r[0]) for r in rows[1:])
    assert all(len(r[8]) == 64 for r in rows[1:])
    session = client.get("/api/health").json()["session"]
    only = list(csv.reader(io.StringIO(client.get(f"/api/log/export?session={session}").content.decode("utf-8-sig"))))
    assert {r[2] for r in only[1:]} == {str(session)}


# ---------------- punkt kontrolny EVA ----------------
def test_checkpoint_round_trips_through_json(tmp_path):
    engine = walking_engine(Store(tmp_path / "a.db"))
    state = json.loads(json.dumps(checkpoint.capture(engine), ensure_ascii=False, default=float))
    assert checkpoint.usable(state, "mount-sharp")
    assert not checkpoint.usable(state, "jezero")
    assert not checkpoint.usable({**state, "format": 99}, "mount-sharp")
    assert not checkpoint.usable({**state, "finished": True}, "mount-sharp")
    assert not checkpoint.usable(None, "mount-sharp")


def test_eva_resumes_after_restart_with_same_state(tmp_path):
    path = tmp_path / "a.db"
    before = walking_engine(Store(path))
    before.add_observation({"kind": "bezpieczne", "x": 400, "y": 700, "radiusM": 30, "source": "załoga"})
    before.pause()
    expected = before.snapshot()
    session = before.store.session
    before.store.close()

    after = make_engine("mount-sharp", Store(path))
    got = after.snapshot()
    assert after.resumed and got["resumed"] and not got["running"]
    assert after.store.session == session, "wznowienie nie może zaczynać nowej sesji"
    for key in ("t", "crewS", "nextWp", "reached", "routeVersion", "phase", "finished", "sep", "obstacles", "timeScale"):
        assert got[key] == expected[key], key
    for a, b in zip(got["crew"], expected["crew"]):
        assert a["id"] == b["id"]
        assert a["o2L"] == pytest.approx(b["o2L"], abs=0.5)
        assert a["batteryPct"] == pytest.approx(b["batteryPct"], abs=0.5)
        assert (a["x"], a["y"]) == pytest.approx((b["x"], b["y"]), abs=2.5)  # pozycja z czujników ma szum
    assert after.route["path"] == before.route["path"]
    assert (after.layers["hazard"] == before.layers["hazard"]).all(), "zgłoszenie „bezpieczne” ma wrócić na mapę zagrożeń"
    assert "Wznowiono sesję EVA" in after.log[-1]["text"]

    assert after.start() is None  # wyjście idzie dalej od tego samego miejsca
    run(after, 300)
    assert after.t > expected["t"] and after.crew_s > expected["crewS"]


def test_running_eva_is_checkpointed_without_pause(tmp_path, monkeypatch):
    path = tmp_path / "a.db"
    engine = make_engine("mount-sharp", Store(path))
    engine.start(600)
    engine.step(0.1)  # pierwszy krok zapisuje punkt kontrolny (poprzedniego jeszcze nie było)
    saved = engine.store.checkpoint_load()
    assert saved and saved["t"] == pytest.approx(60, abs=1)
    again = make_engine("mount-sharp", Store(path))
    assert again.resumed and again.t == pytest.approx(saved["t"])


def test_reset_and_finished_eva_leave_nothing_to_resume(tmp_path):
    path = tmp_path / "a.db"
    engine = walking_engine(Store(path))
    engine.pause()
    assert engine.store.checkpoint_load() is not None
    engine.reset()
    assert engine.store.checkpoint_load() is None
    assert not make_engine("mount-sharp", Store(path)).resumed

    engine.start(2000)
    while engine.phase != "atTarget":
        engine.step(0.1)
    assert engine.return_to_habitat()["ok"]
    while engine.running:
        engine.step(0.1)
    assert engine.finished and engine.store.checkpoint_load() is None
    fresh = make_engine("mount-sharp", Store(path))
    assert not fresh.resumed and fresh.phase == "idle"


def test_broken_checkpoint_falls_back_to_new_session(tmp_path):
    path = tmp_path / "a.db"
    engine = walking_engine(Store(path))
    engine.pause()
    state = engine.store.checkpoint_load()
    state["crew"][0]["id"] = "EV9"  # osoby nie ma w konfiguracji misji
    engine.store.checkpoint_save(state)
    recovered = make_engine("mount-sharp", Store(path))
    assert not recovered.resumed and recovered.phase == "idle" and recovered.t == 0

    recovered.store.db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('checkpoint', '{to nie jest JSON')")
    recovered.store.db.commit()
    assert not make_engine("mount-sharp", Store(path)).resumed


def test_server_restart_resumes_eva_over_http(tmp_path):
    def new_client():
        return TestClient(create_app(start_loop=False, live_feeds=False, db_dir=tmp_path, mission="mount-sharp"))

    with new_client() as first:
        assert first.post("/api/eva/start", json={"timeScale": 600}).status_code == 200
        engine = first.app.state.active()
        run(engine, 600)
        first.post("/api/eva/pause")
        before = first.get("/api/state").json()
        engine.store.close()
    with new_client() as second:
        after = second.get("/api/state").json()
        assert after["resumed"] and not after["running"]
        assert (after["t"], after["crewS"], after["phase"]) == (before["t"], before["crewS"], before["phase"])
        assert second.get("/api/route").json()["route"]["letter"] == "A"
        assert second.post("/api/eva/start").json()["running"] is True
        assert second.post("/api/eva/reset").json()["phase"] == "idle"
        assert second.get("/api/state").json()["resumed"] is False


# ---------------- raport, dokumentacja API, wiersz poleceń ----------------
def test_report_lists_assumptions_from_configuration(client):
    client.post("/api/plan", json={})
    report = client.get("/api/report").json()
    engine = client.app.state.active()
    values = {a["id"]: a["value"] for a in report["assumptions"]}
    assert values["maxSlope"] == engine.cfg["eva"]["maxSlopeDeg"]
    assert values["o2Reserve"] == engine.cfg["eva"]["o2ReservePct"]
    assert values["sandForbidden"] == 0.6 and values["sandCaution"] == 0.35 and values["slopeMargin"] == 2
    assert all(set(a) == {"id", "value", "unit"} for a in report["assumptions"])


def test_openapi_describes_every_api_route(client):
    spec = client.get("/api/openapi.json").json()
    assert spec["info"]["title"] == "MarSim API"
    paths = spec["paths"]
    for path in ("/api/plan", "/api/eva/return", "/api/log/verify", "/api/log/export", "/api/schedule/{item_id}"):
        assert path in paths
    assert all(path.startswith("/api/") for path in paths), "pliki interfejsu nie należą do opisu API"
    assert all(operation.get("tags") for methods in paths.values() for operation in methods.values())
    assert client.get("/api/docs").status_code == 200


def test_command_line_options(monkeypatch):
    monkeypatch.delenv("PORT", raising=False)
    monkeypatch.delenv("MARSIM_HOST", raising=False)
    defaults = parse_args([])
    assert (defaults.port, defaults.host, defaults.mission, defaults.db_dir, defaults.no_live_feeds) == (
        8000,
        "127.0.0.1",
        None,
        None,
        False,
    )
    custom = parse_args(["9001", "--host", "0.0.0.0", "--mission", "jezero", "--db-dir", "x/y", "--no-live-feeds", "--log-level", "debug"])
    assert (custom.port, custom.host, custom.mission, custom.no_live_feeds, custom.log_level) == (9001, "0.0.0.0", "jezero", True, "debug")
    assert custom.db_dir.as_posix() == "x/y"
    monkeypatch.setenv("PORT", "8123")
    assert parse_args([]).port == 8123
    with pytest.raises(SystemExit):
        parse_args(["--log-level", "głośno"])


@pytest.mark.parametrize("mission_id", ["mount-sharp", "jezero"])
def test_changes_made_during_pause_survive_restart(tmp_path, mission_id):
    path = tmp_path / "paused.db"
    before = make_engine(mission_id, Store(path))
    assert before.start(600) is None
    run(before, 600)
    before.pause()
    saved_time = before.t
    assert before.return_to_habitat()["ok"]
    pos = before.crew_pos(0)
    before.add_observation({"kind": "bezpieczne", "x": pos["x"], "y": pos["y"], "radiusM": 1, "source": "załoga"})
    before.inject("sep")
    before.apply_telemetry("EV1", {"o2L": 250.0})
    expected_path = before.route["path"]
    before.store.close()  # bez ponownej pauzy i bez kroku symulacji po zmianach

    after = make_engine(mission_id, Store(path))
    assert after.t == saved_time and not after.running and after.resumed
    assert after.phase == "returning" and after.returning
    assert after.route["path"] == expected_path
    assert after.waypoints[-1]["id"] == "HAB"
    assert len(after.observations) == 1 and after.sep
    assert after.crew[0]["person"].o2_l == 250.0
