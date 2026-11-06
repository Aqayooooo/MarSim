// Mapa 2D na canvasie: zdjęcie, nakładki 6 warstw, trasa, załoga, łazik, strefy, etykiety.
// Rysuje w układzie 972 × 648 px (obszar główny z nagrania); skala okna jest uwzględniana przez k.
export const MAIN_W = 972, MAIN_H = 648;
const MONO = "700 15px 'JetBrains Mono', Consolas, monospace";
const ROUTE = '#FFDC52', TRAIL = '#FC8151', ACCENT = '#FF7B3F';
// krycie warstwy, gdy nie jest bieżąca (wyróżniona): zgodnie z obrazem końcowym z nagrania
const DIM = { optical: 1, terrain: 1, thermal: 0.08, minerals: 0.5, hazards: 0.75, sky: 1 };
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
    this.#minerals(A('minerals'));
    if (A('hazards') > 0) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = A('hazards'); ctx.drawImage(this.hazBlur, 0, 0); ctx.restore(); }
    this.#wind(dt, A('sky'));
    ctx.globalAlpha = 1;

    this.#shelter(now);
    this.#search(now);
    for (const d of st.discarded) this.#line(d, { color: 'rgba(228,226,220,.85)', width: 2.2, dash: [10, 7] });
    this.#route(now);
    for (const o of st.obstacles) this.#obstacle(o, now);
    this.#trail();
    this.#markers(now);
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
      ctx.globalAlpha = a * (v === 2 ? 0.42 : 0.55);
      ctx.fillStyle = cls[v].color;
      const pad = v === 2 ? 0 : 1;
      ctx.fillRect(this.ox + i * c + pad, this.oy + j * c + pad, c - 2 * pad, c - 2 * pad);
    }
    ctx.globalAlpha = 1;
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
    // łazik
    if (optOn || st.route) {
      const p = sim.roverPos(), x = this.sx(p.x), y = this.sy(p.y);
      ctx.fillStyle = ACCENT; ctx.fillRect(x - 8, y - 7, 16, 14);
      const w = (ctx.font = MONO, ctx.measureText('ŁAZIK').width + 10);
      this.#label('ŁAZIK', x - w / 2, y + 26);
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
