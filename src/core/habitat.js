// Habitat od środka: plan wnętrza, strefy do chodzenia, kolizje, śluza z cyklem ciśnienia i uproszczony model
// podtrzymywania życia (moc, tlen). Bez three.js i bez DOM — te same reguły w widoku 3D i w testach (node --test).
//
// Układ modelu (metry): x wzdłuż modułu głównego (+x = śluza), z w poprzek (+z = szklarnia), y w górę od podstawy.
// Moduł główny: walec r 2,3 m od x −4,5 do 4,5 z półkulą z tyłu i płaską grodzią z przodu, do której przylega śluza.
// Szklarnia: walec r 1,9 m wzdłuż z, połączona z modułem krótkim przejściem. Podłoga wszędzie na wysokości 1 m.

export const FLOOR = 1.0;           // podłoga nad podstawą habitatu
export const BODY = 0.3;            // promień postaci przy kolizjach z meblami
export const HULL = { r: 2.3, cy: 2.5, x0: -4.5, x1: 4.5, lining: 2.15 };
export const AIRLOCK = { x0: 4.5, x1: 7.3, y0: 0.5, y1: 3.7, z: 1.4, in: { x0: 4.65, x1: 7.15, top: 3.5, z: 1.25 } };   // drzwi przesuwne w szczelinach między ścianami
export const DOOR = { half: 0.45, top: FLOOR + 2.0 };          // drzwi śluzy: 0,9 × 2 m
export const GREEN = { x: -1.0, r: 1.9, cy: 2.3, z0: 2.6, z1: 6.6, lining: 1.8, hatch: { x0: -1.6, x1: -0.4, top: 3.1 } };
export const RAMP = { x0: 7.3, x1: 10.2, half: 0.7 };
export const MAST = { x: 3.2, z: -3.4 };
export const WINDOW = { x0: 2.7, x1: 4.2 };   // okno w ścianie −z modułu (wysokość 1,8–2,9 m)
export const PANELS = [-4.6, 1.4, 7.4].map((x) => ({ x, z: -8.5, w: 5.6, d: 2.4 }));   // ok. 40 m² ogniw
export const MARS_KPA = 0.6;
export const CABIN_KPA = 56.5;      // atmosfera eksploracyjna NASA: 8,2 psi, 34% O₂ — krótsze odsycanie azotu przed EVA
export const CABIN_O2_PCT = 34;

/**
 * Strefy, po których można chodzić (prostokąty już pomniejszone o promień postaci).
 * gate — strefa dostępna tylko przy otwartych drzwiach; inside — pod dachem habitatu.
 */
export const ZONES = [
  { id: 'module', x0: -4.15, x1: 4.2, z0: -1.2, z1: 1.2, inside: true },
  { id: 'innerDoor', x0: 4.1, x1: 5.05, z0: -0.2, z1: 0.2, gate: 'inner', inside: true },
  { id: 'airlock', x0: 4.95, x1: 6.85, z0: -0.9, z1: 0.9, inside: true },
  { id: 'outerDoor', x0: 6.75, x1: 7.75, z0: -0.2, z1: 0.2, gate: 'outer', inside: true },
  { id: 'greenhouse', x0: -1.3, x1: -0.7, z0: 1.0, z1: 6.3, inside: true },
  { id: 'ramp', x0: 7.6, x1: 10.4, z0: -0.6, z1: 0.6, inside: false },
];

/** Meble w module (rzeczywisty obrys; kolizja z zapasem BODY). */
export const FURNITURE = [
  { id: 'bunkS', x0: -4.5, x1: -2.9, z0: -1.6, z1: -1.0 },
  { id: 'bunkN', x0: -4.5, x1: -2.9, z0: 1.0, z1: 1.6 },
  { id: 'life', x0: -2.6, x1: -1.7, z0: -1.6, z1: -1.05 },
  { id: 'console', x0: 0.3, x1: 2.6, z0: -1.6, z1: -1.0 },
  { id: 'galley', x0: 0.1, x1: 1.9, z0: 1.0, z1: 1.6 },
  { id: 'suits', x0: 2.5, x1: 3.9, z0: 1.05, z1: 1.6 },
];

