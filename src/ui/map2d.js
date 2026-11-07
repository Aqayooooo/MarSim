// Mapa 2D na canvasie: zdjęcie, nakładki 6 warstw, trasa, załoga, łazik, strefy, etykiety.
// Rysuje w układzie 972 × 648 px (obszar główny z nagrania); skala okna jest uwzględniana przez k.
import { t as tr } from '../i18n.js';
export const MAIN_W = 972, MAIN_H = 648;
const MONO = "700 15px 'JetBrains Mono', Consolas, monospace";
const ROUTE = '#FFDC52', TRAIL = '#F28586', ACCENT = '#F17778';   // ACCENT/TRAIL = --accent/--trail w styles.css
const PICK = '#5EE6D0';                                            // własna trasa (Dijkstra)
export const ALT_COLORS = { chosen: ROUTE, straight: '#FF5A4A', shortest: '#FFA94D', strict: '#7FB2FF' };
// krycie warstwy, gdy nie jest bieżąca (wyróżniona): zgodnie z obrazem końcowym z nagrania
const DIM = { optical: 1, terrain: 1, thermal: 0.08, minerals: 0.5, sand: 0.55, boulders: 1, hazards: 0.75, comms: 0.7, shadow: 1, sky: 1 };
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function ramp(t) { // luźny piasek (niebieski) → żółty → lita skała (pomarańczowy)
  const s = [[0, [32, 70, 156]], [0.55, [232, 212, 77]], [1, [237, 95, 38]]];
  for (let i = 1; i < s.length; i++) if (t <= s[i][0]) {
    const [a, ca] = s[i - 1], [b, cb] = s[i], u = (t - a) / (b - a);
    return ca.map((c, k) => Math.round(c + (cb[k] - c) * u));
  }
  return s[s.length - 1][1];
}

export class Map2D {
  constructor(canvas, app) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.app = app;
    const t = app.world.terrain;
    this.W = t.widthM; this.H = t.heightM;
    this.ps = Math.max(MAIN_W / this.W, MAIN_H / this.H);           // px na metr
    this.ox = (MAIN_W - this.W * this.ps) / 2;
    this.oy = (MAIN_H - this.H * this.ps) / 2;
    this.alpha = Object.fromEntries(app.m.layers.map((l) => [l.id, 0]));
    this.k = 1;
    this.#buildLayerCanvases();
    this.#makeTiles();
    this.wind = Array.from({ length: 110 }, () => ({ x: Math.random() * this.W, y: Math.random() * this.H, l: 0.7 + Math.random() * 0.6 }));
    app.on('reset', () => { this.#makeTiles(); for (const id in this.alpha) this.alpha[id] = 0; });
  }

  sx(x) { return this.ox + x * this.ps; }
  sy(y) { return this.oy + y * this.ps; }

  resize(scale) {
    const dpr = window.devicePixelRatio || 1;
    this.k = scale * dpr;
    this.c.width = Math.round(MAIN_W * this.k);
    this.c.height = Math.round(MAIN_H * this.k);
    // rozmyte strefy zagrożeń w rozdzielczości ekranu
    const hz = document.createElement('canvas');
    hz.width = this.c.width; hz.height = this.c.height;
    const g = hz.getContext('2d');
    g.filter = `blur(${7 * this.k}px)`;
    g.drawImage(this.hazCanvas, this.ox * this.k, this.oy * this.k, this.W * this.ps * this.k, this.H * this.ps * this.k);
    this.hazBlur = hz;
    const sb = document.querySelector('#scale .bar');
    if (sb) sb.style.width = `${100 * this.ps}px`;
  }

  #makeTiles() {
    this.tiles = [];
    for (let j = 0; j < 4; j++) for (let i = 0; i < 6; i++) this.tiles.push({ i, j, d: 0.2 + Math.random() * 0.7 });
  }

  #canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }

