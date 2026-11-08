// Adapter stanu EVA z backendu (strumień SSE /api/stream) o tym samym interfejsie co lokalny Sim.
// Backend jest źródłem prawdy: pozycje, tlen, telemetria skafandrów, zdarzenia. UI tylko wyświetla.
import { parseClock } from './format.js';

export class RemoteSim {
  constructor(mission, ds, hooks = {}) {
    this.m = mission;
    this.ds = ds;
    this.hooks = hooks;
    this.remote = true;
    this.reset();
    this.es = ds.stream((s) => this.#onSnap(s));
  }

  reset() {
    this.snap = null;
    this.startMin = parseClock(this.m.mission.startClock);
    this.min = this.startMin;
    this.running = false;
    this.timeScale = 470;
    this.crewS = 0;
    this.gap = 14;
    this.crew = this.m.crew.map((c) => ({ ...c, o2: 100 }));
    this.nextWp = 0;
    this.reached = [];
    this.sep = false;
    this.rover = { s: 0, mode: 'parked' };
    this.route = null;
    this.routeVersion = null;
    this.alertKey = null;
    this.obstacleCount = 0;
  }

  setRoute(route) { this.route = route; }
  step() { /* czas płynie w backendzie */ }

  crewPos(i = 0) {
    const c = this.snap?.crew?.[i];
    return c ? { x: c.x, y: c.y } : { x: this.m.rover.x, y: this.m.rover.y };
  }
  roverPos() {
    const r = this.snap?.rover;
    return r ? { x: r.x, y: r.y } : { x: this.m.rover.x, y: this.m.rover.y };
  }
  reserveH() { return this.snap?.reserveH ?? 0; }

  #onSnap(s) {
    if (s.missionId && s.missionId !== this.m.mission.id) { location.reload(); return; }
    const first = this.snap === null;
    this.snap = s;
    this.min = s.clockMin;
    this.running = s.running;
    this.timeScale = s.timeScale;
    this.crewS = s.crewS;
    this.gap = s.gap;
    this.nextWp = s.nextWp;
    this.rover = { ...s.rover };
    this.crew = s.crew.map((c) => ({ ...c, o2: c.o2Pct }));
    const newly = s.reached.filter((id) => !this.reached.includes(id));
    this.reached = [...s.reached];
    if (!first) for (const id of newly) {
      const wp = this.m.waypoints.find((w) => w.id === id);
      if (wp) this.hooks.onWaypoint?.(wp, this.m.waypoints.indexOf(wp) === this.m.waypoints.length - 1);   // punkt spoza mission.json (własny /api/plan) — pomijamy
    }
    if (s.routeVersion !== this.routeVersion) { this.routeVersion = s.routeVersion; this.hooks.onRouteVersion?.(s.routeVersion); }
    const a = s.alerts[s.alerts.length - 1];
    const key = a ? `${a.t}|${a.category}` : null;
    if (key !== this.alertKey) { this.alertKey = key; if (a && !first) this.hooks.onAlert?.(a); }
    if (s.sep !== this.sep) { this.sep = s.sep; this.hooks.onSep?.(s.sep); }
    if (s.obstacles.length !== this.obstacleCount) { this.obstacleCount = s.obstacles.length; this.hooks.onObstacles?.(s.obstacles); }
    this.hooks.onSnapshot?.(s);
  }
}
