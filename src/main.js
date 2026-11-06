// Start aplikacji: wczytanie danych, złożenie widoków, pętla klatek.
// Parametry adresu: ?data=ścieżka/do/katalogu (domyślnie data/demo), ?api=http://backend (tryb backendu), ?demo (autostart prezentacji).
import { createDataSource } from './data/source.js';
import { App } from './app.js';
import { Panels } from './ui/panels.js';
import { Map2D } from './ui/map2d.js';
import { Director } from './demo.js';
import { num } from './core/format.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const q = new URLSearchParams(location.search);
const ds = createDataSource({ mode: q.get('api') ? 'http' : 'files', base: q.get('data') || 'data/demo', api: q.get('api') });

let world;
try {
  world = await ds.loadMission();
} catch (e) {
  $('loading').textContent = `Nie udało się wczytać danych: ${e.message}`;
  throw e;
}
$('loading').remove();

const app = new App(ds, world);
const panels = new Panels(app);
const map = new Map2D($('map'), app);
let view3d = null;
const director = new Director(app, () => view3d);
window.strata = { app, director, get view3d() { return view3d; } };   // do debugowania w konsoli

function fit() {
  const s = Math.min(innerWidth / 1664, innerHeight / 744);
  stage.style.transform = `translate(${(innerWidth - 1664 * s) / 2}px, ${(innerHeight - 744 * s) / 2}px) scale(${s})`;
  map.resize(s);
  view3d?.resize(s);
}
addEventListener('resize', fit);
fit();

// Widok 3D wczytuje się w tle (three.js z CDN), mapa 2D działa od razu.
document.querySelectorAll('#viewSeg button:not([data-view="map"])').forEach((b) => (b.disabled = true));
import('./ui/view3d.js').then(({ View3D }) => {
  view3d = new View3D($('view3d'), app);
  fit();
  document.querySelectorAll('#viewSeg button').forEach((b) => (b.disabled = false));
  if (app.state.view !== 'map') view3d.setMode(app.state.view);
}).catch((e) => console.error('Widok 3D niedostępny:', e));

// ---------- widoki ----------
$('viewSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (director.playing) director.stop();
  app.setView(b.dataset.view);
});
function applyView(v) {
  document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  $('view3d').classList.toggle('on', v !== 'map');
  $('hud').hidden = v !== 'helmet';
  $('view3dLabel').hidden = v !== 'orbit';
  $('view3dLabel').textContent = 'WIDOK 3D · PRZEWYŻSZENIE ×10';
  if (view3d && v !== 'map') view3d.setMode(v);
}
app.on('view', applyView);
app.on('reset', () => applyView(app.state.view));

// ---------- przyciski ----------
$('demoBtn').addEventListener('click', () => {
  if (director.playing) { director.stop(); return; }
  director.play();
});
app.on('director', (on) => { $('demoBtn').textContent = on ? '■ Zatrzymaj' : '▶ Prezentacja'; $('evaBtn').disabled = on; });

$('evaBtn').addEventListener('click', async () => {
  if (app.sim.running) { app.sim.running = false; $('evaBtn').textContent = 'Wznów EVA'; return; }
  if (app.state.route && app.sim.crewS > 0) { app.sim.running = true; $('evaBtn').textContent = 'Pauza EVA'; return; }
  for (const id of ['optical', 'terrain', 'hazards']) app.toggleLayer(id, true);
  app.setView('map');
  await app.planInitial({ animate: true });
  setTimeout(() => { app.startEva(470); $('evaBtn').textContent = 'Pauza EVA'; }, 3400);
});
app.on('reset', () => { $('evaBtn').textContent = 'Start EVA'; });

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
  $('hudTitle').textContent = `HEŁM ${crew.id}${h.timelapse > 1 ? ` · TIMELAPSE ×${h.timelapse}` : ''}`;
  $('hudHeading').textContent = `KURS ${String(h.heading).padStart(3, '0')}°`;
  $('hudDist').textContent = `DO ${h.target}: ${Math.round(h.dist)} M`;
  $('hudSpeed').textContent = `${num(h.speed, h.speed < 10 ? 1 : 0)} KM/H`;
  const mid = `O<span class="sub2">₂</span> ${Math.round(crew.o2)}% · NACHYLENIE ${Math.round(h.slope)}°`;
  if ($('hudMid').innerHTML !== mid) $('hudMid').innerHTML = mid;
  const w = $('hudWarn');
  const msg = h.warn || (h.zone === 2 ? 'STREFA ZAKAZANA: PIASEK / SKARPA' : h.zone === 1 ? 'UWAGA: NIERÓWNY TEREN' : null);
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
  if (app.state.view === 'map') map.render(dt);
  else if (view3d) { view3d.render(dt); if (app.state.view === 'helmet') updateHud(); }
  panels.update();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
applyView('map');
if (q.has('demo')) director.play();
