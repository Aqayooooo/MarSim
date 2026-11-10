"""Modele fizyczne porównane z wartościami z literatury i z własnym, niezależnym przeliczeniem."""

from datetime import datetime, timezone

import pytest

from backend.models import orbits, physiology, radiation, sun


# ---- czas Marsa: przykład z opisu algorytmu Mars24 (Allison & McEwen 2000), 6.01.2000 00:00 UTC ----
def test_mars24_worked_example():
    m = sun.mars_time(datetime(2000, 1, 6, tzinfo=timezone.utc))
    assert m.ls == pytest.approx(277.18758, abs=0.002)
    assert m.eot == pytest.approx(-5.18774, abs=0.002)
    assert m.decl == pytest.approx(-25.22838, abs=0.01)
    assert m.r_au == pytest.approx(1.39358, abs=0.0005)
    # MTC 23:59:39 = 23,99425 h; kod używa dzisiejszego TT−UTC (69 s zamiast 64 s w 2000 r.) → tolerancja 0,005 h
    assert min(abs(m.mst - 23.99425), 24 - abs(m.mst - 23.99425)) < 0.005


def test_sun_geometry_basics():
    assert sun.sunset_ltst(0, 0) == pytest.approx(18.0)
    elev, _ = sun.sun_position(-4.6, -20.0, 12.0)
    assert elev == pytest.approx(90 - abs(-4.6 - -20.0), abs=1e-6)
    _, az_morning = sun.sun_position(10, 0, 8.0)
    _, az_evening = sun.sun_position(10, 0, 16.0)
    assert 60 < az_morning < 120 and 240 < az_evening < 300
    assert sun.solar_flux_top(1.52367934) == pytest.approx(586.2, abs=1.0)  # stała słoneczna Marsa


@pytest.mark.parametrize("hours,text", [(9.5, "09:30"), (23.9999, "00:00"), (0.0, "00:00"), (12.999999, "13:00")])
def test_fmt_ltst(hours, text):
    assert sun.fmt_ltst(hours) == text


# ---- odległość Ziemia–Mars: znane opozycje i koniunkcje ----
@pytest.mark.parametrize(
    "date,mkm,tol",
    [
        (datetime(2020, 10, 6, 14, tzinfo=timezone.utc), 62.07, 0.5),  # największe zbliżenie 2020
        (datetime(2018, 7, 31, 8, tzinfo=timezone.utc), 57.59, 0.5),  # największe zbliżenie 2018
        (datetime(2003, 8, 27, 10, tzinfo=timezone.utc), 55.76, 0.5),  # rekordowe zbliżenie 2003
    ],
)
def test_earth_mars_distance_at_close_approach(date, mkm, tol):
    g = orbits.earth_mars(date)
    assert g["distanceKm"] / 1e6 == pytest.approx(mkm, abs=tol)
    assert not g["conjunction"]


@pytest.mark.parametrize("date", [datetime(2021, 10, 8, tzinfo=timezone.utc), datetime(2023, 11, 18, tzinfo=timezone.utc)])
def test_solar_conjunction_detected(date):
    g = orbits.earth_mars(date)
    assert g["conjunction"]
    assert 2.4 < g["distanceAu"] < 2.7


def test_light_time_always_physical():
    for year in range(2030, 2041):
        for month in (1, 4, 7, 10):
            g = orbits.earth_mars(datetime(year, month, 1, tzinfo=timezone.utc))
            assert 3.0 < g["oneWayMin"] < 22.4
            assert g["oneWayMin"] == pytest.approx(g["distanceKm"] / 299792.458 / 60)


# ---- wysiłek: równanie Pandolfa przeliczone ręcznie ----
def pandolf_reference(body, load, v, grade_pct, eta, g=0.3794, cal=0.55, suit=60.0):
    move = eta * (body + load) * (1.5 * v * v + 0.35 * v * grade_pct) * g
    return cal * (1.5 * body + 2.0 * (body + load) * (load / body) ** 2 * g + max(0.0, move)) + suit


@pytest.mark.parametrize(
    "v,grade,terrain,eta",
    [(0.0, 0, "rock", 1.1), (0.7, 0, "rock", 1.1), (0.6, 10, "rough", 1.5), (0.5, 20, "sand", 2.1), (0.6, -15, "rock", 1.1)],
)
def test_pandolf_matches_hand_calculation(v, grade, terrain, eta):
    p = physiology.Person("EV1", 78, 125, 520, 520)
    assert float(physiology.metabolic_w(p, v, grade, terrain)) == pytest.approx(pandolf_reference(78, 125, v, grade, eta), rel=1e-9)


def test_metabolic_rates_in_apollo_range():
    """Apollo: średnio ok. 230–300 W podczas EVA; spoczynek w skafandrze wyraźnie ponad 100 W."""
    p = physiology.Person("EV1", 78, 125, 520, 520)
    walking = float(physiology.metabolic_w(p, 2.5 / 3.6, 3))
    resting = float(physiology.metabolic_w(p, 0, 0))
    assert 100 < resting < walking
    assert 180 < walking < 450


def test_oxygen_conversion():
    assert physiology.o2_l_per_min(335.0) == pytest.approx(1.0)  # 20,1 kJ/L → 335 W = 1 L/min
    assert physiology.co2_l_per_min(335.0) == pytest.approx(0.85)
    p = physiology.Person("EV1", 78, 125, 520, 520)
    hours = physiology.endurance_h(p, 335.0, 0.2)
    assert hours == pytest.approx((520 * 0.8) / (1.0 + 0.02) / 60)


# ---- promieniowanie ----
def test_radiation_background_and_storm_levels():
    assert radiation.dose_rate_usv_h() * 24 == pytest.approx(640.0)  # RAD/Curiosity: 0,64 mSv/dobę
    previous = 0.0
    for pfu in (0, 9.99, 10, 100, 1000, 10000, 1e6):
        rate = radiation.dose_rate_usv_h(pfu)
        assert rate >= previous
        previous = rate
    assert radiation.sep_multiplier(9.99)[0] == 1.0 and radiation.sep_multiplier(10)[0] > 1.0
    assert radiation.dose_rate_usv_h(500, shielded=True) < radiation.dose_rate_usv_h(500)


@pytest.mark.parametrize("dose,level", [(0, "ok"), (299.9, "ok"), (300, "uwaga"), (479.9, "uwaga"), (480, "krytyczne"), (700, "krytyczne")])
def test_career_limit_levels(dose, level):
    assert radiation.limit_status(dose)["level"] == level
