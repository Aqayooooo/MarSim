// Symulacja EVA w przeglądarce (tryb bez backendu): zegar misji, marsz załogi po trasie, tlen, zapas na powrót, łazik.
// Działa na danych z mission.json; nie zawiera logiki interfejsu.
// Fazy wyjścia są takie same jak w backendzie: idle → walking/stop → atTarget → returning → done.
import { parseClock } from './format.js';

export const HABITAT_ID = 'HAB';
const CREW_SPACING_M = 14;      // EV2 idzie tyle metrów za EV1
const ROVER_STANDOFF_M = 110;   // łazik zatrzymuje się tyle metrów za załogą
const WALKBACK_WARNING_H = 0.25; // jak w backendzie: ostrzeżenie przy zapasie na powrót poniżej 15 min

export class Sim {
  /** rasters: warstwy misji (timeToHabitat — czas dojścia pieszo do habitatu w sekundach). */
  constructor(mission, hooks = {}, rasters = {}) {
    this.m = mission;
    this.hooks = hooks;
    this.rasters = rasters;
    this.reset();
  }

  reset() {
    const m = this.m;
    this.startMin = parseClock(m.mission.startClock);
    this.min = this.startMin;
    this.running = false;
    this.finished = false;                      // załoga wróciła do habitatu
    this.returning = false;
    this.timeScale = 470;                       // sekundy misji na sekundę rzeczywistą
    this.crewS = 0;                             // odległość EV1 wzdłuż trasy (m)
    this.gap = CREW_SPACING_M;
    this.crew = m.crew.map((c) => ({ ...c, o2: c.o2 }));
    this.waypoints = [...m.waypoints];          // punkty bieżącej trasy (powrót dopisuje habitat)
    this.stopUntil = -1;
    this.nextWp = 0;
    this.reached = [];
    this.sep = false;
    this.rover = { s: 0, mode: 'parked' };      // parked | toCrew
    this.fired = new Set();
    this.firedAt = {};
    this.route = null;
    this.warned = new Set();                    // alarmy tlenu już zgłoszone w tej sesji
  }

  setRoute(route) { this.route = route; }

  /** Powrót: trasa kończy się w habitacie; nieodwiedzone punkty wypadają z planu. */
  beginReturn(habitat) {
    this.waypoints = [...this.waypoints.slice(0, this.nextWp), habitat];
    this.returning = true;
    this.stopUntil = -1;
  }

  get phase() {
    if (this.finished) return 'done';
    if (!this.route || (this.min === this.startMin && !this.running)) return 'idle';
    if (this.nextWp >= this.route.wpS.length) return 'atTarget';
    if (this.returning) return 'returning';
    return this.min < this.stopUntil ? 'stop' : 'walking';
  }

  get walkMpm() { return this.m.eva.walkKmh * 1000 / 60; }

  crewPos(i = 0) {
    if (!this.route) return { ...this.m.rover };
    return this.route.poly.at(Math.max(0, this.crewS - i * this.gap));
  }
  roverPos() {
    if (!this.route || this.rover.mode === 'parked' && this.rover.s === 0) return { x: this.m.rover.x, y: this.m.rover.y };
    return this.route.poly.at(this.rover.s);
  }

  /** Zapas na powrót osoby i (h): czas do osiągnięcia rezerwy O₂ minus czas dojścia pieszo do habitatu (jak w backendzie). */
  memberReserveH(i) {
    const c = this.crew[i], f = this.sep ? this.m.eva.sepO2Factor : 1;
    const toHab = this.rasters.timeToHabitat;
    const p = this.crewPos(i);
    const backH = toHab ? toHab.sample(p.x, p.y) / 3600 : Math.max(0, this.crewS - i * this.gap - this.rover.s) / (this.walkMpm * 60);
    return (c.o2 - this.m.eva.o2ReservePct) / (c.o2RatePctH * f) - backH;
  }

  /** Zapas na powrót (h) najsłabszej osoby. */
  reserveH() { return Math.min(...this.crew.map((_, i) => this.memberReserveH(i))); }

