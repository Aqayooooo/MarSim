// Tekst paneli nad widokiem 3D w kolorze odwrotnym do obrazu pod panelem, zmieniający się płynnie.
// Co ~120 ms klatka WebGL jest zmniejszana do 96×40 px; dla każdego panelu liczony jest średni kolor tła
// (z uwzględnieniem półprzezroczystego tła samego panelu), z niego kolor docelowy tekstu (textColorFor),
// a w każdej klatce bieżący kolor dąży do docelowego wykładniczo (ease) — bez skoków czerń/biel.
// Wynik: zmienne CSS --hud-fg (tekst) i --hud-halo (text-shadow) oraz atrybut data-adapt (style w helmet.css).
const PANELS = [
  '#hud .visor-compass', '#hud .visor-nav', '#hud .visor-motion', '#hud .visor-summary',
  '#hud .visor-warning', '#hud .visor-help', '#rideHud', '#habHud', '#driveHud', '#caption',
];
const W = 96, H = 40;
export const TUNING = {
  everyMs: 120,     // co ile pomiar obrazu (łagodzenie koloru — w każdej klatce)
  mid: 0.42,        // jasność tła (L*/100), przy której tekst ma tę samą jasność — tam czytelność daje obwódka i barwa;
                    // poniżej środka, bo marsjański teren i niebo to zwykle L* 50–75 i tam tekst ma być wyraźnie ciemny
  k: 3,             // nachylenie odwrócenia jasności: l_t = mid − k·(l_bg − mid), obcięte do lMin…lMax
  lMin: 0.1, lMax: 0.97,   // nie do samej czerni/bieli, żeby została barwa odwrotna (granatowy tekst na rudym piasku)
  desat: 0.5,       // ile barwy odwróconej zabrać na rzecz szarości tej samej jasności (0 — pełna, 1 — szary)
  nearL: 0.25,      // gdy jasność tekstu i tła różni się mniej niż o tyle, barwa wraca liniowo do pełnej odwrotności
                    // (przy równej jasności czytelność daje już tylko kontrast barw)
  haloAt: 0.6,      // obwódka: jasność tekstu, przy której obwódka jest szara; ciemniejszy tekst — jaśniejsza obwódka
                    // (> mid, więc tam, gdzie tekst ma jasność tła, obwódka jest biała i go odcina)
  haloW: 0.1,       // szerokość liniowego przejścia obwódki z białej w czarną (w jasności tekstu)
  haloAlpha: 0.8,
  tau: 0.5,         // stała czasowa łagodzenia [s]
  tauReduced: 0.15, // przy prefers-reduced-motion
  hideSnapMs: 1000, // panel niewidoczny dłużej — po pojawieniu się kolor od razu, bez łagodzenia
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** sRGB 0…255 → liniowe 0…1. */
export const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
/** liniowe 0…1 → sRGB 0…255 (ułamkowe). */
export const toSrgb = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * clamp01(v) ** (1 / 2.4) - 0.055);
export const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;          // na liniowych
/** Jasność względna (0…1) koloru sRGB 0…255. */
export const luminance = (r, g, b) => lum(toLin(r), toLin(g), toLin(b));
// jasność percepcyjna L* / 100 z jasności względnej Y
export const lightness = (Y) => (Y > 216 / 24389 ? 1.16 * Math.cbrt(Y) - 0.16 : Y * 24389 / 2700);
/** Odwrotność lightness(). */
export const lumOf = (l) => (l > 0.08 ? ((l + 0.16) / 1.16) ** 3 : l * 2700 / 24389);
/** Współczynnik kontrastu WCAG między jasnościami względnymi. */
export const contrast = (Y1, Y2) => (Math.max(Y1, Y2) + 0.05) / (Math.min(Y1, Y2) + 0.05);

/**
 * Kolor tekstu dla tła sRGB (0…255). Barwa: odwrotność tła (255 − kanał), stonowana o desat.
 * Jasność: liniowe odwrócenie z rozciągnięciem kontrastu l_t = clamp(mid − k·(l_bg − mid), lMin, lMax), bez progów.
 * Zwraca { fg: [r,g,b] liniowe 0…1, halo: jasność obwódki 0…1 (liniowa Y), l: l_t }.
 */
export function textColorFor(r, g, b, o = TUNING) {
  const lBg = lightness(luminance(r, g, b));
  const l = Math.min(o.lMax, Math.max(o.lMin, o.mid - o.k * (lBg - o.mid)));
  const Y = lumOf(l);
  // odwrócona barwa w liniowym RGB: odchylenie kanałów od szarości tej samej luminancji (suma ważona = 0)
  const ir = toLin(255 - r), ig = toLin(255 - g), ib = toLin(255 - b), iy = lum(ir, ig, ib);
  const keep = 1 - o.desat * clamp01(Math.abs(l - lBg) / o.nearL);
  const dr = (ir - iy) * keep, dg = (ig - iy) * keep, db = (ib - iy) * keep;
  // skala barwy tak, by żaden kanał nie wyszedł poza 0…1 (luminancja zostaje dokładnie Y) — ciągła
  const lo = Math.min(dr, dg, db), hi = Math.max(dr, dg, db);
  let s = 1;
  if (lo < 0) s = Math.min(s, Y / -lo);
  if (hi > 0) s = Math.min(s, (1 - Y) / hi);
  const fg = [clamp01(Y + s * dr), clamp01(Y + s * dg), clamp01(Y + s * db)];
  const halo = lumOf(clamp01(0.5 + (o.haloAt - l) / o.haloW));
  return { fg, halo, l };
}

