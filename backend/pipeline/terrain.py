"""Teren z DTM HiRISE: nachylenie z marginesem błędu i nierówności.

Dokładność pionowa DTM (expected precision, EP) ze stereo: EP = ρ · GSD / (p/h)
  ρ   — dokładność dopasowania obrazów (ok. 0,2 piksela, Kirk i in. 2008),
  GSD — rozdzielczość zdjęć źródłowych (m/px),
  p/h — stosunek paralaksy do wysokości z kątów emisji obu zdjęć: tan(e1) + tan(e2) (zdjęcia z przeciwnych stron)
        albo |tan(e1) − tan(e2)| (z tej samej strony). Bez wiedzy o stronie bierzemy wariant ostrożny (mniejsze p/h).
Rzeczywiste błędy DTM są skorelowane i większe na stokach — dlatego przyjmujemy σz = max(EP, σz_min).

Niepewność nachylenia z różnic centralnych na bazie d: σ_g = σz / (√2 · d), σ_nachylenia = σ_g / (1 + g²).
"""

from __future__ import annotations

import math

import numpy as np
from scipy import ndimage


def expected_precision(gsd_m: float, emission1_deg: float, emission2_deg: float, rho_px: float = 0.2) -> dict:
    t1, t2 = math.tan(math.radians(emission1_deg)), math.tan(math.radians(emission2_deg))
    ph_opposite, ph_same = t1 + t2, abs(t1 - t2)
    ph = ph_same if ph_same > 0.1 else ph_opposite  # ostrożnie: mniejsza baza stereo, o ile sensowna
    return {"rhoPx": rho_px, "gsdM": gsd_m, "parallaxHeightRatio": round(ph, 3), "epM": round(rho_px * gsd_m / ph, 3)}


def fill_nan(a: np.ndarray) -> np.ndarray:
    m = np.isnan(a)
    if not m.any():
        return a
    idx = ndimage.distance_transform_edt(m, return_distances=False, return_indices=True)
    return a[tuple(idx)]


def slope_with_sigma(dem: np.ndarray, cell: float, sigma_z: float) -> tuple[np.ndarray, np.ndarray]:
    gy, gx = np.gradient(dem, cell)
    g = np.hypot(gx, gy)
    slope = np.degrees(np.arctan(g))
    sigma_g = sigma_z / (math.sqrt(2) * cell)
    sigma = np.degrees(sigma_g / (1 + g * g))
    return slope.astype(np.float32), sigma.astype(np.float32)


def roughness(dem_1m: np.ndarray, window_m: float = 9.0) -> np.ndarray:
    """Odchylenie standardowe wysokości po odjęciu wygładzonej powierzchni (m)."""
    smooth = ndimage.gaussian_filter(dem_1m, window_m / 3)
    resid = dem_1m - smooth
    return np.sqrt(ndimage.gaussian_filter(resid * resid, window_m / 3)).astype(np.float32)
