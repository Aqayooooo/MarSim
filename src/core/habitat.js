// Habitat od środka: plan bazy, strefy do chodzenia, kolizje, śluza z cyklem ciśnienia i uproszczony model
// podtrzymywania życia (moc, tlen, woda). Bez three.js i bez DOM — te same reguły w widoku 3D i w testach (node --test).
//
// Układ modelu (metry): x wzdłuż modułu dziennego (+x = śluza), z w poprzek, y w górę od podstawy. Podłoga wszędzie 1 m.
//   śluza (+x) — moduł dzienny (walec) — hala: węzeł z mesą | korytarz sypialni z kajutami, łazienką i siłownią (−x)
//   z węzła: laboratorium z punktem medycznym (−z) i szklarnia (walec, +z).

export const FLOOR = 1.0;           // podłoga nad podstawą habitatu
export const CEIL = 3.5;            // sufit modułów prostopadłościennych
export const BODY = 0.3;            // promień postaci przy kolizjach z meblami
export const DOOR = { half: 0.45, top: FLOOR + 2.0 };          // drzwi śluzy i włazy: 0,9 × 2 m
export const HULL = { r: 2.3, cy: 2.5, x0: -4.5, x1: 4.5, lining: 2.15 };   // moduł dzienny
export const AIRLOCK = { x0: 4.5, x1: 7.3, y0: 0.5, y1: 3.7, z: 1.4, in: { x0: 4.65, x1: 7.15, top: 3.5, z: 1.25 } };   // drzwi przesuwne w szczelinach między ścianami
/** Hala: węzeł (x > PARTITION) i część sypialna. Ściany do WALL_TOP, łukowy dach o strzałce ROOF_SAG. */
export const HALL = { x0: -20, x1: -4.5, z: 3.0, wallTop: 3.9, roofSag: 1.1, skirt: -1.5, inset: 0.15, partition: -10 };
export const LAB = { x0: -9.5, x1: -5.0, z0: -9.0, z1: -3.0 };
export const GREEN = { x: -7.25, r: 1.8, cy: 2.05, z0: 3.0, z1: 10.0, lining: 1.65 };
export const RAMP = { x0: 7.3, x1: 10.2, half: 0.7 };
export const MAST = { x: 3.2, z: -3.4 };
export const WINDOWS = [{ x0: 2.7, x1: 4.2, side: -1 }, { x0: -3.6, x1: -2.1, side: 1 }];   // okna w module dziennym (wysokość 1,8–2,9 m)
export const PANELS = [-3.4, 3.4, 10.2].map((x) => ({ x, z: -12.5, w: 6.4, d: 2.6 }));   // ok. 50 m² ogniw
export const MARS_KPA = 0.6;
export const CABIN_KPA = 56.5;      // atmosfera eksploracyjna NASA: 8,2 psi, 34% O₂ — krótsze odsycanie azotu przed EVA
export const CABIN_O2_PCT = 34;

/** Przejścia między modułami (otwór w obu ścianach; oś: 'x' — ściana prostopadła do x). */
export const OPENINGS = {
  common: { axis: 'x', at: HALL.x1, c: 0, half: 0.5 },                        // moduł dzienny ↔ węzeł
  sleep: { axis: 'x', at: HALL.partition, c: 0, half: 0.5 },                  // węzeł ↔ korytarz sypialni
  lab: { axis: 'z', at: -(HALL.z - HALL.inset), c: GREEN.x, half: 0.6 },      // węzeł ↔ laboratorium
  green: { axis: 'z', at: HALL.z - HALL.inset, c: GREEN.x, half: 0.5 },       // węzeł ↔ szklarnia
};