/** Bryły habitatu z zewnątrz (plan w układzie modelu) — przez nie nie da się przejść. */
export const SOLIDS = [
  { x0: -6.8, x1: 4.5, z0: -2.3, z1: 2.3 },
  { x0: 4.5, x1: 7.3, z0: -1.4, z1: 1.4 },
  { x0: -2.9, x1: 0.9, z0: 2.2, z1: 8.5 },
  ...PANELS.map((p) => ({ x0: p.x - p.w / 2, x1: p.x + p.w / 2, z0: p.z - p.d / 2, z1: p.z + p.d / 2 })),
  { x0: MAST.x - 0.15, x1: MAST.x + 0.15, z0: MAST.z - 0.15, z1: MAST.z + 0.15 },
];

/** Obrys habitatu dla łazika: koła (x, z, promień) w układzie modelu. */
export const HABITAT_FOOTPRINT = [
  [-5.2, 0, 2.4], [-2.5, 0, 2.4], [0.2, 0, 2.4], [2.9, 0, 2.4], [5.9, 0, 1.7], [8.8, 0, 1.1],
  [-1, 3.6, 2], [-1, 6.6, 2], ...PANELS.flatMap((p) => [[p.x - 1.5, p.z, 1.5], [p.x + 1.5, p.z, 1.5]]), [MAST.x, MAST.z, 0.4],
];

/** Stanowiska do obsługi klawiszem E: położenie w planie i zasięg ręki. */
export const STATIONS = [
  { id: 'outerPanel', x: 7.35, z: -0.95, reach: 1.9, outside: true },
  { id: 'airlockPanel', x: 5.9, z: -1.25, reach: 1.4 },
  { id: 'hatchPanel', x: 4.45, z: -0.95, reach: 1.3 },
  { id: 'lights', x: 4.45, z: 0.95, reach: 1.3 },
  { id: 'suits', x: 3.2, z: 1.3, reach: 1.4 },
  { id: 'console', x: 1.45, z: -1.3, reach: 1.5 },
  { id: 'life', x: -2.15, z: -1.3, reach: 1.4 },
  { id: 'greenhouse', x: -1.0, z: 6.4, reach: 1.5 },
];

const inRect = (r, x, z, m = 0) => x >= r.x0 - m && x <= r.x1 + m && z >= r.z0 - m && z <= r.z1 + m;

/** Strefa wnętrza w punkcie planu (przy podanym stanie drzwi) albo null. */
export function zoneAt(x, z, gates = {}) {
  for (const zone of ZONES) {
    if (!inRect(zone, x, z) || (zone.gate && !gates[zone.gate])) continue;
    if (zone.id === 'module' && FURNITURE.some((f) => inRect(f, x, z, BODY))) continue;
    return zone;
  }
  return null;
}

/** Czy postać może stanąć w punkcie: we wnętrzu tylko w strefach, na zewnątrz — poza bryłami habitatu. */
export function canStand(x, z, gates = {}, radius = 0.35) {
  if (zoneAt(x, z, gates)) return true;
  return !SOLIDS.some((s) => inRect(s, x, z, radius));
}

/** Wysokość podłogi nad podstawą habitatu (null = grunt): we wnętrzu podłoga, na rampie — spadek do gruntu. */
export function floorAt(x, z, gates = {}) {
  const zone = zoneAt(x, z, gates);
  if (!zone) return null;
  if (zone.id !== 'ramp') return { h: FLOOR, k: 0 };
  return { h: FLOOR, k: Math.max(0, Math.min(1, (x - RAMP.x0) / (RAMP.x1 - RAMP.x0))) };   // k: udział gruntu
}

/**
 * Najbliższe stanowisko w zasięgu ręki, z tej samej strony ściany co postać (inside: we wnętrzu);
 * przy kilku — to przed postacią (fx, fz: kierunek patrzenia w planie).
 */
export function stationAt(x, z, fx = 0, fz = 0, inside = true) {
  let best = null, score = Infinity;
  for (const s of STATIONS) {
    if (!!s.outside === inside) continue;
    const dx = s.x - x, dz = s.z - z, d = Math.hypot(dx, dz);
    if (d > s.reach) continue;
    const facing = d > 0.01 ? (dx * fx + dz * fz) / d : 1;
    const v = d - facing * 0.6;          // stanowisko przed postacią wygrywa z tym za plecami
    if (v < score) { score = v; best = s; }
  }
  return best;
}

