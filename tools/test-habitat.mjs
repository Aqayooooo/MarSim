// Testy logiki habitatu (src/core/habitat.js): strefy bazy, kolizje, śluza, stanowiska, bilans podtrzymywania życia.
// Uruchomienie: node --test tools/test-habitat.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Airlock, CABIN_KPA, DOOR_S, FURNITURE, HABITAT_FOOTPRINT, MARS_KPA, PUMP_S, ROOMS, SOLIDS, STATIONS, ZONES,
  canStand, floorAt, lifeSupport, stationAt, toLocal, toPlan, zoneAt,
} from '../src/core/habitat.js';

const OPEN_OUT = { inner: false, outer: true }, OPEN_IN = { inner: true, outer: false };

/** Idzie po łamanej krokami 0,1 m i zwraca, dokąd udało się dojść (ostatni argument: stan drzwi śluzy). */
function walk(from, ...points) {
  let p = { ...from };
  const gates = typeof points.at(-1).inner === 'boolean' ? points.pop() : OPEN_IN;
  for (const to of points) {
    const a = { ...p }, n = Math.ceil(Math.hypot(to.x - a.x, to.z - a.z) / 0.1);
    for (let i = 1; i <= n; i++) {
      const q = { x: a.x + (to.x - a.x) * i / n, z: a.z + (to.z - a.z) * i / n };
      if (!canStand(q.x, q.z, gates)) return p;
      p = q;
    }
  }
  return p;
}
const at = (p) => zoneAt(p.x, p.z, OPEN_IN)?.id;

test('z rampy przez otwarte drzwi zewnętrzne do śluzy, dalej tylko po napełnieniu', () => {
  const inAirlock = walk({ x: 10, z: 0 }, { x: 5.5, z: 0 }, OPEN_OUT);
  assert.ok(Math.abs(inAirlock.x - 5.5) < 1e-9, `doszedł do ${inAirlock.x}`);
  assert.equal(zoneAt(inAirlock.x, inAirlock.z, OPEN_OUT).id, 'airlock');
  assert.ok(walk(inAirlock, { x: 0, z: 0 }, OPEN_OUT).x > 4.8, 'zamknięte drzwi wewnętrzne zatrzymują');
  assert.equal(at(walk(inAirlock, { x: 0, z: 0 })), 'module');
  assert.ok(walk({ x: 10, z: 0 }, { x: 5.5, z: 0 }, OPEN_IN).x > 7.5, 'zamknięte drzwi zewnętrzne nie wpuszczają');
});

test('cała baza jest połączona: moduł dzienny → węzeł → laboratorium, szklarnia, korytarz i każde pomieszczenie', () => {
  const hub = walk({ x: 0, z: 0 }, { x: -7.25, z: 0 });
  assert.equal(at(hub), 'hub');
  assert.equal(at(walk(hub, { x: -7.25, z: -6 })), 'lab');
  assert.equal(at(walk(hub, { x: -7.25, z: 8 })), 'greenhouse');
  const corridor = walk(hub, { x: -15, z: 0 });
  assert.equal(at(corridor), 'corridor');
  for (const r of ROOMS) {
    const dc = (r.door.x0 + r.door.x1) / 2;
    const p = walk(corridor, { x: dc, z: 0 }, { x: dc, z: r.side * 1.6 });
    assert.equal(at(p), r.id, `${r.id}: doszedł do ${at(p)}`);
  }
});

test('ściany, meble i bryły zatrzymują', () => {
  assert.ok(walk({ x: 0, z: 0 }, { x: 0, z: 3 }).z < 1.3, 'ściana modułu dziennego');
  assert.ok(walk({ x: 1.4, z: 0 }, { x: 1.4, z: -2 }).z > -0.75, 'konsola pod oknem');
  assert.ok(walk({ x: -15, z: 0 }, { x: -15, z: 2 }).z < 0.75, 'ściana korytarza poza drzwiami');
  const c = ROOMS[0], dc = (c.door.x0 + c.door.x1) / 2;
  const inCabin = walk({ x: -15, z: 0 }, { x: dc, z: 0 }, { x: dc, z: 1.5 }, { x: c.x0 + 1, z: 1.5 });
  assert.equal(at(inCabin), c.id);
  assert.ok(walk(inCabin, { x: c.x0 + 1, z: 2.5 }).z < 1.7, 'łóżko w kajucie');
  assert.equal(canStand(-12, 3.2, {}), false, 'bryła hali z zewnątrz');
  assert.equal(canStand(-5.3, 6, {}), false, 'bryła szklarni z zewnątrz');
  assert.equal(canStand(30, 30, {}), true, 'otwarty teren');
});