/** Pomieszczenia przy korytarzu sypialni: strona z (+1/−1), zakres x, drzwi z korytarza przy końcu x1. */
const CORRIDOR = 1.0, IN_Z = HALL.z - HALL.inset;
export const ROOMS = [
  { id: 'cabin1', side: 1, x0: -12.6, x1: HALL.partition },
  { id: 'cabin2', side: 1, x0: -15.2, x1: -12.6 },
  { id: 'cabin3', side: -1, x0: -12.6, x1: HALL.partition },
  { id: 'cabin4', side: -1, x0: -15.2, x1: -12.6 },
  { id: 'gym', side: 1, x0: HALL.x0 + HALL.inset, x1: -15.2 },
  { id: 'bath', side: -1, x0: HALL.x0 + HALL.inset, x1: -15.2 },
].map((r) => ({ ...r, door: { x0: r.x1 - 1.0, x1: r.x1 - 0.2 }, z0: r.side > 0 ? CORRIDOR : -IN_Z, z1: r.side > 0 ? IN_Z : -CORRIDOR }));
export { CORRIDOR };

const S = (s, a, b) => (s > 0 ? [a, b] : [-b, -a]);   // zakres z po stronie s
/**
 * Strefy, po których można chodzić (prostokąty już pomniejszone o promień postaci).
 * gate — strefa dostępna tylko przy otwartych drzwiach śluzy; inside — pod dachem habitatu.
 */
export const ZONES = [
  { id: 'module', x0: -4.2, x1: 4.2, z0: -1.2, z1: 1.2, inside: true },
  { id: 'innerDoor', x0: 4.1, x1: 5.05, z0: -0.2, z1: 0.2, gate: 'inner', inside: true },
  { id: 'airlock', x0: 4.95, x1: 6.85, z0: -0.9, z1: 0.9, inside: true },
  { id: 'outerDoor', x0: 6.75, x1: 7.75, z0: -0.2, z1: 0.2, gate: 'outer', inside: true },
  { id: 'ramp', x0: 7.6, x1: 10.4, z0: -0.6, z1: 0.6, inside: false },
  { id: 'pass', x0: -4.95, x1: -4.05, z0: -0.2, z1: 0.2, inside: true },
  { id: 'hub', x0: HALL.partition + 0.3, x1: HALL.x1 - HALL.inset - 0.3, z0: -IN_Z + 0.3, z1: IN_Z - 0.3, inside: true },
  { id: 'pass', x0: HALL.partition - 0.35, x1: HALL.partition + 0.35, z0: -0.2, z1: 0.2, inside: true },
  { id: 'corridor', x0: HALL.x0 + HALL.inset + 0.3, x1: HALL.partition - 0.3, z0: -CORRIDOR + 0.3, z1: CORRIDOR - 0.3, inside: true },
  ...ROOMS.flatMap((r) => {
    const [z0, z1] = S(r.side, CORRIDOR + 0.3, IN_Z - 0.3), [dz0, dz1] = S(r.side, CORRIDOR - 0.4, CORRIDOR + 0.4), dc = (r.door.x0 + r.door.x1) / 2;
    return [
      { id: r.id, x0: r.x0 + 0.3, x1: r.x1 - 0.3, z0, z1, inside: true },
      { id: 'pass', x0: dc - 0.1, x1: dc + 0.1, z0: dz0, z1: dz1, inside: true },
    ];
  }),
  { id: 'pass', x0: GREEN.x - 0.3, x1: GREEN.x + 0.3, z0: -IN_Z - 0.45, z1: -IN_Z + 0.45, inside: true },
  { id: 'lab', x0: LAB.x0 + HALL.inset + 0.3, x1: LAB.x1 - HALL.inset - 0.3, z0: LAB.z0 + HALL.inset + 0.3, z1: LAB.z1 - 0.25, inside: true },
  { id: 'pass', x0: GREEN.x - 0.2, x1: GREEN.x + 0.2, z0: IN_Z - 0.45, z1: GREEN.z0 + 0.4, inside: true },
  { id: 'greenhouse', x0: GREEN.x - 0.42, x1: GREEN.x + 0.42, z0: GREEN.z0 + 0.3, z1: GREEN.z1 - 0.3, inside: true },
];

