"""Regresje znalezione podczas przeglądu end-to-end (agent DEBUG)."""

import pytest

from backend.live import report


@pytest.mark.parametrize(
    ("n", "word"),
    [(0, "przystanków"), (1, "przystanek"), (2, "przystanki"), (4, "przystanki"), (5, "przystanków"),
     (12, "przystanków"), (22, "przystanki")],
)
def test_report_stops_polish_plural(n, word):
    """Podsumowanie raportu: „0 przystanki” / „1 przystanki” było błędne gramatycznie (np. dla trasy powrotnej)."""
    assert report._stops_pl(n) == word


def test_interval_time_bounds_follow_speed_band(gale):
    """Prędkość ±15% → czas marszu od t/1,15 do t/0,85 (wcześniej t·0,85 i t·1,15 — przedział za szeroki w dół)."""
    from backend import planning

    route = gale.plan()
    u = planning.route_interval(gale.model, gale.layers, route["path"], gale.waypoints)
    stops_h = sum(w.get("stopMin", 0) for w in gale.waypoints) / 60
    low_m, high_m = (planning.CostModel(gale.layers, gale.model.cell, gale.model.eva, gale.model.person, sigma_margin=s)
                     for s in planning.SIGMA_RANGE)
    walk_low = planning.path_stats(low_m, route["path"], None)["walkH"]
    walk_high = planning.path_stats(high_m, route["path"], None)["walkH"]
    assert u["durationH"]["low"] == pytest.approx(walk_low / 1.15 + stops_h, abs=2e-3)
    assert u["durationH"]["high"] == pytest.approx(walk_high / 0.85 + stops_h, abs=2e-3)


def test_return_rejected_before_eva_started(client):
    """Powrót przed startem: wcześniej 200, faza zostawała „idle”, a raport liczył HAB jako zaplanowany punkt."""
    assert client.post("/api/plan").status_code == 200
    r = client.post("/api/eva/return")
    assert r.status_code == 409 and "nie zaczęła" in r.json()["error"]
    assert client.get("/api/state").json()["phase"] == "idle"
    assert client.get("/api/report").json()["effectiveness"]["waypointsPlanned"] == 2


def test_out_of_area_message_has_short_numbers(client):
    """x = 1e308 dawało w komunikacie liczbę z ~300 cyframi."""
    r = client.post("/api/telemetry", json={"id": "Bartek", "x": 1e308, "y": 10})
    assert r.status_code == 422 and len(r.json()["error"]) < 200, r.json()["error"]


def test_telemetry_for_crew_not_on_current_eva_is_409(client):
    eng = client.app.state.active()
    sol = client.get("/api/state").json()["sol"]
    item = {"id": "DBG-1", "sol": sol, "startLtst": "07:00", "durationH": 1, "crew": ["Hubert"]}
    assert client.post("/api/schedule", json=item).status_code == 200
    client.post("/api/eva/reset")
    assert [c["cfg"]["id"] for c in eng.crew] == ["Hubert"]
    r = client.post("/api/telemetry", json={"id": "Bartek", "o2L": 100})
    assert r.status_code == 409 and "Nieznany" not in r.json()["error"]
    assert client.post("/api/telemetry", json={"id": "Nikt", "o2L": 100}).status_code == 404
