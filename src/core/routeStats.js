// Długość i czas przejścia trasy w skafandrze (wzór Toblera, przeskalowany do prędkości EVA).
export function routeStats(terrain, path, eva, stops = 0, stopMin = 0) {
  let walkH = 0, lengthM = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d === 0) continue;
    const grade = (terrain.height(b.x, b.y) - terrain.height(a.x, a.y)) / d;
    const v = eva.walkKmh * Math.exp(-3.5 * Math.abs(grade + 0.05)) / Math.exp(-3.5 * 0.05);
    walkH += d / 1000 / Math.max(0.6, v);
    lengthM += d;
  }
  return { lengthM, durationH: walkH + stopMin / 60, stops };
}