/** Meble (rzeczywisty obrys; kolizja z zapasem BODY w każdej strefie wnętrza). */
export const FURNITURE = [
  // moduł dzienny
  { id: 'life', x0: -1.6, x1: -0.7, z0: -1.6, z1: -1.05 },
  { id: 'console', x0: 0.3, x1: 2.6, z0: -1.6, z1: -1.0 },
  { id: 'galley', x0: -0.6, x1: 1.9, z0: 1.0, z1: 1.6 },
  { id: 'suits', x0: 2.5, x1: 3.9, z0: 1.05, z1: 1.6 },
  { id: 'sofa', x0: -4.3, x1: -2.0, z0: 1.0, z1: 1.6 },
  { id: 'medkit', x0: -4.3, x1: -3.3, z0: -1.6, z1: -1.1 },
  // węzeł z mesą
  { id: 'table', x0: -6.6, x1: -5.2, z0: 1.3, z1: 2.3 },
  { id: 'stores', x0: -6.3, x1: -4.65, z0: -2.85, z1: -2.25 },
  { id: 'lockers', x0: -9.85, x1: -8.4, z0: 2.25, z1: 2.85 },
  { id: 'rack', x0: -9.85, x1: -8.5, z0: -2.85, z1: -2.3 },
  // kajuty: łóżko przy ścianie zewnętrznej, biurko przy drzwiach
  ...ROOMS.filter((r) => r.id.startsWith('cabin')).flatMap((r) => [
    { id: `${r.id}Bed`, x0: r.x0 + 0.1, x1: r.x0 + 2.1, ...zr(r.side, IN_Z - 0.9, IN_Z) },
    { id: `${r.id}Desk`, x0: r.x1 - 0.45, x1: r.x1 - 0.05, ...zr(r.side, IN_Z - 0.6, IN_Z) },
  ]),
  // siłownia i łazienka
  { id: 'treadmill', x0: -19.4, x1: -17.4, ...zr(1, 2.05, 2.75) },
  { id: 'bike', x0: -16.6, x1: -15.8, ...zr(1, 2.0, 2.7) },
  { id: 'toilet', x0: -19.85, x1: -19.25, ...zr(-1, 2.25, IN_Z) },
  { id: 'sink', x0: -18.6, x1: -17.9, ...zr(-1, 2.45, IN_Z) },
  { id: 'wrs', x0: -17.6, x1: -16.8, ...zr(-1, 2.4, IN_Z) },
  { id: 'shower', x0: -16.45, x1: -15.35, ...zr(-1, 1.9, IN_Z) },
  // laboratorium
  { id: 'benchW', x0: LAB.x0 + 0.15, x1: LAB.x0 + 0.8, z0: -8.2, z1: -3.4 },
  { id: 'benchE', x0: LAB.x1 - 0.8, x1: LAB.x1 - 0.15, z0: -8.2, z1: -3.4 },
  { id: 'medbed', x0: -8.2, x1: -6.3, z0: LAB.z0 + 0.15, z1: LAB.z0 + 1.05 },
];
function zr(side, a, b) { const [z0, z1] = S(side, a, b); return { z0, z1 }; }

/** Bryły bazy z zewnątrz (plan w układzie modelu) — przez nie nie da się przejść. */
export const SOLIDS = [
  { x0: HULL.x0, x1: HULL.x1, z0: -HULL.r, z1: HULL.r },
  { x0: AIRLOCK.x0, x1: AIRLOCK.x1, z0: -AIRLOCK.z, z1: AIRLOCK.z },
  { x0: HALL.x0, x1: HALL.x1, z0: -HALL.z, z1: HALL.z },
  { x0: LAB.x0, x1: LAB.x1, z0: LAB.z0, z1: LAB.z1 },
  { x0: GREEN.x - GREEN.r, x1: GREEN.x + GREEN.r, z0: HALL.z, z1: GREEN.z1 + GREEN.r },
  ...PANELS.map((p) => ({ x0: p.x - p.w / 2, x1: p.x + p.w / 2, z0: p.z - p.d / 2, z1: p.z + p.d / 2 })),
  { x0: MAST.x - 0.15, x1: MAST.x + 0.15, z0: MAST.z - 0.15, z1: MAST.z + 0.15 },
];