// ---------- śluza ----------
export const DOOR_S = 1.1, PUMP_S = 4.5;

/** Śluza z dwojgiem drzwi. Stan: out (ciśnienie Marsa, otwarte zewnętrzne) | in (ciśnienie kabiny, otwarte wewnętrzne) | cycling. */
export class Airlock {
  constructor() { this.reset(); }
  reset() { Object.assign(this, { state: 'out', pressure: 0, inner: 0, outer: 1, job: null }); }

  get busy() { return !!this.job; }
  get gates() { return { inner: this.inner > 0.95, outer: this.outer > 0.95 }; }
  get kPa() { return MARS_KPA + this.pressure * (CABIN_KPA - MARS_KPA); }
  /** Etap cyklu: close | pump | open (albo null poza cyklem). */
  get stage() {
    const j = this.job;
    if (!j) return null;
    return j.t < DOOR_S ? 'close' : j.t < DOOR_S + PUMP_S ? 'pump' : 'open';
  }
  get progress() { return this.job ? Math.min(1, this.job.t / (2 * DOOR_S + PUMP_S)) : 1; }

  /** Rozpoczyna cykl do stanu to ('in' | 'out'). Zwraca false, gdy śluza już tam jest albo pracuje. */
  cycle(to) {
    if (this.job || this.state === to || (to !== 'in' && to !== 'out')) return false;
    this.job = { to, t: 0, p0: this.pressure, inner0: this.inner, outer0: this.outer };
    this.state = 'cycling';
    return true;
  }

  step(dt) {
    const j = this.job;
    if (!j) return;
    j.t += dt;
    const k = (a, len) => Math.max(0, Math.min(1, (j.t - a) / len));
    const closing = j.to === 'in' ? 'outer' : 'inner', opening = j.to === 'in' ? 'inner' : 'outer';
    this[closing] = j[`${closing}0`] * (1 - k(0, DOOR_S));
    this.pressure = j.p0 + ((j.to === 'in' ? 1 : 0) - j.p0) * k(DOOR_S, PUMP_S);
    this[opening] = k(DOOR_S + PUMP_S, DOOR_S);
    if (j.t >= 2 * DOOR_S + PUMP_S) { this.state = j.to; this.job = null; }
  }
}

// ---------- podtrzymywanie życia (model uproszczony, do pokazania zależności) ----------
const SOLAR_M2 = PANELS.reduce((s, p) => s + p.w * p.d, 0);
const SOLAR_EFF = 0.29, TOA_WM2 = 590;               // ogniwa trójzłączowe; średnie natężenie na orbicie Marsa
const O2_PER_CREW_GH = 35;                           // ok. 0,84 kg O₂ na osobę na dobę
const MOXIE_GH = 30, PLANTS_GH = 14, LEAK_GH = 2;   // elektroliza CO₂ (MOXIE w większej skali), szklarnia ok. 12 m², nieszczelności
export const O2_TANK_KG = 60, BATTERY_KWH = 30;
export const LOADS_KW = { base: 1.1, lights: 0.2, grow: 0.9, moxie: 1.0, pump: 1.5 };

/**
 * Bilans habitatu w danej chwili.
 * @param {{sunElevDeg:number, tau:number, outsideC:number, crewInside:number, moxie:boolean, grow:boolean, lights:boolean, pumping:boolean}} s
 */
