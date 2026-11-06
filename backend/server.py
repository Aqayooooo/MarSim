"""Serwer MarSim: API na żywo + pliki UI.   python backend/server.py [port]   →   http://localhost:8000

Każde zapytanie jest sprawdzane modelem (pydantic). Błędne dane dają 422 z czytelnym opisem {"ok": false, "error": "..."},
nigdy 500. Zdarzenia, zgłoszenia i harmonogram zapisuje baza SQLite (backend/live/store.py).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path
from typing import Literal, Optional

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from fastapi import FastAPI, HTTPException, Query, Request  # noqa: E402
from fastapi.exceptions import RequestValidationError  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel, ConfigDict, Field, field_validator  # noqa: E402
from starlette.exceptions import HTTPException as StarletteHTTPException  # noqa: E402

from backend.live import report  # noqa: E402
from backend.live.engine import EvaEngine  # noqa: E402
from backend.live.store import Store  # noqa: E402
from backend.paths import MISSIONS, data_dir  # noqa: E402

log = logging.getLogger("marsim")
CFG = json.loads((ROOT / "backend" / "config" / "mission.json").read_text(encoding="utf-8"))
MISSION_DIR = MISSIONS / CFG["id"]
VERSION = "1.1"


# ---------------- modele zapytań ----------------
class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Point(BaseModel):
    x: float = Field(ge=-1e5, le=1e5)
    y: float = Field(ge=-1e5, le=1e5)


class Waypoint(Point):
    model_config = ConfigDict(extra="allow")
    id: str = Field(min_length=1, max_length=20)
    stopMin: float = Field(default=0, ge=0, le=600)


class PlanRequest(Strict):
    start: Optional[Point] = None
    waypoints: Optional[list[Waypoint]] = Field(default=None, min_length=1, max_length=20)
    letter: str = Field(default="A", pattern=r"^[A-Z]$")
    obstacles: Optional[list[dict]] = None   # przeszkody zna backend sam (zgłoszenia); pole akceptowane dla zgodności z UI


class EvaStart(Strict):
    timeScale: Optional[float] = Field(default=None, gt=0, le=5000)
    scenario: Optional[bool] = None


class TimeScale(Strict):
    timeScale: float = Field(gt=0, le=5000)


class Inject(Strict):
    kind: Literal["boulders", "sep", "sep-end", "link-outage"]


class Telemetry(Strict):
    id: str = Field(min_length=1, max_length=20)
    o2L: Optional[float] = Field(default=None, ge=0, le=5000)
    co2mmHg: Optional[float] = Field(default=None, ge=0, le=100)
    batteryPct: Optional[float] = Field(default=None, ge=0, le=100)
    hr: Optional[int] = Field(default=None, ge=20, le=250)
    x: Optional[float] = None
    y: Optional[float] = None


class Observation(Strict):
    kind: Literal["glazy", "piasek", "osuwisko", "inne", "bezpieczne"]
    x: float
    y: float
    radiusM: float = Field(default=20, ge=1, le=500)
    source: Literal["załoga", "łazik", "dron"] = "załoga"


class LinkMessage(Strict):
    text: str = Field(min_length=1, max_length=500)
    kind: str = Field(default="wiadomość", max_length=40)


class ScheduleItem(Strict):
    id: str = Field(min_length=1, max_length=20, pattern=r"^[\w\-]+$")
    sol: int = Field(ge=0, le=100000)
    startLtst: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    durationH: float = Field(gt=0, le=12)
    crew: list[str] = Field(min_length=1, max_length=8)
    purpose: str = Field(default="wyjście", max_length=200)

    @field_validator("crew")
    @classmethod
    def known_crew(cls, v):
        ids = {c["id"] for c in CFG["crew"]}
        bad = [c for c in v if c not in ids]
        if bad:
            raise ValueError(f"nieznany członek załogi: {', '.join(bad)} (dostępni: {', '.join(sorted(ids))})")
        return v


def _err(status: int, msg: str) -> JSONResponse:
    return JSONResponse({"ok": False, "error": msg}, status_code=status)


def _validation_text(exc: RequestValidationError) -> str:
    parts = []
    for e in exc.errors():
        loc = ".".join(str(x) for x in e.get("loc", []) if x != "body")
        parts.append(f"{loc or 'treść'}: {e.get('msg', 'błędna wartość')}")
    return "Błędne dane zapytania — " + "; ".join(parts)


# ---------------- aplikacja ----------------
def create_app(store: Store | None = None, start_loop: bool = True, live_feeds: bool = True) -> FastAPI:
    if not (MISSION_DIR / "mission.json").exists():
        raise SystemExit(f"Brak danych misji w {MISSION_DIR}. Uruchom najpierw: python backend/build.py")
    store = store or Store(Path(os.environ.get("MARSIM_DB", data_dir() / "marsim.db")))
    engine = EvaEngine(MISSION_DIR, CFG, store=store, live_feeds=live_feeds)
    area = engine.mission["area"]
    app = FastAPI(title="MarSim API", version=VERSION)
    app.state.engine = engine

    if start_loop:
        def _loop():
            last = time.perf_counter()
            while True:
                time.sleep(0.1)
                now = time.perf_counter()
                try:
                    engine.step(now - last)
                except Exception:   # błąd kroku nie może zatrzymać habitatu
                    log.exception("Błąd kroku symulacji")
                last = now
        threading.Thread(target=_loop, daemon=True).start()

    @app.exception_handler(RequestValidationError)
    async def _bad_request(_req: Request, exc: RequestValidationError):
        return _err(422, _validation_text(exc))

    @app.exception_handler(StarletteHTTPException)
    async def _http(_req: Request, exc: StarletteHTTPException):
        return _err(exc.status_code, str(exc.detail))

    @app.exception_handler(Exception)
    async def _crash(_req: Request, exc: Exception):
        log.exception("Nieobsłużony błąd")
        store.log("błąd", f"Błąd serwera: {type(exc).__name__}: {exc}"[:500])
        return _err(500, "Błąd wewnętrzny serwera (zapisany w dzienniku zdarzeń)")

    def inside(x: float, y: float):
        if not (0 <= x <= area["widthM"] and 0 <= y <= area["heightM"]):
            raise HTTPException(422, f"Punkt ({x:.0f}, {y:.0f}) poza obszarem mapy 0–{area['widthM']} × 0–{area['heightM']} m")

    @app.get("/api/health")
    def health():
        return {"ok": True, "mission": CFG["id"], "synthetic": False, "version": VERSION, "session": store.session}

    @app.get("/missions/current/{name}")
    def mission_file(name: str):
        p = (MISSION_DIR / name).resolve()
        if MISSION_DIR.resolve() not in p.parents or not p.is_file():
            raise HTTPException(404, "Nie ma takiego pliku misji")
        return FileResponse(p, headers={"Cache-Control": "no-store"})

    @app.post("/api/plan")
    def plan(body: Optional[PlanRequest] = None):
        body = body or PlanRequest()
        if body.start:
            inside(body.start.x, body.start.y)
        for w in body.waypoints or []:
            inside(w.x, w.y)
        r = engine.plan(body.start.model_dump() if body.start else None,
                        [w.model_dump() for w in body.waypoints] if body.waypoints else None, body.letter)
        return r if r.get("ok", True) else JSONResponse(r, status_code=409)

    @app.get("/api/route")
    def route():
        with engine.lock:
            return {"version": engine.route_version, "route": engine.route, "discarded": engine.discarded}

    @app.get("/api/state")
    def state():
        return engine.snapshot()

    @app.get("/api/stream")
    async def stream():
        async def gen():
            while True:
                yield f"data: {json.dumps(engine.snapshot(), ensure_ascii=False, default=float)}\n\n"
                await asyncio.sleep(0.25)
        return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})

    def _status():
        return {"ok": True, "running": engine.running, "timeScale": engine.time_scale}

    @app.post("/api/eva/start")
    def eva_start(body: Optional[EvaStart] = None):
        body = body or EvaStart()
        with engine.lock:
            if not engine.route:
                r = engine.plan()
                if not r.get("ok", True) and "path" not in r:
                    return JSONResponse(r, status_code=409)
            engine.running = True
            if body.timeScale is not None:
                engine.time_scale = body.timeScale
            if body.scenario is not None:
                engine.scenario = body.scenario
            engine.add_log("EVA", f"Start EVA ×{engine.time_scale:.0f}")
        return _status()

    @app.post("/api/eva/pause")
    def eva_pause():
        with engine.lock:
            engine.running = False
        return _status()

    @app.post("/api/eva/reset")
    def eva_reset():
        engine.reset()
        return _status()

    @app.post("/api/eva/timescale")
    def eva_timescale(body: TimeScale):
        with engine.lock:
            engine.time_scale = body.timeScale
        return _status()

    @app.post("/api/eva/inject")
    def eva_inject(body: Inject):
        r = engine.inject(body.kind)
        return r if r.get("ok", True) else JSONResponse({"ok": False, "error": "Zdarzenie wymaga wyznaczonej trasy"}, status_code=409)

    @app.post("/api/telemetry")
    def telemetry(d: Telemetry):
        """Wejście dla prawdziwego skafandra. Wyłącza model dla tej osoby."""
        with engine.lock:
            for c in engine.crew:
                if c["cfg"]["id"] == d.id:
                    c["source"] = "skafander"
                    p = c["person"]
                    if d.o2L is not None:
                        p.o2_l = min(d.o2L, p.o2_capacity_l)
                    if d.co2mmHg is not None:
                        c["co2mmHg"] = d.co2mmHg
                    if d.batteryPct is not None:
                        p.battery_left_wh = p.battery_wh * d.batteryPct / 100
                    return {"ok": True}
        raise HTTPException(404, f"Nieznany członek załogi: {d.id}")

    @app.get("/api/observations")
    def observations():
        return {"observations": engine.observations, "obstacles": engine.obstacles}

    @app.get("/api/observations/history")
    def observations_history(limit: int = Query(200, ge=1, le=5000)):
        return {"observations": store.observations(limit)}

    @app.post("/api/observations")
    def add_observation(obs: Observation):
        inside(obs.x, obs.y)
        return engine.add_observation(obs.model_dump())

    @app.get("/api/log")
    def event_log(limit: int = Query(100, ge=1, le=5000), session: Optional[int] = Query(None, ge=1)):
        return {"session": store.session, "events": store.events(limit, session)}

    @app.get("/api/spaceweather")
    def spaceweather():
        return engine.spaceweather or {"available": False, "summary": "pobieranie…"}

    @app.get("/api/link")
    def link():
        return engine.link.status(engine.t)

    @app.post("/api/link/send")
    def link_send(d: LinkMessage):
        with engine.lock:
            b = engine.link.send(engine.t, d.kind, d.text, reply="Kontrola misji: wiadomość odebrana")
        return {"id": b.id, "deliverInMin": round((b.deliver_s - engine.t) / 60, 1)}

    @app.get("/api/schedule")
    def schedule():
        return engine.scheduler.evaluate()

    @app.post("/api/schedule")
    def schedule_upsert(item: ScheduleItem):
        engine.scheduler.upsert(item.model_dump())
        engine.add_log("harmonogram", f"Zapisano {item.id}: sol {item.sol}, {item.startLtst}, {item.durationH:g} h", to_earth=False)
        return engine.scheduler.evaluate()

    @app.delete("/api/schedule/{item_id}")
    def schedule_delete(item_id: str):
        if not any(i["id"] == item_id for i in engine.scheduler.items):
            raise HTTPException(404, f"Nie ma wyjścia {item_id}")
        engine.scheduler.delete(item_id)
        engine.add_log("harmonogram", f"Usunięto {item_id}", to_earth=False)
        return engine.scheduler.evaluate()

    @app.get("/api/report")
    def get_report():
        with engine.lock:
            return report.build(engine)

    @app.get("/api/provenance")
    def provenance():
        return engine.provenance

    @app.get("/")
    def index():
        return FileResponse(ROOT / "index.html", headers={"Cache-Control": "no-store"})

    @app.get("/styles.css")
    def styles():
        return FileResponse(ROOT / "styles.css", headers={"Cache-Control": "no-store"})

    # tylko pliki interfejsu — nie cały katalog projektu (bez .git, konfiguracji, bazy)
    app.mount("/src", StaticFiles(directory=ROOT / "src"), name="src")
    app.mount("/vendor", StaticFiles(directory=ROOT / "vendor"), name="vendor")
    app.mount("/data/demo", StaticFiles(directory=ROOT / "data" / "demo"), name="demo")
    return app


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8000))
    host = os.environ.get("MARSIM_HOST", "127.0.0.1")
    application = create_app()
    print(f"MarSim: http://localhost:{port}", flush=True)
    uvicorn.run(application, host=host, port=port, log_level="warning")
