"""Poprawki API z przeglądu: walidacja /api/plan (M6), 409 raportu bez trasy, bufor DONKI (M8),
próg piasku w raporcie, sol ≥ 1 i polskie komunikaty harmonogramu (M5)."""

import json
import os

import pytest

from backend.live import report, spaceweather
from backend.tests.conftest import make_engine


def _mission(client) -> dict:
    return client.get("/missions/current/mission.json").json()


def _wp(client, i: int) -> dict:
    w = _mission(client)["waypoints"][0]
    return {"id": f"W{i}", "x": w["x"], "y": w["y"]}


# ---------------- M6: /api/plan ----------------
def test_plan_accepts_at_most_eight_waypoints(client):
    r = client.post("/api/plan", json={"waypoints": [_wp(client, i) for i in range(9)]})
    assert r.status_code == 422 and r.json()["ok"] is False
    r = client.post("/api/plan", json={"waypoints": [_wp(client, i) for i in range(8)]})
    assert r.status_code != 422, r.text[:300]


def test_plan_rejects_duplicate_waypoint_ids(client):
    r = client.post("/api/plan", json={"waypoints": [_wp(client, 1), _wp(client, 1), _wp(client, 2)]})
    assert r.status_code == 422
    assert "powtórzony identyfikator punktu: W1" in r.json()["error"]
    assert "Value error" not in r.json()["error"]


def test_plan_still_accepts_and_ignores_obstacles(client):
    wps = _mission(client)["waypoints"]
    r = client.post("/api/plan", json={"waypoints": wps, "obstacles": [{"x": 1, "y": 1, "r": 5}]})
    assert r.status_code == 200 and r.json()["ok"]


# ---------------- /api/report bez trasy ----------------
def test_report_without_route_is_409_with_error_body(client):
    r = client.get("/api/report")
    assert r.status_code == 409
    assert r.json() == {"ok": False, "error": "Brak trasy — najpierw wyznacz trasę."}
    client.post("/api/plan")
    r = client.get("/api/report")
    assert r.status_code == 200 and r.json()["ok"]


# ---------------- M5: harmonogram ----------------
def _item(client, **kw) -> dict:
    crew = [m["id"] for m in _mission(client)["crew"]][:1]
    return {"id": "EVA-T1", "sol": 900, "startLtst": "10:00", "durationH": 2.0, "crew": crew, "purpose": "test", **kw}


@pytest.mark.parametrize("sol", [0, -1])
def test_schedule_rejects_sol_below_one(client, sol):
    r = client.post("/api/schedule", json=_item(client, sol=sol))
    assert r.status_code == 422
    assert r.json()["error"] == "Błędne dane zapytania — sol: numer solu od 1 do 100000"


def test_schedule_accepts_sol_one(client):
    r = client.post("/api/schedule", json=_item(client, sol=1))
    assert r.status_code == 200, r.text[:300]
    assert any(i["id"] == "EVA-T1" for i in r.json()["items"])


@pytest.mark.parametrize(
    "patch, text",
    [
        ({"startLtst": "9:30"}, "startLtst: godzina startu w formacie GG:MM"),
        ({"durationH": 0}, "durationH: czas trwania większy od 0 i najwyżej 12 h"),
        ({"crew": []}, "crew: wybierz od 1 do 8 osób"),
        ({"id": "bad id!"}, "id: identyfikator"),
        ({"purpose": "x" * 201}, "purpose: cel najwyżej 200 znaków"),
        ({"extra": 1}, "extra: nieznane pole"),
    ],
)
def test_schedule_errors_are_readable_polish(client, patch, text):
    r = client.post("/api/schedule", json=_item(client, **patch))
    assert r.status_code == 422
    error = r.json()["error"]
    assert error.startswith("Błędne dane zapytania — ") and text in error
    assert "should" not in error and "^" not in error  # bez surowego tekstu pydantic i wyrażeń regularnych


def test_schedule_duplicate_crew_message_without_pydantic_prefix(client):
    who = _item(client)["crew"][0]
    r = client.post("/api/schedule", json=_item(client, crew=[who, who]))
    assert r.status_code == 422
    assert r.json()["error"] == "Błędne dane zapytania — crew: ta sama osoba wpisana więcej niż raz"


def test_schedule_put_uses_polish_messages_too(client):
    item = _item(client)
    assert client.post("/api/schedule", json=item).status_code == 200
    r = client.put(f"/api/schedule/{item['id']}", json={**item, "sol": 0})
    assert r.status_code == 422 and "sol: numer solu od 1" in r.json()["error"]