/** Wykładnicze dążenie cur → target po dt [s] ze stałą tau; nigdy nie przeskakuje celu. */
export function ease(cur, target, dt, tau) {
  if (!(dt > 0)) return cur;
  const a = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
  return cur + (target - cur) * a;
}

const css = (lin) => lin.map((v) => Math.round(toSrgb(v)));
const PROPS = ['--hud-fg', '--hud-halo'];

export class Backdrop {
  /** @param {HTMLCanvasElement} glCanvas płótno WebGL (czytane tuż po renderze, więc bez preserveDrawingBuffer) */
  constructor(glCanvas) {
    this.gl = glCanvas;
    this.small = document.createElement('canvas');
    this.small.width = W; this.small.height = H;
    this.ctx = this.small.getContext('2d', { willReadFrequently: true });
    this.last = 0;            // czas ostatniego pomiaru; 0 — poza widokiem 3D (main.js woła wtedy clear())
    this.prev = 0;            // czas poprzedniej klatki (do dt łagodzenia)
    this.state = new Map();   // panel → { fg, halo, tFg, tHalo, seen, out } ; panele mogą znikać i pojawiać się
    this.motion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  }

  /** Poza widokiem 3D (mapa 2D): panele wracają do zwykłego wyglądu. */
  clear() {
    for (const el of this.state.keys()) {
      for (const p of PROPS) el.style.removeProperty(p);
      el.removeAttribute('data-adapt');
    }
    this.state.clear();
    this.last = 0; this.prev = 0;
  }

  /** Wołać zaraz po renderze klatki. */
  sample(now = performance.now()) {
    const dt = this.prev ? Math.min(1, (now - this.prev) / 1000) : 0;
    this.prev = now;
    if (now - this.last >= TUNING.everyMs) this.#measure(now);
    const tau = this.motion?.matches ? TUNING.tauReduced : TUNING.tau;
    for (const [el, s] of this.state) {
      if (!el.isConnected) { this.state.delete(el); continue; }
      if (s.tFg) {
        for (let i = 0; i < 3; i++) s.fg[i] = ease(s.fg[i], s.tFg[i], dt, tau);
        s.halo = ease(s.halo, s.tHalo, dt, tau);
      }
      this.#write(el, s);
    }
  }

  #measure(now) {
    this.last = now;
    const cr = this.gl.getBoundingClientRect();
    if (cr.width < 2 || cr.height < 2) return;
    // za każdym razem od nowa: panele bywają usuwane i tworzone później
    const visible = PANELS.flatMap((s) => [...document.querySelectorAll(s)])
      .filter((el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed');
    if (!visible.length) return;
    let img;
    try {
      this.ctx.drawImage(this.gl, 0, 0, W, H);
      img = this.ctx.getImageData(0, 0, W, H).data;
    } catch { return; }
    for (const el of visible) {
      const r = el.getBoundingClientRect();
      const x0 = Math.max(0, Math.floor((r.left - cr.left) / cr.width * W)), x1 = Math.min(W, Math.ceil((r.right - cr.left) / cr.width * W));
      const y0 = Math.max(0, Math.floor((r.top - cr.top) / cr.height * H)), y1 = Math.min(H, Math.ceil((r.bottom - cr.top) / cr.height * H));
      if (x1 <= x0 || y1 <= y0) continue;
      // średnia w liniowym RGB (tak miesza światło), potem z powrotem do sRGB
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4; sr += toLin(img[i]); sg += toLin(img[i + 1]); sb += toLin(img[i + 2]); n++;
      }
      let bg = [toSrgb(sr / n), toSrgb(sg / n), toSrgb(sb / n)];
      bg = overlay(bg, getComputedStyle(el).backgroundColor);   // półprzezroczyste tło panelu (poza hełmem)
      const t = textColorFor(bg[0], bg[1], bg[2]);
      let s = this.state.get(el);
      if (!s || now - s.seen > TUNING.hideSnapMs) {   // pierwszy pomiar (wejście do 3D, nowy panel): od razu
        s = { fg: [...t.fg], halo: t.halo, out: null };
        this.state.set(el, s);
      }
      s.tFg = t.fg; s.tHalo = t.halo; s.seen = now;
    }
  }

  #write(el, s) {
    const [r, g, b] = css(s.fg), h = Math.round(toSrgb(s.halo));
    const o = s.out;
    if (o && Math.abs(o[0] - r) < 1 && Math.abs(o[1] - g) < 1 && Math.abs(o[2] - b) < 1 && Math.abs(o[3] - h) < 1) return;
    s.out = [r, g, b, h];
    const a = TUNING.haloAlpha;
    el.style.setProperty('--hud-fg', `rgb(${r} ${g} ${b})`);
    el.style.setProperty('--hud-halo', `0 1px 2px rgb(${h} ${h} ${h} / ${a}), 0 0 9px rgb(${h} ${h} ${h} / ${(a * 0.6).toFixed(2)})`);
    if (!el.hasAttribute('data-adapt')) el.setAttribute('data-adapt', '');
  }
}

/** Nałożenie koloru CSS rgb()/rgba() (tło panelu) na tło sRGB, jak przeglądarka (mieszanie w sRGB). */
function overlay(bg, cssColor) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?/.exec(cssColor || '');
  if (!m) return bg;
  let a = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (m[4]?.endsWith('%')) a /= 100;
  if (!(a > 0)) return bg;
  return bg.map((c, i) => c + (parseFloat(m[i + 1]) - c) * a);
}
