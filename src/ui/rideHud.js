// Wskaźniki ręcznej jazdy łazikiem (F w hełmie): prędkość, kurs, nachylenie, tempo, rodzaj kamery i klawisze.
import { $, setText } from '../core/dom.js';
import { num } from '../core/format.js';
import { t } from '../i18n.js';
import { renderTeleportBar } from './helmetHud.js';

export class RideHud {
  constructor(app) {
    this.app = app;
    this.el = $('rideHud');
    this.el.innerHTML = `<div class="rh-top"><b>${t('ride.title')}</b><span id="rhCam"></span></div>
      <div id="rhLine"></div><div class="rh-warn" id="rhWarn" role="alert" hidden></div><div class="rh-help">${t('ride.help')}</div><div class="visor-teleport rh-teleport" id="rhTeleport"></div>`;
  }

  update(i) {
    setText($('rhCam'), t(i.cabin ? 'ride.camCabin' : 'ride.camBoom', { m: num(i.boom, 0) }));
    setText($('rhLine'), t('ride.line', { v: `${i.reverse ? '−' : ''}${num(i.speed, 1)}`, h: String(i.heading).padStart(3, '0'), s: num(i.slope, 0), p: num(i.pace, Number.isInteger(i.pace) ? 0 : 1) }));
    renderTeleportBar($('rhTeleport'), this.app, i.teleports || []);
    setText($('rhWarn'), i.warn || '');
    $('rhWarn').hidden = !i.warn;
  }
}
