// Projekcja danych na wizjer. Przykład niedoboru zmienia wyłącznie podgląd HUD.
import { $, esc, setText } from '../core/dom.js';
import { num, hm, clock } from '../core/format.js';
import { t } from '../i18n.js';

/** reservePct: rezerwa tlenu misji (eva.o2ReservePct); poniżej niej — natychmiastowy powrót. */
export function helmetStatus({ oxygen, battery, reserve, zone, sep, offline, planned, reservePct = 20 }) {
  if (offline) return { tone: 'warning', key: 'visor.offline', detail: 'visor.offlineDetail' };
  if (sep) return { tone: 'danger', key: 'visor.shelter', detail: 'visor.shelterDetail' };
  if (oxygen <= reservePct || (planned && reserve <= 0)) return { tone: 'danger', key: 'visor.returnNow', detail: 'visor.oxygenDetail' };
  if (battery !== null && battery <= 25) return { tone: 'warning', key: 'visor.lowBattery', detail: 'visor.batteryDetail' };
  if (zone === 2) return { tone: 'danger', key: 'hud.nogo', detail: 'visor.terrainDetail' };
  if (zone === 1) return { tone: 'warning', key: 'hud.caution', detail: 'visor.terrainDetail' };
  if (planned && reserve < .5) return { tone: 'warning', key: 'visor.lowReserve', detail: 'visor.reserveDetail' };
  return { tone: 'normal', key: planned ? 'visor.nominal' : 'visor.ready', detail: planned ? 'visor.nominalDetail' : 'visor.planDetail' };
}

/**
 * Pasek teleportu: przyciski WP1…WPn i HAB z klawiszami 1–9 / 0. Odświeża się tylko po zmianie listy punktów.
 * Kliknięcie emituje „teleport-request” z indeksem celu (obsługa w View3D.teleport).
 */
export function renderTeleportBar(el, app, ids) {
  const sig = ids.join('|');
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  const key = (id, i) => (id === 'HAB' ? '0' : i < 9 ? String(i + 1) : '');
  el.innerHTML = `<small>${esc(t('hud.teleport'))}</small>` + ids.map((id, i) =>
    `<button type="button" data-i="${i}" title="${esc(t('hud.teleportTo', { t: id }))}">${key(id, i) ? `<kbd>${key(id, i)}</kbd>` : ''}${esc(id)}</button>`).join('');
  if (!el.dataset.wired) {
    el.dataset.wired = '1';
    el.addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (b) { app.emit('teleport-request', Number(b.dataset.i)); b.blur(); } });
  }
}

export class HelmetHud {
  constructor(app) {
    this.app = app;
    this.example = false;
    this.el = $('hud');
    this.el.innerHTML = `
      <div class="visor-glass" aria-hidden="true"></div>
      <div class="visor-id"><span class="visor-led"></span> MARSIM <span id="visorWearer">/ EV1</span><small>${t('visor.system')}</small></div>
      <div class="visor-compass"><div class="compass-ruler" aria-hidden="true"></div><b id="hudHeading"></b><span>▼</span></div>
      <div class="visor-cross" aria-hidden="true"><i></i><span>+</span><i></i></div>
      <div class="visor-nav"><small>${t('visor.navigation')}</small><b id="hudDist"></b><span id="visorRoute"></span><div class="visor-teleport" id="visorTeleport"></div></div>
      <div class="visor-motion"><b id="hudSpeed"></b><span id="visorSlope"></span><small id="visorClock"></small></div>
      <div class="visor-wordmark" aria-hidden="true">EXPLORER <span>01</span> / EVA SYSTEM</div>
      <section class="visor-summary" aria-labelledby="visorSummaryTitle">
        <header><span class="visor-led"></span><h2 id="visorSummaryTitle">${t('visor.summary')}</h2><span id="visorSource"></span></header>
        <div class="visor-decision"><span id="visorDecision"></span><p id="visorDetail"></p></div>
        <div class="visor-metric"><span>${t('visor.oxygen')} <em id="visorWho"></em></span><b id="visorOxygen"></b><div class="visor-bar"><i id="visorOxygenBar"></i></div></div>
        <div class="visor-metric"><span>${t('visor.energy')}</span><b id="visorBattery"></b><div class="visor-bar"><i id="visorBatteryBar"></i></div></div>
        <div class="visor-facts"><div><span>${t('visor.reserve')}</span><b id="visorReserve"></b></div><div><span>${t('visor.pressure')}</span><b id="visorPressure"></b></div></div>
        <footer><span id="visorDataNote"></span><button id="visorExample" type="button" aria-pressed="false">${t('visor.tryAlert')}</button></footer>
      </section>
      <div class="visor-warning" id="hudWarn" role="alert" hidden></div>
      <div class="visor-help" id="hudHelp">${t('hud.help')}</div>`;
    $('visorExample').addEventListener('click', () => { this.example = !this.example; });
    app.on('view', (view) => { if (view !== 'helmet') this.example = false; });
    app.on('reset', () => { this.example = false; });
  }