/** Obrys bazy dla łazika: koła (x, z, promień) pokrywające bryły (w układzie modelu). */
export const HABITAT_FOOTPRINT = [...SOLIDS, { x0: RAMP.x0, x1: RAMP.x1, z0: -RAMP.half, z1: RAMP.half }].flatMap((s) => {
  const w = s.x1 - s.x0, d = s.z1 - s.z0, along = w >= d, len = along ? w : d, r = Math.max(0.4, (along ? d : w) / 2 * 1.2);
  const n = Math.max(1, Math.ceil(len / r));
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 0.5) / n;
    return along ? [s.x0 + w * t, (s.z0 + s.z1) / 2, r] : [(s.x0 + s.x1) / 2, s.z0 + d * t, r];
  });
});

/** Stanowiska do obsługi klawiszem E: położenie w planie i zasięg ręki. */
export const STATIONS = [
  { id: 'outerPanel', x: 7.35, z: -0.95, reach: 1.9, from: [null, 'ramp'] },
  { id: 'airlockPanel', x: 5.9, z: -1.25, reach: 1.4, from: ['airlock', 'innerDoor', 'outerDoor'] },
  { id: 'hatchPanel', x: 4.45, z: -0.95, reach: 1.3, from: ['module', 'innerDoor'] },
  { id: 'lights', x: 4.45, z: 0.95, reach: 1.3, from: ['module'] },
  { id: 'suits', x: 3.2, z: 1.3, reach: 1.4, from: ['module'] },
  { id: 'console', x: 1.45, z: -1.3, reach: 1.5, from: ['module'] },
  { id: 'life', x: -1.15, z: -1.3, reach: 1.4, from: ['module'] },
  { id: 'map', x: HALL.x1 - HALL.inset, z: -1.4, reach: 1.4, from: ['hub'] },
  ...ROOMS.filter((r) => r.id.startsWith('cabin')).map((r) => ({ id: r.id, x: r.x1 - 0.25, z: r.side * (IN_Z - 0.45), reach: 1.3, from: [r.id] })),
  { id: 'gym', x: -18.4, z: 2.1, reach: 1.4, from: ['gym'] },
  { id: 'water', x: -17.2, z: -2.45, reach: 1.3, from: ['bath'] },
  { id: 'lab', x: LAB.x1 - 0.5, z: -5.8, reach: 1.4, from: ['lab'] },
  { id: 'med', x: GREEN.x, z: LAB.z0 + 1.05, reach: 1.4, from: ['lab'] },
  { id: 'greenhouse', x: GREEN.x, z: GREEN.z1 - 0.1, reach: 1.5, from: ['greenhouse'] },
];

const inRect = (r, x, z, m = 0) => x >= r.x0 - m && x <= r.x1 + m && z >= r.z0 - m && z <= r.z1 + m;

