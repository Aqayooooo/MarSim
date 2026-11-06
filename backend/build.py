"""Potok danych MarSim: produkty NASA → pliki misji dla UI (data/missions/<id>/) + pochodzenie danych.

    python backend/build.py                      # pełne przetwarzanie misji domyślnej (z pamięcią podręczną kroków)
    python backend/build.py --mission jezero     # inna misja (backend/config/missions/<id>.json)
    python backend/build.py --fresh              # bez pamięci podręcznej
    python backend/build.py --only-minerals      # tylko warstwa CRISM
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from rasterio.enums import Resampling  # noqa: E402

from backend.models import sun  # noqa: E402
from backend.models.physiology import Person  # noqa: E402
from backend.paths import CACHE as CACHE_ROOT, MISSIONS, RAW  # noqa: E402
from backend import missions  # noqa: E402
from backend.pipeline import boulders as bld  # noqa: E402
from backend.pipeline import environment as env  # noqa: E402
from backend.pipeline import sand as snd  # noqa: E402
from backend.pipeline import terrain as ter  # noqa: E402
from backend.pipeline import minerals as mnr  # noqa: E402
from backend.pipeline.grid import block_mean, cache_remote_window, grid_from_center, open_crs, read_into  # noqa: E402
from backend import planning  # noqa: E402

PIPELINE_VERSION = "1.1.0"
MISSION_ID = missions.from_argv()
CFG = missions.config(MISSION_ID)
SOURCES = {p["id"]: p for p in missions.sources(MISSION_ID)["products"]}
PROD = CFG["products"]
CACHE = CACHE_ROOT / MISSION_ID
S3 = "/vsicurl/https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/"
EXTRA = {
    **{k: {**v, "url": S3 + v["path"]} for k, v in CFG.get("extra", {}).items()},
    "mola": {
        "id": "Mars_MGS_MOLA_DEM_mosaic_global_463m", "instrument": "MGS MOLA",
        "description": "Globalny model wysokości MOLA 463 m/px — kontrola wysokości bezwzględnej DTM",
        "url": S3 + "Mars_MGS_MOLA_DEM_mosaic_global_463m.tif"},
}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def load_manifest() -> dict:
    f = RAW / f"manifest-{MISSION_ID}.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def label_value(text: str, key: str):
    m = re.search(rf"^\s*{key}\s*=\s*\"?([^\"<\n]+)", text, re.M)
    return m.group(1).strip() if m else None


def cached(name: str, fn, fresh: bool):
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"{name}.npz"
    if f.exists() and not fresh:
        d = np.load(f, allow_pickle=True)
        return {k: d[k] for k in d.files} if len(d.files) > 1 else d[d.files[0]]
    t = time.time()
    out = fn()
    if isinstance(out, dict):
        np.savez_compressed(f, **out)
    else:
        np.savez_compressed(f, a=out)
    log(f"  {name}: {time.time() - t:.1f} s")
    return out


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def png_gray(path: Path, a: np.ndarray):
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), mode="L").save(path, optimize=True)


CRISM_ID = PROD.get("crism")


def build_minerals(out: Path, g1) -> dict | None:
    """Warstwa minerałów z CRISM (gdy plik jest pobrany). Zwraca {"layer", "source", "stats", "method"} albo None."""
    p = SOURCES.get(CRISM_ID) if CRISM_ID else None
    if not p or not (RAW / p["file"]).exists():
        log("CRISM: brak pliku — warstwa minerałów pominięta (python backend/fetch_data.py)")
        return None
    log("Minerały: parametry sumaryczne CRISM (18 m/px)")
    params = mnr.read_params(g1.with_res(18.0), str(RAW / p["file"]))
    cls, conf = mnr.classify(params)
    png_gray(out / "minerals.png", cls)
    png_gray(out / "mineralsConfidence.png", conf * 255)
    st = mnr.stats(cls, params)
    present = [k for k in mnr.CLASSES if (cls == k).any()]
    classes = {str(k): {"color": mnr.CLASSES[k]["color"], "text": mnr.CLASSES[k]["text"]} for k in present}
    layer = {"id": "minerals", "name": "Minerały", "desc": "CRISM 18 m/px", "colorOff": "#2f4a2a", "colorOn": "#7CC36E",
             "raster": {"file": "minerals.png", "encoding": "png-class8", "width": int(cls.shape[1]), "height": int(cls.shape[0]),
                        "cellM": 18, "classes": classes},
             "legend": [{"color": mnr.CLASSES[k]["color"], "text": mnr.CLASSES[k]["text"]} for k in present]}
    log(f"  klasy: {st['fractions']}, mediana OLINDEX3 {st['olindex3Median']}")
    manifest = load_manifest()
    f = RAW / p["file"]
    source = {"id": CRISM_ID, "instrument": p["instrument"], "description": p["description"], "url": p["url"],
              "sha256": manifest.get(CRISM_ID, {}).get("sha256") or sha256(f), "bytes": f.stat().st_size, "access": "plik lokalny"}
    rules = "; ".join(f"{k}: {c['text']} ({c['rule']})" for k, c in mnr.CLASSES.items())
    method = f"CRISM MTRDR, parametry Viviano-Beck i in. (2014); klasy: {rules}. Warstwa informacyjna — nie zmienia mapy zagrożeń."
    return {"layer": layer, "source": source, "stats": st, "method": method}


def insert_layer(layers: list, layer: dict) -> list:
    layers = [x for x in layers if x["id"] != layer["id"]]
    i = next((k + 1 for k, x in enumerate(layers) if x["id"] == "thermal"), len(layers))
    return layers[:i] + [layer] + layers[i:]


def only_minerals() -> int:
    """Dodaje/odświeża warstwę minerałów w istniejącej misji bez przeliczania reszty potoku."""
    out = MISSIONS / CFG["id"]
    a = CFG["aoi"]
    crs = open_crs(str(RAW / f"dtm_window_{CFG['id']}.tif"))
    g1 = grid_from_center(crs, a["centerLon"], a["centerLat"], a["widthM"], a["heightM"], 1.0)
    res = build_minerals(out, g1)
    if not res:
        return 1
    mission = json.loads((out / "mission.json").read_text(encoding="utf-8"))
    prov = json.loads((out / "provenance.json").read_text(encoding="utf-8"))
    mission["layers"] = insert_layer(mission["layers"], res["layer"])
    mission["mission"]["sourceLabel"] = "Dane NASA: HiRISE, THEMIS, CTX, MOLA, CRISM"
    prov["sources"] = [s for s in prov["sources"] if s["id"] != CRISM_ID] + [res["source"]]
    prov["methods"]["minerals"] = res["method"]
    prov["stats"]["minerals"] = res["stats"]
    prov["pipelineVersion"] = PIPELINE_VERSION
    for name in ("minerals.png", "mineralsConfidence.png"):
        prov.setdefault("outputs", {})[name] = sha256(out / name)
    (out / "provenance.json").write_text(json.dumps(prov, indent=2, ensure_ascii=False), encoding="utf-8")
    (out / "mission.json").write_text(json.dumps(mission, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"Gotowe: warstwa minerałów → {out}")
    return 0


def main() -> int:
    if "--only-minerals" in sys.argv:
        return only_minerals()
    fresh = "--fresh" in sys.argv
    out = MISSIONS / CFG["id"]
    out.mkdir(parents=True, exist_ok=True)
    dtm_url = "/vsicurl/" + SOURCES[PROD["dtm"]]["url"]
    ortho_a = str(RAW / SOURCES[PROD["orthoA"]]["file"])
    ortho_c = str(RAW / SOURCES[PROD["orthoC"]]["file"])
    lbl_img = (RAW / SOURCES[PROD["image"] + "_RED"]["file"]).read_text(encoding="latin-1")
    lbl_pair = (RAW / SOURCES[PROD["pair"] + "_RED"]["file"]).read_text(encoding="latin-1")

    a = CFG["aoi"]
    log("Siatka obszaru (układ DTM HiRISE)")
    crs = open_crs(dtm_url)
    g1 = grid_from_center(crs, a["centerLon"], a["centerLat"], a["widthM"], a["heightM"], 1.0)
    g3, g025 = g1.with_res(3.0), g1.with_res(0.25)
    corners = g1.corners_lonlat()

    log("DTM HiRISE (odczyt zdalny fragmentu)")
    RAW.mkdir(parents=True, exist_ok=True)
    dtm_local = cache_remote_window(dtm_url, g1, str(RAW / f"dtm_window_{CFG['id']}.tif"))
    dem1 = cached("dem1", lambda: ter.fill_nan(read_into(g1, dtm_local, resampling=Resampling.bilinear)), fresh)
    dem3 = block_mean(dem1, 3).astype(np.float32)
    cell = 3.0

    log("Ortoobrazy HiRISE")
    # ortoobrazy z katalogu DTM są w układzie DTM (GDAL źle czyta układ z nagłówka JP2 przy równoleżniku ≠ 0°)
    img1 = cached("img1", lambda: read_into(g1, ortho_c, resampling=Resampling.average, src_crs=crs), fresh)
    img025 = cached("img025", lambda: read_into(g025, ortho_a, resampling=Resampling.bilinear, src_crs=crs), fresh)
    for im in (img1, img025):
        im[im <= 0] = np.nan

    log("THEMIS (podczerwień nocna), CTX i MOLA — odczyt zdalny")
    th_local = cache_remote_window(EXTRA["themis"]["url"], g1, str(RAW / f"themis_window_{CFG['id']}.tif"), margin_m=1500)
    ctx_local = cache_remote_window(EXTRA["ctx"]["url"], g1, str(RAW / f"ctx_window_{CFG['id']}.tif"), margin_m=300)
    mola_local = cache_remote_window(EXTRA["mola"]["url"], g1, str(RAW / f"mola_window_{CFG['id']}.tif"), margin_m=3000)
    themis1 = cached("themis1", lambda: read_into(g1, th_local, resampling=Resampling.bilinear), fresh)
    themis100 = cached("themis100", lambda: read_into(g1.with_res(100.0), th_local, resampling=Resampling.average), fresh)
    ctx6 = cached("ctx6", lambda: read_into(g1.with_res(6.0), ctx_local, resampling=Resampling.average), fresh)
    mola = cached("mola", lambda: read_into(g1.with_res(120.0), mola_local, resampling=Resampling.bilinear), fresh)

    # ---------- geometria zdjęć i dokładność DTM ----------
    inc = float(label_value(lbl_img, "INCIDENCE_ANGLE"))
    sub_az = float(label_value(lbl_img, "SUB_SOLAR_AZIMUTH"))
    north_az = float(label_value(lbl_img, "NORTH_AZIMUTH"))
    sun_elev_img = 90.0 - inc
    sun_az_img = (sub_az - north_az) % 360.0          # od północy, zgodnie z ruchem wskazówek
    em1 = float(label_value(lbl_img, "EMISSION_ANGLE")); em2 = float(label_value(lbl_pair, "EMISSION_ANGLE"))
    ep = ter.expected_precision(0.25, em1, em2)
    sigma_z = max(ep["epM"], CFG["eva"]["sigmaZMinM"])
    img_time = label_value(lbl_img, "START_TIME"); pair_time = label_value(lbl_pair, "START_TIME")

    log("Nachylenie ± σ, nierówności")
    slope, slope_sigma = ter.slope_with_sigma(dem3, cell, sigma_z / math.sqrt(3))  # uśrednienie 3×3 próbek 1 m
    rough1 = ter.roughness(dem1)
    rough3 = block_mean(rough1, 3)

    log("Piasek: ciemność, gładkość, zmarszczki, THEMIS, DTM")
    img05 = block_mean(img025, 2)
    ind = {
        "darkness": snd.darkness(img1),
        "ripples": cached("ripples", lambda: snd.ripple_score(img05, 0.5), fresh)[::2, ::2][:img1.shape[0], :img1.shape[1]],
        "thermal": snd.thermal_score(themis1),
        "imageSmooth": snd.image_smoothness(img1),
        "dtmSmooth": snd.dtm_smoothness(rough1),
    }
    if ind["ripples"].shape != img1.shape:
        from scipy import ndimage
        r = ind["ripples"]; ind["ripples"] = ndimage.zoom(r, (img1.shape[0] / r.shape[0], img1.shape[1] / r.shape[1]), order=1)[:img1.shape[0], :img1.shape[1]]
    sand1, sand_conf1, weights = snd.combine(ind)
    sand3, sand_conf3 = block_mean(sand1, 3), block_mean(sand_conf1, 3)

    log("Głazy: metoda cieni na zdjęciu 0,25 m")
    sand025 = np.repeat(np.repeat(sand1, 4, 0), 4, 1)[:img025.shape[0], :img025.shape[1]] > 0.5
    boulders = bld.detect(img025, 0.25, sun_az_img, sun_elev_img, exclude=sand025)
    log(f"  wykryto {len(boulders)} kandydatów (≥1 m)")
    bdens = bld.density_raster(boulders, a["widthM"], a["heightM"], cell)

    log("Klasy zagrożeń")
    H, W = dem3.shape
    slope_up = slope + 2 * slope_sigma
    yy, xx = (np.mgrid[0:H, 0:W] + 0.5) * cell
    bblock = np.zeros((H, W), bool)
    for b in boulders:
        if b["confidence"] >= 0.5 and b["heightM"] >= 0.5:
            r = b["diameterM"] / 2 + 1.0
            i0, i1 = max(0, int((b["y"] - r) // cell)), min(H, int((b["y"] + r) // cell) + 1)
            j0, j1 = max(0, int((b["x"] - r) // cell)), min(W, int((b["x"] + r) // cell) + 1)
            bblock[i0:i1, j0:j1] |= np.hypot(xx[i0:i1, j0:j1] - b["x"], yy[i0:i1, j0:j1] - b["y"]) < r
    eva = CFG["eva"]
    forbidden = (slope_up > eva["maxSlopeDeg"]) | (sand3 > 0.6) | bblock
    caution = (slope_up > eva["cautionSlopeDeg"]) | (sand3 > 0.35) | (rough3 > 0.5) | (bdens > 1.0)
    hazard = np.where(forbidden, 2, np.where(caution, 1, 0)).astype(np.uint8)
    layers = {"slope": slope, "slopeSigma": slope_sigma, "sand": sand3, "sandConfidence": sand_conf3, "hazard": hazard}

    log("Łączność z habitatem (linia widoczności)")
    hab = CFG["habitat"]
    comms = env.viewshed(dem3, cell, (hab["x"], hab["y"]), hab["mastM"], eva["rxHeightM"])
    comms_cls = np.where(comms > 2.0, 2, np.where(comms > 0, 1, 0)).astype(np.uint8)

    log("Oświetlenie: położenie Słońca (Allison & McEwen 2000) i cienie terenu")
    lon_c, lat_c = g1.lonlat(a["widthM"] / 2, a["heightM"] / 2)
    mt = sun.mars_time(datetime.fromisoformat(CFG["missionDateUtc"].replace("Z", "+00:00")))
    sun_table = []
    for hour in range(6, 19):
        el, az = sun.sun_position(lat_c, mt.decl, hour)
        mask = env.shadow_mask(dem3, cell, el, az)
        png_gray(out / f"shadow_{hour:02d}.png", mask * 255)
        sun_table.append({"ltst": hour, "elevDeg": round(el, 2), "azDeg": round(az, 2), "shadowFrac": round(float(mask.mean()), 3)})

    log("Koszt marszu i pole „ile tlenu do habitatu” (granica powrotu)")
    c0 = CFG["crew"][0]
    person = Person(c0["id"], c0["bodyKg"], c0["loadKg"], c0["o2CapacityL"], c0["o2CapacityL"])
    model = planning.CostModel(layers, cell, eva, person)
    o2_home = planning.cost_field(model, hab, "o2")
    t_home = planning.cost_field(model, hab, "time")

    # ---------- zapis plików dla UI ----------
    log("Zapis plików misji")
    (dem3 - np.nanmin(dem3)).astype("<f4").tofile(out / "dem.f32")
    lo, hi = np.nanpercentile(img1, [0.5, 99.5])
    png_gray(out / "optical.png", np.nan_to_num((img1 - lo) / (hi - lo) * 255, nan=0))
    png_gray(out / "hazards.png", hazard)
    png_gray(out / "sand.png", sand3 * 255)
    png_gray(out / "sandConfidence.png", sand_conf3 * 255)
    png_gray(out / "comms.png", comms_cls)
    slope.astype("<f4").tofile(out / "slope.f32")
    slope_sigma.astype("<f4").tofile(out / "slopeSigma.f32")
    np.nan_to_num(o2_home, posinf=9999).astype("<f4").tofile(out / "o2ToHabitat.f32")
    np.nan_to_num(t_home, posinf=9e6).astype("<f4").tofile(out / "timeToHabitat.f32")
    th = themis100.copy(); th[th <= 0] = np.nan
    tlo, thi = np.nanpercentile(th, [2, 98])
    png_gray(out / "thermal.png", np.nan_to_num((th - tlo) / (thi - tlo + 1e-6) * 255, nan=128))
    (out / "boulders.json").write_text(json.dumps({"sunAzDeg": round(sun_az_img, 2), "sunElevDeg": round(sun_elev_img, 2),
                                                   "pixelM": 0.25, "minDiameterM": 1.0, "boulders": boulders}), encoding="utf-8")

    mins = build_minerals(out, g1)

    # kontrola spójności z MOLA i CTX
    mola_off = float(np.nanmean(dem1) - np.nanmean(mola[mola > -1e4])) if np.isfinite(mola).any() else None
    ctx_corr = None
    if np.isfinite(ctx6).any():
        hr6 = block_mean(img1, 6)
        m = np.isfinite(hr6) & np.isfinite(ctx6)
        if m.sum() > 100:
            ctx_corr = float(np.corrcoef(hr6[m], ctx6[m])[0, 1])

    # ---------- pochodzenie danych ----------
    manifest = load_manifest()
    prov_sources = []
    for pid, p in SOURCES.items():
        m = manifest.get(pid, {})
        prov_sources.append({"id": pid, "instrument": p["instrument"], "description": p["description"], "url": p["url"],
                             "sha256": m.get("sha256"), "bytes": m.get("bytes"), "access": "zdalny fragment" if p.get("remote") else "plik lokalny"})
    for k, p in EXTRA.items():
        prov_sources.append({"id": p["id"], "instrument": p["instrument"], "description": p["description"],
                             "url": p["url"].replace("/vsicurl/", ""), "sha256": None, "access": "zdalny fragment"})
    prov_sources = [s for s in prov_sources if not (CRISM_ID and s["id"].startswith(CRISM_ID))] + ([mins["source"]] if mins else [])
    provenance = {
        "pipelineVersion": PIPELINE_VERSION, "builtUtc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "crs": crs.to_wkt(), "area": {"widthM": a["widthM"], "heightM": a["heightM"], "corners": corners,
                                      "center": {"lon": round(lon_c, 5), "lat": round(lat_c, 5)},
                                      "note": "Współrzędne planetocentryczne, długość wschodnia, sfera Mars 2000 (IAU)"},
        "sources": prov_sources,
        "imaging": {"image": PROD["image"], "imageTimeUtc": img_time, "pairImage": PROD["pair"], "pairTimeUtc": pair_time,
                    "sunElevDeg": round(sun_elev_img, 2), "sunAzDeg": round(sun_az_img, 2), "emissionDeg": [em1, em2]},
        "dtmPrecision": {**ep, "sigmaZUsedM": sigma_z, "rule": "σz = max(EP, sigmaZMinM)"},
        "methods": {
            "slope": "różnice centralne na siatce 3 m; σ = σz/(√2·d)/(1+g²); do decyzji: nachylenie + 2σ",
            "sand": {"weights": weights, "indicators": list(weights)},
            "boulders": "metoda cieni (próg 2,6σ lokalnego szumu, weryfikacja oświetlonej ściany), wykrywalne ≥1 m",
            "hazard": f"zakaz: nachylenie+2σ > {eva['maxSlopeDeg']}° lub piasek > 0,6 lub głaz (H≥0,5 m); uwaga: nachylenie+2σ > {eva['cautionSlopeDeg']}°, piasek > 0,35, nierówności > 0,5 m, > 1 głaz/100 m²",
            "comms": f"linia widoczności z masztu habitatu {hab['mastM']} m do odbiornika {eva['rxHeightM']} m nad gruntem",
            "illumination": "Allison & McEwen (2000), cienie z DTM co godzinę LTST",
            **({"minerals": mins["method"]} if mins else {}),
        },
        "checks": {"dtmMinusMolaM": None if mola_off is None else round(mola_off, 1),
                   "hiriseVsCtxCorrelation": None if ctx_corr is None else round(ctx_corr, 3)},
        "stats": {"boulders": len(boulders), "bouldersConfident": sum(b["confidence"] >= 0.5 for b in boulders),
                  "sandFraction": round(float((sand3 > 0.5).mean()), 3), "forbiddenFraction": round(float((hazard == 2).mean()), 3),
                  "commsCoverage": round(float((comms_cls > 0).mean()), 3), "slopeSigmaMedianDeg": round(float(np.median(slope_sigma)), 2),
                  **({"minerals": mins["stats"]} if mins else {})},
        "sun": {"missionDateUtc": CFG["missionDateUtc"], "ls": round(mt.ls, 2), "declDeg": round(mt.decl, 3), "rAu": round(mt.r_au, 4),
                "sunsetLtst": round(sun.sunset_ltst(lat_c, mt.decl), 2), "hours": sun_table},
    }
    for f in sorted(out.iterdir()):
        if f.suffix in (".png", ".f32", ".json") and f.name not in ("provenance.json", "mission.json"):
            provenance.setdefault("outputs", {})[f.name] = sha256(f)
    (out / "provenance.json").write_text(json.dumps(provenance, indent=2, ensure_ascii=False), encoding="utf-8")
    write_mission_json(out, H, W, cell, provenance, lat_c, lon_c, mt, th.shape, mins["layer"] if mins else None)
    log(f"Gotowe → {out}")
    print(json.dumps(provenance["stats"], ensure_ascii=False), json.dumps(provenance["checks"]))
    return 0


def write_mission_json(out: Path, H: int, W: int, cell: float, prov: dict, lat: float, lon: float, mt, th_shape, minerals_layer=None):
    a = CFG["aoi"]
    dtm_year = (prov["imaging"]["imageTimeUtc"] or "")[:4]
    mission = {
        "contractVersion": 2,
        "synthetic": False,
        "mission": {"id": CFG["id"], "title": CFG["title"], "label": CFG.get("label"), "sourceLabel": "Dane NASA: HiRISE, THEMIS, CTX, MOLA" + (", CRISM" if minerals_layer else ""),
                    "sol": CFG["sol"], "startClock": CFG["startLtst"], "dateUtc": CFG["missionDateUtc"]},
        "area": {"label": CFG["areaLabel"], "widthM": a["widthM"], "heightM": a["heightM"],
                 "center": {"lat": round(lat, 5), "lon": round(lon, 5)}, "corners": prov["area"]["corners"]},
        "dem": {"file": "dem.f32", "encoding": "float32le", "width": W, "height": H, "cellM": cell, "unit": "m",
                "source": PROD["dtm"], "year": dtm_year, "sigmaZM": prov["dtmPrecision"]["sigmaZUsedM"]},
        "rasters": {
            "slope": {"file": "slope.f32", "encoding": "float32le", "width": W, "height": H, "cellM": cell, "unit": "°"},
            "slopeSigma": {"file": "slopeSigma.f32", "encoding": "float32le", "width": W, "height": H, "cellM": cell, "unit": "°"},
            "o2ToHabitat": {"file": "o2ToHabitat.f32", "encoding": "float32le", "width": W, "height": H, "cellM": cell, "unit": "L"},
            "timeToHabitat": {"file": "timeToHabitat.f32", "encoding": "float32le", "width": W, "height": H, "cellM": cell, "unit": "s"},
        },
        "layers": [
            {"id": "optical", "name": "Optyczna", "desc": "HiRISE 25 cm/px", "colorOff": "#45403F", "colorOn": "#9F9F9E",
             "raster": {"file": "optical.png", "encoding": "png-gray8", "width": a["widthM"], "height": a["heightM"], "cellM": 1},
             "legend": [{"color": "#9F9F9E", "text": f"HiRISE {PROD['image']}, {dtm_year}"}]},
            {"id": "terrain", "name": "Teren", "desc": f"nachylenie ±{prov['stats']['slopeSigmaMedianDeg']:.0f}° z DTM", "colorOff": "#65615B", "colorOn": "#F8F0E2",
             "derivedFrom": "slope", "legend": [{"color": "#F8F0E2", "text": "jaśniej = bardziej stromo"}]},
            {"id": "thermal", "name": "Termiczna", "desc": "THEMIS noc 100 m/px", "colorOff": "#1C4753", "colorOn": "#3AAFD7",
             "raster": {"file": "thermal.png", "encoding": "png-gray8", "width": th_shape[1], "height": th_shape[0], "cellM": 100},
             "legend": [{"color": "#20469C", "text": "chłodno nocą: luźny materiał"}, {"color": "#ED5F26", "text": "ciepło nocą: lita skała"}]},
            {"id": "sand", "name": "Piasek", "desc": "5 wskaźników, bez AI", "colorOff": "#5a4a1c", "colorOn": "#E8B13A",
             "raster": {"file": "sand.png", "encoding": "png-gray8", "width": W, "height": H, "cellM": cell},
             "confidence": {"file": "sandConfidence.png", "encoding": "png-gray8", "width": W, "height": H, "cellM": cell},
             "legend": [{"color": "#E8B13A", "text": "prawdopodobieństwo piasku"}, {"color": "#7a6a50", "text": "kreskowanie: niska pewność"}]},
            {"id": "boulders", "name": "Głazy", "desc": "metoda cieni, ≥1 m", "colorOff": "#5b3f2a", "colorOn": "#E6BE79",
             "vector": {"file": "boulders.json"},
             "legend": [{"color": "#E6BE79", "text": "głaz (średnica w skali)"}, {"color": "#8a7660", "text": "niska pewność wykrycia"}]},
            {"id": "hazards", "name": "Zagrożenia", "desc": "nachylenie+2σ, piasek, głazy", "colorOff": "#691C0B", "colorOn": "#FF441F",
             "raster": {"file": "hazards.png", "encoding": "png-class8", "width": W, "height": H, "cellM": cell,
                        "classes": {"1": {"color": "#FFBD33", "text": "uwaga"}, "2": {"color": "#FD4420", "text": "zakaz"}}},
             "legend": [{"color": "#FD4420", "text": "zakaz: piasek, stromo, głazy"}, {"color": "#FFBD33", "text": "uwaga: nierówno"}]},
            {"id": "comms", "name": "Łączność", "desc": f"z habitatu, maszt {CFG['habitat']['mastM']} m", "colorOff": "#2d4a3a", "colorOn": "#5FE0A0",
             "raster": {"file": "comms.png", "encoding": "png-class8", "width": W, "height": H, "cellM": cell,
                        "classes": {"0": {"color": "#C0392B", "text": "brak zasięgu"}, "1": {"color": "#F1C40F", "text": "zasięg na granicy"}}},
             "legend": [{"color": "#C0392B", "text": "brak zasięgu radiowego"}, {"color": "#F1C40F", "text": "zasięg na granicy"}]},
            {"id": "shadow", "name": "Cień", "desc": "o godzinie (suwak)", "colorOff": "#3a3550", "colorOn": "#8E7CC3",
             "hourly": {"pattern": "shadow_{HH}.png", "hours": list(range(6, 19)), "width": W, "height": H, "cellM": cell},
             "legend": [{"color": "#1a1630", "text": "cień terenu o wybranej godzinie"}]},
            {"id": "sky", "name": "Niebo", "desc": "RAD + DONKI + NOAA", "colorOff": "#475E61", "colorOn": "#A7E9FB",
             "legend": [{"color": "#A7E9FB", "text": "wiatr z modelu, dawka z pomiaru RAD"}]},
        ],
        "habitat": CFG["habitat"],
        "rover": CFG["rover"],
        "waypoints": [{**w, "view": {"source": "render", "caption": "Render z DTM HiRISE · widok z hełmu"} if i == len(CFG["waypoints"]) - 1 else None}
                      for i, w in enumerate(CFG["waypoints"])],
        "crew": [{"id": c["id"], "o2": 100, "o2RatePctH": 12} for c in CFG["crew"]],
        "eva": {**CFG["eva"], "sepO2Factor": 1.25, "o2ReservePct": CFG["eva"]["o2ReservePct"]},
        "environment": {"doseUsvh": 26.7, "dustTau": 0.5, "wind": {"meanMs": 6, "spreadMs": 1.5, "fromDeg": 315},
                        "temperature": [["06:00", -85], ["09:20", -50], ["13:30", -5], ["18:00", -40]]},
        "sun": prov["sun"],
        "events": [
            {"id": "boulders", "type": "obstacle", "trigger": {"afterWaypoint": "WP1", "afterM": 40}, "aheadM": 150, "radiusM": 35,
             "source": "zgłoszenie z terenu (dron)", "alert": {"category": "ZAGROŻENIE", "text": "Dron: pole głazów na trasie, {dist} m przed nami"}},
            {"id": "sep", "type": "space-weather", "source": "DONKI", "trigger": {"afterEvent": "boulders", "afterMin": 3},
             "alert": {"category": "POGODA KOSMICZNA", "text": "ostrzeżenie SEP · łazik jedzie do załogi"}},
        ],
    }
    if minerals_layer:
        mission["layers"] = insert_layer(mission["layers"], minerals_layer)
    (out / "mission.json").write_text(json.dumps(mission, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
