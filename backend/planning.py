"""Planowanie tras na siatce kosztów (backend). Koszt = litry O₂ na metr marszu w skafandrze.

- Nachylenie liczone z marginesem: nachylenie + 2σ (ostrożnie).
- Strefy zakazane (piasek > 0,6, nachylenie+2σ > maks., głazy) są nieprzekraczalne.
- Strefy „uwaga” kosztują więcej (dłuższy, ostrożniejszy marsz).
Najkrótsza ścieżka: skimage.graph.MCP_Geometric (Dijkstra w C, 8 sąsiadów, długość przekątnej uwzględniona).
"""
from __future__ import annotations

import math

import numpy as np
from skimage.graph import MCP_Geometric

from backend.models.physiology import Person, metabolic_w, o2_l_per_min


def walk_speed_ms(slope_deg: np.ndarray | float, base_kmh: float) -> np.ndarray | float:
    g = np.tan(np.radians(slope_deg))
    return base_kmh / 3.6 * np.exp(-3.5 * np.abs(g)) / math.exp(0)  # bez znaku: siatka izotropowa


class CostModel:
    def __init__(self, layers: dict, cell: float, eva: dict, person: Person):
        self.cell = cell
        self.eva = eva
        slope_up = layers["slope"] + 2 * layers["slopeSigma"]
        self.slope_up = slope_up
        speed = np.maximum(walk_speed_ms(slope_up, eva["walkKmh"]), 0.15)
        sand = layers["sand"]
        terrain = np.where(sand > 0.35, "sand", np.where(layers["hazard"] == 1, "rough", "rock"))
        met = np.zeros_like(speed)
        for t in ("rock", "rough", "sand"):
            m = terrain == t
            if m.any():
                met[m] = metabolic_w(person, speed[m], np.tan(np.radians(slope_up[m])) * 100, t)
        o2_per_m = o2_l_per_min(met) / 60.0 / speed         # L O₂ na metr
        mult = np.where(layers["hazard"] == 1, 1.6, 1.0)
        self.time_per_m = (1.0 / speed) * mult              # s/m
        self.o2_per_m = o2_per_m * mult
        self.blocked = layers["hazard"] == 2
        self.metabolic = met

    def cost_array(self, kind: str = "o2", extra_blocked: np.ndarray | None = None) -> np.ndarray:
        base = (self.o2_per_m if kind == "o2" else self.time_per_m) * self.cell
        c = base.astype(np.float64).copy()
        blk = self.blocked if extra_blocked is None else (self.blocked | extra_blocked)
        c[blk] = np.inf
        return c

    def to_rc(self, p: dict) -> tuple[int, int]:
        H, W = self.blocked.shape
        return (min(H - 1, max(0, int(p["y"] // self.cell))), min(W - 1, max(0, int(p["x"] // self.cell))))

    def to_xy(self, rc) -> dict:
        return {"x": (rc[1] + 0.5) * self.cell, "y": (rc[0] + 0.5) * self.cell}


def obstacle_mask(shape, cell: float, obstacles: list[dict], buffer_m: float = 6.0) -> np.ndarray:
    H, W = shape
    m = np.zeros(shape, bool)
    if not obstacles:
        return m
    yy, xx = (np.mgrid[0:H, 0:W] + 0.5) * cell
    for o in obstacles:
        m |= np.hypot(xx - o["x"], yy - o["y"]) < o["radiusM"] + buffer_m
    return m


def _unblock(cost: np.ndarray, rc, model: CostModel):
    if not np.isfinite(cost[rc]):
        cost[rc] = model.o2_per_m[rc] * model.cell * 3


def plan(model: CostModel, start: dict, waypoints: list[dict], obstacles: list[dict] | None = None,
         layers: dict | None = None, kind: str = "o2") -> dict:
    extra = obstacle_mask(model.blocked.shape, model.cell, obstacles or [])
    cost = model.cost_array(kind, extra)
    path_rc, wp_idx, expanded = [], [], []
    prev = model.to_rc(start)
    _unblock(cost, prev, model)
    for wp in waypoints:
        goal = model.to_rc(wp)
        _unblock(cost, goal, model)
        mcp = MCP_Geometric(cost, fully_connected=True)
        cum, _ = mcp.find_costs([prev], [goal])
        if not np.isfinite(cum[goal]):
            return {"ok": False, "error": f"Brak bezpiecznego przejścia do {wp['id']}"}
        leg = mcp.traceback(goal)
        # „przeszukane” komórki do animacji: siatka co 10 komórek, w kolejności kosztu, tańsze niż cel
        sub = cum[::10, ::10]
        rr, cc = np.nonzero(np.isfinite(sub) & (sub <= cum[goal]))
        order = np.argsort(sub[rr, cc])
        expanded += [model.to_xy((r * 10, c * 10)) for r, c in zip(rr[order], cc[order])]
        if path_rc:
            leg = leg[1:]
        path_rc += leg
        wp_idx.append(len(path_rc) - 1)
        prev = goal
    pts = [model.to_xy(rc) for rc in path_rc]
    pts[0] = {"x": start["x"], "y": start["y"]}
    for i, wp in zip(wp_idx, waypoints):
        pts[i] = {"x": wp["x"], "y": wp["y"]}
    pts, wp_idx = _simplify(pts, wp_idx)
    stats = path_stats(model, pts, layers)
    stops = len(waypoints)
    stop_min = sum(w.get("stopMin", 0) for w in waypoints)
    return {"ok": True, "path": pts, "waypointIndex": wp_idx, "lengthM": stats["lengthM"],
            "durationH": stats["walkH"] + stop_min / 60, "o2L": stats["o2L"], "stops": stops,
            "rating": stats["rating"], "uncertainty": stats["uncertainty"], "expanded": expanded[:600]}


def _simplify(pts, wp_idx, tol=1.5):
    """Usuwa punkty współliniowe (siatka daje schodki), zachowując punkty WP."""
    keep = set(wp_idx) | {0, len(pts) - 1}
    out, new_idx, last = [], {}, None
    for i, p in enumerate(pts):
        if i in keep or i == 0:
            new_idx[i] = len(out); out.append(p); last = i; continue
        a, b = pts[last], pts[i + 1] if i + 1 < len(pts) else p
        ax, ay, bx, by = a["x"], a["y"], b["x"], b["y"]
        d = abs((bx - ax) * (ay - p["y"]) - (ax - p["x"]) * (by - ay)) / (math.hypot(bx - ax, by - ay) + 1e-9)
        if d > tol:
            new_idx[i] = len(out); out.append(p); last = i
    return out, [new_idx[i] for i in wp_idx]


def path_stats(model: CostModel, pts: list[dict], layers: dict | None) -> dict:
    L = walk_s = o2 = 0.0
    max_slope, max_sigma, max_sand, min_conf = 0.0, 0.0, 0.0, 1.0
    caution_m = 0.0
    for a, b in zip(pts[:-1], pts[1:]):
        d = math.hypot(b["x"] - a["x"], b["y"] - a["y"])
        n = max(1, int(d // model.cell))
        for k in range(n):
            t = (k + 0.5) / n
            rc = model.to_rc({"x": a["x"] + (b["x"] - a["x"]) * t, "y": a["y"] + (b["y"] - a["y"]) * t})
            seg = d / n
            L += seg; walk_s += model.time_per_m[rc] * seg; o2 += model.o2_per_m[rc] * seg
            if layers is not None:
                if layers["slope"][rc] > max_slope:
                    max_slope, max_sigma = float(layers["slope"][rc]), float(layers["slopeSigma"][rc])
                max_sand = max(max_sand, float(layers["sand"][rc]))
                min_conf = min(min_conf, float(layers["sandConfidence"][rc]))
                if layers["hazard"][rc] == 1:
                    caution_m += seg
    rating = "bezpieczna" if caution_m < 0.1 * max(L, 1) else "bezpieczna z uwagami"
    unc = {"maxSlopeDeg": round(max_slope, 1), "maxSlopeSigmaDeg": round(max_sigma, 1),
           "maxSandProb": round(max_sand, 2), "minSandConfidence": round(min_conf, 2), "cautionM": round(caution_m)}
    return {"lengthM": L, "walkH": walk_s / 3600, "o2L": o2, "rating": rating, "uncertainty": unc}


def cost_field(model: CostModel, origin: dict, kind: str = "o2") -> np.ndarray:
    """Koszt (L O₂ albo s) dojścia z każdej komórki do punktu origin (np. habitatu)."""
    cost = model.cost_array(kind)
    rc = model.to_rc(origin)
    _unblock(cost, rc, model)
    mcp = MCP_Geometric(cost, fully_connected=True)
    cum, _ = mcp.find_costs([rc])
    return cum.astype(np.float32)
