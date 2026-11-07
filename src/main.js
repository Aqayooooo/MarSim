// Start aplikacji: wczytanie danych, złożenie widoków, pętla klatek.
// Parametry adresu: ?data=ścieżka/do/katalogu, ?api=http://backend (tryb backendu), ?demo (autostart prezentacji).
// Bez ?data= i bez backendu: domyślna misja z data/missions/index.json (dane NASA + przykładowe dane backendu), inaczej data/demo.
import { createDataSource, detectBackend } from './data/source.js';
import { DeviceView, ReportView, ScheduleView, FieldReports, RouteCompare } from './ui/views.js';
import { App } from './app.js';
import { Panels } from './ui/panels.js';
import { Map2D } from './ui/map2d.js';
import { Director } from './demo.js';
import { num } from './core/format.js';
import { t, lang, setLang, applyStatic } from './i18n.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
applyStatic();
document.querySelectorAll('#langSeg button').forEach((b) => {
  b.classList.toggle('on', b.dataset.lang === lang);
  b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  b.addEventListener('click', () => setLang(b.dataset.lang));
});
const q = new URLSearchParams(location.search);
const api = q.has('data') ? null : await detectBackend(q.get('api'));
if (api !== null) setupMissions(api);
// bez backendu: lista misji z przykładowymi danymi backendu (tools/export_backend_sample.py)
const missionIndex = api === null ? await fetch('data/missions/index.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
const base = (q.get('data') || (missionIndex?.default ? `data/missions/${missionIndex.default}` : 'data/demo')).replace(/\/$/, '');
if (missionIndex) setupStaticMissions(missionIndex, base);
const ds = createDataSource({ mode: api !== null ? 'http' : 'files', base, api: api ?? '' });

let world;
try {
  world = await ds.loadMission();
} catch (e) {
  $('loading').textContent = t('loading.fail', { e: e.message });
  throw e;
}
$('loading').remove();

const app = new App(ds, world);
const panels = new Panels(app);
const map = new Map2D($('map'), app);
let view3d = null;
const director = new Director(app, () => view3d);
const device = new DeviceView(app), report = new ReportView(app), schedule = new ScheduleView(app);
new FieldReports(app, map);
const compare = new RouteCompare(app);
window.marsim = { app, director, map, panels, device, report, schedule, compare, get view3d() { return view3d; } };   // do debugowania w konsoli

function fit() {
  const s = Math.min(innerWidth / 1664, innerHeight / 744);
  stage.style.transform = `translate(${(innerWidth - 1664 * s) / 2}px, ${(innerHeight - 744 * s) / 2}px) scale(${s})`;
  map.resize(s);
  view3d?.resize(s);
}
addEventListener('resize', fit);
fit();

// Widok 3D wczytuje się w tle (three.js z CDN), mapa 2D działa od razu.
document.querySelectorAll('#viewSeg button[data-view="orbit"], #viewSeg button[data-view="helmet"]').forEach((b) => (b.disabled = true));
import('./ui/view3d.js').then(({ View3D }) => {
  view3d = new View3D($('view3d'), app);
  fit();
  document.querySelectorAll('#viewSeg button').forEach((b) => (b.disabled = false));
  if (['orbit', 'helmet'].includes(app.state.view)) view3d.setMode(app.state.view);
}).catch((e) => console.error('3D view unavailable / widok 3D niedostępny:', e));

// ---------- wybór misji bez backendu: przeładowanie z ?data=<katalog> ----------
function setupStaticMissions(index, current) {
  const opts = (index.missions || []).map((m) => ({ v: `data/missions/${m.id}`, label: m.label?.[lang] || m.id }));
  if (!opts.length) return;
  opts.push({ v: 'data/demo', label: t('mission.demo') });
  if (!opts.some((o) => o.v === current)) opts.push({ v: current, label: current });   // własny ?data=
  const sel = $('missionSel');
  sel.innerHTML = '';
  for (const o of opts) {
    const el = document.createElement('option');
    el.value = o.v; el.textContent = o.label; el.selected = o.v === current;
    sel.appendChild(el);
  }
  sel.hidden = false;
  sel.addEventListener('change', () => {
    const p = new URLSearchParams(location.search);
    p.set('data', sel.value);
    location.search = [...p].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2F/g, '/')}`).join('&');
  });
}

// ---------- wybór misji (tylko z backendem) ----------
async function setupMissions(base) {
  try {
    const r = await (await fetch(`${base}/api/missions`, { cache: 'no-store' })).json();
    const sel = $('missionSel');
    if (!r.missions || r.missions.length < 2) return;
    sel.innerHTML = '';
    for (const m of r.missions) {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.label?.[lang] || m.id; o.selected = m.id === r.active;
      sel.appendChild(o);
    }
    sel.hidden = false;
    sel.addEventListener('change', async () => {
      sel.disabled = true;
      const res = await fetch(`${base}/api/missions/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sel.value }) });
      if (res.ok) location.reload(); else { sel.disabled = false; alert(t('mission.error')); }
    });
  } catch { /* brak listy misji — zostaje jedna */ }
}

