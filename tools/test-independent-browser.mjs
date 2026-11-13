// Niezależny test dymny prawdziwej aplikacji w przeglądarce (Playwright, Chromium bez okna).
// Uruchamia backend (tymczasowa baza, bez pobierania pogody kosmicznej) i wersję bez serwera (tools/serve.py),
// otwiera stronę, przechodzi przez wszystkie zakładki widoków, startuje EVA i sprawdza ?lang=en.
// Kryterium: brak błędów w konsoli, brak nieudanych zapytań (poza celowym 409) i widoczna treść każdego widoku.
// Uruchomienie: node --test --test-concurrency=1 tools/test-independent-browser.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENV = join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const PYTHON = process.env.PYTHON || (existsSync(VENV) ? VENV : 'python3');
const TIMEOUT = 30000;
const VIEWS = ['map', 'orbit', 'helmet', 'device', 'report', 'schedule'];

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startServer(python, args, probe) {
  const proc = spawn(python, args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT) {
    if (proc.exitCode !== null) throw new Error(`serwer ${args[0]} zakończył pracę: ${stderr.slice(-600)}`);
    try { if ((await fetch(probe)).ok) return proc; } catch { /* jeszcze nie słucha */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error(`serwer ${args[0]} nie odpowiedział: ${stderr.slice(-600)}`);
}

function stop(proc) {
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 3000);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
    proc.kill();
  });
}

let browser, backend, backendUrl, staticServer, staticUrl, dbDir;

test.before(async () => {
  const channel = process.env.PW_CHANNEL || undefined;
  browser = await chromium.launch({ channel });
  dbDir = await mkdtemp(join(tmpdir(), 'marsim-independent-'));
  const [bp, sp] = [await freePort(), await freePort()];
  backendUrl = `http://127.0.0.1:${bp}/`;
  staticUrl = `http://127.0.0.1:${sp}/`;
  backend = await startServer(PYTHON, ['backend/server.py', String(bp), '--no-live-feeds', '--db-dir', dbDir], `${backendUrl}api/health`);
  staticServer = await startServer('python3', ['tools/serve.py', String(sp), '--no-reload'], staticUrl);
});

test.after(async () => {
  await browser?.close();
  await Promise.all([stop(backend), stop(staticServer)]);
  if (dbDir) await rm(dbDir, { recursive: true, force: true }).catch(() => {});
});

/** Otwiera aplikację i zbiera błędy: wyjątki strony, błędy konsoli, odpowiedzi ≥ 400 (poza 409) i zerwane zapytania. */
async function open(url) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);   // budowa sceny 3D w Chromium bez GPU potrafi chwilę blokować stronę
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && r.status() !== 409) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText || '';
    if (!/ERR_ABORTED/.test(why)) errors.push(`requestfailed ${new URL(r.url()).pathname}: ${why}`);
  });
  await page.goto(url);
  await page.waitForFunction(() => window.marsim?.app, null, { timeout: TIMEOUT });
  if (await page.isVisible('#introOk')) await page.click('#introOk');
  return { page, context, errors };
}

/** Przełącza zakładkę i sprawdza, że widok faktycznie coś pokazuje. */
async function checkView(page, view) {
  await page.click(`#viewSeg [data-view="${view}"]`);
  assert.equal(await page.getAttribute(`#viewSeg [data-view="${view}"]`, 'class').then((c) => /\bon\b/.test(c || '')), true, `zakładka ${view} aktywna`);
  if (view === 'map') {
    assert.equal(await page.isVisible('#map'), true);
    const box = await page.locator('#map').boundingBox();
    assert.ok(box.width > 200 && box.height > 100, 'mapa ma rozmiar');
  } else if (view === 'orbit') {
    await page.waitForFunction(() => window.marsim.view3d?.renderer?.info.render.triangles > 100000, null, { timeout: TIMEOUT });
  } else if (view === 'helmet') {
    await page.waitForFunction(() => window.marsim.view3d?.mode === 'helmet', null, { timeout: TIMEOUT });
    assert.equal(await page.isVisible('#hud'), true, 'wizjer hełmu');
  } else {
    await page.waitForFunction((id) => { const el = document.getElementById(id); return el && !el.hidden && el.textContent.trim().length > 20; }, view, { timeout: TIMEOUT });
  }
}

