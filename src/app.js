// Kontroler aplikacji: stan UI + akcje. Widoki tylko czytają stan i wywołują akcje.
// Tryb lokalny: symulacja w przeglądarce (Sim). Tryb backendu: stan z /api/stream (RemoteSim), akcje przez API.
import { Polyline } from './core/path.js';
import { Sim } from './core/sim.js';
import { RemoteSim } from './core/remoteSim.js';
import { routeStats } from './core/routeStats.js';
import { t, tx } from './i18n.js';

export class App {
  constructor(ds, world) {
    this.ds = ds;
    this.world = world;
    this.m = world.mission;
    this.remote = ds.mode === 'http';
    this.now = 0;
    this.autoEvents = true;   // false, gdy prezentacja sama steruje końcem alarmów
    this.handlers = {};
    this.shadowHour = 14;
    const hooks = {
      onWaypoint: (wp, last) => this.#onWaypoint(wp, last),
      onEvent: (ev) => this.#onEvent(ev),
      onRouteVersion: () => this.#syncRemoteRoute(),
      onAlert: (a) => this.#onRemoteAlert(a),
      onSep: (on) => this.#onRemoteSep(on),
      onObstacles: (obs) => this.#syncObstacles(obs),
      onSnapshot: (s) => this.emit('snapshot', s),
    };
    this.sim = this.remote ? new RemoteSim(this.m, ds, hooks) : new Sim(this.m, hooks);
    this.reset();
  }

  on(evt, fn) { (this.handlers[evt] ||= []).push(fn); }
  off(evt, fn) { this.handlers[evt] = (this.handlers[evt] || []).filter((f) => f !== fn); }
  emit(evt, data) { (this.handlers[evt] || []).forEach((fn) => fn(data)); }