test('strefy pomieszczeń dzieli co najmniej 0,4 m — krok marszu nie przeskoczy ściany', () => {
  const rooms = ZONES.filter((z) => z.inside && z.id !== 'pass' && !z.gate);
  for (const a of rooms) for (const b of rooms) {
    if (a === b) continue;
    const gap = Math.max(a.x0 - b.x1, b.x0 - a.x1, a.z0 - b.z1, b.z0 - a.z1);
    assert.ok(gap >= 0.4, `${a.id} ↔ ${b.id}: ${gap.toFixed(2)} m`);
  }
});

test('meble i stanowiska leżą w bazie, obrys dla łazika pokrywa bryły', () => {
  const inBase = (x, z) => SOLIDS.some((s) => x >= s.x0 - 0.01 && x <= s.x1 + 0.01 && z >= s.z0 - 0.01 && z <= s.z1 + 0.01);
  for (const f of FURNITURE) assert.ok(inBase((f.x0 + f.x1) / 2, (f.z0 + f.z1) / 2), f.id);
  for (const s of STATIONS.filter((st) => !st.from.includes(null))) assert.ok(inBase(s.x, s.z), s.id);
  for (const s of SOLIDS) {
    const c = { x: (s.x0 + s.x1) / 2, z: (s.z0 + s.z1) / 2 };
    assert.ok(HABITAT_FOOTPRINT.some(([x, z, r]) => Math.hypot(c.x - x, c.z - z) <= r), `obrys ${JSON.stringify(c)}`);
  }
});

test('podłoga: we wnętrzu stała, na rampie przechodzi w grunt', () => {
  assert.deepEqual(floorAt(0, 0, OPEN_IN), { h: 1, k: 0 });
  assert.equal(floorAt(30, 0, OPEN_IN), null);
  const mid = floorAt(8.75, 0, OPEN_OUT);
  assert.ok(mid.k > 0.4 && mid.k < 0.6);
});

test('śluza: zamyka, napełnia do ciśnienia kabiny, otwiera; w drugą stronę odpompowuje', () => {
  const a = new Airlock();
  assert.equal(a.state, 'out');
  assert.equal(a.cycle('out'), false, 'już otwarta na zewnątrz');
  assert.equal(a.cycle('in'), true);
  assert.equal(a.cycle('out'), false, 'w trakcie cyklu nie przyjmuje kolejnego');
  a.step(DOOR_S * 0.5);
  assert.equal(a.stage, 'close');
  assert.equal(a.gates.outer, false, 'drzwi zamykają się od razu');
  a.step(DOOR_S * 0.5 + PUMP_S * 0.5);
  assert.equal(a.stage, 'pump');
  assert.ok(a.kPa > MARS_KPA + 5 && a.kPa < CABIN_KPA - 5);
  a.step(PUMP_S);
  a.step(DOOR_S);
  assert.equal(a.state, 'in');
  assert.equal(Math.round(a.kPa * 10) / 10, CABIN_KPA);
  assert.deepEqual(a.gates, { inner: true, outer: false });
  a.cycle('out');
  for (let i = 0; i < 100; i++) a.step(0.1);
  assert.equal(a.state, 'out');
  assert.equal(a.kPa, MARS_KPA);
  assert.deepEqual(a.gates, { inner: false, outer: true });
});