async function runSmoke(url, { backendMode }) {
  const { page, context, errors } = await open(url);
  try {
    assert.equal(await page.evaluate(() => window.marsim.app.ds.mode), backendMode ? 'http' : 'files');
    assert.equal(await page.evaluate(() => window.marsim.app.phase), 'idle');
    for (const v of VIEWS) await checkView(page, v);
    await checkView(page, 'map');

    await page.click('#evaBtn');
    await page.waitForFunction(() => window.marsim.app.phase !== 'idle', null, { timeout: TIMEOUT });
    assert.ok(await page.evaluate(() => window.marsim.app.state.route?.lengthM > 100), 'wyznaczona trasa');
    if (backendMode) {
      const state = await (await fetch(`${url}api/state`)).json();
      assert.equal(state.running, true, 'backend prowadzi EVA');
      assert.ok(state.routeVersion >= 1);
      await page.waitForFunction(async (u) => (await (await fetch(`${u}api/state`)).json()).t > 0, url, { timeout: TIMEOUT });
      await page.click('#evaBtn');   // ten sam przycisk wstrzymuje
      await page.waitForFunction(async (u) => (await (await fetch(`${u}api/state`)).json()).running === false, url, { timeout: TIMEOUT });
    }
    // widoki działają także w trakcie wyjścia
    for (const v of ['device', 'report', 'map']) await checkView(page, v);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

test('bez serwera (dane demo): wszystkie zakładki, start EVA, bez błędów', async () => {
  await runSmoke(staticUrl, { backendMode: false });
});

test('z backendem: wszystkie zakładki, start i pauza EVA przez API, bez błędów', async () => {
  await fetch(`${backendUrl}api/eva/reset`, { method: 'POST' });
  await runSmoke(backendUrl, { backendMode: true });
});

test('?lang=en: interfejs po angielsku, zakładki bez polskich znaków', async () => {
  const pl = await open(staticUrl);
  const plTabs = await pl.page.$$eval('#viewSeg [data-view]', (els) => els.map((e) => e.textContent.trim()));
  await pl.context.close();
  for (const url of [`${staticUrl}?lang=en`, `${backendUrl}?lang=en`]) {
    const { page, context, errors } = await open(url);
    try {
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'en', url);
      const tabs = await page.$$eval('#viewSeg [data-view]', (els) => els.map((e) => e.textContent.trim()));
      assert.equal(tabs.length, plTabs.length);
      assert.ok(tabs.some((t, i) => t !== plTabs[i]), 'etykiety różnią się od polskich');
      for (const t of tabs) assert.doesNotMatch(t, /[ąćęłńóśźż]/i, t);
      await checkView(page, 'report');
      assert.doesNotMatch(await page.textContent('#viewSeg'), /Raport|Mapa|Urządzenie/);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
});

test('z backendem: przełączenie misji w nagłówku zmienia aktywny obszar', async () => {
  const missions = (await (await fetch(`${backendUrl}api/missions`)).json()).missions.map((m) => m.id);
  assert.ok(missions.length >= 2);
  const { page, context, errors } = await open(backendUrl);
  try {
    const current = await page.evaluate(() => window.marsim.app.m.mission.id);
    const other = missions.find((m) => m !== current);
    const select = page.locator('select').filter({ has: page.locator(`option[value="${other}"]`) }).first();
    await select.selectOption(other);
    await page.waitForFunction(async ({ u, id }) => (await (await fetch(`${u}api/health`)).json()).mission === id, { u: backendUrl, id: other }, { timeout: TIMEOUT });
    await page.waitForFunction((id) => window.marsim?.app?.m?.mission?.id === id, other, { timeout: TIMEOUT });
    await checkView(page, 'map');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await fetch(`${backendUrl}api/missions/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'mount-sharp' }) });
  }
});
