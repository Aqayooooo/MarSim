// Projekcja danych na wizjer: po lewej ruch i nawigacja, po prawej tlen i energia.
import { $, esc, setText } from '../core/dom.js';
import { num } from '../core/format.js';
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
    this.el = $('hud');
    this.el.innerHTML = `
      <div class="visor-glass" aria-hidden="true"></div>
      <div class="visor-compass"><div class="compass-ruler" aria-hidden="true"></div><b id="hudHeading"></b><span>▼</span></div>
      <div class="visor-cross" aria-hidden="true"><i></i><span>+</span><i></i></div>
      <div class="visor-nav"><b id="hudDist"></b><div class="visor-teleport" id="visorTeleport"></div></div>
      <div class="visor-motion"><b id="hudSpeed"></b><span id="visorSlope"></span></div>
      <section class="visor-summary" aria-label="${t('visor.summary')}">
        <div class="visor-metric"><span>${t('visor.oxygen')} <em id="visorWho"></em></span><b id="visorOxygen"></b><div class="visor-bar"><i id="visorOxygenBar"></i></div></div>
        <div class="visor-metric"><span>${t('visor.energy')}</span><b id="visorBattery"></b><div class="visor-bar"><i id="visorBatteryBar"></i></div></div>
      </section>
      <div class="visor-warning" id="hudWarn" role="alert" hidden></div>
      <div class="visor-help" id="hudHelp">${t('hud.help')}</div>`;
  }

  update(h) {
    const app = this.app, sim = app.sim;
    // wizjer pokazuje osobę w najgorszym stanie (najmniej tlenu), z jej identyfikatorem
    const i = sim.crew.reduce((best, m, k) => (m.o2 < sim.crew[best].o2 ? k : best), 0);
    const who = sim.crew[i], c = sim.snap?.crew?.[i];
    const oxygen = who.o2, battery = c?.batteryPct ?? null;
    // ton (norma / ostrzeżenie / zagrożenie) barwi cały wizjer
    const state = helmetStatus({ oxygen, battery, reserve: sim.reserveH(), zone: h.zone, sep: sim.sep, offline: app.offline, planned: !!app.state.route, reservePct: app.m.eva.o2ReservePct });
    this.el.dataset.tone = state.tone;
    setText($('hudHeading'), `${String(h.heading).padStart(3, '0')}°`);
    setText($('hudDist'), t('hud.to', { t: h.target, d: Math.round(h.dist) }));
    renderTeleportBar($('visorTeleport'), app, h.teleports || []);
    setText($('hudSpeed'), `${num(h.speed, 1)} km/h${h.pace > 1.01 ? ` · ${t('hud.pace', { x: num(h.pace, Number.isInteger(h.pace) ? 0 : 1) })}` : ''}`);
    setText($('hudHelp'), t(h.locked ? 'hud.helpLocked' : 'hud.help'));
    setText($('visorSlope'), `${t('hud.slope')} ${num(h.slope, 0)}°`);
    setText($('visorWho'), who.id);
    setText($('visorOxygen'), `${num(oxygen, 0)}%`);
    setText($('visorBattery'), battery === null ? '—' : `${num(battery, 0)}%`);
    $('visorOxygenBar').style.width = `${Math.max(0, Math.min(100, oxygen))}%`;
    $('visorBatteryBar').style.width = battery === null ? '0%' : `${Math.max(0, Math.min(100, battery))}%`;
    const message = h.warn || (h.zone === 2 ? t('hud.nogo') : null);
    setText($('hudWarn'), message || '');
    $('hudWarn').hidden = !message;
    $('hudHelp').hidden = h.timelapse > 1;
  }
}
