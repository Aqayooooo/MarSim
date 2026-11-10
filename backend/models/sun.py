"""Położenie Słońca na Marsie — algorytm Allison & McEwen (2000), ten sam co w NASA GISS Mars24.

Wejście: czas UTC i współrzędne planetocentryczne (szerokość, długość wschodnia).
Wyjście: Ls, deklinacja, lokalny prawdziwy czas słoneczny (LTST), wysokość i azymut Słońca.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone

TT_MINUS_UTC = 69.184  # s (TAI-UTC 37 s + 32.184 s)
_PBS = [  # (A, tau, phi) — perturbacje planetarne
    (0.0071, 2.2353, 49.409),
    (0.0057, 2.7543, 168.173),
    (0.0039, 1.1177, 191.837),
    (0.0037, 15.7866, 21.736),
    (0.0021, 2.1354, 15.704),
    (0.0020, 2.4694, 95.528),
    (0.0018, 32.8493, 49.095),
]


def _jd_utc(t: datetime) -> float:
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return 2440587.5 + t.timestamp() / 86400.0


@dataclass
class MarsTime:
    ls: float  # długość areocentryczna Słońca (°)
    decl: float  # deklinacja Słońca (°)
    eot: float  # równanie czasu (°)
    mst: float  # średni czas słoneczny na południku 0 (h)
    r_au: float  # odległość Mars–Słońce (AU)
    jd_tt: float


def mars_time(t: datetime) -> MarsTime:
    jd_tt = _jd_utc(t) + TT_MINUS_UTC / 86400.0
    dt = jd_tt - 2451545.0
    M = 19.3871 + 0.52402073 * dt
    a_fms = 270.3871 + 0.524038496 * dt
    pbs = sum(A * math.cos(math.radians(0.985626 * dt / tau + phi)) for A, tau, phi in _PBS)
    Mr = math.radians(M)
    nu_m = (
        (10.691 + 3.0e-7 * dt) * math.sin(Mr)
        + 0.623 * math.sin(2 * Mr)
        + 0.050 * math.sin(3 * Mr)
        + 0.005 * math.sin(4 * Mr)
        + 0.0005 * math.sin(5 * Mr)
        + pbs
    )
    ls = (a_fms + nu_m) % 360.0
    lsr = math.radians(ls)
    eot = 2.861 * math.sin(2 * lsr) - 0.071 * math.sin(4 * lsr) + 0.002 * math.sin(6 * lsr) - nu_m
    mst = (24.0 * ((jd_tt - 2451549.5) / 1.0274912517 + 44796.0 - 0.0009626)) % 24.0
    decl = math.degrees(math.asin(0.42565 * math.sin(lsr))) + 0.25 * math.sin(lsr)
    r = 1.52367934 * (
        1.00436 - 0.09309 * math.cos(Mr) - 0.004336 * math.cos(2 * Mr) - 0.00031 * math.cos(3 * Mr) - 0.00003 * math.cos(4 * Mr)
    )
    return MarsTime(ls, decl, eot, mst, r, jd_tt)


def ltst(t: datetime, lon_east: float) -> float:
    """Lokalny prawdziwy czas słoneczny (h) w danej długości wschodniej."""
    m = mars_time(t)
    lmst = (m.mst + lon_east / 15.0) % 24.0
    return (lmst + m.eot / 15.0) % 24.0


def fmt_ltst(hours: float) -> str:
    """Godzina LTST jako „GG:MM” (zaokrąglenie do minuty — int(h % 1 * 60) gubi minutę przez błąd zmiennoprzecinkowy)."""
    m = round(hours * 60)
    return f"{m // 60 % 24:02d}:{m % 60:02d}"


def sun_position(lat: float, decl: float, ltst_h: float) -> tuple[float, float]:
    """(wysokość °, azymut ° od północy zgodnie z ruchem wskazówek) dla danego LTST."""
    H = math.radians((ltst_h - 12.0) * 15.0)
    phi, d = math.radians(lat), math.radians(decl)
    cz = math.sin(phi) * math.sin(d) + math.cos(phi) * math.cos(d) * math.cos(H)
    elev = math.degrees(math.asin(max(-1.0, min(1.0, cz))))
    az = math.degrees(math.atan2(-math.sin(H), math.tan(d) * math.cos(phi) - math.sin(phi) * math.cos(H))) % 360.0
    return elev, az


def solar_flux_top(r_au: float) -> float:
    """Natężenie promieniowania słonecznego na szczycie atmosfery Marsa (W/m²)."""
    return 1361.0 / (r_au**2)


def sunset_ltst(lat: float, decl: float, horizon_deg: float = 0.0) -> float:
    """Godzina LTST, o której Słońce schodzi poniżej danej wysokości horyzontu."""
    phi, d, h0 = math.radians(lat), math.radians(decl), math.radians(horizon_deg)
    c = (math.sin(h0) - math.sin(phi) * math.sin(d)) / (math.cos(phi) * math.cos(d))
    if c <= -1:
        return 24.0
    if c >= 1:
        return 12.0
    return 12.0 + math.degrees(math.acos(c)) / 15.0
