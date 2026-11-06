"""Serwer MarSim: API na żywo + pliki UI.   python backend/server.py   →   http://localhost:8000"""
from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import uvicorn  # noqa: E402
from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from backend.live import report  # noqa: E402
from backend.live.engine import EvaEngine  # noqa: E402
from backend.paths import MISSIONS  # noqa: E402

CFG = json.loads((ROOT / "backend" / "config" / "mission.json").read_text(encoding="utf-8"))
MISSION_DIR = MISSIONS / CFG["id"]
if not (MISSION_DIR / "mission.json").exists():
    sys.exit(f"Brak danych misji w {MISSION_DIR}. Uruchom najpierw: python backend/build.py")

engine = EvaEngine(MISSION_DIR, CFG)
app = FastAPI(title="MarSim API", version="1.0")


def _loop():
    last = time.perf_counter()
    while True:
        time.sleep(0.1)
        now = time.perf_counter()
        engine.step(now - last)
        last = now


threading.Thread(target=_loop, daemon=True).start()


@app.get("/api/health")
def health():
    return {"ok": True, "mission": CFG["id"], "synthetic": False}


@app.get("/missions/current/{name}")
def mission_file(name: str):
    p = (MISSION_DIR / name).resolve()
    if MISSION_DIR.resolve() not in p.parents or not p.exists():
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "no-store"})


@app.post("/api/plan")
async def plan(req: Request):
    body = await req.json() if (await req.body()) else {}
    r = engine.plan(body.get("start"), body.get("waypoints"), body.get("letter", "A"))
    return r


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


@app.post("/api/eva/{action}")
async def eva(action: str, req: Request):
    body = await req.json() if (await req.body()) else {}
    with engine.lock:
        if action == "start":
            if not engine.route:
                r = engine.plan()
                if not r.get("ok", True) and "path" not in r:
                    return JSONResponse(r, 400)
            engine.running = True
            engine.time_scale = float(body.get("timeScale", engine.time_scale))
            engine.scenario = bool(body.get("scenario", engine.scenario))
            engine.add_log("EVA", f"Start EVA ×{engine.time_scale:.0f}")
        elif action == "pause":
            engine.running = False
        elif action == "reset":
            engine.reset()
        elif action == "timescale":
            engine.time_scale = float(body["timeScale"])
        elif action == "inject":
            return engine.inject(body["kind"])
        else:
            raise HTTPException(404)
    return {"ok": True, "running": engine.running, "timeScale": engine.time_scale}


@app.post("/api/telemetry")
async def telemetry(req: Request):
    """Wejście dla prawdziwego skafandra: {id, o2L, co2mmHg, batteryPct, hr, x?, y?}. Wyłącza model dla tej osoby."""
    d = await req.json()
    with engine.lock:
        for c in engine.crew:
            if c["cfg"]["id"] == d["id"]:
                c["source"] = "skafander"
                p = c["person"]
                if "o2L" in d:
                    p.o2_l = float(d["o2L"])
                if "co2mmHg" in d:
                    c["co2mmHg"] = float(d["co2mmHg"])
                if "batteryPct" in d:
                    p.battery_left_wh = p.battery_wh * float(d["batteryPct"]) / 100
                return {"ok": True}
    raise HTTPException(404, "Nieznany członek załogi")


@app.get("/api/observations")
def observations():
    return {"observations": engine.observations, "obstacles": engine.obstacles}


@app.post("/api/observations")
async def add_observation(req: Request):
    return engine.add_observation(await req.json())


@app.get("/api/spaceweather")
def spaceweather():
    return engine.spaceweather or {"available": False, "summary": "pobieranie…"}


@app.get("/api/link")
def link():
    return engine.link.status(engine.t)


@app.post("/api/link/send")
async def link_send(req: Request):
    d = await req.json()
    with engine.lock:
        b = engine.link.send(engine.t, d.get("kind", "wiadomość"), d["text"], reply="Kontrola misji: wiadomość odebrana")
    return {"id": b.id, "deliverInMin": round((b.deliver_s - engine.t) / 60, 1)}


@app.get("/api/schedule")
def schedule():
    return engine.scheduler.evaluate()


@app.post("/api/schedule")
async def schedule_upsert(req: Request):
    engine.scheduler.upsert(await req.json())
    return engine.scheduler.evaluate()


@app.delete("/api/schedule/{item_id}")
def schedule_delete(item_id: str):
    engine.scheduler.delete(item_id)
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


app.mount("/", StaticFiles(directory=ROOT, html=False), name="ui")

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"MarSim: http://localhost:{port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
