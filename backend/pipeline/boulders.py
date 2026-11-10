"""Wykrywanie głazów metodą cieni (bez AI), jak przy ocenie miejsc lądowania (Golombek i in. 2008, 2012).

Na zdjęciu HiRISE głaz to jasna plamka z ciemnym cieniem po stronie przeciwnej do Słońca.
1. Tło jasności: rozmycie Gaussa; cień = piksele wyraźnie ciemniejsze od tła (próg względem lokalnego szumu).
2. Segmentacja cieni na spójne obszary; odrzucenie zbyt małych i zbyt dużych.
3. Weryfikacja: po stronie Słońca od cienia powinna być oświetlona (jaśniejsza) ściana głazu.
4. Wymiary: długość cienia L wzdłuż kierunku światła → wysokość H = L · tan(wysokość Słońca);
   średnica D ≈ szerokość cienia prostopadle do kierunku światła.
Ograniczenie: wykrywalne od ok. 1–1,5 m średnicy (4–6 pikseli przy 0,25 m/px).
"""

from __future__ import annotations

import math

import numpy as np
from scipy import ndimage


def detect(
    img: np.ndarray,
    px_m: float,
    sun_az_deg: float,
    sun_elev_deg: float,
    exclude: np.ndarray | None = None,
    k: float = 2.6,
    min_d_m: float = 1.0,
    max_d_m: float = 8.0,
) -> list[dict]:
    """img: zdjęcie w siatce obszaru (x na wschód, y na południe); sun_az od północy zgodnie z ruchem wskazówek.
    exclude: maska (True = pomiń, np. piasek), w tej samej siatce co img."""
    I = np.nan_to_num(img.astype(np.float32), nan=float(np.nanmedian(img)))
    bg = ndimage.gaussian_filter(I, 10)
    resid = I - bg
    noise = np.sqrt(ndimage.gaussian_filter(resid * resid, 25)) + 1e-6
    shadow = resid < -k * noise
    if exclude is not None:
        shadow &= ~exclude
    shadow = ndimage.binary_opening(shadow, iterations=1)
    lab, n = ndimage.label(shadow)
    if n == 0:
        return []
    objs = ndimage.find_objects(lab)
    sh_az = math.radians((sun_az_deg + 180.0) % 360.0)
    d = np.array([math.sin(sh_az), -math.cos(sh_az)])  # kierunek cienia w (x, y obrazu)
    p = np.array([-d[1], d[0]])  # prostopadły
    tan_e = math.tan(math.radians(sun_elev_deg))
    out = []
    min_px, max_px = (min_d_m / px_m) ** 2 * 0.3, (max_d_m / px_m) ** 2 * 2
    for i, sl in enumerate(objs, start=1):
        if sl is None:
            continue
        m = lab[sl] == i
        area = int(m.sum())
        if area < max(3, min_px) or area > max_px:
            continue
        ys, xs = np.nonzero(m)
        xs = xs + sl[1].start
        ys = ys + sl[0].start
        proj_d = xs * d[0] + ys * d[1]
        proj_p = xs * p[0] + ys * p[1]
        L = (proj_d.max() - proj_d.min() + 1) * px_m
        D = (proj_p.max() - proj_p.min() + 1) * px_m
        if min_d_m > D or max_d_m < D:
            continue
        cx, cy = xs.mean(), ys.mean()
        # oświetlona ściana: próbka po stronie Słońca od cienia
        off = (proj_d.max() - proj_d.min()) / 2 + D / px_m / 2
        sx, sy = int(round(cx - d[0] * off)), int(round(cy - d[1] * off))
        lit = 0.0
        if 1 <= sy < I.shape[0] - 1 and 1 <= sx < I.shape[1] - 1:
            lit = float((I[sy - 1 : sy + 2, sx - 1 : sx + 2].mean() - bg[sy, sx]) / noise[sy, sx])
        depth = float(-resid[ys, xs].mean() / noise[ys, xs].mean())
        # zwartość: cień głazu jest krótki i zwarty; długi, wąski cień to zwykle krawędź półki skalnej
        aspect = max(L, D) / max(min(L, D), px_m)
        fill = area * px_m * px_m / max(L * D, 1e-6)
        compact = float(np.clip((3.0 - aspect) / 2.0, 0, 1) * np.clip(fill / 0.5, 0, 1))
        conf = float(np.clip(0.1 + 0.08 * np.clip(depth - k, 0, 3) + 0.4 * np.clip(lit / 2.0, 0, 1) + 0.3 * compact, 0, 1))
        # środek głazu: od środka cienia o pół średnicy w stronę Słońca
        bx, by = cx - d[0] * (D / px_m) / 2, cy - d[1] * (D / px_m) / 2
        out.append(
            {
                "x": round(bx * px_m, 2),
                "y": round(by * px_m, 2),
                "diameterM": round(D, 2),
                "heightM": round(L * tan_e, 2),
                "shadowM": round(L, 2),
                "confidence": round(conf, 2),
            }
        )
    out.sort(key=lambda b: -b["diameterM"])
    return out


def density_raster(boulders: list[dict], width_m: float, height_m: float, cell_m: float, min_conf: float = 0.5) -> np.ndarray:
    """Liczba głazów na 100 m² w komórkach siatki (wygładzona)."""
    H, W = int(round(height_m / cell_m)), int(round(width_m / cell_m))
    g = np.zeros((H, W), np.float32)
    for b in boulders:
        if b["confidence"] < min_conf:
            continue
        i, j = int(b["y"] // cell_m), int(b["x"] // cell_m)
        if 0 <= i < H and 0 <= j < W:
            g[i, j] += 1
    g = ndimage.gaussian_filter(g, 10 / cell_m) * (100 / (cell_m * cell_m))
    return g