test('stanowiska: tylko z własnego pomieszczenia, przy kilku — to przed postacią', () => {
  assert.equal(stationAt(8.2, 0, -1, 0, 'ramp')?.id, 'outerPanel');
  assert.notEqual(stationAt(6.9, -0.4, 1, 0, 'airlock')?.id, 'outerPanel', 'panel zewnętrzny nie przez ścianę');
  assert.equal(stationAt(5.9, -0.5, 0, -1, 'airlock')?.id, 'airlockPanel');
  assert.equal(stationAt(1.4, -0.5, 0, -1, 'module')?.id, 'console');
  assert.equal(stationAt(1.4, -0.5, 0, -1, null), null);
  assert.equal(stationAt(-4.2, -1.2, -1, 0, 'module')?.id, undefined, 'plan bazy w węźle nie przez ścianę');
  assert.equal(stationAt(-5.2, -1.3, 1, 0, 'hub')?.id, 'map');
  const c = ROOMS[0];
  assert.equal(stationAt(c.x1 - 0.5, 1.5, 0, 1, c.id)?.id, c.id);
});

test('podtrzymywanie życia: noc bez prądu ze słońca, pył osłabia ogniwa, załoga zużywa tlen i wodę', () => {
  const base = { sunElevDeg: 50, tau: 0.5, outsideC: -40, crewInside: 2, moxie: true, grow: true, lights: true, wrs: true, pumping: false };
  const day = lifeSupport(base), dusty = lifeSupport({ ...base, tau: 2 }), night = lifeSupport({ ...base, sunElevDeg: -10 });
  assert.ok(day.solarKw > 3 && day.solarKw < 8, `moc w dzień ${day.solarKw}`);
  assert.ok(dusty.solarKw < day.solarKw * 0.75, `burza pyłowa: ${dusty.solarKw} kW`);
  assert.equal(night.solarKw, 0);
  assert.ok(night.batteryHours > 0 && night.batteryHours < Infinity);
  assert.ok(day.o2BalanceGh < 0, 'dwie osoby zużywają więcej, niż daje MOXIE i szklarnia');
  assert.ok(lifeSupport({ ...base, crewInside: 0 }).o2BalanceGh > 0);
  assert.ok(lifeSupport({ ...base, pumping: true }).loadKw > day.loadKw);
  assert.ok(day.waterLh < 0 && lifeSupport({ ...base, wrs: false }).waterLh < day.waterLh * 5, 'bez odzysku woda znika szybciej');
  assert.ok(lifeSupport({ ...base, treadmill: true }).o2BalanceGh < day.o2BalanceGh, 'ćwiczenia zwiększają zużycie tlenu');
});

test('przeliczenie plan ↔ układ habitatu jest odwracalne', () => {
  const l = toLocal(105, 230, 100, 200, 0.35), p = toPlan(l.x, l.z, 100, 200, 0.35);
  assert.ok(Math.abs(p.x - 105) < 1e-9 && Math.abs(p.y - 230) < 1e-9);
});

test('systemy habitatu: bateria, tlen i woda zmieniają się z zegarem misji, przy niskiej baterii odłączają się odbiorniki', async () => {
  const { HabitatSystems, SHED_PCT, RESTORE_PCT } = await import('../src/core/habitat.js');
  const night = { sunElevDeg: -20, tau: 0.5, outsideC: -70, crewInside: 2 }, day = { ...night, sunElevDeg: 60, outsideC: -10, crewInside: 0 };
  const h = new HabitatSystems();
  const b0 = h.batteryPct, o0 = h.o2Kg, w0 = h.waterL;
  h.step(1, night);
  assert.ok(h.batteryPct < b0, 'w nocy bateria się rozładowuje');
  assert.ok(h.o2Kg < o0, 'dwie osoby w środku zużywają tlen');
  assert.ok(h.waterL < w0, 'i trochę wody mimo odzysku');
  for (let i = 0; i < 60 && !h.shed; i++) h.step(0.5, night);
  assert.equal(h.shed, true);
  assert.ok(h.batteryPct < SHED_PCT + 1);
  assert.deepEqual([h.systems.moxie, h.systems.grow], [false, false], 'MOXIE i lampy odłączone');
  assert.equal(h.toggle('moxie'), false, 'bez energii nie da się włączyć MOXIE');
  for (let i = 0; i < 80 && h.shed; i++) h.step(0.5, day);
  assert.equal(h.shed, false);
  assert.ok(h.batteryPct > RESTORE_PCT - 1);
  assert.deepEqual([h.systems.moxie, h.systems.grow], [true, true], 'odbiorniki wracają po naładowaniu');
});
