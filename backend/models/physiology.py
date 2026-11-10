"""Wysiłek i zużycie tlenu w skafandrze.

Wydatek energii: równanie Pandolfa (Pandolf i in., 1977) dla marszu z obciążeniem:
    M = 1.5·W + 2.0·(W+L)·(L/W)² + η·(W+L)·(1.5·V² + 0.35·V·G)
W — masa ciała [kg], L — masa skafandra i sprzętu [kg], V — prędkość [m/s], G — nachylenie [%], η — współczynnik podłoża.
Człony zależne od ciężaru skalujemy grawitacją Marsa (0,38 g); stały koszt pracy w skafandrze (zginanie
ciśnieniowego skafandra) dodaje `suit_overhead_w`. Współczynnik `calibration` dopasowuje wynik do średnich
wartości zmierzonych w EVA Apollo (ok. 230–300 W). Po podłączeniu prawdziwego skafandra zastępuje go telemetria.

Tlen: 1 litr O₂ (warunki normalne) ≈ 20,1 kJ wydatku energii.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

G_MARS = 0.3794
KJ_PER_L_O2 = 20.1

TERRAIN_ETA = {"rock": 1.1, "rough": 1.5, "sand": 2.1}


@dataclass
class Person:
    id: str
    body_kg: float
    load_kg: float  # skafander + plecak (PLSS) + narzędzia
    o2_capacity_l: float  # zapas tlenu w skafandrze (litry, warunki normalne)
    o2_l: float  # bieżący zapas
    leak_l_min: float = 0.02
    calibration: float = 0.55
    suit_overhead_w: float = 60.0
    battery_wh: float = 1000.0
    battery_left_wh: float = 1000.0
    co2_capacity_l: float = 950.0  # pojemność pochłaniacza CO₂ (litry CO₂)
    co2_absorbed_l: float = 0.0
    dose_msv: float = 0.0  # dawka skumulowana w karierze (mSv)


def metabolic_w(p: Person, speed_ms: float, grade_pct: float, terrain: str = "rock") -> float:
    W, L, V, G = p.body_kg, p.load_kg, np.maximum(0.0, speed_ms), grade_pct
    eta = TERRAIN_ETA.get(terrain, 1.2)
    base = 1.5 * W
    load = 2.0 * (W + L) * (L / W) ** 2 * G_MARS
    move = eta * (W + L) * (1.5 * V * V + 0.35 * V * G) * G_MARS
    # zejście w dół: Pandolf przeszacowuje oszczędność — ograniczamy człon do zera
    return p.calibration * (base + load + np.maximum(0.0, move)) + p.suit_overhead_w


def o2_l_per_min(metabolic: float) -> float:
    return metabolic * 60.0 / (KJ_PER_L_O2 * 1000.0)


def co2_l_per_min(metabolic: float, rq: float = 0.85) -> float:
    return o2_l_per_min(metabolic) * rq


def heart_rate(metabolic: float, rest_hr: float = 65.0) -> float:
    # przybliżona zależność liniowa tętna od wydatku energii dla dorosłego (ok. 1 ud./min na 4,5 W ponad spoczynek)
    return rest_hr + np.maximum(0.0, metabolic - 110.0) / 4.5


def endurance_h(p: Person, metabolic: float, reserve_frac: float) -> float:
    """Ile godzin do osiągnięcia rezerwy tlenu przy danym wysiłku."""
    usable = p.o2_l - reserve_frac * p.o2_capacity_l
    rate = o2_l_per_min(metabolic) + p.leak_l_min
    return max(0.0, usable / rate / 60.0)
