// Działający habitat w widoku z hełmu: wnętrze 3D, śluza z cyklem ciśnienia, stanowiska pod klawiszem E,
// oświetlenie, ekrany z danymi misji i model podtrzymywania życia. Reguły w core/habitat.js, geometria w habitatInterior.js.
import {
  Airlock, LOADS_KW, CABIN_KPA, floorAt, canStand, lifeSupport, stationAt, toLocal, zoneAt,
} from '../core/habitat.js';
import { buildInterior } from './habitatInterior.js';
import { habitatEnv } from '../core/environment.js';
import { num, int, clock, hm } from '../core/format.js';
import { t } from '../i18n.js';

const SCREEN_EVERY_S = 0.25, NEAR_M = 30, CONSOLE_PAGES = 3;
const DOOR_SLIDE = 0.92;
const C = { bg: '#0b1116', line: '#20323b', text: '#d8f3f2', dim: '#78a5a6', ok: '#5ee6a0', warn: '#ffd166', bad: '#ff7b6b', accent: '#68dee0', grow: '#ff8ce8' };

export class HabitatView {
  /** mesh: grupa modelu habitatu (pozycja i obrót ustawia widok 3D). */
  constructor(app, mesh) {
    this.app = app;
    this.mesh = mesh;
    this.airlock = new Airlock();
    this.parts = buildInterior();
    mesh.add(this.parts.group);
    this.page = 0;
    this.flash = null;
    this.screenT = 0;
    this.zone = null;
    this.station = null;
    app.on('reset', () => { this.airlock.reset(); this.flash = null; });
  }

  get hab() { return this.app.m.habitat; }
  /** Przełączniki habitatu — wspólne z modelem w czasie misji (app.habitat). */
  get systems() { return this.app.habitat.systems; }
  get angle() { return this.mesh.rotation.y; }
  #local(x, y) { return toLocal(x, y, this.hab.x, this.hab.y, this.angle); }

