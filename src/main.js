// Start aplikacji: wczytanie danych, złożenie widoków, pętla klatek.
// Parametry adresu: ?data=ścieżka/do/katalogu, ?api=http://backend (tryb backendu), ?demo (autostart prezentacji), ?lang=en.
// Bez ?data= i bez backendu: domyślna misja z data/missions/index.json (dane NASA + przykładowe dane backendu), inaczej data/demo.
import { createDataSource, detectBackend } from './data/source.js';
import { DeviceView, ReportView, ScheduleView, FieldReports, RouteCompare, PathPicker, DriveHud } from './ui/views.js';
import { App } from './app.js';
import { Panels } from './ui/panels.js';
import { Map2D } from './ui/map2d.js';
import { RouteProfile } from './ui/profile.js';
import { EvaControls } from './ui/evaControls.js';
import { Help } from './ui/help.js';
import { Director } from './demo.js';
import { $, setHidden } from './core/dom.js';
import { num } from './core/format.js';
import { t, lang, setLang, applyStatic } from './i18n.js';

const STAGE_W = 1664, STAGE_H = 744;
const VIEWS_3D = ['orbit', 'helmet', 'drive'];
const stage = $('stage');

let stageScale = 1;
function fitStage() {
  stageScale = Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H);
  stage.style.transform = `translate(${(innerWidth - STAGE_W * stageScale) / 2}px, ${(innerHeight - STAGE_H * stageScale) / 2}px) scale(${stageScale})`;
}
fitStage();                 // od razu, żeby ekran wczytywania też był dopasowany do okna
applyStatic();
document.querySelectorAll('#langSeg button').forEach((b) => {
  b.classList.toggle('on', b.dataset.lang === lang);
  b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  b.addEventListener('click', () => setLang(b.dataset.lang));
});

// ---------- dane ----------
const query = new URLSearchParams(location.search);
const api = query.has('data') ? null : await detectBackend(query.get('api'));
if (api !== null) setupMissions(api.base);
// bez backendu: lista misji z przykładowymi danymi backendu (tools/export_backend_sample.py)
const missionIndex = api === null ? await fetch('data/missions/index.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
const base = (query.get('data') || (missionIndex?.default ? `data/missions/${missionIndex.default}` : 'data/demo')).replace(/\/$/, '');
if (missionIndex) setupStaticMissions(missionIndex, base);
const ds = createDataSource({ mode: api !== null ? 'http' : 'files', base, api: api?.base ?? '' });

let world;
try {
  world = await ds.loadMission();
} catch (e) {
  $('loading').textContent = t('loading.fail', { e: e.message });
  throw e;
}
$('loading').remove();

// ---------- widoki ----------
const app = new App(ds, world);
const panels = new Panels(app);
const map = new Map2D($('map'), app);
let view3d = null;
const director = new Director(app, () => view3d, () => ensureView3D());
const device = new DeviceView(app), report = new ReportView(app), schedule = new ScheduleView(app);
new FieldReports(app, map);
const compare = new RouteCompare(app);
const picker = new PathPicker(app, map);
const driveHud = new DriveHud(app, () => view3d);
const profile = new RouteProfile(app);
const eva = new EvaControls(app, director);
const sampleMeta = api === null ? await ds.sample('meta') : null;
const help = new Help(app, {
  setView: (v) => selectView(v),
  toggleEva: () => eva.toggle(),
  returnHome: () => eva.returnHome(),
  toggleCompare: () => compare.toggle(),
  toggleProfile: () => profile.toggle(),
}, {
  footer: api !== null ? t('help.modeLive', { v: api.version })
    : sampleMeta?.generatedUtc ? t('help.modeStatic', { d: String(sampleMeta.generatedUtc).slice(0, 10) }) : t('help.modeDemo'),
});
window.marsim = { app, director, map, panels, device, report, schedule, compare, picker, driveHud, profile, eva, help, get view3d() { return view3d; } };   // do debugowania w konsoli

function fit() {
  fitStage();
  map.resize(stageScale);
  view3d?.resize(stageScale);
}
addEventListener('resize', fit);
fit();

let view3dLoading = null;
function ensureView3D() {
  if (view3d) return Promise.resolve(view3d);
  if (view3dLoading) return view3dLoading;
  $('view3d').querySelector('#loading')?.remove();
  const status = document.createElement('div');
  status.id = 'loading';
  status.setAttribute('role', 'status');
  status.textContent = t('loading');
  $('view3d').appendChild(status);
  view3dLoading = import('./ui/view3d.js').then(({ View3D }) => {
    view3d = new View3D($('view3d'), app);
    status.remove();
    fit();
    if (VIEWS_3D.includes(app.state.view)) view3d.setMode(app.state.view);
    return view3d;
  }).catch((e) => {
    status.textContent = t('loading.fail', { e: e.message });
    view3dLoading = null;
    throw e;
  });
  return view3dLoading;
}

// ---------- wybór misji bez backendu: przeładowanie z ?data=<katalog> ----------
function setupStaticMissions(index, current) {
  const options = (index.missions || []).map((m) => ({ value: `data/missions/${m.id}`, label: m.label?.[lang] || m.id }));
  if (!options.length) return;
  options.push({ value: 'data/demo', label: t('mission.demo') });
  if (!options.some((o) => o.value === current)) options.push({ value: current, label: current });   // własny ?data=
  const select = $('missionSel');
  select.replaceChildren(...options.map((o) => new Option(o.label, o.value, false, o.value === current)));
  select.hidden = false;
  select.addEventListener('change', () => {
    const params = new URLSearchParams(location.search);
    params.set('data', select.value);
    location.search = [...params].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2F/g, '/')}`).join('&');
  });
}

// ---------- wybór misji z backendem ----------
async function setupMissions(apiBase) {
  try {
    const list = await (await fetch(`${apiBase}/api/missions`, { cache: 'no-store' })).json();
    if (!list.missions || list.missions.length < 2) return;
    const select = $('missionSel');
    select.replaceChildren(...list.missions.map((m) => new Option(m.label?.[lang] || m.id, m.id, false, m.id === list.active)));
    select.hidden = false;
    select.addEventListener('change', async () => {
      select.disabled = true;
      const res = await fetch(`${apiBase}/api/missions/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: select.value }) });
      if (res.ok) location.reload(); else { select.disabled = false; alert(t('mission.error')); }
    });
  } catch { /* brak listy misji — zostaje jedna */ }
}

