"""Sieć grzbietów boxwork z modelu wysokości HiRISE (warstwa nauki dla misji boxwork).

Boxwork to sieć niskich grzbietów (ok. 1–2 m) z zacementowanych przez wodę gruntową szczelin, między którymi
leżą zagłębienia z osadem (Siebach i Grotzinger 2014, JGR Planets 119; Curiosity, 2025). Grzbiety wykrywamy zwykłą
geometrią na modelu wysokości 1 m, bez uczenia maszynowego:

  1. detrend: DEM − filtr Gaussa (σ = 15 m) usuwa ogólne nachylenie zbocza Mount Sharp,
  2. filtr Sato (macierz Hessego, σ = 2–4 m) wzmacnia wąskie, wydłużone wyniesienia,
  3. grzbiet = najsilniejsze RIDGE_PCT % odpowiedzi filtra i co najmniej RELIEF_M ponad tło (σ = 8 m),
     bez obiektów mniejszych niż MIN_PX m²,
  4. pole boxwork = miejsca, gdzie grzbiety zajmują ≥ FIELD_SHARE okolicy o promieniu ok. 30 m
     i krzyżują się (niska spójność kierunku); równoległe grzbiety to warstwy skalne zbocza, nie boxwork.
     Pokazujemy tylko grzbiety wewnątrz pola.

Warstwa jest poglądowa i nie wpływa na zagrożenia ani planowanie trasy (te liczy build.py z nachylenia, piasku
i głazów). Uruchom po build.py:  python -m backend.pipeline.boxwork
"""

from __future__ import annotations

import hashlib
import json
import sys

import numpy as np
from scipy import ndimage
from skimage.filters import sato

from backend.paths import CACHE, MISSIONS

MISSION = "boxwork"
DETREND_M = 15.0
SIGMAS_M = (2, 3, 4)
RIDGE_PCT = 12.0  # odsetek najsilniejszych odpowiedzi filtra Sato
RELIEF_M = 0.15  # minimalne wyniesienie nad tło (σ = 8 m)
MIN_PX = 40  # najmniejszy grzbiet [m²]
FIELD_WIN_M = 61  # okno gęstości grzbietów
FIELD_SHARE = 0.12  # pole boxwork: grzbiety zajmują co najmniej tyle okolicy
COH_WIN_M = 31  # okno spójności kierunku grzbietów
MAX_COHERENCE = 0.45  # powyżej: grzbiety równoległe (warstwy skalne), nie siatka boxwork

CLASSES = {
    "1": {"color": "#F2C66D", "text": "grzbiet boxwork (zacementowana szczelina, wyniesienie z DTM)"},
    "2": {"color": "#4FB3A9", "text": "pole boxwork: gęsta sieć grzbietów (cel naukowy)"},
}


def load_dem(mdir) -> tuple[np.ndarray, float]:
    """Model wysokości 1 m z pamięci podręcznej potoku (najnowszy plik, o wymiarach okna misji);
    bez niego siatka 3 m z mission.json (mniej szczegółów)."""
    mission = json.loads((mdir / "mission.json").read_text(encoding="utf-8"))
    area, d = mission["area"], mission["dem"]
    want = (round(area["heightM"]), round(area["widthM"]))
    for hit in sorted((CACHE / MISSION).glob("dem1-*.npz"), key=lambda p: p.stat().st_mtime, reverse=True):
        dem = np.load(hit)["a"]
        if dem.shape == want:
            return dem.astype(np.float32), 1.0
    return np.fromfile(mdir / d["file"], dtype="<f4").reshape(d["height"], d["width"]), float(d["cellM"])


