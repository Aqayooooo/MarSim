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
from contextvars import ContextVar
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

from backend import __version__ as VERSION  # noqa: E402
from backend import missions as mis  # noqa: E402
from backend.live import report  # noqa: E402
from backend.live.engine import EvaEngine  # noqa: E402
from backend.live.store import Store  # noqa: E402
from backend.paths import MISSIONS, data_dir  # noqa: E402

log = logging.getLogger("marsim")
STEP_INTERVAL_S = 0.1        # krok pętli symulacji (czas rzeczywisty)
STREAM_INTERVAL_S = 0.25     # odstęp między stanami w strumieniu SSE
MISSION_HEADER = "X-MarSim-Mission"


# ---------------- modele zapytań ----------------
class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Point(BaseModel):
    x: float = Field(ge=-1e5, le=1e5)
    y: float = Field(ge=-1e5, le=1e5)


class Waypoint(Point):
    model_config = ConfigDict(extra="allow")     # interfejs odsyła punkty z mission.json razem z polami opisowymi
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
    def _no_duplicates(cls, crew: list[str]) -> list[str]:
        if len(set(crew)) != len(crew):
            raise ValueError("ta sama osoba wpisana więcej niż raz")
        return crew


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
    # Misja przypięta do zapytania: przełączenie misji w trakcie obsługi nie zmienia silnika w połowie.
    request_mission: ContextVar[str | None] = ContextVar("request_mission", default=None)

    def engine_for(mission_id: str) -> EvaEngine:
        with lock:
            if mission_id not in engines:
                db = store if (store is not None and mission_id == first) else Store(db_dir / f"marsim-{mission_id}.db")
                engines[mission_id] = EvaEngine(MISSIONS / mission_id, mis.config(mission_id), store=db, live_feeds=live_feeds)
            return engines[mission_id]

    def active() -> EvaEngine:
        return engine_for(request_mission.get() or current["active"])

    engine_for(first)
    app = FastAPI(title="MarSim API", version=VERSION)
    app.state.engines = engines
    app.state.active = active

    if start_loop:
        def simulation_loop():
            last = time.perf_counter()
            while True:
                time.sleep(STEP_INTERVAL_S)
                now = time.perf_counter()
                try:
                    active().step(now - last)          # krok tylko aktywnej misji
                except Exception:   # błąd kroku nie może zatrzymać habitatu
                    log.exception("Błąd kroku symulacji")
                last = now
        threading.Thread(target=simulation_loop, daemon=True).start()

    @app.middleware("http")
    async def pin_mission(request: Request, call_next):
        """Odrzuca zmiany wysłane do nieaktualnej misji i wymusza sprawdzanie plików interfejsu u serwera (ETag)."""
        expected = request.headers.get(MISSION_HEADER)
        if request.method in ("POST", "PUT", "DELETE") and expected and expected != current["active"]:
            return _err(409, "Misja została zmieniona. Odśwież stronę.")
        path = request.url.path
        token = request_mission.set(None if path == "/api/missions/select" else current["active"])
        try:
            response = await call_next(request)
        finally:
            request_mission.reset(token)
        if path.startswith(("/src/", "/vendor/fonts/")) or path in ("/", "/styles.css"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.exception_handler(RequestValidationError)
    async def bad_request(_request: Request, exc: RequestValidationError):
        return _err(422, _validation_text(exc))

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_request: Request, exc: StarletteHTTPException):
        return _err(exc.status_code, str(exc.detail))

    @app.exception_handler(Exception)
    async def crash(_request: Request, exc: Exception):
        log.exception("Nieobsłużony błąd")
        active().store.log("błąd", f"Błąd serwera: {type(exc).__name__}: {exc}"[:500])
        return _err(500, "Błąd wewnętrzny serwera (zapisany w dzienniku zdarzeń)")

    def require_inside(eng: EvaEngine, x: float, y: float) -> None:
        area = eng.mission["area"]
        if not (0 <= x <= area["widthM"] and 0 <= y <= area["heightM"]):
            raise HTTPException(422, f"Punkt ({x:.0f}, {y:.0f}) poza obszarem mapy 0–{area['widthM']} × 0–{area['heightM']} m")

    def require_known_crew(eng: EvaEngine, crew: list[str]) -> None:
        known = {c["id"] for c in eng.cfg["crew"]}
        unknown = [c for c in crew if c not in known]
        if unknown:
            raise HTTPException(422, f"Błędne dane zapytania — crew: nieznany członek załogi: {', '.join(unknown)} "
                                     f"(dostępni: {', '.join(sorted(known))})")

    def status(eng: EvaEngine) -> dict:
        return {"ok": True, "running": eng.running, "timeScale": eng.time_scale, "phase": eng.phase}

    # ---------- misje i pliki ----------
    @app.get("/api/health")
    def health():
        eng = active()
        return {"ok": True, "mission": current["active"], "synthetic": bool(eng.mission.get("synthetic", False)),
                "version": VERSION, "session": eng.store.session}

    @app.get("/api/missions")
    def missions_list():
        out = []
        for mission_id in available_missions():
            m = json.loads((MISSIONS / mission_id / "mission.json").read_text(encoding="utf-8"))
            out.append({"id": mission_id, "title": m["mission"]["title"],
                        "label": m["mission"].get("label") or {"pl": mission_id, "en": mission_id},
                        "center": m["area"]["center"], "active": mission_id == current["active"]})
        return {"active": current["active"], "missions": out}

    @app.post("/api/missions/select")
    def missions_select(body: MissionSelect):
        if body.id not in available_missions():
            raise HTTPException(404, f"Nie ma zbudowanej misji „{body.id}”")
        with lock:
            previous = current["active"]
            if previous != body.id:
                engine_for(previous).pause()            # poprzednia misja zostaje wstrzymana
                current["active"] = body.id
                engine_for(body.id).add_log("EVA", f"Przełączono misję: {previous} → {body.id}", to_earth=False)
        return {"ok": True, "active": current["active"]}

    @app.get("/missions/{mission_id}/{name}")
    def mission_file(mission_id: str, name: str):
        selected = active().cfg["id"] if mission_id == "current" else mission_id
        if selected not in ready:
            raise HTTPException(404, "Nie ma takiej misji")
        mission_dir = (MISSIONS / selected).resolve()
        path = (mission_dir / name).resolve()
        if mission_dir not in path.parents or not path.is_file():
            raise HTTPException(404, "Nie ma takiego pliku misji")
        return FileResponse(path, headers={"Cache-Control": "no-store"})

    # ---------- trasa i przebieg EVA ----------
    @app.post("/api/plan")
    def plan(body: Optional[PlanRequest] = None):
        body = body or PlanRequest()
        eng = active()
        for point in [body.start, *(body.waypoints or [])]:
            if point is not None:
                require_inside(eng, point.x, point.y)
        route = eng.plan(body.start.model_dump() if body.start else None,
                         [w.model_dump() for w in body.waypoints] if body.waypoints else None, body.letter)
        return route if route["ok"] else JSONResponse(route, status_code=409)

    @app.get("/api/route")
    def route():
        eng = active()
        with eng.lock:
            return {"version": eng.route_version, "route": eng.route, "discarded": eng.discarded}

    @app.get("/api/state")
    def state():
        return active().snapshot()

    @app.get("/api/stream")
    async def stream():
        async def events():
            while True:
                snapshot = await asyncio.to_thread(lambda: active().snapshot())
                yield f"data: {json.dumps(snapshot, ensure_ascii=False, default=float)}\n\n"
                await asyncio.sleep(STREAM_INTERVAL_S)
        return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})

    @app.post("/api/eva/start")
    def eva_start(body: Optional[EvaStart] = None):
        body = body or EvaStart()
        eng = active()
        problem = eng.start(body.timeScale, body.scenario)
        return _err(409, problem) if problem else status(eng)

    @app.post("/api/eva/pause")
    def eva_pause():
        eng = active()
        eng.pause()
        return status(eng)

    @app.post("/api/eva/reset")
    def eva_reset():
        eng = active()
        eng.reset()
        return status(eng)

    @app.post("/api/eva/timescale")
    def eva_timescale(body: TimeScale):
        eng = active()
        with eng.lock:
            eng.time_scale = body.timeScale
        return status(eng)

    @app.post("/api/eva/return")
    def eva_return():
        """Powrót do habitatu od bieżącej pozycji załogi; po dojściu do śluzy EVA się kończy."""
        result = active().return_to_habitat()
        return result if result["ok"] else JSONResponse(result, status_code=409)

    @app.post("/api/eva/inject")
    def eva_inject(body: Inject):
        result = active().inject(body.kind)
        return result if result.get("ok", True) else JSONResponse(result, status_code=409)

    # ---------- telemetria i zgłoszenia ----------
    @app.post("/api/telemetry")
    def telemetry(body: Telemetry):
        """Wejście dla prawdziwego skafandra. Wyłącza model dla tej osoby."""
        values = body.model_dump(exclude_none=True, exclude={"id"})
        if not values:
            raise HTTPException(422, "Brak pomiarów telemetrii")
        eng = active()
        if ("x" in values) != ("y" in values):
            raise HTTPException(422, "Pozycja wymaga x i y")
        if "x" in values:
            require_inside(eng, body.x, body.y)
        if not eng.apply_telemetry(body.id, values):
            raise HTTPException(404, f"Nieznany członek załogi: {body.id}")
        return {"ok": True}

    @app.get("/api/observations")
    def observations():
        eng = active()
        return {"observations": eng.observations, "obstacles": eng.obstacles}

    @app.get("/api/observations/history")
    def observations_history(limit: int = Query(200, ge=1, le=5000)):
        return {"observations": active().store.observations(limit)}

    @app.post("/api/observations")
    def add_observation(body: Observation):
        eng = active()
        require_inside(eng, body.x, body.y)
        return eng.add_observation(body.model_dump())

    @app.get("/api/log")
    def event_log(limit: int = Query(100, ge=1, le=5000), session: Optional[int] = Query(None, ge=1)):
        db = active().store
        return {"session": db.session, "events": db.events(limit, session)}

    # ---------- pogoda kosmiczna i łączność ----------
    @app.get("/api/spaceweather")
    def spaceweather():
        return active().spaceweather or {"available": False, "summary": "pobieranie…"}

    @app.get("/api/link")
    def link():
        eng = active()
        return eng.link.status(eng.t)

    @app.post("/api/link/send")
    def link_send(body: LinkMessage):
        eng = active()
        with eng.lock:
            bundle = eng.link.send(eng.t, body.kind, body.text, reply="Kontrola misji: wiadomość odebrana")
            return {"id": bundle.id, "deliverInMin": round((bundle.deliver_s - eng.t) / 60, 1)}

    # ---------- harmonogram wyjść ----------
    @app.get("/api/schedule")
    def schedule():
        return active().scheduler.evaluate()

    def save_schedule_item(eng: EvaEngine, item: ScheduleItem, verb: str) -> dict:
        require_known_crew(eng, item.crew)
        eng.scheduler.upsert(item.model_dump())
        eng.add_log("harmonogram", f"{verb} {item.id}: sol {item.sol}, {item.startLtst}, {item.durationH:g} h", to_earth=False)
        return eng.scheduler.evaluate()

    @app.post("/api/schedule")
    def schedule_create(item: ScheduleItem):
        eng = active()
        with eng.lock:
            if eng.scheduler.has(item.id):
                raise HTTPException(409, "Identyfikator wyjścia jest już zajęty")
            return save_schedule_item(eng, item, "Zapisano")

    @app.put("/api/schedule/{item_id}")
    def schedule_update(item_id: str, item: ScheduleItem):
        eng = active()
        with eng.lock:
            if item_id != item.id or not eng.scheduler.has(item_id):
                raise HTTPException(404, f"Nie ma wyjścia {item_id}")
            return save_schedule_item(eng, item, "Zmieniono")

    @app.delete("/api/schedule/{item_id}")
    def schedule_delete(item_id: str):
        eng = active()
        with eng.lock:
            if not eng.scheduler.has(item_id):
                raise HTTPException(404, f"Nie ma wyjścia {item_id}")
            eng.scheduler.delete(item_id)
            eng.add_log("harmonogram", f"Usunięto {item_id}", to_earth=False)
            return eng.scheduler.evaluate()

    # ---------- raport i pochodzenie danych ----------
    @app.get("/api/report")
    def get_report():
        eng = active()
        with eng.lock:
            return report.build(eng)

    @app.get("/api/provenance")
    def provenance():
        return active().provenance

    # ---------- interfejs ----------
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
