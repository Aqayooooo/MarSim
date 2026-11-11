// Testy interfejsu w prawdziwej przeglądarce (Playwright, Chromium bez okna): wersja bez serwera, telefon i backend.
// Uruchomienie: npm run test:browser   (lokalnie bez pobierania Chromium: PW_CHANNEL=chrome albo msedge)
// Serwery startują na wolnych portach; baza backendu jest w katalogu tymczasowym.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? join(ROOT, '.venv', 'Scripts', 'python.exe') : 'python3');
const LOAD_MS = 30000;

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Uruchamia proces serwera i czeka, aż odpowie pod podanym adresem. */
async function startServer(args, url) {
  const proc = spawn(PYTHON, args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const t0 = Date.now();
  while (Date.now() - t0 < LOAD_MS) {
    if (proc.exitCode !== null) throw new Error(`Serwer zakończył pracę: ${stderr.slice(-800)}`);
    try { if ((await fetch(url)).ok) return proc; } catch { /* jeszcze nie słucha */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error(`Serwer nie odpowiedział w ${LOAD_MS / 1000} s: ${stderr.slice(-800)}`);
}

async function launch() {
  const channel = process.env.PW_CHANNEL || undefined;
  try { return await chromium.launch({ channel }); } catch (e) {
    if (channel) throw e;
    for (const c of ['chrome', 'msedge']) { try { return await chromium.launch({ channel: c }); } catch { /* następna */ } }
    throw e;
  }
}

/** Strona z licznikiem błędów konsoli i wyjątków; czeka na złożenie aplikacji (window.marsim). */
async function openApp(browser, url, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400 && r.status() !== 409) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });   // 409: odmowa celowa
  await page.goto(url);
  await page.waitForFunction(() => window.marsim?.app, null, { timeout: LOAD_MS });
  return { page, context, errors };
}

const phaseIsNot = (page, phase) => page.waitForFunction((p) => window.marsim.app.phase !== p, phase, { timeout: LOAD_MS });

let browser, staticServer, staticUrl;
test.before(async () => {
  browser = await launch();
  const port = await freePort();
  staticUrl = `http://127.0.0.1:${port}/`;
  staticServer = await startServer(['tools/serve.py', String(port), '--no-reload'], staticUrl);
});
test.after(async () => {
  await browser?.close();
  staticServer?.kill();
});

