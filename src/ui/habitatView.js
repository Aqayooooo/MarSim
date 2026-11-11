// Działająca baza w widoku z hełmu: wnętrze 3D we własnej scenie (własne światła, bez słońca przez ściany), śluza z cyklem
// ciśnienia, stanowiska pod klawiszem E, oświetlenie, ekrany z danymi misji i model podtrzymywania życia.
// Reguły w core/habitat.js, geometria w habitatInterior.js.
import * as THREE from 'three';
import {
  AIRLOCK, Airlock, CABIN_KPA, GREEN, HALL, HULL, LAB, LOADS_KW, ROOMS, WATER_TANK_L, ZONES, canStand, floorAt, lifeSupport, stationAt, toLocal, zoneAt,
} from '../core/habitat.js';
import { buildInterior } from './habitatInterior.js';
import { habitatEnv } from '../core/environment.js';
import { num, int, clock, hm } from '../core/format.js';
import { t, tx } from '../i18n.js';

const SCREEN_EVERY_S = 0.25, CONSOLE_PAGES = 3;
const DOOR_SLIDE = 0.92;
const C = { bg: '#0b1116', line: '#20323b', text: '#d8f3f2', dim: '#78a5a6', ok: '#5ee6a0', warn: '#ffd166', bad: '#ff7b6b', accent: '#68dee0', grow: '#ff8ce8' };
const CABINS = ROOMS.filter((r) => r.id.startsWith('cabin'));
const CREW_NAMES = ['IV1', 'IV2'];   // załoga zostająca w bazie (EV1, EV2 — z misji)

export class HabitatView {
  /** mesh: grupa modelu bazy (pozycja i obrót ustawia widok 3D). */
  constructor(app, mesh) {
    this.app = app;
    this.mesh = mesh;
    this.airlock = new Airlock();
    this.parts = buildInterior();
    this.scene = new THREE.Scene();   // wnętrze rysowane osobno, oświetlone tylko lampami bazy
    this.scene.add(new THREE.HemisphereLight(0xfff4e6, 0x3a332c, 0.55));
    this.scene.add(this.parts.group);
    this.cabinLamps = Object.fromEntries(CABINS.map((r) => [r.id, true]));
    this.night = false;
    this.page = 0;
    this.analyzed = [];
    this.medAt = null;
    this.flash = null;
    this.screenT = 0;
    this.zone = null;
    this.station = null;
    this.local = { x: 99, z: 0 };
    this.dir = { x: 1, z: 0 };
    app.on('reset', () => { this.airlock.reset(); this.flash = null; this.analyzed = []; this.medAt = null; });
  }

  get hab() { return this.app.m.habitat; }
  /** Przełączniki bazy — wspólne z modelem w czasie misji (app.habitat). */
  get systems() { return this.app.habitat.systems; }
  get angle() { return this.mesh.rotation.y; }
  #local(x, y) { return toLocal(x, y, this.hab.x, this.hab.y, this.angle); }

