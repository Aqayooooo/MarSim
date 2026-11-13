// Jazda łazikiem po wyznaczonej trasie (◎ Wyznacz trasę → ▶ Jedź łazikiem).
// Prędkość: nominalna z misji (rover.speedKmh), wolniej pod górę, w strefach „uwaga” i w ciasnych zakrętach.
// Przyspieszenie czasu ×1…×200.
//
// Skręt jak w prawdziwym pojeździe: trasa z A* (schodki co 45°) jest najpierw wygładzana, a kurs łazika
// nie przeskakuje na kierunek odcinka, tylko obraca się z prędkością kątową modelu rowerowego
// ω = v / L · tan(δ), gdzie L to rozstaw osi, a δ skręt kół ograniczony do DRIVE_MAX_STEER.
// Kierunek celu wybiera „pure pursuit”: punkt na trasie kilka metrów przed łazikiem.
import { Polyline, headingDeg } from './path.js';

export const DRIVE_SPEEDS = [1, 5, 20, 50, 200];
export const DRIVE_WHEELBASE = 4;          // m, jak w ręcznej jeździe (NASA SEV)
export const DRIVE_MAX_STEER = 32;         // °, skręt kół przednich
const DRIVE_LOOKAHEAD = 6;                 // m, punkt docelowy pure pursuit
const LAT_ACCEL = 0.6;                     // m/s², bezpieczne przyspieszenie boczne w zakręcie (0,38 g, luźny grunt)
const STEER_RATE = 40;                     // °/s, jak szybko kierowca kręci kołami

/** Równe odstępy co `step` metrów (A* daje punkty co 1 m po schodkach). */
export function resample(pts, step) {
  const poly = new Polyline(pts);
  if (poly.length < step * 2) return pts.map((p) => ({ x: p.x, y: p.y }));
  const out = [];
  const n = Math.max(2, Math.round(poly.length / step));
  for (let i = 0; i <= n; i++) out.push(poly.at(poly.length * i / n));
  return out;
}

