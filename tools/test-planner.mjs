// Szybki test planera w Node (bez przeglądarki):  node tools/test-planner.mjs [katalog misji, domyślnie data/demo]
// Mapa zagrożeń jest czytana tym samym dekoderem PNG co w przeglądarce (src/core/png.js — odporny na tarcze Brave).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Terrain, Raster } from '../src/core/terrain.js';
import { planRoute } from '../src/data/mockPlanner.js';
import { decodePngGray } from '../src/core/png.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.resolve(ROOT, process.argv[2] || path.join('data', 'demo'));
const m = JSON.parse(fs.readFileSync(path.join(DIR, 'mission.json'), 'utf8'));
const demBuf = fs.readFileSync(path.join(DIR, m.dem.file));
const heights = new Float32Array(demBuf.buffer.slice(demBuf.byteOffset, demBuf.byteOffset + demBuf.byteLength));
const terrain = new Terrain({ heights, width: m.dem.width, height: m.dem.height, cellM: m.dem.cellM });

const hz = m.layers.find((l) => l.id === 'hazards').raster;
const png = await decodePngGray(fs.readFileSync(path.join(DIR, hz.file)));
if (png.width !== hz.width || png.height !== hz.height) { console.log('BŁĄD: wymiary', hz.file, png.width, png.height); process.exit(1); }
const badClass = png.data.filter((v) => v > 2).length;          // tak wyglądało zaszumienie canvasa w Brave
if (badClass) { console.log(`BŁĄD: ${badClass} komórek ${hz.file} poza klasami 0/1/2`); process.exit(1); }
const hazards = new Raster({ data: png.data, width: png.width, height: png.height, cellM: hz.cellM });

const t0 = performance.now();
const r = planRoute({ terrain, hazards, start: m.rover, waypoints: m.waypoints, eva: m.eva });
const ms = performance.now() - t0;
if (!r.ok) { console.log('BŁĄD', r.error); process.exit(1); }
let inForbidden = 0;
for (const p of r.path) if (hazards.sample(p.x, p.y) === 2) inForbidden++;
console.log(`czas ${ms.toFixed(0)} ms, punktów ${r.path.length}, długość ${r.lengthM.toFixed(0)} m, czas ${(r.durationH * 60).toFixed(0)} min, w strefie zakazu: ${inForbidden}, rozwinięte (próbka): ${r.expanded.length}`);
console.log('WP idx', r.waypointIndex, 'punkty WP', r.waypointIndex.map((i) => r.path[i]));
