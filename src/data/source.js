// JEDYNE miejsce, w którym UI styka się z danymi.
// Tryb "files": czyta pliki z katalogu (dane przykładowe albo wynik backendu zapisany na dysk).
// Tryb "http":  te same pliki z serwera backendu + planowanie trasy przez POST {api}/plan.
// Reszta aplikacji używa tylko obiektu zwracanego przez createDataSource().
import { Terrain, Raster } from '../core/terrain.js';
import { planRoute as mockPlan } from './mockPlanner.js';

async function loadImage(url) {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return img;
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

export function createDataSource({ mode = 'files', base = 'data/demo', api = null } = {}) {
  const root = mode === 'http' ? `${api.replace(/\/$/, '')}/missions/current` : base.replace(/\/$/, '');
  const url = (f) => `${root}/${f}`;
  let ctx = null;

  return {
    mode,
    async loadMission() {
      const mission = await (await fetch(url('mission.json'), { cache: 'no-store' })).json();
      if (mission.contractVersion !== 1) throw new Error(`Nieobsługiwana wersja kontraktu danych: ${mission.contractVersion}`);
      const demBuf = await (await fetch(url(mission.dem.file))).arrayBuffer();
      const terrain = new Terrain({ heights: new Float32Array(demBuf), width: mission.dem.width, height: mission.dem.height, cellM: mission.dem.cellM });
      const rasters = {};
      await Promise.all(mission.layers.filter((l) => l.raster).map(async (l) => {
        const img = await loadImage(url(l.raster.file));
        rasters[l.id] = l.raster.encoding === 'png-gray8' && l.id === 'optical'
          ? { image: img, ...l.raster }
          : Object.assign(new Raster({ data: grayFromImage(img), width: l.raster.width, height: l.raster.height, cellM: l.raster.cellM }), { meta: l.raster });
      }));
      ctx = { mission, terrain, rasters };
      return ctx;
    },

    /** Wyznacza trasę. Kształt odpowiedzi: patrz docs/KONTRAKT_DANYCH.md, sekcja „Plan trasy”. */
    async planRoute({ start, waypoints, obstacles = [] }) {
      if (mode === 'http') {
        const r = await fetch(`${api.replace(/\/$/, '')}/plan`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ missionId: ctx.mission.mission.id, start, waypoints, obstacles }),
        });
        if (!r.ok) throw new Error(`Backend /plan: ${r.status}`);
        return r.json();
      }
      return mockPlan({ terrain: ctx.terrain, hazards: ctx.rasters.hazards, start, waypoints, obstacles, eva: ctx.mission.eva });
    },
  };
}
