// Regresje sterowania EVA: tryb lokalny, błędy API i wyścigi odczytów trasy.
// Uruchomienie: node --test tools/test-eva.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { App } from '../src/app.js';
import { Director } from '../src/demo.js';
import { EvaControls } from '../src/ui/evaControls.js';
import { Terrain, Raster } from '../src/core/terrain.js';
import { decodePngGray } from '../src/core/png.js';
import { planRoute } from '../src/data/mockPlanner.js';

const template = JSON.parse(await readFile(new URL('../data/demo/mission.json', import.meta.url), 'utf8'));
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function route(start, waypoints, version = 1) {
  const path = [start, ...waypoints.map(({ x, y }) => ({ x, y }))];
  return { ok: true, path, waypointIndex: waypoints.map((_, i) => i + 1), waypointIds: waypoints.map((w) => w.id),
    lengthM: 300, durationH: 0.5, stops: waypoints.length, version, letter: 'A' };
}

function fixture(remote = false) {
  const mission = structuredClone(template);
  mission.events = [];
  const ds = { mode: remote ? 'http' : 'files',
    planRoute: async ({ start, waypoints }) => route(start, waypoints),
    post: async () => ({ ok: true }),
    get: async () => ({ route: null }),
    stream: (receive) => { ds.receive = receive; },
  };
  const app = new App(ds, { mission, terrain: { height: () => 0 }, rasters: {} });
  return { app, ds };
}

function snapshot(app, version) {
  return { missionId: app.m.mission.id, session: 1, t: 60, clockMin: 600, running: false, phase: 'walking', timeScale: 470,
    crewS: 10, gap: 14, nextWp: 0, reached: [], sep: false, rover: { s: 0, x: 0, y: 0 },
    crew: app.m.crew.map((c) => ({ ...c, o2Pct: 99 })), alerts: [], obstacles: [], routeVersion: version };
}

test('powrót od startu zachowuje początek trasy i poprawne indeksy', async () => {
  const { app } = fixture();
  app.m.habitat = { x: app.m.rover.x - 20, y: app.m.rover.y };
  await app.planInitial({ animate: false });
  app.startEva();
  await app.returnToHabitat();
  assert.deepEqual(app.state.route.poly.at(0), { x: app.m.rover.x, y: app.m.rover.y });
  assert.ok(app.state.route.poly.length > 0);
  assert.ok(app.state.route.wpS.every(Number.isFinite));
  assert.deepEqual(app.state.route.wpIds, ['HAB']);
});

test('zgłoszenie podczas pauzy blokuje wznowienie niedostępnej trasy', async () => {
  const { app, ds } = fixture();
  await app.planInitial({ animate: false });
  app.startEva();
  app.update(0.1);
  app.pauseEva(true);
  ds.planRoute = async () => ({ ok: false, error: 'Brak przejścia' });
  await app.reportObservation({ kind: 'glazy', x: 100, y: 100, radiusM: 30 });
  app.pauseEva(false);
  assert.equal(app.routeBlocked, true);
  assert.equal(app.sim.running, false);
  assert.equal(app.state.alert.text, 'Brak przejścia');
});

test('przeliczenie trasy w pauzie zachowuje pozycję i nie wznawia marszu', async () => {
  const { app } = fixture();
  await app.planInitial({ animate: false });
  app.startEva();
  app.update(0.1);
  app.pauseEva(true);
  const position = app.sim.crewPos();
  await app.reportObservation({ kind: 'glazy', x: 100, y: 100, radiusM: 5 });
  assert.deepEqual(app.sim.crewPos(), position);
  assert.equal(app.sim.running, false);
  assert.equal(app.state.route.letter, 'B');
});