test('bez serwera: wprowadzenie, start EVA, widoki 3D i hełm, raport — bez błędów', async () => {
  const { page, context, errors } = await openApp(browser, staticUrl);
  assert.equal(await page.isVisible('#intro'), true, 'karta „Jak zacząć” przy pierwszym wejściu');
  await page.click('#introOk');
  assert.equal(await page.isVisible('#intro'), false);

  await page.click('#evaBtn');
  await phaseIsNot(page, 'idle');
  assert.ok(await page.evaluate(() => window.marsim.app.state.route.lengthM > 100));

  await page.click('#viewSeg [data-view="orbit"]');
  await page.waitForFunction(() => window.marsim.view3d?.renderer.info.render.triangles > 100000, null, { timeout: LOAD_MS });
  assert.equal(await page.evaluate(() => window.marsim.view3d.block.visible), true, 'ściany bloku terenu z orbity');

  await page.click('#viewSeg [data-view="helmet"]');
  await page.waitForFunction(() => window.marsim.view3d.mode === 'helmet' && window.marsim.view3d.pebbles.mesh.count > 100, null, { timeout: LOAD_MS });
  assert.equal(await page.isVisible('#hud'), true);
  assert.equal(await page.evaluate(() => window.marsim.view3d.habitatMesh.visible), true);

  await page.click('#viewSeg [data-view="report"]');
  await page.waitForSelector('#report .sens-table', { timeout: LOAD_MS });
  assert.match(await page.textContent('#report'), /Niepewność i wrażliwość/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('bez serwera: edytor punktów EVA dodaje punkt kliknięciem i przelicza trasę', async () => {
  const { page, context, errors } = await openApp(browser, staticUrl);
  await page.click('#introOk');
  await page.click('#wpBtn');
  await page.waitForFunction(() => window.marsim.app.state.route, null, { timeout: LOAD_MS });
  const box = await page.locator('#map').boundingBox();
  const [px, py] = await page.evaluate(() => { const m = window.marsim.map; return [m.sx(1000) / 972, m.sy(300) / 648]; });
  await page.mouse.click(box.x + px * box.width, box.y + py * box.height);
  await page.waitForFunction(() => window.marsim.app.state.route?.wpIds.length === 3, null, { timeout: LOAD_MS });
  assert.match(await page.textContent('#wpEditor'), /WP3/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('marsim.waypoints.mount-sharp')).length), 3, 'plan zapisany w przeglądarce');
  await page.click('#wpEditor [data-a="reset"]');
  await page.waitForFunction(() => window.marsim.app.state.route?.wpIds.length === 2, null, { timeout: LOAD_MS });
  assert.deepEqual(errors, []);
  await context.close();
});

test('telefon: układ kolumnowy, bez przewijania w poziomie, czytelne panele', async () => {
  const { page, context, errors } = await openApp(browser, staticUrl, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  assert.equal(await page.evaluate(() => document.getElementById('stage').classList.contains('compact')), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'brak poziomego przewijania');
  const card = await page.locator('#cDose').boundingBox();
  assert.ok(card.width > 120, 'karty panelu stanu w zwykłej wielkości');
  await page.click('#introOk');
  await page.click('#viewSeg [data-view="helmet"]');
  await page.waitForFunction(() => window.marsim.view3d?.mode === 'helmet', null, { timeout: LOAD_MS });
  assert.equal(await page.isVisible('#walkPad'), true, 'przyciski marszu na ekranie dotykowym');
  assert.deepEqual(errors, []);
  await context.close();
});

test('z backendem: start EVA, analiza „co jeśli” i raport z przedziałem niepewności', async () => {
  const db = await mkdtemp(join(tmpdir(), 'marsim-browser-'));
  const port = await freePort(), url = `http://127.0.0.1:${port}/`;
  const server = await startServer(['backend/server.py', String(port), '--no-live-feeds', '--db-dir', db], `${url}api/health`);
  try {
    const { page, context, errors } = await openApp(browser, url);
    assert.equal(await page.evaluate(() => window.marsim.app.ds.mode), 'http');
    await page.click('#introOk');
    await page.click('#evaBtn');
    await phaseIsNot(page, 'idle');
    const state = await (await fetch(`${url}api/state`)).json();
    assert.equal(state.running, true);
    assert.equal((await fetch(`${url}api/plan`, { method: 'POST' })).status, 409, 'trasy nie zmienia się w trakcie EVA');
    await page.click('#sensBtn');
    await page.waitForSelector('#sensRange', { timeout: LOAD_MS });
    await page.click('#viewSeg [data-view="report"]');
    await page.waitForSelector('#report .sens-int', { timeout: LOAD_MS });
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    server.kill();
    await rm(db, { recursive: true, force: true }).catch(() => {});
  }
});

test('hełm jak w grze: marsz W, tempo +, bieg Shift i skok spacją (bez startu EVA)', async () => {
  const { page, context, errors } = await openApp(browser, `${staticUrl}?view=helmet`);
  await page.waitForFunction(() => window.marsim.view3d?.mode === 'helmet', null, { timeout: LOAD_MS });
  const pos = () => page.evaluate(() => { const h = window.marsim.view3d.helmet; return { x: h.x, y: h.y, z: h.z, speed: h.speed }; });
  const p0 = await pos();
  await page.keyboard.down('KeyW'); await page.waitForTimeout(800); await page.keyboard.up('KeyW');
  const p1 = await pos();
  const walked = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  assert.ok(walked > 0.3, `marsz W: ${walked} m`);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Equal');
  assert.equal(await page.evaluate(() => window.marsim.view3d.hudInfo().pace), 8);
  await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW'); await page.waitForTimeout(800);
  const fast = await pos();
  await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
  assert.ok(fast.speed > 60, `bieg przy tempie ×8: ${fast.speed} km/h`);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.marsim.view3d.helmet.z > 0.05, null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.marsim.app.phase), 'idle', 'spacja w hełmie to skok, nie start EVA');
  assert.deepEqual(errors, []);
  await context.close();
});

