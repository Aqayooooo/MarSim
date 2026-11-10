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
