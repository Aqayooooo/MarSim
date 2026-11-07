// JEDYNE miejsce, w którym UI styka się z danymi.
// Tryb "files": pliki z katalogu (dane przykładowe albo wynik potoku zapisany na dysk) + planer zastępczy w przeglądarce.
// Tryb "http":  backend MarSim (python backend/server.py) — pliki misji, planowanie, strumień stanu EVA, raport, harmonogram.
// Wykrywanie: ?api=… albo, gdy strona jest serwowana przez backend, odpowiedź na /api/health.
// Bez backendu (np. GitHub Pages) tryb "files" czyta też przykładowe odpowiedzi backendu zapisane obok danych misji
// w <katalog>/backend/*.json (tools/export_backend_sample.py): raport, plan wyjść, pogoda kosmiczna, dziennik, trasa A.
import { Terrain, Raster } from '../core/terrain.js';
import { planRoute as mockPlan } from './mockPlanner.js';
import { makeRocks } from '../core/rocks.js';
import { decodePngGray } from '../core/png.js';

export const ROVER_CLEARANCE_M = 1.8;   // połowa długości łazika (1,6 m) + margines

// onload zamiast img.decode(): decode() potrafi nie zakończyć się w karcie działającej w tle
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Nie można wczytać ${url}`));
    img.src = url;
  });
}
// Warstwa danych z PNG: dekodowanie bajtów pliku (core/png.js), bo odczyt z canvasa bywa zaszumiony
// przez ochronę przed fingerprintingiem (tarcze Brave i in.). Canvas tylko awaryjnie (brak DecompressionStream).
async function grayRaster(u) {
  if (typeof DecompressionStream !== 'undefined') {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`Nie można wczytać ${u}`);
    return (await decodePngGray(await r.arrayBuffer())).data;
  }
  return grayFromImage(await loadImage(u));
}
function grayFromImage(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data, out = new Uint8Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
  return out;
}

export async function detectBackend(explicitApi) {
  if (explicitApi) return explicitApi.replace(/\/$/, '');
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (r.ok && (await r.json()).ok) return '';
  } catch { /* brak backendu — tryb plikowy */ }
  return null;
}

export function createDataSource({ mode = 'files', base = 'data/demo', api = '' } = {}) {
  const root = mode === 'http' ? `${api}/missions/current` : base.replace(/\/$/, '');
  const url = (f) => `${root}/${f}`;
  const API = (p) => `${api}/api/${p}`;
  let ctx = null;
  const json = async (r) => {
    if (!r.ok) {
      let msg = `${r.url}: ${r.status}`;
      try { const b = await r.json(); msg = b.error || (typeof b.detail === 'string' ? b.detail : msg); } catch { /* treść nie jest JSON */ }
      throw new Error(msg);
    }
    return r.json();
  };

  // przykładowe odpowiedzi backendu (tylko tryb plikowy); meta.json mówi, które pliki istnieją — bez zbędnych 404
  let meta = null;
  const samples = new Map();
  const getJson = (f) => fetch(url(f), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const sample = (name) => {
    if (mode === 'http') return Promise.resolve(null);
    meta ||= getJson('backend/meta.json');
    if (name === 'meta') return meta;
    if (!samples.has(name)) samples.set(name, meta.then((m) => (m?.files?.includes(name) ? getJson(`backend/${name}.json`) : null)));
    return samples.get(name);
  };
  const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 0.5;
  const samePlan = (req, start, waypoints, obstacles) => !!req && !obstacles.length && near(req.start, start)
    && req.waypoints.length === waypoints.length && req.waypoints.every((w, i) => w.id === waypoints[i].id && near(w, waypoints[i]));

  return {
    mode,
    api: API,
    sample,
    async loadMission() {
      const mission = await json(await fetch(url('mission.json'), { cache: 'no-store' }));
      if (![1, 2].includes(mission.contractVersion)) throw new Error(`Nieobsługiwana wersja kontraktu danych: ${mission.contractVersion}`);
      const f32 = async (meta) => new Float32Array(await (await fetch(url(meta.file))).arrayBuffer());
      const terrain = new Terrain({ heights: await f32(mission.dem), width: mission.dem.width, height: mission.dem.height, cellM: mission.dem.cellM });
      const rasters = {};
      const jobs = [];
      for (const l of mission.layers) {
        if (l.raster) jobs.push((async () => {
          rasters[l.id] = l.id === 'optical'           // zdjęcie tylko do wyświetlania — zwykły obraz
            ? { image: await loadImage(url(l.raster.file)), ...l.raster }
            : Object.assign(new Raster({ data: await grayRaster(url(l.raster.file)), width: l.raster.width, height: l.raster.height, cellM: l.raster.cellM }), { meta: l.raster });
          if (l.confidence) {
            rasters[`${l.id}Confidence`] = new Raster({ data: await grayRaster(url(l.confidence.file)), width: l.confidence.width, height: l.confidence.height, cellM: l.confidence.cellM });
          }
        })());
        if (l.vector) jobs.push((async () => { rasters[l.id] = await json(await fetch(url(l.vector.file))); })());
        if (l.hourly) jobs.push((async () => {
          const h = l.hourly, byHour = {};
          await Promise.all(h.hours.map(async (hr) => {
            byHour[hr] = new Raster({ data: await grayRaster(url(h.pattern.replace('{HH}', String(hr).padStart(2, '0')))), width: h.width, height: h.height, cellM: h.cellM });
          }));
          rasters[l.id] = { hourly: byHour, hours: h.hours };
        })());
      }
      for (const [k, meta] of Object.entries(mission.rasters || {})) {
        jobs.push((async () => { rasters[k] = new Raster({ data: await f32(meta), width: meta.width, height: meta.height, cellM: meta.cellM }); })());
      }
      await Promise.all(jobs);
      if (rasters.slope) terrain.slopeGrid = rasters.slope.data;     // nachylenie policzone przez potok (z niepewnością obok)
      ctx = { mission, terrain, rasters };
      return ctx;
    },

    /** Wyznacza trasę. Kształt odpowiedzi: docs/KONTRAKT_DANYCH.md, sekcja „Plan trasy”. */
    async planRoute({ start, waypoints, obstacles = [] }) {
      if (mode === 'http') {
        return json(await fetch(API('plan'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start, waypoints, obstacles }),
        }));
      }
      // to samo zapytanie co przy eksporcie: trasa policzona przez backend (Dijkstra na koszcie O₂) razem z wariantami
      const s = await sample('plan');
      if (s && samePlan(s.request, start, waypoints, obstacles)) return structuredClone(s.response);
      return mockPlan({ terrain: ctx.terrain, hazards: ctx.rasters.hazards, start, waypoints, obstacles, eva: ctx.mission.eva });
    },

    /** Trasa z dowolnego startu do dowolnego celu: czysty Dijkstra w przeglądarce (działa też bez serwera; nie zmienia stanu EVA). */
    planDijkstra({ start, end, obstacles = [] }) {
      const t0 = performance.now();
      ctx.rocks ||= makeRocks({ W: ctx.terrain.widthM, H: ctx.terrain.heightM, hazards: ctx.rasters.hazards, boulders: ctx.rasters.boulders });
      const r = mockPlan({ terrain: ctx.terrain, hazards: ctx.rasters.hazards, start, waypoints: [{ id: 'CEL', x: end.x, y: end.y }],
        obstacles, eva: ctx.mission.eva, heuristic: false, rocks: ctx.rocks, clearanceM: ROVER_CLEARANCE_M });
      return { ...r, ms: performance.now() - t0 };
    },

    // ---- tylko z backendem ----
    async post(path, body = {}) {
      return json(await fetch(API(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    },
    async get(path) { return json(await fetch(API(path), { cache: 'no-store' })); },
    async del(path) { return json(await fetch(API(path), { method: 'DELETE' })); },
    stream(onData) {
      const es = new EventSource(API('stream'));
      es.onmessage = (e) => onData(JSON.parse(e.data));
      return es;
    },
  };
}
