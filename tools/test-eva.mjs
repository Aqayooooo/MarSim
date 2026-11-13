// Regresje sterowania EVA: tryb lokalny, błędy API i wyścigi odczytów trasy.
// Uruchomienie: node --test tools/test-eva.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { App } from '../src/app.js';
import { Director } from '../src/demo.js';
import { helmetStatus } from '../src/ui/helmetHud.js';
import { DeviceView } from '../src/ui/views.js';
import { t } from '../src/i18n.js';
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

test('urządzenie pokazuje postój podczas pauzy i usuwa cel po nowym wyjściu', async () => {
  const { app } = fixture();
  const saved = globalThis.document;
  const elements = new Map();
  globalThis.document = { getElementById: (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', className: '', setAttribute() {} });
    return elements.get(id);
  } };
  try {
    const device = new DeviceView(app);
    await app.planInitial({ animate: false });
    app.startEva();
    app.update(0.1);
    device.update();
    assert.equal(elements.get('dvMsg').textContent, `OK · ${t('dev.walk')}`);
    app.pauseEva(true);
    device.update();
    assert.equal(elements.get('dvMsg').textContent, `OK · ${t('dev.stop')}`);
    app.reset();
    device.update();
    assert.equal(elements.get('dvTgt').textContent, t('dev.target'));
    assert.equal(elements.get('dvDist').textContent, '—');
  } finally { globalThis.document = saved; }
});

test('wizjer nadaje pierwszeństwo zagrożeniom i rozróżnia brak pomiaru baterii', () => {
  const good = { oxygen: 90, battery: 80, reserve: 2, zone: 0, sep: false, offline: false, planned: true };
  assert.equal(helmetStatus(good).tone, 'normal');
  assert.equal(helmetStatus({ ...good, battery: null }).tone, 'normal');
  assert.equal(helmetStatus({ ...good, planned: false }).key, 'visor.ready');
  assert.equal(helmetStatus({ ...good, oxygen: 18 }).key, 'visor.returnNow');
  assert.equal(helmetStatus({ ...good, reserve: -0.1 }).key, 'visor.returnNow');
  assert.equal(helmetStatus({ ...good, battery: 22 }).key, 'visor.lowBattery');
  assert.equal(helmetStatus({ ...good, zone: 2 }).key, 'hud.nogo');
  assert.equal(helmetStatus({ ...good, zone: 1 }).tone, 'warning');
  assert.equal(helmetStatus({ ...good, oxygen: 18, sep: true }).key, 'visor.shelter');
  assert.equal(helmetStatus({ ...good, oxygen: 18, offline: true }).key, 'visor.offline');
});

test('wyjście kończy się, gdy do habitatu dojdzie cała załoga (tryb lokalny)', async () => {
  const { app } = fixture();
  app.m.habitat = { x: app.m.rover.x - 60, y: app.m.rover.y };
  await app.planInitial({ animate: false });
  app.startEva(60);
  for (let k = 0; k < 400 && app.sim.crewS < 30; k++) app.update(0.1);
  await app.returnToHabitat();
  app.sim.running = true;
  for (let k = 0; k < 20000 && !app.sim.finished; k++) app.update(0.1);
  assert.equal(app.sim.finished, true);
  for (const i of [0, 1]) {
    const p = app.sim.crewPos(i);
    assert.ok(Math.hypot(p.x - app.m.habitat.x, p.y - app.m.habitat.y) < 0.5, `EV${i + 1}`);
  }
});

test('tryb lokalny zgłasza alarm tlenu raz i liczy zapas do habitatu', async () => {
  const { app } = fixture();
  const alerts = [];
  app.on('alert', () => { if (app.state.alert) alerts.push(app.state.alert.text); });
  await app.planInitial({ animate: false });
  app.sim.rasters = { timeToHabitat: { sample: () => 1800 } };   // pół godziny do habitatu
  app.sim.crew[1].o2 = app.m.eva.o2ReservePct + 1;
  const expected = (app.sim.crew[1].o2 - app.m.eva.o2ReservePct) / app.sim.crew[1].o2RatePctH - 0.5;
  assert.ok(Math.abs(app.sim.reserveH() - expected) < 1e-9);
  app.startEva(470);
  for (let k = 0; k < 50; k++) app.update(0.1);
  const o2 = alerts.filter((a) => a.startsWith('Hubert: '));
  assert.ok(o2.includes('Hubert: za mało tlenu na powrót pieszo — wezwij łazik'), o2.join(' | '));
  assert.ok(o2.includes(`Hubert: tlen poniżej rezerwy ${app.m.eva.o2ReservePct}%`), o2.join(' | '));
  assert.equal(new Set(o2).size, o2.length);
});