test('lokalna EVA kończy się po powrocie, a pauza zatrzymuje czas i tlen', async () => {
  const { app } = fixture();
  await app.planInitial({ animate: false });
  app.startEva();
  app.update(0.1);
  app.pauseEva(true);
  const time = app.sim.min, oxygen = app.sim.crew[0].o2;
  app.update(1);
  assert.equal(app.sim.min, time);
  assert.equal(app.sim.crew[0].o2, oxygen);
  await app.returnToHabitat();
  app.pauseEva(false);
  for (let i = 0; i < 500 && !app.sim.finished; i++) app.update(0.1);
  assert.equal(app.phase, 'done');
  assert.equal(app.sim.running, false);
  assert.deepEqual(app.sim.crewPos(), { x: app.m.habitat.x, y: app.m.habitat.y });
  assert.ok(app.sim.crew[0].o2 < oxygen);
});

for (const action of ['start', 'pause', 'resume', 'tempo']) {
  test(`błąd API przy poleceniu ${action} daje komunikat i zachowuje stan`, async () => {
    const { app, ds } = fixture(true);
    await app.planInitial({ animate: false });
    ds.post = async () => { throw new Error('Utrata połączenia'); };
    const result = await ({ start: () => app.startEva(), pause: () => app.pauseEva(true),
      resume: () => app.pauseEva(false), tempo: () => app.setTimeScale(150) })[action]();
    assert.equal(result, null);
    assert.equal(app.state.alert.text, 'Utrata połączenia');
    assert.equal(app.sim.running, false);
  });
}

test('nieudany reset nie uruchamia planowania nowego wyjścia', async () => {
  const { app, ds } = fixture(true);
  let planned = 0;
  ds.post = async () => { throw new Error('Reset nie dotarł'); };
  ds.planRoute = async () => { planned++; };
  app.reset();
  assert.equal(await app.planInitial(), null);
  assert.equal(planned, 0);
  assert.equal(app.resetting, false);
  assert.equal(app.state.alert.text, 'Reset nie dotarł');
});

test('odrzucony reset zachowuje bieżącą trasę i pozwala ponowić reset', async () => {
  const { app, ds } = fixture(true);
  await app.planInitial({ animate: false });
  const current = app.state.route;
  ds.post = async () => { throw new Error('Reset nie dotarł'); };
  await app.reset();
  assert.equal(app.state.route, current);
  ds.post = async () => ({ ok: true });
  await app.reset();
  assert.equal(app.state.route, null);
});

test('nowa sesja w innej karcie usuwa stare przeszkody i ponownie pobiera trasę', async () => {
  const { app, ds } = fixture(true);
  ds.get = async () => ({ route: route(app.m.rover, app.m.waypoints) });
  ds.receive(snapshot(app, 1));
  await tick();
  app.state.obstacles.push({ x: 20, y: 20 });
  app.state.alert = { text: 'Stary alarm' };
  let reads = 0;
  ds.get = async () => { reads++; return { route: route(app.m.rover, app.m.waypoints) }; };
  ds.receive({ ...snapshot(app, 1), session: 2 });
  await tick();
  assert.equal(reads, 1);
  assert.equal(app.state.obstacles.length, 0);
  assert.equal(app.state.alert, null);
});

test('spóźniony odczyt nie nadpisuje nowszej trasy', async () => {
  const { app, ds } = fixture(true);
  const old = deferred(), latest = deferred();
  ds.get = () => old.promise;
  ds.receive(snapshot(app, 1));
  ds.get = () => latest.promise;
  ds.receive(snapshot(app, 2));
  const start = { x: app.m.rover.x, y: app.m.rover.y };
  latest.resolve({ route: route(start, app.m.waypoints, 2) });
  await tick();
  old.resolve({ route: route(start, app.m.waypoints, 1) });
  await tick();
  assert.equal(app.state.route.version, 2);
});

test('reset odrzuca wcześniejszy odczyt trasy', async () => {
  const { app, ds } = fixture(true), response = deferred();
  ds.get = () => response.promise;
  ds.receive(snapshot(app, 1));
  app.reset();
  response.resolve({ route: route(app.m.rover, app.m.waypoints) });
  await tick();
  assert.equal(app.state.route, null);
});

