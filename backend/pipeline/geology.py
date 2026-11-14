"""Mapa geologiczna krateru Jezero (USGS SIM 3464, Sun & Stack 2020, skala 1:75 000) jako warstwa misji jezero.

Źródło: usługa ArcGIS USGS Astrogeology (ta sama, z której korzysta interaktywna mapa na astrogeology-usgs.hub.arcgis.com):
  …/Jezero_FeatureServiceFromPro/FeatureServer/8 — jednostki geologiczne (wielokąty)
  …/Jezero_FeatureServiceFromPro/FeatureServer/7 — cechy powierzchni (m.in. ciemny materiał płaszczowy)
Zapytanie w układzie geograficznym Mars 2000 (wkid 104905), f=json (GeoJSON jest odrzucany dla układów pozaziemskich).

Wynik: geology.png (klasy 8-bit, 3 m/px, jak hazards.png) + warstwa „geology” w mission.json.
Ograniczenie: mapa była kartowana na półkontrolowanej mozaice CTX z przesunięciami ~100–200 m względem mozaiki
kontrolowanej, a skala 1:75 000 to ~40–75 m dokładności — warstwa jest poglądowa, NIE wchodzi do zagrożeń ani planera.

  .venv/bin/python -m backend.pipeline.geology
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.parse
import urllib.request

from backend.pipeline.rover_track import MISSIONS, ROOT, Window

SERVICE = "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Jezero_FeatureServiceFromPro/FeatureServer"
CACHE = ROOT / "backend" / "cache" / "usgs"
CELL = 3.0
MISSION = "jezero"
CITATION = (
    "Sun, V.Z., and Stack, K.M., 2020, Geologic map of Jezero crater and the Nili Planum region, Mars: "
    "USGS SIM 3464, 1:75,000, doi:10.3133/sim3464"
)

# klasy rastra: symbol jednostki USGS → (klasa, kolor, nazwa PL, nazwa EN w i18n)
UNITS = {
    "Nle": (1, "#C98B5E", "dolna jednostka wytrawiona (Nle) — popiół wulkaniczny?, oliwin i węglany"),
    "Njf": (2, "#8E7DB8", "jednostka dna krateru (Njf) — popiół lub osad eoliczny, skład maficzny"),
}
MANTLE = (3, "#3B3F52", "ciemny materiał płaszczowy (cienka pokrywa)")


def query(layer: int, win: Window, pad_deg: float = 0.01) -> dict:
    lon0, lon1 = sorted((win.lon0, win.lon1))
    lat0, lat1 = sorted((win.lat0, win.lat1))
    env = {
        "xmin": lon0 - pad_deg,
        "ymin": lat0 - pad_deg,
        "xmax": lon1 + pad_deg,
        "ymax": lat1 + pad_deg,
        "spatialReference": {"wkid": 104905},
    }
    q = {
        "where": "1=1",
        "geometry": json.dumps(env),
        "geometryType": "esriGeometryEnvelope",
        "inSR": 104905,
        "outSR": 104905,
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*",
        "returnGeometry": "true",
        "f": "json",
    }
    url = f"{SERVICE}/{layer}/query?" + urllib.parse.urlencode(q)
    cache = CACHE / f"jezero_{layer}.json"
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "MarSim-data-pipeline"}), timeout=120) as r:
            cache.write_bytes(r.read())
    d = json.loads(cache.read_text(encoding="utf-8"))
    if "error" in d:
        raise RuntimeError(f"USGS: {d['error']}")
    return d


def signed_area(ring) -> float:
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1])) / 2


def rasterize(features, win: Window, w: int, h: int):
    """Maska wielokątów (z dziurami) w siatce misji; PIL rysuje wielokąty szybko i dokładnie."""
    from PIL import Image, ImageDraw

    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    for f in features:
        rings = f["geometry"].get("rings") or []
        # Esri: zewnętrzne pierścienie zgodnie z ruchem wskazówek zegara (w lon/lat, oś y w górę), dziury przeciwnie
        outer = [r for r in rings if signed_area(r) < 0]
        holes = [r for r in rings if signed_area(r) >= 0]
        for group, val in ((outer, 255), (holes, 0)):
            for r in group:
                pts = [(x / CELL, y / CELL) for x, y in (win.xy(lon, lat) for lon, lat in r)]
                if len(pts) >= 3:
                    d.polygon(pts, fill=val)
    return mask


def build() -> dict | None:
    from PIL import Image

    mdir = MISSIONS / MISSION
    mission = json.loads((mdir / "mission.json").read_text(encoding="utf-8"))
    win = Window(mission["area"])
    w, h = round(win.W / CELL), round(win.H / CELL)
    units = query(8, win)["features"]
    surface = query(7, win)["features"]
    cls = Image.new("L", (w, h), 0)
    stats, legend, classes = {}, [], {}
    for sym, (k, color, text) in UNITS.items():
        feats = [f for f in units if (f["attributes"].get("symbol_noSub") or f["attributes"].get("symbol")) == sym]
        if not feats:
            continue
        m = rasterize(feats, win, w, h)
        cls.paste(k, mask=m)
        share = sum(m.histogram()[1:]) / (w * h)
        if share > 0:
            stats[sym] = round(share, 3)
            classes[str(k)] = {"color": color, "text": text}
            legend.append({"color": color, "text": text})
    mantle = [f for f in surface if "mantl" in str(f["attributes"].get("TYPE", "")).lower()]
    if mantle:
        m = rasterize(mantle, win, w, h)
        share = sum(m.histogram()[1:]) / (w * h)
        if share > 0:
            cls.paste(MANTLE[0], mask=m)
            stats["mantle"] = round(share, 3)
            classes[str(MANTLE[0])] = {"color": MANTLE[1], "text": MANTLE[2]}
            legend.append({"color": MANTLE[1], "text": MANTLE[2]})
    if not classes:
        return None
    out = mdir / "geology.png"
    cls.save(out, optimize=True)
    legend.append({"color": "#888888", "text": "granice z mapy 1:75 000, dokładność ~100–200 m"})
    layer = {
        "id": "geology",
        "name": "Geologia",
        "desc": "USGS SIM 3464, 1:75 000",
        "colorOff": "#4a3f5c",
        "colorOn": "#B39DDB",
        "raster": {"file": "geology.png", "encoding": "png-class8", "width": w, "height": h, "cellM": CELL, "classes": classes},
        "legend": legend,
    }
    source = {
        "id": "USGS_SIM3464_Jezero",
        "instrument": "USGS SIM 3464",
        "description": "Mapa geologiczna krateru Jezero (Sun & Stack 2020), jednostki i cechy powierzchni",
        "url": SERVICE,
        "sha256": None,
        "bytes": None,
        "access": "pobrany plik",
    }
    return {"layer": layer, "source": source, "stats": stats, "sha256": hashlib.sha256(out.read_bytes()).hexdigest()}


def apply() -> int:
    res = build()
    if not res:
        print("[geology] brak jednostek w oknie")
        return 1
    mdir = MISSIONS / MISSION
    mission = json.loads((mdir / "mission.json").read_text(encoding="utf-8"))
    prov = json.loads((mdir / "provenance.json").read_text(encoding="utf-8"))
    layers = [x for x in mission["layers"] if x["id"] != "geology"]
    i = next((k + 1 for k, x in enumerate(layers) if x["id"] == "sky"), len(layers))  # po „Niebie”, przed trasą łazika
    mission["layers"] = layers[:i] + [res["layer"]] + layers[i:]
    prov["sources"] = [s for s in prov["sources"] if s["id"] != res["source"]["id"]] + [res["source"]]
    prov.setdefault("methods", {})["geology"] = (
        "jednostki USGS SIM 3464 (wielokąty z usługi ArcGIS, wkid 104905) zrasteryzowane do siatki 3 m; ciemny płaszcz na wierzchu. "
        "Poglądowo: przesunięcia mapy ~100–200 m, nie używane w zagrożeniach ani planowaniu. " + CITATION
    )
    prov.setdefault("stats", {})["geology"] = res["stats"]
    prov.setdefault("outputs", {})["geology.png"] = res["sha256"]
    (mdir / "provenance.json").write_text(json.dumps(prov, indent=2, ensure_ascii=False), encoding="utf-8")
    (mdir / "mission.json").write_text(json.dumps(mission, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[geology] jezero: udział w oknie {res['stats']}")
    return 0


if __name__ == "__main__":
    sys.exit(apply())
