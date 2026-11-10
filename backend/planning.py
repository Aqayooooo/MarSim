"""Planowanie tras na siatce kosztów. Koszt przejścia to litry O₂ na metr marszu w skafandrze.

Zasady:
- nachylenie liczone ostrożnie: nachylenie + 2σ;
- strefy zakazane (piasek > 0,6, nachylenie + 2σ > maks., głazy, zgłoszone przeszkody) są nieprzekraczalne,
  także „po przekątnej” między dwoma zakazanymi polami;
- strefy „uwaga” kosztują 1,6 raza więcej (wolniejszy, ostrożniejszy marsz).

Algorytm: Dijkstra (scipy.sparse.csgraph) na grafie 8 sąsiadów. Waga krawędzi to średni koszt obu pól razy długość
kroku. Łamana z siatki jest potem prostowana: odcinek zastępuje jej fragment tylko wtedy, gdy nie wchodzi w strefę
zakazaną i nie kosztuje więcej niż ten fragment.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from backend.models.physiology import Person, metabolic_w, o2_l_per_min

CAUTION_FACTOR = 1.6  # mnożnik kosztu i czasu w strefie „uwaga”
SAND_TERRAIN_THRESHOLD = 0.35  # od tego prawdopodobieństwa piasku podłoże liczymy jak piasek (i strefa „uwaga”)
SAND_FORBIDDEN_THRESHOLD = 0.6  # od tego prawdopodobieństwa piasek jest strefą zakazaną
SLOPE_SIGMA_MARGIN = 2.0  # nachylenie liczone ostrożnie: wartość + tyle odchyleń standardowych
MIN_SPEED_MS = 0.15
OBSTACLE_BUFFER_M = 6.0  # zapas wokół zgłoszonej przeszkody
UNREACHABLE = 9999.0  # wartość pola kosztu tam, dokąd nie da się dojść
EXPANDED_STRIDE = 10  # co która komórka trafia do animacji „przeszukiwania”
EXPANDED_LIMIT = 600
STRAIGHTEN_LOOKAHEAD = 80  # ile wierzchołków naprzód sprawdza prostowanie trasy
_GRAPH_CACHE_SIZE = 4


def walk_speed_ms(slope_deg: np.ndarray | float, base_kmh: float) -> np.ndarray | float:
    """Prędkość marszu maleje wykładniczo z nachyleniem. Bez znaku nachylenia: siatka jest izotropowa."""
    grade = np.tan(np.radians(slope_deg))
    return base_kmh / 3.6 * np.exp(-3.5 * np.abs(grade))


def resting_o2_l_min(person: Person) -> float:
    """Zużycie tlenu na postoju (wysiłek spoczynkowy + nieszczelność skafandra), L/min."""
    return float(o2_l_per_min(metabolic_w(person, 0, 0))) + person.leak_l_min


class CostModel:
    """Koszt marszu w każdej komórce siatki dla jednej osoby i jednej mapy zagrożeń."""

    def __init__(self, layers: dict, cell: float, eva: dict, person: Person):
        self.person = person
        self.cell = cell
        self.eva = eva
        hazard = layers["hazard"]
        self.slope_up = layers["slope"] + SLOPE_SIGMA_MARGIN * layers["slopeSigma"]
        speed = np.maximum(walk_speed_ms(self.slope_up, eva["walkKmh"]), MIN_SPEED_MS)
        terrain = np.where(layers["sand"] > SAND_TERRAIN_THRESHOLD, "sand", np.where(hazard == 1, "rough", "rock"))
        grade_pct = np.tan(np.radians(self.slope_up)) * 100
        metabolic = np.zeros_like(speed)
        for kind in ("rock", "rough", "sand"):
            mask = terrain == kind
            if mask.any():
                metabolic[mask] = metabolic_w(person, speed[mask], grade_pct[mask], kind)
        factor = np.where(hazard == 1, CAUTION_FACTOR, 1.0)
        self.metabolic = metabolic
        self.time_per_m = factor / speed  # s/m
        self.o2_per_m = o2_l_per_min(metabolic) / 60.0 / speed * factor  # L/m
        self.blocked = hazard == 2
        self.caution = hazard == 1
        self._searches: dict[tuple, _Search] = {}

    def per_metre(self, kind: str) -> np.ndarray:
        """kind: "o2" (litry tlenu), "time" (sekundy), "dist" (metry — najkrótsza droga bez względu na wysiłek)."""
        if kind == "dist":
            return np.ones_like(self.time_per_m)
        return {"o2": self.o2_per_m, "time": self.time_per_m}[kind]

    def cost_array(self, kind: str = "o2", extra_blocked: np.ndarray | None = None) -> np.ndarray:
        """Koszt przejścia jednej komórki; pola nieprzekraczalne mają koszt nieskończony."""
        cost = (self.per_metre(kind) * self.cell).astype(np.float64)
        cost[self.blocked if extra_blocked is None else (self.blocked | extra_blocked)] = np.inf
        return cost

    def to_rc(self, p: dict) -> tuple[int, int]:
        rows, cols = self.blocked.shape
        return min(rows - 1, max(0, int(p["y"] // self.cell))), min(cols - 1, max(0, int(p["x"] // self.cell)))

    def to_xy(self, rc) -> dict:
        return {"x": (rc[1] + 0.5) * self.cell, "y": (rc[0] + 0.5) * self.cell}


def obstacle_mask(shape, cell: float, obstacles: list[dict], buffer_m: float = OBSTACLE_BUFFER_M) -> np.ndarray:
    mask = np.zeros(shape, bool)
    if not obstacles:
        return mask
    yy, xx = (np.mgrid[0 : shape[0], 0 : shape[1]] + 0.5) * cell
    for o in obstacles:
        mask |= np.hypot(xx - o["x"], yy - o["y"]) < o["radiusM"] + buffer_m
    return mask


# ---------------- graf i najkrótsze ścieżki ----------------
def _grid_graph(cost: np.ndarray) -> csr_matrix:
    """Graf 8 sąsiadów. Krok po przekątnej jest dozwolony tylko wtedy, gdy oba pola obok niego są przejezdne."""
    rows, cols = cost.shape
    index = np.arange(rows * cols).reshape(rows, cols)
    free = np.isfinite(cost)
    square_free = free[:-1, :-1] & free[1:, 1:] & free[:-1, 1:] & free[1:, :-1]
    moves = (
        (index[:, :-1], index[:, 1:], free[:, :-1] & free[:, 1:], 1.0),  # wschód
        (index[:-1, :], index[1:, :], free[:-1, :] & free[1:, :], 1.0),  # południe
        (index[:-1, :-1], index[1:, 1:], square_free, math.sqrt(2)),  # południowy wschód
        (index[:-1, 1:], index[1:, :-1], square_free, math.sqrt(2)),  # południowy zachód
    )
    flat = cost.ravel()
    src, dst, weight = [], [], []
    for a, b, allowed, step in moves:
        a, b = a[allowed], b[allowed]
        src.append(a)
        dst.append(b)
        weight.append((flat[a] + flat[b]) * 0.5 * step)
    return csr_matrix((np.concatenate(weight), (np.concatenate(src), np.concatenate(dst))), shape=(rows * cols,) * 2)


class _Search:
    """Graf kosztów dla jednego zestawu przeszkód. Pamięta ostatni wynik Dijkstry (kilka celów z jednego punktu)."""

    def __init__(self, cost: np.ndarray):
        self.cost = cost
        self.blocked = np.isinf(cost)
        self.graph = _grid_graph(cost)
        self._last: tuple | None = None

    def from_cell(self, rc: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
        """(koszt dojścia do każdej komórki, tablica poprzedników) dla startu w komórce rc."""
        if self._last is None or self._last[0] != rc:
            cols = self.cost.shape[1]
            dist, pred = dijkstra(self.graph, directed=False, indices=rc[0] * cols + rc[1], return_predecessors=True)
            self._last = (rc, dist.reshape(self.cost.shape), pred)
        return self._last[1], self._last[2]

    def trace(self, pred: np.ndarray, start: tuple[int, int], goal: tuple[int, int]) -> list[tuple[int, int]]:
        cols = self.cost.shape[1]
        first, node = start[0] * cols + start[1], goal[0] * cols + goal[1]
        nodes = [node]
        while node != first:
            node = int(pred[node])
            nodes.append(node)
        return [(n // cols, n % cols) for n in reversed(nodes)]


def _search(model: CostModel, kind: str, obstacles: list[dict] | None, strict: bool, start_rc: tuple[int, int] | None) -> _Search:
    """Graf dla danego rodzaju kosztu i przeszkód (z pamięcią ostatnich kilku — trasy awaryjne liczą się często)."""
    key = (kind, strict, tuple((o["x"], o["y"], o["radiusM"]) for o in obstacles or []))
    cached = model._searches.get(key)
    if cached is not None and (start_rc is None or not cached.blocked[start_rc]):
        return cached
    extra = obstacle_mask(model.blocked.shape, model.cell, obstacles or [])
    if strict:
        extra |= model.caution
    cost = model.cost_array(kind, extra)
    if start_rc is not None and np.isinf(cost[start_rc]):
        # start w polu zakazanym (np. zgłoszenie objęło pozycję załogi): wolno z niego wyjść, drogo, ale nie wejść dalej
        cost[start_rc] = model.o2_per_m[start_rc] * model.cell * 3
        return _Search(cost)
    search = _Search(cost)
    if len(model._searches) >= _GRAPH_CACHE_SIZE:
        model._searches.pop(next(iter(model._searches)))
    model._searches[key] = search
    return search


# ---------------- geometria łamanej ----------------
def _segment_samples(model: CostModel, a: dict, b: dict) -> tuple[np.ndarray, np.ndarray, float]:
    """Komórki pod odcinkiem, próbkowane co pół komórki: (wiersze, kolumny, długość przypadająca na próbkę)."""
    length = math.hypot(b["x"] - a["x"], b["y"] - a["y"])
    n = max(1, math.ceil(2 * length / model.cell))
    t = (np.arange(n) + 0.5) / n
    rows, cols = model.blocked.shape
    r = np.clip(((a["y"] + (b["y"] - a["y"]) * t) // model.cell).astype(int), 0, rows - 1)
    c = np.clip(((a["x"] + (b["x"] - a["x"]) * t) // model.cell).astype(int), 0, cols - 1)
    return r, c, length / n


def _polyline_samples(model: CostModel, pts: list[dict]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rows, cols, lengths = [np.empty(0, int)], [np.empty(0, int)], [np.empty(0)]
    for a, b in zip(pts[:-1], pts[1:]):
        r, c, step = _segment_samples(model, a, b)
        rows.append(r)
        cols.append(c)
        lengths.append(np.full(len(r), step))
    return np.concatenate(rows), np.concatenate(cols), np.concatenate(lengths)


def _segment_cost(model: CostModel, per_m: np.ndarray, a: dict, b: dict) -> float:
    r, c, step = _segment_samples(model, a, b)
    return float(per_m[r, c].sum() * step)


def _segment_clear(model: CostModel, a: dict, b: dict, blocked: np.ndarray) -> bool:
    """Sprawdza każde pole przecięte przez odcinek, w tym punkty na granicach pól."""
    cuts = [np.array([0.0, 1.0])]
    for axis in ("x", "y"):
        origin = a[axis]
        delta = b[axis] - origin
        if delta:
            low, high = sorted((origin, b[axis]))
            borders = np.arange(math.floor(low / model.cell) + 1, math.ceil(high / model.cell)) * model.cell
            cuts.append((borders - origin) / delta)
    times = np.unique(np.concatenate(cuts))
    samples = np.concatenate((times, (times[:-1] + times[1:]) * 0.5))
    cols = np.clip(np.floor((a["x"] + (b["x"] - a["x"]) * samples) / model.cell).astype(int), 0, blocked.shape[1] - 1)
    rows = np.clip(np.floor((a["y"] + (b["y"] - a["y"]) * samples) / model.cell).astype(int), 0, blocked.shape[0] - 1)
    return not bool(blocked[rows, cols].any())


def _drop_collinear(pts: list[dict], keep: set[int]) -> tuple[list[dict], dict[int, int]]:
    """Usuwa punkty leżące dokładnie na prostej między sąsiadami. Zwraca punkty i mapę starych indeksów na nowe."""
    out, new_index = [], {}
    for i, p in enumerate(pts):
        if 0 < i < len(pts) - 1 and i not in keep:
            a, b = out[-1], pts[i + 1]
            cross = (b["x"] - a["x"]) * (p["y"] - a["y"]) - (p["x"] - a["x"]) * (b["y"] - a["y"])
            if abs(cross) < 1e-6:
                continue
        new_index[i] = len(out)
        out.append(p)
    return out, new_index


def _straighten(
    model: CostModel, pts: list[dict], wp_idx: list[int], per_m: np.ndarray, blocked: np.ndarray
) -> tuple[list[dict], list[int]]:
    """Prostuje łamaną z siatki. Punkty trasy (WP) zostają; skrót musi być wolny od zakazu i nie droższy od oryginału."""
    pts, remap = _drop_collinear(pts, set(wp_idx))
    anchors = [remap[i] for i in wp_idx]
    spent = np.concatenate(([0.0], np.cumsum([_segment_cost(model, per_m, a, b) for a, b in zip(pts[:-1], pts[1:])])))

    def shortcut_ok(i: int, j: int) -> bool:
        return _segment_clear(model, pts[i], pts[j], blocked) and _segment_cost(model, per_m, pts[i], pts[j]) <= (spent[j] - spent[i]) * (
            1 + 1e-9
        )

    chosen = [0]
    for anchor in anchors:
        i = chosen[-1]
        while i < anchor:
            far = min(anchor, i + STRAIGHTEN_LOOKAHEAD)
            if far > i + 1 and not shortcut_ok(i, far):
                low = i + 1  # sąsiedni wierzchołek jest zawsze osiągalny
                while far - low > 1:  # najdalszy wierzchołek, do którego da się pójść prosto
                    mid = (low + far) // 2
                    low, far = (mid, far) if shortcut_ok(i, mid) else (low, mid)
                far = low
            chosen.append(far)
            i = far
    position = {old: new for new, old in enumerate(chosen)}
    return [pts[i] for i in chosen], [position[a] for a in anchors]


# ---------------- plan trasy ----------------
def plan(
    model: CostModel,
    start: dict,
    waypoints: list[dict],
    obstacles: list[dict] | None = None,
    layers: dict | None = None,
    kind: str = "o2",
    strict: bool = False,
) -> dict:
    """Trasa start → kolejne punkty o najmniejszym koszcie `kind`. strict=True: strefy „uwaga” też są nieprzekraczalne."""
    prev = model.to_rc(start)
    search = _search(model, kind, obstacles, strict, prev)
    cells, wp_idx, expanded = [], [], []
    for wp in waypoints:
        goal = model.to_rc(wp)
        if search.blocked[goal]:
            return {"ok": False, "error": f"Cel {wp['id']} leży w strefie niedostępnej"}
        reach, pred = search.from_cell(prev)
        if not np.isfinite(reach[goal]):
            return {"ok": False, "error": f"Brak bezpiecznego przejścia do {wp['id']}"}
        leg = search.trace(pred, prev, goal)
        if len(leg) == 1:
            leg = [prev, goal]
        # komórki „przeszukane” przed dojściem do celu, w kolejności kosztu — do animacji w interfejsie
        coarse = reach[::EXPANDED_STRIDE, ::EXPANDED_STRIDE]
        rr, cc = np.nonzero(coarse <= reach[goal])
        order = np.argsort(coarse[rr, cc])
        expanded += [model.to_xy((r * EXPANDED_STRIDE, c * EXPANDED_STRIDE)) for r, c in zip(rr[order], cc[order])]
        cells += leg[1:] if cells else leg
        wp_idx.append(len(cells) - 1)
        prev = goal
    pts = [model.to_xy(rc) for rc in cells]
    pts[0] = {"x": start["x"], "y": start["y"]}
    for i, wp in zip(wp_idx, waypoints):
        pts[i] = {"x": wp["x"], "y": wp["y"]}
    pts, wp_idx = _straighten(model, pts, wp_idx, model.per_metre(kind), search.blocked)
    stats = path_stats(model, pts, layers)
    stop_min = sum(w.get("stopMin", 0) for w in waypoints)
    return {
        "ok": True,
        "path": pts,
        "waypointIndex": wp_idx,
        "lengthM": stats["lengthM"],
        "durationH": stats["walkH"] + stop_min / 60,
        "o2L": stats["o2L"] + stop_min * resting_o2_l_min(model.person),
        "stops": len(waypoints),
        "rating": stats["rating"],
        "uncertainty": stats["uncertainty"],
        "expanded": expanded[:EXPANDED_LIMIT],
    }


def path_stats(model: CostModel, pts: list[dict], layers: dict | None) -> dict:
    """Długość, czas marszu i tlen wzdłuż łamanej oraz największe niepewności danych pod trasą."""
    rows, cols, step = _polyline_samples(model, pts)
    length = float(step.sum())
    uncertainty = {"maxSlopeDeg": 0.0, "maxSlopeSigmaDeg": 0.0, "maxSandProb": 0.0, "minSandConfidence": 1.0, "cautionM": 0}
    caution_m = 0.0
    if layers is not None and len(rows):
        steepest = int(np.argmax(layers["slope"][rows, cols]))
        caution_m = float(step[layers["hazard"][rows, cols] == 1].sum())
        uncertainty = {
            "maxSlopeDeg": round(float(layers["slope"][rows[steepest], cols[steepest]]), 1),
            "maxSlopeSigmaDeg": round(float(layers["slopeSigma"][rows[steepest], cols[steepest]]), 1),
            "maxSandProb": round(float(layers["sand"][rows, cols].max()), 2),
            "minSandConfidence": round(float(layers["sandConfidence"][rows, cols].min()), 2),
            "cautionM": round(caution_m),
        }
    rating = "bezpieczna" if caution_m < 0.1 * max(length, 1) else "bezpieczna z uwagami"
    return {
        "lengthM": length,
        "walkH": float((model.time_per_m[rows, cols] * step).sum()) / 3600,
        "o2L": float((model.o2_per_m[rows, cols] * step).sum()),
        "rating": rating,
        "uncertainty": uncertainty,
    }


def cost_field(model: CostModel, origin: dict, kind: str = "o2", obstacles: list[dict] | None = None) -> np.ndarray:
    """Koszt (L O₂ albo s) dojścia z każdej komórki do punktu origin (np. habitatu)."""
    search = _search(model, kind, obstacles, False, None)
    rc = model.to_rc(origin)
    if search.blocked[rc]:
        return np.full(search.cost.shape, UNREACHABLE, dtype=np.float32)
    reach, _ = search.from_cell(rc)
    return np.where(np.isfinite(reach), reach, UNREACHABLE).astype(np.float32)


# ---------------- porównanie wariantów trasy („dlaczego ta trasa”) ----------------
def forbidden_reasons(layers: dict, eva: dict) -> dict:
    """Dlaczego komórka jest zakazana: stromo (nachylenie+2σ > maks.), luźny piasek (> 0,6) albo głazy."""
    forbidden = layers["hazard"] == 2
    steep = (layers["slope"] + 2 * layers["slopeSigma"]) > eva["maxSlopeDeg"]
    sand = layers["sand"] > 0.6
    return {"steep": forbidden & steep, "sand": forbidden & sand & ~steep, "boulders": forbidden & ~steep & ~sand}


def evaluate(model: CostModel, pts: list, layers: dict, comms=None) -> dict:
    """Ocena dowolnej linii: długość, czas, tlen, metry w strefach „uwaga”/„zakaz” (z przyczyną), bez zasięgu radiowego."""
    rows, cols, step = _polyline_samples(model, pts)
    blocked = model.blocked[rows, cols]
    reasons = forbidden_reasons(layers, model.eva)
    return {
        "lengthM": float(step.sum()),
        "walkS": float((model.time_per_m[rows, cols] * step).sum()),
        "o2L": float((model.o2_per_m[rows, cols] * step).sum()),
        "cautionM": float(step[model.caution[rows, cols] & ~blocked].sum()),
        "forbiddenM": float(step[blocked].sum()),
        "noCommsM": float(step[comms[rows, cols] == 0].sum()) if comms is not None else 0.0,
        **{key: float(step[reasons[key][rows, cols]].sum()) for key in ("steep", "sand", "boulders")},
        "maxSlopeUpDeg": float(model.slope_up[rows, cols].max(initial=0.0)),
        "maxSand": float(layers["sand"][rows, cols].max(initial=0.0)),
    }


def _summary(variant_id: str, acc: dict, stop_h: float, path, ok: bool = True) -> dict:
    return {
        "id": variant_id,
        "ok": ok,
        "path": path or [],
        "lengthM": round(acc["lengthM"]),
        "durationH": round(acc["walkS"] / 3600 + stop_h, 3),
        "o2L": round(acc["o2L"], 1),
        "cautionM": round(acc["cautionM"]),
        "forbiddenM": round(acc["forbiddenM"]),
        "forbidden": {k: round(acc[k]) for k in ("steep", "sand", "boulders")},
        "maxSlopeUpDeg": round(acc["maxSlopeUpDeg"], 1),
        "maxSand": round(acc["maxSand"], 2),
        "noCommsM": round(acc["noCommsM"]),
    }


def _compare(variant: dict, best: dict, max_slope_deg: float) -> tuple[str, list[dict]]:
    """Werdykt wariantu względem wybranej trasy i powody jako kody z liczbami (zdania składa interfejs, PL/EN)."""
    reasons = []
    same = abs(variant["lengthM"] - best["lengthM"]) <= 0.01 * best["lengthM"] and abs(variant["o2L"] - best["o2L"]) <= 0.01 * best["o2L"]
    if variant["forbiddenM"] > 0:
        verdict = "unsafe"
        reasons.append({"code": "forbidden", "m": variant["forbiddenM"], **variant["forbidden"]})
        if variant["maxSlopeUpDeg"] > max_slope_deg:
            reasons.append({"code": "tooSteep", "deg": variant["maxSlopeUpDeg"], "max": max_slope_deg})
    elif same:
        return "same", [{"code": "sameAsChosen"}]
    else:
        verdict = "worse"
    d_len = variant["lengthM"] - best["lengthM"]
    d_o2 = round(variant["o2L"] - best["o2L"], 1)
    d_min = round((variant["durationH"] - best["durationH"]) * 60)
    if d_len < 0:
        reasons.append({"code": "shorter", "m": -d_len})
    elif d_len > 0:
        reasons.append({"code": "longer", "m": d_len})
    if d_o2 > 0:
        reasons.append({"code": "moreO2", "l": d_o2})
    if d_min > 0:
        reasons.append({"code": "slower", "min": d_min})
    elif d_min < 0 and verdict == "unsafe":
        reasons.append({"code": "fasterButUnsafe", "min": -d_min})
    if variant["cautionM"] - best["cautionM"] > 10:
        reasons.append({"code": "moreCaution", "m": variant["cautionM"] - best["cautionM"]})
    if variant["noCommsM"] - best["noCommsM"] > 10:
        reasons.append({"code": "lessComms", "m": variant["noCommsM"] - best["noCommsM"]})
    return verdict, reasons


def alternatives(model: CostModel, start: dict, waypoints: list, obstacles, layers: dict, comms, chosen: dict) -> list:
    """Warianty obok wybranej trasy (najmniej O₂) i powody, dla których przegrywają."""
    effective_layers = {**layers, "hazard": layers["hazard"].copy()}
    effective_layers["hazard"][obstacle_mask(model.blocked.shape, model.cell, obstacles or [])] = 2
    evaluation_model = CostModel(effective_layers, model.cell, model.eva, model.person)

    def assess(path):
        return evaluate(evaluation_model, path, effective_layers, comms)

    stop_h = sum(w.get("stopMin", 0) for w in waypoints) / 60
    stop_o2 = stop_h * 60 * resting_o2_l_min(model.person)
    best = _summary("chosen", assess(chosen["path"]), stop_h, chosen["path"])
    best["verdict"] = "chosen"
    best["reasons"] = [
        {"code": "minO2", "o2": round(best["o2L"] + stop_o2, 1)},
        {"code": "noForbidden"},
        {"code": "margin2s", "deg": model.eva["maxSlopeDeg"]},
    ]
    if best["cautionM"]:
        best["reasons"].append(
            {"code": "cautionShare", "m": best["cautionM"], "pct": round(100 * best["cautionM"] / max(best["lengthM"], 1))}
        )

    straight = [{"x": start["x"], "y": start["y"]}] + [{"x": w["x"], "y": w["y"]} for w in waypoints]
    shortest = plan(model, start, waypoints, obstacles, layers, kind="dist")
    strict = plan(model, start, waypoints, obstacles, layers, kind="o2", strict=True)
    out = [best]
    for variant_id, path in (("straight", straight), ("shortest", shortest.get("path")), ("strict", strict.get("path"))):
        if path is None:
            variant = _summary(variant_id, assess(straight), stop_h, None, ok=False)
            variant.update(verdict="impossible", reasons=[{"code": "noPath"}])
        else:
            variant = _summary(variant_id, assess(path), stop_h, path)
            verdict, reasons = _compare(variant, best, model.eva["maxSlopeDeg"])
            variant.update(verdict=verdict, reasons=reasons)
        out.append(variant)
    for variant in out:
        variant["o2L"] = round(variant["o2L"] + stop_o2, 1)
    return out