  #buildLayerCanvases() {
    const { terrain, rasters } = this.app.world;
    // nachylenie: jaśniej = bardziej stromo
    {
      const [c, g] = this.#canvas(terrain.w, terrain.hgt), im = g.createImageData(terrain.w, terrain.hgt);
      for (let k = 0; k < terrain.slopeGrid.length; k++) {
        const a = clamp01((terrain.slopeGrid[k] - 3) / 20);
        im.data.set([255, 248, 236, Math.round(a * 215)], k * 4);
      }
      g.putImageData(im, 0, 0);
      this.slopeCanvas = c;
    }
    // zagrożenia: klasy 1/2 → bursztyn/czerwień
    {
      const R = rasters.hazards, cls = R.meta.classes;
      const [c, g] = this.#canvas(R.width, R.height), im = g.createImageData(R.width, R.height);
      const col = { 1: hexToRgb(cls[1].color), 2: hexToRgb(cls[2].color) };
      for (let k = 0; k < R.data.length; k++) {
        const v = R.data[k];
        if (v) im.data.set([...col[v], v === 2 ? 105 : 80], k * 4);
      }
      g.putImageData(im, 0, 0);
      this.hazCanvas = c;
    }
    // piasek: prawdopodobieństwo (bursztyn), kreskowanie tam, gdzie pewność wykrycia jest niska
    if (rasters.sand) {
      const R = rasters.sand, C = rasters.sandConfidence;
      const sc = 2, [c, g] = this.#canvas(R.width * sc, R.height * sc), im = g.createImageData(R.width * sc, R.height * sc);
      for (let j = 0; j < R.height * sc; j++) for (let i = 0; i < R.width * sc; i++) {
        const k = ((j / sc) | 0) * R.width + ((i / sc) | 0), p = R.data[k] / 255, conf = C ? C.data[k] / 255 : 1;
        if (p < 0.3) continue;
        const hatch = conf < 0.4 && (i + j) % 6 < 2;
        im.data.set(hatch ? [60, 45, 25, 200] : [232, 177, 58, Math.round(clamp01((p - 0.3) / 0.5) * 170)], (j * R.width * sc + i) * 4);
      }
      g.putImageData(im, 0, 0);
      this.sandCanvas = c;
    }
    // łączność: brak zasięgu (czerwony), na granicy (żółty)
    if (rasters.comms) {
      const R = rasters.comms, [c, g] = this.#canvas(R.width, R.height), im = g.createImageData(R.width, R.height);
      for (let k = 0; k < R.data.length; k++) {
        const v = R.data[k];
        if (v === 0) im.data.set([192, 57, 43, 120], k * 4);
        else if (v === 1) im.data.set([241, 196, 15, 110], k * 4);
      }
      g.putImageData(im, 0, 0);
      this.commsCanvas = c;
    }
    this.shadowCanvases = {};
  }

  #shadowCanvas(hour) {
    const sh = this.app.world.rasters.shadow;
    if (!sh) return null;
    const h = sh.hours.reduce((a, b) => (Math.abs(b - hour) < Math.abs(a - hour) ? b : a));
    if (!this.shadowCanvases[h]) {
      const R = sh.hourly[h], [c, g] = this.#canvas(R.width, R.height), im = g.createImageData(R.width, R.height);
      for (let k = 0; k < R.data.length; k++) if (R.data[k] > 127) im.data.set([18, 14, 40, 190], k * 4);
      g.putImageData(im, 0, 0);
      this.shadowCanvases[h] = c;
    }
    return this.shadowCanvases[h];
  }

  /** Granica powrotu pieszego: komórki, z których zapas O₂ (ponad rezerwę) wystarcza na dojście do habitatu. */
  #walkbackCanvas(budgetL) {
    const R = this.app.world.rasters.o2ToHabitat;
    if (!R) return null;
    const key = Math.round(budgetL / 2);
    if (this.wbKey === key) return this.wbCanvas;
    const [c, g] = this.wbCanvas && this.wbCanvas.width === R.width ? [this.wbCanvas, this.wbCanvas.getContext('2d')] : this.#canvas(R.width, R.height);
    const im = g.createImageData(R.width, R.height), W = R.width, d = R.data;
    for (let j = 1; j < R.height - 1; j++) for (let i = 1; i < W - 1; i++) {
      const k = j * W + i, v = d[k];
      if (v >= 9000) continue;                                   // strefa zakazana — osobna warstwa
      if (v > budgetL) { im.data.set([0, 0, 0, 90], k * 4); continue; }
      const out = (n) => d[n] > budgetL && d[n] < 9000;          // granica tylko tam, gdzie kończy się tlen
      if (out(k - 1) || out(k + 1) || out(k - W) || out(k + W)) im.data.set([120, 230, 255, 255], k * 4);
    }
    g.putImageData(im, 0, 0);
    this.wbKey = key; this.wbCanvas = c;
    return c;
  }

  // ---------- rysowanie ----------
  render(dt) {
    const app = this.app, st = app.state, now = app.now, ctx = this.ctx;
    for (const l of app.m.layers) {
      const target = st.layers[l.id].on ? 1 : 0;
      const a = this.alpha[l.id];
      this.alpha[l.id] = a < target ? Math.min(target, a + dt / 0.3) : Math.max(target, a - dt / 0.3);
    }
    const A = (id) => this.alpha[id] * (st.focus === id ? 1 : DIM[id]);

    ctx.setTransform(this.k, 0, 0, this.k, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, MAIN_W, MAIN_H);
    this.#optical(now);
    this.#imageLayer(this.slopeCanvas, A('terrain'), true);
    this.#thermal(A('thermal'));
    if (this.app.world.rasters.minerals) this.#minerals(A('minerals'));
    if (this.sandCanvas && A('sand') > 0) this.#imageLayer(this.sandCanvas, A('sand'), false);
    if (A('hazards') > 0) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = A('hazards'); ctx.drawImage(this.hazBlur, 0, 0); ctx.restore(); }
    if (this.commsCanvas && A('comms') > 0) this.#imageLayer(this.commsCanvas, A('comms'), false);
    if (A('shadow') > 0) { const sc = this.#shadowCanvas(app.shadowHour); if (sc) this.#imageLayer(sc, A('shadow'), false); }
    if (A('boulders') > 0) this.#boulders(A('boulders'));
    this.#wind(dt, A('sky'));
    ctx.globalAlpha = 1;
    this.#walkback();
    this.#emergency();

    this.#shelter(now);
    this.#search(now);
    for (const d of st.discarded) this.#line(d, { color: 'rgba(228,226,220,.85)', width: 2.2, dash: [10, 7] });
    this.#alternatives();
    this.#route(now);
    for (const o of st.obstacles) this.#obstacle(o, now);
    this.#trail();
    this.#markers(now);
    this.#pick();
  }

  // własna trasa (◎ Wyznacz trasę): start, cel i ścieżka z algorytmu Dijkstry
  #pick() {
    const p = this.app.state.pick, ctx = this.ctx;
    if (!p?.start) return;
    if (p.path) this.#line(p.path, { color: PICK, width: 3.5, outline: 'rgba(0,0,0,.7)' });
    for (const [pt, lbl] of [[p.start, tr('pick.startLbl')], [p.end, tr('pick.endLbl')]]) {
      if (!pt) continue;
      const x = this.sx(pt.x), y = this.sy(pt.y);
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#000'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = PICK; ctx.stroke();
      this.#label(lbl, x + 12, y - 18);
    }
  }

  #optical(now) {
    const L = this.app.state.layers.optical, img = this.app.world.rasters.optical.image, ctx = this.ctx;
    if (!L.on) { if (this.alpha.optical > 0) { ctx.globalAlpha = this.alpha.optical; ctx.drawImage(img, this.ox, this.oy, this.W * this.ps, this.H * this.ps); ctx.globalAlpha = 1; } return; }
    const t = now - L.changedAt, tw = MAIN_W / 6, th = MAIN_H / 4;
    const sx = img.naturalWidth / (this.W * this.ps), sy = img.naturalHeight / (this.H * this.ps);
    for (const tile of this.tiles) {
      const a = clamp01((t - tile.d) / 0.12);
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      const dx = tile.i * tw, dy = tile.j * th;
      ctx.drawImage(img, (dx - this.ox) * sx, (dy - this.oy) * sy, tw * sx, th * sy, dx, dy, tw, th);
    }
    ctx.globalAlpha = 1;
  }

  #imageLayer(canvas, a, smooth) {
    if (a <= 0) return;
    const ctx = this.ctx;
    ctx.globalAlpha = a;
    ctx.imageSmoothingEnabled = smooth;
    ctx.drawImage(canvas, this.ox, this.oy, this.W * this.ps, this.H * this.ps);
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 1;
  }

  #thermal(a) {
    if (a <= 0) return;
    const R = this.app.world.rasters.thermal, ctx = this.ctx, c = R.cellM * this.ps;
    ctx.globalAlpha = a * 0.5;
    for (let j = 0; j < R.height; j++) for (let i = 0; i < R.width; i++) {
      const [r, g, b] = ramp(R.data[j * R.width + i] / 255);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(this.ox + i * c + 0.5, this.oy + j * c + 0.5, c - 1, c - 1);
    }
    ctx.globalAlpha = 1;
  }

  #minerals(a) {
    if (a <= 0) return;
    const R = this.app.world.rasters.minerals, ctx = this.ctx, c = R.cellM * this.ps, cls = R.meta.classes;
    for (let j = 0; j < R.height; j++) for (let i = 0; i < R.width; i++) {
      const v = R.data[j * R.width + i];
      if (!v) continue;
      if (!cls[v]) continue;
      ctx.globalAlpha = a * 0.5;
      ctx.fillStyle = cls[v].color;
      ctx.fillRect(this.ox + i * c, this.oy + j * c, c, c);
    }
    ctx.globalAlpha = 1;
  }

  #boulders(a) {
    const B = this.app.world.rasters.boulders?.boulders;
    if (!B) return;
    const ctx = this.ctx;
    ctx.lineWidth = 1.2;
    for (const b of B) {
      const r = Math.max(2, b.diameterM / 2 * this.ps * 1.6);
      ctx.globalAlpha = a * (b.confidence >= 0.5 ? 0.95 : 0.45);
      ctx.strokeStyle = b.confidence >= 0.5 ? '#E6BE79' : '#8a7660';
      ctx.beginPath(); ctx.arc(this.sx(b.x), this.sy(b.y), r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  #walkback() {
    const snap = this.app.sim.snap;
    if (!snap || !this.app.state.crewVisible || !snap.crew?.length) return;
    const avail = Math.min(...snap.crew.map((c) => c.walkback.availL));
    const c = this.#walkbackCanvas(Math.max(0, avail));
    if (!c) return;
    this.#imageLayer(c, 0.9, false);
  }

  #emergency() {
    const e = this.app.sim.snap?.emergency;
    if (!e || !this.app.state.crewVisible || !this.app.sim.running) return;
    if (e.habitat) this.#line(e.habitat.path, { color: 'rgba(120,230,255,.95)', width: 2, dash: [4, 5] });
    if (e.rover) this.#line(e.rover.path, { color: 'rgba(241,119,120,.9)', width: 2, dash: [2, 5] });
  }

  #wind(dt, a) {
    if (a <= 0) return;
    const ctx = this.ctx, d = Math.SQRT1_2, v = this.app.state.wind * 9;   // przyspieszone wizualnie
    ctx.strokeStyle = '#A7E9FB';
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    for (const p of this.wind) {
      p.x += v * d * dt; p.y += v * d * dt;
      if (p.x > this.W) p.x -= this.W; if (p.y > this.H) p.y -= this.H;
      const x = this.sx(p.x), y = this.sy(p.y), L = 20 * p.l;
      ctx.globalAlpha = a * 0.6;
      ctx.beginPath(); ctx.moveTo(x - L * d, y - L * d); ctx.lineTo(x, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  #pathTo(pts) {
    const ctx = this.ctx;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(this.sx(p.x), this.sy(p.y)) : ctx.moveTo(this.sx(p.x), this.sy(p.y))));
  }
  #line(pts, { color, width, dash = [], outline = null }) {
    if (pts.length < 2) return;
    const ctx = this.ctx;
    ctx.lineJoin = 'round'; ctx.lineCap = dash.length ? 'butt' : 'round';
    if (outline) { this.#pathTo(pts); ctx.setLineDash([]); ctx.strokeStyle = outline; ctx.lineWidth = width + 3; ctx.stroke(); }
    this.#pathTo(pts);
    ctx.setLineDash(dash);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    ctx.setLineDash([]);
  }

  #alternatives() {
    const st = this.app.state, alts = st.route?.alternatives;
    if (!st.altOpen || !alts || st.view !== 'map') return;
    for (const a of alts) {
      if (a.id === 'chosen' || !a.path?.length) continue;
      const hi = st.altHi === a.id;
      this.#line(a.path, { color: ALT_COLORS[a.id], width: hi ? 4 : 2.4, dash: a.verdict === 'unsafe' ? [9, 6] : [3, 5], outline: hi ? 'rgba(0,0,0,.7)' : null });
    }
  }

  #route(now) {
    const st = this.app.state, r = st.route;
    if (!r) return;
    const p = clamp01((now - r.draw.t0) / (r.draw.dur || 1e-6));
    if (now < r.draw.t0) return;
    const end = r.draw.s0 + (r.poly.length - r.draw.s0) * p;
    const from = this.app.sim.running || this.app.sim.crewS > 0 ? this.app.sim.crewS : 0;
    this.#line(r.poly.slice(from, end), { color: ROUTE, width: 3.5, outline: 'rgba(20,12,4,.75)' });
  }

  #trail() {
    const r = this.app.state.route, s = this.app.sim.crewS;
    if (!r || s <= 0) return;
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    this.#pathTo(r.poly.slice(0, s));
    ctx.setLineDash([0.1, 8]);
    ctx.strokeStyle = TRAIL; ctx.lineWidth = 4; ctx.stroke();
    ctx.setLineDash([]);
  }

  #search(now) {
    const s = this.app.state.search;
    if (!s) return;
    const t = (now - s.t0) / s.dur;
    if (t > 1.3) return;
    const n = Math.floor(s.pts.length * clamp01(t)), a = t > 1 ? 1 - (t - 1) / 0.3 : 1, ctx = this.ctx;
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = 0.8 * a;
    for (let i = 0; i < n; i++) { const p = s.pts[i]; ctx.beginPath(); ctx.arc(this.sx(p.x), this.sy(p.y), 1.4, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1;
  }

  #obstacle(o, now) {
    const a = clamp01((now - o.t0 - 0.1) / 0.3), ctx = this.ctx;
    if (a <= 0) return;
    const x = this.sx(o.x), y = this.sy(o.y), r = o.radiusM * this.ps;
    ctx.globalAlpha = a;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fill();
    ctx.setLineDash([6, 5]); ctx.strokeStyle = '#E6BE79'; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
    this.#label(o.label, x + r * 0.72 + 4, y - r * 0.72 - 10, a);
    ctx.globalAlpha = 1;
  }

  #shelter(now) {
    const sh = this.app.state.shelter;
    if (!sh) return;
    const a = clamp01((now - sh.t0) / 0.3), ctx = this.ctx;
    if (a <= 0) return;
    const c = this.app.sim.roverPos(), x = this.sx(c.x), y = this.sy(c.y), r = sh.radiusM * this.ps;
    ctx.globalAlpha = a;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(110,170,215,.16)'; ctx.fill();
    ctx.setLineDash([8, 6]); ctx.strokeStyle = 'rgba(175,228,248,.9)'; ctx.lineWidth = 1.6; ctx.stroke(); ctx.setLineDash([]);
    ctx.font = MONO;
    const w = ctx.measureText(sh.label).width + 10;
    const lx = x + r + 6 + w < MAIN_W - 8 ? x + r + 6 : x - r - 6 - w;
    this.#label(sh.label, lx, Math.min(MAIN_H - 110, Math.max(20, y)), a);
    ctx.globalAlpha = 1;
  }

  #label(text, x, y, a = 1) {
    const ctx = this.ctx;
    ctx.font = MONO;
    const w = ctx.measureText(text).width;
    ctx.globalAlpha = a;
    ctx.fillStyle = '#000';
    ctx.fillRect(x, y - 13, w + 10, 26);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 5, y + 1);
    ctx.globalAlpha = 1;
  }

  #diamond(x, y, filled) {
    const ctx = this.ctx, s = 8;
    ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath();
    ctx.fillStyle = filled ? ROUTE : '#000'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = ROUTE; ctx.stroke();
  }

  #markers(now) {
    const app = this.app, st = app.state, sim = app.sim, ctx = this.ctx;
    const optOn = st.layers.optical.on && now - st.layers.optical.changedAt > 1.04;
    // punkty trasy
    if (st.route && now >= st.route.draw.t0) {
      app.m.waypoints.forEach((wp, i) => {
        const s = st.route.wpS[i];
        if (st.route.draw.s0 === 0 && s > st.route.poly.length * clamp01((now - st.route.draw.t0) / (st.route.draw.dur || 1e-6)) + 1) return;
        const reached = st.reached[wp.id] !== undefined;
        const x = this.sx(wp.x), y = this.sy(wp.y);
        if (reached && i === sim.reached.length - 1) {
          const ph = ((now - st.reached[wp.id]) % 1.4) / 1.4;
          ctx.globalAlpha = 1 - ph; ctx.strokeStyle = ROUTE; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(x, y, 12 + 38 * ph, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
        }
        this.#diamond(x, y, reached);
        this.#label(wp.id, x + 12, y - 18);
      });
    }
    // habitat i nadajniki UWB
    const hab = app.m.habitat;
    if (hab && (optOn || st.route)) {
      const x = this.sx(hab.x), y = this.sy(hab.y);
      ctx.fillStyle = '#e8e2d8'; ctx.fillRect(x - 9, y - 9, 18, 18);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.strokeRect(x - 9, y - 9, 18, 18);
      ctx.font = MONO;
      this.#label(tr('map.habitat'), x - 14 - ctx.measureText(tr('map.habitat')).width - 10, y + 2);
    }
    // elipsy błędu pozycji (UWB / odometria)
    if (st.crewVisible && app.sim.snap) for (const c of app.sim.snap.crew) {
      if (!c.est) continue;
      ctx.save(); ctx.translate(this.sx(c.est.x), this.sy(c.est.y)); ctx.rotate(-(c.est.ellipse.angleDeg || 0) * Math.PI / 180);
      ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.ellipse(0, 0, Math.max(3, c.est.ellipse.a * this.ps * 3), Math.max(3, c.est.ellipse.b * this.ps * 3), 0, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.restore();
    }
    // łazik
    if (optOn || st.route) {
      const p = sim.roverPos(), x = this.sx(p.x), y = this.sy(p.y);
      ctx.fillStyle = ACCENT; ctx.fillRect(x - 8, y - 7, 16, 14);
      const w = (ctx.font = MONO, ctx.measureText(tr('map.rover')).width + 10);
      this.#label(tr('map.rover'), x - w / 2, y + 26);
    }
    // załoga
    if (st.crewVisible && st.route) {
      const ids = sim.crew.map((c) => c.id);
      const pos = ids.map((_, i) => sim.crewPos(i));
      for (let i = pos.length - 1; i >= 0; i--) {
        const x = this.sx(pos[i].x), y = this.sy(pos[i].y);
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = ACCENT; ctx.stroke();
      }
      const lead = pos[0];
      this.#label(ids.join(' '), this.sx(lead.x) + 14, this.sy(lead.y) + 14);
    }
  }
}