export function lifeSupport(s) {
  const sin = Math.max(0, Math.sin(s.sunElevDeg * Math.PI / 180));
  // przez warstwę pyłu: wiązka bezpośrednia słabnie wykładniczo, część rozproszonego światła dociera jako rozproszone
  const direct = sin > 0 ? Math.exp(-s.tau / Math.max(sin, 0.08)) : 0;
  const irr = sin > 0 ? TOA_WM2 * sin * (direct + 0.49 * (1 - direct)) : 0;
  const solarKw = SOLAR_M2 * irr * SOLAR_EFF / 1000;
  const heaterKw = Math.max(0, 21 - s.outsideC) * 0.015;
  const loads = {
    base: LOADS_KW.base, heater: heaterKw, lights: s.lights ? LOADS_KW.lights : 0, grow: s.grow ? LOADS_KW.grow : 0,
    moxie: s.moxie ? LOADS_KW.moxie : 0, pump: s.pumping ? LOADS_KW.pump : 0,
  };
  const loadKw = Object.values(loads).reduce((a, b) => a + b, 0);
  const o2In = (s.moxie ? MOXIE_GH : 0) + (s.grow ? PLANTS_GH : 0);
  const o2Out = s.crewInside * O2_PER_CREW_GH + LEAK_GH;
  const o2BalanceGh = o2In - o2Out;
  const co2Ppm = Math.round(450 + s.crewInside * 900 - (s.grow ? 250 : 0));
  const balanceKw = solarKw - loadKw;
  return {
    solarKw, loadKw, loads, balanceKw, o2BalanceGh, co2Ppm: Math.max(400, co2Ppm),
    o2Hours: o2BalanceGh < 0 ? O2_TANK_KG * 1000 / -o2BalanceGh : Infinity,
    batteryHours: balanceKw < 0 ? BATTERY_KWH / -balanceKw : Infinity,
    kPa: CABIN_KPA, o2Pct: CABIN_O2_PCT, tempC: 21,
  };
}

/** Plan → układ modelu habitatu (środek cx, cy; obrót modelu wokół pionu o angle). */
export function toLocal(px, py, cx, cy, angle) {
  const dx = px - cx, dy = py - cy, c = Math.cos(angle), s = Math.sin(angle);
  return { x: dx * c - dy * s, z: dx * s + dy * c };
}
/** Układ modelu habitatu → plan. */
export function toPlan(lx, lz, cx, cy, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: cx + lx * c + lz * s, y: cy - lx * s + lz * c };
}

// ---------- stan systemów w czasie misji ----------
export const SHED_PCT = 15, RESTORE_PCT = 35;   // poniżej — automatyczne wyłączenie lamp szklarni i MOXIE; powyżej — powrót

/**
 * Bateria i zbiornik O₂ habitatu całkowane z zegarem misji. Przełączniki (światło, MOXIE, lampy szklarni) zmienia
 * załoga przy stanowiskach; przy niskiej baterii habitat sam odłącza największe odbiorniki (i włącza je z powrotem).
 */
export class HabitatSystems {
  constructor() { this.reset(); }

  reset() {
    this.batteryKWh = BATTERY_KWH * 0.8;
    this.o2Kg = O2_TANK_KG * 0.9;
    this.systems = { lights: true, moxie: true, grow: true };
    this.shed = false;          // odbiorniki odłączone z braku energii
    this.pumping = false;       // pompa śluzy (ustawia widok 3D w trakcie cyklu)
    this.now = null;
  }

  get batteryPct() { return this.batteryKWh / BATTERY_KWH * 100; }
  get o2Pct() { return this.o2Kg / O2_TANK_KG * 100; }

  /** Przełącza system; przy odłączeniu z braku energii MOXIE i lampy czekają na baterię. Zwraca nowy stan. */
  toggle(id) {
    if (this.shed && (id === 'moxie' || id === 'grow') && !this.systems[id]) return false;
    this.systems[id] = !this.systems[id];
    return this.systems[id];
  }

  /** Krok o dH godzin misji w warunkach env ({sunElevDeg, tau, outsideC, crewInside}); zwraca bieżący bilans. */
  step(dH, env) {
    const s = this.systems;
    if (!this.shed && this.batteryPct < SHED_PCT) { this.shed = true; this.saved = { moxie: s.moxie, grow: s.grow }; s.moxie = s.grow = false; }
    else if (this.shed && this.batteryPct > RESTORE_PCT) { this.shed = false; Object.assign(s, this.saved); }
    const ls = lifeSupport({ ...env, ...s, pumping: this.pumping });
    if (dH > 0) {
      this.batteryKWh = Math.max(0, Math.min(BATTERY_KWH, this.batteryKWh + ls.balanceKw * dH));
      this.o2Kg = Math.max(0, Math.min(O2_TANK_KG, this.o2Kg + ls.o2BalanceGh * dH / 1000));
    }
    this.now = ls;
    return ls;
  }
}
