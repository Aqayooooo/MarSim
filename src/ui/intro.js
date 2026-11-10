// Karta „Jak zacząć” przy pierwszym otwarciu: trzy kroki i skrót do prezentacji. Pokazywana raz na przeglądarkę
// (pamięć lokalna; gdy niedostępna — przy każdym wejściu). Znika sama, gdy użytkownik zacznie EVA albo prezentację.
import { $ } from '../core/dom.js';

const KEY = 'marsim.intro.v1';

function seen() { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }
function remember() { try { localStorage.setItem(KEY, '1'); } catch { /* tryb prywatny — trudno */ } }

export class Intro {
  constructor(app, { play, show = true }) {
    this.el = $('intro');
    const close = (save = true) => { if (this.el.hidden) return; this.el.hidden = true; if (save) remember(); };
    $('introOk').addEventListener('click', () => close());
    $('introDemo').addEventListener('click', () => { close(); play(); });
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    app.on('phase', (phase) => { if (phase !== 'idle') close(); });
    app.on('director', (on) => { if (on) close(false); });
    app.on('view', (v) => { if (v !== 'map') close(false); });
    app.on('wpedit', (on) => { if (on) close(); });
    this.close = close;
    if (show && !seen()) this.el.hidden = false;
  }

  /** Ponowne pokazanie (z okna pomocy). */
  open() { this.el.hidden = false; $('introOk').focus(); }
}
