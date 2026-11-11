// Wskaźniki w habitacie (zamiast wizjera): miejsce, ciśnienie i stan śluzy, podpowiedź stanowiska pod E, komunikaty.
import { $, setText } from '../core/dom.js';
import { t } from '../i18n.js';

export class HabHud {
  constructor() {
    this.el = $('habHud');
    this.el.innerHTML = `<div class="hh-top"><b id="hhZone"></b><span id="hhStatus"></span></div>
      <div class="hh-bar" id="hhBar" hidden><i></i></div>
      <div class="hh-prompt" id="hhPrompt"></div><div class="hh-flash" id="hhFlash" role="status"></div>
      <div class="hh-help">${t('hab.help')}</div>`;
  }

  update(i) {
    setText($('hhZone'), i.zone);
    setText($('hhStatus'), i.status);
    setText($('hhPrompt'), i.prompt || '');
    setText($('hhFlash'), i.flash || '');
    $('hhPrompt').hidden = !i.prompt;
    $('hhFlash').hidden = !i.flash;
    $('hhBar').hidden = !i.cycling;
    if (i.cycling) $('hhBar').firstElementChild.style.width = `${Math.round(i.progress * 100)}%`;
    this.el.classList.toggle('suited', !i.helmetOff);
  }
}