test('łazik: F przy łaziku — wsiadanie, jazda W/D, kamera na wysięgniku, kabina C, wysiadanie F', async () => {
  const { page, context, errors } = await openApp(browser, `${staticUrl}?view=helmet`);
  await page.waitForFunction(() => window.marsim.view3d?.mode === 'helmet', null, { timeout: LOAD_MS });
  await page.evaluate(() => { const { app, view3d: v } = window.marsim, r = app.roverPos(); Object.assign(v.helmet, { x: r.x + 5, y: r.y + 3 }); });
  await page.keyboard.press('KeyF');
  assert.equal(await page.evaluate(() => !!window.marsim.view3d.ride), true);
  assert.equal(await page.isVisible('#rideHud'), true);
  const p0 = await page.evaluate(() => ({ ...window.marsim.app.roverPos() }));
  await page.keyboard.down('KeyW'); await page.waitForTimeout(1500);
  await page.keyboard.down('KeyD'); await page.waitForTimeout(600); await page.keyboard.up('KeyD'); await page.keyboard.up('KeyW');
  const s = await page.evaluate(() => { const { app, view3d: v } = window.marsim, p = app.roverPos(); return { x: p.x, y: p.y, boom: v.boom.visible, heading: v.ride.heading }; });
  assert.ok(Math.hypot(s.x - p0.x, s.y - p0.y) > 1, 'łazik pojechał');
  assert.equal(s.boom, true, 'kamera na widocznym wysięgniku');
  await page.keyboard.press('KeyC');
  await page.waitForFunction(() => window.marsim.view3d.ride.cabin && !window.marsim.view3d.roverMesh.visible, null, { timeout: 5000 });   // po klatce
  await page.keyboard.press('KeyF');
  const out = await page.evaluate(() => { const { app, view3d: v } = window.marsim, p = app.roverPos(); return { ride: !!v.ride, d: Math.hypot(v.helmet.x - p.x, v.helmet.y - p.y) }; });
  assert.equal(out.ride, false);
  assert.ok(out.d > 3 && out.d < 6, `wyjście przez śluzę obok łazika: ${out.d} m`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('habitat: z rampy do śluzy, cykl ciśnienia klawiszem E, wejście do modułu bez hełmu', async () => {
  const { page, context, errors } = await openApp(browser, `${staticUrl}?view=helmet`);
  await page.waitForFunction(() => window.marsim.view3d?.hab, null, { timeout: LOAD_MS });
  // na rampie, przodem do drzwi śluzy (−x w układzie habitatu)
  await page.evaluate(() => {
    const { app, view3d: v } = window.marsim, hab = app.m.habitat, a = v.habitatMesh.rotation.y, c = Math.cos(a), s = Math.sin(a);
    window.local = () => { const dx = v.helmet.x - hab.x, dy = v.helmet.y - hab.y; return { x: dx * c - dy * s, z: dx * s + dy * c }; };
    Object.assign(v.helmet, { x: hab.x + 10 * c, y: hab.y - 10 * s, yaw: (Math.atan2(-c, -s) * 180 / Math.PI + 360) % 360, pitch: -5 });
  });
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.local().x < 6.2, null, { timeout: LOAD_MS });
  await page.keyboard.up('KeyW');
  await page.waitForFunction(() => window.marsim.view3d.hab.station?.id === 'airlockPanel', null, { timeout: 10000 });
  assert.equal(await page.isVisible('#habHud'), true, 'wskaźniki habitatu w śluzie');
  await page.keyboard.press('KeyE');
  assert.equal(await page.evaluate(() => window.marsim.view3d.hab.airlock.state), 'cycling');
  await page.waitForFunction(() => window.marsim.view3d.hab.airlock.state === 'in', null, { timeout: 90000 });
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.marsim.view3d.hab.zone?.id === 'module', null, { timeout: LOAD_MS });
  await page.keyboard.up('KeyW');
  const s = await page.evaluate(() => { const v = window.marsim.view3d; return { off: v.hab.helmetOff, rim: v.interior.group.visible, hud: document.getElementById('hud').hidden }; });
  assert.deepEqual(s, { off: true, rim: false, hud: true }, 'w module hełm zdjęty, wizjer schowany');
  assert.equal(await page.evaluate(() => window.marsim.app.phase), 'idle', 'E w habitacie nie startuje EVA bez stanowiska skafandrów');
  assert.deepEqual(errors, []);
  await context.close();
});
