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
from pydantic import BaseModel, ConfigDict, Field  # noqa: E402
from starlette.exceptions import HTTPException as StarletteHTTPException  # noqa: E402

from backend.live import report  # noqa: E402
from backend.live.engine import EvaEngine  # noqa: E402
from backend.live.store import Store  # noqa: E402
from backend import missions as mis  # noqa: E402
from backend.paths import MISSIONS, data_dir  # noqa: E402

log = logging.getLogger("marsim")
VERSION = "1.2"


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


class MissionSelect(Strict):
    id: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9\-]+$")


def _err(status: int, msg: str) -> JSONResponse:
    return JSONResponse({"ok": False, "error": msg}, status_code=status)


def _validation_text(exc: RequestValidationError) -> str:
    parts = []
    for e in exc.errors():
        loc = ".".join(str(x) for x in e.get("loc", []) if x != "body")
        parts.append(f"{loc or 'treść'}: {e.get('msg', 'błędna wartość')}")
    return "Błędne dane zapytania — " + "; ".join(parts)


# ---------------- aplikacja ----------------
def available_missions() -> list[str]:
    """Misje z konfiguracją i zbudowanymi danymi (data/missions/<id>/mission.json)."""
    return [m for m in mis.ids() if (MISSIONS / m / "mission.json").exists()]


