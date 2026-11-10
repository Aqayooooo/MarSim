"""Promieniowanie: tło GCR na powierzchni, zdarzenia SEP i limity NASA-STD-3001.

Tło: RAD (Curiosity) zmierzył na powierzchni w kraterze Gale średnio ok. 0,64 mSv/dobę
równoważnika dawki (Hassler i in., 2014, Science) — to ok. 27 μSv/h.
Limit: NASA-STD-3001 Vol. 1 (rev. B) — dawka efektywna w karierze 600 mSv.
"""

from __future__ import annotations

GCR_SURFACE_USV_H = 640.0 / 24.0  # ≈ 26,7 μSv/h
CAREER_LIMIT_MSV = 600.0

# Mnożnik dawki na powierzchni podczas SEP zależnie od strumienia protonów >10 MeV (przy Ziemi, pfu).
# Atmosfera Marsa (~20 g/cm²) silnie tłumi protony; przyjęte wartości są ostrożnym oszacowaniem.
SEP_LEVELS = [  # (min pfu, mnożnik, opis)
    (10_000, 30.0, "S4–S5: bardzo silna burza"),
    (1_000, 10.0, "S3: silna burza"),
    (100, 4.0, "S2: umiarkowana burza"),
    (10, 1.8, "S1: słaba burza"),
    (0, 1.0, "brak burzy"),
]


def sep_multiplier(pfu: float) -> tuple[float, str]:
    for lim, mult, desc in SEP_LEVELS:
        if pfu >= lim:
            return mult, desc
    return 1.0, "brak burzy"


def dose_rate_usv_h(pfu: float = 0.0, shielded: bool = False) -> float:
    mult, _ = sep_multiplier(pfu)
    rate = GCR_SURFACE_USV_H * mult
    return rate * (0.6 if shielded else 1.0)


def limit_status(dose_msv: float) -> dict:
    frac = dose_msv / CAREER_LIMIT_MSV
    level = "ok" if frac < 0.5 else "uwaga" if frac < 0.8 else "krytyczne"
    return {
        "doseMsv": round(dose_msv, 3),
        "limitMsv": CAREER_LIMIT_MSV,
        "fraction": round(frac, 4),
        "level": level,
        "standard": "NASA-STD-3001 Vol. 1 Rev. B, limit kariery 600 mSv",
    }
