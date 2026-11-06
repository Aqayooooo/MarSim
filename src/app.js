// Kontroler aplikacji: stan UI + akcje. Widoki tylko czytają stan i wywołują akcje.
import { Polyline } from './core/path.js';
import { Sim } from './core/sim.js';
import { routeStats } from './core/routeStats.js';

export class App {
  constructor(ds, world) {
    this.ds = ds;
    this.world = world;
    this.m = world.mission;
    this.now = 0;
    this.autoEvents = true;   // false, gdy prezentacja sama steruje zdarzeniami
    this.handlers = {};
    this.sim = new Sim(this.m, {
      onWaypoint: (wp, last) => this.#onWaypoint(wp, last),
      onEvent: (ev) => this.#onEvent(ev),
    });
    this.reset();
  }

  on(evt, fn) { (this.handlers[evt] ||= []).push(fn); }
  off(evt, fn) { this.handlers[evt] = (this.handlers[evt] || []).filter((f) => f !== fn); }
  emit(evt, data) { (this.handlers[evt] || []).forEach((fn) => fn(data)); }

  reset() {
    this.sim.reset();
    this.windNext = 0;
    this.lastReplan = null;
    this.state = {
      layers: Object.fromEntries(this.m.layers.map((l) => [l.id, { on: false, changedAt: -10 }])),
      focus: 'optical',
      legend: 'optical',
      view: 'map',
      caption: null,
      route: null,
      routeCardAt: Infinity,
      discarded: [],
      search: null,
      crewVisible: false,
      obstacles: [],
      shelter: null,
      alert: null,
      doseHi: false,
      reached: {},
      wpView: {},
      wind: this.m.environment.wind.meanMs,
      sepEndAt: null,
      fadeOut: false,
    };
    this.emit('reset');
  }

  // ---------- warstwy ----------
  toggleLayer(id, on = !this.state.layers[id].on) {
    const L = this.state.layers[id];
    if (L.on === on) return;
    L.on = on;
    L.changedAt = this.now;
    if (on) { this.state.focus = id; this.state.legend = id; }
    else if (this.state.focus === id) this.state.focus = null;
    this.emit('layers');
  }
  clearFocus(legend) {
    this.state.focus = null;
    if (legend) this.state.legend = legend;
    this.emit('layers');
  }
  get envOn() { return this.state.layers.sky?.on; }

  // ---------- trasa ----------
  async planInitial({ animate = true } = {}) {
    const r = await this.ds.planRoute({ start: { x: this.m.rover.x, y: this.m.rover.y }, waypoints: this.m.waypoints });
    if (!r.ok) { this.setAlert({ category: 'BRAK TRASY', text: r.error }); return null; }
    const searchDur = animate ? 2.2 : 0, drawDur = animate ? 1.0 : 0;
    this.state.search = animate ? { pts: r.expanded, t0: this.now, dur: searchDur } : null;
    this.state.route = this.#makeRoute(r.path, r.waypointIndex, 'A', r, { t0: this.now + searchDur, dur: drawDur, s0: 0 });
    this.state.routeCardAt = this.now + searchDur + drawDur;
    this.state.discarded = [];
    this.sim.setRoute(this.state.route);
    this.emit('route');
    return this.state.route;
  }

