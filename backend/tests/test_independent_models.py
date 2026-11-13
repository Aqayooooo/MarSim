"""Niezależne testy modeli fizycznych i planera (backend/models, backend/planning.py).

Wartości odniesienia pochodzą z fizyki i literatury (Allison & McEwen 2000 / NASA Mars24, NOAA S-scale,
RAD/Curiosity, NASA-STD-3001, efemerydy opozycji i koniunkcji Marsa), a nie z oczekiwań istniejących testów.
Planer sprawdzany jest także na syntetycznych siatkach, gdzie poprawną odpowiedź da się wyznaczyć ręcznie.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest
from conftest import cells, densify, make_engine

from backend import planning
from backend.models import orbits, physiology, radiation, sun
from backend.models.physiology import Person

UTC = timezone.utc
MARS_SOL_S = 88775.244  # doba słoneczna Marsa (Allison & McEwen 2000)
AU_LIGHT_MIN = 149_597_870.7 / 299_792.458 / 60  # ≈ 8,317 min


def person(**kw) -> Person:
    base = dict(id="T", body_kg=75.0, load_kg=120.0, o2_capacity_l=520.0, o2_l=520.0)
    base.update(kw)
    return Person(**base)


# ============================ słońce i czas na Marsie ============================
def test_mars24_reference_epoch_2000_01_06():
    """Przykład z opisu algorytmu Mars24: 2000-01-06 00:00 UTC → Ls ≈ 277,187°, EOT ≈ −5,188°, MST ≈ 23,994 h."""
    m = sun.mars_time(datetime(2000, 1, 6, tzinfo=UTC))
    assert m.ls == pytest.approx(277.187, abs=0.02)
    assert m.eot == pytest.approx(-5.1877, abs=0.01)
    # różnica TT−UTC (64 s w 2000 r. wobec 69 s przyjętych w kodzie) daje najwyżej kilka sekund
    assert m.mst == pytest.approx(23.994, abs=0.003)
    assert 1.38 < m.r_au < 1.40  # blisko peryhelium (Ls peryhelium ≈ 251°)


def test_one_sol_later_mean_solar_time_repeats():
    t0 = datetime(2037, 1, 10, tzinfo=UTC)
    a = sun.mars_time(t0).mst
    b = sun.mars_time(t0 + timedelta(seconds=MARS_SOL_S)).mst
    diff = (b - a + 12) % 24 - 12
    assert abs(diff) < 1e-3, f"po jednym solu MST zmienia się o {diff * 3600:.1f} s"


def test_half_sol_shifts_mean_solar_time_by_12h():
    t0 = datetime(2037, 1, 10, tzinfo=UTC)
    a = sun.mars_time(t0).mst
    b = sun.mars_time(t0 + timedelta(seconds=MARS_SOL_S / 2)).mst
    assert (b - a) % 24 == pytest.approx(12.0, abs=1e-3)


def test_ltst_shifts_one_hour_per_15_degrees_east():
    t = datetime(2037, 3, 15, 6, tzinfo=UTC)
    a, b = sun.ltst(t, 77.45), sun.ltst(t, 77.45 + 15)
    assert (b - a) % 24 == pytest.approx(1.0, abs=1e-9)


def test_mars_year_ls_returns_after_686_98_days():
    t0 = datetime(2037, 1, 10, tzinfo=UTC)
    a = sun.mars_time(t0).ls
    b = sun.mars_time(t0 + timedelta(days=686.98)).ls
    assert abs((b - a + 180) % 360 - 180) < 0.5


def test_solar_declination_bounded_by_mars_obliquity():
    """Nachylenie osi Marsa 25,19° — deklinacja Słońca w ciągu roku nie wychodzi poza ok. ±25,5° (wzór planetograficzny)."""
    t0 = datetime(2037, 1, 1, tzinfo=UTC)
    decl = [sun.mars_time(t0 + timedelta(days=d)).decl for d in range(0, 687, 3)]
    assert 25.0 < max(decl) < 25.6
    assert -25.6 < min(decl) < -25.0


def test_noon_elevation_is_90_minus_lat_minus_decl():
    for lat, decl in [(-4.67, 13.66), (18.44, -10.0), (0.0, 0.0), (45.0, 20.0)]:
        elev, _ = sun.sun_position(lat, decl, 12.0)
        assert elev == pytest.approx(90 - abs(lat - decl), abs=1e-6)


def test_sun_morning_east_afternoon_west_and_symmetric():
    lat, decl = 18.44, 5.0
    e_am, az_am = sun.sun_position(lat, decl, 9.0)
    e_pm, az_pm = sun.sun_position(lat, decl, 15.0)
    assert e_am == pytest.approx(e_pm, abs=1e-9)
    assert 0 < az_am < 180, "rano Słońce na wschodzie"
    assert 180 < az_pm < 360, "po południu na zachodzie"
    assert (az_am + az_pm) % 360 == pytest.approx(0, abs=1e-6)


def test_sun_below_horizon_at_midnight_on_equator():
    elev, _ = sun.sun_position(0.0, 10.0, 0.0)
    assert elev < -70


def test_sunset_is_18h_at_equinox_and_later_in_local_summer():
    for lat in (-40, -4.67, 0, 18.44, 60):
        assert sun.sunset_ltst(lat, 0.0) == pytest.approx(18.0, abs=1e-9)
    assert sun.sunset_ltst(18.44, 20) > 18.0  # lato na półkuli północnej
    assert sun.sunset_ltst(-30, 20) < 18.0  # zima na półkuli południowej
    assert sun.sunset_ltst(85, 25) == 24.0  # dzień polarny
    assert sun.sunset_ltst(-85, 25) == 12.0  # noc polarna


def test_sun_elevation_zero_at_computed_sunset():
    lat, decl = 18.44, 12.0
    elev, _ = sun.sun_position(lat, decl, sun.sunset_ltst(lat, decl))
    assert elev == pytest.approx(0.0, abs=1e-6)


def test_solar_flux_at_mars_orbit():
    """Stała słoneczna 1361 W/m² skalowana 1/r²: ok. 586 W/m² średnio, 717 w peryhelium, 490 w aphelium."""
    assert sun.solar_flux_top(1.0) == pytest.approx(1361.0)
    assert sun.solar_flux_top(1.5237) == pytest.approx(586, abs=2)
    assert sun.solar_flux_top(1.3814) == pytest.approx(713, abs=3)
    assert sun.solar_flux_top(1.6660) == pytest.approx(490, abs=2)


@pytest.mark.parametrize("hours,text", [(9.5, "09:30"), (0.0, "00:00"), (23.9999, "00:00"), (17.92, "17:55"), (13.0 + 59.6 / 60, "14:00")])
def test_fmt_ltst(hours, text):
    assert sun.fmt_ltst(hours) == text


# ============================ odległość Ziemia–Mars ============================
@pytest.mark.parametrize(
    "date,lo,hi,conj",
    [
        ("2035-09-15", 0.37, 0.40, False),  # opozycja peryheliczna 2035
        ("2027-02-20", 0.66, 0.70, False),  # opozycja 2027 (największe zbliżenie ≈0,678 AU)
        ("2026-01-09", 2.35, 2.55, True),  # koniunkcja Słońca 2026
    ],
)
def test_earth_mars_distance_at_known_oppositions_and_conjunction(date, lo, hi, conj):
    g = orbits.earth_mars(datetime.fromisoformat(date).replace(tzinfo=UTC))
    assert lo < g["distanceAu"] < hi
    assert g["conjunction"] is conj or bool(g["conjunction"]) == conj
    if not conj:
        assert g["sunEarthMarsDeg"] > 160, "w opozycji Mars jest naprzeciw Słońca"


def test_light_time_consistent_with_distance_and_within_3_to_23_minutes():
    t0 = datetime(2030, 1, 1, tzinfo=UTC)
    for d in range(0, 800, 20):
        g = orbits.earth_mars(t0 + timedelta(days=d))
        assert g["oneWayMin"] == pytest.approx(g["distanceAu"] * AU_LIGHT_MIN, rel=1e-9)
        assert g["distanceKm"] == pytest.approx(g["distanceAu"] * 149_597_870.7, rel=1e-12)
        assert 3.0 <= g["oneWayMin"] <= 22.5


def test_naive_datetime_treated_as_utc():
    naive = orbits.earth_mars(datetime(2037, 1, 10))
    aware = orbits.earth_mars(datetime(2037, 1, 10, tzinfo=UTC))
    assert naive["distanceKm"] == pytest.approx(aware["distanceKm"])


# ============================ fizjologia ============================
def test_mars_gravity_ratio():
    assert pytest.approx(3.721 / 9.80665, rel=0.005) == physiology.G_MARS


def test_oxygen_energy_equivalent_in_physiological_range():
    """1 L O₂ ≈ 19,6–21,1 kJ zależnie od paliwa (RQ 0,7–1,0)."""
    assert 19.5 <= physiology.KJ_PER_L_O2 <= 21.2
    # 335 W ≈ 1 L O₂/min
    assert physiology.o2_l_per_min(physiology.KJ_PER_L_O2 * 1000 / 60) == pytest.approx(1.0)


def test_metabolic_rate_monotonic_in_load_speed_grade():
    p = person()
    base = physiology.metabolic_w(p, 0.7, 0)
    assert physiology.metabolic_w(person(load_kg=160), 0.7, 0) > base
    assert physiology.metabolic_w(p, 1.0, 0) > base > physiology.metabolic_w(p, 0.3, 0)
    assert physiology.metabolic_w(p, 0.7, 10) > base
    speeds = np.linspace(0, 1.5, 16)
    w = physiology.metabolic_w(p, speeds, 5.0)
    assert np.all(np.diff(w) > 0)


def test_terrain_factor_orders_rock_rough_sand():
    p = person()
    rock, rough, sand = (physiology.metabolic_w(p, 0.7, 3, k) for k in ("rock", "rough", "sand"))
    assert rock < rough < sand


def test_downhill_never_cheaper_than_standing():
    p = person()
    standing = physiology.metabolic_w(p, 0.0, 0)
    for grade in (-5, -15, -30):
        assert physiology.metabolic_w(p, 0.7, grade) >= standing - 1e-9


def test_suited_walking_metabolic_in_apollo_range():
    """Średni wydatek w EVA Apollo ≈ 230–300 W; spokojny marsz w skafandrze powinien dać rząd 150–400 W."""
    p = person()
    w = physiology.metabolic_w(p, 0.6, 3)
    assert 150 < w < 400
    rest = physiology.metabolic_w(p, 0.0, 0)
    assert 60 < rest < w


def test_o2_and_co2_proportional_and_rq():
    for w in (100, 250, 500):
        assert physiology.co2_l_per_min(w) == pytest.approx(0.85 * physiology.o2_l_per_min(w))
    assert physiology.o2_l_per_min(500) == pytest.approx(5 * physiology.o2_l_per_min(100))


def test_heart_rate_rest_and_monotonic():
    assert physiology.heart_rate(80) == pytest.approx(65)
    assert physiology.heart_rate(110) == pytest.approx(65)
    hr = [physiology.heart_rate(w) for w in (150, 250, 350, 450)]
    assert hr == sorted(hr) and hr[0] < hr[-1]
    assert physiology.heart_rate(110 + 4.5 * 40) == pytest.approx(105)


def test_endurance_hours_formula_and_zero_below_reserve():
    p = person(o2_l=520)
    rate = physiology.o2_l_per_min(300) + p.leak_l_min
    assert physiology.endurance_h(p, 300, 0.2) == pytest.approx((520 - 104) / rate / 60)
    assert physiology.endurance_h(person(o2_l=50), 300, 0.2) == 0.0
    assert physiology.endurance_h(p, 400, 0.2) < physiology.endurance_h(p, 200, 0.2)


# ============================ promieniowanie ============================
def test_gcr_surface_dose_matches_rad_measurement():
    """RAD (Hassler 2014): ok. 0,64 mSv/sol na powierzchni w kraterze Gale."""
    assert radiation.dose_rate_usv_h() * 24 == pytest.approx(640, rel=1e-6)
    assert radiation.dose_rate_usv_h() == pytest.approx(26.7, abs=0.05)


@pytest.mark.parametrize("pfu,level", [(0, 1.0), (9.99, 1.0), (10, 1.8), (100, 4.0), (1000, 10.0), (10_000, 30.0), (1e6, 30.0)])
def test_sep_thresholds_follow_noaa_s_scale(pfu, level):
    assert radiation.sep_multiplier(pfu)[0] == level


def test_sep_multiplier_monotonic_and_shielding_reduces():
    flux = np.logspace(-1, 5, 60)
    mult = [radiation.sep_multiplier(f)[0] for f in flux]
    assert mult == sorted(mult)
    for f in (0, 50, 5000):
        assert radiation.dose_rate_usv_h(f, shielded=True) < radiation.dose_rate_usv_h(f)


def test_career_limit_levels():
    assert radiation.CAREER_LIMIT_MSV == 600
    assert radiation.limit_status(0)["level"] == "ok"
    assert radiation.limit_status(299.9)["level"] == "ok"
    assert radiation.limit_status(300)["level"] == "uwaga"
    assert radiation.limit_status(479.9)["level"] == "uwaga"
    assert radiation.limit_status(480)["level"] == "krytyczne"
    assert radiation.limit_status(150)["fraction"] == pytest.approx(0.25)


# ============================ planer: siatki syntetyczne ============================
N = 40
CELL = 3.0
EVA = {"walkKmh": 2.5, "maxSlopeDeg": 25}


def synthetic(hazard: np.ndarray | None = None, slope: float = 0.0, sand: float = 0.0) -> dict:
    shape = (N, N)
    return {
        "hazard": np.zeros(shape, np.uint8) if hazard is None else hazard.astype(np.uint8),
        "slope": np.full(shape, slope, np.float32),
        "slopeSigma": np.zeros(shape, np.float32),
        "sand": np.full(shape, sand, np.float32),
        "sandConfidence": np.ones(shape, np.float32),
    }


def model_for(layers) -> planning.CostModel:
    return planning.CostModel(layers, CELL, EVA, person())


def path_cells(path):
    xy = densify(path, step=0.2)
    return np.clip((xy[:, 1] // CELL).astype(int), 0, N - 1), np.clip((xy[:, 0] // CELL).astype(int), 0, N - 1)


def test_walk_speed_reference_values():
    assert planning.walk_speed_ms(0, 2.5) == pytest.approx(2.5 / 3.6)
    s = [float(planning.walk_speed_ms(d, 2.5)) for d in (0, 5, 10, 20, 30)]
    assert s == sorted(s, reverse=True)
    assert planning.walk_speed_ms(-12, 2.5) == pytest.approx(planning.walk_speed_ms(12, 2.5))


def test_open_flat_grid_route_is_nearly_straight():
    layers = synthetic()
    m = model_for(layers)
    start, goal = {"x": 4.5, "y": 4.5}, {"id": "G", "x": 112.5, "y": 85.5, "stopMin": 0}
    r = planning.plan(m, start, [goal], layers=layers)
    assert r["ok"]
    straight = math.hypot(goal["x"] - start["x"], goal["y"] - start["y"])
    assert straight <= r["lengthM"] <= straight * 1.02
    # płasko, bez stref: czas = droga / prędkość marszu
    assert r["durationH"] * 3600 == pytest.approx(r["lengthM"] / (2.5 / 3.6), rel=0.02)
    assert r["path"][0] == {"x": 4.5, "y": 4.5}
    assert r["path"][-1] == {"x": 112.5, "y": 85.5}


def test_wall_with_gap_route_goes_through_gap_only():
    hazard = np.zeros((N, N), np.uint8)
    hazard[:34, 20] = 2  # ściana z przejściem w wierszach 34–39
    layers = synthetic(hazard)
    r = planning.plan(model_for(layers), {"x": 10.5, "y": 10.5}, [{"id": "G", "x": 100.5, "y": 10.5}], layers=layers)
    assert r["ok"]
    rows, cols = path_cells(r["path"])
    assert not np.any(hazard[rows, cols] == 2)
    assert max(p["y"] for p in r["path"]) >= 34 * CELL, "trasa musi zejść do przejścia"
    # najkrótsza droga euklidesowa przez róg przejścia (x 60–63, y ≥ 102)
    bound = math.hypot(60 - 10.5, 102 - 10.5) + math.hypot(100.5 - 63, 102 - 10.5)
    assert bound <= r["lengthM"] <= bound * 1.1


def test_diagonal_wall_cannot_be_crossed_corner_to_corner():
    """Zakaz także „po przekątnej” między dwoma zakazanymi polami stykającymi się rogami."""
    hazard = np.zeros((N, N), np.uint8)
    for i in range(N):
        hazard[i, i] = 2
    layers = synthetic(hazard)
    r = planning.plan(model_for(layers), {"x": 100.5, "y": 10.5}, [{"id": "G", "x": 10.5, "y": 100.5}], layers=layers)
    assert not r["ok"]
    assert "G" in r["error"]


def test_goal_in_forbidden_cell_is_rejected_with_id():
    hazard = np.zeros((N, N), np.uint8)
    hazard[30, 30] = 2
    layers = synthetic(hazard)
    r = planning.plan(model_for(layers), {"x": 4.5, "y": 4.5}, [{"id": "WPX", "x": 30 * CELL + 1, "y": 30 * CELL + 1}], layers=layers)
    assert r == {"ok": False, "error": r["error"]} and "WPX" in r["error"]


def test_caution_zone_is_avoided_when_detour_is_cheap():
    hazard = np.zeros((N, N), np.uint8)
    hazard[5:35, 18:22] = 1  # pas „uwaga” na środku, obejście dołem/górą możliwe
    layers = synthetic(hazard)
    m = model_for(layers)
    start, goal = {"x": 10.5, "y": 60.5}, {"id": "G", "x": 110.5, "y": 60.5}
    r = planning.plan(m, start, [goal], layers=layers)
    strict = planning.plan(m, start, [goal], layers=layers, strict=True)
    assert r["ok"] and strict["ok"]
    rows, cols = path_cells(strict["path"])
    assert not np.any(hazard[rows, cols] == 1), "wariant ścisły nie wchodzi w strefy uwaga"
    # najtańszy (O₂) nie jest droższy niż ścisły
    assert r["o2L"] <= strict["o2L"] * 1.001


def test_obstacle_buffer_respected():
    layers = synthetic()
    m = model_for(layers)
    obstacle = {"x": 60.0, "y": 60.0, "radiusM": 15.0}
    r = planning.plan(m, {"x": 10.5, "y": 60.5}, [{"id": "G", "x": 110.5, "y": 60.5}], [obstacle], layers)
    assert r["ok"]
    xy = densify(r["path"], 0.2)
    clearance = np.hypot(xy[:, 0] - obstacle["x"], xy[:, 1] - obstacle["y"]).min()
    # komórki w promieniu r + bufor są zablokowane (środki komórek); trasa omija je co najmniej o r + bufor − przekątna komórki
    assert clearance >= obstacle["radiusM"] + planning.OBSTACLE_BUFFER_M - CELL * math.sqrt(2) / 2 - 1e-6


def test_stop_minutes_add_time_and_resting_oxygen():
    layers = synthetic()
    m = model_for(layers)
    start = {"x": 10.5, "y": 10.5}
    a = planning.plan(m, start, [{"id": "G", "x": 70.5, "y": 70.5, "stopMin": 0}], layers=layers)
    b = planning.plan(m, start, [{"id": "G", "x": 70.5, "y": 70.5, "stopMin": 30}], layers=layers)
    assert b["durationH"] - a["durationH"] == pytest.approx(0.5, abs=1e-9)
    assert b["o2L"] - a["o2L"] == pytest.approx(30 * planning.resting_o2_l_min(m.person), rel=1e-9)
    assert b["path"] == a["path"]


def test_steeper_terrain_costs_more_oxygen_and_time():
    flat, steep = synthetic(slope=0), synthetic(slope=12)
    goal = [{"id": "G", "x": 100.5, "y": 10.5}]
    a = planning.plan(model_for(flat), {"x": 10.5, "y": 10.5}, goal, layers=flat)
    b = planning.plan(model_for(steep), {"x": 10.5, "y": 10.5}, goal, layers=steep)
    assert b["o2L"] > a["o2L"] and b["durationH"] > a["durationH"]
    assert b["lengthM"] == pytest.approx(a["lengthM"], rel=1e-6)


def test_sand_terrain_costs_more_than_rock():
    rock, sand = synthetic(sand=0.0), synthetic(sand=0.5)
    goal = [{"id": "G", "x": 100.5, "y": 10.5}]
    a = planning.plan(model_for(rock), {"x": 10.5, "y": 10.5}, goal, layers=rock)
    b = planning.plan(model_for(sand), {"x": 10.5, "y": 10.5}, goal, layers=sand)
    assert b["o2L"] > a["o2L"]


def test_cost_field_zero_at_origin_grows_with_distance_and_marks_unreachable():
    hazard = np.zeros((N, N), np.uint8)
    hazard[:, 30] = 2  # pełna ściana: prawa część nieosiągalna
    layers = synthetic(hazard)
    m = model_for(layers)
    field = planning.cost_field(m, {"x": 4.5, "y": 4.5})
    assert field[1, 1] == 0
    assert field[1, 10] > field[1, 5] > field[1, 2] > 0
    assert np.all(field[:, 31:] == planning.UNREACHABLE)
    assert np.all(field[:, 30] == planning.UNREACHABLE)


def test_cost_field_from_blocked_origin_is_all_unreachable():
    hazard = np.zeros((N, N), np.uint8)
    hazard[1, 1] = 2
    layers = synthetic(hazard)
    field = planning.cost_field(model_for(layers), {"x": 4.5, "y": 4.5})
    assert np.all(field == planning.UNREACHABLE)


def test_hazard_for_limit_relaxes_only_steep_cells():
    hazard = np.zeros((N, N), np.uint8)
    layers = synthetic(hazard)
    layers["slope"][:, :10] = 27.0  # strome (zakazane przy 25°)
    layers["hazard"][:, :10] = 2
    layers["sand"][:, 30:] = 0.9  # piasek — zakaz niezależny od nachylenia
    layers["hazard"][:, 30:] = 2
    h30 = planning.hazard_for_limit(layers, EVA, 30.0)
    h20 = planning.hazard_for_limit(layers, EVA, 20.0)
    assert np.all(h30[:, :10] == 1), "przy 30° strome pola stają się „uwaga”"
    assert np.all(h30[:, 30:] == 2), "piasek zostaje zakazany"
    assert np.all(h20[:, :10] == 2) and np.all(h20[:, 30:] == 2)
    layers["slope"][:, 12:14] = 22.0
    assert np.all(planning.hazard_for_limit(layers, EVA, 20.0)[:, 12:14] == 2)


# ============================ planer na danych misji ============================
@pytest.fixture(scope="module", params=["mount-sharp", "jezero"])
def mission_engine(request):
    return make_engine(request.param)


@pytest.fixture(scope="module")
def mission_plan(mission_engine):
    e = mission_engine
    start = {"x": e.cfg["rover"]["x"], "y": e.cfg["rover"]["y"]}
    r = planning.plan(e.model, start, e.cfg["waypoints"], [], e.layers)
    assert r["ok"], r
    return e, start, r


def test_mission_route_obeys_contract_start_and_waypoints(mission_plan):
    e, start, r = mission_plan
    assert r["path"][0] == {"x": start["x"], "y": start["y"]}
    assert len(r["waypointIndex"]) == len(e.cfg["waypoints"])
    assert r["waypointIndex"] == sorted(r["waypointIndex"])
    for i, wp in zip(r["waypointIndex"], e.cfg["waypoints"]):
        assert r["path"][i] == {"x": wp["x"], "y": wp["y"]}
    assert r["waypointIndex"][-1] == len(r["path"]) - 1


def test_mission_route_never_enters_forbidden_cells_or_steep_or_loose_sand(mission_plan):
    e, _, r = mission_plan
    rows, cols = cells(e, densify(r["path"], 0.25))
    assert not np.any(e.layers["hazard"][rows, cols] == 2)
    slope_up = e.layers["slope"][rows, cols] + 2 * e.layers["slopeSigma"][rows, cols]
    assert slope_up.max() <= e.cfg["eva"]["maxSlopeDeg"]
    assert e.layers["sand"][rows, cols].max() <= 0.6


def test_mission_route_length_consistent_with_geometry(mission_plan):
    e, start, r = mission_plan
    poly = sum(math.hypot(b["x"] - a["x"], b["y"] - a["y"]) for a, b in zip(r["path"][:-1], r["path"][1:]))
    assert r["lengthM"] == pytest.approx(poly, rel=1e-6)
    stops = [start] + e.cfg["waypoints"]
    straight = sum(math.hypot(b["x"] - a["x"], b["y"] - a["y"]) for a, b in zip(stops[:-1], stops[1:]))
    assert r["lengthM"] >= straight - 1e-6


def test_mission_route_duration_not_faster_than_flat_walk(mission_plan):
    e, _, r = mission_plan
    stop_h = sum(w.get("stopMin", 0) for w in e.cfg["waypoints"]) / 60
    flat_h = r["lengthM"] / (e.cfg["eva"]["walkKmh"] * 1000)
    assert r["durationH"] >= flat_h + stop_h - 1e-9
    assert r["durationH"] < 8, "pojedyncze wyjście w limicie 8 h"


def test_mission_route_is_deterministic(mission_plan):
    e, start, r = mission_plan
    again = planning.plan(e.model, start, e.cfg["waypoints"], [], e.layers)
    assert again["path"] == r["path"] and again["o2L"] == r["o2L"]


def test_route_interval_brackets_planner_estimate(mission_plan):
    e, _, r = mission_plan
    interval = planning.route_interval(e.model, e.layers, r["path"], e.cfg["waypoints"])
    o2, dur = interval["o2L"], interval["durationH"]
    assert o2["low"] <= o2["mid"] <= o2["high"]
    assert dur["low"] <= dur["mid"] <= dur["high"]
    assert o2["mid"] == pytest.approx(r["o2L"], abs=0.11)
    assert dur["mid"] == pytest.approx(r["durationH"], abs=1e-3)


def test_sensitivity_higher_slope_limit_never_needs_more_oxygen(mission_plan):
    e, start, _ = mission_plan
    rows = planning.sensitivity(e.model, start, e.cfg["waypoints"], [], e.layers)
    assert [row["maxSlopeDeg"] for row in rows] == sorted(row["maxSlopeDeg"] for row in rows)
    ok = [row for row in rows if row["ok"]]
    assert ok, "co najmniej jeden limit daje trasę"
    for a, b in zip(ok, ok[1:]):
        assert b["o2L"] <= a["o2L"] * 1.03, f"limit {b['maxSlopeDeg']}° droższy niż {a['maxSlopeDeg']}°"
    for row in ok:
        assert row["maxSlopeOnRouteDeg"] <= row["maxSlopeDeg"] + 1e-6


def test_mission_alternatives_chosen_is_cheapest_safe(mission_plan):
    e, start, r = mission_plan
    alts = planning.alternatives(e.model, start, e.cfg["waypoints"], [], e.layers, e.comms, r)
    by_id = {a["id"]: a for a in alts}
    assert set(by_id) == {"chosen", "straight", "shortest", "strict"}
    chosen = by_id["chosen"]
    assert chosen["forbiddenM"] == 0
    for a in alts:
        if a["ok"] and a["forbiddenM"] == 0 and a["id"] != "chosen":
            assert a["o2L"] >= chosen["o2L"] * 0.99, f"{a['id']} tańszy od wybranej"
    assert by_id["shortest"]["lengthM"] <= chosen["lengthM"] + 1
    assert by_id["straight"]["lengthM"] <= by_id["shortest"]["lengthM"] + 1
