// Projekcja danych na wizjer. Przykład niedoboru zmienia wyłącznie podgląd HUD.
import { $, setText } from '../core/dom.js';
import { num, hm, clock } from '../core/format.js';
import { t } from '../i18n.js';

export function helmetStatus({ oxygen, battery, reserve, zone, sep, offline, planned }) {
  if (offline) return { tone: 'warning', key: 'visor.offline', detail: 'visor.offlineDetail' };
  if (sep) return { tone: 'danger', key: 'visor.shelter', detail: 'visor.shelterDetail' };
  if (oxygen <= 25 || (planned && reserve <= 0)) return { tone: 'danger', key: 'visor.returnNow', detail: 'visor.oxygenDetail' };
  if (battery !== null && battery <= 25) return { tone: 'warning', key: 'visor.lowBattery', detail: 'visor.batteryDetail' };
  if (zone === 2) return { tone: 'danger', key: 'hud.nogo', detail: 'visor.terrainDetail' };
  if (zone === 1) return { tone: 'warning', key: 'hud.caution', detail: 'visor.terrainDetail' };
  if (planned && reserve < .5) return { tone: 'warning', key: 'visor.lowReserve', detail: 'visor.reserveDetail' };
  return { tone: 'normal', key: planned ? 'visor.nominal' : 'visor.ready', detail: planned ? 'visor.nominalDetail' : 'visor.planDetail' };
}

export class HelmetHud {
  constructor(app) {
    this.app = app;
    this.example = false;
    this.el = $('hud');
    this.el.innerHTML = `
      <div class="visor-glass" aria-hidden="true"></div>
      <div class="visor-id"><span class="visor-led"></span> MARSIM <span>/ EV1</span><small>${t('visor.system')}</small></div>
      <div class="visor-compass"><div class="compass-ruler" aria-hidden="true"></div><b id="hudHeading"></b><span>▼</span></div>
      <div class="visor-cross" aria-hidden="true"><i></i><span>+</span><i></i></div>
      <div class="visor-nav"><small>${t('visor.navigation')}</small><b id="hudDist"></b><span id="visorRoute"></span></div>
      <div class="visor-motion"><b id="hudSpeed"></b><span id="visorSlope"></span><small id="visorClock"></small></div>
      <div class="visor-wordmark" aria-hidden="true">EXPLORER <span>01</span> / EVA SYSTEM</div>
      <section class="visor-summary" aria-labelledby="visorSummaryTitle">
        <header><span class="visor-led"></span><h2 id="visorSummaryTitle">${t('visor.summary')}</h2><span id="visorSource"></span></header>
        <div class="visor-decision"><span id="visorDecision"></span><p id="visorDetail"></p></div>
        <div class="visor-metric"><span>${t('visor.oxygen')}</span><b id="visorOxygen"></b><div class="visor-bar"><i id="visorOxygenBar"></i></div></div>
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
    const app = this.app, sim = app.sim, c = sim.snap?.crew?.[0];
    const oxygen = this.example ? 18 : sim.crew[0].o2;
    const battery = this.example ? 22 : c?.batteryPct ?? null;
    const planned = !!app.state.route;
    const reserve = this.example ? -.12 : sim.reserveH();
    const state = helmetStatus({ oxygen, battery, reserve, zone: h.zone, sep: sim.sep, offline: app.offline, planned: planned || this.example });
    this.el.dataset.tone = state.tone;
    this.el.classList.toggle('example', this.example);
    setText($('hudHeading'), `${String(h.heading).padStart(3, '0')}°`);
    setText($('hudDist'), t('hud.to', { t: h.target, d: Math.round(h.dist) }));
    setText($('visorRoute'), planned ? t('visor.route', { l: app.state.route.letter }) : t('visor.noRoute'));
    setText($('hudSpeed'), `${num(h.speed, 1)} km/h`);
    setText($('visorSlope'), `${t('hud.slope')} ${num(h.slope, 0)}°`);
    setText($('visorClock'), `SOL ${app.m.mission.sol} / ${clock(sim.min)} LTST`);
    setText($('visorDecision'), t(state.key));
    setText($('visorDetail'), t(state.detail));
    setText($('visorSource'), t(this.example ? 'visor.example' : 'visor.simulation'));
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
