// ZAŚLEPKA BACKENDU: planer trasy A* na siatce kosztów.
// Docelowo zastąpi go endpoint backendu POST /api/plan (patrz docs/KONTRAKT_DANYCH.md).
// Wejście i wyjście mają dokładnie ten kształt, który ma zwracać backend.
import { routeStats } from '../core/routeStats.js';

const OBSTACLE_MARGIN_M = 12;   // zgłoszona przeszkoda blokuje dysk o promieniu r + tyle metrów
const OBSTACLE_EXIT_FACTOR = 10; // mnożnik kosztu w przeszkodzie, z której trzeba wyjść (jak w backendzie: załoga, habitat albo łazik w środku)
const O2_CAPACITY_L = 520;      // pojemność butli O₂, gdy dane misji jej nie podają (konfiguracja backendu: 520 L)

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
 * @param {{x:number,y:number,r:number}[]} [req.rocks]  kamienie do ominięcia (jazda łazikiem): blokują oczka, które dotyka kamień powiększony o clearanceM
 * @param {number} [req.clearanceM]  zapas od kamienia (połowa łazika + margines)
 * @param {boolean} [req.heuristic]  true: A* (odległość w linii prostej), false: czysty Dijkstra — ta sama trasa, więcej sprawdzonych komórek
 * @param {{x:number,y:number}} [req.habitat]  habitat: ocena tlenu z powrotem (ostatni punkt → habitat)
 * @param {{x:number,y:number}[]} [req.release]  punkty, których zgłoszona przeszkoda nie może odciąć (habitat, łazik); domyślnie habitat
 * @param {{o2RatePctH:number,o2CapacityL?:number}[]} [req.crew]  załoga (zużycie w %/h butli) do bilansu tlenu; bez niej plan nie jest oceniany pod kątem O₂
 */
