"""Wykrywanie luźnego piasku bez AI — zestawienie niezależnych wskaźników (każdy 0–1, 1 = piasek).

1. Ciemność: piasek bazaltowy (np. wydmy Bagnold) jest wyraźnie ciemniejszy od skały na zdjęciu HiRISE.
2. Gładkość zdjęcia: brak bloków i spękań — małe lokalne odchylenie jasności.
3. Zmarszczki: falisty, ukierunkowany wzór o długości fali 2,5–15 m — udział mocy widma w tym paśmie
   i anizotropia (zmarszczki mają jeden dominujący kierunek), w oknach 32 m (analiza Fouriera).
4. Niska bezwładność termiczna: chłodne nocą miejsca na mozaice THEMIS w podczerwieni nocnej (100 m/px).
5. Małe nierówności w DTM.
Wynik: prawdopodobieństwo piasku (średnia ważona dostępnych wskaźników) i pewność (zgodność wskaźników).
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage


def _robust01(a: np.ndarray, lo_p=5, hi_p=95) -> np.ndarray:
    lo, hi = np.nanpercentile(a, [lo_p, hi_p])
    return np.clip((a - lo) / (hi - lo + 1e-9), 0, 1)


def _soft_below(a: np.ndarray, threshold: float, width: float) -> np.ndarray:
    return 1.0 / (1.0 + np.exp((a - threshold) / max(width, 1e-6)))


def otsu(a: np.ndarray) -> float:
    v = a[np.isfinite(a)].ravel()
    hist, edges = np.histogram(v, bins=256)
    c = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(hist)
    w1 = w0[-1] - w0
    m0 = np.cumsum(hist * c) / np.maximum(w0, 1)
    m1 = (np.sum(hist * c) - np.cumsum(hist * c)) / np.maximum(w1, 1)
    return float(c[np.argmax(w0 * w1 * (m0 - m1) ** 2)])


def darkness(img_1m: np.ndarray) -> np.ndarray:
    s = ndimage.gaussian_filter(np.nan_to_num(img_1m, nan=np.nanmedian(img_1m)), 3)
    t = otsu(s)
    spread = np.nanstd(s) * 0.25
    return _soft_below(s, t, spread).astype(np.float32)


def image_smoothness(img_1m: np.ndarray) -> np.ndarray:
    s = np.nan_to_num(img_1m, nan=np.nanmedian(img_1m))
    m = ndimage.uniform_filter(s, 9)
    sd = np.sqrt(np.maximum(ndimage.uniform_filter(s * s, 9) - m * m, 0))
    rel = sd / (m + 1e-6)
    return (1 - _robust01(rel)).astype(np.float32)


def ripple_score(
    img: np.ndarray, px_m: float, win_m: float = 32.0, step_m: float = 8.0, band_m: tuple[float, float] = (2.5, 15.0)
) -> np.ndarray:
    """Udział mocy widma w paśmie zmarszczek × anizotropia, liczony w oknach i interpolowany do pełnej siatki."""
    img = np.nan_to_num(img, nan=np.nanmedian(img)).astype(np.float32)
    n = int(round(win_m / px_m))
    n += n % 2
    step = max(1, int(round(step_m / px_m)))
    H, W = img.shape
    fy = np.fft.fftfreq(n, d=px_m)[:, None]
    fx = np.fft.fftfreq(n, d=px_m)[None, :]
    f = np.hypot(fx, fy)
    band = (f >= 1 / band_m[1]) & (f <= 1 / band_m[0])
    ang = np.arctan2(fy, fx) * 2  # orientacja (podwojony kąt — wektor nieskierowany)
    win = np.outer(np.hanning(n), np.hanning(n)).astype(np.float32)
    rows = list(range(0, max(1, H - n + 1), step))
    cols = list(range(0, max(1, W - n + 1), step))
    out = np.zeros((len(rows), len(cols)), np.float32)
    for i, r in enumerate(rows):
        for j, c in enumerate(cols):
            p = img[r : r + n, c : c + n]
            p = (p - p.mean()) * win
            P = np.abs(np.fft.fft2(p)) ** 2
            P[0, 0] = 0
            tot = P.sum() + 1e-9
            pb = P[band]
            frac = pb.sum() / tot
            aniso = np.abs((pb * np.exp(1j * ang[band])).sum()) / (pb.sum() + 1e-9)
            out[i, j] = frac * (0.4 + 0.6 * aniso)
    out = _robust01(out, 10, 95)
    zoom = (H / out.shape[0], W / out.shape[1])
    return np.clip(ndimage.zoom(out, zoom, order=1)[:H, :W], 0, 1).astype(np.float32)


def thermal_score(night_ir: np.ndarray) -> np.ndarray:
    """Chłodniej nocą = mniejsza bezwładność termiczna = luźniejszy materiał (wynik względny w obrębie obszaru)."""
    if night_ir is None or not np.isfinite(night_ir).any():
        return None
    v = night_ir.copy()
    v[v <= 0] = np.nan
    if np.nanstd(v) < 1e-3:
        return None
    return (1 - _robust01(v, 10, 90)).astype(np.float32)


def dtm_smoothness(rough_m: np.ndarray) -> np.ndarray:
    return _soft_below(rough_m, 0.25, 0.08).astype(np.float32)


WEIGHTS = {"darkness": 0.35, "ripples": 0.25, "thermal": 0.2, "imageSmooth": 0.1, "dtmSmooth": 0.1}


def combine(indicators: dict[str, np.ndarray | None]) -> tuple[np.ndarray, np.ndarray, dict]:
    used = {k: v for k, v in indicators.items() if v is not None}
    wsum = sum(WEIGHTS[k] for k in used)
    prob = sum(WEIGHTS[k] * v for k, v in used.items()) / wsum
    stack = np.stack(list(used.values()))
    agreement = 1 - np.clip(np.std(stack, axis=0) * 2, 0, 1)
    coverage = wsum / sum(WEIGHTS.values())
    confidence = agreement * (0.5 + 0.5 * coverage)
    return prob.astype(np.float32), confidence.astype(np.float32), {k: WEIGHTS[k] for k in used}
