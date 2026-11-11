// Testy logiki habitatu (src/core/habitat.js): strefy wnętrza, kolizje, śluza, stanowiska, bilans podtrzymywania życia.
// Uruchomienie: node --test tools/test-habitat.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Airlock, CABIN_KPA, DOOR_S, MARS_KPA, PUMP_S, canStand, floorAt, lifeSupport, stationAt, toLocal, toPlan, zoneAt,
} from '../src/core/habitat.js';

const OPEN_OUT = { inner: false, outer: true }, OPEN_IN = { inner: true, outer: false };

/** Idzie po linii prostej krokami 0,1 m i zwraca, dokąd udało się dojść. */
function walk(from, to, gates) {
  let p = { ...from };
  const n = Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / 0.1);
  for (let i = 1; i <= n; i++) {
    const q = { x: from.x + (to.x - from.x) * i / n, z: from.z + (to.z - from.z) * i / n };
    if (!canStand(q.x, q.z, gates)) break;
    p = q;
  }
  return p;
}

test('z rampy przez otwarte drzwi zewnętrzne do śluzy, dalej tylko po napełnieniu', () => {
  const inAirlock = walk({ x: 10, z: 0 }, { x: 5.5, z: 0 }, OPEN_OUT);
  assert.ok(Math.abs(inAirlock.x - 5.5) < 1e-9, `doszedł do ${inAirlock.x}`);
  assert.equal(zoneAt(inAirlock.x, inAirlock.z, OPEN_OUT).id, 'airlock');
  const stuck = walk(inAirlock, { x: 0, z: 0 }, OPEN_OUT);
  assert.ok(stuck.x > 4.8, 'zamknięte drzwi wewnętrzne zatrzymują');
  const inModule = walk(inAirlock, { x: 0, z: 0 }, OPEN_IN);
  assert.equal(zoneAt(inModule.x, inModule.z, OPEN_IN).id, 'module');
});

test('zamknięte drzwi zewnętrzne nie wpuszczają, ściany i meble zatrzymują', () => {
  const p = walk({ x: 10, z: 0 }, { x: 5.5, z: 0 }, OPEN_IN);
  assert.ok(p.x > 7.5, `zatrzymany przed drzwiami: ${p.x}`);
  assert.ok(walk({ x: 0, z: 0 }, { x: 0, z: 3 }, OPEN_IN).z < 1.3, 'ściana modułu');
  assert.ok(walk({ x: 1.4, z: 0 }, { x: 1.4, z: -2 }, OPEN_IN).z > -0.75, 'konsola pod oknem');
  const green = walk({ x: -1, z: 0 }, { x: -1, z: 6 }, OPEN_IN);
  assert.equal(zoneAt(green.x, green.z, OPEN_IN).id, 'greenhouse', 'przejście do szklarni');
  assert.equal(canStand(0, 3, {}), false, 'bryła szklarni z zewnątrz');
  assert.equal(canStand(20, 20, {}), true, 'otwarty teren');
});

test('podłoga: we wnętrzu stała, na rampie przechodzi w grunt', () => {
  assert.deepEqual(floorAt(0, 0, OPEN_IN), { h: 1, k: 0 });
  assert.equal(floorAt(20, 0, OPEN_IN), null);
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

test('stanowiska: z właściwej strony ściany, to przed postacią', () => {
  assert.equal(stationAt(8.2, 0, -1, 0, false)?.id, 'outerPanel');
  assert.notEqual(stationAt(6.9, -0.4, 1, 0, true)?.id, 'outerPanel', 'panel zewnętrzny nie przez ścianę');
  assert.equal(stationAt(5.9, -0.5, 0, -1, true)?.id, 'airlockPanel');
  assert.equal(stationAt(1.4, -0.5, 0, -1, true)?.id, 'console');
  assert.equal(stationAt(1.4, -0.5, 0, -1, false), null);
});

test('podtrzymywanie życia: noc bez prądu ze słońca, pył osłabia ogniwa, załoga zużywa tlen', () => {
  const base = { sunElevDeg: 50, tau: 0.5, outsideC: -40, crewInside: 2, moxie: true, grow: true, lights: true, pumping: false };
  const day = lifeSupport(base), dusty = lifeSupport({ ...base, tau: 2 }), night = lifeSupport({ ...base, sunElevDeg: -10 });
  assert.ok(day.solarKw > 3 && day.solarKw < 8, `moc w dzień ${day.solarKw}`);
  assert.ok(dusty.solarKw < day.solarKw * 0.75, `burza pyłowa: ${dusty.solarKw} kW`);
  assert.equal(night.solarKw, 0);
  assert.ok(night.batteryHours > 0 && night.batteryHours < Infinity);
  assert.ok(day.o2BalanceGh < 0, 'dwie osoby zużywają więcej, niż daje MOXIE i szklarnia');
  assert.ok(lifeSupport({ ...base, crewInside: 0 }).o2BalanceGh > 0);
  assert.ok(lifeSupport({ ...base, pumping: true }).loadKw > day.loadKw);
});

test('przeliczenie plan ↔ układ habitatu jest odwracalne', () => {
  const l = toLocal(105, 230, 100, 200, 0.35), p = toPlan(l.x, l.z, 100, 200, 0.35);
  assert.ok(Math.abs(p.x - 105) < 1e-9 && Math.abs(p.y - 230) < 1e-9);
});

test('systemy habitatu: bateria i tlen zmieniają się z zegarem misji, przy niskiej baterii odłączają się odbiorniki', async () => {
  const { HabitatSystems, SHED_PCT, RESTORE_PCT } = await import('../src/core/habitat.js');
  const night = { sunElevDeg: -20, tau: 0.5, outsideC: -70, crewInside: 2 }, day = { ...night, sunElevDeg: 60, outsideC: -10, crewInside: 0 };
  const h = new HabitatSystems();
  const b0 = h.batteryPct, o0 = h.o2Kg;
  h.step(1, night);
  assert.ok(h.batteryPct < b0, 'w nocy bateria się rozładowuje');
  assert.ok(h.o2Kg < o0, 'dwie osoby w środku zużywają tlen');
  for (let i = 0; i < 40 && !h.shed; i++) h.step(0.5, night);
  assert.equal(h.shed, true);
  assert.ok(h.batteryPct < SHED_PCT + 1);
  assert.deepEqual([h.systems.moxie, h.systems.grow], [false, false], 'MOXIE i lampy odłączone');
  assert.equal(h.toggle('moxie'), false, 'bez energii nie da się włączyć MOXIE');
  for (let i = 0; i < 40 && h.shed; i++) h.step(0.5, day);
  assert.equal(h.shed, false);
  assert.ok(h.batteryPct > RESTORE_PCT);
  assert.deepEqual([h.systems.moxie, h.systems.grow], [true, true], 'odbiorniki wracają po naładowaniu');
  h.step(0, night);
  assert.ok(h.now.loadKw > 0);
});
