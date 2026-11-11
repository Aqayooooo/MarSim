// Kamienie terenu: JEDNA lista dla widoku 3D (rysowanie, kolizje w hełmie) i dla planera jazdy łazikiem,
// żeby wyznaczona trasa omijała dokładnie te kamienie, które widać. Losowanie z ziarnem — zawsze ten sam układ.

export function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/**
 * @param {{W:number, H:number, hazards:any, boulders?:{boulders?:any[]}, keepClear?:{x:number,y:number,r:number}[]}} p
 *   keepClear: miejsca bez losowych kamieni (habitat, postój łazika); wykryte głazy zostają zawsze
 * @returns {{x:number,y:number,r:number,h?:number,rot:number,collide:boolean,real?:boolean}[]}
 */
export function makeRocks({ W, H, hazards, boulders, keepClear = [] }) {
  const rnd = mulberry(7), rocks = [];
  for (let n = 0; n < 1400; n++) {
    const x = rnd() * W, y = rnd() * H;
    const haz = hazards.sample(x, y);
    if (haz === 2 && rnd() < 0.9) continue;            // mało kamieni na piasku
    const r = 0.12 + rnd() ** 3 * 0.55, rot = rnd() * 6.28;
    if (keepClear.some((c) => Math.hypot(x - c.x, y - c.y) < c.r)) continue;   // po losowaniu: reszta układu bez zmian
    rocks.push({ x, y, r, rot, collide: r > 0.35 });
  }
  // prawdziwe głazy wykryte metodą cieni (średnica i wysokość z pomiaru); pewne — z kolizją
  for (const b of boulders?.boulders || []) {
    rocks.push({ x: b.x, y: b.y, r: b.diameterM / 2, h: Math.max(0.3, b.heightM), rot: rnd() * 6.28, collide: b.confidence >= 0.5, real: true });
  }
  return rocks;
}

/** Miejsca wokół habitatu i postoju łazika, gdzie nie ma losowych kamieni (te same w 3D i w planerze jazdy). */
export function clearings(mission) {
  return [mission.habitat && { x: mission.habitat.x, y: mission.habitat.y, r: 24 }, mission.rover && { x: mission.rover.x, y: mission.rover.y, r: 6 }].filter(Boolean);
}

/** Najmniejszy odstęp (m) między linią a krawędzią kamienia; do sprawdzania trasy łazika. */
export function minRockGap(path, rocks, step = 0.25) {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k <= n; k++) {
      const x = a.x + (b.x - a.x) * k / n, y = a.y + (b.y - a.y) * k / n;
      for (const r of rocks) { const d = Math.hypot(x - r.x, y - r.y) - r.r; if (d < best) best = d; }
    }
  }
  return best;
}
