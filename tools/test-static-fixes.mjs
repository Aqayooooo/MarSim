// Regresje trybu statycznego (bez backendu): przeszkody przy załodze i habitacie, przeszkoda z drona przy WP,
// trasa łazikiem przy kamieniu, wynik zgłoszenia z terenu, zapas tlenu planu i stan końcowy EVA.
// Uruchomienie: node --test tools/test-static-fixes.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// pliki misji z repozytorium zamiast sieci (jak w przeglądarce w trybie plikowym)
const ROOT = fileURLToPath(new URL('../', import.meta.url));
globalThis.fetch = async (u) => {
  const p = path.join(ROOT, String(u).split('?')[0]);
  if (!existsSync(p)) return { ok: false, status: 404, url: u, json: async () => { throw new Error('404'); } };
  const b = readFileSync(p);
  return { ok: true, status: 200, url: u, json: async () => JSON.parse(b.toString('utf8')), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
};
globalThis.Image ??= class { set src(v) { this._src = v; this.naturalWidth = 1; this.naturalHeight = 1; setImmediate(() => this.onload?.()); } get src() { return this._src; } };
const store = new Map();
globalThis.localStorage ??= { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const { createDataSource } = await import('../src/data/source.js');
const { App } = await import('../src/app.js');
const { Director } = await import('../src/demo.js');
const { t } = await import('../src/i18n.js');

const AREAS = ['data/missions/mount-sharp', 'data/missions/jezero', 'data/missions/boxwork', 'data/demo'];
const FAR = [{ x: -1e4, y: -1e4, radiusM: 1 }];   // przeszkoda poza mapą: planer w przeglądarce zamiast zapisanej odpowiedzi backendu
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function load(dir) {
  const ds = createDataSource({ mode: 'files', base: dir });
  const world = await ds.loadMission();
  return { ds, world, m: world.mission };
}
async function runUntil(app, done, steps = 8000, dt = 0.05) {
  for (let i = 0; i < steps && !done(); i++) { app.update(dt); await tick(); }
}

// ------------------------------------------------------------------ P2: przeszkoda przy załodze lub habitacie
for (const dir of AREAS) {
  test(`P2 ${dir}: przeszkoda na załodze albo na habitacie nie odcina powrotu`, async () => {
    const { ds, m } = await load(dir);
    const hab = { id: 'HAB', x: m.habitat.x, y: m.habitat.y, stopMin: 0 };
    const fails = [];
    for (const crew of [m.waypoints[0], m.waypoints.at(-1)]) {
      for (const R of [25, 50]) for (const ctr of [crew, hab]) for (const d of [0, R / 2, R + 6]) for (const k of [0, 3, 6]) {
        const a = Math.PI * k / 4, o = { x: ctr.x + d * Math.cos(a), y: ctr.y + d * Math.sin(a), radiusM: R };
        const r = await ds.planRoute({ start: crew, waypoints: [hab], obstacles: [o] });
        if (!r.ok) fails.push(`${crew.id} r=${R} d=${d}: ${r.error}`);
      }
    }
    assert.deepEqual(fails, []);
  });
}

test('P2+P5: głazy zgłoszone na pozycji załogi w trakcie EVA nie więzią jej; Start EVA omija przeszkody', async () => {
  const { ds, world } = await load('data/missions/mount-sharp');
  world.mission.events = [];
  const app = new App(ds, world);
  // przeszkoda zgłoszona przed startem na łaziku: plan omija ją (P5), a start nadal działa (P2)
  app.state.obstacles.push({ id: 'o0', x: app.m.rover.x, y: app.m.rover.y, radiusM: 25 });
  const sent = [];
  const plan = ds.planRoute;
  ds.planRoute = (req) => { sent.push(req); return plan(req); };
  assert.ok(await app.planInitial({ animate: false, quiet: true }), app.lastPlanError);
  assert.equal(sent[0].obstacles, app.state.obstacles, 'planInitial przekazuje zgłoszone przeszkody');
  assert.ok(app.startEva(470));
  await runUntil(app, () => app.sim.crewS > 300);
  const p = app.sim.crewPos();
  const res = await app.reportObservation({ kind: 'glazy', x: p.x, y: p.y, radiusM: 50 });
  assert.deepEqual(res, { ok: true, replanned: true, routeBlocked: false });
  await runUntil(app, () => app.phase === 'atTarget' || !app.sim.running);
  assert.equal(app.phase, 'atTarget', JSON.stringify(app.state.alert));
  assert.ok(await app.returnToHabitat());
  await runUntil(app, () => app.sim.finished || !app.sim.running);
  assert.equal(app.phase, 'done', JSON.stringify(app.state.alert));
});

// ------------------------------------------------------------------ P4: przeszkoda z drona przy własnym WP
for (const [dir, x, y] of [['data/missions/mount-sharp', 794, 527], ['data/missions/mount-sharp', 644, 377], ['data/missions/jezero', 965, 815]]) {
  test(`P4 ${dir}: przeszkoda z drona nie blokuje bliskiego WP2 (${x}, ${y})`, async () => {
    const { ds, world } = await load(dir);
    const app = new App(ds, world);
    app.setWaypoints([{ ...app.m.waypoints[0] }, { id: '', x, y, stopMin: 10 }], { save: false });
    assert.ok(await app.planInitial({ animate: false, quiet: true }), app.lastPlanError);
    app.startEva(470);
    await runUntil(app, () => app.phase === 'atTarget' || app.routeBlocked);
    assert.equal(app.routeBlocked, false, JSON.stringify(app.state.alert));
    assert.equal(app.phase, 'atTarget');
    for (const o of app.state.obstacles) for (const w of app.m.waypoints) {
      assert.ok(Math.hypot(o.x - w.x, o.y - w.y) >= o.radiusM + 15, `${w.id} w dysku przeszkody`);
    }
  });
}

test('P4: prezentacja idzie planem misji, a własny plan wraca po resecie', async () => {
  const { ds, world } = await load('data/demo');
  const app = new App(ds, world);
  const own = [{ id: 'WP1', x: 300, y: 600, stopMin: 5 }];
  app.setWaypoints(structuredClone(own), { save: false });
  assert.equal(app.waypointsCustom, true);
  const sent = [];
  const plan = ds.planRoute;
  ds.planRoute = (req) => { sent.push(req.waypoints.map((w) => w.id + w.x)); return plan(req); };
  app.startEva = async () => null;   // krótka prezentacja: kończy się na starcie EVA
  const director = new Director(app, () => null);
  let clock = 0;
  director.clock = () => (clock += 100);
  await director.play();
  assert.deepEqual(sent[0], app.defaultWaypoints.map((w) => w.id + w.x));
  app.reset(false);
  assert.deepEqual(app.m.waypoints.map((w) => [w.x, w.y]), own.map((w) => [w.x, w.y]));
  assert.deepEqual(app.sim.waypoints.map((w) => [w.x, w.y]), own.map((w) => [w.x, w.y]));
});

// ------------------------------------------------------------------ M1: łazik, cel przy kamieniu
test('M1: cel tuż przy kamieniu (także kamyku bez kolizji) jest osiągalny łazikiem', async () => {
  const { ds, world, m } = await load('data/missions/mount-sharp');
  ds.planDijkstra({ start: m.rover, end: m.rover });          // kamienie liczone przy pierwszym użyciu
  const { makeRocks, clearings } = await import('../src/core/rocks.js');
  const rocks = makeRocks({ W: world.terrain.widthM, H: world.terrain.heightM, hazards: world.rasters.hazards, boulders: world.rasters.boulders, keepClear: clearings(m) });
  const hz = world.rasters.hazards;
  const fails = [];
  let n = 0;
  for (const rk of rocks) {
    if (n >= 30) break;
    const goal = { x: rk.x + rk.r + 1.0, y: rk.y };
    if (hz.sample(goal.x, goal.y) !== 0 || world.terrain.slope(goal.x, goal.y) > m.eva.maxSlopeDeg) continue;
    if (Math.hypot(goal.x - m.rover.x, goal.y - m.rover.y) > 300) continue;
    n++;
    const r = ds.planDijkstra({ start: m.rover, end: goal });
    if (!r.ok && /leży/.test(r.error)) fails.push(`${Math.round(goal.x)},${Math.round(goal.y)} (kamień r=${rk.r}, kolizja ${rk.collide})`);
  }
  assert.ok(n > 5, `za mało przypadków: ${n}`);
  assert.deepEqual(fails, []);
});

test('M1/F6: mount-sharp łazikiem do WP2 i z WP1 do WP2', async () => {
  const { ds, m } = await load('data/missions/mount-sharp');
  const [w1, w2] = m.waypoints;
  assert.equal(ds.planDijkstra({ start: m.rover, end: w2 }).ok, true);
  assert.equal(ds.planDijkstra({ start: w1, end: w2 }).ok, true);
});

// ------------------------------------------------------------------ zgłoszenie z terenu: wynik
test('P2: zwykły punkt trasy w zgłoszonej przeszkodzie jest odrzucany (jak w backendzie)', async () => {
  const { ds, m } = await load('data/missions/mount-sharp');
  const [w1, w2] = m.waypoints;
  const r = await ds.planRoute({ start: m.rover, waypoints: [w1, w2], obstacles: [{ x: w2.x, y: w2.y, radiusM: 25 }] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Cel WP2 leży w strefie niedostępnej');
});

test('reportObservation: nieudane przeliczenie zwraca replanned=false i routeBlocked=true', async () => {
  const { ds, world } = await load('data/missions/mount-sharp');
  world.mission.events = [];
  const app = new App(ds, world);
  await app.planInitial({ animate: false, quiet: true });
  app.startEva(470);
  await runUntil(app, () => app.sim.crewS > 100);
  assert.deepEqual(await app.reportObservation({ kind: 'bezpieczne', x: 0, y: 0, radiusM: 10 }), { ok: true, replanned: false, routeBlocked: false });
  ds.planRoute = async () => ({ ok: false, error: 'Brak bezpiecznego przejścia do WP1' });
  let replans = 0;
  app.on('replanned', () => replans++);
  const res = await app.reportObservation({ kind: 'glazy', x: 10, y: 10, radiusM: 25 });
  assert.deepEqual(res, { ok: true, replanned: false, routeBlocked: true });
  assert.equal(app.routeBlocked, true);
  assert.equal(app.sim.running, false);
  assert.equal(app.state.alert.category, t('noRoute'));
  assert.equal(replans, 0, 'bez zdarzenia „replanned” po nieudanym przeliczeniu');
});

// ------------------------------------------------------------------ P3: tlen planu i stan końcowy
for (const dir of AREAS) {
  test(`P3 ${dir}: plan domyślny mieści się w zapasie O₂, plan z długimi postojami nie`, async () => {
    const { ds, m } = await load(dir);
    const ok = await ds.planRoute({ start: m.rover, waypoints: m.waypoints, obstacles: FAR });
    assert.equal(ok.ok, true);
    assert.equal(ok.o2Budget.ok, true, JSON.stringify(ok.o2Budget));
    assert.equal(ok.rating, 'bezpieczna');
    assert.ok(ok.o2Budget.returnL > 0 && ok.o2Budget.needL > ok.o2Budget.returnL);
    assert.equal(ok.o2Budget.reservePct, m.eva.o2ReservePct);
    const long = Array.from({ length: 8 }, (_, i) => ({ ...m.waypoints[i % m.waypoints.length], id: `WP${i + 1}`, stopMin: 60 }));
    const bad = await ds.planRoute({ start: m.rover, waypoints: long, obstacles: FAR });
    assert.equal(bad.ok, true);
    const b = bad.o2Budget;
    assert.equal(b.ok, false);
    assert.equal(bad.rating, 'niebezpieczna');
    assert.equal(bad.ratingReason, b.reason);
    assert.equal(b.usableL, Math.round(5200 * (1 - m.eva.o2ReservePct / 100)) / 10);
    assert.equal(b.reason, `za mało tlenu: plan z powrotem do habitatu wymaga ${Math.round(b.needL)} L O₂, a zapas ponad rezerwę ${m.eva.o2ReservePct}% to ${Math.round(b.usableL)} L`);
  });
}

test('P3: Start EVA odrzuca plan, który przekracza zapas O₂', async () => {
  const { ds, world } = await load('data/missions/mount-sharp');
  const app = new App(ds, world);
  const [w1, w2] = app.m.waypoints;
  app.setWaypoints(Array.from({ length: 8 }, (_, i) => ({ ...(i % 2 ? w2 : w1), stopMin: 60 })), { save: false });
  const route = await app.planInitial({ animate: false, quiet: true });
  assert.equal(route?.o2Budget?.ok, false);
  assert.equal(app.startEva(470), null);
  assert.equal(app.sim.running, false);
  assert.equal(app.state.alert.text, `Start EVA odrzucony — ${route.o2Budget.reason}. Skróć trasę.`);
});

test('P3: rezerwa O₂ uruchamia powrót, 0% przerywa EVA bez wznowienia', async () => {
  const { ds, world } = await load('data/missions/mount-sharp');
  world.mission.events = [];
  const app = new App(ds, world);
  await app.planInitial({ animate: false, quiet: true });
  app.startEva(470);
  await runUntil(app, () => app.sim.crewS > 100);
  for (const c of app.sim.crew) c.o2 = app.m.eva.o2ReservePct + 0.01;
  await runUntil(app, () => app.phase === 'returning', 200);
  assert.equal(app.phase, 'returning');
  assert.equal(app.state.alert.text, 'Tlen poniżej rezerwy — automatyczny powrót do habitatu');
  app.sim.crew[1].o2 = 0.01;
  await runUntil(app, () => app.sim.aborted, 200);
  assert.equal(app.sim.aborted, true);
  assert.equal(app.sim.running, false);
  assert.notEqual(app.phase, 'done');
  assert.equal(app.state.alert.text, 'EVA przerwana: brak tlenu (EV2) — potrzebna akcja ratunkowa');
  assert.equal(app.pauseEva(false), null);
  assert.equal(app.sim.running, false, 'po braku tlenu wyjścia nie da się wznowić');
  assert.equal(app.state.alert.text, 'EVA przerwana: brak tlenu. Zresetuj symulację.');
  const min = app.sim.min;
  app.update(1);
  assert.equal(app.sim.min, min);
});

// ------------------------------------------------------------------ 409 / spóźniona odpowiedź planera
test('nieudany plan usuwa starą trasę; spóźniona odpowiedź starszego zapytania jej nie przywraca', async () => {
  const { ds, world } = await load('data/missions/mount-sharp');
  const app = new App(ds, world);
  await app.planInitial({ animate: false, quiet: true });
  assert.ok(app.state.route);
  let release;
  const slow = new Promise((r) => { release = r; });
  const plan = ds.planRoute;
  ds.planRoute = async (req) => { await slow; return plan(req); };
  const first = app.planInitial({ animate: false, quiet: true });
  ds.planRoute = async () => { throw new Error('Brak bezpiecznego przejścia do WP3'); };   // np. HTTP 409 z /api/plan
  assert.equal(await app.planInitial({ animate: false, quiet: true }), null);
  assert.equal(app.state.route, null);
  release();
  assert.equal(await first, null);
  assert.equal(app.state.route, null, 'starsza odpowiedź nie przywraca trasy');
  assert.equal(app.lastPlanError, 'Brak bezpiecznego przejścia do WP3');
});
