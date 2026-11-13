// Tekst paneli nad widokiem 3D dopasowany do tła: na jasnym (niebo, jasny piasek, ściany habitatu) — czarny,
// na ciemnym — biały. Kilka razy na sekundę klatka WebGL jest zmniejszana do 96×40 px i dla każdego panelu
// liczona jest średnia jasność obrazu pod nim. Wynik trafia do atrybutu data-bg="light" | "dark" (style w helmet.css).
const PANELS = [
  '#hud .visor-id', '#hud .visor-compass', '#hud .visor-nav', '#hud .visor-motion', '#hud .visor-summary',
  '#hud .visor-warning', '#hud .visor-help', '#rideHud', '#habHud', '#driveHud', '#caption',
];
const W = 96, H = 40, EVERY_MS = 250;
// próg ok. 0,18 to punkt, w którym czarny i biały tekst mają równy kontrast; wyżej, bo panel ma jeszcze lekko
// przyciemniające tło. Histereza: panel nie miga na granicy.
const LIGHT_ON = 0.3, LIGHT_OFF = 0.22;

/** Jasność względna sRGB (0…1) koloru 0…255. */
function luminance(r, g, b) {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export class Backdrop {
  /** @param {HTMLCanvasElement} glCanvas płótno WebGL (czytane tuż po renderze, więc bez preserveDrawingBuffer) */
  constructor(glCanvas) {
    this.gl = glCanvas;
    this.small = document.createElement('canvas');
    this.small.width = W; this.small.height = H;
    this.ctx = this.small.getContext('2d', { willReadFrequently: true });
    this.last = 0;
    this.els = null;
  }

  /** Poza widokiem 3D (mapa 2D): panele wracają do zwykłego wyglądu. */
  clear() {
    if (!this.els) return;
    for (const el of this.els) if (el.dataset.bg) delete el.dataset.bg;
    this.last = 0;
  }

  /** Wołać zaraz po renderze klatki. */
  sample(now = performance.now()) {
    if (now - this.last < EVERY_MS) return;
    this.last = now;
    const cr = this.gl.getBoundingClientRect();
    if (cr.width < 2 || cr.height < 2) return;
    this.els ||= PANELS.flatMap((s) => [...document.querySelectorAll(s)]);
    const visible = this.els.filter((el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed');
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
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; sum += luminance(img[i], img[i + 1], img[i + 2]); n++; }
      const L = sum / n, was = el.dataset.bg === 'light';
      const light = was ? L > LIGHT_OFF : L > LIGHT_ON;
      const v = light ? 'light' : 'dark';
      if (el.dataset.bg !== v) el.dataset.bg = v;
    }
  }
}
