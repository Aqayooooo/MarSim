"""Zdjęcia z kamer nawigacyjnych łazika (Navcam) wykonane na postojach w obszarze misji.

Źródło: publiczne katalogi surowych zdjęć NASA (te same, z których korzystają strony raw-images):
  Perseverance: https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&…
  Curiosity:    https://mars.nasa.gov/api/v1/raw_image_items/?condition_1=msl:mission&…
Uwaga do składni: condition_1 jest zajęty przez misję, filtry solu to condition_2/condition_3; „|” musi być zakodowany (%7C).

Każde zdjęcie łączymy z postojem po (site, drive) — postoje są już w roverTrack.json (krok rover_track.py).
Kierunek: model kamery CAHV jest w układzie łazika (N-E-dół względem nadwozia), więc
  azymut świata = kurs łazika (MMGIS yaw) + atan2(A_y, A_x),  elewacja = −asin(A_z / |A|),
  poziome pole widzenia = 2·atan((szerokość/2) / |A × H|).
Do repozytorium trafiają tylko miniatury 320 px (do 3 na postój, możliwie różne kierunki); pełny rozmiar otwiera się
z serwera NASA, gdy jest internet. Wynik dopisywany do data/missions/<id>/roverTrack.json jako pole "photos".

  python -m backend.pipeline.rover_photos            # obie misje
  python -m backend.pipeline.rover_photos jezero
"""

from __future__ import annotations

import io
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from backend.pipeline.rover_track import MISSIONS, ROOT, ROVERS

CACHE = ROOT / "backend" / "cache" / "rawimages"
UA = {"User-Agent": "MarSim-data-pipeline"}
THUMB_W = 320
PER_STOP = 3
EL_RANGE = (-32.0, 12.0)   # bez zdjęć pokładu, kół i nieba

CAMERAS = {
    "M20": {"search": "NAVCAM_LEFT", "credit": "NASA/JPL-Caltech", "label": "Navcam"},
    "MSL": {"search": "NAV_LEFT_A|NAV_LEFT_B", "credit": "NASA/JPL-Caltech", "label": "Navcam"},
}


def _get(url: str, cache: Path | None = None) -> bytes:
    if cache and cache.exists():
        return cache.read_bytes()
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                data = r.read()
            break
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 + attempt * 3)
    if cache:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(data)
    time.sleep(0.3)   # grzecznie wobec serwera NASA
    return data


def query_m20(sol0: int, sol1: int, search: str, page: int) -> tuple[list[dict], int]:
    q = {
        "feed": "raw_images", "category": "mars2020", "feedtype": "json", "num": 100, "page": page, "order": "sol asc",
        "condition_1": "mars2020:mission", "condition_2": f"{sol0}:sol:gte", "condition_3": f"{sol1}:sol:lte",
        "search": search, "extended": "sample_type::full,",
    }
    url = "https://mars.nasa.gov/rss/api/?" + urllib.parse.urlencode(q, safe=":,")
    d = json.loads(_get(url, CACHE / "M20" / f"{sol0}-{sol1}-{page}.json"))
    return d.get("images") or [], int(d.get("total_results") or 0)


def query_msl(sol0: int, sol1: int, search: str, page: int) -> tuple[list[dict], int]:
    q = {
        "order": "sol asc", "per_page": 100, "page": page, "condition_1": "msl:mission",
        "condition_2": f"{sol0}:sol:gte", "condition_3": f"{sol1}:sol:lte", "search": search, "extended": "thumbnail::sample_type::noteq",
    }
    url = "https://mars.nasa.gov/api/v1/raw_image_items/?" + urllib.parse.urlencode(q, safe=":,")
    d = json.loads(_get(url, CACHE / "MSL" / f"{sol0}-{sol1}-{page}.json"))
    return d.get("items") or [], int(d.get("total") or 0)


def vec(s: str) -> list[float]:
    return [float(v) for v in s.strip().strip("()").split(",")]