  reset() {
    if (this.remote) { this.pendingReset = this.ds.post('eva/reset').catch(() => {}); this.sim.reset(); }
    else this.sim.reset();
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
      reportMode: false,
    };
    this.emit('reset');
  }

  // ---------- warstwy ----------
  toggleLayer(id, on = !this.state.layers[id].on) {
    const L = this.state.layers[id];
    if (!L || L.on === on) return;
    L.on = on;
    L.changedAt = this.now;
    if (on) { this.state.focus = id; this.state.legend = id; }
    else if (this.state.focus === id) this.state.focus = null;
    this.emit('layers');
  }
  clearFocus(legend) {
    this.state.focus = null;
    if (legend && this.state.layers[legend]) this.state.legend = legend;
    this.emit('layers');
  }
  setShadowHour(h) { this.shadowHour = h; this.emit('layers'); }
  get envOn() { return this.state.layers.sky?.on; }

  // ---------- trasa ----------
  async planInitial({ animate = true } = {}) {
    if (this.pendingReset) await this.pendingReset;
    const r = await this.ds.planRoute({ start: { x: this.m.rover.x, y: this.m.rover.y }, waypoints: this.m.waypoints });
    if (!r.ok && !r.path) { this.setAlert({ category: t('noRoute'), text: tx(r.error) }); return null; }
    const searchDur = animate ? 2.2 : 0, drawDur = animate ? 1.0 : 0;
    this.state.search = animate ? { pts: r.expanded || [], t0: this.now, dur: searchDur } : null;
    this.state.route = this.#makeRoute(r.path, r.waypointIndex, r.letter || 'A', r, { t0: this.now + searchDur, dur: drawDur, s0: 0 });
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
      o2L: stats.o2L, uncertainty: stats.uncertainty || null, draw,
    };
  }

  async #syncRemoteRoute() {
    const { route, discarded } = await this.ds.get('route');
    if (!route) return;
    const cur = this.state.route;
    if (cur && cur.letter === route.letter) return;              // ta sama trasa (np. po własnym POST /plan)
    const s0 = route.replanFrom ?? 0;
    this.state.discarded = discarded || [];
    this.state.route = this.#makeRoute(route.path, route.waypointIndex, route.letter, route, { t0: this.now, dur: cur ? 0.65 : 0, s0: cur ? s0 : 0 });
    this.state.routeCardAt = this.now + (cur ? 0.65 : 0);
    this.sim.setRoute(this.state.route);
    this.emit('route');
    if (cur && route.deltaM !== undefined) {
      this.lastReplan = { deltaM: route.deltaM };
      this.emit('replanned', this.lastReplan);
    }
  }

  async replanAround(obstacle) {
    const old = this.state.route, s = this.sim.crewS;
    const pos = old.poly.at(s);
    const remaining = this.m.waypoints.slice(this.sim.nextWp);
    const r = await this.ds.planRoute({ start: pos, waypoints: remaining, obstacles: this.state.obstacles });
    if (!r.ok) { this.setAlert({ category: t('noRoute'), text: tx(r.error) }); return; }
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
    this.state.route = this.#makeRoute(path, wpIndex, letter, { ...stats, uncertainty: old.uncertainty }, { t0: this.now, dur: 0.65, s0: s });
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

  // ---------- zgłoszenia z terenu ----------
  async reportObservation(obs) {
    if (this.remote) return this.ds.post('observations', obs);
    if (obs.kind === 'bezpieczne') return { ok: true };
    const ob = { id: `obs${this.state.obstacles.length + 1}`, x: obs.x, y: obs.y, radiusM: obs.radiusM, t0: this.now, label: labelFor(obs.kind) };
    this.state.obstacles.push(ob);
    this.emit('obstacle', ob);
    if (this.state.route && this.sim.running) {
      const res = await this.replanAround(ob);
      this.lastReplan = res;
      this.emit('replanned', res);
    }
    return { ok: true };
  }
  #syncObstacles(list) {
    const known = new Set(this.state.obstacles.map((o) => `${o.x}|${o.y}`));
    for (const o of list) {
      if (known.has(`${o.x}|${o.y}`)) continue;
      const ob = { ...o, t0: this.now, label: labelFor(o.kind) };
      this.state.obstacles.push(ob);
      this.emit('obstacle', ob);
    }
  }

  // ---------- EVA ----------
  showCrew() { this.state.crewVisible = true; this.emit('crew'); }
  startEva(timeScale = 470) {
    if (!this.state.route) return;
    this.state.crewVisible = true;
    if (this.remote) this.ds.post('eva/start', { timeScale, scenario: !this.autoEvents });
    else { this.sim.timeScale = timeScale; this.sim.running = true; }
    this.emit('eva');
  }
  pauseEva(paused) {
    if (this.remote) this.ds.post(paused ? 'eva/pause' : 'eva/start', paused ? {} : { timeScale: this.sim.timeScale });
    else this.sim.running = !paused;
  }
  setTimeScale(ts) { if (this.remote) this.ds.post('eva/timescale', { timeScale: ts }); else this.sim.timeScale = ts; }

  setAlert(a) { this.state.alert = a ? { ...a, t0: this.now } : null; this.emit('alert'); }
  setCaption(n, text) { this.state.caption = n ? { n, text, t0: this.now } : null; this.emit('caption'); }
  setView(v) { if (this.state.view !== v) { this.state.view = v; this.emit('view', v); } }

  endSep() {
    if (!this.sim.sep && !this.state.doseHi) return;
    if (this.remote) this.ds.post('eva/inject', { kind: 'sep-end' });
    else this.sim.sep = false;
    this.state.doseHi = false;
    this.emit('sep-end');
  }

  #onWaypoint(wp, last) {
    this.state.reached[wp.id] = this.now;
    if (last && this.autoEvents) this.setTimeScale(Math.min(this.sim.timeScale, 150));
    this.emit('waypoint', { wp, last });
  }
  setWaypointView(id, src, caption) {
    this.state.wpView[id] = { src, caption, t0: this.now };
    this.emit('wpview', id);
  }

  #onRemoteAlert(a) {
    this.setAlert({ category: tx(a.category), text: tx(a.text), source: tx(a.source) });
    if (a.highlight === 'dose') this.state.doseHi = true;
  }
  #onRemoteSep(on) {
    if (on) {
      this.state.doseHi = true;
      this.state.shelter = { radiusM: this.m.eva.shelterRadiusM, label: t('map.shelter', { m: this.m.eva.shelterMin }), t0: this.now + 0.3 };
      this.emit('sep');
    } else this.state.doseHi = false;
  }

  async #onEvent(ev) {   // tylko tryb lokalny
    if (ev.type === 'obstacle') {
      const s = this.sim.crewS + ev.aheadM;
      const c = this.state.route.poly.at(Math.min(s, this.state.route.poly.length - ev.radiusM - 10));
      const ob = { id: ev.id, x: c.x, y: c.y, radiusM: ev.radiusM, t0: this.now, label: t('lbl.glazy') };
      this.state.obstacles.push(ob);
      this.setAlert({ category: tx(ev.alert.category), text: tx(ev.alert.text.replace('{dist}', Math.round(ev.aheadM))) });
      this.emit('obstacle', ob);
      const res = await this.replanAround(ob);
      this.lastReplan = res;
      this.emit('replanned', res);
    }
    if (ev.type === 'space-weather') {
      this.setAlert({ category: tx(ev.alert.category), text: tx(ev.alert.text), source: tx(ev.source) });
      this.state.doseHi = true;
      this.sim.sep = true;
      this.sim.rover.mode = 'toCrew';
      this.state.shelter = { radiusM: this.m.eva.shelterRadiusM, label: t('map.shelter', { m: this.m.eva.shelterMin }), t0: this.now + 0.3 };
      this.emit('sep');
    }
  }

  // ---------- pętla ----------
  update(dt) {
    this.now += dt;
    this.sim.step(dt);
    if (this.now >= this.windNext) {
      const w = this.m.environment.wind;
      this.state.wind = this.sim.snap?.env?.windMs ?? Math.round((w.meanMs + (Math.random() * 2 - 1) * w.spreadMs) * 10) / 10;
      this.windNext = this.now + 0.4 + Math.random() * 0.6;
    }
    // koniec alarmu SEP w trybie ręcznym: załoga przy łaziku (w schronie) przez 20 min misji
    if (this.autoEvents && this.sim.sep) {
      const near = this.sim.crewS - this.sim.rover.s <= 111;
      if (near && this.state.sepEndAt === null) this.state.sepEndAt = this.sim.min + 20;
      if (this.state.sepEndAt !== null && this.sim.min >= this.state.sepEndAt) { this.endSep(); this.setAlert(null); this.state.sepEndAt = null; }
    }
  }
}

export function labelFor(kind) {
  return ['glazy', 'piasek', 'osuwisko', 'inne', 'bezpieczne'].includes(kind) ? t(`lbl.${kind}`) : t('lbl.glazy');
}
