"""Minerały z CRISM (MRO): klasy z parametrów sumarycznych produktu MTRDR (plik *_SU*_MTR3, 18 m/px).

Parametry według Viviano-Beck i in. (2014), JGR Planets 119, „Revised CRISM spectral parameters and summary products”:
- OLINDEX3   — oliwin (pasmo ~1 μm),
- LCPINDEX2 / HCPINDEX2 — piroksen nisko- i wysokowapniowy,
- BD1900_2   — woda związana w minerałach (uwodnienie),
- SINDEX2, BD2100_2 — siarczany / minerały uwodnione,
- D2300      — krzemiany warstwowe Fe/Mg.

Progi są zachowawcze (szum CRISM przy 18 m/px to ok. 0,005–0,01). Warstwa jest informacyjna: NIE wpływa na mapę
zagrożeń ani na trasę (piasek wykrywamy osobno, z 5 niezależnych wskaźników). Na wydmach Bagnold oczekiwany jest
piasek bazaltowy bogaty w oliwin (Lapotre i in. 2017), a na dnie krateru Jezero skały bogate w oliwin (formacja Séítah,
Liu i in. 2022), więc OLINDEX3 jest w obu obszarach głównym sygnałem.
"""
from __future__ import annotations

import numpy as np
import rasterio
from rasterio.enums import Resampling

from backend.pipeline.grid import Grid, read_into

PARAMS = ["OLINDEX3", "LCPINDEX2", "HCPINDEX2", "BD1900_2", "SINDEX2", "BD2100_2", "D2300"]

# klasa: (warunek opisany w provenance, kolor, opis PL)
CLASSES = {
    1: {"color": "#7CC36E", "text": "oliwin wyraźny (bazalt lub piasek bazaltowy)", "rule": "OLINDEX3 > 0,08"},
    2: {"color": "#3E7A4B", "text": "oliwin słaby / materiał mieszany", "rule": "0,05 < OLINDEX3 ≤ 0,08"},
    3: {"color": "#C9A3FF", "text": "piroksen", "rule": "max(LCPINDEX2, HCPINDEX2) > 0,01"},
    4: {"color": "#31D7B6", "text": "uwodnienie / siarczany (słaby sygnał)", "rule": "BD1900_2 > 0,005 lub SINDEX2 > 0,02 lub BD2100_2 > 0,02"},
    5: {"color": "#4FA3FF", "text": "krzemiany warstwowe Fe/Mg", "rule": "D2300 > 0,01"},
}


def read_params(grid18: Grid, img_path: str) -> dict[str, np.ndarray]:
    with rasterio.open(img_path, driver="ENVI") as ds:
        names = list(ds.descriptions)
    out = {}
    for p in PARAMS:
        a = read_into(grid18, img_path, band=names.index(p) + 1, resampling=Resampling.average, driver="ENVI", src_nodata=65535.0)
        a[(a > 6e4) | (a < -1e3)] = np.nan
        out[p] = a
    return out


def classify(p: dict[str, np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
    """Zwraca (klasy uint8, pewność 0–1). Kolejność: silniejsze i rzadsze sygnały nadpisują słabsze."""
    ol = p["OLINDEX3"]
    cls = np.zeros(ol.shape, np.uint8)
    conf = np.zeros(ol.shape, np.float32)
    nan = lambda a: np.nan_to_num(a, nan=-1.0)  # noqa: E731
    cls[nan(ol) > 0.05] = 2
    cls[nan(ol) > 0.08] = 1
    pyx = np.fmax(nan(p["LCPINDEX2"]), nan(p["HCPINDEX2"]))
    cls[pyx > 0.01] = 3
    hyd = (nan(p["BD1900_2"]) > 0.005) | (nan(p["SINDEX2"]) > 0.02) | (nan(p["BD2100_2"]) > 0.02)
    cls[hyd] = 4
    cls[nan(p["D2300"]) > 0.01] = 5
    # pewność: o ile wartość przekracza próg, w jednostkach szumu (≈0,01)
    conf = np.where(cls == 1, (ol - 0.08) / 0.03, conf)
    conf = np.where(cls == 2, (ol - 0.05) / 0.03, conf)
    conf = np.where(cls == 3, (pyx - 0.01) / 0.01, conf)
    conf = np.where(cls == 4, 0.3, conf)
    conf = np.where(cls == 5, (nan(p["D2300"]) - 0.01) / 0.01, conf)
    cls[~np.isfinite(ol)] = 0
    return cls, np.clip(np.nan_to_num(conf, nan=0.0), 0, 1).astype(np.float32)


def stats(cls: np.ndarray, p: dict[str, np.ndarray]) -> dict:
    n = cls.size
    return {"coverage": round(float(np.isfinite(p["OLINDEX3"]).mean()), 3),
            "fractions": {str(k): round(float((cls == k).mean()), 3) for k in CLASSES if (cls == k).any()},
            "olindex3Median": round(float(np.nanmedian(p["OLINDEX3"])), 4),
            "pixels": int(n)}