  #makeRoute(path, wpIndex, letter, stats, draw) {
    const poly = new Polyline(path);
    return {
      letter, poly, wpS: wpIndex.map((i) => poly.cum[i]),
      lengthM: stats.lengthM, durationH: stats.durationH, stops: stats.stops, rating: stats.rating || 'bezpieczna',
      draw,
    };
  }

  async replanAround(obstacle) {
    const old = this.state.route, s = this.sim.crewS;
    const pos = old.poly.at(s);
    const remaining = this.m.waypoints.slice(this.sim.nextWp);
    const r = await this.ds.planRoute({ start: pos, waypoints: remaining, obstacles: this.state.obstacles });
    if (!r.ok) { this.setAlert({ category: 'BRAK TRASY', text: r.error }); return; }
    const walked = old.poly.slice(0, s);
    const path = walked.concat(r.path.slice(1));
    const off = walked.length - 1;
    const wpIndex = [
      ...this.m.waypoints.slice(0, this.sim.nextWp).map((wp) => this.#nearestIndex(walked, wp)),
      ...r.waypointIndex.map((i) => i + off),
    ];
    const totalStop = this.m.waypoints.reduce((a, w) => a + (w.stopMin ?? 0), 0);
    const stats = routeStats(this.world.terrain, path, this.m.eva, this.m.waypoints.length, totalStop);
    this.state.discarded.push(old.poly.slice(s, old.poly.length));
    const letter = String.fromCharCode(old.letter.charCodeAt(0) + 1);
    this.state.route = this.#makeRoute(path, wpIndex, letter, stats, { t0: this.now, dur: 0.65, s0: s });
    this.sim.setRoute(this.state.route);
    this.state.routeCardAt = this.now + 0.65;
    this.emit('route');
    return { deltaM: stats.lengthM - old.lengthM, obstacle };
  }
  #nearestIndex(pts, p) {
    let bi = 0, bd = Infinity;
    pts.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; bi = i; } });
    return bi;
  }

  // ---------- EVA ----------
  showCrew() { this.state.crewVisible = true; this.emit('crew'); }
  startEva(timeScale = 470) {
    if (!this.state.route) return;
    this.state.crewVisible = true;
    this.sim.timeScale = timeScale;
    this.sim.running = true;
    this.emit('eva');
  }
  setTimeScale(ts) { this.sim.timeScale = ts; }

  setAlert(a) { this.state.alert = a ? { ...a, t0: this.now } : null; this.emit('alert'); }
  setCaption(n, text) { this.state.caption = n ? { n, text, t0: this.now } : null; this.emit('caption'); }
  setView(v) { if (this.state.view !== v) { this.state.view = v; this.emit('view', v); } }

  endSep() {
    if (!this.sim.sep && !this.state.doseHi) return;
    this.sim.sep = false;
    this.state.doseHi = false;
    this.emit('sep-end');
  }

  #onWaypoint(wp, last) {
    this.state.reached[wp.id] = this.now;
    if (last && this.autoEvents) this.sim.timeScale = Math.min(this.sim.timeScale, 150);
    this.emit('waypoint', { wp, last });
  }
  setWaypointView(id, src, caption) {
    this.state.wpView[id] = { src, caption, t0: this.now };
    this.emit('wpview', id);
  }

  async #onEvent(ev) {
    if (ev.type === 'obstacle') {
      const s = this.sim.crewS + ev.aheadM;
      const c = this.state.route.poly.at(Math.min(s, this.state.route.poly.length - ev.radiusM - 10));
      const ob = { id: ev.id, x: c.x, y: c.y, radiusM: ev.radiusM, t0: this.now, label: 'GŁAZY' };
      this.state.obstacles.push(ob);
      this.setAlert({ category: ev.alert.category, text: ev.alert.text.replace('{dist}', Math.round(ev.aheadM)) });
      this.emit('obstacle', ob);
      const res = await this.replanAround(ob);
      this.lastReplan = res;
      this.emit('replanned', res);
    }
    if (ev.type === 'space-weather') {
      this.setAlert({ category: ev.alert.category, text: ev.alert.text, source: ev.source });
      this.state.doseHi = true;
      this.sim.sep = true;
      this.sim.rover.mode = 'toCrew';
      this.state.shelter = { radiusM: this.m.eva.shelterRadiusM, label: `SCHRON ≤ ${this.m.eva.shelterMin} MIN`, t0: this.now + 0.3 };
      this.emit('sep');
    }
  }

  // ---------- pętla ----------
  update(dt) {
    this.now += dt;
    this.sim.step(dt);
    if (this.now >= this.windNext) {
      const w = this.m.environment.wind;
      this.state.wind = Math.round((w.meanMs + (Math.random() * 2 - 1) * w.spreadMs) * 10) / 10;
      this.windNext = this.now + 0.4 + Math.random() * 0.6;
    }
    // koniec alarmu SEP w trybie ręcznym: załoga przy łaziku (w schronie) przez 20 min misji
    if (this.autoEvents && this.sim.sep) {
      const near = this.sim.crewS - this.sim.rover.s <= 111;
      if (near && this.state.sepEndAt === null) this.state.sepEndAt = this.sim.min + 20;
      if (this.state.sepEndAt !== null && this.sim.min >= this.state.sepEndAt) { this.endSep(); this.setAlert(null); }
    }
  }
}
