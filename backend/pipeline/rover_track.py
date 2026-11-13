"""Prawdziwe trasy łazików (Curiosity, Perseverance) w obszarze misji — z NASA MMGIS (mars.nasa.gov/mmgis-maps).

Pliki GeoJSON z lokalizacjami zespołów misji:
  {ROVER}_traverse.json  — przejechana trasa (linie, lon/lat planetocentryczne, wysokość względem areoidu)
  {ROVER}_waypoints.json — postoje (sol, site, drive, lon/lat, wysokość, kurs łazika, czasem panorama)

Wynik: data/missions/<id>/roverTrack.json w lokalnych metrach UI (x na wschód od lewego górnego rogu, y na południe),
przycięty do okna misji. Krok nie wymaga rasterio: siatka misji jest w projekcji równokątnej, więc lon/lat → metry
to interpolacja liniowa między narożnikami z mission.json (tak samo jak w backend/pipeline/grid.py).

Uruchomienie samodzielne (dopisuje warstwę do zbudowanej misji, bez przeliczania reszty potoku):
  python -m backend.pipeline.rover_track mount-sharp
  python -m backend.pipeline.rover_track jezero
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MISSIONS = ROOT / "data" / "missions"
CACHE = ROOT / "backend" / "cache" / "mmgis"
MMGIS = "https://mars.nasa.gov/mmgis-maps"

SOL_S = 88775.244   # doba marsjańska [s]
ROVERS = {
    # misja MarSim → łazik NASA, którego trasa przechodzi przez okno.
    # landing: lądowanie (UTC) i lokalny czas słoneczny w chwili lądowania (ułamek doby) — do przeliczenia sol → data
    "mount-sharp": {"key": "MSL", "name": "Curiosity", "credit": "NASA/JPL-Caltech/MSL localization team (MMGIS)",
                    "landing": ("2012-08-06T05:17:57+00:00", 15.0 / 24)},
    "jezero": {"key": "M20", "name": "Perseverance", "credit": "NASA/JPL-Caltech/Mars 2020 localization team (MMGIS)",
               "landing": ("2021-02-18T20:55:00+00:00", 15.88 / 24)},
}


def sol_date(sol: int, landing: tuple[str, float]) -> str:
    """Data ziemska (UTC) południa danego solu misji."""
    t0 = datetime.fromisoformat(landing[0]).timestamp() - landing[1] * SOL_S   # północ solu 0
    return datetime.fromtimestamp(t0 + (sol + 0.5) * SOL_S, timezone.utc).date().isoformat()

LAYER = {
    "id": "rover",
    "name": "Trasa łazika",
    "desc": "prawdziwy przejazd NASA",
    "colorOff": "#2d4f5c",
    "colorOn": "#6FD3F2",
    "vector": {"file": "roverTrack.json"},
}


def fetch_json(url: str, cache: Path, fresh: bool = False) -> dict:
    """Pobiera plik raz i trzyma go w backend/cache (praca offline przy kolejnych budowach)."""
    cache.parent.mkdir(parents=True, exist_ok=True)
    if fresh or not cache.exists():
        req = urllib.request.Request(url, headers={"User-Agent": "MarSim-data-pipeline"})
        with urllib.request.urlopen(req, timeout=120) as r:
            cache.write_bytes(r.read())
    return json.loads(cache.read_text(encoding="utf-8"))


class Window:
    """Okno misji: narożniki z mission.json (lon/lat), rozmiar w metrach."""

    def __init__(self, area: dict):
        c = area["corners"]
        self.lon0, self.lat0 = c["nw"]
        self.lon1, self.lat1 = c["se"]
        self.W, self.H = float(area["widthM"]), float(area["heightM"])

    def xy(self, lon: float, lat: float) -> tuple[float, float]:
        lon %= 360.0
        return ((lon - self.lon0) / (self.lon1 - self.lon0) * self.W, (lat - self.lat0) / (self.lat1 - self.lat0) * self.H)

    def inside(self, x: float, y: float, pad: float = 0.0) -> bool:
        return -pad <= x <= self.W + pad and -pad <= y <= self.H + pad


def clip_segment(ax, ay, bx, by, W, H):
    """Liang–Barsky: odcinek przycięty do prostokąta [0,W]×[0,H] albo None."""
    t0, t1, dx, dy = 0.0, 1.0, bx - ax, by - ay
    for p, q in ((-dx, ax), (dx, W - ax), (-dy, ay), (dy, H - ay)):
        if p == 0:
            if q < 0:
                return None
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return None
            t0 = max(t0, r)
        else:
            if r < t0:
                return None
            t1 = min(t1, r)
    return (ax + t0 * dx, ay + t0 * dy), (ax + t1 * dx, ay + t1 * dy)


def clip_lines(lines: list[list[tuple[float, float]]], W: float, H: float, min_step: float = 0.5) -> list[list[list[float]]]:
    """Linie w metrach → odcinki wewnątrz okna (ciągłe kawałki), z punktami co najmniej min_step m."""
    out: list[list[list[float]]] = []
    for ln in lines:
        cur: list[list[float]] = []
        for (ax, ay), (bx, by) in zip(ln, ln[1:]):
            c = clip_segment(ax, ay, bx, by, W, H)
            if c is None:
                if len(cur) > 1:
                    out.append(cur)
                cur = []
                continue
            (px, py), (qx, qy) = c
            if not cur or math.hypot(cur[-1][0] - px, cur[-1][1] - py) > 0.01:
                if len(cur) > 1:
                    out.append(cur)
                cur = [[round(px, 2), round(py, 2)]]
            if math.hypot(cur[-1][0] - qx, cur[-1][1] - qy) >= min_step:
                cur.append([round(qx, 2), round(qy, 2)])
            if (qx, qy) != (bx, by):   # wyjazd poza okno
                if len(cur) > 1:
                    out.append(cur)
                cur = []
        if len(cur) > 1:
            out.append(cur)
    return out


def merge_segments(segs: list[list[list[float]]], tol: float = 1.0) -> list[list[list[float]]]:
    """Łączy kolejne kawałki, które się stykają (każdy przejazd to osobny obiekt w GeoJSON)."""
    out: list[list[list[float]]] = []
    for s in segs:
        if out and math.hypot(out[-1][-1][0] - s[0][0], out[-1][-1][1] - s[0][1]) <= tol:
            out[-1].extend(s[1:])
        else:
            out.append(list(s))
    return out


def dem_sampler(mdir: Path, mission: dict):
    """Wysokość z DTM misji (do porównania z wysokościami lokalizacji łazika)."""
    d = mission["dem"]
    w, h, cell = d["width"], d["height"], d["cellM"]
    raw = (mdir / d["file"]).read_bytes()
    vals = struct.unpack(f"<{w * h}f", raw[: 4 * w * h])

    def at(x: float, y: float) -> float | None:
        i, j = int(min(w - 1, max(0, x / cell))), int(min(h - 1, max(0, y / cell)))
        v = vals[j * w + i]
        return None if math.isnan(v) else v

    return at


def build(mission_id: str, fresh: bool = False) -> dict | None:
    """Tworzy roverTrack.json dla misji. Zwraca {layer, source, stats} albo None, gdy łazik nie przejeżdżał przez okno."""
    rv = ROVERS.get(mission_id)
    if not rv:
        return None
    mdir = MISSIONS / mission_id
    mission = json.loads((mdir / "mission.json").read_text(encoding="utf-8"))
    win = Window(mission["area"])
    key = rv["key"]
    urls = {k: f"{MMGIS}/{key}/Layers/json/{key}_{k}.json" for k in ("traverse", "waypoints")}
    trav = fetch_json(urls["traverse"], CACHE / f"{key}_traverse.json", fresh)
    wps = fetch_json(urls["waypoints"], CACHE / f"{key}_waypoints.json", fresh)

    # trasa: linie → metry → przycięcie do okna
    lines, sol_of_line = [], []
    for f in trav["features"]:
        g = f["geometry"]
        parts = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
        for part in parts:
            lines.append([win.xy(p[0], p[1]) for p in part])
            sol_of_line.append(f["properties"].get("sol"))
    segments = merge_segments(clip_lines(lines, win.W, win.H))
    length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for s in segments for a, b in zip(s, s[1:]))

    # postoje w oknie
    dem = dem_sampler(mdir, mission)
    stops, dz = [], []
    for f in wps["features"]:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"][:2]
        x, y = win.xy(lon, lat)
        if not win.inside(x, y):
            continue
        stop = {
            "x": round(x, 2), "y": round(y, 2), "sol": p.get("sol"), "site": p.get("site"), "drive": p.get("drive"),
            "yaw": round(p["yaw"], 1) if isinstance(p.get("yaw"), (int, float)) else None,
            "elev": p.get("elev_geoid"),
            "date": sol_date(p["sol"], rv["landing"]) if isinstance(p.get("sol"), int) else None,
        }
        pano = next((im for im in p.get("images") or [] if im.get("isPanoramic") and im.get("url")), None)
        if pano:
            stop["pano"] = f"{MMGIS}/{key}/{pano['url']}"
        stops.append(stop)
        z = dem(x, y)
        if z is not None and isinstance(p.get("elev_geoid"), (int, float)):
            dz.append(p["elev_geoid"] - z)
    if not segments and not stops:
        return None
    stops.sort(key=lambda s: (s["sol"] or 0, s["site"] or 0, s["drive"] or 0))
    sols = [s["sol"] for s in stops if s["sol"] is not None]
    dz.sort()
    med = dz[len(dz) // 2] if dz else None
    spread = (dz[int(len(dz) * 0.84)] - dz[int(len(dz) * 0.16)]) / 2 if len(dz) >= 5 else None

    data = {
        "rover": rv["name"],
        "credit": rv["credit"],
        "source": urls,
        "fetchedUtc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "lengthM": round(length, 1),
        "sols": [min(sols), max(sols)] if sols else None,
        "segments": segments,
        "stops": stops,
        "dates": [sol_date(min(sols), rv["landing"]), sol_date(max(sols), rv["landing"])] if sols else None,
        # zgodność wysokości lokalizacji łazika z naszym DTM: stała różnica = inny poziom odniesienia (DEM misji jest
        # liczony od własnego minimum), rozrzut = błąd położenia / modelu. Przesunięcia poziomego to nie wyznacza
        # (rzędu do kilkudziesięciu m między mozaiką bazową misji a ortoobrazem HiRISE) — trasa jest poglądowa.
        "elevCheck": {"medianOffsetM": round(med, 2) if med is not None else None, "spreadM": round(spread, 2) if spread is not None else None, "n": len(dz)},
    }
    out = mdir / "roverTrack.json"
    if out.exists():   # zdjęcia dopisuje osobny krok (rover_photos.py) — nie gubimy ich przy odświeżeniu trasy
        prev = json.loads(out.read_text(encoding="utf-8"))
        if prev.get("photos"):
            data["photos"] = prev["photos"]
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    sha = hashlib.sha256(out.read_bytes()).hexdigest()
    years = f"{data['dates'][0][:4]}–{data['dates'][1][:4]}" if data["dates"] else ""
    # opis i legenda stałymi napisami (tłumaczone w src/i18n.js), liczby pokazuje odczyt pod kursorem
    layer = {**LAYER, "desc": f"{rv['name']} {years}".strip(), "legend": [
        {"color": "#6FD3F2", "text": "przejazd łazika (lokalizacje NASA)"},
        {"color": "#FFFFFF", "text": "postój — kliknij: zdjęcia z łazika"},
    ]}
    source = {
        "id": f"{key}_traverse",
        "instrument": f"{key} localization",
        "description": f"Trasa i postoje łazika {rv['name']} (lokalizacje zespołu misji, NASA MMGIS)",
        "url": urls["traverse"],
        "sha256": None,
        "bytes": None,
        "access": "pobrany plik",
    }
    stats = {"lengthM": data["lengthM"], "stops": len(stops), "sols": data["sols"], "elevCheck": data["elevCheck"], "sha256": sha}
    return {"layer": layer, "source": source, "stats": stats}


def insert_layer(layers: list, layer: dict) -> list:
    """Warstwa trasy łazika na końcu listy: skróty 1–9, 0 istniejących warstw zostają bez zmian."""
    return [x for x in layers if x["id"] != layer["id"]] + [layer]


def apply(mission_id: str, fresh: bool = False) -> int:
    res = build(mission_id, fresh)
    mdir = MISSIONS / mission_id
    if not res:
        print(f"[rover] {mission_id}: brak przejazdu łazika w oknie — pomijam")
        return 0
    mission = json.loads((mdir / "mission.json").read_text(encoding="utf-8"))
    prov = json.loads((mdir / "provenance.json").read_text(encoding="utf-8"))
    mission["layers"] = insert_layer(mission["layers"], res["layer"])
    prov["sources"] = [s for s in prov["sources"] if s["id"] != res["source"]["id"]] + [res["source"]]
    prov.setdefault("methods", {})["rover"] = (
        "trasa i postoje z lokalizacji zespołu misji (NASA MMGIS GeoJSON), przeliczone liniowo z lon/lat do siatki równokątnej "
        "misji i przycięte do okna (Liang–Barsky); elevCheck porównuje wysokości postojów z DTM HiRISE"
    )
    prov.setdefault("stats", {})["rover"] = {k: v for k, v in res["stats"].items() if k != "sha256"}
    prov.setdefault("outputs", {})["roverTrack.json"] = res["stats"]["sha256"]
    (mdir / "provenance.json").write_text(json.dumps(prov, indent=2, ensure_ascii=False), encoding="utf-8")
    (mdir / "mission.json").write_text(json.dumps(mission, indent=2, ensure_ascii=False), encoding="utf-8")
    s = res["stats"]
    print(f"[rover] {mission_id}: {s['lengthM']} m trasy, {s['stops']} postojów, sole {s['sols']}, wysokość vs DTM {s['elevCheck']}")
    return 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    fresh = "--fresh" in sys.argv
    ids = args or list(ROVERS)
    sys.exit(max(apply(m, fresh) for m in ids))