/** Strefa wnętrza w punkcie planu (przy podanym stanie drzwi) albo null. */
export function zoneAt(x, z, gates = {}) {
  for (const zone of ZONES) {
    if (!inRect(zone, x, z) || (zone.gate && !gates[zone.gate])) continue;
    if (zone.inside && FURNITURE.some((f) => inRect(f, x, z, BODY))) continue;
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
 * Najbliższe stanowisko w zasięgu ręki, dostępne z pomieszczenia postaci (zone: id strefy, null = na zewnątrz);
 * przy kilku — to przed postacią (fx, fz: kierunek patrzenia w planie).
 */
export function stationAt(x, z, fx = 0, fz = 0, zone = null) {
  let best = null, score = Infinity;
  for (const s of STATIONS) {
    if (!s.from.includes(zone)) continue;
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
const MOXIE_GH = 30, PLANTS_GH = 18, LEAK_GH = 3;   // elektroliza CO₂ (MOXIE w większej skali), szklarnia ok. 16 m², nieszczelności
const WATER_PER_CREW_LH = 0.5, WRS_RECOVERY = 0.93;  // ok. 12 l na osobę na dobę; odzysk wody jak w systemie ISS
export const O2_TANK_KG = 60, BATTERY_KWH = 40, WATER_TANK_L = 400;
export const LOADS_KW = { base: 1.4, lights: 0.3, grow: 1.1, moxie: 1.0, pump: 1.5, wrs: 0.4, treadmill: 0.3 };

/**
 * Bilans habitatu w danej chwili.
 * @param {{sunElevDeg:number, tau:number, outsideC:number, crewInside:number, moxie:boolean, grow:boolean, lights:boolean,
 *   wrs?:boolean, treadmill?:boolean, pumping:boolean}} s
 */
export function lifeSupport(s) {
  const sin = Math.max(0, Math.sin(s.sunElevDeg * Math.PI / 180));
  // przez warstwę pyłu: wiązka bezpośrednia słabnie wykładniczo, część rozproszonego światła dociera jako rozproszone
  const direct = sin > 0 ? Math.exp(-s.tau / Math.max(sin, 0.08)) : 0;
  const irr = sin > 0 ? TOA_WM2 * sin * (direct + 0.49 * (1 - direct)) : 0;
  const solarKw = SOLAR_M2 * irr * SOLAR_EFF / 1000;
  const heaterKw = Math.max(0, 21 - s.outsideC) * 0.022;   // większa baza — więcej ścian do ogrzania
  const loads = {
    base: LOADS_KW.base, heater: heaterKw, lights: s.lights ? LOADS_KW.lights : 0, grow: s.grow ? LOADS_KW.grow : 0,
    moxie: s.moxie ? LOADS_KW.moxie : 0, pump: s.pumping ? LOADS_KW.pump : 0,
    wrs: s.wrs ? LOADS_KW.wrs : 0, treadmill: s.treadmill ? LOADS_KW.treadmill : 0,
  };
  const loadKw = Object.values(loads).reduce((a, b) => a + b, 0);
  const o2In = (s.moxie ? MOXIE_GH : 0) + (s.grow ? PLANTS_GH : 0);
  const o2Out = s.crewInside * O2_PER_CREW_GH * (s.treadmill ? 1.3 : 1) + LEAK_GH;
  const waterLh = -s.crewInside * WATER_PER_CREW_LH * (s.wrs ? 1 - WRS_RECOVERY : 1);
  const o2BalanceGh = o2In - o2Out;
  const co2Ppm = Math.round(450 + s.crewInside * 900 - (s.grow ? 250 : 0));
  const balanceKw = solarKw - loadKw;
  return {
    solarKw, loadKw, loads, balanceKw, o2BalanceGh, waterLh, co2Ppm: Math.max(400, co2Ppm),
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
    this.waterL = WATER_TANK_L * 0.85;
    this.systems = { lights: true, moxie: true, grow: true, wrs: true, treadmill: false };
    this.shed = false;          // odbiorniki odłączone z braku energii
    this.pumping = false;       // pompa śluzy (ustawia widok 3D w trakcie cyklu)
    this.now = null;
  }

  get batteryPct() { return this.batteryKWh / BATTERY_KWH * 100; }
  get o2Pct() { return this.o2Kg / O2_TANK_KG * 100; }
  get waterPct() { return this.waterL / WATER_TANK_L * 100; }

  /** Przełącza system; przy odłączeniu z braku energii MOXIE i lampy czekają na baterię. Zwraca nowy stan. */
  toggle(id) {
    if (this.shed && ['moxie', 'grow', 'treadmill'].includes(id) && !this.systems[id]) return false;
    this.systems[id] = !this.systems[id];
    return this.systems[id];
  }

  /** Krok o dH godzin misji w warunkach env ({sunElevDeg, tau, outsideC, crewInside}); zwraca bieżący bilans. */
  step(dH, env) {
    const s = this.systems;
    if (!this.shed && this.batteryPct < SHED_PCT) { this.shed = true; this.saved = { moxie: s.moxie, grow: s.grow }; s.moxie = s.grow = s.treadmill = false; }
    else if (this.shed && this.batteryPct > RESTORE_PCT) { this.shed = false; Object.assign(s, this.saved); }
    const ls = lifeSupport({ ...env, ...s, pumping: this.pumping });
    if (dH > 0) {
      this.batteryKWh = Math.max(0, Math.min(BATTERY_KWH, this.batteryKWh + ls.balanceKw * dH));
      this.o2Kg = Math.max(0, Math.min(O2_TANK_KG, this.o2Kg + ls.o2BalanceGh * dH / 1000));
      this.waterL = Math.max(0, Math.min(WATER_TANK_L, this.waterL + ls.waterLh * dH));
    }
    this.now = ls;
    return ls;
  }
}