def geometry(model: str, width: int, rover_yaw: float) -> tuple[float, float, float] | None:
    """(azymut świata, elewacja, poziome pole widzenia) z modelu CAHV(OR/E) w układzie łazika."""
    try:
        parts = model.split(";")
        A, H = vec(parts[1]), vec(parts[2])
    except (IndexError, ValueError, AttributeError):
        return None
    na = math.sqrt(sum(a * a for a in A)) or 1
    A = [a / na for a in A]
    az = (rover_yaw + math.degrees(math.atan2(A[1], A[0]))) % 360
    el = -math.degrees(math.asin(max(-1, min(1, A[2]))))
    cx = [A[1] * H[2] - A[2] * H[1], A[2] * H[0] - A[0] * H[2], A[0] * H[1] - A[1] * H[0]]
    hs = math.sqrt(sum(c * c for c in cx)) or 1
    hfov = math.degrees(2 * math.atan((width / 2) / hs))
    return az, el, hfov


def spans(sols: list[int], gap: int = 6) -> list[tuple[int, int]]:
    out: list[list[int]] = []
    for s in sorted(set(sols)):
        if out and s - out[-1][1] <= gap:
            out[-1][1] = s
        else:
            out.append([s, s])
    return [(a, b) for a, b in out]


def pick_spread(cands: list[dict], n: int) -> list[dict]:
    """Do n zdjęć o możliwie różnych azymutach; najpierw te patrzące najbliżej horyzontu."""
    cands = sorted(cands, key=lambda c: abs(c["el"] + 8))
    chosen: list[dict] = []
    for c in cands:
        if len(chosen) >= n:
            break
        if all(abs(((c["az"] - o["az"]) + 540) % 360 - 180) > 35 for o in chosen):
            chosen.append(c)
    return chosen


def thumb(src: bytes, dest: Path) -> int:
    from PIL import Image   # tylko w kroku budowania (requirements-runtime: pillow)

    im = Image.open(io.BytesIO(src))
    im = im.convert("RGB") if im.mode not in ("RGB", "L") else im
    if im.width > THUMB_W:
        im = im.resize((THUMB_W, round(im.height * THUMB_W / im.width)), Image.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest, "JPEG", quality=80, optimize=True)
    return dest.stat().st_size


