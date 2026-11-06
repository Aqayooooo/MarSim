// JEDYNE miejsce, w którym UI styka się z danymi.
// Tryb "files": pliki z katalogu (dane przykładowe albo wynik potoku zapisany na dysk) + planer zastępczy w przeglądarce.
// Tryb "http":  backend MarSim (python backend/server.py) — pliki misji, planowanie, strumień stanu EVA, raport, harmonogram.
// Wykrywanie: ?api=… albo, gdy strona jest serwowana przez backend, odpowiedź na /api/health.
import { Terrain, Raster } from '../core/terrain.js';
import { planRoute as mockPlan } from './mockPlanner.js';

// onload zamiast img.decode(): decode() potrafi nie zakończyć się w karcie działającej w tle
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Nie można wczytać ${url}`));
    img.src = url;
  });
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

  return {
    mode,
    api: API,
    async loadMission() {
      const mission = await json(await fetch(url('mission.json'), { cache: 'no-store' }));
      if (![1, 2].includes(mission.contractVersion)) throw new Error(`Nieobsługiwana wersja kontraktu danych: ${mission.contractVersion}`);
      const f32 = async (meta) => new Float32Array(await (await fetch(url(meta.file))).arrayBuffer());
      const terrain = new Terrain({ heights: await f32(mission.dem), width: mission.dem.width, height: mission.dem.height, cellM: mission.dem.cellM });
      const rasters = {};
      const jobs = [];
      for (const l of mission.layers) {
        if (l.raster) jobs.push((async () => {
          const img = await loadImage(url(l.raster.file));
          rasters[l.id] = l.id === 'optical'
            ? { image: img, ...l.raster }
            : Object.assign(new Raster({ data: grayFromImage(img), width: l.raster.width, height: l.raster.height, cellM: l.raster.cellM }), { meta: l.raster });
          if (l.confidence) {
            const ci = await loadImage(url(l.confidence.file));
            rasters[`${l.id}Confidence`] = new Raster({ data: grayFromImage(ci), width: l.confidence.width, height: l.confidence.height, cellM: l.confidence.cellM });
          }
        })());
        if (l.vector) jobs.push((async () => { rasters[l.id] = await json(await fetch(url(l.vector.file))); })());
        if (l.hourly) jobs.push((async () => {
          const h = l.hourly, byHour = {};
          await Promise.all(h.hours.map(async (hr) => {
            const img = await loadImage(url(h.pattern.replace('{HH}', String(hr).padStart(2, '0'))));
            byHour[hr] = new Raster({ data: grayFromImage(img), width: h.width, height: h.height, cellM: h.cellM });
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
      return mockPlan({ terrain: ctx.terrain, hazards: ctx.rasters.hazards, start, waypoints, obstacles, eva: ctx.mission.eva });
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
