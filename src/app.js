// Kontroler aplikacji: stan UI + akcje. Widoki tylko czytają stan i wywołują akcje.
// Tryb lokalny: symulacja w przeglądarce (Sim). Tryb backendu: stan z /api/stream (RemoteSim), akcje przez API.
import { Polyline } from './core/path.js';
import { Sim, HABITAT_ID } from './core/sim.js';
import { RemoteSim } from './core/remoteSim.js';
import { routeStats } from './core/routeStats.js';
import { Drive } from './core/drive.js';
import { hm } from './core/format.js';
import { t, tx } from './i18n.js';

const DEFAULT_LAYERS = ['optical', 'hazards', 'sky'];   // widoczne od razu po otwarciu strony
const CAN_RETURN = ['walking', 'stop', 'atTarget'];
const MAX_WAYPOINTS = 8;

// plan wyjścia zapisany w przeglądarce (osobno dla każdej misji); brak dostępu do pamięci — plan domyślny
const wpKey = (m) => `marsim.waypoints.${m.mission.id}`;
function loadWaypoints(m) {
  try {
    const list = JSON.parse(localStorage.getItem(wpKey(m)) || 'null');
    const inside = (w) => Number.isFinite(w?.x) && Number.isFinite(w?.y) && w.x >= 0 && w.y >= 0 && w.x <= m.area.widthM && w.y <= m.area.heightM;
    if (!Array.isArray(list) || !list.length || list.length > MAX_WAYPOINTS || !list.every((w) => inside(w) && typeof w.id === 'string')) return null;
    return list.map((w) => ({ ...w, stopMin: Math.max(0, Math.min(600, Number(w.stopMin) || 0)) }));
  } catch { return null; }
}
function saveWaypoints(m, list) {
  try { if (list) localStorage.setItem(wpKey(m), JSON.stringify(list)); else localStorage.removeItem(wpKey(m)); } catch { /* tryb prywatny */ }
}
const wpSignature = (list) => JSON.stringify(list.map((w) => [w.id, Math.round(w.x), Math.round(w.y), w.stopMin ?? 0]));

export class App {
  constructor(ds, world) {
    this.ds = ds;
    this.world = world;
    this.m = world.mission;
    this.defaultWaypoints = structuredClone(this.m.waypoints);
    this.m.waypoints = loadWaypoints(this.m) ?? this.m.waypoints;   // własny plan wyjścia z poprzedniej wizyty
    this.lastPlanError = null;
    this.remote = ds.mode === 'http';
    this.now = 0;
    this.autoEvents = true;   // false, gdy prezentacja sama steruje końcem alarmów
    this.handlers = {};
    this.shadowHour = 14;
    this.offline = false;     // utracone połączenie ze strumieniem backendu
    this.lastPhase = null;
    const hooks = {
      onWaypoint: (wp, last) => this.#onWaypoint(wp, last),
      onEvent: (ev) => this.#onEvent(ev),
      onRouteVersion: () => this.#syncRemoteRoute(),
      onAlert: (a) => this.#onRemoteAlert(a),
      onSep: (on) => this.#onRemoteSep(on),
      onObstacles: (obs) => this.#syncObstacles(obs),
      onSnapshot: (s) => this.emit('snapshot', s),
      onSession: () => this.reset(false),
      onFinish: () => this.#onFinish(),
      onOngoing: (s) => this.#onOngoing(s),
      onLink: (up) => { this.offline = !up; this.emit('net', up); },
    };
    this.sim = this.remote ? new RemoteSim(this.m, ds, hooks) : new Sim(this.m, hooks, world.rasters);
    this.reset(false);
  }

  on(evt, fn) { (this.handlers[evt] ||= []).push(fn); }
  off(evt, fn) { this.handlers[evt] = (this.handlers[evt] || []).filter((f) => f !== fn); }
  emit(evt, data) { (this.handlers[evt] || []).forEach((fn) => fn(data)); }

