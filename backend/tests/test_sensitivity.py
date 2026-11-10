"""Niepewność i wrażliwość: mapa zagrożeń przy innym limicie nachylenia, warianty trasy, przedział tlenu i czasu."""

import numpy as np
import pytest
from conftest import MISSION_IDS, make_engine

from backend import planning


@pytest.mark.parametrize("mission", MISSION_IDS)
def test_higher_slope_limit_never_adds_forbidden_cells(mission):
    e = make_engine(mission)
    hazards = [planning.hazard_for_limit(e.layers, e.cfg["eva"], limit) == 2 for limit in planning.SENSITIVITY_SLOPE_LIMITS]
    for lower, higher in zip(hazards, hazards[1:]):
        assert not (higher & ~lower).any()
    same = planning.hazard_for_limit(e.layers, e.cfg["eva"], e.cfg["eva"]["maxSlopeDeg"])
    assert np.array_equal(same == 2, e.layers["hazard"] == 2)  # przy obecnym limicie mapa zakazów bez zmian
    sand = e.layers["sand"] > planning.SAND_FORBIDDEN_THRESHOLD
    assert (hazards[-1][sand & (e.layers["hazard"] == 2)]).all()  # piasek zostaje zakazany przy każdym limicie


def test_sensitivity_matches_plan_at_current_limit(gale):
    route = gale.plan()
    result = gale.sensitivity()
    assert result["ok"] and result["currentMaxSlopeDeg"] == gale.cfg["eva"]["maxSlopeDeg"]
    current = next(v for v in result["variants"] if v["maxSlopeDeg"] == result["currentMaxSlopeDeg"])
    assert current["ok"] and abs(current["lengthM"] - route["lengthM"]) <= 1
    assert gale.sensitivity() is result  # druga prośba bez liczenia od nowa


def test_lower_limit_can_make_a_steep_target_unreachable(gale):
    target = {"id": "WP1", "x": 674, "y": 226, "stopMin": 10}
    variants = {v["maxSlopeDeg"]: v for v in planning.sensitivity(gale.model, gale.cfg["rover"], [target], [], gale.layers)}
    assert not variants[20.0]["ok"] and variants[30.0]["ok"]


@pytest.mark.parametrize("mission", MISSION_IDS)
def test_interval_brackets_the_planned_values(mission):
    e = make_engine(mission)
    route = e.plan()
    u = planning.route_interval(e.model, e.layers, route["path"], e.waypoints)
    for key in ("o2L", "durationH"):
        assert u[key]["low"] < u[key]["mid"] < u[key]["high"]
    assert abs(u["o2L"]["mid"] - route["o2L"]) < 0.2
    assert abs(u["durationH"]["mid"] - route["durationH"]) < 0.01


def test_sensitivity_endpoint(client):
    assert client.get("/api/sensitivity").status_code == 409  # bez trasy
    assert client.post("/api/plan").status_code == 200
    body = client.get("/api/sensitivity").json()
    assert body["ok"] and len(body["variants"]) == len(planning.SENSITIVITY_SLOPE_LIMITS)
    assert "uncertainty" in client.get("/api/report").json()