  update(h) {
    const app = this.app, sim = app.sim;
    // wizjer pokazuje osobę w najgorszym stanie (najmniej tlenu), z jej identyfikatorem
    const i = sim.crew.reduce((best, m, k) => (m.o2 < sim.crew[best].o2 ? k : best), 0);
    const who = sim.crew[i], c = sim.snap?.crew?.[i];
    const oxygen = this.example ? 18 : who.o2;
    const battery = this.example ? 22 : c?.batteryPct ?? null;
    const planned = !!app.state.route;
    const reserve = this.example ? -.12 : sim.reserveH();
    const state = helmetStatus({ oxygen, battery, reserve, zone: h.zone, sep: sim.sep, offline: app.offline, planned: planned || this.example, reservePct: app.m.eva.o2ReservePct });
    this.el.dataset.tone = state.tone;
    this.el.classList.toggle('example', this.example);
    setText($('hudHeading'), `${String(h.heading).padStart(3, '0')}°`);
    setText($('hudDist'), t('hud.to', { t: h.target, d: Math.round(h.dist) }));
    renderTeleportBar($('visorTeleport'), app, h.teleports || []);
    setText($('visorRoute'), planned ? t('visor.route', { l: app.state.route.letter }) : t('visor.noRoute'));
    setText($('hudSpeed'), `${num(h.speed, 1)} km/h${h.pace > 1.01 ? ` · ${t('hud.pace', { x: num(h.pace, Number.isInteger(h.pace) ? 0 : 1) })}` : ''}`);
    setText($('hudHelp'), t(h.locked ? 'hud.helpLocked' : 'hud.help'));
    setText($('visorSlope'), `${t('hud.slope')} ${num(h.slope, 0)}°`);
    setText($('visorClock'), `SOL ${app.m.mission.sol} / ${clock(sim.min)} LTST`);
    setText($('visorDecision'), t(state.key));
    setText($('visorDetail'), t(state.detail));
    setText($('visorSource'), t(this.example ? 'visor.example' : 'visor.simulation'));
    setText($('visorWearer'), `/ ${sim.crew[0].id}`);   // widok z hełmu prowadzącego
    setText($('visorWho'), who.id);
    setText($('visorOxygen'), `${num(oxygen, 0)}%`);
    setText($('visorBattery'), battery === null ? '—' : `${num(battery, 0)}%`);
    $('visorOxygenBar').style.width = `${Math.max(0, Math.min(100, oxygen))}%`;
    $('visorBatteryBar').style.width = battery === null ? '0%' : `${Math.max(0, Math.min(100, battery))}%`;
    setText($('visorReserve'), planned || this.example ? reserve < 0 ? t('visor.deficit', { m: Math.ceil(-reserve * 60) }) : hm(reserve) : '—');
    setText($('visorPressure'), c ? `${num(c.pressureKPa, 1)} kPa` : '—');
    setText($('visorDataNote'), t(this.example ? 'visor.exampleNote' : c ? 'visor.modelNote' : 'visor.localNote'));
    setText($('visorExample'), t(this.example ? 'visor.endAlert' : 'visor.tryAlert'));
    $('visorExample').setAttribute('aria-pressed', String(this.example));
    const message = h.warn || (h.zone === 2 ? t('hud.nogo') : null);
    setText($('hudWarn'), message || '');
    $('hudWarn').hidden = !message;
    $('hudHelp').hidden = h.timelapse > 1;
  }
}