test('wizjer: próg tlenu z rezerwy misji', () => {
  const good = { oxygen: 22, battery: 80, reserve: 2, zone: 0, sep: false, offline: false, planned: true };
  assert.equal(helmetStatus({ ...good, reservePct: 20 }).key, 'visor.nominal');
  assert.equal(helmetStatus({ ...good, reservePct: 25 }).key, 'visor.returnNow');
});

test('litera trasy po Z wraca do A (tryb lokalny)', async () => {
  const { app } = fixture();
  await app.planInitial({ animate: false });
  app.state.route.letter = 'Z';
  app.startEva(60);
  app.update(0.1);
  await app.reportObservation({ kind: 'glazy', x: 100, y: 100, radiusM: 30 });
  assert.equal(app.state.route.letter, 'A');
});

test('plan wyjścia: nowe punkty dostają kolejne numery i trafiają do planera oraz symulacji', async () => {
  const { app, ds } = fixture();
  let sent = null;
  ds.planRoute = async ({ start, waypoints }) => { sent = waypoints.map((w) => w.id); return route(start, waypoints); };
  app.setWaypoints([...app.m.waypoints, { id: '', x: 300, y: 200, stopMin: 5 }]);
  assert.deepEqual(app.m.waypoints.map((w) => w.id), ['WP1', 'WP2', 'WP3']);
  assert.deepEqual(app.sim.waypoints.map((w) => w.id), ['WP1', 'WP2', 'WP3']);
  assert.equal(app.waypointsCustom, true);
  await app.planInitial({ animate: false });
  assert.deepEqual(sent, ['WP1', 'WP2', 'WP3']);
  assert.deepEqual(app.state.route.wpIds, ['WP1', 'WP2', 'WP3']);
  app.restoreDefaultWaypoints();
  assert.equal(app.waypointsCustom, false);
  assert.equal(app.m.waypoints.length, 2);
});

test('nieudane wyznaczenie trasy usuwa nieaktualną trasę; tryb cichy nie pokazuje alertu', async () => {
  const { app, ds } = fixture();
  await app.planInitial({ animate: false });
  assert.ok(app.state.route);
  ds.planRoute = async () => ({ ok: false, error: 'Cel WP1 leży w strefie niedostępnej' });
  assert.equal(await app.planInitial({ animate: false, quiet: true }), null);
  assert.equal(app.state.route, null);
  assert.equal(app.lastPlanError, 'Cel WP1 leży w strefie niedostępnej');
  assert.equal(app.state.alert, null);
});

test('plan wyjścia można zmieniać tylko przed startem', async () => {
  const { app } = fixture();
  assert.equal(app.canEditWaypoints, true);
  await app.planInitial({ animate: false });
  app.startEva(470);
  app.update(0.1);
  assert.equal(app.canEditWaypoints, false);
});

test('z backendem interfejs przyjmuje listę punktów trwającego wyjścia (np. z innej karty)', async () => {
  const { app, ds } = fixture(true);
  const custom = [...app.m.waypoints.map((w) => ({ ...w })), { id: 'WP3', x: 400, y: 120, stopMin: 7 }];
  ds.get = async () => ({ route: { ...route(app.m.rover, custom, 4), letter: 'A' }, discarded: [], waypoints: custom });
  ds.receive(snapshot(app, 4));
  await tick(); await tick();
  assert.deepEqual(app.m.waypoints.map((w) => w.id), ['WP1', 'WP2', 'WP3']);
  assert.equal(app.m.waypoints[2].stopMin, 7);
  assert.ok(app.m.waypoints[1].view || !template.waypoints[1].view, 'pola opisowe punktu z misji zostają');
  // trasa powrotu (z habitatem) nie zmienia planu wyjścia
  ds.get = async () => ({ route: { ...route(app.m.rover, [{ id: 'HAB', x: 10, y: 10 }], 5), letter: 'B' }, discarded: [], waypoints: [{ id: 'HAB', x: 10, y: 10 }] });
  ds.receive(snapshot(app, 5));
  await tick(); await tick();
  assert.equal(app.m.waypoints.length, 3);
});

test('kamienie: wokół habitatu i postoju łazika pusto, reszta układu bez zmian', async () => {
  const { makeRocks, clearings } = await import('../src/core/rocks.js');
  const hazards = { sample: () => 0 };
  const all = makeRocks({ W: 1000, H: 800, hazards });
  const mission = { habitat: { x: 300, y: 300 }, rover: { x: 500, y: 400 } };
  const clear = makeRocks({ W: 1000, H: 800, hazards, keepClear: clearings(mission) });
  for (const c of clearings(mission)) assert.ok(clear.every((r) => Math.hypot(r.x - c.x, r.y - c.y) >= c.r));
  const outside = all.filter((r) => clearings(mission).every((c) => Math.hypot(r.x - c.x, r.y - c.y) >= c.r));
  assert.deepEqual(clear, outside);
});
