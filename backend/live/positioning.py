"""Pozycjonowanie bez GPS: trilateracja z nadajników radiowych UWB w terenie + odometria (kroki/IMU).

Nadajnik jest użyteczny tylko w linii widoczności (sprawdzane na DTM). Odległości mają szum σ = 0,3 m.
Gdy widać < 3 nadajniki, pozycja pochodzi z odometrii, której błąd rośnie z przebytą drogą (2% dystansu).
Wynik: pozycja, elipsa błędu (półosie, kąt) i źródło.
"""
from __future__ import annotations

import math
import random

import numpy as np
from scipy import ndimage


class Positioner:
    def __init__(self, beacons: list[dict], dem: np.ndarray, cell: float, range_sigma: float = 0.3, beacon_mast: float = 2.0):
        self.beacons = beacons
        self.dem = dem
        self.cell = cell
        self.sigma = range_sigma
        self.mast = beacon_mast
        self.odo_err = {}

    def _h(self, x, y):
        return float(ndimage.map_coordinates(self.dem, [[y / self.cell - 0.5], [x / self.cell - 0.5]], order=1, mode="nearest")[0])

    def _los(self, a: dict, b: dict) -> bool:
        ha, hb = self._h(a["x"], a["y"]) + self.mast, self._h(b["x"], b["y"]) + 1.8
        for t in np.linspace(0.05, 0.95, 24):
            x, y = a["x"] + (b["x"] - a["x"]) * t, a["y"] + (b["y"] - a["y"]) * t
            if self._h(x, y) > ha + (hb - ha) * t:
                return False
        return True

    def estimate(self, who: str, true_xy: dict, moved_m: float) -> dict:
        vis = [b for b in self.beacons if self._los(b, true_xy)]
        if len(vis) >= 3:
            self.odo_err[who] = 0.0
            ranges = [math.hypot(b["x"] - true_xy["x"], b["y"] - true_xy["y"]) + random.gauss(0, self.sigma) for b in vis]
            p = np.array([true_xy["x"] + random.gauss(0, 1), true_xy["y"] + random.gauss(0, 1)])
            for _ in range(8):  # Gauss–Newton
                B = np.array([[b["x"], b["y"]] for b in vis])
                d = np.linalg.norm(B - p, axis=1) + 1e-9
                J = (p - B) / d[:, None]
                r = np.array(ranges) - d
                step, *_ = np.linalg.lstsq(J, r, rcond=None)
                p = p + step
            B = np.array([[b["x"], b["y"]] for b in vis])
            d = np.linalg.norm(B - p, axis=1) + 1e-9
            J = (p - B) / d[:, None]
            cov = np.linalg.inv(J.T @ J + 1e-9 * np.eye(2)) * self.sigma ** 2
            w, v = np.linalg.eigh(cov)
            return {"x": round(float(p[0]), 2), "y": round(float(p[1]), 2), "source": f"UWB ({len(vis)} nadajniki)",
                    "ellipse": {"a": round(float(2 * math.sqrt(max(w[1], 0))), 2), "b": round(float(2 * math.sqrt(max(w[0], 0))), 2),
                                "angleDeg": round(math.degrees(math.atan2(v[1, 1], v[0, 1])), 1)},
                    "beaconsVisible": [b["id"] for b in vis]}
        err = self.odo_err.get(who, 0.0) + 0.02 * moved_m
        self.odo_err[who] = err
        return {"x": round(true_xy["x"] + random.gauss(0, err / 3), 2), "y": round(true_xy["y"] + random.gauss(0, err / 3), 2),
                "source": f"odometria ({len(vis)} nadajn. w zasięgu)", "ellipse": {"a": round(2 * err, 2), "b": round(2 * err, 2), "angleDeg": 0},
                "beaconsVisible": [b["id"] for b in vis]}
