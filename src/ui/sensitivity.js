// „Co jeśli”: trasa bieżącego planu przy innych limitach nachylenia (20–30°) oraz przedział tlenu i czasu wynikający
// z niepewności DTM i założeń modelu. Dane: backend /api/sensitivity; bez serwera — zapisana odpowiedź dla planu misji.
import { $, esc } from '../core/dom.js';
import { t, tx } from '../i18n.js';
import { hm, int, num } from '../core/format.js';

const WHATIF_COLOR = '#7FB2FF';
const sign = (v, f) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${f(Math.abs(v))}`;

/** Pobiera analizę dla bieżącego planu albo zwraca { ok:false, error }. */
export async function loadSensitivity(app) {
  if (app.remote) {
    try { return await app.ds.get('sensitivity'); } catch (e) { return { ok: false, error: e.message }; }
  }
  const sample = app.waypointsCustom ? null : await app.ds.sample('sensitivity');
  return sample || { ok: false, error: t('sens.needBackend') };
}

/** Przedział niepewności trasy (tlen, czas) jako krótki blok HTML. */
export function intervalHtml(u) {
  if (!u) return '';
  return `<p class="sens-int"><b>${t('sens.o2', { mid: num(u.o2L.mid, 0), low: num(u.o2L.low, 0), high: num(u.o2L.high, 0) })}</b> · `
    + `<b>${t('sens.time', { mid: hm(u.durationH.mid), low: hm(u.durationH.low), high: hm(u.durationH.high) })}</b></p>`
    + `<p class="note">${t('sens.note', { e: u.assumptions.effortPct, s: u.assumptions.speedPct })}</p>`;
}

/** Czy w całym zakresie limitów trasa jest praktycznie ta sama (±1% długości i tlenu). */
export function robust(variants) {
  const ok = variants.filter((v) => v.ok);
  if (ok.length !== variants.length || !ok.length) return false;
  const [a] = ok;
  return ok.every((v) => Math.abs(v.lengthM - a.lengthM) <= 0.01 * a.lengthM && Math.abs(v.o2L - a.o2L) <= 0.01 * a.o2L);
}

/** Tabela wariantów: limit, długość, czas, tlen; bieżący limit wyróżniony. */
export function variantsTable(d, selected = null) {
  const rows = d.variants.map((v, i) => {
    const cur = v.maxSlopeDeg === d.currentMaxSlopeDeg, on = i === selected;
    return `<tr class="${cur ? 'cur' : ''}${on ? ' on' : ''}"><td>${num(v.maxSlopeDeg, 1)}°${cur ? ` <span class="muted">${t('sens.current')}</span>` : ''}</td>`
      + (v.ok ? `<td>${int(v.lengthM)} m</td><td>${hm(v.durationH)}</td><td>${num(v.o2L, 0)} L</td>` : `<td colspan="3" class="warn">${esc(tx(v.error))}</td>`) + '</tr>';
  }).join('');
  return `<table class="sens-table"><tr><th>${t('sens.thLimit')}</th><th>${t('sens.thLen')}</th><th>${t('sens.thTime')}</th><th>O₂</th></tr>${rows}</table>`;
}

export class Sensitivity {
  constructor(app) {
    this.app = app;
    this.btn = $('sensBtn');
    this.card = $('sensCard');
    this.on = false;
    this.data = null;
    this.idx = 0;
    this.btn.addEventListener('click', () => this.toggle());
    this.card.addEventListener('input', (e) => { if (e.target.id === 'sensRange') this.#select(Number(e.target.value)); });
    this.card.addEventListener('click', (e) => { if (e.target.closest('[data-a="close"]')) this.toggle(false); });
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.on) this.toggle(false); });
    app.on('route', () => { this.#syncButton(); if (this.on) this.#load(); });
    app.on('view', () => { this.#syncButton(); if (this.app.state.view !== 'map' && this.on) this.toggle(false); });
    app.on('reset', () => this.toggle(false));
    app.on('wpedit', (on) => { if (on && this.on) this.toggle(false); });
  }

  #syncButton() { this.btn.hidden = this.app.state.view !== 'map' || !this.app.state.route; }

  toggle(on = !this.on) {
    if (on === this.on) return;
    this.on = on;
    this.btn.classList.toggle('on', on);
    this.btn.setAttribute('aria-expanded', String(on));
    this.card.hidden = !on;
    if (!on) { this.app.state.whatIf = null; return; }
    this.#load();
  }

  async #load() {
    const route = this.app.state.route;
    this.card.innerHTML = `<b>${t('sens.title')}</b><p class="muted">${t('sens.loading')}</p>`;
    const d = await loadSensitivity(this.app);
    if (!this.on || this.app.state.route !== route) return;
    this.data = d;
    if (!d.ok) { this.app.state.whatIf = null; this.#render(); return; }
    const cur = d.variants.findIndex((v) => v.maxSlopeDeg === d.currentMaxSlopeDeg);
    this.#select(cur >= 0 ? cur : 0);
  }

  #select(i) {
    this.idx = i;
    const v = this.data?.variants?.[i];
    this.app.state.whatIf = v?.ok && v.maxSlopeDeg !== this.data.currentMaxSlopeDeg ? { path: v.path, color: WHATIF_COLOR, label: `${num(v.maxSlopeDeg, 1)}°` } : null;
    if (!this.card.querySelector('#sensRange')) this.#render();   // suwak zostaje — przeciąganie nie jest przerywane
    else this.#renderLine();
  }

  /** Wiersz z wynikiem dla wybranego limitu (aktualizowany przy przesuwaniu suwaka). */
  #renderLine() {
    const d = this.data, v = d.variants[this.idx], base = d.variants.find((x) => x.maxSlopeDeg === d.currentMaxSlopeDeg);
    let line;
    if (!v.ok) line = `<span class="warn">${esc(t('sens.none', { e: tx(v.error) }))}</span>`;
    else {
      const stats = `${int(v.lengthM)} m · ${hm(v.durationH)} · ${num(v.o2L, 0)} L O₂ · ${t('sens.caution', { m: int(v.cautionM) })}`;
      const delta = !base?.ok || v === base ? '' : Math.abs(v.lengthM - base.lengthM) <= 2 && Math.abs(v.o2L - base.o2L) < 0.5 ? t('sens.same')
        : `${sign(v.lengthM - base.lengthM, (x) => `${int(x)} m`)} · ${sign(Math.round((v.durationH - base.durationH) * 60), (x) => `${int(x)} min`)} · ${sign(v.o2L - base.o2L, (x) => `${num(x, 1)} L O₂`)}`;
      line = `${t('sens.at', { deg: num(v.maxSlopeDeg, 1) })} <b>${stats}</b>${delta ? `<br><span class="muted">${t('sens.delta', { d: delta })}</span>` : ''}`;
    }
    this.card.querySelector('.sens-line').innerHTML = line;
    this.card.querySelector('#sensRange').setAttribute('aria-valuetext', `${num(v.maxSlopeDeg, 1)}°`);
  }

  #render() {
    const d = this.data;
    if (!d?.ok) {
      this.card.innerHTML = `<b>${t('sens.title')}</b><p class="warn">${esc(tx(d?.error || t('noRoute')))}</p><div class="pc-row"><button class="btn" data-a="close">${t('wpe.done')}</button></div>`;
      return;
    }
    const ticks = d.variants.map((x) => `<span>${num(x.maxSlopeDeg, 1)}°</span>`).join('');
    this.card.innerHTML = `<b>${t('sens.title')}</b>
      <label class="sens-slider"><span>${t('sens.limit')}</span>
        <input id="sensRange" type="range" min="0" max="${d.variants.length - 1}" step="1" value="${this.idx}"></label>
      <div class="sens-ticks">${ticks}</div>
      <p class="sens-line"></p>
      ${robust(d.variants) ? `<p class="ok">${t('sens.robust')}</p>` : ''}
      <h3>${t('sens.interval')}</h3>${intervalHtml(d.interval)}
      <div class="pc-row"><button class="btn" data-a="close">${t('wpe.done')}</button></div>`;
    this.#renderLine();
  }
}
