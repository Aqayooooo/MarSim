// Generator danych przykładowych dla UI STRATA.
// Udaje backend: tworzy pliki w formacie opisanym w docs/KONTRAKT_DANYCH.md.
// Teren jest syntetyczny (szum + komórki „boxwork” + wydmy + skarpa), NIE pochodzi z NASA.
// Uruchomienie: node tools/generate-mock-data.mjs [katalog_wyjściowy]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'data', 'demo'));
fs.mkdirSync(OUT, { recursive: true });

// ---- siatka terenu ----
const DEM_W = 480, DEM_H = 320, CELL = 3;           // 1440 × 960 m
const WM = DEM_W * CELL, HM = DEM_H * CELL;
const OPT_W = 1440, OPT_H = 960;                    // zdjęcie 1 m/px

// ---- szum ----
function hash2(ix, iy, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(x, y, seed, oct = 5) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f, seed + i * 17); n += a; a *= 0.5; f *= 2; }
  return s / n;
}
function worley(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 9, f2 = 9;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = ix + i, cy = iy + j;
    const px = cx + hash2(cx, cy, seed), py = cy + hash2(cx, cy, seed + 101);
    const d = Math.hypot(px - x, py - y);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return [f1, f2];
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

// ---- elementy krajobrazu (współrzędne w metrach: x na wschód, y na południe) ----
const ROVER = { x: 350, y: 720 };
const WP = [{ id: 'WP1', x: 560, y: 470 }, { id: 'WP2', x: 985, y: 180 }];
const SAND = [
  { cx: 420, cy: 560, rx: 150, ry: 90 },
  { cx: 760, cy: 340, rx: 130, ry: 70 },
  { cx: 1160, cy: 730, rx: 210, ry: 120 },
  { cx: 140, cy: 260, rx: 120, ry: 160 },
];
function sandAt(x, y) {
  let s = 0;
  const warp = (fbm(x / 90, y / 90, 3) - 0.5) * 0.6;
  for (const e of SAND) {
    const d = Math.hypot((x - e.cx) / e.rx, (y - e.cy) / e.ry) + warp;
    s = Math.max(s, smooth(1.0, 0.75, d));
  }
  return s;
}
function scarpX(y) { return 900 + 50 * Math.sin(y / 120); }
function scarpAmp(y) { return 9 * (1 - smooth(230, 320, y)); }

function boxwork(x, y) {
  const wx = x + (fbm(x / 60, y / 60, 13) - 0.5) * 40, wy = y + (fbm(x / 60, y / 60, 14) - 0.5) * 40;
  const [f1, f2] = worley(wx / 48, wy / 48, 11);
  const breaks = smooth(0.3, 0.55, fbm(x / 35, y / 35, 15));
  const pitShape = f1 + (fbm(x / 9, y / 9, 16) - 0.5) * 0.45;
  return { ridge: (1 - smooth(0, 0.14, f2 - f1)) * breaks, pit: smooth(0.5, 0.15, pitShape) * smooth(0.35, 0.6, fbm(x / 80, y / 80, 17)) };
}

function heightAt(x, y) {
  const sand = sandAt(x, y), rock = 1 - sand;
  const bw = boxwork(x, y);
  let h = 0.006 * x - 0.010 * y + (fbm(x / 260, y / 260, 1) - 0.5) * 14;
  h += rock * (0.8 * bw.ridge - 0.9 * bw.pit);
  h += sand * (0.5 * Math.sin((x * 0.8 + y * 0.6) / 4 + fbm(x / 50, y / 50, 19) * 9) - 1.2);
  h += scarpAmp(y) * smooth(-7, 7, x - scarpX(y));
  return h;
}

// ---- DEM ----
console.log('DEM…');
const dem = new Float32Array(DEM_W * DEM_H);
let hmin = Infinity, hmax = -Infinity;
for (let j = 0; j < DEM_H; j++) for (let i = 0; i < DEM_W; i++) {
  const h = heightAt((i + 0.5) * CELL, (j + 0.5) * CELL);
  dem[j * DEM_W + i] = h; hmin = Math.min(hmin, h); hmax = Math.max(hmax, h);
}
for (let k = 0; k < dem.length; k++) dem[k] = +(dem[k] - hmin - 4300).toFixed(3); // wysokość względna do areoidy (umowna)
const demAt = (i, j) => dem[clamp(j, 0, DEM_H - 1) * DEM_W + clamp(i, 0, DEM_W - 1)];
function demBilinear(x, y) {
  const fx = x / CELL - 0.5, fy = y / CELL - 0.5;
  const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
  return demAt(i, j) * (1 - tx) * (1 - ty) + demAt(i + 1, j) * tx * (1 - ty) + demAt(i, j + 1) * (1 - tx) * ty + demAt(i + 1, j + 1) * tx * ty;
}

// ---- nachylenie i zagrożenia (to jest „interpretacja”, którą później zrobi backend) ----
console.log('zagrożenia…');
const slope = new Float32Array(DEM_W * DEM_H);
for (let j = 0; j < DEM_H; j++) for (let i = 0; i < DEM_W; i++) {
  const dx = (demAt(i + 1, j) - demAt(i - 1, j)) / (2 * CELL);
  const dy = (demAt(i, j + 1) - demAt(i, j - 1)) / (2 * CELL);
  slope[j * DEM_W + i] = Math.atan(Math.hypot(dx, dy)) * 180 / Math.PI;
}
const hazard = new Uint8Array(DEM_W * DEM_H);
for (let j = 0; j < DEM_H; j++) for (let i = 0; i < DEM_W; i++) {
  const x = (i + 0.5) * CELL, y = (j + 0.5) * CELL, k = j * DEM_W + i;
  const s = sandAt(x, y), sl = slope[k];
  let rough = 0;
  for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) rough = Math.max(rough, Math.abs(demAt(i + a, j + b) - dem[k]));
  hazard[k] = (s > 0.5 || sl > 22) ? 2 : (sl > 13 || s > 0.2 || rough > 1.3) ? 1 : 0;
}