export function planRoute(req) {
  const { terrain, hazards, start, waypoints, obstacles = [], eva, heuristic = true, rocks = null, clearanceM = 0, habitat = null, crew = null } = req;
  const softAll = !!req.softAll;               // druga próba powrotu do habitatu: wszystkie przeszkody przejezdne z wysokim kosztem
  const release = req.release ?? (habitat ? [habitat] : []);
  const W = hazards.width, H = hazards.height, C = hazards.cellM;
  const N = W * H;
  const blocked = new Uint8Array(N);
  const mult = new Float32Array(N);
  // Zgłoszona przeszkoda, w której stoi załoga albo leży habitat lub łazik, nie więzi (jak w backendzie): cały spójny obszar
  // nakładających się przeszkód jest przejezdny, ale bardzo drogi, więc trasa wychodzi z niego najkrótszą drogą.
  // Pozostałe przeszkody blokują dysk r + 12 m; zwykły punkt trasy w przeszkodzie jest odrzucany.
  const keep = [start, ...release];
  const inside = (o, p) => Math.hypot(p.x - o.x, p.y - o.y) < o.radiusM + OBSTACLE_MARGIN_M + 1.5 * C;
  const group = obstacles.map((_, n) => n);    // obszary nakładających się przeszkód (union-find)
  const root = (n) => (group[n] === n ? n : (group[n] = root(group[n])));
  obstacles.forEach((a, n) => obstacles.forEach((b, q) => {
    if (q > n && Math.hypot(a.x - b.x, a.y - b.y) < a.radiusM + b.radiusM + 2 * OBSTACLE_MARGIN_M) group[root(q)] = root(n);
  }));
  const freed = new Set(obstacles.flatMap((o, n) => (softAll || keep.some((p) => inside(o, p)) ? [root(n)] : [])));
  const soft = obstacles.map((_, n) => freed.has(root(n)));
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, x = (i + 0.5) * C, y = (j + 0.5) * C;
    const hz = hazards.data[k], sl = terrain.slope(x, y);
    let b = hz === 2 || sl > eva.maxSlopeDeg, m = (1 + (sl / 12) ** 2) * (hz === 1 ? 1.8 : 1);
    const base0 = m;
    for (let n = 0; n < obstacles.length; n++) {
      const o = obstacles[n];
      if (Math.hypot(x - o.x, y - o.y) >= o.radiusM + OBSTACLE_MARGIN_M) continue;
      if (soft[n]) m = Math.max(m, base0 * OBSTACLE_EXIT_FACTOR); else b = true;
    }
    blocked[k] = b ? 1 : 0;
    mult[k] = m;
  }
  const cellOf = (p) => [Math.min(W - 1, Math.max(0, Math.floor(p.x / C))), Math.min(H - 1, Math.max(0, Math.floor(p.y / C)))];
  const exact = !!rocks;                       // tryb łazika: bez ścinania rogów i bez zaokrąglania (trasa ma omijać kamienie)
  const base = blocked.slice();                // siatka bez kamieni: cel sprawdzamy na niej (kamień przy celu to nie „strefa niedostępna”)
  if (exact) {
    for (const rk of rocks) {
      const R = rk.r + clearanceM;
      const i0 = Math.max(0, Math.floor((rk.x - R) / C)), i1 = Math.min(W - 1, Math.floor((rk.x + R) / C));
      const j0 = Math.max(0, Math.floor((rk.y - R) / C)), j1 = Math.min(H - 1, Math.floor((rk.y + R) / C));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const nx = Math.max(i * C, Math.min(rk.x, (i + 1) * C)), ny = Math.max(j * C, Math.min(rk.y, (j + 1) * C));   // najbliższy punkt oczka
        if (Math.hypot(nx - rk.x, ny - rk.y) < R) blocked[j * W + i] = 1;
      }
    }
  }
  // oczko startu jest zawsze wolne (załoga już tam stoi); łazik: także 3×3 wokół startu, bo kamienie powiększone o zapas
  // potrafią zamknąć oczko, w którym stoi, i jego sąsiadów
  const free = (p, to) => {
    const [i, j] = cellOf(p), r = exact ? 1 : 0;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const a = i + di, b = j + dj;
      if (a >= 0 && b >= 0 && a < W && b < H) blocked[b * W + a] = to ? to[b * W + a] : 0;
    }
  };
  free(start);
  for (const wp of waypoints) {
    const [i, j] = cellOf(wp);
    if (base[j * W + i] && blocked[j * W + i]) return { ok: false, error: `Cel ${wp.id} leży w strefie niedostępnej` };
    if (exact) free(wp, base);                 // łazik: cel tuż przy kamieniu — 3×3 wokół celu bez kamieni (teren i zakazy zostają)
  }

  const expanded = [];
  let visited = 0;
  const hw = heuristic ? C : 0;
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
      visited++;
      const i = k % W, j = (k / W) | 0;
      if (i % 10 === 0 && j % 10 === 0) expanded.push({ x: (i + 0.5) * C, y: (j + 0.5) * C });
      if (k === t) break;
      for (const [di, dj, d] of DIRS) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const nk = nj * W + ni;
        if (blocked[nk] || closed[nk]) continue;
        if (di && dj && (blocked[j * W + ni] || blocked[nj * W + i])) continue;   // bez ścinania rogu po skosie
        const ng = g[k] + d * C * 0.5 * (mult[k] + mult[nk]);
        if (ng < g[nk]) { g[nk] = ng; from[nk] = k; heap.push(ng + Math.hypot(ni - bi, nj - bj) * hw, nk); }
      }
    }
    if (from[t] === -1 && s !== t) return null;
    const cells = []; for (let k = t; k !== -1; k = from[k]) cells.push(k);
    cells.reverse();
    if (cells.length === 1) cells.push(cells[0]);
    const pts = cells.map((k) => ({ x: (k % W + 0.5) * C, y: (((k / W) | 0) + 0.5) * C }));
    pts[0] = { x: a.x, y: a.y }; pts[pts.length - 1] = { x: b.x, y: b.y };
    return smooth(pts);
  }

  // koszt odcinka prostego; Infinity, gdy przecina strefę zablokowaną
  function lineCost(p, q) {
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    const cuts = [0, 1];
    for (const axis of ['x', 'y']) {
      const delta = q[axis] - p[axis];
      if (!delta) continue;
      const low = Math.min(p[axis], q[axis]), high = Math.max(p[axis], q[axis]);
      for (let border = Math.floor(low / C) + 1; border < Math.ceil(high / C); border++) {
        cuts.push((border * C - p[axis]) / delta);
      }
    }
    cuts.sort((a, b) => a - b);
    const at = t => {
      const [i, j] = cellOf({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      return j * W + i;
    };
    let cost = 0;
    for (let i = 0; i < cuts.length; i++) {
      if (blocked[at(cuts[i])]) return Infinity;
      if (i === 0 || cuts[i] === cuts[i - 1]) continue;
      const k = at((cuts[i] + cuts[i - 1]) / 2);
      if (blocked[k]) return Infinity;
      cost += mult[k] * (cuts[i] - cuts[i - 1]) * length;
    }
    return cost;
  }
  function smooth(pts) {
    const out = [pts[0]];
    const legCosts = pts.slice(1).map((p, i) => lineCost(pts[i], p));
    let a = 0;
    while (a < pts.length - 1) {
      let best = a + 1;
      for (let b = Math.min(pts.length - 1, a + 80); b > a + 1; b--) {
        let raw = 0; for (let m = a; m < b; m++) raw += legCosts[m];
        const shortcut = lineCost(pts[a], pts[b]);
        if (Number.isFinite(shortcut) && shortcut <= raw * 1.04) { best = b; break; }
      }
      out.push(pts[best]); a = best;
    }
    return out;
  }

  const path = [];
  const wpIndex = [];
  let prev = start;
  for (const wp of waypoints) {
    const leg = astar(prev, wp);
    if (!leg) {
      // powrót do habitatu nigdy nie jest zamknięty przez zgłoszone przeszkody (np. przeszkoda zamyka jedyne wyjście z kotliny):
      // wtedy idziemy przez nie z wysokim kosztem; blokuje tylko teren
      const home = habitat && Math.hypot(wp.x - habitat.x, wp.y - habitat.y) < C;
      if (home && obstacles.length && !softAll) return planRoute({ ...req, softAll: true });
      return { ok: false, error: `Brak bezpiecznego przejścia do ${wp.id}`, expanded };
    }
    if (path.length) leg.shift();
    path.push(...leg);
    wpIndex.push(path.length - 1);
    prev = wp;
  }

  const stopMin = waypoints.reduce((s, w) => s + (w.stopMin ?? 0), 0);
  const { lengthM, durationH } = routeStats(terrain, path, eva, waypoints.length, stopMin);
  const o2Budget = crew?.length && habitat ? budget(durationH) : null;
  return {
    ok: true,
    path,
    waypointIndex: wpIndex,
    lengthM,
    durationH,
    stops: waypoints.length,
    rating: o2Budget && !o2Budget.ok ? 'niebezpieczna' : 'bezpieczna',
    ...(o2Budget ? { o2Budget } : {}),
    ...(o2Budget && !o2Budget.ok ? { ratingReason: o2Budget.reason } : {}),
    expanded,
    visited,
  };

  // Bilans tlenu jak w backendzie (o2Budget): plan z postojami i powrotem pieszo z ostatniego punktu do habitatu
  // dla osoby o największym zużyciu wobec zapasu ponad rezerwę najmniejszej butli w załodze.
  function budget(outH) {
    const n = expanded.length;
    const home = Math.hypot(prev.x - habitat.x, prev.y - habitat.y) < C;
    const back = home ? [prev, prev] : astar(prev, habitat);
    expanded.length = n;                       // powrót nie należy do animacji wyszukiwania
    const reservePct = eva.o2ReservePct ?? 20;
    const capL = Math.min(...crew.map((c) => c.o2CapacityL ?? O2_CAPACITY_L));
    const usableL = capL * (1 - reservePct / 100);
    const litresPerH = Math.max(...crew.map((c) => c.o2RatePctH / 100 * (c.o2CapacityL ?? O2_CAPACITY_L)));
    const returnL = back ? routeStats(terrain, back, eva).durationH * litresPerH : Infinity;
    const needL = outH * litresPerH + returnL;
    const out = { needL: Math.round(needL * 10) / 10, returnL: Math.round(returnL * 10) / 10, usableL: Math.round(usableL * 10) / 10, reservePct };
    if (!back) return { ...out, needL: null, returnL: null, ok: false, reason: 'brak drogi powrotnej do habitatu z ostatniego punktu trasy' };
    if (needL > usableL) {
      return { ...out, ok: false, reason: `za mało tlenu: plan z powrotem do habitatu wymaga ${Math.round(needL)} L O₂, a zapas ponad rezerwę ${reservePct}% to ${Math.round(usableL)} L` };
    }
    return { ...out, ok: true };
  }
}
