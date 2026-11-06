// Szybki test planera w Node na danych przykładowych (bez przeglądarki).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Terrain, Raster } from '../src/core/terrain.js';
import { planRoute } from '../src/data/mockPlanner.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'demo');
const m = JSON.parse(fs.readFileSync(path.join(DIR, 'mission.json'), 'utf8'));
const demBuf = fs.readFileSync(path.join(DIR, m.dem.file));
const heights = new Float32Array(demBuf.buffer.slice(demBuf.byteOffset, demBuf.byteOffset + demBuf.byteLength));
const terrain = new Terrain({ heights, width: m.dem.width, height: m.dem.height, cellM: m.dem.cellM });

function readGrayPng(file) {
  const b = fs.readFileSync(path.join(DIR, file));
  let o = 8, w = 0, h = 0; const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8), data = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(raw.subarray(y * (w + 1) + 1, y * (w + 1) + 1 + w), y * w);
  return { data: out, width: w, height: h };
}
const hz = m.layers.find((l) => l.id === 'hazards').raster;
const hazards = new Raster({ ...readGrayPng(hz.file), cellM: hz.cellM });

const t0 = performance.now();
const r = planRoute({ terrain, hazards, start: m.rover, waypoints: m.waypoints, eva: m.eva });
const ms = performance.now() - t0;
if (!r.ok) { console.log('BŁĄD', r.error); process.exit(1); }
let inForbidden = 0;
for (const p of r.path) if (hazards.sample(p.x, p.y) === 2) inForbidden++;
console.log(`czas ${ms.toFixed(0)} ms, punktów ${r.path.length}, długość ${r.lengthM.toFixed(0)} m, czas ${(r.durationH * 60).toFixed(0)} min, w strefie zakazu: ${inForbidden}, rozwinięte (próbka): ${r.expanded.length}`);
console.log('WP idx', r.waypointIndex, 'punkty WP', r.waypointIndex.map((i) => r.path[i]));