// ---- zdjęcie „optyczne” 1 m/px ----
console.log('zdjęcie…');
const opt = new Uint8Array(OPT_W * OPT_H);
const L = (() => { const az = 315 * Math.PI / 180, alt = 35 * Math.PI / 180; return [Math.sin(az) * Math.cos(alt), -Math.cos(az) * Math.cos(alt), Math.sin(alt)]; })();
for (let y = 0; y < OPT_H; y++) for (let x = 0; x < OPT_W; x++) {
  const mx = x + 0.5, my = y + 0.5;
  const dx = (demBilinear(mx + 1, my) - demBilinear(mx - 1, my)) / 2 * 4;
  const dy = (demBilinear(mx, my + 1) - demBilinear(mx, my - 1)) / 2 * 4;
  const n = Math.hypot(dx, dy, 1);
  const shade = clamp((-dx * L[0] + -dy * L[1] + L[2]) / n, 0, 1);
  const sand = sandAt(mx, my), bw = boxwork(mx, my);
  const [g1, g2] = worley(mx / 7, my / 7, 23);
  let alb = 0.6 + 0.22 * (fbm(mx / 220, my / 220, 5) - 0.5) + 0.1 * (fbm(mx / 30, my / 30, 6) - 0.5)
    + 0.13 * bw.ridge - 0.3 * bw.pit - 0.06 * (1 - smooth(0, 0.08, g2 - g1)) * smooth(0.4, 0.7, fbm(mx / 40, my / 40, 8));
  const sandAlb = 0.28 + 0.05 * Math.sin((mx * 0.8 + my * 0.6) / 2 + fbm(mx / 50, my / 50, 19) * 18) + 0.08 * (fbm(mx / 25, my / 25, 9) - 0.5);
  alb = alb * (1 - sand) + sandAlb * sand;
  if (mx > scarpX(my) - 10 && my < 300) alb += 0.04;
  alb += (hash2(x, y, 77) - 0.5) * 0.09 + (vnoise(mx / 2.5, my / 2.5, 78) - 0.5) * 0.07;
  opt[y * OPT_W + x] = clamp(Math.round(255 * alb * (0.45 + 0.75 * shade)), 0, 255);
}

