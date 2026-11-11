"""Serwer MarSim: API na żywo + pliki UI.   python backend/server.py [port]   →   http://localhost:8000

Opcje wiersza poleceń: python backend/server.py --help. Opis API (OpenAPI): /api/docs.

Każde zapytanie jest sprawdzane modelem (pydantic). Błędne dane dają 422 z czytelnym opisem {"ok": false, "error": "..."},
nigdy 500. Zdarzenia, zgłoszenia i harmonogram zapisuje baza SQLite (backend/live/store.py).
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import io
import json
import logging
import os
import sys
import threading
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Literal

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend import __version__ as VERSION
from backend import missions as mis
from backend.live import report
from backend.live.engine import EvaEngine
from backend.live.store import Store
from backend.paths import MISSIONS, data_dir

log = logging.getLogger("marsim")
STEP_INTERVAL_S = 0.1  # krok pętli symulacji (czas rzeczywisty)
STREAM_INTERVAL_S = 0.25  # odstęp między stanami w strumieniu SSE
MISSION_HEADER = "X-MarSim-Mission"
API_META = "marsim-api"  # znacznik <meta> dopisywany do index.html serwowanego przez backend


# ---------------- modele zapytań ----------------
class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Point(BaseModel):
    x: float = Field(ge=-1e5, le=1e5)
    y: float = Field(ge=-1e5, le=1e5)


class Waypoint(Point):
    model_config = ConfigDict(extra="allow")  # interfejs odsyła punkty z mission.json razem z polami opisowymi
    id: str = Field(min_length=1, max_length=20)
    stopMin: float = Field(default=0, ge=0, le=600)


class PlanRequest(Strict):
    start: Point | None = None
    waypoints: list[Waypoint] | None = Field(default=None, min_length=1, max_length=20)
    letter: str = Field(default="A", pattern=r"^[A-Z]$")
    obstacles: list[dict] | None = None  # przeszkody zna backend sam (zgłoszenia); pole akceptowane dla zgodności z UI


class EvaStart(Strict):
    timeScale: float | None = Field(default=None, gt=0, le=5000)
    scenario: bool | None = None


class TimeScale(Strict):
    timeScale: float = Field(gt=0, le=5000)


class Inject(Strict):
    kind: Literal["boulders", "sep", "sep-end", "link-outage"]


class Telemetry(Strict):
    id: str = Field(min_length=1, max_length=20)
    o2L: float | None = Field(default=None, ge=0, le=5000)
    co2mmHg: float | None = Field(default=None, ge=0, le=100)
    batteryPct: float | None = Field(default=None, ge=0, le=100)
    hr: int | None = Field(default=None, ge=20, le=250)
    x: float | None = None
    y: float | None = None


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


def create_app(
    store: Store | None = None, start_loop: bool = True, live_feeds: bool = True, db_dir: Path | None = None, mission: str | None = None
) -> FastAPI:
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
    app = FastAPI(
        title="MarSim API",
        version=VERSION,
        description='Planowanie i przebieg wyjść (EVA) na Marsie. Błędy mają postać {"ok": false, "error": "…"}.',
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    app.state.engines = engines
    app.state.active = active

    if start_loop:

        def simulation_loop():
            last = time.perf_counter()
            while True:
                time.sleep(STEP_INTERVAL_S)
                now = time.perf_counter()
                try:
                    active().step(now - last)  # krok tylko aktywnej misji
                except Exception:  # błąd kroku nie może zatrzymać habitatu
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
            raise HTTPException(
                422, f"Błędne dane zapytania — crew: nieznany członek załogi: {', '.join(unknown)} (dostępni: {', '.join(sorted(known))})"
            )

    def status(eng: EvaEngine) -> dict:
        return {"ok": True, "running": eng.running, "timeScale": eng.time_scale, "phase": eng.phase}

    # ---------- misje i pliki ----------
    @app.get("/api/health", tags=["Misje"])
    def health():
        eng = active()
        return {
            "ok": True,
            "mission": current["active"],
            "synthetic": bool(eng.mission.get("synthetic", False)),
            "version": VERSION,
            "session": eng.store.session,
        }

    @app.get("/api/missions", tags=["Misje"])
    def missions_list():
        out = []
        for mission_id in available_missions():
            m = json.loads((MISSIONS / mission_id / "mission.json").read_text(encoding="utf-8"))
            out.append(
                {
                    "id": mission_id,
                    "title": m["mission"]["title"],
                    "label": m["mission"].get("label") or {"pl": mission_id, "en": mission_id},
                    "center": m["area"]["center"],
                    "active": mission_id == current["active"],
                }
            )
        return {"active": current["active"], "missions": out}

    @app.post("/api/missions/select", tags=["Misje"])
    def missions_select(body: MissionSelect):
        if body.id not in available_missions():
            raise HTTPException(404, f"Nie ma zbudowanej misji „{body.id}”")
        with lock:
            previous = current["active"]
            if previous != body.id:
                engine_for(previous).pause()  # poprzednia misja zostaje wstrzymana
                current["active"] = body.id
                engine_for(body.id).add_log("EVA", f"Przełączono misję: {previous} → {body.id}", to_earth=False)
        return {"ok": True, "active": current["active"]}

    @app.get("/missions/{mission_id}/{name}", include_in_schema=False)
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
    @app.post("/api/plan", tags=["Trasa"])
    def plan(body: PlanRequest | None = None):
        body = body or PlanRequest()
        eng = active()
        if eng.running or eng.t > 0 or eng.finished:  # trasę wyznacza się przed startem (także zanim minie pierwsza sekunda)
            raise HTTPException(409, "Trasę można wyznaczyć tylko przed startem EVA. Zresetuj symulację, aby zaplanować nowe wyjście.")
        for point in [body.start, *(body.waypoints or [])]:
            if point is not None:
                require_inside(eng, point.x, point.y)
        route = eng.plan(
            body.start.model_dump() if body.start else None,
            [w.model_dump() for w in body.waypoints] if body.waypoints else None,
            body.letter,
        )
        return route if route["ok"] else JSONResponse(route, status_code=409)

    @app.get("/api/sensitivity", tags=["Trasa"])
    def route_sensitivity():
        """Co jeśli: trasa bieżącego planu przy limitach nachylenia 20–30° oraz przedział tlenu i czasu."""
        result = active().sensitivity()
        return result if result["ok"] else JSONResponse(result, status_code=409)

    @app.get("/api/route", tags=["Trasa"])
    def route():
        eng = active()
        with eng.lock:
            return {"version": eng.route_version, "route": eng.route, "discarded": eng.discarded, "waypoints": eng.waypoints}

    @app.get("/api/state", tags=["Przebieg EVA"])
    def state():
        return active().snapshot()

    @app.get("/api/stream", tags=["Przebieg EVA"])
    async def stream():
        async def events():
            while True:
                snapshot = await asyncio.to_thread(lambda: active().snapshot())
                yield f"data: {json.dumps(snapshot, ensure_ascii=False, default=float)}\n\n"
                await asyncio.sleep(STREAM_INTERVAL_S)

        return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})

    @app.post("/api/eva/start", tags=["Przebieg EVA"])
    def eva_start(body: EvaStart | None = None):
        body = body or EvaStart()
        eng = active()
        problem = eng.start(body.timeScale, body.scenario)
        return _err(409, problem) if problem else status(eng)

    @app.post("/api/eva/pause", tags=["Przebieg EVA"])
    def eva_pause():
        eng = active()
        eng.pause()
        return status(eng)

    @app.post("/api/eva/reset", tags=["Przebieg EVA"])
    def eva_reset():
        eng = active()
        eng.reset()
        return status(eng)

    @app.post("/api/eva/timescale", tags=["Przebieg EVA"])
    def eva_timescale(body: TimeScale):
        eng = active()
        with eng.lock:
            eng.time_scale = body.timeScale
            if not eng.running and eng.t > 0:
                eng.save_checkpoint()
        return status(eng)

    @app.post("/api/eva/return", tags=["Przebieg EVA"])
    def eva_return():
        """Powrót do habitatu od bieżącej pozycji załogi; po dojściu do śluzy EVA się kończy."""
        result = active().return_to_habitat()
        return result if result["ok"] else JSONResponse(result, status_code=409)

    @app.post("/api/eva/inject", tags=["Przebieg EVA"])
    def eva_inject(body: Inject):
        result = active().inject(body.kind)
        return result if result.get("ok", True) else JSONResponse(result, status_code=409)

    # ---------- telemetria i zgłoszenia ----------
    @app.post("/api/telemetry", tags=["Telemetria i zgłoszenia"])
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
        member = next((c for c in eng.cfg["crew"] if c["id"] == body.id), None)
        if member and body.o2L is not None and body.o2L > member["o2CapacityL"]:
            limit = member["o2CapacityL"]
            raise HTTPException(422, f"Błędne dane zapytania — o2L: {body.o2L:g} L przekracza pojemność butli {body.id} ({limit:g} L)")
        if not eng.apply_telemetry(body.id, values):
            raise HTTPException(404, f"Nieznany członek załogi: {body.id}")
        return {"ok": True}

    @app.get("/api/observations", tags=["Telemetria i zgłoszenia"])
    def observations():
        eng = active()
        return {"observations": eng.observations, "obstacles": eng.obstacles}

    @app.get("/api/observations/history", tags=["Telemetria i zgłoszenia"])
    def observations_history(limit: int = Query(200, ge=1, le=5000)):
        return {"observations": active().store.observations(limit)}

    @app.post("/api/observations", tags=["Telemetria i zgłoszenia"])
    def add_observation(body: Observation):
        eng = active()
        require_inside(eng, body.x, body.y)
        return eng.add_observation(body.model_dump())

    @app.get("/api/log", tags=["Dziennik"])
    def event_log(limit: int = Query(100, ge=1, le=5000), session: int | None = Query(None, ge=1)):
        db = active().store
        return {"session": db.session, "events": db.events(limit, session)}

    @app.get("/api/log/verify", tags=["Dziennik"])
    def event_log_verify():
        """Sprawdza łańcuch skrótów SHA-256 dziennika: czy żaden wpis nie został zmieniony ani usunięty."""
        return active().store.verify_log()

    @app.get("/api/log/export", tags=["Dziennik"])
    def event_log_export(session: int | None = Query(None, ge=1)):
        """Cały dziennik (albo jedna sesja EVA) jako plik CSV, od najstarszego wpisu."""
        eng = active()
        out = io.StringIO()
        writer = csv.writer(out, lineterminator="\n")
        writer.writerow(["id", "utc", "session", "mission_t_s", "clock_ltst", "kind", "text", "meta", "sha256"])
        writer.writerows(eng.store.events_oldest_first(session))
        name = f"marsim-{eng.cfg['id']}-log{f'-session{session}' if session else ''}.csv"
        return Response(
            "\ufeff" + out.getvalue(),  # BOM: Excel otwiera plik jako UTF-8
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"},
        )

    # ---------- pogoda kosmiczna i łączność ----------
    @app.get("/api/spaceweather", tags=["Pogoda kosmiczna i łączność"])
    def spaceweather():
        return active().spaceweather or {"available": False, "summary": "pobieranie…"}

    @app.get("/api/link", tags=["Pogoda kosmiczna i łączność"])
    def link():
        eng = active()
        return eng.link.status(eng.t)

    @app.post("/api/link/send", tags=["Pogoda kosmiczna i łączność"])
    def link_send(body: LinkMessage):
        eng = active()
        with eng.lock:
            bundle = eng.link.send(eng.t, body.kind, body.text, reply="Kontrola misji: wiadomość odebrana")
            return {"id": bundle.id, "deliverInMin": round((bundle.deliver_s - eng.t) / 60, 1)}

    # ---------- harmonogram wyjść ----------
    @app.get("/api/schedule", tags=["Harmonogram"])
    def schedule():
        return active().scheduler.evaluate()

    def save_schedule_item(eng: EvaEngine, item: ScheduleItem, verb: str) -> dict:
        require_known_crew(eng, item.crew)
        eng.scheduler.upsert(item.model_dump())
        eng.add_log("harmonogram", f"{verb} {item.id}: sol {item.sol}, {item.startLtst}, {item.durationH:g} h", to_earth=False)
        return eng.scheduler.evaluate()

    @app.post("/api/schedule", tags=["Harmonogram"])
    def schedule_create(item: ScheduleItem):
        eng = active()
        with eng.lock:
            if eng.scheduler.has(item.id):
                raise HTTPException(409, "Identyfikator wyjścia jest już zajęty")
            return save_schedule_item(eng, item, "Zapisano")

    @app.put("/api/schedule/{item_id}", tags=["Harmonogram"])
    def schedule_update(item_id: str, item: ScheduleItem):
        eng = active()
        with eng.lock:
            if item_id != item.id or not eng.scheduler.has(item_id):
                raise HTTPException(404, f"Nie ma wyjścia {item_id}")
            return save_schedule_item(eng, item, "Zmieniono")

    @app.delete("/api/schedule/{item_id}", tags=["Harmonogram"])
    def schedule_delete(item_id: str):
        eng = active()
        with eng.lock:
            if not eng.scheduler.has(item_id):
                raise HTTPException(404, f"Nie ma wyjścia {item_id}")
            eng.scheduler.delete(item_id)
            eng.add_log("harmonogram", f"Usunięto {item_id}", to_earth=False)
            return eng.scheduler.evaluate()

    # ---------- raport i pochodzenie danych ----------
    @app.get("/api/report", tags=["Raport"])
    def get_report():
        eng = active()
        with eng.lock:
            return report.build(eng)

    @app.get("/api/provenance", tags=["Raport"])
    def provenance():
        return active().provenance

    # ---------- interfejs ----------
    @app.get("/", include_in_schema=False)
    def index():
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        marker = f'<meta name="{API_META}" content="{VERSION}">'  # po tym znaczniku interfejs poznaje, że ma backend
        return HTMLResponse(html.replace("<title>", f"{marker}\n<title>", 1), headers={"Cache-Control": "no-store"})

    @app.get("/styles.css", include_in_schema=False)
    def styles():
        return FileResponse(ROOT / "styles.css", headers={"Cache-Control": "no-store"})

    # tylko pliki interfejsu — nie cały katalog projektu (bez .git, konfiguracji, bazy)
    app.mount("/src", StaticFiles(directory=ROOT / "src"), name="src")
    app.mount("/vendor", StaticFiles(directory=ROOT / "vendor"), name="vendor")
    app.mount("/data/demo", StaticFiles(directory=ROOT / "data" / "demo"), name="demo")
    return app


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python backend/server.py",
        description="Serwer MarSim: API i interfejs w jednym procesie.",
        epilog="Zmienne środowiskowe: PORT, MARSIM_HOST, MARSIM_MISSION, MARSIM_DB_DIR, MARSIM_DATA, NASA_API_KEY.",
    )
    parser.add_argument("port", nargs="?", type=int, default=int(os.environ.get("PORT", 8000)), help="port HTTP (domyślnie 8000)")
    parser.add_argument("--host", default=os.environ.get("MARSIM_HOST", "127.0.0.1"), help="adres nasłuchu (domyślnie tylko lokalnie)")
    parser.add_argument("--mission", help="misja startowa, np. mount-sharp albo jezero")
    parser.add_argument("--db-dir", type=Path, help="katalog baz SQLite marsim-<misja>.db (domyślnie katalog danych)")
    parser.add_argument("--no-live-feeds", action="store_true", help="bez pobierania pogody kosmicznej z sieci")
    parser.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error"], help="poziom dziennika serwera")
    parser.add_argument("--version", action="version", version=f"MarSim {VERSION}")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    import uvicorn

    args = parse_args(argv)
    logging.basicConfig(level=args.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    application = create_app(db_dir=args.db_dir, mission=args.mission, live_feeds=not args.no_live_feeds)
    shown_host = "localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host
    log.info("MarSim %s: http://%s:%d (opis API: /api/docs)", VERSION, shown_host, args.port)
    uvicorn.run(application, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
