"""Tworzy data-sources.json (wykaz użytych danych) z plików provenance.json wszystkich zbudowanych misji.

    python tools/make_data_sources.py
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MISSIONS = ROOT / "data" / "missions"

SC = {
    "MRO HiRISE": ("Mars Reconnaissance Orbiter", "HiRISE", "NASA/JPL-Caltech/University of Arizona"),
    "Mars Odyssey THEMIS": ("2001 Mars Odyssey", "THEMIS", "NASA/JPL-Caltech/Arizona State University; mosaic: USGS Astrogeology"),
    "MRO CTX": ("Mars Reconnaissance Orbiter", "CTX", "NASA/JPL-Caltech/Malin Space Science Systems; mosaic: USGS Astrogeology"),
    "MGS MOLA": ("Mars Global Surveyor", "MOLA", "NASA/GSFC; mosaic: USGS Astrogeology"),
    "MRO CRISM": ("Mars Reconnaissance Orbiter", "CRISM", "NASA/JPL-Caltech/JHUAPL; parameters: Viviano-Beck et al. (2014), JGR Planets 119"),
}

# opis i użycie według rodzaju produktu (rozpoznawany po identyfikatorze)
KINDS = [
    ("DTEEC_", ("HiRISE stereo digital terrain model (DTM), 1.01 m/px", "Model wysokości HiRISE (DTM), 1,01 m/px",
                "terrain, slope ±σ, 3D view, route planning, radio line of sight, terrain shadows",
                "teren, nachylenie ±σ, widok 3D, planowanie trasy, zasięg radiowy, cienie")),
    ("_RED_A_01_ORTHO", ("HiRISE orthoimage 0.25 m/px", "Ortoobraz HiRISE 0,25 m/px",
                         "boulder detection (shadow method), sand indicators (darkness, ripples)",
                         "wykrywanie głazów (metoda cieni), wskaźniki piasku (ciemność, zmarszczki)")),
    ("_RED_C_01_ORTHO", ("HiRISE orthoimage 1 m/px", "Ortoobraz HiRISE 1 m/px", "base map (Optical layer)", "mapa bazowa (warstwa Optyczna)")),
    ("THEMIS_NightIR", ("THEMIS night-time infrared controlled mosaic, 100 m/px (USGS)", "Mozaika THEMIS w podczerwieni nocnej, 100 m/px (USGS)",
                        "Thermal layer: qualitative thermal inertia (loose sand vs bedrock), sand indicator",
                        "warstwa Termiczna: jakościowa bezwładność termiczna (piasek vs skała), wskaźnik piasku")),
    ("_CTX_BlockAdj", ("CTX mosaic, ~5 m/px (USGS Human Exploration Zones)", "Mozaika CTX, ~5 m/px (USGS)",
                       "consistency check of the HiRISE image", "kontrola spójności zdjęcia HiRISE")),
    ("MOLA", ("MOLA global elevation model, 463 m/px", "Globalny model wysokości MOLA, 463 m/px",
              "absolute elevation check of the DTM", "kontrola wysokości bezwzględnej DTM")),
    ("_MTR3", ("CRISM map-projected targeted reduced data record (MTRDR), summary parameters, 18 m/px",
               "CRISM MTRDR (produkt odwzorowany), parametry sumaryczne, 18 m/px",
               "Minerals layer: olivine, pyroxene, hydration and sulfate indices (informational, does not change the hazard map)",
               "warstwa Minerały: oliwin, piroksen, wskaźniki uwodnienia i siarczanów (informacyjna, nie zmienia mapy zagrożeń)")),
    ("_RED", ("HiRISE PDS image label", "Etykieta PDS zdjęcia HiRISE",
              "Sun incidence/azimuth for the shadow method, image time, emission angle for DTM precision",
              "kąt i azymut Słońca do metody cieni, czas zdjęcia, kąt emisji do oceny dokładności DTM")),
]

LIVE = [
    {"id": "DONKI", "type": "live API", "provider": "NASA CCMC (Space Weather Database Of Notifications, Knowledge, Information)",
     "description": {"en": "Solar energetic particle (SEP), CME and flare events, last 7 days", "pl": "Zdarzenia SEP, CME i rozbłyski z ostatnich 7 dni"},
     "usedFor": {"en": "radiation risk, space weather alerts, report", "pl": "ryzyko promieniowania, alarmy pogody kosmicznej, raport"},
     "url": "https://api.nasa.gov/DONKI/", "access": "live, cached for offline use (NASA_API_KEY or DEMO_KEY)", "credit": "NASA CCMC"},
    {"id": "NOAA-SWPC-GOES-integral-protons", "type": "live API", "provider": "NOAA Space Weather Prediction Center",
     "description": {"en": "GOES integral proton flux ≥10 MeV, 1 day", "pl": "Strumień protonów ≥10 MeV z GOES, 1 doba"},
     "usedFor": {"en": "solar storm level (S-scale) indicator", "pl": "wskaźnik poziomu burzy słonecznej (skala S)"},
     "url": "https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json", "access": "live, cached for offline use", "credit": "NOAA SWPC"},
    {"id": "MSL-RAD-dose-rate", "type": "published measurement", "provider": "Curiosity Radiation Assessment Detector (Hassler et al., Science 2014)",
     "description": {"en": "Surface dose rate in Gale crater ≈ 0.64 mSv/sol (GCR background)", "pl": "Dawka na powierzchni w kraterze Gale ≈ 0,64 mSv/sol (tło GCR)"},
     "usedFor": {"en": "background dose rate and crew dose budget", "pl": "tło dawki i bilans dawki załogi"},
     "url": "https://doi.org/10.1126/science.1244797", "access": "constant in model", "credit": "NASA/JPL-Caltech/SwRI"},
    {"id": "NASA-STD-3001", "type": "standard", "provider": "NASA",
     "description": {"en": "NASA Space Flight Human-System Standard Vol. 1 — career radiation limit 600 mSv", "pl": "Norma NASA-STD-3001 t. 1 — limit dawki w karierze 600 mSv"},
     "usedFor": {"en": "career dose limit in the dose card", "pl": "limit dawki w karcie dawki"},
     "url": "https://www.nasa.gov/ochmo/human-system-standards/", "access": "constant in model", "credit": "NASA OCHMO"},
    {"id": "Allison-McEwen-2000", "type": "algorithm", "provider": "Allison & McEwen, Planetary and Space Science 48 (2000) — basis of NASA GISS Mars24",
     "description": {"en": "Mars Sun position and local solar time", "pl": "Położenie Słońca i czas słoneczny na Marsie"},
     "usedFor": {"en": "terrain shadows, sunset, daylight rules, thermal model", "pl": "cienie terenu, zmierzch, reguły dnia, model cieplny"},
     "url": "https://www.giss.nasa.gov/tools/mars24/help/algorithm.html", "access": "implemented in backend/models/sun.py", "credit": "NASA GISS"},
]


def describe(pid: str):
    for key, v in KINDS:
        if key in pid:
            return v
    return (pid, pid, "", "")


def main():
    sources: dict[str, dict] = {}
    areas = []
    for mdir in sorted(MISSIONS.iterdir()):
        pf = mdir / "provenance.json"
        if not pf.exists():
            continue
        prov = json.loads(pf.read_text(encoding="utf-8"))
        mission = json.loads((mdir / "mission.json").read_text(encoding="utf-8"))
        areas.append({"mission": mdir.name, "name": (mission["mission"].get("label") or {}).get("en", mdir.name),
                      "centerLat": prov["area"]["center"]["lat"], "centerLonEast": prov["area"]["center"]["lon"],
                      "sizeM": [prov["area"]["widthM"], prov["area"]["heightM"]], "pipelineVersion": prov["pipelineVersion"], "builtUtc": prov["builtUtc"]})
        for s in prov["sources"]:
            sc, ins, credit = SC[s["instrument"]]
            en, pl, use_en, use_pl = describe(s["id"])
            item = sources.setdefault(s["id"], {
                "id": s["id"], "type": "orbital", "spacecraft": sc, "instrument": ins, "missions": [],
                "description": {"en": en, "pl": pl}, "usedFor": {"en": use_en, "pl": use_pl}, "url": s["url"],
                "access": "remote window (only the area of interest is read)" if s.get("access") == "zdalny fragment" else "downloaded file",
                **({"bytes": s["bytes"]} if s.get("bytes") else {}), **({"sha256": s["sha256"]} if s.get("sha256") else {}), "credit": credit})
            item["missions"].append(mdir.name)
    out = {
        "name": "MarSim",
        "description": {"en": "Data used by MarSim (Mars EVA map and planner). Generated by tools/make_data_sources.py from data/missions/*/provenance.json plus live feeds.",
                        "pl": "Dane użyte w MarSim (mapa i planer EVA na Marsie). Wygenerowane przez tools/make_data_sources.py z data/missions/*/provenance.json oraz źródeł na żywo."},
        "areas": areas,
        "crs": "Mars 2000 sphere (IAU), planetocentric latitude, east longitude",
        "notUsed": {"en": ["Mastcam / rover images: the waypoint view is a render from the HiRISE DTM, not a photograph",
                           "Synthetic sample data in data/demo/ (used only without the backend)"],
                    "pl": ["Mastcam / zdjęcia z łazika: widok w punkcie trasy to render z DTM HiRISE, nie zdjęcie",
                           "Syntetyczne dane przykładowe w data/demo/ (tylko bez backendu)"]},
        "usage": {"en": "NASA data are generally not subject to copyright in the US; credit the instrument teams as listed.",
                  "pl": "Dane NASA zasadniczo nie podlegają prawu autorskiemu w USA; należy podać źródło jak w polu credit."},
        "sources": list(sources.values()) + LIVE,
    }
    (ROOT / "data-sources.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"data-sources.json: {len(areas)} obszary, {len(out['sources'])} źródeł")


if __name__ == "__main__":
    main()
