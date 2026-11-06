// ZAŚLEPKA BACKENDU: planer trasy A* na siatce kosztów.
// Docelowo zastąpi go endpoint backendu POST /api/plan (patrz docs/KONTRAKT_DANYCH.md).
// Wejście i wyjście mają dokładnie ten kształt, który ma zwracać backend.
import { cumulative } from '../core/path.js';
import { routeStats } from '../core/routeStats.js';

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

/**
 * @param {object} req
 * @param {import('../core/terrain.js').Terrain} req.terrain
 * @param {import('../core/terrain.js').Raster} req.hazards  klasy 0 ok, 1 uwaga, 2 zakaz
 * @param {{x:number,y:number}} req.start
 * @param {{id:string,x:number,y:number,stopMin?:number}[]} req.waypoints
 * @param {{x:number,y:number,radiusM:number}[]} [req.obstacles]
 * @param {{walkKmh:number,maxSlopeDeg:number}} req.eva
 */
export function planRoute({ terrain, hazards, start, waypoints, obstacles = [], eva }) {
  const W = hazards.width, H = hazards.height, C = hazards.cellM;
  const N = W * H;
  const blocked = new Uint8Array(N);
  const mult = new Float32Array(N);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, x = (i + 0.5) * C, y = (j + 0.5) * C;
    const hz = hazards.data[k], sl = terrain.slope(x, y);
    let b = hz === 2 || sl > eva.maxSlopeDeg;
    for (const o of obstacles) if (Math.hypot(x - o.x, y - o.y) < o.radiusM + 12) b = true;
    blocked[k] = b ? 1 : 0;
    mult[k] = (1 + (sl / 12) ** 2) * (hz === 1 ? 1.8 : 1);
  }
  const cellOf = (p) => [Math.min(W - 1, Math.max(0, Math.floor(p.x / C))), Math.min(H - 1, Math.max(0, Math.floor(p.y / C)))];
  const free = (p) => { const [i, j] = cellOf(p); blocked[j * W + i] = 0; };
  free(start); waypoints.forEach(free);

  const expanded = [];
  const g = new Float32Array(N), from = new Int32Array(N), closed = new Uint8Array(N);
  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

  function astar(a, b) {
    g.fill(Infinity); from.fill(-1); closed.fill(0);
    const [ai, aj] = cellOf(a), [bi, bj] = cellOf(b), s = aj * W + ai, t = bj * W + bi;
    const heap = new Heap(); g[s] = 0; heap.push(0, s);
    while (heap.size) {
      const k = heap.pop();
      if (closed[k]) continue;
      closed[k] = 1;
      const i = k % W, j = (k / W) | 0;
      if (i % 10 === 0 && j % 10 === 0) expanded.push({ x: (i + 0.5) * C, y: (j + 0.5) * C });
      if (k === t) break;
      for (const [di, dj, d] of DIRS) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const nk = nj * W + ni;
        if (blocked[nk] || closed[nk]) continue;
        const ng = g[k] + d * C * 0.5 * (mult[k] + mult[nk]);
        if (ng < g[nk]) { g[nk] = ng; from[nk] = k; heap.push(ng + Math.hypot(ni - bi, nj - bj) * C, nk); }
      }
    }
    if (from[t] === -1 && s !== t) return null;
    const cells = []; for (let k = t; k !== -1; k = from[k]) cells.push(k);
    cells.reverse();
    const pts = cells.map((k) => ({ x: (k % W + 0.5) * C, y: (((k / W) | 0) + 0.5) * C }));
    pts[0] = { x: a.x, y: a.y }; pts[pts.length - 1] = { x: b.x, y: b.y };
    return smooth(pts);
  }

  // koszt odcinka prostego; Infinity, gdy przecina strefę zablokowaną
  function lineCost(p, q) {
    const L = Math.hypot(q.x - p.x, q.y - p.y), n = Math.max(1, Math.ceil(L / (C * 0.5)));
    let c = 0;
    for (let s = 0; s <= n; s++) {
      const x = p.x + (q.x - p.x) * s / n, y = p.y + (q.y - p.y) * s / n;
      const [i, j] = cellOf({ x, y }), k = j * W + i;
      if (blocked[k]) return Infinity;
      c += mult[k];
    }
    return c / (n + 1) * L;
  }
  function smooth(pts) {
    const cum = cumulative(pts), out = [pts[0]];
    let a = 0;
    while (a < pts.length - 1) {
      let best = a + 1;
      for (let b = Math.min(pts.length - 1, a + 80); b > a + 1; b--) {
        let raw = 0; for (let m = a; m < b; m++) raw += lineCost(pts[m], pts[m + 1]);
        if (lineCost(pts[a], pts[b]) <= raw * 1.04) { best = b; break; }
      }
      out.push(pts[best]); a = best;
    }
    // zaokrąglenie załamań (Chaikin), końce bez zmian
    let r = out;
    for (let it = 0; it < 2; it++) {
      const n = [r[0]];
      for (let i = 0; i < r.length - 1; i++) {
        const p = r[i], q = r[i + 1];
        if (i > 0) n.push({ x: 0.75 * p.x + 0.25 * q.x, y: 0.75 * p.y + 0.25 * q.y });
        if (i < r.length - 2) n.push({ x: 0.25 * p.x + 0.75 * q.x, y: 0.25 * p.y + 0.75 * q.y });
      }
      n.push(r[r.length - 1]);
      r = n;
    }
    void cum;
    return r;
  }

  const path = [];
  const wpIndex = [];
  let prev = start;
  for (const wp of waypoints) {
    const leg = astar(prev, wp);
    if (!leg) return { ok: false, error: `Brak bezpiecznego przejścia do ${wp.id}`, expanded };
    if (path.length) leg.shift();
    path.push(...leg);
    wpIndex.push(path.length - 1);
    prev = wp;
  }

  const stopMin = waypoints.reduce((s, w) => s + (w.stopMin ?? 0), 0);
  const { lengthM, durationH } = routeStats(terrain, path, eva, waypoints.length, stopMin);
  return {
    ok: true,
    path,
    waypointIndex: wpIndex,
    lengthM,
    durationH,
    stops: waypoints.length,
    rating: 'bezpieczna',
    expanded,
  };
}
