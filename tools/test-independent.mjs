// Niezależne testy logiki interfejsu w Node (bez przeglądarki): src/core/*, src/data/mockPlanner.js, src/i18n.js.
// Oczekiwania wynikają z geometrii, fizyki i opisu w README/docs — nie z istniejących testów.
// Uruchomienie: node --test tools/test-independent.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Polyline, cumulative, headingDeg } from '../src/core/path.js';
import { num, int, hm, clock, parseClock, km } from '../src/core/format.js';
import { Terrain, Raster } from '../src/core/terrain.js';
import { routeStats } from '../src/core/routeStats.js';
import { Sim, HABITAT_ID } from '../src/core/sim.js';
import {
  Airlock, CABIN_KPA, MARS_KPA, DOOR_S, PUMP_S, HabitatSystems, SHED_PCT, lifeSupport, toLocal, toPlan, ROOMS, zoneAt, canStand,
} from '../src/core/habitat.js';
import { Drive, chaikin, resample, smoothPath, DRIVE_SPEEDS } from '../src/core/drive.js';
import { planRoute } from '../src/data/mockPlanner.js';
import { decodePngGray } from '../src/core/png.js';

const ROOT = new URL('../', import.meta.url);
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≠ ${b} (±${eps})`);
const flatTerrain = (w = 60, h = 40, cellM = 3, f = () => 0) => {
  const heights = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) heights[j * w + i] = f((i + 0.5) * cellM, (j + 0.5) * cellM);
  return new Terrain({ heights, width: w, height: h, cellM });
};

// ------------------------------------------------------------------ path.js
test('Polyline: długość trójkąta 3-4-5 i punkty na odległości', () => {
  const p = new Polyline([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }]);
  assert.equal(p.length, 7);
  assert.deepEqual(p.at(0), { x: 0, y: 0 });
  assert.deepEqual(p.at(1.5), { x: 1.5, y: 0 });
  assert.deepEqual(p.at(5), { x: 3, y: 2 });
  assert.deepEqual(p.at(-10), { x: 0, y: 0 }, 'przed początkiem — początek');
  assert.deepEqual(p.at(99), { x: 3, y: 4 }, 'za końcem — koniec');
  assert.deepEqual([...cumulative([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 4 }])], [0, 5, 5]);
});

test('Polyline: slice zachowuje długość, project jest odwrotnością at', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const p = new Polyline(pts);
  const part = new Polyline(p.slice(4, 23));
  near(part.length, 19, 1e-9, 'długość wycinka');
  assert.deepEqual(p.slice(5, 5), []);
  for (const s of [0, 2.5, 10, 13.7, 25, 30]) near(p.project(p.at(s)), s, 1e-9, `project(at(${s}))`);
  near(p.project({ x: 5, y: -3 }), 5, 1e-9, 'rzut punktu obok linii');
  assert.deepEqual(new Polyline([]).at(3), { x: 0, y: 0 });
});

test('headingDeg: kurs od północy zgodnie z ruchem wskazówek (y rośnie na południe)', () => {
  near(headingDeg(0, -1), 0); near(headingDeg(1, 0), 90); near(headingDeg(0, 1), 180); near(headingDeg(-1, 0), 270);
  near(headingDeg(1, -1), 45);
  const p = new Polyline([{ x: 0, y: 100 }, { x: 0, y: 0 }]);
  near(p.heading(50), 0, 1e-9, 'marsz na północ');
  near(p.heading(50, -1), 180, 1e-9, 'kierunek odwrotny');
});

// ------------------------------------------------------------------ format.js (PL)
test('format: zegar, odwrotność parseClock i zawijanie doby', () => {
  assert.equal(clock(560), '09:20');
  assert.equal(clock(-1), '23:59');
  assert.equal(clock(1445), '00:05');
  assert.equal(clock(600.9), '10:00', 'minuty są obcinane');
  for (let m = 0; m < 1440; m += 7) assert.equal(parseClock(clock(m)), m);
});

test('format: liczby po polsku — przecinek dziesiętny i typograficzny minus', () => {
  assert.equal(num(1.25, 1), '1,3');
  assert.equal(num(-2.5, 2), '−2,50');
  assert.equal(int(-3.6), '−4');
  assert.equal(km(1234), '1,23 km');
  assert.equal(hm(1.5), '1:30 h');
  assert.equal(hm(0.999), '1:00 h');
  assert.equal(hm(-2), '0:00 h');
});

// ------------------------------------------------------------------ terrain.js
test('Terrain: płaski teren ma nachylenie 0, wysokość względem minimum', () => {
  const t = flatTerrain(20, 20, 3, () => 100);
  assert.equal(t.minH, 100);
  near(t.height(15, 15), 0);
  near(t.slope(30, 30), 0);
  assert.equal(t.widthM, 60);
  assert.ok(t.inside(0, 0) && t.inside(60, 60) && !t.inside(61, 5) && !t.inside(2, 2, 3));
});

test('Terrain: równia o spadku 10% ma nachylenie atan(0,1) ≈ 5,71° we wnętrzu', () => {
  const t = flatTerrain(30, 30, 2, (x) => 0.1 * x);
  for (const [x, y] of [[20, 20], [31, 11], [45, 50]]) near(t.slope(x, y), Math.atan(0.1) * 180 / Math.PI, 1e-4, `nachylenie w (${x},${y})`);
  near(t.height(21, 9) - t.height(11, 9), 1.0, 1e-4, 'interpolacja liniowa wzdłuż spadku');
});

test('Raster: próbkowanie najbliższej komórki z obcięciem do brzegów', () => {
  const r = new Raster({ data: Uint8Array.from([0, 1, 2, 3]), width: 2, height: 2, cellM: 10 });
  assert.equal(r.sample(5, 5), 0); assert.equal(r.sample(15, 5), 1); assert.equal(r.sample(5, 15), 2);
  assert.equal(r.sample(-100, 500), 2); assert.equal(r.sample(999, 999), 3);
});

// ------------------------------------------------------------------ routeStats.js
test('routeStats: płasko czas = droga / prędkość marszu + postoje', () => {
  const t = flatTerrain();
  const path = [{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 60 }];
  const r = routeStats(t, path, { walkKmh: 2.5 }, 2, 30);
  near(r.lengthM, 150, 1e-9);
  near(r.durationH, 0.15 / 2.5 + 0.5, 1e-9);
  assert.equal(r.stops, 2);
});

test('routeStats: funkcja Toblera — najszybciej przy lekkim zejściu (−5%), wolniej pod górę', () => {
  const t = flatTerrain(100, 10, 3, (x) => 0.05 * x);       // rośnie na wschód
  const east = routeStats(t, [{ x: 30, y: 15 }, { x: 230, y: 15 }], { walkKmh: 2.5 }).durationH;
  const west = routeStats(t, [{ x: 230, y: 15 }, { x: 30, y: 15 }], { walkKmh: 2.5 }).durationH;
  const flat = routeStats(flatTerrain(100, 10), [{ x: 30, y: 15 }, { x: 230, y: 15 }], { walkKmh: 2.5 }).durationH;
  assert.ok(west < flat && flat < east, `zejście ${west}, płasko ${flat}, podejście ${east}`);
});

// ------------------------------------------------------------------ sim.js (EVA bez backendu)
const demo = JSON.parse(readFileSync(new URL('data/demo/mission.json', ROOT), 'utf8'));
function simMission() {
  const m = structuredClone(demo);
  m.events = [];
  return m;
}
function straightRoute(m) {
  const path = [{ x: m.rover.x, y: m.rover.y }, ...m.waypoints.map(({ x, y }) => ({ x, y }))];
  const poly = new Polyline(path);
  return { poly, wpS: m.waypoints.map((_, i) => poly.cum[i + 1]), path };
}

test('Sim: marsz z prędkością eva.walkKmh i spadek tlenu o2RatePctH na godzinę', () => {
  const m = simMission(), sim = new Sim(m);
  sim.setRoute(straightRoute(m));
  assert.equal(sim.phase, 'idle');
  sim.running = true;
  sim.timeScale = 60;                                       // 1 s → 1 min misji
  for (let i = 0; i < 5; i++) sim.step(1);
  assert.ok(sim.crewS < sim.route.wpS[0], 'jeszcze przed pierwszym punktem');
  near(sim.crewS, m.eva.walkKmh * 1000 / 60 * 5, 1e-6, 'przebyta droga po 5 min');
  m.crew.forEach((c, i) => near(sim.crew[i].o2, 100 - c.o2RatePctH * 5 / 60, 1e-9, `${c.id} O₂`));
  assert.equal(sim.phase, 'walking');
  assert.deepEqual(sim.crew.map((c) => c.id), m.crew.map((c) => c.id));
});

test('Sim: pełne wyjście — punkty, postoje, cel, powrót do habitatu, koniec', () => {
  const m = simMission(), seen = [], hooks = { onWaypoint: (wp, last) => seen.push([wp.id, last]), onFinish: () => seen.push(['finish']) };
  const sim = new Sim(m, hooks), route = straightRoute(m);
  sim.setRoute(route);
  sim.running = true;
  const phases = [sim.phase];
  let guard = 0;
  while (sim.phase !== 'atTarget' && guard++ < 10000) { sim.step(0.05); phases.push(sim.phase); }
  assert.equal(sim.phase, 'atTarget');
  assert.deepEqual(sim.reached, m.waypoints.map((w) => w.id));
  assert.ok(phases.includes('stop'), 'postój w punkcie');
  const hab = { id: HABITAT_ID, x: m.rover.x, y: m.rover.y, stopMin: 0 };
  const back = new Polyline([...route.path, { x: hab.x, y: hab.y }]);
  sim.setRoute({ poly: back, wpS: [...route.wpS, back.length] });
  sim.beginReturn(hab);
  assert.equal(sim.phase, 'returning');
  guard = 0;
  while (!sim.finished && guard++ < 10000) sim.step(0.05);
  assert.equal(sim.phase, 'done');
  assert.equal(sim.running, false);
  assert.deepEqual(seen.at(-1), ['finish']);
  assert.deepEqual(seen.slice(0, -1).map(([id]) => id), m.waypoints.map((w) => w.id));
  assert.equal(seen.at(-2)[1], true, 'ostatni punkt oznaczony jako cel');
  const pos = sim.crewPos(0);
  near(pos.x, hab.x, 1e-6); near(pos.y, hab.y, 1e-6);
  for (const c of sim.crew) assert.ok(c.o2 > 0 && c.o2 < 100);
});

test('Sim: tlen nigdy ujemny, alarm rezerwy raz na osobę', () => {
  const m = simMission();
  m.crew.forEach((c) => { c.o2RatePctH = 400; });
  const alerts = [];
  const sim = new Sim(m, { onAlert: (a) => alerts.push(a) });
  sim.setRoute(straightRoute(m));
  sim.running = true;
  for (let i = 0; i < 400; i++) sim.step(0.5);
  for (const c of sim.crew) assert.ok(c.o2 >= 0, `${c.id}: ${c.o2}`);
  const reserve = alerts.filter((a) => /rezerwy/.test(a.text));
  assert.equal(reserve.length, m.crew.length);
  for (const c of m.crew) assert.ok(reserve.some((a) => a.text.startsWith(c.id)));
  assert.ok(alerts.every((a) => a.category === 'TLEN'));
});

test('Sim: zapas na powrót maleje w marszu, a burza SEP przyspiesza zużycie tlenu', () => {
  const m = simMission();
  const a = new Sim(m), b = new Sim(m);
  for (const s of [a, b]) { s.setRoute(straightRoute(m)); s.running = true; s.timeScale = 60; }
  b.sep = true;
  const r0 = a.reserveH();
  for (let i = 0; i < 20; i++) { a.step(1); b.step(1); }
  assert.ok(a.reserveH() < r0);
  const usedA = 100 - a.crew[0].o2, usedB = 100 - b.crew[0].o2;
  near(usedB / usedA, m.eva.sepO2Factor, 1e-9, 'mnożnik SEP');
});

test('Sim: pauza zatrzymuje zegar i zużycie; reset przywraca stan początkowy', () => {
  const m = simMission(), sim = new Sim(m);
  sim.setRoute(straightRoute(m));
  sim.running = true; sim.step(1);
  sim.running = false;
  const snap = [sim.min, sim.crewS, sim.crew[0].o2];
  sim.step(10);
  assert.deepEqual([sim.min, sim.crewS, sim.crew[0].o2], snap);
  sim.reset();
  assert.equal(sim.min, parseClock(m.mission.startClock));
  assert.equal(sim.phase, 'idle');
  assert.ok(sim.crew.every((c) => c.o2 === 100));
});

// ------------------------------------------------------------------ habitat.js
test('lifeSupport: noc bez energii słonecznej, więcej słońca i mniej pyłu → więcej mocy', () => {
  const base = { tau: 0.5, outsideC: -60, crewInside: 2, moxie: true, grow: true, lights: true, pumping: false };
  assert.equal(lifeSupport({ ...base, sunElevDeg: -10 }).solarKw, 0);
  const low = lifeSupport({ ...base, sunElevDeg: 15 }).solarKw, high = lifeSupport({ ...base, sunElevDeg: 70 }).solarKw;
  assert.ok(high > low && low > 0);
  assert.ok(lifeSupport({ ...base, sunElevDeg: 50, tau: 2 }).solarKw < lifeSupport({ ...base, sunElevDeg: 50, tau: 0.3 }).solarKw);
  const ls = lifeSupport({ ...base, sunElevDeg: 50 });
  near(ls.balanceKw, ls.solarKw - ls.loadKw, 1e-12);
  near(ls.loadKw, Object.values(ls.loads).reduce((a, b) => a + b, 0), 1e-12);
});

test('lifeSupport: więcej załogi zużywa więcej tlenu i wody; zimniej → więcej grzania', () => {
  const s = { sunElevDeg: 40, tau: 0.5, outsideC: -60, moxie: false, grow: false, lights: false, pumping: false };
  const two = lifeSupport({ ...s, crewInside: 2 }), four = lifeSupport({ ...s, crewInside: 4 });
  assert.ok(four.o2BalanceGh < two.o2BalanceGh && two.o2BalanceGh < 0);
  assert.ok(four.waterLh < two.waterLh);
  assert.ok(Number.isFinite(two.o2Hours) && two.o2Hours > 0);
  assert.ok(lifeSupport({ ...s, crewInside: 2, outsideC: -90 }).loads.heater > two.loads.heater);
  assert.ok(lifeSupport({ ...s, crewInside: 0, moxie: true }).o2Hours === Infinity, 'MOXIE bez załogi — bilans dodatni');
});

test('Airlock: pełny cykl ciśnienia 0,6 → 56,5 kPa trwa 2·drzwi + pompowanie, nie można przerwać', () => {
  const a = new Airlock();
  near(a.kPa, MARS_KPA, 1e-12, 'na zewnątrz ciśnienie Marsa');
  assert.deepEqual(a.gates, { inner: false, outer: true });
  assert.equal(a.cycle('out'), false, 'już na zewnątrz');
  assert.equal(a.cycle('in'), true);
  assert.equal(a.cycle('out'), false, 'zajęta w trakcie cyklu');
  const stages = new Set();
  let t = 0;
  while (a.busy) { a.step(0.05); t += 0.05; stages.add(a.stage); }
  near(t, 2 * DOOR_S + PUMP_S, 0.051, 'czas cyklu');
  assert.deepEqual([...stages].filter(Boolean), ['close', 'pump', 'open']);
  assert.equal(a.state, 'in');
  near(a.kPa, CABIN_KPA, 1e-9);
  assert.deepEqual(a.gates, { inner: true, outer: false });
  a.cycle('out');
  for (let i = 0; i < 200; i++) a.step(0.05);
  near(a.kPa, MARS_KPA, 1e-9);
  assert.ok(Math.abs(CABIN_KPA - 56.5) < 1e-9 && MARS_KPA > 0.4 && MARS_KPA < 1.0, 'ciśnienia zgodne z README i Marsem');
});

test('Airlock: drzwi nigdy nie są otwarte jednocześnie', () => {
  const a = new Airlock();
  a.cycle('in');
  while (a.busy) { a.step(0.02); assert.ok(!(a.inner > 0.01 && a.outer > 0.01), `oba otwarte przy ${a.job?.t}`); }
});

test('HabitatSystems: przy niskiej baterii odłącza MOXIE i lampy, przywraca po naładowaniu', () => {
  const h = new HabitatSystems();
  h.batteryKWh = 40 * (SHED_PCT - 1) / 100;
  const night = { sunElevDeg: -20, tau: 0.5, outsideC: -70, crewInside: 2 };
  h.step(0, night);
  assert.equal(h.shed, true);
  assert.equal(h.systems.moxie, false); assert.equal(h.systems.grow, false);
  assert.equal(h.toggle('moxie'), false, 'nie da się włączyć przy odłączeniu');
  h.batteryKWh = 40 * 0.9;
  h.step(0, night);
  assert.equal(h.shed, false);
  assert.equal(h.systems.moxie, true); assert.equal(h.systems.grow, true);
});

test('HabitatSystems: bateria w nocy maleje, w dzień rośnie; wartości w granicach zbiorników', () => {
  const h = new HabitatSystems();
  const b0 = h.batteryKWh;
  h.step(2, { sunElevDeg: -20, tau: 0.5, outsideC: -70, crewInside: 2 });
  assert.ok(h.batteryKWh < b0);
  const b1 = h.batteryKWh;
  h.step(2, { sunElevDeg: 60, tau: 0.3, outsideC: -10, crewInside: 2 });
  assert.ok(h.batteryKWh > b1);
  for (let i = 0; i < 500; i++) h.step(1, { sunElevDeg: -20, tau: 0.5, outsideC: -90, crewInside: 4 });
  assert.ok(h.batteryKWh >= 0 && h.o2Kg >= 0 && h.waterL >= 0);
  assert.ok(h.batteryPct >= 0 && h.batteryPct <= 100);
});

test('toLocal/toPlan są wzajemnie odwrotne dla dowolnego obrotu', () => {
  for (const angle of [0, 0.7, Math.PI / 2, 2.5, -1.1]) {
    const p = toPlan(3.2, -1.7, 500, 400, angle), back = toLocal(p.x, p.y, 500, 400, angle);
    near(back.x, 3.2, 1e-9); near(back.z, -1.7, 1e-9);
  }
});

test('habitat: każda kajuta ma drzwi do korytarza i da się w niej stanąć', () => {
  const cabins = ROOMS.filter((r) => r.id.startsWith('cabin'));
  assert.equal(cabins.length, 4, 'cztery kajuty (README)');
  for (const r of cabins) {
    assert.ok(r.door.x0 >= r.x0 && r.door.x1 <= r.x1, `${r.id}: drzwi w ścianie kajuty`);
    assert.equal(canStand((r.door.x0 + r.door.x1) / 2, 0, {}), true, `${r.id}: korytarz przed drzwiami`);
  }
  assert.equal(zoneAt(0, 0, {})?.id, 'module');
});

// ------------------------------------------------------------------ drive.js
test('chaikin i resample: końce trasy zostają, odstępy równe', () => {
  const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }];
  const c = chaikin(pts, 3);
  assert.deepEqual(c[0], pts[0]); assert.deepEqual(c.at(-1), pts.at(-1));
  assert.ok(new Polyline(c).length < 100, 'ścięte narożniki skracają drogę');
  const r = resample(pts, 5);
  const gaps = r.slice(1).map((p, i) => Math.hypot(p.x - r[i].x, p.y - r[i].y));
  for (const g of gaps) near(g, gaps[0], 1e-6);
  assert.deepEqual(smoothPath([{ x: 1, y: 2 }, { x: 3, y: 4 }]), [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
});

test('Drive: prosta po płaskim — dojazd do końca w czasie długość / prędkość nominalna', () => {
  const terrain = flatTerrain(200, 20, 3);
  const hazards = new Raster({ data: new Uint8Array(200 * 20), width: 200, height: 20, cellM: 3 });
  const d = new Drive([{ x: 10, y: 30 }, { x: 510, y: 30 }], { terrain, hazards, speedKmh: 12 });
  near(d.length, 500, 1e-6);
  near(d.heading(), 90, 1e-6, 'kurs na wschód');
  d.running = true; d.timeScale = DRIVE_SPEEDS.at(-1);
  let guard = 0;
  while (!d.done && guard++ < 1000) d.step(0.1);
  assert.equal(d.done, true);
  near(d.t, 500 / (12 / 3.6), 0.3, 'czas jazdy');
  assert.equal(d.remaining, 0);
});

test('Drive: strefa „uwaga” i podjazd spowalniają łazik', () => {
  const flat = flatTerrain(100, 10, 3), hill = flatTerrain(100, 10, 3, (x) => 0.2 * x);
  const clear = new Raster({ data: new Uint8Array(1000), width: 100, height: 10, cellM: 3 });
  const caution = new Raster({ data: new Uint8Array(1000).fill(1), width: 100, height: 10, cellM: 3 });
  const path = [{ x: 20, y: 15 }, { x: 280, y: 15 }];
  const base = new Drive(path, { terrain: flat, hazards: clear, speedKmh: 12 }).speedAt(100);
  near(base, 12 / 3.6, 1e-9);
  near(new Drive(path, { terrain: flat, hazards: caution, speedKmh: 12 }).speedAt(100), base * 0.6, 1e-9);
  assert.ok(new Drive(path, { terrain: hill, hazards: clear, speedKmh: 12 }).speedAt(100) < base);
});

// ------------------------------------------------------------------ mockPlanner.js na danych demo
const hzLayer = demo.layers.find((l) => l.id === 'hazards').raster;
const demBuf = readFileSync(new URL(`data/demo/${demo.dem.file}`, ROOT));
const demoTerrain = new Terrain({
  heights: new Float32Array(demBuf.buffer.slice(demBuf.byteOffset, demBuf.byteOffset + demBuf.byteLength)),
  width: demo.dem.width, height: demo.dem.height, cellM: demo.dem.cellM,
});
const png = await decodePngGray(readFileSync(new URL(`data/demo/${hzLayer.file}`, ROOT)));
const demoHazards = new Raster({ data: png.data, width: png.width, height: png.height, cellM: hzLayer.cellM });

function forbiddenSamples(path, terrain, hazards, eva) {
  let bad = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 4));
    for (let k = 0; k <= n; k++) {
      const x = a.x + (b.x - a.x) * k / n, y = a.y + (b.y - a.y) * k / n;
      if (hazards.sample(x, y) === 2 || terrain.slope(x, y) > eva.maxSlopeDeg) bad++;
    }
  }
  return bad;
}

test('planer zastępczy: kontrakt trasy na danych demo (start, punkty WP, bez zakazu)', () => {
  assert.equal(png.width, hzLayer.width); assert.equal(png.height, hzLayer.height);
  assert.ok(png.data.every((v) => v <= 2), 'klasy zagrożeń 0/1/2');
  const r = planRoute({ terrain: demoTerrain, hazards: demoHazards, start: demo.rover, waypoints: demo.waypoints, eva: demo.eva });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.path[0], { x: demo.rover.x, y: demo.rover.y });
  r.waypointIndex.forEach((i, k) => assert.deepEqual(r.path[i], { x: demo.waypoints[k].x, y: demo.waypoints[k].y }));
  assert.equal(forbiddenSamples(r.path, demoTerrain, demoHazards, demo.eva), 0);
  near(r.lengthM, new Polyline(r.path).length, 1e-6, 'lengthM = długość łamanej');
  assert.equal(r.stops, demo.waypoints.length);
  assert.ok(r.durationH > demo.waypoints.reduce((s, w) => s + w.stopMin, 0) / 60);
});

test('planer zastępczy: A* i Dijkstra dają trasę tego samego kosztu, A* sprawdza mniej komórek', () => {
  const req = { terrain: demoTerrain, hazards: demoHazards, start: demo.rover, waypoints: demo.waypoints, eva: demo.eva };
  const a = planRoute(req), d = planRoute({ ...req, heuristic: false });
  assert.ok(a.ok && d.ok);
  near(a.lengthM, d.lengthM, d.lengthM * 0.02, 'długość');
  near(a.durationH, d.durationH, d.durationH * 0.02, 'czas');
  assert.ok(a.visited <= d.visited, `${a.visited} > ${d.visited}`);
});

test('planer zastępczy: przeszkoda na trasie wymusza objazd z zapasem', () => {
  const req = { terrain: demoTerrain, hazards: demoHazards, start: demo.rover, waypoints: demo.waypoints, eva: demo.eva };
  const base = planRoute(req);
  const mid = new Polyline(base.path).at(base.lengthM * 0.3);
  const obstacle = { x: mid.x, y: mid.y, radiusM: 30 };
  const r = planRoute({ ...req, obstacles: [obstacle] });
  assert.equal(r.ok, true, r.error);
  const poly = new Polyline(r.path);
  let clearance = Infinity;
  for (let s = 0; s <= poly.length; s += 0.5) { const p = poly.at(s); clearance = Math.min(clearance, Math.hypot(p.x - obstacle.x, p.y - obstacle.y)); }
  assert.ok(clearance > obstacle.radiusM, `trasa ${clearance.toFixed(1)} m od środka przeszkody`);
  assert.ok(r.lengthM >= base.lengthM - 1e-6, 'objazd nie krótszy od trasy bez przeszkody');
});

test('planer zastępczy: cel w strefie zakazanej i odcięty cel dają błąd z identyfikatorem', () => {
  const W = demoHazards.width, k = png.data.findIndex((v) => v === 2);
  assert.ok(k >= 0, 'dane demo mają strefę zakazaną');
  const target = { id: 'ZAKAZ', x: (k % W + 0.5) * hzLayer.cellM, y: (Math.floor(k / W) + 0.5) * hzLayer.cellM };
  const r = planRoute({ terrain: demoTerrain, hazards: demoHazards, start: demo.rover, waypoints: [target], eva: demo.eva });
  assert.equal(r.ok, false); assert.match(r.error, /ZAKAZ/);
  const wall = { x: demo.waypoints[0].x, y: demo.waypoints[0].y, radiusM: 60 };
  const ring = Array.from({ length: 24 }, (_, i) => ({ x: wall.x + 80 * Math.cos(i * Math.PI / 12), y: wall.y + 80 * Math.sin(i * Math.PI / 12), radiusM: 12 }));
  const cut = planRoute({ terrain: demoTerrain, hazards: demoHazards, start: demo.rover, waypoints: [demo.waypoints[0]], obstacles: ring, eva: demo.eva });
  assert.equal(cut.ok, false); assert.match(cut.error, new RegExp(demo.waypoints[0].id));
});

// ------------------------------------------------------------------ i18n.js
const src = readFileSync(new URL('src/i18n.js', ROOT), 'utf8');
function blockKeys(name) {
  const start = src.indexOf(`\n  ${name}: {`), end = src.indexOf('\n  },', start);
  assert.ok(start > 0 && end > start, `blok ${name}`);
  return new Set([...src.slice(start, end).matchAll(/(?:^\s*|[{,]\s*)'([^'\s]+)':\s*['`"]/gm)].map((m) => m[1]));
}
const PL_KEYS = blockKeys('pl'), EN_KEYS = blockKeys('en');
const plMod = await import(new URL('src/i18n.js?independent-pl', ROOT).href);
globalThis.location = { search: '?lang=en', href: 'http://localhost/?lang=en' };
const enMod = await import(new URL('src/i18n.js?independent-en', ROOT).href);
delete globalThis.location;