/** Ścinanie narożników (Chaikin); końce zostają na miejscu. */
export function chaikin(pts, iterations = 3) {
  let p = pts;
  for (let k = 0; k < iterations && p.length > 2; k++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

/** Trasa, po której łazik faktycznie jedzie: bez schodków siatki A*, z łukami zamiast ostrych narożników. */
export function smoothPath(path) {
  if (path.length < 3) return path.map((p) => ({ x: p.x, y: p.y }));
  return chaikin(resample(path, 3), 3);
}

const wrap = (d) => ((d % 360) + 540) % 360 - 180;

export class Drive {
  /**
   * @param {{x:number,y:number}[]} path
   * @param {{terrain:any, hazards:any, speedKmh:number}} env
   */
  constructor(path, { terrain, hazards, speedKmh }) {
    this.poly = new Polyline(smoothPath(path));
    this.terrain = terrain;
    this.hazards = hazards;
    this.baseMs = speedKmh / 3.6;
    this.s = 0;               // przejechane metry
    this.t = 0;               // czas jazdy (sekundy misji)
    this.timeScale = 1;
    this.running = false;
    this.done = false;
    this.speedMs = 0;
    this.yaw = this.poly.heading(Math.min(4, this.length / 2));   // kurs nadwozia (°), startuje w kierunku trasy
    this.steer = 0;           // skręt kół (°, + w prawo)
    this.curveK = this.#curvature();
  }

  get length() { return this.poly.length; }
  get remaining() { return Math.max(0, this.length - this.s); }
  pos() { return this.poly.at(this.s); }
  /** Kurs nadwozia łazika (0° = północ). */
  heading() { return this.yaw; }

  /** Krzywizna trasy co 2 m (1/m), do zwalniania przed zakrętem. */
  #curvature() {
    const n = Math.max(1, Math.ceil(this.length / 2)), k = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const s = i * 2, h0 = this.poly.heading(s - 2), h1 = this.poly.heading(s + 2);
      k[i] = Math.abs(wrap(h1 - h0)) * Math.PI / 180 / 4;
    }
    return k;
  }
  #maxCurvAhead(s, ahead) {
    let m = 0;
    for (let x = s; x <= s + ahead; x += 2) m = Math.max(m, this.curveK[Math.min(this.curveK.length - 1, Math.max(0, Math.round(x / 2)))]);
    return m;
  }

  /** Prędkość w punkcie trasy: pod górę wolniej (do 40% na 25°), w strefie „uwaga” 60%, w zakręcie v ≤ √(a·R). */
  speedAt(s) {
    const a = this.poly.at(s), b = this.poly.at(s + 3);
    const rise = this.terrain.height(b.x, b.y) - this.terrain.height(a.x, a.y);
    const grade = Math.atan2(rise, 3) * 180 / Math.PI;                       // + pod górę, − w dół
    let k = grade > 0 ? Math.max(0.4, 1 - grade / 40) : Math.max(0.7, 1 + grade / 60);
    if (this.hazards.sample(a.x, a.y) === 1) k *= 0.6;
    let v = this.baseMs * k;
    const curv = this.#maxCurvAhead(s, 8);
    if (curv > 1e-3) v = Math.min(v, Math.max(this.baseMs * 0.3, Math.sqrt(LAT_ACCEL / curv)));
    return v;
  }

  /** Szacowany czas do celu (sekundy misji) przy obecnym terenie przed łazikiem. */
  etaS() {
    let t = 0;
    for (let s = this.s; s < this.length; s += 10) t += Math.min(10, this.length - s) / this.speedAt(s);
    return t;
  }

  /** Kierownica: pure pursuit do punktu przed łazikiem, skręt kół ograniczony, kurs z modelu rowerowego. */
  #steerStep(h, ds) {
    const p = this.pos(), q = this.poly.at(this.s + DRIVE_LOOKAHEAD);
    const dist = Math.hypot(q.x - p.x, q.y - p.y);
    if (dist < 0.5) return;
    const alpha = wrap(headingDeg(q.x - p.x, q.y - p.y) - this.yaw) * Math.PI / 180;
    // pure pursuit: δ = atan(2 L sin α / Ld)
    let want = Math.abs(alpha) > Math.PI / 2 ? Math.sign(alpha) * DRIVE_MAX_STEER   // cel za łazikiem: pełny skręt
      : Math.atan2(2 * DRIVE_WHEELBASE * Math.sin(alpha), dist) * 180 / Math.PI;
    want = Math.max(-DRIVE_MAX_STEER, Math.min(DRIVE_MAX_STEER, want));
    const maxD = STEER_RATE * h;
    this.steer += Math.max(-maxD, Math.min(maxD, want - this.steer));
    this.yaw = (this.yaw + (ds / DRIVE_WHEELBASE) * Math.tan(this.steer * Math.PI / 180) * 180 / Math.PI + 360) % 360;
  }

  step(dt) {
    if (!this.running || this.done) { this.speedMs = 0; return; }
    let left = dt * this.timeScale;                   // sekundy misji w tej klatce, w krokach ≤ 0,25 s
    while (left > 0 && !this.done) {
      const h = Math.min(0.25, left);
      this.speedMs = this.speedAt(this.s);
      const ds = this.speedMs * h;
      this.s += ds;
      this.t += h;
      left -= h;
      this.#steerStep(h, ds);
      if (this.s >= this.length) { this.s = this.length; this.done = true; this.running = false; }
    }
  }

  restart() { this.s = 0; this.t = 0; this.done = false; this.running = true; this.steer = 0; this.yaw = this.poly.heading(Math.min(4, this.length / 2)); }
  faster(dir) {
    const i = DRIVE_SPEEDS.indexOf(this.timeScale);
    this.timeScale = DRIVE_SPEEDS[Math.max(0, Math.min(DRIVE_SPEEDS.length - 1, (i < 0 ? 0 : i) + dir))];
  }
}
