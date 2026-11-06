"""Odległość Ziemia–Mars i opóźnienie sygnału (elementy keplerowskie JPL, przybliżenie 1800–2050)."""
from __future__ import annotations

import math
from datetime import datetime, timezone

# a [AU], e, I [°], L [°], long.peri [°], long.node [°] + tempo na stulecie
_EL = {
    "earth": ((1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0),
              (0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0)),
    "mars": ((1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891),
             (0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343)),
}
AU_KM = 149_597_870.7
C_KM_S = 299_792.458


def _pos(body: str, T: float):
    (a0, e0, i0, L0, w0, O0), (da, de, di, dL, dw, dO) = _EL[body]
    a, e, I, L, wbar, Om = a0 + da * T, e0 + de * T, i0 + di * T, L0 + dL * T, w0 + dw * T, O0 + dO * T
    w = wbar - Om
    M = math.radians((L - wbar + 180) % 360 - 180)
    E = M
    for _ in range(8):
        E -= (E - e * math.sin(E) - M) / (1 - e * math.cos(E))
    xp, yp = a * (math.cos(E) - e), a * math.sqrt(1 - e * e) * math.sin(E)
    w, Om, I = map(math.radians, (w, Om, I))
    x = (math.cos(w) * math.cos(Om) - math.sin(w) * math.sin(Om) * math.cos(I)) * xp + (-math.sin(w) * math.cos(Om) - math.cos(w) * math.sin(Om) * math.cos(I)) * yp
    y = (math.cos(w) * math.sin(Om) + math.sin(w) * math.cos(Om) * math.cos(I)) * xp + (-math.sin(w) * math.sin(Om) + math.cos(w) * math.cos(Om) * math.cos(I)) * yp
    z = (math.sin(w) * math.sin(I)) * xp + (math.cos(w) * math.sin(I)) * yp
    return x, y, z


def earth_mars(t: datetime) -> dict:
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    T = ((2440587.5 + t.timestamp() / 86400.0) - 2451545.0) / 36525.0
    ex, ey, ez = _pos("earth", T)
    mx, my, mz = _pos("mars", T)
    d_au = math.dist((ex, ey, ez), (mx, my, mz))
    # kąt Słońce–Ziemia–Mars: blisko 0° = koniunkcja (Słońce między planetami), łączność zerwana
    sun_angle = math.degrees(math.acos(max(-1, min(1, (-ex * (mx - ex) - ey * (my - ey) - ez * (mz - ez)) / (math.dist((0, 0, 0), (ex, ey, ez)) * d_au)))))
    return {"distanceAu": d_au, "distanceKm": d_au * AU_KM, "oneWayMin": d_au * AU_KM / C_KM_S / 60.0,
            "sunEarthMarsDeg": sun_angle, "conjunction": sun_angle < 3.0}