  /** Strefa wnętrza w punkcie planu (null = na zewnątrz). */
  zoneAtPlan(x, y) { const l = this.#local(x, y); return zoneAt(l.x, l.z, this.airlock.gates); }
  canStandPlan(x, y) { const l = this.#local(x, y); return canStand(l.x, l.z, this.airlock.gates); }
  /** Podłoga w punkcie planu: { h: nad podstawą habitatu, k: udział gruntu } albo null (zwykły grunt). */
  floorAtPlan(x, y) { const l = this.#local(x, y); return floorAt(l.x, l.z, this.airlock.gates); }

  /** Pod dachem i z ciśnieniem kabiny — hełm zdjęty. */
  get helmetOff() {
    const z = this.zone?.id;
    return z === 'module' || z === 'greenhouse' || z === 'innerDoor' || (z === 'airlock' && this.airlock.pressure > 0.95 && this.airlock.outer < 0.05);
  }
  get indoors() { return !!this.zone?.inside; }

  /** Stan habitatu po ruchu postaci: strefa i stanowisko w zasięgu (yaw — kierunek patrzenia). */
  track(x, y, yawDeg) {
    this.zone = this.zoneAtPlan(x, y);
    const l = this.#local(x, y), a = yawDeg * Math.PI / 180, dx = Math.sin(a), dy = -Math.cos(a);
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    this.station = stationAt(l.x, l.z, dx * c - dy * s, dx * s + dy * c, this.indoors);
    this.dist = Math.hypot(x - this.hab.x, y - this.hab.y);
  }

  #say(key, vars) { this.flash = { text: t(key, vars), t: performance.now() }; }

  /** Działanie stanowiska w zasięgu (klawisz E). Zwraca true, gdy coś było w zasięgu. */
  use() {
    const s = this.station, a = this.airlock;
    if (!s) return false;
    const inDoor = this.zone?.id === 'innerDoor' || this.zone?.id === 'outerDoor';
    const cycle = (to) => {
      if (a.busy) return this.#say('hab.busy');
      if (inDoor) return this.#say('hab.clearDoor');
      if (a.cycle(to)) this.#say(to === 'in' ? 'hab.pressurize' : 'hab.depressurize');
    };
    switch (s.id) {
      case 'outerPanel': if (a.state === 'in') cycle('out'); else this.#say(a.busy ? 'hab.busy' : 'hab.openOuter'); break;
      case 'airlockPanel': cycle(a.state === 'out' ? 'in' : 'out'); break;
      case 'hatchPanel': if (a.state === 'out') cycle('in'); else this.#say(a.busy ? 'hab.busy' : 'hab.readyIn'); break;
      case 'lights': this.#say(this.app.habitat.toggle('lights') ? 'hab.lightsOn' : 'hab.lightsOff'); break;
      case 'console': this.page = (this.page + 1) % CONSOLE_PAGES; this.#say(`hab.page${this.page}`); break;
      case 'life': this.#toggle('moxie', 'hab.moxieOn', 'hab.moxieOff'); break;
      case 'greenhouse': this.#toggle('grow', 'hab.growOn', 'hab.growOff'); break;
      case 'suits':
        if (this.app.phase === 'idle' && !this.app.drive) { this.#say('hab.suitUp'); this.app.emit('hab-suitup'); }
        else this.#say('hab.evaBusy');
        break;
      default: return false;
    }
    this.screenT = SCREEN_EVERY_S;   // ekrany od razu pokazują zmianę
    return true;
  }

  #toggle(id, on, off) {
    const h = this.app.habitat, was = h.systems[id], now = h.toggle(id);
    this.#say(now === was ? 'hab.shedBlocked' : now ? on : off);
  }

  /** Napis akcji dla stanowiska w zasięgu (podpowiedź „E — …”). */
  prompt() {
    const s = this.station, a = this.airlock;
    if (!s) return null;
    const act = {
      outerPanel: a.busy ? 'hab.act.wait' : a.state === 'in' ? 'hab.act.callAirlock' : 'hab.act.enter',
      airlockPanel: a.busy ? 'hab.act.wait' : a.state === 'out' ? 'hab.act.pressurize' : 'hab.act.depressurize',
      hatchPanel: a.busy ? 'hab.act.wait' : a.state === 'out' ? 'hab.act.pressurize' : 'hab.act.enterAirlock',
      lights: this.systems.lights ? 'hab.act.lightsOff' : 'hab.act.lightsOn',
      console: 'hab.act.page',
      life: this.systems.moxie ? 'hab.act.moxieOff' : 'hab.act.moxieOn',
      greenhouse: this.systems.grow ? 'hab.act.growOff' : 'hab.act.growOn',
      suits: this.app.phase === 'idle' && !this.app.drive ? 'hab.act.suitUp' : 'hab.act.suits',
    }[s.id];
    return t('hab.prompt', { s: t(`hab.st.${s.id}`), a: t(act) });
  }

  /** Bieżący bilans habitatu (liczony w App z zegarem misji). */
  lifeSupport() { return this.app.habitat.now ?? lifeSupport({ ...habitatEnv(this.app), ...this.systems, pumping: false }); }

  /** Dane dla wskaźników habitatu (ui/habHud.js). */
  info() {
    const a = this.airlock, z = this.zone?.id ?? 'ramp';
    const flash = this.flash && performance.now() - this.flash.t < 2600 ? this.flash.text : null;
    const status = z === 'airlock' || z === 'outerDoor' || z === 'ramp'
      ? t('hab.airlockLine', { p: num(a.kPa, 1), s: t(`hab.al.${a.stage ?? a.state}`) })
      : t('hab.cabinLine', { p: num(CABIN_KPA, 1), o: 34, c: int(this.lifeSupport().co2Ppm) });
    return { zone: t(`hab.zone.${z}`), status, prompt: this.prompt(), flash, helmetOff: this.helmetOff, cycling: a.busy, progress: a.progress };
  }

  /** Krok: śluza, drzwi, światła, ekrany. */
  step(dt, near) {
    const a = this.airlock, p = this.parts;
    a.step(dt);
    this.app.habitat.pumping = a.stage === 'pump';
    p.doors.inner.position.z = -a.inner * DOOR_SLIDE;
    p.doors.outer.position.z = -a.outer * DOOR_SLIDE;
    const inside = this.indoors && this.zone?.id !== 'ramp';
    const on = this.systems.lights;
    for (const l of p.lamps) l.intensity = on && near ? 4.5 : 0;
    p.strips.emissiveIntensity = on ? 1.4 : 0.05;
    p.grow.emissiveIntensity = this.systems.grow ? 1.6 : 0.05;
    p.growLight.intensity = this.systems.grow && near ? 3 : 0;
    const col = a.busy ? 0xffb020 : a.state === 'in' ? 0x40ff80 : 0xff5040;   // zielone: kabina, czerwone: próżnia
    for (const lamp of [p.airLamp, p.outLamp]) { lamp.material.color.setHex(col); lamp.material.emissive.setHex(col); }
    p.airLight.color.setHex(col);
    p.airLight.intensity = near ? 1.4 : 0;
    this.screenT += dt;
    if (near && this.screenT >= SCREEN_EVERY_S) { this.screenT = 0; this.#drawScreens(); }
    return inside;
  }

  // ---------- ekrany ----------
  #drawScreens() {
    const s = this.parts.screens, ls = this.lifeSupport();
    s.console.draw((g, w, h) => this.#console(g, w, h, ls));
    s.life.draw((g, w, h) => this.#life(g, w, h, ls));
    for (const k of ['airlock', 'hatch', 'outer']) s[k].draw((g, w, h) => this.#airlockScreen(g, w, h));
    s.green.draw((g, w, h) => this.#green(g, w, h, ls));
    s.lights.draw((g, w, h) => {
      frame(g, w, h, this.systems.lights ? C.warn : C.dim);
      g.fillStyle = this.systems.lights ? C.warn : C.dim; g.font = '700 64px sans-serif'; g.textAlign = 'center';
      g.fillText(this.systems.lights ? 'ON' : 'OFF', w / 2, h / 2 + 22);
    });
  }

  #console(g, w, h, ls) {
    const app = this.app, sim = app.sim, m = app.m;
    frame(g, w, h, C.accent);
    const tabs = [t('hab.page0'), t('hab.page1'), t('hab.page2')];
    g.font = '600 20px sans-serif';
    tabs.forEach((label, i) => {
      g.fillStyle = i === this.page ? C.accent : C.line; g.fillRect(16 + i * 205, 14, 195, 34);
      g.fillStyle = i === this.page ? C.bg : C.dim; g.fillText(label, 28 + i * 205, 38);
    });
    const rows = [];
    if (this.page === 0) {
      const phase = app.phase, target = app.navTarget?.();
      rows.push([`SOL ${m.mission.sol}`, `${clock(sim.min)} LTST`]);
      rows.push([t('hab.c.phase'), t(`phase.${phase}`, { wp: target?.id ?? '—' })]);
      rows.push([t('hab.c.route'), app.state.route ? `${num(app.state.route.lengthM / 1000, 2)} km · ${app.state.route.wpIds.length} WP` : t('hab.c.noRoute')]);
      sim.crew.forEach((c) => rows.push([`${c.id} O₂`, `${num(c.o2, 0)}%`, c.o2 / 100]));
      if (app.state.route && phase !== 'idle') rows.push([t('hab.c.reserve'), hm(Math.max(0, sim.reserveH()))]);
    } else if (this.page === 1) {
      const env = sim.snap?.env, e = m.environment, he = habitatEnv(app);
      rows.push([t('hab.c.sun'), `${num(he.sunElevDeg, 0)}°`]);
      rows.push([t('hab.c.tau'), num(he.tau, 2)]);
      rows.push([t('hab.c.temp'), `${int(he.outsideC)} °C`]);
      rows.push([t('hab.c.wind'), `${num(app.state.wind ?? e.wind.meanMs, 1)} m/s`]);
      rows.push([t('hab.c.dose'), `${int(env?.doseUsvh ?? e.doseUsvh)} µSv/h`]);
    } else {
      rows.push([t('hab.c.solar'), `${num(ls.solarKw, 2)} kW`, ls.solarKw / 6]);
      rows.push([t('hab.c.load'), `${num(ls.loadKw, 2)} kW`, ls.loadKw / 6]);
      rows.push([t('hab.c.balance'), `${ls.balanceKw >= 0 ? '+' : ''}${num(ls.balanceKw, 2)} kW`]);
      const hs = this.app.habitat;
      rows.push([t('hab.c.battery'), `${int(hs.batteryPct)}% · ${ls.balanceKw >= 0 ? t('hab.c.charging') : span(hs.batteryKWh / -ls.balanceKw)}`, hs.batteryPct / 100]);
    }
    table(g, rows, 66, w, 40);
    if (this.page === 2) {   // odbiorniki: udział w poborze
      let x = 18;
      g.font = '15px sans-serif';
      for (const [k, v] of Object.entries(ls.loads).filter(([, kw]) => kw > 0)) {
        const label = `${t(`hab.load.${k}`)} ${num(v, 1)}`, tw = g.measureText(label).width + 16;
        if (x + tw > w - 18) break;
        g.fillStyle = C.line; g.fillRect(x, 248, tw, 26);
        g.fillStyle = C.text; g.fillText(label, x + 8, 266);
        x += tw + 6;
      }
    }
    g.fillStyle = C.dim; g.font = '15px sans-serif'; g.fillText(t('hab.c.hint'), 18, h - 14);
  }

  #life(g, w, h, ls) {
    frame(g, w, h, ls.o2BalanceGh < 0 && !Number.isFinite(ls.o2Hours) ? C.bad : C.ok);
    g.fillStyle = C.text; g.font = '700 24px sans-serif'; g.fillText(t('hab.st.life'), 18, 40);
    table(g, [
      [t('hab.l.pressure'), `${num(ls.kPa, 1)} kPa`],
      ['O₂', `${ls.o2Pct}%`],
      ['CO₂', `${int(ls.co2Ppm)} ppm`],
      [t('hab.l.temp'), `${ls.tempC} °C`],
      ['MOXIE', this.systems.moxie ? `ON · ${num(LOADS_KW.moxie, 1)} kW` : 'OFF'],
      [t('hab.l.o2'), `${ls.o2BalanceGh >= 0 ? '+' : ''}${int(ls.o2BalanceGh)} g/h`],
      [t('hab.l.tank'), `${num(this.app.habitat.o2Kg, 1)} kg · ${ls.o2BalanceGh < 0 ? span(this.app.habitat.o2Kg * 1000 / -ls.o2BalanceGh) : t('hab.l.stable')}`],
    ], 64, w, 38);
    g.fillStyle = C.dim; g.font = '14px sans-serif'; g.fillText(t('hab.l.model'), 18, h - 14);
  }

  #airlockScreen(g, w, h) {
    const a = this.airlock, col = a.busy ? C.warn : a.state === 'in' ? C.ok : C.bad;
    frame(g, w, h, col);
    g.fillStyle = C.dim; g.font = '600 20px sans-serif'; g.fillText(t('hab.st.airlockPanel').toUpperCase(), 18, 36);
    const kp = num(a.kPa, 1);
    g.fillStyle = col; g.font = '700 64px sans-serif'; g.fillText(kp, 18, 120);
    const kw = g.measureText(kp).width;
    g.font = '600 26px sans-serif'; g.fillText('kPa', 30 + kw, 120);
    g.fillStyle = C.text; g.font = '600 24px sans-serif'; g.fillText(t(`hab.al.${a.stage ?? a.state}`), 18, 170);
    g.fillStyle = C.line; g.fillRect(18, 200, w - 36, 22);
    g.fillStyle = col; g.fillRect(18, 200, (w - 36) * (a.busy ? a.progress : 1), 22);
    g.fillStyle = C.dim; g.font = '16px sans-serif'; g.fillText(t('hab.al.doors', { i: t(a.inner > 0.95 ? 'hab.open' : 'hab.closed'), o: t(a.outer > 0.95 ? 'hab.open' : 'hab.closed') }), 18, 248);
  }

  #green(g, w, h, ls) {
    const on = this.systems.grow;
    frame(g, w, h, on ? C.grow : C.dim);
    g.fillStyle = C.text; g.font = '700 26px sans-serif'; g.fillText(t('hab.st.greenhouse'), 18, 40);
    table(g, [
      [t('hab.g.lamps'), on ? `ON · ${num(LOADS_KW.grow, 1)} kW` : 'OFF'],
      [t('hab.g.o2'), on ? '+14 g/h' : '0 g/h'],
      [t('hab.g.day'), `${this.app.m.mission.sol % 90 + 1} / 90`],
      [t('hab.g.air'), '24 °C · 70%'],
    ], 66, w, 40);
    g.fillStyle = C.dim; g.font = '15px sans-serif'; g.fillText(t(ls.o2BalanceGh < 0 ? 'hab.g.deficit' : 'hab.g.surplus'), 18, h - 16);
  }
}

/** Czas: do dwóch dób jako g:mm h, dłużej w solach (doba Marsa 24,66 h). */
function span(hours) { return hours < 48 ? hm(hours) : `${num(hours / 24.66, 0)} sol`; }

function frame(g, w, h, col) {
  g.fillStyle = C.bg; g.fillRect(0, 0, w, h);
  g.strokeStyle = col; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
  g.textAlign = 'left';
}

function table(g, rows, y0, w, step = 44) {
  rows.forEach(([k, v, bar], i) => {
    const y = y0 + i * step;
    g.fillStyle = C.dim; g.font = '20px sans-serif'; g.textAlign = 'left'; g.fillText(k, 18, y + 20);
    g.fillStyle = C.text; g.font = '600 22px sans-serif'; g.textAlign = 'right'; g.fillText(v, w - 18, y + 20);
    if (bar != null) {
      g.fillStyle = C.line; g.fillRect(18, y + 28, w - 36, 5);
      g.fillStyle = bar < 0.25 ? C.bad : bar < 0.5 ? C.warn : C.ok; g.fillRect(18, y + 28, (w - 36) * Math.max(0, Math.min(1, bar)), 5);
    }
  });
  g.textAlign = 'left';
}