  /** Krok symulacji; dtReal w sekundach. */
  step(dtReal) {
    if (!this.running) return;
    const dMin = dtReal * this.timeScale / 60;
    this.min += dMin;
    const f = this.sep ? this.m.eva.sepO2Factor : 1;
    for (const c of this.crew) c.o2 = Math.max(0, c.o2 - c.o2RatePctH / 60 * dMin * f);
    if (this.route) this.#checkOxygen();

    const r = this.route;
    if (r) {
      if (this.min >= this.stopUntil && this.nextWp < r.wpS.length) this.#walk(r, dMin);
      // łazik jedzie po śladzie załogi, aż załoga znajdzie się blisko
      if (this.rover.mode === 'toCrew') {
        const stopAt = this.crewS - ROVER_STANDOFF_M;
        const spd = this.m.rover.speedKmh * 1000 / 60;
        if (this.rover.s < stopAt) this.rover.s = Math.min(stopAt, this.rover.s + spd * dMin);
      }
    }
    if (!this.finished) this.#checkEvents();
  }

  #walk(route, dMin) {
    const target = route.wpS[this.nextWp], step = this.walkMpm * dMin;
    if (this.crewS < target - 0.01) {
      const advance = Math.min(target - this.crewS, step);
      this.crewS += advance;
      this.gap = Math.min(CREW_SPACING_M, this.gap + advance);   // po postoju reszta załogi rusza, gdy odstęp wróci do normy
      return;
    }
    // prowadzący stoi w punkcie, reszta dochodzi; punkt jest osiągnięty, gdy dojdzie ostatnia osoba
    this.gap = Math.max(0, this.gap - step);
    if (this.gap > 0.01 && this.crew.length > 1) return;
    this.gap = 0;
    const wp = this.waypoints[this.nextWp];
    this.reached.push(wp.id);
    this.nextWp++;
    if (wp.id === HABITAT_ID) {
      this.finished = true;
      this.returning = false;
      this.running = false;
      this.hooks.onFinish?.();
      return;
    }
    this.stopUntil = this.min + (wp.stopMin ?? 0);
    this.hooks.onWaypoint?.(wp, this.nextWp === route.wpS.length);
  }

  /** Alarmy tlenu jak w backendzie: poniżej rezerwy, brak zapasu na powrót, mały zapas na powrót (każdy raz na sesję). */
  #checkOxygen() {
    const reserve = this.m.eva.o2ReservePct;
    this.crew.forEach((c, i) => {
      const margin = this.memberReserveH(i);
      if (c.o2 <= reserve) this.#warnOnce(c.id, 'reserve', `${c.id}: tlen poniżej rezerwy ${reserve}%`);
      else if (margin < 0) this.#warnOnce(c.id, 'noReturn', `${c.id}: za mało tlenu na powrót pieszo — wezwij łazik`);
      else if (margin < WALKBACK_WARNING_H) this.#warnOnce(c.id, 'margin', `${c.id}: zapas na powrót pieszo poniżej ${WALKBACK_WARNING_H * 60} min — zawróć`);
    });
  }

  #warnOnce(id, kind, text) {
    const key = `${id}|${kind}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.hooks.onAlert?.({ category: 'TLEN', text, highlight: 'o2' });
  }

  #checkEvents() {
    for (const ev of this.m.events) {
      if (this.fired.has(ev.id)) continue;
      const t = ev.trigger;
      let go = false;
      if (t.afterWaypoint && this.route && !this.returning) {
        const i = this.m.waypoints.findIndex((w) => w.id === t.afterWaypoint);
        go = this.reached.includes(t.afterWaypoint) && this.crewS >= this.route.wpS[i] + (t.afterM ?? 0);
      }
      if (t.afterEvent && this.fired.has(t.afterEvent)) go = this.min >= this.firedAt[t.afterEvent] + (t.afterMin ?? 0);
      if (go) {
        this.fired.add(ev.id);
        this.firedAt[ev.id] = this.min;
        this.hooks.onEvent?.(ev);
      }
    }
  }
}