test('błąd pobrania trasy pozwala ponowić odczyt', async () => {
  const { app, ds } = fixture(true);
  ds.get = async () => { throw new Error('Brak łączności'); };
  ds.receive(snapshot(app, 1));
  await tick();
  ds.get = async () => ({ route: route(app.m.rover, app.m.waypoints) });
  ds.receive(snapshot(app, 1));
  await tick();
  assert.equal(app.state.route.version, 1);
});

test('prezentacja kończy się z komunikatem po odrzuconym starcie EVA', async () => {
  const { app } = fixture();
  app.m.layers = [];
  app.startEva = async () => null;
  const director = new Director(app, () => null);
  const saved = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => setImmediate(() => { app.now += 100; fn(); });
  try {
    const result = await Promise.race([director.play().then(() => 'done'), new Promise((r) => {
      const timer = setTimeout(() => r('timeout'), 500); timer.unref();
    })]);
    assert.equal(result, 'done');
    assert.equal(director.playing, false);
    assert.ok(app.state.alert);
    assert.equal(app.autoEvents, true);
  } finally { director.stop(); globalThis.requestAnimationFrame = saved; }
});

test('kolejne kliknięcie pauzy nie wysyła drugiego polecenia', async () => {
  const { app } = fixture();
  await app.planInitial({ animate: false });
  app.startEva();
  const response = deferred();
  let calls = 0;
  app.pauseEva = () => { calls++; return response.promise; };
  const saved = globalThis.document;
  globalThis.document = { getElementById: () => ({ addEventListener() {} }) };
  try {
    const controls = new EvaControls(app, { playing: false });
    const first = controls.toggle();
    await controls.toggle();
    assert.equal(calls, 1);
    response.resolve({ ok: true });
    await first;
    assert.equal(controls.starting, false);
  } finally { globalThis.document = saved; }
});

for (const folder of ['demo', 'missions/mount-sharp', 'missions/jezero']) {
  test(`pełna EVA na danych ${folder}: punkty trasy, zagrożenia i powrót`, async () => {
    const root = new URL(`../data/${folder}/`, import.meta.url);
    const mission = JSON.parse(await readFile(new URL('mission.json', root), 'utf8'));
    const raw = await readFile(new URL(mission.dem.file, root));
    const heights = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const terrain = new Terrain({ heights, width: mission.dem.width, height: mission.dem.height, cellM: mission.dem.cellM });
    const hz = mission.layers.find((l) => l.id === 'hazards').raster;
    const png = await decodePngGray(await readFile(new URL(hz.file, root)));
    const hazards = new Raster({ data: png.data, width: png.width, height: png.height, cellM: hz.cellM });
    let initial = null;
    if (folder !== 'demo') initial = JSON.parse(await readFile(new URL('backend/plan.json', root), 'utf8')).response;
    const ds = { mode: 'files', planRoute: async ({ start, waypoints, obstacles = [] }) => {
      if (initial) { const result = initial; initial = null; return result; }
      return planRoute({ terrain, hazards, start, waypoints, obstacles, eva: mission.eva });
    } };
    const app = new App(ds, { mission, terrain, rasters: { hazards } });
    await app.planInitial({ animate: false });
    app.startEva();
    for (let i = 0; i < 4000 && app.phase !== 'atTarget' && app.sim.running; i++) { app.update(0.1); await tick(); }
    assert.equal(app.phase, 'atTarget', JSON.stringify(app.state.alert));
    assert.deepEqual(app.sim.reached, mission.waypoints.map((w) => w.id));
    assert.ok(app.state.obstacles.length > 0);
    assert.ok(app.sim.fired.size >= 2);
    assert.ok(app.sim.crew.every((c) => c.o2 > 0));
    await app.returnToHabitat();
    assert.equal(app.phase, 'returning', JSON.stringify(app.state.alert));
    for (let i = 0; i < 4000 && app.sim.running; i++) { app.update(0.1); await tick(); }
    assert.equal(app.phase, 'done', JSON.stringify(app.state.alert));
    assert.equal(app.sim.reached.at(-1), 'HAB');
    assert.ok(app.sim.crew.every((c) => c.o2 > 0));
  });
}