test('i18n: wybór języka z adresu ?lang=en, domyślnie polski', () => {
  assert.equal(plMod.lang, 'pl');
  assert.equal(enMod.lang, 'en');
  assert.deepEqual(plMod.LANGS, ['pl', 'en']);
});

test('i18n: te same klucze w PL i EN (ponad 300)', () => {
  assert.ok(PL_KEYS.size > 300, `${PL_KEYS.size} kluczy`);
  assert.deepEqual([...PL_KEYS].filter((k) => !EN_KEYS.has(k)), [], 'brak EN');
  assert.deepEqual([...EN_KEYS].filter((k) => !PL_KEYS.has(k)), [], 'brak PL');
});

test('i18n: te same zmienne {…} w obu językach i brak polskich znaków w EN', () => {
  const vars = (s) => [...new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
  const mismatched = [], polish = [];
  for (const k of PL_KEYS) {
    const pl = plMod.t(k), en = enMod.t(k);
    if (vars(pl).join() !== vars(en).join()) mismatched.push(`${k}: ${vars(pl)} / ${vars(en)}`);
    if (/[ąćęłńśźżĄĆĘŁŃŚŹŻ]/.test(en)) polish.push(`${k}: ${en}`);
  }
  assert.deepEqual(mismatched, []);
  assert.deepEqual(polish, []);
});

test('i18n: zmienne w t(), nieznany klucz zwraca klucz, odmiana liczebników', () => {
  assert.equal(plMod.t('nie.ma.takiego.klucza'), 'nie.ma.takiego.klucza');
  const key = [...PL_KEYS].find((k) => /\{\w+\}/.test(plMod.t(k)));
  const name = plMod.t(key).match(/\{(\w+)\}/)[1];
  assert.ok(plMod.t(key, { [name]: 'XYZ' }).includes('XYZ'));
  assert.ok(!plMod.t(key, { [name]: 'XYZ' }).includes(`{${name}}`));
  const p = plMod.plural;
  assert.equal(p(1), plMod.t('stops.1'));
  for (const n of [2, 3, 4, 22, 34]) assert.equal(p(n), plMod.t('stops.few'), `${n}`);
  for (const n of [5, 11, 12, 14, 25, 100]) assert.equal(p(n), plMod.t('stops.many'), `${n}`);
  assert.equal(enMod.plural(1), enMod.t('stops.1'));
  assert.equal(enMod.plural(2), enMod.t('stops.many'));
});

test('i18n: tx() zostawia polski bez zmian, a w EN tłumaczy teksty backendu i liczby z kropką', () => {
  const s = 'Nowa sesja EVA nr 3';
  assert.equal(plMod.tx(s), s);
  const en = enMod.tx(s);
  assert.notEqual(en, s);
  assert.match(en, /3/);
  assert.equal(enMod.tx(''), '');
  assert.equal(enMod.tx(null), null);
  assert.equal(enMod.tx('1,5 km'), '1.5 km');
});

test('i18n: etykiety zakładek widoków istnieją w obu językach i się różnią', () => {
  for (const v of ['map', 'helmet', 'device', 'report', 'schedule']) {
    const k = `view.${v}`;
    assert.ok(PL_KEYS.has(k));
    assert.notEqual(plMod.t(k), enMod.t(k), k);
  }
});
