// Start aplikacji: wczytanie danych, złożenie widoków, pętla klatek.
// Parametry adresu: ?view=helmet (widok astronauty), ?data=ścieżka/do/katalogu, ?api=http://backend (tryb backendu), ?demo (autostart prezentacji), ?lang=en.
// Bez ?data= i bez backendu: domyślna misja z data/missions/index.json (dane NASA + przykładowe dane backendu), inaczej data/demo.
import { createDataSource, detectBackend } from './data/source.js';
import { DeviceView, ReportView, ScheduleView, FieldReports, RouteCompare, PathPicker, DriveHud } from './ui/views.js';
import { App } from './app.js';
import { Panels } from './ui/panels.js';
import { Map2D } from './ui/map2d.js';
import { RouteProfile } from './ui/profile.js';
import { EvaControls } from './ui/evaControls.js';
import { Help } from './ui/help.js';
import { HelmetHud } from './ui/helmetHud.js';
import { Director } from './demo.js';
import { Intro } from './ui/intro.js';
import { WaypointEditor } from './ui/wpEditor.js';
import { Sensitivity } from './ui/sensitivity.js';
import { $, setHidden } from './core/dom.js';
import { t, lang, setLang, applyStatic } from './i18n.js';

const STAGE_W = 1664, STAGE_H = 744, MAIN_W = 972, MAIN_H = 648;
const COMPACT_BELOW_PX = 900;            // węższe okno albo ekran w pionie: układ kolumnowy (telefon, tablet)
const VIEWS_3D = ['orbit', 'helmet', 'drive'];
const stage = $('stage');

let stageScale = 1, labelScale = 1, currentView = 'map';
const DOC_VIEWS = ['report', 'schedule', 'device'];
function fitStage() {
  const compact = innerWidth < COMPACT_BELOW_PX || innerHeight > innerWidth;
  stage.classList.toggle('compact', compact);
  document.documentElement.classList.toggle('compact', compact);
  if (!compact) {
    labelScale = 1;
    stage.style.removeProperty('--mh');
    stageScale = Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H);
    stage.style.transform = `translate(${(innerWidth - STAGE_W * stageScale) / 2}px, ${(innerHeight - STAGE_H * stageScale) / 2}px) scale(${stageScale})`;
    return;
  }
  // mapa / widok 3D na całą szerokość (z zachowaniem proporcji 3:2), panele pod spodem w zwykłej wielkości
  stage.style.transform = '';
  const width = document.documentElement.clientWidth - 16, height = innerHeight - $('hdr').offsetHeight - 24;
  stageScale = Math.max(0.2, Math.min(width / MAIN_W, height / MAIN_H, 1.2));
  labelScale = Math.min(2, Math.max(1, 0.72 / stageScale));   // napisy na mapie nie mniejsze niż ok. 72% wielkości
  stage.style.setProperty('--ms', stageScale);
  stage.style.setProperty('--uiz', labelScale);
  // raport, plan wyjść, urządzenie: wysoki obszar do czytania zamiast okienka o proporcjach mapy
  const docHeight = DOC_VIEWS.includes(currentView) ? Math.max(MAIN_H, height / stageScale) : MAIN_H;
  stage.style.setProperty('--mh', docHeight);
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
  world = await ds.loadMission({
    onProgress: (f) => { $('loadPct').textContent = `${Math.round(f * 100)}%`; $('loading').style.setProperty('--p', f); },
  });
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
const wpEditor = new WaypointEditor(app, map, { picker });
const sensitivity = new Sensitivity(app);
const driveHud = new DriveHud(app, () => view3d);
const profile = new RouteProfile(app);
const eva = new EvaControls(app, director);
const helmetHud = new HelmetHud(app);
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
const intro = new Intro(app, { play: () => director.play(), show: query.get('view') !== 'helmet' && !query.has('demo') });
$('introAgain').addEventListener('click', () => { help.toggle(false); selectView('map'); intro.open(); });
window.marsim = { app, director, map, panels, device, report, schedule, compare, picker, wpEditor, sensitivity, driveHud, profile, eva, help, intro, get view3d() { return view3d; } };   // do debugowania w konsoli

function fit() {
  fitStage();
  map.resize(stageScale, labelScale);
  view3d?.resize(stageScale);
  setHidden($('walkPad'), !(app.state.view === 'helmet' && matchMedia('(pointer: coarse)').matches));
}

// hełm na ekranie dotykowym: przytrzymanie przycisku = marsz (zamiast klawiszy W/S)
for (const b of $('walkPad').querySelectorAll('button')) {
  const keys = () => view3d?.helmet.keys;
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); keys()?.add(b.dataset.key); b.setPointerCapture(e.pointerId); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(type, () => keys()?.delete(b.dataset.key));
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
  currentView = v;
  document.querySelectorAll('#viewSeg button').forEach((b) => {
    const on = b.dataset.view === v || (v === 'drive' && b.dataset.view === 'orbit');
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  const is3d = VIEWS_3D.includes(v), isMap = v === 'map';
  stage.classList.toggle('helmet-mode', v === 'helmet');
  fit();
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

// ---------- pętla klatek ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  app.update(dt);
  const v = app.state.view;
  if (v === 'map') map.render(dt);
  else if (VIEWS_3D.includes(v) && view3d) { view3d.render(dt); if (v === 'helmet') helmetHud.update(view3d.hudInfo()); }
  if (app.drive) driveHud.update();
  else if (v === 'device') device.update();
  panels.update();
  eva.update();
  profile.update();
  setHidden($('net'), !app.offline);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
if (query.get('view') === 'helmet') app.setView('helmet');
else applyView('map');
if (query.has('demo')) director.play();