def build(mission_id: str) -> dict | None:
    rv = ROVERS.get(mission_id)
    mdir = MISSIONS / mission_id
    track_path = mdir / "roverTrack.json"
    if not rv or not track_path.exists():
        return None
    track = json.loads(track_path.read_text(encoding="utf-8"))
    key, cam = rv["key"], CAMERAS[rv["key"]]
    by_stop = {(int(s["site"]), int(s["drive"])): i for i, s in enumerate(track["stops"]) if s.get("site") is not None}
    query = query_m20 if key == "M20" else query_msl
    cands: dict[int, list[dict]] = {}
    seen = 0
    for sol0, sol1 in spans([s["sol"] for s in track["stops"] if s.get("sol") is not None]):
        page, total = 0, None
        while True:
            items, tot = query(sol0, sol1, cam["search"], page)
            total = tot if total is None else total
            seen += len(items)
            for it in items:
                try:
                    k = (int(it["site"]), int(it["drive"]))
                except (KeyError, TypeError, ValueError):
                    continue
                si = by_stop.get(k)
                if si is None:
                    continue   # zdjęcie z innego postoju (poza oknem) albo w trakcie jazdy
                stop = track["stops"][si]
                if stop.get("yaw") is None:
                    continue
                if key == "M20":
                    model = it["camera"]["camera_model_component_list"]
                    dim = (it.get("extended") or {}).get("dimension") or "(1280,960)"
                    width = int(vec(dim)[0])
                    url_thumb, url_large, date = it["image_files"]["small"], it["image_files"].get("large") or it["image_files"]["medium"], it.get("date_taken_utc")
                    credit, page_url = it.get("credit") or cam["credit"], it.get("link")
                else:
                    model = it.get("camera_model_component_list") or ""
                    sub = it.get("subframe_rect") or "(1,1,1024,1024)"
                    width = int(vec(sub)[2])
                    url_thumb = url_large = (it.get("https_url") or it.get("url") or "").replace("http://mars.jpl.nasa.gov", "https://mars.nasa.gov").replace("https://mars.jpl.nasa.gov", "https://mars.nasa.gov")
                    date, credit = it.get("date_taken"), it.get("image_credit") or cam["credit"]
                    page_url = "https://mars.nasa.gov/msl/multimedia/raw-images/?id=" + str(it.get("id")) if it.get("id") else None
                if width < 640:
                    continue   # wycinki i miniatury pokładowe
                g = geometry(model, width, stop["yaw"])
                if not g or not (EL_RANGE[0] <= g[1] <= EL_RANGE[1]):
                    continue
                cands.setdefault(si, []).append({
                    "id": it["imageid"], "stop": si, "sol": it["sol"], "dateUtc": (date or "")[:19],
                    "cam": cam["label"], "az": round(g[0], 1), "el": round(g[1], 1), "hfov": round(g[2], 1),
                    "_thumb": url_thumb, "large": url_large, "page": page_url, "credit": credit,
                })
            page += 1
            if not items or page * 100 >= (total or 0):
                break
    photos, bytes_total = [], 0
    for si in sorted(cands):
        for p in pick_spread(cands[si], PER_STOP):
            dest = mdir / "photos" / f"{p['id']}.jpg"
            if not dest.exists():
                src = _get(p["_thumb"])
                bytes_total += thumb(src, dest)
            else:
                bytes_total += dest.stat().st_size
            p = {k: v for k, v in p.items() if not k.startswith("_")}
            p["thumb"] = f"photos/{p['id']}.jpg"
            photos.append(p)
    # usuwamy stare miniatury, których już nie ma w indeksie
    keep = {Path(p["thumb"]).name for p in photos}
    for f in (mdir / "photos").glob("*.jpg") if (mdir / "photos").exists() else []:
        if f.name not in keep:
            f.unlink()
    track["photos"] = photos
    track_path.write_text(json.dumps(track, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return {"photos": len(photos), "stopsWithPhotos": len({p["stop"] for p in photos}), "imagesScanned": seen, "thumbBytes": bytes_total}


def apply(mission_id: str) -> int:
    res = build(mission_id)
    if not res:
        print(f"[photos] {mission_id}: brak roverTrack.json — najpierw python -m backend.pipeline.rover_track {mission_id}")
        return 0
    mdir = MISSIONS / mission_id
    prov = json.loads((mdir / "provenance.json").read_text(encoding="utf-8"))
    key = ROVERS[mission_id]["key"]
    src = {
        "id": f"{key}_raw_navcam",
        "instrument": f"{key} Navcam",
        "description": f"Surowe zdjęcia Navcam łazika {ROVERS[mission_id]['name']} z postojów w obszarze (miniatury 320 px)",
        "url": "https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020" if key == "M20" else "https://mars.nasa.gov/api/v1/raw_image_items/?condition_1=msl:mission",
        "sha256": None, "bytes": res["thumbBytes"], "access": "pobrany plik",
    }
    prov["sources"] = [s for s in prov["sources"] if s["id"] != src["id"]] + [src]
    prov.setdefault("methods", {})["roverPhotos"] = (
        "zdjęcia Navcam połączone z postojami po (site, drive); kierunek z modelu CAHV + kurs łazika, elewacja −32…+12°, "
        f"do {PER_STOP} miniatur na postój w różnych kierunkach"
    )
    prov.setdefault("stats", {})["roverPhotos"] = res
    import hashlib
    prov.setdefault("outputs", {})["roverTrack.json"] = hashlib.sha256((mdir / "roverTrack.json").read_bytes()).hexdigest()
    (mdir / "provenance.json").write_text(json.dumps(prov, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[photos] {mission_id}: {res}")
    return 0


if __name__ == "__main__":
    ids = [a for a in sys.argv[1:] if not a.startswith("--")] or list(ROVERS)
    sys.exit(max(apply(m) for m in ids))
