// Środowisko z zegara misji bez backendu: przybliżone położenie słońca i temperatura z krzywej dobowej misji.
// Bez DOM i three.js — używają tego panele, widok 3D i model habitatu.
import { parseClock } from './format.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Położenie słońca: przybliżenie z godziny LTST (wschód 6:00, zachód 18:00) i szerokości obszaru. */
export function approxSun(hour, latDeg) {
  const k = clamp((hour - 6) / 12, 0, 1);
  const el = Math.sin(Math.PI * k) * (90 - Math.min(60, Math.abs(latDeg) + 25));
  const az = latDeg >= 0 ? 90 + 180 * k : (450 - 180 * k) % 360;   // przez południe na półkuli północnej, przez północ na południowej
  // w nocy słońce pod horyzontem (do −30° o północy) — dla modelu energii, widok 3D i tak trzyma je nad horyzontem
  const night = hour < 6 || hour > 18 ? -Math.sin(Math.PI * (((hour + 6) % 24) / 12)) * 30 : 0;
  return { az, el: el + night };
}

/** Temperatura z krzywej [["hh:mm", °C], …] w minucie doby (między punktami — liniowo). */
export function tempAt(curve, min) {
  const pts = curve.map(([c, t]) => [parseClock(c), t]);
  if (min <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (min <= pts[i][0]) { const [a, ta] = pts[i - 1], [b, tb] = pts[i]; return ta + (tb - ta) * (min - a) / (b - a); }
  }
  return pts[pts.length - 1][1];
}

/** Warunki dla modelu habitatu: z migawki backendu, a bez niej — z danych misji i zegara. */
export function habitatEnv(app) {
  const sim = app.sim, env = sim.snap?.env, m = app.m;
  const hour = ((sim.min / 60) % 24 + 24) % 24;
  return {
    sunElevDeg: env?.sunElevDeg ?? approxSun(hour, m.area?.center?.lat ?? 0).el,
    tau: env?.tau ?? m.environment.dustTau,
    outsideC: env?.groundTempC ?? tempAt(m.environment.temperature, sim.min),
    crewInside: app.phase === 'idle' || app.phase === 'done' ? sim.crew.length : 0,
  };
}
