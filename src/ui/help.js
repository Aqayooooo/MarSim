// Skróty klawiszowe i okno pomocy (klawisz „?”).
import { $, esc, isTyping } from '../core/dom.js';
import { t } from '../i18n.js';

const VIEW_KEYS = { m: 'map', o: 'orbit', h: 'helmet', u: 'device', r: 'report', g: 'schedule' };
const LAYER_KEYS = '1234567890';

/** Skrót klawiszowy warstwy o danym numerze na liście (1–9, potem 0) albo null. */
export const layerKey = (index) => LAYER_KEYS[index] ?? null;

export class Help {
  /** actions: { setView, toggleEva, returnHome, toggleCompare, toggleProfile } */
  constructor(app, actions, { footer = '' } = {}) {
    this.app = app;
    this.actions = actions;
    this.el = $('help');
    this.dialog = this.el.querySelector('.dialog');
    this.lastFocus = null;
    $('helpBody').innerHTML = this.#content();
    $('versionLabel').textContent = footer;
    $('helpBtn').addEventListener('click', () => this.toggle());
    $('helpClose').addEventListener('click', () => this.toggle(false));
    this.el.addEventListener('mousedown', (e) => { if (e.target === this.el) this.toggle(false); });
    addEventListener('keydown', (e) => this.#key(e));
  }

  get open() { return !this.el.hidden; }

  toggle(on = !this.open) {
    if (on === this.open) return;
    this.el.hidden = !on;
    if (on) { this.lastFocus = document.activeElement; this.dialog.focus(); }
    else this.lastFocus?.focus?.();
  }

  #content() {
    const row = (keys, label) => `<div><span>${esc(t(label))}</span><span>${keys.map((k) => `<kbd>${esc(k)}</kbd>`).join(' ')}</span></div>`;
    const views = Object.entries(VIEW_KEYS).map(([key, view]) => row([key.toUpperCase()], `view.${view}`)).join('');
    return `<div class="keys">
      <h3>${esc(t('help.g.views'))}</h3>${views}
      <h3>${esc(t('help.g.eva'))}</h3>${row([t('key.space')], 'help.k.eva')}${row(['B'], 'help.k.return')}
      <h3>${esc(t('help.g.map'))}</h3>${row(['1–9', '0'], 'help.k.layers')}${row(['C'], 'help.k.compare')}${row(['P'], 'help.k.profile')}${row(['?'], 'help.k.help')}${row(['Esc'], 'help.k.esc')}
      <h3>${esc(t('help.g.move'))}</h3>${row(['W A S D', '← ↑ ↓ →'], 'help.k.walk')}${row(['Shift'], 'help.k.run')}${row([t('key.space'), '+', '−'], 'help.k.drive')}${row(['C'], 'help.k.cabin')}
    </div>`;
  }

  #key(e) {
    if (e.key === 'Escape' && this.open) { this.toggle(false); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
    if (e.key === '?') { e.preventDefault(); this.toggle(); return; }
    if (this.open) return;
    const app = this.app, key = e.key.toLowerCase(), view = app.state.view;
    const driving = !!app.drive;       // jazda łazikiem ma własne klawisze (spacja, C)

    const layer = LAYER_KEYS.indexOf(e.key);
    if (layer >= 0 && app.m.layers[layer]) { app.toggleLayer(app.m.layers[layer].id); return; }
    if (VIEW_KEYS[key]) { this.actions.setView(VIEW_KEYS[key]); return; }
    if (e.code === 'Space' && !driving && !e.target.closest?.('button, [role="switch"], [role="button"], a')) {
      e.preventDefault();
      this.actions.toggleEva();
      return;
    }
    if (key === 'b') { this.actions.returnHome(); return; }
    if (view !== 'map' || driving) return;
    if (key === 'c') this.actions.toggleCompare();
    if (key === 'p') this.actions.toggleProfile();
  }
}