// ---- bezwładność termiczna (THEMIS ~100 m/px) ----
const TH_W = Math.ceil(WM / 100), TH_H = Math.ceil(HM / 100);
const thermal = new Uint8Array(TH_W * TH_H);
for (let j = 0; j < TH_H; j++) for (let i = 0; i < TH_W; i++) {
  let s = 0, n = 0;
  for (let b = 0; b < 100; b += 10) for (let a = 0; a < 100; a += 10) { const x = i * 100 + a + 5, y = j * 100 + b + 5; if (x < WM && y < HM) { s += sandAt(x, y); n++; } }
  const ti = 0.2 + 0.65 * (1 - s / n) + 0.15 * fbm(i / 3, j / 3, 31);
  thermal[j * TH_W + i] = clamp(Math.round(ti * 255), 0, 255);
}

// ---- minerały (CRISM ~18 m/px): 0 brak, 1 spoiwo grzbietów, 2 siarczany ----
const MN_C = 18, MN_W = Math.ceil(WM / MN_C), MN_H = Math.ceil(HM / MN_C);
const minerals = new Uint8Array(MN_W * MN_H);
for (let j = 0; j < MN_H; j++) for (let i = 0; i < MN_W; i++) {
  const x = (i + 0.5) * MN_C, y = (j + 0.5) * MN_C;
  let r = 0, n = 0;
  for (let b = -6; b <= 6; b += 4) for (let a = -6; a <= 6; a += 4) { r += boxwork(x + a, y + b).ridge; n++; }
  const sand = sandAt(x, y);
  let c = 0;
  if (sand < 0.3 && r / n > 0.3 && hash2(i, j, 41) > 0.35) c = 1;
  if (x > 930 && y < 470 && sand < 0.3 && fbm(x / 120, y / 120, 7) > 0.52) c = 2;
  minerals[j * MN_W + i] = c;
}