// ---------- przełączanie widoków ----------
function selectView(view) {
  if (director.playing) director.stop();
  app.setView(view);
}
$('viewSeg').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (button && !button.disabled) selectView(button.dataset.view);
});

function applyView(v) {
  document.querySelectorAll('#viewSeg button').forEach((b) => {
    const on = b.dataset.view === v || (v === 'drive' && b.dataset.view === 'orbit');
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  const is3d = VIEWS_3D.includes(v), isMap = v === 'map';
  $('view3d').classList.toggle('on', is3d);
  $('hud').hidden = v !== 'helmet';
  $('view3dLabel').hidden = v !== 'orbit';
  $('view3dLabel').textContent = t('view3d.label', { x: view3d?.exOrbit ?? 10 });
  $('device').hidden = v !== 'device';
  $('report').hidden = v !== 'report';
  $('schedule').hidden = v !== 'schedule';
  $('mapTools').hidden = !isMap;
  if (!isMap) { $('obsForm').hidden = true; app.state.reportMode = false; $('reportBtn').classList.remove('on'); $('main').classList.remove('reporting'); }
  if (v === 'report') report.open();
  if (v === 'schedule') schedule.open();
  if (view3d && is3d) view3d.setMode(v);
  else if (is3d) ensureView3D().catch((e) => console.error(e));
}
app.on('view', applyView);
app.on('reset', () => applyView(app.state.view));

// ---------- prezentacja ----------
$('demoBtn').addEventListener('click', () => {
  if (director.playing) director.stop(); else director.play();
});
app.on('director', (on) => { $('demoBtn').textContent = on ? t('demo.stop') : t('demo.play'); });

// ---------- punkt trasy z widokiem: render terenu z poziomu gruntu ----------
app.on('waypoint', async ({ wp }) => {
  if (!wp.view) return;
  const route = app.state.route;
  try { await ensureView3D(); } catch { return; }
  if (app.state.route !== route) return;
  const heading = route.poly.heading(route.wpS[app.m.waypoints.indexOf(wp)] - 6);
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
  const warn = $('hudWarn');
  const message = h.warn || (h.zone === 2 ? t('hud.nogo') : h.zone === 1 ? t('hud.caution') : null);
  warn.hidden = !message;
  if (message) { warn.textContent = message; warn.classList.toggle('caution', !h.warn && h.zone === 1); }
  $('hudHelp').hidden = h.timelapse > 1;
}

// ---------- pętla klatek ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  app.update(dt);
  const v = app.state.view;
  if (v === 'map') map.render(dt);
  else if (VIEWS_3D.includes(v) && view3d) { view3d.render(dt); if (v === 'helmet') updateHud(); }
  if (app.drive) driveHud.update();
  else if (v === 'device') device.update();
  panels.update();
  eva.update();
  profile.update();
  setHidden($('net'), !app.offline);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
applyView('map');
if (query.has('demo')) director.play();
