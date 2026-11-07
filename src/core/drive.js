// Jazda łazikiem po wyznaczonej trasie (◎ Wyznacz trasę → ▶ Jedź łazikiem).
// Prędkość: nominalna z misji (rover.speedKmh), wolniej pod górę i w strefach „uwaga”. Przyspieszenie czasu ×1…×200.
import { Polyline } from './path.js';

export const DRIVE_SPEEDS = [1, 5, 20, 50, 200];

export class Drive {
  /**
   * @param {{x:number,y:number}[]} path
   * @param {{terrain:any, hazards:any, speedKmh:number}} env
   */
  constructor(path, { terrain, hazards, speedKmh }) {
    this.poly = new Polyline(path);
    this.terrain = terrain;
    this.hazards = hazards;
    this.baseMs = speedKmh / 3.6;
    this.s = 0;               // przejechane metry
    this.t = 0;               // czas jazdy (sekundy misji)
    this.timeScale = 1;
    this.running = false;
    this.done = false;
    this.speedMs = 0;
  }

  get length() { return this.poly.length; }
  get remaining() { return Math.max(0, this.length - this.s); }
  pos() { return this.poly.at(this.s); }
  heading() { return this.poly.heading(Math.min(Math.max(this.s, 4), this.length - 4)); }

  /** Prędkość w punkcie trasy: pod górę wolniej (do 40% na 25°), w strefie „uwaga” 60%. */
  speedAt(s) {
    const a = this.poly.at(s), b = this.poly.at(s + 3);
    const rise = this.terrain.height(b.x, b.y) - this.terrain.height(a.x, a.y);
    const grade = Math.atan2(rise, 3) * 180 / Math.PI;                       // + pod górę, − w dół
    let k = grade > 0 ? Math.max(0.4, 1 - grade / 40) : Math.max(0.7, 1 + grade / 60);
    if (this.hazards.sample(a.x, a.y) === 1) k *= 0.6;
    return this.baseMs * k;
  }

  /** Szacowany czas do celu (sekundy misji) przy obecnym terenie przed łazikiem. */
  etaS() {
    let t = 0;
    for (let s = this.s; s < this.length; s += 10) t += Math.min(10, this.length - s) / this.speedAt(s);
    return t;
  }

  step(dt) {
    if (!this.running || this.done) { this.speedMs = 0; return; }
    let left = dt * this.timeScale;                   // sekundy misji w tej klatce, w krokach ≤ 1 s
    while (left > 0 && !this.done) {
      const h = Math.min(1, left);
      this.speedMs = this.speedAt(this.s);
      this.s += this.speedMs * h;
      this.t += h;
      left -= h;
      if (this.s >= this.length) { this.s = this.length; this.done = true; this.running = false; }
    }
  }

  restart() { this.s = 0; this.t = 0; this.done = false; this.running = true; }
  faster(dir) {
    const i = DRIVE_SPEEDS.indexOf(this.timeScale);
    this.timeScale = DRIVE_SPEEDS[Math.max(0, Math.min(DRIVE_SPEEDS.length - 1, (i < 0 ? 0 : i) + dir))];
  }
}