// ---- zapis PNG (8-bit, skala szarości) ----
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePng(file, w, h, gray) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; Buffer.from(gray.buffer, gray.byteOffset + y * w, w).copy(raw, y * (w + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(path.join(OUT, file), Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

fs.writeFileSync(path.join(OUT, 'dem.f32'), Buffer.from(dem.buffer));
writePng('optical.png', OPT_W, OPT_H, opt);
writePng('hazards.png', DEM_W, DEM_H, hazard);
writePng('thermal.png', TH_W, TH_H, thermal);
writePng('minerals.png', MN_W, MN_H, minerals);

// ---- opis misji ----
const mission = {
  contractVersion: 1,
  synthetic: true,
  mission: {
    id: 'eva-1',
    title: 'EVA-1 · trawers przez boxwork · krater Gale',
    sourceLabel: 'Dane przykładowe (syntetyczne)',
    sol: 147,
    startClock: '09:20',
  },
  area: {
    label: 'MT SHARP · BOXWORK · DEMO',
    widthM: WM, heightM: HM,
    note: 'Układ lokalny w metrach: x rośnie na wschód, y na południe, (0,0) = lewy górny róg.',
  },
  dem: { file: 'dem.f32', encoding: 'float32le', width: DEM_W, height: DEM_H, cellM: CELL, unit: 'm' },
  layers: [
    { id: 'optical', name: 'Optyczna', desc: 'HiRISE 25 cm/px', colorOff: '#45403F', colorOn: '#9F9F9E',
      raster: { file: 'optical.png', encoding: 'png-gray8', width: OPT_W, height: OPT_H, cellM: 1 },
      legend: [{ color: '#9F9F9E', text: 'HiRISE, grudzień 2006' }] },
    { id: 'terrain', name: 'Teren', desc: 'nachylenie z DTM', colorOff: '#65615B', colorOn: '#F8F0E2',
      derivedFrom: 'dem', legend: [{ color: '#F8F0E2', text: 'jaśniej = bardziej stromo' }] },
    { id: 'thermal', name: 'Termiczna', desc: 'THEMIS 100 m/px', colorOff: '#1C4753', colorOn: '#3AAFD7',
      raster: { file: 'thermal.png', encoding: 'png-gray8', width: TH_W, height: TH_H, cellM: 100, valueRange: [100, 600], unit: 'J m⁻² K⁻¹ s⁻½' },
      legend: [{ color: '#20469C', text: 'luźny piasek' }, { color: '#ED5F26', text: 'lita skała' }] },
    { id: 'minerals', name: 'Minerały', desc: 'CRISM 18 m/px', colorOff: '#48336D', colorOn: '#AD7EFF',
      raster: { file: 'minerals.png', encoding: 'png-class8', width: MN_W, height: MN_H, cellM: MN_C,
        classes: { 1: { color: '#AE7EFF', text: 'spoiwo grzbietów' }, 2: { color: '#31D7B6', text: 'skały z siarczanami' } } },
      legend: [{ color: '#31D7B6', text: 'skały z siarczanami' }, { color: '#AE7EFF', text: 'spoiwo grzbietów' }] },
    { id: 'hazards', name: 'Zagrożenia', desc: 'piasek, skarpy', colorOff: '#691C0B', colorOn: '#FF441F',
      raster: { file: 'hazards.png', encoding: 'png-class8', width: DEM_W, height: DEM_H, cellM: CELL,
        classes: { 1: { color: '#FFBD33', text: 'uwaga: nierówno' }, 2: { color: '#FD4420', text: 'zakaz: piasek, skarpy' } } },
      legend: [{ color: '#FD4420', text: 'zakaz: piasek, skarpy' }, { color: '#FFBD33', text: 'uwaga: nierówno' }] },
    { id: 'sky', name: 'Niebo', desc: 'RAD + MAVEN', colorOff: '#475E61', colorOn: '#A7E9FB',
      legend: [{ color: '#A7E9FB', text: 'wiatr 7 m/s z NW' }] },
  ],
  rover: { ...ROVER, speedKmh: 12 },
  waypoints: WP.map((w) => ({ ...w, stopMin: 15, target: w.id === 'WP2' ? 'cel próbki S-02' : null,
    view: w.id === 'WP2' ? { source: 'render', caption: 'Render z DTM · widok z hełmu' } : null })),
  crew: [
    { id: 'EV1', o2: 100, o2RatePctH: 12 },
    { id: 'EV2', o2: 100, o2RatePctH: 14 },
  ],
  eva: { walkKmh: 2.5, maxSlopeDeg: 25, o2ReservePct: 55, sepO2Factor: 1.25, shelterMin: 15, shelterRadiusM: 400 },
  environment: {
    doseUsvh: 27, dustTau: 0.52,
    wind: { meanMs: 7, spreadMs: 1, fromDeg: 315 },
    temperature: [['09:20', -41], ['11:30', -25], ['14:00', -18]],
  },
  events: [
    { id: 'boulders', type: 'obstacle', trigger: { afterWaypoint: 'WP1', afterM: 40 }, aheadM: 181, radiusM: 55,
      alert: { category: 'ZAGROŻENIE', text: 'Pole głazów na trasie, {dist} m przed nami' } },
    { id: 'sep', type: 'space-weather', source: 'DONKI', trigger: { afterEvent: 'boulders', afterMin: 3 },
      alert: { category: 'POGODA KOSMICZNA', text: 'ostrzeżenie SEP · łazik jedzie do załogi' } },
  ],
};
fs.writeFileSync(path.join(OUT, 'mission.json'), JSON.stringify(mission, null, 2));

let counts = [0, 0, 0]; for (const v of hazard) counts[v]++;
console.log('Zapisano do', OUT);
console.log('DEM', DEM_W, '×', DEM_H, 'zakres', (hmax - hmin).toFixed(1), 'm; zagrożenia 0/1/2 =', counts.join('/'));
