"""Przykładowe dane z backendu dla wersji bez serwera (np. GitHub Pages).

Uruchamia prawdziwy backend w tym procesie (FastAPI TestClient, bez serwera HTTP) i dla każdej misji:
  1. wyznacza trasę tak, jak robi to interfejs (Dijkstra na koszcie O₂ + warianty „dlaczego ta trasa”),
  2. przeprowadza EVA ze scenariuszem: głazy na trasie → nowa trasa, alarm SEP (20 min), odpowiedzi z Ziemi,
  3. zapisuje odpowiedzi API do data/missions/<id>/backend/*.json, a listę misji do data/missions/index.json.
Interfejs bez backendu czyta te pliki zamiast API (raport, plan wyjść, pogoda kosmiczna, dziennik, trasa A).

Bazy SQLite i bufor powstają w katalogu tymczasowym — prawdziwy katalog danych (MARSIM_DATA) zostaje nietknięty.
Pogoda kosmiczna jest pobierana z sieci (NASA DONKI, NOAA SWPC); bez sieci zapisuje się „brak danych”.

Uruchomienie z katalogu projektu:  .venv/Scripts/python.exe tools/export_backend_sample.py
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="marsim-sample-"))
os.environ["MARSIM_DATA"] = str(TMP)  # przed importem backendu: bufor pogody i bazy w katalogu tymczasowym
os.environ.pop("MARSIM_DB_DIR", None)
sys.path.insert(0, str(REPO))

from fastapi.testclient import TestClient

from backend import missions as mis
from backend import server
from backend.live import spaceweather

FILES = ["plan", "report", "spaceweather", "log", "state", "schedule"]
STEP_S = 15.0  # krok symulacji (sekundy misji)
SEP_MIN = 20  # tyle trwa alarm SEP w scenariuszu
EARTH_WAIT_MIN = 45  # po ostatnim punkcie: czas na odpowiedzi z Ziemi (opóźnienie światła w obie strony)
CAP_H = 8.0  # bezpiecznik: maks. czas EVA


def rnd(o, nd: int = 3):
    """Zaokrągla liczby, żeby pliki były małe (metry z dokładnością do mm to i tak za dużo)."""
    if isinstance(o, float):
        return round(o, nd)
    if isinstance(o, list):
        return [rnd(v, nd) for v in o]
    if isinstance(o, dict):
        return {k: rnd(v, nd) for k, v in o.items()}
    return o


def ok(resp):
    if resp.status_code >= 400:
        raise SystemExit(f"{resp.request.method} {resp.request.url.path}: {resp.status_code} {resp.text[:300]}")
    return resp.json()


def write(path: Path, data) -> int:
    text = json.dumps(rnd(data), ensure_ascii=False, separators=(",", ":"))
    text = re.sub(r"api_key=[^&\s\"]+", "api_key=***", text)  # na wszelki wypadek: klucz NASA nie trafia do repozytorium
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + "\n", encoding="utf-8")
    return len(text)


def run_eva(E, c) -> float | None:
    """Krok po kroku aż do ostatniego punktu i jeszcze chwilę (odpowiedzi z Ziemi). Zwraca czas dojścia [s]."""
    sep_at, finished_at = None, None
    while E.t < CAP_H * 3600:
        E.step(STEP_S / E.time_scale)
        if E.sep and sep_at is None:
            sep_at = E.t
        if E.sep and sep_at is not None and E.t - sep_at >= SEP_MIN * 60:
            ok(c.post("/api/eva/inject", json={"kind": "sep-end"}))
        if finished_at is None and E.next_wp >= len(E.wp_s) and E.t / 60 >= E.stop_until:
            finished_at = E.t
        if finished_at is not None and E.t - finished_at >= EARTH_WAIT_MIN * 60:
            break
    return finished_at


def export_mission(mid: str, sw: dict, generated: str) -> dict:
    app = server.create_app(start_loop=False, live_feeds=False, db_dir=TMP, mission=mid)
    E = app.state.active()
    E.spaceweather = sw
    m = E.mission
    # dokładnie to zapytanie wysyła interfejs przy pierwszym planowaniu (App.planInitial)
    req = {
        "start": {"x": m["rover"]["x"], "y": m["rover"]["y"]},
        "waypoints": [{k: w[k] for k in ("id", "x", "y", "stopMin") if k in w} for w in m["waypoints"]],
    }
    out = {}
    with TestClient(app) as c:
        out["plan"] = {"request": req, "response": ok(c.post("/api/plan", json=req))}
        ok(c.post("/api/eva/start", json={"timeScale": 60, "scenario": True}))
        finished_at = run_eva(E, c)
        ok(c.post("/api/eva/pause"))
        out["report"] = ok(c.get("/api/report"))
        out["spaceweather"] = ok(c.get("/api/spaceweather"))
        out["log"] = ok(c.get("/api/log", params={"limit": 12}))
        snap = ok(c.get("/api/state"))
        out["state"] = {k: snap[k] for k in ("t", "clock", "link")}  # tylko to, czego potrzebuje raport (łącze z Ziemią)
        out["schedule"] = ok(c.get("/api/schedule"))
        listing = ok(c.get("/api/missions"))
    for eng in app.state.engines.values():
        eng.store.close()

    folder = REPO / "data" / "missions" / mid / "backend"
    sizes = {name: write(folder / f"{name}.json", out[name]) for name in FILES}
    meta = {
        "generatedUtc": generated,
        "backendVersion": server.VERSION,
        "mission": mid,
        "files": FILES,
        "eva": {
            "route": E.route["letter"] if E.route else None,
            "reachedMin": round(finished_at / 60) if finished_at else None,
            "events": sorted(E.fired),
            "spaceweather": sw.get("source"),
        },
        "note": "Zapis odpowiedzi API z prawdziwego backendu (tools/export_backend_sample.py). "
        "Interfejs bez serwera pokazuje je tylko do odczytu.",
    }
    write(folder / "meta.json", meta)
    route = out["plan"]["response"]
    print(
        f"  {mid}: trasa A {route['lengthM']:.0f} m / {route['o2L']:.0f} L O₂, {len(route.get('alternatives') or [])} warianty · "
        f"EVA do trasy {meta['eva']['route']}, zdarzenia {meta['eva']['events']}, dojście po {meta['eva']['reachedMin']} min · "
        f"{sum(sizes.values()) / 1024:.0f} KB"
    )
    return listing


def main():
    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print("Pogoda kosmiczna (NASA DONKI, NOAA SWPC)…")
    sw = spaceweather.get()
    print(f"  {sw.get('source')}: {sw.get('summary')}")
    ids = server.available_missions()
    print(f"Misje: {', '.join(ids)}")
    listing = None
    for mid in ids:
        listing = export_mission(mid, sw, generated)
    index = {
        "generatedUtc": generated,
        "default": mis.DEFAULT if mis.DEFAULT in ids else ids[0],
        "missions": [{k: x[k] for k in ("id", "title", "label", "center")} for x in listing["missions"]],
    }
    write(REPO / "data" / "missions" / "index.json", index)
    print("Zapisano data/missions/index.json i data/missions/<id>/backend/*.json")


if __name__ == "__main__":
    try:
        main()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