def classify(dem: np.ndarray, cell_m: float) -> np.ndarray:
    fill = np.where(np.isfinite(dem), dem, np.nanmean(dem)).astype(np.float32)
    det = fill - ndimage.gaussian_filter(fill, DETREND_M / cell_m)
    v = sato(det, sigmas=[s / cell_m for s in SIGMAS_M], black_ridges=False)
    rel = fill - ndimage.gaussian_filter(fill, 8.0 / cell_m)
    ridge = (v > np.percentile(v, 100 - RIDGE_PCT)) & (rel > RELIEF_M)
    lab, n = ndimage.label(ridge)
    if n:
        sizes = ndimage.sum(ridge, lab, range(1, n + 1))
        ridge = np.isin(lab, np.flatnonzero(sizes * cell_m * cell_m >= MIN_PX) + 1)
    win = max(3, int(round(FIELD_WIN_M / cell_m)) | 1)
    dense = ndimage.uniform_filter(ridge.astype(np.float32), win) >= FIELD_SHARE
    # boxwork: grzbiety krzyżują się pod różnymi kątami; warstwy skalne na zboczu biegną równolegle.
    # Spójność kierunku z tensora struktury (0 = wszystkie kierunki, 1 = jeden kierunek) liczona z pikseli grzbietów.
    gy, gx = np.gradient(ndimage.gaussian_filter(det, 2.0 / cell_m))
    w, s = ridge.astype(np.float32), COH_WIN_M / 2 / cell_m
    jxx, jyy, jxy = (ndimage.gaussian_filter(a * w, s) for a in (gx * gx, gy * gy, gx * gy))
    coherence = np.sqrt((jxx - jyy) ** 2 + 4 * jxy**2) / (jxx + jyy + 1e-9)
    field = dense & (coherence < MAX_COHERENCE)
    cls = np.zeros(dem.shape, np.uint8)
    cls[field] = 2
    cls[field & ridge] = 1
    return cls


def build() -> dict:
    from PIL import Image

    mdir = MISSIONS / MISSION
    dem, cell = load_dem(mdir)
    cls = classify(dem, cell)
    out = mdir / "boxwork.png"
    Image.fromarray(cls, "L").save(out, optimize=True)
    n = cls.size
    stats = {
        "ridgeShare": round(float((cls == 1).sum()) / n, 3),
        "fieldShare": round(float((cls > 0).sum()) / n, 3),
        "cellM": cell,
    }
    legend = [dict(c) for c in CLASSES.values()]
    legend.append({"color": "#888888", "text": f"z modelu wysokości HiRISE {cell:g} m, bez uczenia maszynowego"})
    layer = {
        "id": "boxwork",
        "name": "Boxwork",
        "desc": "grzbiety z DTM HiRISE",
        "colorOff": "#5a4a26",
        "colorOn": "#F2C66D",
        "raster": {
            "file": "boxwork.png",
            "encoding": "png-class8",
            "width": int(cls.shape[1]),
            "height": int(cls.shape[0]),
            "cellM": cell,
            "classes": CLASSES,
        },
        "legend": legend,
    }
    return {"layer": layer, "stats": stats, "cellM": cell, "sha256": hashlib.sha256(out.read_bytes()).hexdigest()}


def apply() -> int:
    res = build()
    mdir = MISSIONS / MISSION
    mission = json.loads((mdir / "mission.json").read_text(encoding="utf-8"))
    prov = json.loads((mdir / "provenance.json").read_text(encoding="utf-8"))
    layers = [x for x in mission["layers"] if x["id"] != "boxwork"]
    i = next((k + 1 for k, x in enumerate(layers) if x["id"] == "sky"), len(layers))  # po „Niebie”, przed trasą łazika
    mission["layers"] = layers[:i] + [res["layer"]] + layers[i:]
    num = lambda v: f"{v:g}".replace(".", ",")  # noqa: E731 — zapis liczb jak w pozostałych opisach (przecinek)
    prov.setdefault("methods", {})["boxwork"] = (
        f"DEM {num(res['cellM'])} m − filtr Gaussa (σ = {num(DETREND_M)} m), filtr Sato (σ = {'–'.join(map(str, SIGMAS_M))} m); "
        f"grzbiet = górne {num(RIDGE_PCT)}% odpowiedzi i wyniesienie > {num(RELIEF_M)} m (tło σ = 8 m), obiekty < {MIN_PX} m² "
        f"pominięte; pole boxwork = grzbiety ≥ {FIELD_SHARE:.0%} okna {FIELD_WIN_M} m i spójność kierunku < {num(MAX_COHERENCE)} "
        f"(okno {COH_WIN_M} m). Poglądowo: nie używane w zagrożeniach ani planowaniu. "
        "Boxwork: Siebach i Grotzinger 2014, JGR Planets 119, doi:10.1002/2013JE004508."
    )
    prov.setdefault("stats", {})["boxwork"] = res["stats"]
    prov.setdefault("outputs", {})["boxwork.png"] = res["sha256"]
    (mdir / "provenance.json").write_text(json.dumps(prov, indent=2, ensure_ascii=False), encoding="utf-8")
    (mdir / "mission.json").write_text(json.dumps(mission, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[boxwork] {res['stats']}")
    return 0


if __name__ == "__main__":
    sys.exit(apply())