// ---------- widoki ----------
$('viewSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (director.playing) director.stop();
  app.setView(b.dataset.view);
});
function applyView(v) {
  document.querySelectorAll('#viewSeg button').forEach((b) => { b.classList.toggle('on', b.dataset.view === v); b.setAttribute('aria-selected', String(b.dataset.view === v)); });
  const is3d = v === 'orbit' || v === 'helmet';
  $('view3d').classList.toggle('on', is3d);
  $('hud').hidden = v !== 'helmet';
  $('view3dLabel').hidden = v !== 'orbit';
  $('view3dLabel').textContent = t('view3d.label', { x: view3d?.exOrbit ?? 10 });
  $('device').hidden = v !== 'device';
  $('report').hidden = v !== 'report';
  $('schedule').hidden = v !== 'schedule';
  $('reportBtn').hidden = v !== 'map';
  if (v !== 'map') { $('obsForm').hidden = true; app.state.reportMode = false; $('reportBtn').classList.remove('on'); $('main').classList.remove('reporting'); }
  if (v === 'report') report.open();
  if (v === 'schedule') schedule.open();
  if (view3d && is3d) view3d.setMode(v);
}
app.on('view', applyView);
app.on('reset', () => applyView(app.state.view));

// ---------- przyciski ----------
$('demoBtn').addEventListener('click', () => {
  if (director.playing) { director.stop(); return; }
  director.play();
});
app.on('director', (on) => { $('demoBtn').textContent = on ? t('demo.stop') : t('demo.play'); $('evaBtn').disabled = on; });

$('evaBtn').addEventListener('click', async () => {
  if (app.sim.running) { app.pauseEva(true); $('evaBtn').textContent = t('eva.resume'); return; }
  if (app.state.route && app.sim.crewS > 0) { app.pauseEva(false); $('evaBtn').textContent = t('eva.pause'); return; }
  for (const id of ['optical', 'terrain', 'hazards']) app.toggleLayer(id, true);
  app.setView('map');
  await app.planInitial({ animate: true });
  setTimeout(() => { app.startEva(470); $('evaBtn').textContent = t('eva.pause'); }, 3400);
});
app.on('reset', () => { $('evaBtn').textContent = t('eva.start'); });

// ---------- WP z widokiem: render terenu z poziomu gruntu ----------
app.on('waypoint', ({ wp }) => {
  if (!wp.view || !view3d) return;
  const r = app.state.route, i = app.m.waypoints.indexOf(wp);
  const heading = r.poly.heading(r.wpS[i] - 6);
  setTimeout(() => app.setWaypointView(wp.id, view3d.snapshot(wp, heading), wp.view.caption), 240);
});

// ---------- HUD hełmu ----------
function updateHud() {
  const h = view3d.hudInfo(), crew = app.sim.crew[0];
  $('hudTitle').textContent = `${t('hud.title', { id: crew.id })}${h.timelapse > 1 ? ` · TIMELAPSE ×${h.timelapse}` : ''}`;
  $('hudHeading').textContent = t('hud.heading', { h: String(h.heading).padStart(3, '0') });
  $('hudDist').textContent = t('hud.to', { t: h.target, d: Math.round(h.dist) });
  $('hudSpeed').textContent = `${num(h.speed, h.speed < 10 ? 1 : 0)} KM/H`;
  const mid = `O<span class="sub2">₂</span> ${Math.round(crew.o2)}% · ${t('hud.slope')} ${Math.round(h.slope)}°`;
  if ($('hudMid').innerHTML !== mid) $('hudMid').innerHTML = mid;
  const w = $('hudWarn');
  const msg = h.warn || (h.zone === 2 ? t('hud.nogo') : h.zone === 1 ? t('hud.caution') : null);
  w.hidden = !msg;
  if (msg) { w.textContent = msg; w.classList.toggle('caution', !h.warn && h.zone === 1); }
  $('hudHelp').hidden = h.timelapse > 1;
}

// ---------- pętla ----------
let last = performance.now();
function frame(t) {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  app.update(dt);
  const v = app.state.view;
  if (v === 'map') map.render(dt);
  else if ((v === 'orbit' || v === 'helmet') && view3d) { view3d.render(dt); if (v === 'helmet') updateHud(); }
  else if (v === 'device') device.update();
  panels.update();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
applyView('map');
if (q.has('demo')) director.play();
