"""Łączność radiowa (linia widoczności), oświetlenie i cienie terenu, temperatura powierzchni."""
from __future__ import annotations

import math

import numpy as np
from scipy import ndimage

SIGMA_SB = 5.670374e-8
SOL_S = 88775.244


def _sample(dem: np.ndarray, rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    return ndimage.map_coordinates(dem, [rows, cols], order=1, mode="nearest")


def viewshed(dem: np.ndarray, cell: float, src_xy: tuple[float, float], src_height: float, rx_height: float = 1.8,
             steps: int = 160) -> np.ndarray:
    """Maska linii widoczności z anteny (x, y w metrach lokalnych) do odbiornika na wysokości rx_height nad gruntem.
    Zwraca zapas wysokości nad przeszkodą (m): > 0 — widoczność, < 0 — teren zasłania."""
    H, W = dem.shape
    sr, sc = src_xy[1] / cell - 0.5, src_xy[0] / cell - 0.5
    h0 = _sample(dem, np.array([sr]), np.array([sc]))[0] + src_height
    rr, cc = np.mgrid[0:H, 0:W].astype(np.float32)
    h1 = dem + rx_height
    clearance = np.full((H, W), np.inf, np.float32)
    for t in np.linspace(0.02, 0.98, steps):
        r = sr + (rr - sr) * t; c = sc + (cc - sc) * t
        line = h0 + (h1 - h0) * t
        terr = _sample(dem, r.ravel(), c.ravel()).reshape(H, W)
        clearance = np.minimum(clearance, line - terr)
    return clearance


def shadow_mask(dem: np.ndarray, cell: float, sun_elev: float, sun_az: float, max_dist: float = 1200.0) -> np.ndarray:
    """True = cień (Słońce pod lokalnym horyzontem albo stok odwrócony od Słońca)."""
    H, W = dem.shape
    if sun_elev <= 0:
        return np.ones((H, W), bool)
    az = math.radians(sun_az)
    dx, dy = math.sin(az), -math.cos(az)            # kierunek do Słońca w (x, y lokalnym)
    tan_e = math.tan(math.radians(sun_elev))
    rr, cc = np.mgrid[0:H, 0:W].astype(np.float32)
    shade = np.zeros((H, W), bool)
    dist = cell
    while dist < max_dist:
        r = rr + dy * dist / cell; c = cc + dx * dist / cell
        inside = (r >= 0) & (r <= H - 1) & (c >= 0) & (c <= W - 1)
        if not inside.any():
            break
        terr = _sample(dem, r.ravel(), c.ravel()).reshape(H, W)
        shade |= inside & (terr > dem + dist * tan_e)
        dist += cell if dist < 60 else cell * 3
    gy, gx = np.gradient(dem, cell)
    nz = 1 / np.sqrt(1 + gx * gx + gy * gy)
    # normalna (−gx, gy, 1)/|n| w układzie (x wsch., y płn., z); y lokalne rośnie na południe → gy_north = −gy
    sun = np.array([math.cos(math.radians(sun_elev)) * dx, -math.cos(math.radians(sun_elev)) * dy, math.sin(math.radians(sun_elev))])
    cos_i = (-gx * sun[0] + gy * sun[1] + sun[2]) * nz
    return shade | (cos_i <= 0)


def surface_temperature(ltst_h: float, lat_deg: float, decl_deg: float, flux_top: float, albedo: float,
                        thermal_inertia: float, tau_dust: float = 0.5, slope_cos: float = 1.0, emissivity: float = 0.95) -> float:
    """Temperatura powierzchni [K] — rozwiązanie harmoniczne (1. harmoniczna) równania przewodzenia dla półprzestrzeni
    z linearyzowanym promieniowaniem i stałym strumieniem zwrotnym atmosfery. Uproszczenie do planowania, nie do nauki."""
    phi, d = math.radians(lat_deg), math.radians(decl_deg)
    trans = math.exp(-tau_dust / max(0.2, math.cos(phi - d)))
    # średnia dobowa i 1. harmoniczna nasłonecznienia poziomej powierzchni
    hs = math.acos(max(-1.0, min(1.0, -math.tan(phi) * math.tan(d))))
    mean_cos = (hs * math.sin(phi) * math.sin(d) + math.cos(phi) * math.cos(d) * math.sin(hs)) / math.pi
    c1 = (2 / math.pi) * (math.cos(phi) * math.cos(d) * (hs / 2 + math.sin(2 * hs) / 4) + math.sin(phi) * math.sin(d) * math.sin(hs))
    absorbed_mean = (1 - albedo) * flux_top * trans * mean_cos * slope_cos
    absorbed_1 = (1 - albedo) * flux_top * trans * c1 * slope_cos
    atm = 0.04 * flux_top * mean_cos + 15.0           # promieniowanie zwrotne atmosfery i pyłu (szacunek)
    T0 = ((absorbed_mean + atm) / (emissivity * SIGMA_SB)) ** 0.25
    omega = 2 * math.pi / SOL_S
    lin = 4 * emissivity * SIGMA_SB * T0 ** 3
    cond = thermal_inertia * math.sqrt(omega)
    Z = complex(lin + cond / math.sqrt(2), cond / math.sqrt(2))
    amp = absorbed_1 / abs(Z)
    lag = math.atan2(Z.imag, Z.real)
    T = T0 + amp * math.cos(2 * math.pi * (ltst_h - 12.0) / 24.0 - lag)
    return T
