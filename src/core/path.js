// Narzędzia do linii łamanych w metrach: długości, punkt na odległości, przycinanie.
export function cumulative(pts) {
  const d = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) d[i] = d[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return d;
}

export class Polyline {
  constructor(points) {
    this.pts = points;
    this.cum = cumulative(points);
    this.length = this.cum[this.cum.length - 1] || 0;
  }
  /** Indeks odcinka zawierającego odległość s. */
  seg(s) {
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= s) lo = m; else hi = m; }
    return lo;
  }
  at(s) {
    if (this.pts.length === 0) return { x: 0, y: 0 };
    if (s <= 0) return { ...this.pts[0] };
    if (s >= this.length) return { ...this.pts[this.pts.length - 1] };
    const i = this.seg(s), a = this.pts[i], b = this.pts[i + 1];
    const t = (s - this.cum[i]) / (this.cum[i + 1] - this.cum[i] || 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  /** Kierunek ruchu w s jako kurs (0° = północ, zgodnie z ruchem wskazówek zegara). */
  heading(s, dir = 1) {
    const a = this.at(s - 4 * dir), b = this.at(s + 4 * dir);
    return headingDeg(b.x - a.x, b.y - a.y);
  }
  slice(s0, s1) {
    s0 = Math.max(0, s0); s1 = Math.min(this.length, s1);
    if (s1 <= s0) return [];
    const out = [this.at(s0)];
    for (let i = 0; i < this.pts.length; i++) if (this.cum[i] > s0 && this.cum[i] < s1) out.push(this.pts[i]);
    out.push(this.at(s1));
    return out;
  }
  /** Odległość wzdłuż linii do punktu najbliższego p. */
  project(p) {
    let best = Infinity, bestS = 0;
    for (let i = 0; i < this.pts.length - 1; i++) {
      const a = this.pts[i], b = this.pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
      const qx = a.x + dx * t, qy = a.y + dy * t, d = Math.hypot(p.x - qx, p.y - qy);
      if (d < best) { best = d; bestS = this.cum[i] + t * Math.sqrt(L2); }
    }
    return bestS;
  }
}

export function headingDeg(dx, dy) {
  return (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
}
