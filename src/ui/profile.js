// Profil trasy: wysokość terenu wzdłuż trasy, strefy „uwaga”, punkty trasy i bieżąca pozycja załogi.
// Najechanie kursorem pokazuje odczyt w tym miejscu i zaznacza je na mapie (state.probe).
import { $, esc, setHidden, setText } from '../core/dom.js';
import { num, int } from '../core/format.js';
import { t } from '../i18n.js';

const W = 596, H = 132;                          // rozmiar wykresu w pikselach ekranu projektowego
const PAD = { left: 34, right: 10, top: 16, bottom: 18 };
const PIXEL_RATIO = 2;                           // zapas rozdzielczości: ekran jest skalowany do okna
const MAX_SAMPLES = 600;
const MIN_SPAN_M = 12;                           // najmniejszy zakres osi wysokości (płaska trasa nie wygląda jak góry)
const FONT = "10px 'JetBrains Mono', Consolas, monospace";
const COLOR = { line: '#ffffff', walked: '#f28586', safe: 'rgba(255,255,255,.09)', caution: 'rgba(255,194,77,.42)', grid: '#2a2117', text: '#8d8a84', route: '#ffdc52' };

export class RouteProfile {
  constructor(app) {
    this.app = app;
    this.el = $('profile');
    this.btn = $('profileBtn');
    this.open = false;
    this.data = null;
    this.drawnKey = null;
    this.hoverS = null;
    this.el.innerHTML = `<div class="pf-head"><b id="pfTitle"></b><span id="pfStats"></span><span class="pf-read" id="pfRead"></span></div>
      <canvas width="${W * PIXEL_RATIO}" height="${H * PIXEL_RATIO}" role="img" aria-label="${esc(t('profile.aria'))}"></canvas>
      <div class="pf-legend"><span><i style="background:${COLOR.caution}"></i>${esc(t('profile.caution'))}</span>
        <span><i style="background:${COLOR.walked}"></i>${esc(t('profile.walked'))}</span><span>${esc(t('profile.hint'))}</span></div>`;
    this.canvas = this.el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.btn.addEventListener('click', () => this.toggle());
    this.canvas.addEventListener('mousemove', (e) => this.#hover(e));
    this.canvas.addEventListener('mouseleave', () => this.#hover(null));
    app.on('route', () => { this.data = null; this.sync(); });
    for (const evt of ['view', 'drive', 'reset']) app.on(evt, () => this.sync());
  }

  toggle(on = !this.open) {
    this.open = on;
    this.sync();
  }

  sync() {
    const app = this.app, available = !!app.state.route && app.state.view === 'map';
    setHidden(this.btn, !available);
    const shown = this.open && available && !app.drive && !app.state.caption;
    setHidden(this.el, !shown);
    this.btn.classList.toggle('on', this.open && available);
    this.btn.setAttribute('aria-expanded', String(this.open && available));
    if (!shown) { this.#setProbe(null); this.drawnKey = null; }
  }

  /** Co klatkę: przerysowuje wykres tylko wtedy, gdy zmieniła się trasa, pozycja załogi albo wskazany punkt. */
  update() {
    const app = this.app, route = app.state.route;
    if (this.el.hidden !== !(this.open && route && app.state.view === 'map' && !app.drive && !app.state.caption)) this.sync();
    if (this.el.hidden || !route) return;
    this.data ||= this.#sample(route);
    const key = `${route.letter}|${route.version ?? ''}|${Math.round(app.sim.crewS)}|${this.hoverS === null ? '' : Math.round(this.hoverS)}`;
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    this.#draw(route);
  }

  #sample(route) {
    const { terrain, rasters } = this.app.world, poly = route.poly;
    const n = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(poly.length / terrain.cell) + 1));
    const s = new Float32Array(n), h = new Float32Array(n), slope = new Float32Array(n), zone = new Uint8Array(n);
    let up = 0, down = 0, maxSlope = 0, cautionM = 0;
    for (let i = 0; i < n; i++) {
      s[i] = poly.length * i / (n - 1);
      const p = poly.at(s[i]);
      h[i] = terrain.height(p.x, p.y);
      slope[i] = terrain.slope(p.x, p.y);
      zone[i] = rasters.hazards ? rasters.hazards.sample(p.x, p.y) : 0;
      maxSlope = Math.max(maxSlope, slope[i]);
      if (i > 0) {
        const dh = h[i] - h[i - 1];
        if (dh > 0) up += dh; else down -= dh;
        if (zone[i] === 1) cautionM += s[i] - s[i - 1];
      }
    }
    let lo = Math.min(...h), hi = Math.max(...h);
    if (hi - lo < MIN_SPAN_M) { const mid = (hi + lo) / 2; lo = mid - MIN_SPAN_M / 2; hi = mid + MIN_SPAN_M / 2; }
    setText($('pfTitle'), t('profile.title', { l: route.letter }));
    setText($('pfStats'), t('profile.stats', { up: int(up), down: int(down), deg: int(maxSlope), c: int(cautionM) }));
    return { n, s, h, slope, zone, lo, hi, length: poly.length };
  }