  /** bare: pusta mapa bez warstw (prezentacja włącza je po kolei). */
  reset(newSession = true, { bare = false } = {}) {
    this.routeSync = (this.routeSync ?? 0) + 1;
    if (this.remote && newSession) {
      this.resetting = true;
      this.pendingReset = this.ds.post('eva/reset').then((result) => {
        this.reset(false, { bare });
        return result;
      }).catch((e) => {
        this.setAlert({ category: t('eva.error'), text: tx(e.message) });
        return null;
      }).finally(() => { this.resetting = false; });
      return this.pendingReset;
    }
    this.sim.reset();
    this.drive = null;       // jazda łazikiem po trasie A→B (core/drive.js)
    this.roverAt = null;     // gdzie łazik stanął po jeździe (null = pozycja z misji / z symulacji EVA)
    this.routeBlocked = false;
    this.windNext = 0;
    this.lastReplan = null;
    this.state = {
      layers: Object.fromEntries(this.m.layers.map((l) => [l.id, { on: !bare && DEFAULT_LAYERS.includes(l.id), changedAt: -10 }])),
      focus: null,
      legend: bare ? 'optical' : 'hazards',
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
      altOpen: false,
      altHi: null,
      probe: null,           // punkt trasy wskazany na profilu wysokości
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

  // ---------- punkty wyjścia (plan EVA) ----------
  /** Plan wyjścia można zmieniać tylko przed startem EVA i bez jazdy łazikiem. */
  get canEditWaypoints() { return this.phase === 'idle' && !this.drive; }
  get waypointsCustom() { return wpSignature(this.m.waypoints) !== wpSignature(this.defaultWaypoints); }

  /** Nowy plan wyjścia. renumber: identyfikatory WP1…WPn w kolejności; save: zapis w przeglądarce. */
  setWaypoints(list, { save = true, renumber = true } = {}) {
    const next = list.slice(0, MAX_WAYPOINTS);
    if (renumber) next.forEach((w, i) => { w.id = `WP${i + 1}`; });
    this.m.waypoints = next;
    if (!this.remote && this.phase === 'idle') this.sim.waypoints = [...next];
    if (save) saveWaypoints(this.m, this.waypointsCustom ? next : null);
    this.emit('waypoints', next);
  }

  /** Powrót do punktów z konfiguracji misji. */
  restoreDefaultWaypoints() { this.setWaypoints(structuredClone(this.defaultWaypoints), { renumber: false }); }

  /** Backend prowadzi wyjście według własnej listy punktów (np. ustawionej w innej karcie) — interfejs ją przyjmuje. */
  #adoptWaypoints(list) {
    if (!Array.isArray(list) || !list.length || list.some((w) => w.id === HABITAT_ID)) return;   // trasa powrotu: plan bez zmian
    if (wpSignature(list) === wpSignature(this.m.waypoints)) return;
    const known = [...this.m.waypoints, ...this.defaultWaypoints];
    this.setWaypoints(list.map((w) => ({ ...(known.find((k) => k.id === w.id) || {}), ...w })), { save: false, renumber: false });
  }

  // ---------- trasa ----------
  /** Trasa bieżącego planu od łazika. quiet: błąd tylko w lastPlanError (edytor pokazuje go u siebie). */
  async planInitial({ animate = true, quiet = false } = {}) {
    if (this.pendingReset) {
      const result = await this.pendingReset;
      this.pendingReset = null;
      if (!result) return null;
    }
    let r;
    try {
      r = await this.ds.planRoute({ start: { x: this.m.rover.x, y: this.m.rover.y }, waypoints: this.m.waypoints });
    } catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok && !r.path) {
      this.lastPlanError = tx(r.error);
      if (!quiet) this.setAlert({ category: t('noRoute'), text: this.lastPlanError });
      if (this.phase === 'idle' && this.state.route) { this.state.route = null; this.sim.setRoute(null); this.emit('route'); }   // stara trasa nie pasuje już do planu
      return null;
    }
    this.lastPlanError = null;
    this.routeBlocked = false;
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
      letter, version: stats.version, poly, wpS: wpIndex.map((i) => poly.cum[i]),
      wpIds: stats.waypointIds ?? (this.sim.waypoints ?? this.m.waypoints).map((w) => w.id),
      lengthM: stats.lengthM, durationH: stats.durationH, stops: stats.stops, rating: stats.rating || 'bezpieczna',
      o2L: stats.o2L, uncertainty: stats.uncertainty || null, alternatives: stats.alternatives || null, draw,
    };
  }

  async #syncRemoteRoute() {
    const request = ++this.routeSync;
    let response;
    try { response = await this.ds.get('route'); } catch (e) {
      if (request === this.routeSync) {
        this.sim.routeVersion = null;   // kolejna próbka ponowi odczyt trasy
        this.setAlert({ category: t('eva.error'), text: tx(e.message) });
      }
      return;
    }
    if (request !== this.routeSync) return;   // nowszy odczyt albo reset zastąpił to żądanie
    const { route, discarded, waypoints } = response;
    if (!route) { this.state.route = null; this.sim.setRoute(null); this.emit('route'); return; }
    this.#adoptWaypoints(waypoints);
    const cur = this.state.route;
    if (cur && cur.version === route.version) return;              // ta sama trasa (np. po własnym POST /plan)
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

  /** Tryb lokalny: nowa trasa od pozycji załogi wokół przeszkody, do punktów jeszcze nieodwiedzonych. */
  async replanAround(obstacle) {
    const old = this.state.route, s = this.sim.crewS;
    const remaining = this.sim.waypoints.slice(this.sim.nextWp);
    const r = await this.ds.planRoute({ start: old.poly.at(s), waypoints: remaining, obstacles: this.state.obstacles });
    if (!r.ok) { this.sim.running = false; this.routeBlocked = true; this.setAlert({ category: t('noRoute'), text: tx(r.error) }); return; }
    const route = this.#spliceRoute(r);
    return { deltaM: route.lengthM - old.lengthM, obstacle };
  }

  /** Skleja przebytą część bieżącej trasy z planem `onward` od pozycji załogi (tryb lokalny). */
  #spliceRoute(onward) {
    const old = this.state.route, s = this.sim.crewS, wps = this.sim.waypoints;
    const walked = s > 0 ? old.poly.slice(0, s) : [old.poly.at(0)];
    const path = walked.concat(onward.path.slice(1));
    const off = walked.length - 1;
    const wpIndex = [
      ...wps.slice(0, this.sim.nextWp).map((wp) => this.#nearestIndex(walked, wp)),
      ...onward.waypointIndex.map((i) => i + off),
    ];
    const totalStop = wps.reduce((a, w) => a + (w.stopMin ?? 0), 0);
    const stats = routeStats(this.world.terrain, path, this.m.eva, wps.filter((w) => w.id !== HABITAT_ID).length, totalStop);
    this.state.discarded.push(old.poly.slice(s, old.poly.length));
    const letter = String.fromCharCode((old.letter.charCodeAt(0) - 65 + 1) % 26 + 65);   // A → … → Z → A, jak w backendzie
    this.routeBlocked = false;
    this.state.route = this.#makeRoute(path, wpIndex, letter, { ...stats, uncertainty: old.uncertainty }, { t0: this.now, dur: 0.65, s0: s });
    this.sim.setRoute(this.state.route);
    this.state.routeCardAt = this.now + 0.65;
    this.emit('route');
    return this.state.route;
  }

  /** Powrót do habitatu od bieżącej pozycji załogi. Po dojściu do śluzy wyjście się kończy. */
  async returnToHabitat() {
    if (!this.state.route || !CAN_RETURN.includes(this.phase)) return null;
    if (this.remote) {
      try { return await this.ds.post('eva/return'); } catch (e) { this.setAlert({ category: t('noRoute'), text: tx(e.message) }); return null; }
    }
    const habitat = { id: HABITAT_ID, x: this.m.habitat.x, y: this.m.habitat.y, stopMin: 0 };
    const r = await this.ds.planRoute({ start: this.state.route.poly.at(this.sim.crewS), waypoints: [habitat], obstacles: this.state.obstacles });
    if (!r.ok) { this.setAlert({ category: t('noRoute'), text: tx(r.error) }); return null; }
    this.sim.beginReturn(habitat);
    return this.#spliceRoute(r);
  }

  /** Dokąd teraz idzie załoga: następny punkt trasy albo habitat. */
  navTarget() {
    const phase = this.phase;
    if (phase === 'returning' || phase === 'done') return { id: HABITAT_ID, x: this.m.habitat.x, y: this.m.habitat.y, reached: phase === 'done' };
    const wps = this.m.waypoints, i = Math.min(this.sim.nextWp, wps.length - 1);
    return { ...wps[i], reached: this.sim.nextWp >= wps.length };
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
    if (this.state.route && !this.sim.finished) {
      if (this.sim.nextWp >= this.state.route.wpS.length) return { ok: true };
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

  // ---------- jazda łazikiem ----------
  /** Pozycja łazika do rysowania: w trakcie jazdy z trasy A→B, po jeździe tam, gdzie stanął, inaczej z symulacji EVA. */
  roverPos() { return this.drive ? this.drive.pos() : this.roverAt ? { ...this.roverAt } : this.sim.roverPos(); }
  startDrive(path) {
    if (this.sim.running) this.pauseEva(true);              // EVA i jazda łazikiem nie idą naraz
    this.drive = new Drive(path, { terrain: this.world.terrain, hazards: this.world.rasters.hazards, speedKmh: this.m.rover.speedKmh });
    this.drive.running = true;
    this.emit('drive');
  }
  stopDrive() {
    if (!this.drive) return;
    this.roverAt = this.drive.pos();
    this.drive = null;
    this.emit('drive');
  }

  // ---------- EVA ----------
  /** Faza wyjścia: idle | walking | stop | atTarget | returning | done (jak pole `phase` w stanie backendu). */
  get phase() { return this.sim.phase; }
  get paused() { return !this.sim.running && this.phase !== 'idle' && this.phase !== 'done'; }

  showCrew() { this.state.crewVisible = true; this.emit('crew'); }
  startEva(timeScale = 470) {
    if (!this.state.route || this.routeBlocked) return null;
    if (this.drive || this.roverAt) { this.drive = null; this.roverAt = null; this.emit('drive'); }   // EVA zaczyna od łazika przy habitacie
    this.state.crewVisible = true;
    if (this.remote) return this.#evaCommand('eva/start', { timeScale, scenario: !this.autoEvents });
    this.sim.timeScale = timeScale;
    this.sim.running = true;
    this.emit('eva');
    return { ok: true };
  }
  pauseEva(paused) {
    if (!paused && this.routeBlocked) return;
    if (this.remote) return this.#evaCommand(paused ? 'eva/pause' : 'eva/start', paused ? {} : { timeScale: this.sim.timeScale });
    this.sim.running = !paused;
    return { ok: true };
  }
  async #evaCommand(path, body) {
    try { return await this.ds.post(path, body); } catch (e) {
      this.setAlert({ category: t('eva.error'), text: tx(e.message) });
      return null;
    }
  }

  setTimeScale(ts) { if (this.remote) return this.#evaCommand('eva/timescale', { timeScale: ts }); else this.sim.timeScale = ts; }

  setAlert(a) { this.state.alert = a ? { ...a, t0: this.now } : null; this.emit('alert'); }
  setCaption(n, text) { this.state.caption = n ? { n, text, t0: this.now } : null; this.emit('caption'); }
  setView(v) { if (this.state.view !== v) { this.state.view = v; this.emit('view', v); } }

  endSep() {
    if (!this.sim.sep && !this.state.doseHi) return;
    if (this.remote) this.#evaCommand('eva/inject', { kind: 'sep-end' });
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

  #onFinish() {
    const o2 = Math.min(...this.sim.crew.map((c) => c.o2));
    this.setAlert({ category: t('eva.doneCat'), text: t('eva.doneText', { time: hm((this.sim.min - this.sim.startMin) / 60), o2: Math.round(o2) }) });
    this.emit('finished');
  }

  /** Strona otwarta w trakcie wyjścia (odświeżenie albo restart serwera): pokazujemy załogę od razu. */
  #onOngoing(snapshot) {
    if (this.resetting) return;
    this.state.crewVisible = true;
    if (snapshot.resumed && !snapshot.running && !snapshot.finished) this.setAlert({ category: t('resume.cat'), text: t('resume.text') });
    this.emit('crew');
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
    const phase = `${this.phase}${this.sim.running ? '' : ':paused'}`;
    if (phase !== this.lastPhase) { this.lastPhase = phase; this.emit('phase', this.phase); }
    if (this.drive) {
      const was = this.drive.done;
      this.drive.step(dt);
      if (!was && this.drive.done) this.emit('drive-done');
    }
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
