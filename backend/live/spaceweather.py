"""Pogoda kosmiczna z prawdziwych źródeł: NASA DONKI (SEP, CME, rozbłyski) i NOAA SWPC (strumień protonów GOES).

Dane dotyczą okolic Ziemi. Mars bywa po drugiej stronie Słońca, więc to wskaźnik orientacyjny —
dla misji potrzebny byłby monitor przy Marsie (np. RAD, przyszłe sondy). Wyniki są buforowane na dysku,
żeby habitat działał bez łączności (ostatni znany stan + wiek danych).
"""
from __future__ import annotations

import json
import os
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from backend import __version__
from backend.paths import CACHE

DONKI = "https://api.nasa.gov/DONKI/{kind}?startDate={start}&endDate={end}&api_key={key}"
NOAA_PROTONS = "https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json"
CACHE_FILE = CACHE / "spaceweather.json"


def _get(url: str, timeout: int = 40):
    req = urllib.request.Request(url, headers={"User-Agent": f"MarSim/{__version__}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch(api_key: str | None = None, days: int = 7) -> dict:
    api_key = api_key or os.environ.get("NASA_API_KEY", "DEMO_KEY")   # własny klucz: https://api.nasa.gov
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=days)
    out = {"fetchedUtc": datetime.now(timezone.utc).isoformat(timespec="seconds"), "errors": []}
    for kind in ("SEP", "CME", "FLR"):
        try:
            out[kind.lower()] = _get(DONKI.format(kind=kind, start=start, end=end, key=api_key)) or []
        except Exception as e:
            out[kind.lower()] = []
            out["errors"].append(f"DONKI {kind}: {e}")
    try:
        prot = _get(NOAA_PROTONS)
        ge10 = [p for p in prot if p.get("energy") == ">=10 MeV"]
        out["protons10MeV"] = [{"t": p["time_tag"], "pfu": p["flux"]} for p in ge10[-120:]]
    except Exception as e:
        out["protons10MeV"] = []
        out["errors"].append(f"NOAA: {e}")
    return out


def get(max_age_s: int = 1800) -> dict:
    """Bufor: najpierw świeże dane z sieci, a gdy jej brak — ostatnie zapisane."""
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = None
    if CACHE_FILE.exists():
        try:
            cached = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            cached = None
        if cached and time.time() - CACHE_FILE.stat().st_mtime < max_age_s:
            return summarize(cached, source="bufor")
    try:
        data = fetch()
        if not data.get("protons10MeV") and cached and cached.get("protons10MeV"):
            data["protons10MeV"] = cached["protons10MeV"]
            data["protonsStale"] = True
        if len(data["errors"]) < 4:
            temporary = CACHE_FILE.with_suffix(".tmp")
            temporary.write_text(json.dumps(data), encoding="utf-8")
            temporary.replace(CACHE_FILE)
            return summarize(data, source="sieć")
    except Exception:
        pass
    if cached:
        return summarize(cached, source="bufor (brak sieci)")
    return {"available": False, "source": "brak danych", "pfu": 0.0, "events": [], "summary": "Brak danych o pogodzie kosmicznej"}


def summarize(d: dict, source: str) -> dict:
    pfu = d["protons10MeV"][-1]["pfu"] if d.get("protons10MeV") else None
    events = []
    for s in d.get("sep", [])[-5:]:
        events.append({"type": "SEP", "time": s.get("eventTime"), "note": "zdarzenie cząstek energetycznych"})
    for c in d.get("cme", [])[-5:]:
        an = (c.get("cmeAnalyses") or [{}])[0] or {}
        events.append({"type": "CME", "time": c.get("startTime"), "note": f"prędkość {an.get('speed', '?')} km/s"})
    for f in d.get("flr", [])[-5:]:
        events.append({"type": "FLR", "time": f.get("peakTime"), "note": f"rozbłysk klasy {f.get('classType', '?')}"})
    events.sort(key=lambda e: e["time"] or "", reverse=True)
    value = pfu or 0
    level = "S4+" if value >= 10000 else "S3" if value >= 1000 else "S2" if value >= 100 else "S1" if value >= 10 else "brak"
    return {"available": True, "source": source, "fetchedUtc": d.get("fetchedUtc"), "protonsAvailable": pfu is not None, "protonsStale": d.get("protonsStale", False), "protonsTime": d.get("protons10MeV", [{}])[-1].get("t") if d.get("protons10MeV") else None, "pfu": round(float(pfu), 3) if pfu is not None else None, "stormLevel": level if pfu is not None else "brak danych",
            "events": events[:8], "errors": d.get("errors", []),
            "summary": "Brak aktualnego pomiaru protonów NOAA" if pfu is None else ("Ostatni pomiar (nieaktualny): " if d.get("protonsStale") else "") + f"Protony ≥10 MeV przy Ziemi: {value:.2f} pfu (burza: {level}); zdarzenia DONKI z 7 dni: {len(events)}".replace(".", ","),
            "note": "Pomiary przy Ziemi — dla Marsa wskaźnik orientacyjny."}