  #x(s) { return PAD.left + (W - PAD.left - PAD.right) * s / (this.data.length || 1); }
  #y(h) { const d = this.data; return H - PAD.bottom - (H - PAD.top - PAD.bottom) * (h - d.lo) / (d.hi - d.lo); }

  #draw(route) {
    const ctx = this.ctx, d = this.data, base = H - PAD.bottom, crewS = this.app.sim.crewS;
    ctx.setTransform(PIXEL_RATIO, 0, 0, PIXEL_RATIO, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = FONT;

    // osie: wysokość z lewej, odległość u dołu
    ctx.fillStyle = COLOR.text; ctx.strokeStyle = COLOR.grid; ctx.lineWidth = 1;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const h of [d.lo, (d.lo + d.hi) / 2, d.hi]) {
      const y = Math.round(this.#y(h)) + 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
      ctx.fillText(int(h), PAD.left - 5, y);
    }
    const tick = d.length > 1600 ? 500 : d.length > 700 ? 200 : 100;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let s = 0; s <= d.length; s += tick) ctx.fillText(s === 0 ? '0' : `${s} m`, this.#x(s), base + 5);

    // wypełnienie pod krzywą: kolor strefy zagrożeń w tym miejscu trasy
    for (let i = 1; i < d.n; i++) {
      ctx.fillStyle = d.zone[i] === 1 ? COLOR.caution : COLOR.safe;
      ctx.beginPath();
      ctx.moveTo(this.#x(d.s[i - 1]), base); ctx.lineTo(this.#x(d.s[i - 1]), this.#y(d.h[i - 1]));
      ctx.lineTo(this.#x(d.s[i]), this.#y(d.h[i])); ctx.lineTo(this.#x(d.s[i]), base);
      ctx.fill();
    }
    const curve = (from, to, color, width) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < d.n; i++) {
        if (d.s[i] < from || d.s[i] > to) continue;
        ctx.lineTo(this.#x(d.s[i]), this.#y(d.h[i]));
      }
      ctx.stroke();
    };
    curve(0, d.length, COLOR.line, 1.5);
    if (crewS > 0) curve(0, crewS, COLOR.walked, 2.5);

    // punkty trasy
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    route.wpS.forEach((s, i) => {
      const x = Math.round(this.#x(s)) + 0.5;
      ctx.strokeStyle = COLOR.route; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, PAD.top - 2); ctx.lineTo(x, base); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLOR.route;
      ctx.fillText(route.wpIds[i] ?? '', Math.min(W - PAD.right - 12, Math.max(PAD.left + 12, x)), 2);
    });

    // załoga i wskazany punkt
    const dot = (s, fill, stroke) => {
      const x = this.#x(s), y = this.#y(this.#heightAt(s));
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = stroke; ctx.stroke();
    };
    if (this.app.state.crewVisible) dot(Math.min(crewS, d.length), '#fff', '#f17778');
    if (this.hoverS !== null) {
      const x = Math.round(this.#x(this.hoverS)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, base); ctx.stroke();
      dot(this.hoverS, '#000', '#fff');
    }
  }

  #index(s) { const d = this.data; return Math.min(d.n - 1, Math.max(0, Math.round(s / (d.length || 1) * (d.n - 1)))); }
  #heightAt(s) { return this.data.h[this.#index(s)]; }

  #hover(e) {
    if (!e || !this.data) { this.hoverS = null; this.#setProbe(null); setText($('pfRead'), ''); return; }
    const r = this.canvas.getBoundingClientRect(), d = this.data;
    const x = (e.clientX - r.left) / r.width * W;
    this.hoverS = Math.min(d.length, Math.max(0, (x - PAD.left) / (W - PAD.left - PAD.right) * d.length));
    const i = this.#index(this.hoverS);
    setText($('pfRead'), t('profile.read', { s: int(this.hoverS), h: num(d.h[i], 1), deg: int(d.slope[i]) }) + (d.zone[i] === 1 ? ` · ${t('profile.caution')}` : ''));
    this.#setProbe(this.app.state.route.poly.at(this.hoverS));
  }

  #setProbe(p) { this.app.state.probe = p; }
}