def create_app(store: Store | None = None, start_loop: bool = True, live_feeds: bool = True,
               db_dir: Path | None = None, mission: str | None = None) -> FastAPI:
    """store: baza dla misji startowej (testy); db_dir: katalog baz marsim-<misja>.db (domyślnie katalog danych)."""
    ready = available_missions()
    if not ready:
        raise SystemExit("Brak danych misji w data/missions/. Uruchom najpierw: python backend/build.py")
    first = mission or os.environ.get("MARSIM_MISSION") or (mis.DEFAULT if mis.DEFAULT in ready else ready[0])
    if first not in ready:
        raise SystemExit(f"Misja „{first}” nie jest zbudowana. Dostępne: {', '.join(ready)}")
    db_dir = Path(db_dir or os.environ.get("MARSIM_DB_DIR", data_dir()))
    engines: dict[str, EvaEngine] = {}
    lock = threading.RLock()
    current = {"active": first}

    def engine_for(mid: str) -> EvaEngine:
        with lock:
            if mid not in engines:
                st = store if (store is not None and mid == first) else Store(db_dir / f"marsim-{mid}.db")
                engines[mid] = EvaEngine(MISSIONS / mid, mis.config(mid), store=st, live_feeds=live_feeds)
            return engines[mid]

    def E() -> EvaEngine:
        return engine_for(current["active"])

    def S() -> Store:
        return E().store

    engine_for(first)
    app = FastAPI(title="MarSim API", version=VERSION)
    app.state.engines = engines
    app.state.active = lambda: E()

    if start_loop:
        def _loop():
            last = time.perf_counter()
            while True:
                time.sleep(0.1)
                now = time.perf_counter()
                try:
                    E().step(now - last)          # krok tylko aktywnej misji
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
        S().log("błąd", f"Błąd serwera: {type(exc).__name__}: {exc}"[:500])
        return _err(500, "Błąd wewnętrzny serwera (zapisany w dzienniku zdarzeń)")

    def inside(x: float, y: float):
        area = E().mission["area"]
        if not (0 <= x <= area["widthM"] and 0 <= y <= area["heightM"]):
            raise HTTPException(422, f"Punkt ({x:.0f}, {y:.0f}) poza obszarem mapy 0–{area['widthM']} × 0–{area['heightM']} m")

    @app.get("/api/health")
    def health():
        return {"ok": True, "mission": current["active"], "synthetic": False, "version": VERSION, "session": S().session}

    @app.get("/api/missions")
    def missions_list():
        out = []
        for mid in available_missions():
            m = json.loads((MISSIONS / mid / "mission.json").read_text(encoding="utf-8"))
            out.append({"id": mid, "title": m["mission"]["title"], "label": m["mission"].get("label") or {"pl": mid, "en": mid},
                        "center": m["area"]["center"], "active": mid == current["active"]})
        return {"active": current["active"], "missions": out}

    @app.post("/api/missions/select")
    def missions_select(body: MissionSelect):
        if body.id not in available_missions():
            raise HTTPException(404, f"Nie ma zbudowanej misji „{body.id}”")
        with lock:
            if current["active"] != body.id:
                old = current["active"]
                E().running = False                     # poprzednia misja zostaje wstrzymana
                current["active"] = body.id
                E().add_log("EVA", f"Przełączono misję: {old} → {body.id}", to_earth=False)
        return {"ok": True, "active": current["active"]}

    @app.get("/missions/current/{name}")
    def mission_file(name: str):
        mdir = MISSIONS / current["active"]
        p = (mdir / name).resolve()
        if mdir.resolve() not in p.parents or not p.is_file():
            raise HTTPException(404, "Nie ma takiego pliku misji")
        return FileResponse(p, headers={"Cache-Control": "no-store"})

    @app.post("/api/plan")
    def plan(body: Optional[PlanRequest] = None):
        body = body or PlanRequest()
        if body.start:
            inside(body.start.x, body.start.y)
        for w in body.waypoints or []:
            inside(w.x, w.y)
        r = E().plan(body.start.model_dump() if body.start else None,
                        [w.model_dump() for w in body.waypoints] if body.waypoints else None, body.letter)
        return r if r.get("ok", True) else JSONResponse(r, status_code=409)

    @app.get("/api/route")
    def route():
        with E().lock:
            return {"version": E().route_version, "route": E().route, "discarded": E().discarded}

    @app.get("/api/state")
    def state():
        return E().snapshot()

    @app.get("/api/stream")
    async def stream():
        async def gen():
            while True:
                yield f"data: {json.dumps(E().snapshot(), ensure_ascii=False, default=float)}\n\n"
                await asyncio.sleep(0.25)
        return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})

    def _status():
        return {"ok": True, "running": E().running, "timeScale": E().time_scale}

    @app.post("/api/eva/start")
    def eva_start(body: Optional[EvaStart] = None):
        body = body or EvaStart()
        with E().lock:
            if not E().route:
                r = E().plan()
                if not r.get("ok", True) and "path" not in r:
                    return JSONResponse(r, status_code=409)
            E().running = True
            if body.timeScale is not None:
                E().time_scale = body.timeScale
            if body.scenario is not None:
                E().scenario = body.scenario
            E().add_log("EVA", f"Start EVA ×{E().time_scale:.0f}")
        return _status()

    @app.post("/api/eva/pause")
    def eva_pause():
        with E().lock:
            E().running = False
        return _status()

    @app.post("/api/eva/reset")
    def eva_reset():
        E().reset()
        return _status()

    @app.post("/api/eva/timescale")
    def eva_timescale(body: TimeScale):
        with E().lock:
            E().time_scale = body.timeScale
        return _status()

    @app.post("/api/eva/inject")
    def eva_inject(body: Inject):
        r = E().inject(body.kind)
        return r if r.get("ok", True) else JSONResponse({"ok": False, "error": "Zdarzenie wymaga wyznaczonej trasy"}, status_code=409)

    @app.post("/api/telemetry")
    def telemetry(d: Telemetry):
        """Wejście dla prawdziwego skafandra. Wyłącza model dla tej osoby."""
        with E().lock:
            for c in E().crew:
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
        return {"observations": E().observations, "obstacles": E().obstacles}

    @app.get("/api/observations/history")
    def observations_history(limit: int = Query(200, ge=1, le=5000)):
        return {"observations": S().observations(limit)}

    @app.post("/api/observations")
    def add_observation(obs: Observation):
        inside(obs.x, obs.y)
        return E().add_observation(obs.model_dump())

    @app.get("/api/log")
    def event_log(limit: int = Query(100, ge=1, le=5000), session: Optional[int] = Query(None, ge=1)):
        return {"session": S().session, "events": S().events(limit, session)}

    @app.get("/api/spaceweather")
    def spaceweather():
        return E().spaceweather or {"available": False, "summary": "pobieranie…"}

    @app.get("/api/link")
    def link():
        return E().link.status(E().t)

    @app.post("/api/link/send")
    def link_send(d: LinkMessage):
        with E().lock:
            b = E().link.send(E().t, d.kind, d.text, reply="Kontrola misji: wiadomość odebrana")
        return {"id": b.id, "deliverInMin": round((b.deliver_s - E().t) / 60, 1)}

    @app.get("/api/schedule")
    def schedule():
        return E().scheduler.evaluate()

    @app.post("/api/schedule")
    def schedule_upsert(item: ScheduleItem):
        ids = {c["id"] for c in E().cfg["crew"]}
        bad = [c for c in item.crew if c not in ids]
        if bad:
            raise HTTPException(422, f"Błędne dane zapytania — crew: nieznany członek załogi: {', '.join(bad)} (dostępni: {', '.join(sorted(ids))})")
        E().scheduler.upsert(item.model_dump())
        E().add_log("harmonogram", f"Zapisano {item.id}: sol {item.sol}, {item.startLtst}, {item.durationH:g} h", to_earth=False)
        return E().scheduler.evaluate()

    @app.delete("/api/schedule/{item_id}")
    def schedule_delete(item_id: str):
        if not any(i["id"] == item_id for i in E().scheduler.items):
            raise HTTPException(404, f"Nie ma wyjścia {item_id}")
        E().scheduler.delete(item_id)
        E().add_log("harmonogram", f"Usunięto {item_id}", to_earth=False)
        return E().scheduler.evaluate()

    @app.get("/api/report")
    def get_report():
        with E().lock:
            return report.build(E())

    @app.get("/api/provenance")
    def provenance():
        return E().provenance

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