  /** Strefa wnętrza w punkcie planu (null = na zewnątrz). */
  zoneAtPlan(x, y) { const l = this.#local(x, y); return zoneAt(l.x, l.z, this.airlock.gates); }
  canStandPlan(x, y) { const l = this.#local(x, y); return canStand(l.x, l.z, this.airlock.gates); }
  /** Podłoga w punkcie planu: { h: nad podstawą bazy, k: udział gruntu } albo null (zwykły grunt). */
  floorAtPlan(x, y) { const l = this.#local(x, y); return floorAt(l.x, l.z, this.airlock.gates); }

  /**
   * Ruchy zastępcze, gdy krok (dx, dy) w planie trafia w ścianę: ślizg wzdłuż ścian bazy, a przy drzwiach — zejście
   * w otwór (kierunek do środka najbliższego przejścia przed postacią i jego składowe wzdłuż ścian).
   */
  slides(x, y, dx, dy) {
    const c = Math.cos(this.angle), s = Math.sin(this.angle), l = this.#local(x, y);
    const toLocal = (vx, vy) => [vx * c - vy * s, vx * s + vy * c], toPlan = (vx, vz) => [vx * c + vz * s, -vx * s + vz * c];
    const [mx, mz] = toLocal(dx, dy), len = Math.hypot(mx, mz), out = [toPlan(mx, 0), toPlan(0, mz)];
    let best = null, bd = 1.6;
    for (const z of ZONES) {
      if (z.id !== 'pass' && !z.gate) continue;
      if (z.gate && !this.airlock.gates[z.gate]) continue;
      const cx = (z.x0 + z.x1) / 2, cz = (z.z0 + z.z1) / 2, vx = cx - l.x, vz = cz - l.z, d = Math.hypot(vx, vz);
      if (d < bd && d > 0.05 && vx * mx + vz * mz > 0) { bd = d; best = [vx / d * len, vz / d * len]; }
    }
    if (best) out.push(toPlan(...best), toPlan(best[0], 0), toPlan(0, best[1]));
    return out;
  }

  /** Pod dachem i z ciśnieniem kabiny — hełm zdjęty. */
  get helmetOff() {
    const z = this.zone?.id;
    if (!z || z === 'ramp' || z === 'outerDoor') return false;
    if (z === 'airlock') return this.airlock.pressure > 0.95 && this.airlock.outer < 0.05;
    return true;
  }
  get indoors() { return !!this.zone?.inside; }

  /** Stan bazy po ruchu postaci: strefa i stanowisko w zasięgu (yaw — kierunek patrzenia). */
  track(x, y, yawDeg) {
    this.zone = this.zoneAtPlan(x, y);
    const l = this.#local(x, y), a = yawDeg * Math.PI / 180, dx = Math.sin(a), dy = -Math.cos(a);
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    this.local = l;
    this.dir = { x: dx * c - dy * s, z: dx * s + dy * c };
    this.station = stationAt(l.x, l.z, this.dir.x, this.dir.z, this.zone?.id ?? null);
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
      case 'gym': this.#toggle('treadmill', 'hab.gymOn', 'hab.gymOff'); break;
      case 'water': this.#toggle('wrs', 'hab.wrsOn', 'hab.wrsOff'); break;
      case 'map': this.night = !this.night; this.#say(this.night ? 'hab.nightOn' : 'hab.nightOff'); break;
      case 'lab': this.analyzed = this.#samples(); this.#say(this.analyzed.length ? 'hab.labDone' : 'hab.labEmpty', { n: this.analyzed.length }); break;
      case 'med': this.medAt = this.app.sim.min; this.#say('hab.medDone'); break;
      case 'suits':
        if (this.app.phase === 'idle' && !this.app.drive) { this.#say('hab.suitUp'); this.app.emit('hab-suitup'); }
        else this.#say('hab.evaBusy');
        break;
      default:
        if (!(s.id in this.cabinLamps)) return false;
        this.cabinLamps[s.id] = !this.cabinLamps[s.id];
        this.#say(this.cabinLamps[s.id] ? 'hab.lampOn' : 'hab.lampOff');
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
    const s = this.station, a = this.airlock, sys = this.systems;
    if (!s) return null;
    const act = {
      outerPanel: a.busy ? 'hab.act.wait' : a.state === 'in' ? 'hab.act.callAirlock' : 'hab.act.enter',
      airlockPanel: a.busy ? 'hab.act.wait' : a.state === 'out' ? 'hab.act.pressurize' : 'hab.act.depressurize',
      hatchPanel: a.busy ? 'hab.act.wait' : a.state === 'out' ? 'hab.act.pressurize' : 'hab.act.enterAirlock',
      lights: sys.lights ? 'hab.act.lightsOff' : 'hab.act.lightsOn',
      console: 'hab.act.page',
      life: sys.moxie ? 'hab.act.moxieOff' : 'hab.act.moxieOn',
      greenhouse: sys.grow ? 'hab.act.growOff' : 'hab.act.growOn',
      gym: sys.treadmill ? 'hab.act.gymOff' : 'hab.act.gymOn',
      water: sys.wrs ? 'hab.act.wrsOff' : 'hab.act.wrsOn',
      map: this.night ? 'hab.act.dayMode' : 'hab.act.nightMode',
      lab: 'hab.act.analyze',
      med: 'hab.act.checkup',
      suits: this.app.phase === 'idle' && !this.app.drive ? 'hab.act.suitUp' : 'hab.act.suits',
    }[s.id] ?? (this.cabinLamps[s.id] ? 'hab.act.lampOff' : 'hab.act.lampOn');
    return t('hab.prompt', { s: t(`hab.st.${s.id}`), a: t(act) });
  }

  /** Bieżący bilans bazy (liczony w App z zegarem misji). */
  lifeSupport() { return this.app.habitat.now ?? lifeSupport({ ...habitatEnv(this.app), ...this.systems, pumping: false }); }

  /** Dane dla wskaźników bazy (ui/habHud.js). */
  info() {
    const a = this.airlock, z = this.zone?.id ?? 'ramp';
    const flash = this.flash && performance.now() - this.flash.t < 2600 ? this.flash.text : null;
    const status = z === 'airlock' || z === 'outerDoor' || z === 'ramp'
      ? t('hab.airlockLine', { p: num(a.kPa, 1), s: t(`hab.al.${a.stage ?? a.state}`) })
      : t('hab.cabinLine', { p: num(CABIN_KPA, 1), o: 34, c: int(this.lifeSupport().co2Ppm) });
    return { zone: t(`hab.zone.${z}`), status, prompt: this.prompt(), flash, helmetOff: this.helmetOff, cycling: a.busy, progress: a.progress };
  }

  /** Krok: śluza, drzwi, światła, ekrany; near — postać blisko bazy (wnętrze warto rysować). */
  step(dt, near) {
    const a = this.airlock, p = this.parts, sys = this.systems;
    a.step(dt);
    this.app.habitat.pumping = a.stage === 'pump';
    p.group.position.copy(this.mesh.position);
    p.group.rotation.copy(this.mesh.rotation);
    p.group.visible = this.mesh.visible;
    p.doors.inner.position.z = -a.inner * DOOR_SLIDE;
    p.doors.outer.position.z = -a.outer * DOOR_SLIDE;
    const main = sys.lights ? (this.night ? 0.3 : 1) : 0.03;
    const cabinLights = new Map(Object.entries(p.cabins).map(([k, c]) => [c.light, k]));
    for (const e of p.lights) {
      const cabin = cabinLights.get(e);
      e.light.intensity = !near ? 0 : cabin ? (this.cabinLamps[cabin] ? e.base : 0) : e.base * main;
    }
    for (const [k, c] of Object.entries(p.cabins)) c.bulb.emissiveIntensity = this.cabinLamps[k] ? 1.6 : 0;
    p.strips.emissiveIntensity = 1.4 * main + 0.04;
    p.grow.emissiveIntensity = sys.grow ? 1.6 : 0.05;
    p.growLight.intensity = sys.grow && near ? 3 : 0;
    if (sys.treadmill) p.belt.offset.y -= dt * 1.8;
    const col = a.busy ? 0xffb020 : a.state === 'in' ? 0x40ff80 : 0xff5040;   // zielone: kabina, czerwone: próżnia
    for (const lamp of [p.airLamp, p.outLamp]) { lamp.material.color.setHex(col); lamp.material.emissive.setHex(col); }
    p.airLight.color.setHex(col);
    p.airLight.intensity = near ? 1.4 : 0;
    this.scene.children[0].intensity = 0.15 + 0.4 * main;
    this.screenT += dt;
    if (near && this.screenT >= SCREEN_EVERY_S) { this.screenT = 0; this.#drawScreens(); }
    return this.indoors && this.zone?.id !== 'ramp';
  }

  /** Próbki z punktów osiągniętych w czasie EVA: odczyt warstw misji w tych miejscach. */
  #samples() {
    const app = this.app, w = app.world, wps = app.m.waypoints;
    return app.sim.reached.filter((id) => id !== 'HAB').map((id) => {
      const wp = wps.find((p) => p.id === id);
      if (!wp) return null;
      const cls = w.rasters.minerals?.meta?.classes?.[w.rasters.minerals.sample(wp.x, wp.y)];
      return {
        id, elev: w.terrain.height(wp.x, wp.y) + w.terrain.minH, slope: w.terrain.slope(wp.x, wp.y),
        mineral: cls ? tx(cls.text) : t('hab.lab.none'), sand: w.rasters.sand ? w.rasters.sand.sample(wp.x, wp.y) / 2.55 : null,
      };
    }).filter(Boolean);
  }

  // ---------- ekrany ----------
  #drawScreens() {
    const s = this.parts.screens, ls = this.lifeSupport(), sys = this.systems;
    s.console.draw((g, w, h) => this.#console(g, w, h, ls));
    s.life.draw((g, w, h) => this.#life(g, w, h, ls));
    for (const k of ['airlock', 'hatch', 'outer']) s[k].draw((g, w, h) => this.#airlockScreen(g, w, h));
    s.green.draw((g, w, h) => this.#green(g, w, h, ls));
    s.lights.draw((g, w, h) => {
      frame(g, w, h, sys.lights ? C.warn : C.dim);
      g.fillStyle = sys.lights ? C.warn : C.dim; g.font = '700 64px sans-serif'; g.textAlign = 'center';
      g.fillText(sys.lights ? 'ON' : 'OFF', w / 2, h / 2 + 22);
    });
    s.map.draw((g, w, h) => this.#map(g, w, h));
    s.gym.draw((g, w, h) => {
      frame(g, w, h, sys.treadmill ? C.ok : C.dim);
      title(g, t('hab.st.gym'));
      table(g, [[t('hab.gym.belt'), sys.treadmill ? 'ON · 6 km/h' : 'OFF'], [t('hab.gym.load'), sys.treadmill ? `+${num(LOADS_KW.treadmill, 1)} kW` : '—'], [t('hab.gym.goal'), '2 h / sol']], 70, w, 50);
    });
    s.water.draw((g, w, h) => {
      const hs = this.app.habitat;
      frame(g, w, h, sys.wrs ? C.accent : C.warn);
      title(g, t('hab.st.water'));
      table(g, [
        [t('hab.w.tank'), `${int(hs.waterL)} / ${WATER_TANK_L} l`, hs.waterPct / 100],
        [t('hab.w.wrs'), sys.wrs ? 'ON · 93%' : 'OFF'],
        [t('hab.w.balance'), `${num(ls.waterLh, 2)} l/h`],
      ], 66, w, 54);
    });
    s.lab.draw((g, w, h) => this.#lab(g, w, h));
    s.med.draw((g, w, h) => this.#med(g, w, h));
    CABINS.forEach((r, k) => s[r.id].draw((g, w, h) => {
      const who = this.app.sim.crew[k]?.id ?? CREW_NAMES[k - this.app.sim.crew.length] ?? '—';
      frame(g, w, h, this.cabinLamps[r.id] ? C.warn : C.dim);
      g.fillStyle = C.text; g.font = '700 30px sans-serif'; g.fillText(`${t(`hab.st.${r.id}`)}`, 16, 44);
      g.fillStyle = C.accent; g.font = '600 26px sans-serif'; g.fillText(who, 16, 86);
      g.fillStyle = C.dim; g.font = '20px sans-serif'; g.fillText(`${clock(this.app.sim.min)} LTST · ${t('hab.cab.sleep')}`, 16, 130);
      g.fillText(`${t('hab.cab.lamp')} ${this.cabinLamps[r.id] ? 'ON' : 'OFF'}`, 16, 168);
    }));
  }

  #map(g, w, h) {
    frame(g, w, h, C.accent);
    title(g, t('hab.st.map'));
    const X0 = -21, X1 = 11, Z0 = -10, Z1 = 12, k = Math.min((w - 40) / (X1 - X0), (h - 80) / (Z1 - Z0));
    const px = (x) => 20 + (x - X0) * k, pz = (z) => 62 + (Z1 - z) * k;   // północ (+z) u góry
    const rect = (x0, x1, z0, z1, fill) => { g.fillStyle = fill; g.fillRect(px(x0), pz(z1), (x1 - x0) * k, (z1 - z0) * k); g.strokeRect(px(x0), pz(z1), (x1 - x0) * k, (z1 - z0) * k); };
    g.strokeStyle = C.dim; g.lineWidth = 1.5;
    rect(HULL.x0, HULL.x1, -HULL.r, HULL.r, '#16303a');
    rect(AIRLOCK.x0, AIRLOCK.x1, -AIRLOCK.z, AIRLOCK.z, '#2a2a16');
    rect(HALL.x0, HALL.partition, -HALL.z, HALL.z, '#1d2440');
    rect(HALL.partition, HALL.x1, -HALL.z, HALL.z, '#16303a');
    rect(LAB.x0, LAB.x1, LAB.z0, LAB.z1, '#1d3a2c');
    rect(GREEN.x - GREEN.r, GREEN.x + GREEN.r, GREEN.z0, GREEN.z1 + GREEN.r, '#3a1d36');
    for (const r of ROOMS) rect(r.x0, r.x1, r.z0, r.z1, 'rgba(255,255,255,.04)');
    g.fillStyle = C.text; g.font = '15px sans-serif'; g.textAlign = 'center';
    const label = (key, x, z) => g.fillText(t(key), px(x), pz(z) + 5);
    label('hab.zone.module', 0, 0); label('hab.zone.airlock', 5.9, 0); label('hab.zone.hub', -7.3, 0.6); label('hab.zone.corridor', -15, 0);
    label('hab.zone.lab', -7.25, -6); label('hab.zone.greenhouse', -7.25, 7);
    for (const r of ROOMS) label(`hab.zone.${r.id}`, (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2);
    const me = this.local;
    if (me.x > -22 && me.x < 12 && me.z > -11 && me.z < 13) {
      g.fillStyle = C.warn; g.beginPath(); g.arc(px(me.x), pz(me.z), 7, 0, Math.PI * 2); g.fill();
      g.strokeStyle = C.warn; g.lineWidth = 3; g.beginPath(); g.moveTo(px(me.x), pz(me.z)); g.lineTo(px(me.x + this.dir.x * 1.5), pz(me.z + this.dir.z * 1.5)); g.stroke();
    }
    g.textAlign = 'left'; g.fillStyle = C.dim; g.font = '15px sans-serif';
    g.fillText(t(this.night ? 'hab.map.night' : 'hab.map.day'), 18, h - 14);
  }

  #lab(g, w, h) {
    frame(g, w, h, C.ok);
    title(g, t('hab.st.lab'));
    const list = this.analyzed;
    if (!list.length) {
      g.fillStyle = C.dim; g.font = '22px sans-serif';
      g.fillText(t(this.#samples().length ? 'hab.lab.pending' : 'hab.lab.collect'), 18, 110);
      return;
    }
    g.font = '18px sans-serif';
    list.slice(0, 6).forEach((s, i) => {
      const y = 92 + i * 48;
      g.fillStyle = C.accent; g.font = '700 20px sans-serif'; g.fillText(s.id, 18, y);
      g.fillStyle = C.text; g.font = '18px sans-serif';
      g.fillText(`${int(s.elev)} m · ${num(s.slope, 0)}° · ${s.sand == null ? '' : `${t('hab.lab.sand')} ${int(s.sand)}%`}`, 90, y);
      g.fillStyle = C.dim; g.font = '16px sans-serif'; g.fillText(s.mineral.slice(0, 58), 90, y + 22);
    });
  }

  #med(g, w, h) {
    const sim = this.app.sim, snap = sim.snap;
    frame(g, w, h, C.accent);
    title(g, t('hab.st.med'));
    if (this.medAt == null) { g.fillStyle = C.dim; g.font = '20px sans-serif'; g.fillText(t('hab.med.hint'), 18, 110); return; }
    const rows = sim.crew.map((c, i) => {
      const tl = snap?.crew?.[i], career = tl?.career?.fraction;
      return [c.id, `O₂ ${num(c.o2, 0)}%${tl ? ` · ${tl.hr} bpm` : ''}${career != null ? ` · ${num(career * 100, 1)}%` : ''}`];
    });
    rows.push([t('hab.med.dose'), `${int(snap?.env?.doseUsvh ?? this.app.m.environment.doseUsvh)} µSv/h`]);
    rows.push([t('hab.med.at'), `${clock(this.medAt)} LTST`]);
    table(g, rows, 62, w, 44);
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
      rows.push([t('hab.c.solar'), `${num(ls.solarKw, 2)} kW`, ls.solarKw / 7]);
      rows.push([t('hab.c.load'), `${num(ls.loadKw, 2)} kW`, ls.loadKw / 7]);
      rows.push([t('hab.c.balance'), `${ls.balanceKw >= 0 ? '+' : ''}${num(ls.balanceKw, 2)} kW`]);
      const hs = this.app.habitat;
      rows.push([t('hab.c.battery'), `${int(hs.batteryPct)}% · ${ls.balanceKw >= 0 ? t('hab.c.charging') : span(hs.batteryKWh / -ls.balanceKw)}`, hs.batteryPct / 100]);
    }
    table(g, rows, 66, w, 40);
    if (this.page === 2) {   // odbiorniki: udział w poborze
      let x = 18, y = 248;
      g.font = '15px sans-serif';
      for (const [k, v] of Object.entries(ls.loads).filter(([, kw]) => kw > 0)) {
        const label = `${t(`hab.load.${k}`)} ${num(v, 1)}`, tw = g.measureText(label).width + 16;
        if (x + tw > w - 18) { x = 18; y += 32; }
        g.fillStyle = C.line; g.fillRect(x, y, tw, 26);
        g.fillStyle = C.text; g.fillText(label, x + 8, y + 18);
        x += tw + 6;
      }
    }
    g.fillStyle = C.dim; g.font = '15px sans-serif'; g.fillText(t('hab.c.hint'), 18, h - 14);
  }

  #life(g, w, h, ls) {
    frame(g, w, h, ls.o2BalanceGh < 0 ? C.warn : C.ok);
    title(g, t('hab.st.life'));
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
    title(g, t('hab.st.greenhouse'));
    table(g, [
      [t('hab.g.lamps'), on ? `ON · ${num(LOADS_KW.grow, 1)} kW` : 'OFF'],
      [t('hab.g.o2'), on ? '+18 g/h' : '0 g/h'],
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

function title(g, text) { g.fillStyle = C.text; g.font = '700 24px sans-serif'; g.textAlign = 'left'; g.fillText(text, 18, 40); }

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