# ---------------- M8: bufor pogody kosmicznej ----------------
PROTONS = [{"energy": ">=10 MeV", "time_tag": "2026-11-14T00:00:00Z", "flux": 0.5}]
OLD = {
    "fetchedUtc": "2026-11-13T00:00:00+00:00",
    "errors": [],
    "sep": [{"eventTime": "2026-11-12T01:00Z"}],
    "cme": [{"startTime": "2026-11-12T02:00Z", "cmeAnalyses": [{"speed": 500}]}],
    "flr": [{"peakTime": "2026-11-12T03:00Z", "classType": "M1"}],
    "protons10MeV": [{"t": "2026-11-13T00:00:00Z", "pfu": 0.4}],
}


def _fake_get(fail: set[str]):
    def get(url, timeout=40):
        for kind in ("SEP", "CME", "FLR"):
            if f"/DONKI/{kind}?" in url:
                if kind in fail:
                    raise OSError("HTTP Error 429: Too Many Requests")
                return [{"eventTime": "2026-11-14T05:00Z"}] if kind == "SEP" else []
        return PROTONS

    return get


@pytest.fixture
def sw_cache(tmp_path, monkeypatch):
    path = tmp_path / "cache" / "spaceweather.json"
    monkeypatch.setattr(spaceweather, "CACHE_FILE", path)
    return path


def _write_old_cache(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(OLD), encoding="utf-8")
    os.utime(path, (0, 0))  # bufor przeterminowany: get() próbuje sieci


def test_donki_failure_keeps_cached_events(sw_cache, monkeypatch):
    _write_old_cache(sw_cache)
    monkeypatch.setattr(spaceweather, "_get", _fake_get({"SEP", "CME", "FLR"}))
    out = spaceweather.get()
    assert out["source"] == "sieć"
    assert {e["type"] for e in out["events"]} == {"SEP", "CME", "FLR"}
    assert "zdarzenia DONKI z 7 dni: 3" in out["summary"]
    saved = json.loads(sw_cache.read_text(encoding="utf-8"))
    assert saved["sep"] == OLD["sep"] and saved["cme"] == OLD["cme"] and saved["flr"] == OLD["flr"]
    assert sorted(saved["donkiStale"]) == ["cme", "flr", "sep"]
    assert saved["protons10MeV"][-1]["pfu"] == 0.5  # protony z sieci są nowe


def test_donki_partial_failure_replaces_only_failed_kinds(sw_cache, monkeypatch):
    _write_old_cache(sw_cache)
    monkeypatch.setattr(spaceweather, "_get", _fake_get({"CME"}))
    spaceweather.get()
    saved = json.loads(sw_cache.read_text(encoding="utf-8"))
    assert saved["sep"] == [{"eventTime": "2026-11-14T05:00Z"}]  # nowe z sieci
    assert saved["flr"] == []  # z sieci: brak rozbłysków to też wynik
    assert saved["cme"] == OLD["cme"] and saved["donkiStale"] == ["cme"]


def test_donki_all_failed_without_cache_says_no_data(sw_cache, monkeypatch):
    monkeypatch.setattr(spaceweather, "_get", _fake_get({"SEP", "CME", "FLR"}))
    out = spaceweather.get()
    assert out["events"] == []
    assert out["summary"].endswith("zdarzenia DONKI z 7 dni: brak danych")
    # kolejna awaria nie zamienia „brak danych” na „0”
    os.utime(sw_cache, (0, 0))
    assert spaceweather.get()["summary"].endswith("zdarzenia DONKI z 7 dni: brak danych")


def test_donki_ok_with_no_events_says_zero(sw_cache, monkeypatch):
    monkeypatch.setattr(spaceweather, "_get", lambda url, timeout=40: PROTONS if "swpc" in url else [])
    assert spaceweather.get()["summary"].endswith("zdarzenia DONKI z 7 dni: 0")


# ---------------- report.py: próg piasku z konfiguracji misji ----------------
@pytest.mark.parametrize("mission_id, text", [("mount-sharp", "> 0,6; uwaga przy 0,35–0,6"), ("boxwork", "> 0,8; uwaga przy 0,35–0,8")])
def test_report_sand_mitigation_uses_mission_threshold(mission_id, text):
    eng = make_engine(mission_id)
    assert eng.plan(None, None, "A")["ok"]
    h2 = next(h for h in report.build(eng)["hazards"] if h["id"] == "H2")
    assert h2["mitigation"] == f"trasa omija piasek {text}"
