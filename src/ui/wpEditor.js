// Edytor punktów wyjścia (EVA) na mapie 2D: kliknięcie dodaje punkt, przeciągnięcie przesuwa, na liście — postój,
// kolejność i usuwanie. Działa tylko przed startem wyjścia; każda zmiana przelicza trasę (backend albo planer w przeglądarce).
import { $, esc } from '../core/dom.js';
import { t, tx } from '../i18n.js';
import { hm, int, km } from '../core/format.js';
import { MAIN_W, MAIN_H } from './map2d.js';

export const MAX_WAYPOINTS = 8;
const HIT_PX = 14, REPLAN_MS = 220, NEW_STOP_MIN = 10;

export class WaypointEditor {
  constructor(app, map, { picker }) {
    Object.assign(this, { app, map, picker });
    this.btn = $('wpBtn');
    this.card = $('wpEditor');
    this.on = false;
    this.drag = null;
    this.timer = null;
    this.status = null;          // busy | ok | fail
    this.btn.addEventListener('click', () => this.toggle());
    this.card.addEventListener('click', (e) => this.#click(e));
    this.card.addEventListener('change', (e) => this.#change(e));
    const c = map.c;
    c.addEventListener('pointerdown', (e) => this.#down(e));
    c.addEventListener('pointermove', (e) => this.#move(e));
    c.addEventListener('pointerup', () => this.#up());
    c.addEventListener('pointercancel', () => this.#up());
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.on && !e.target.closest?.('input')) this.toggle(false); });
    $('pickBtn').addEventListener('click', () => { if (this.on) this.toggle(false); });
    $('reportBtn').addEventListener('click', () => { if (this.on) this.toggle(false); });
    app.on('view', (v) => { if (v !== 'map' && this.on) this.toggle(false); this.btn.hidden = v !== 'map'; });
    app.on('phase', (p) => { if (p !== 'idle' && this.on) this.toggle(false); });
    app.on('director', (on) => { if (on && this.on) this.toggle(false); });
    app.on('waypoints', () => { if (this.on) this.#render(); });
    app.on('route', () => { if (this.on) this.#render(); });
  }

  toggle(on = !this.on) {
    if (on === this.on) return;
    if (on && !this.app.canEditWaypoints) { this.app.setAlert({ category: t('wpe.title'), text: t('wpe.locked') }); return; }
    if (on) {
      if (this.picker.on) this.picker.toggle(false);                  // tylko jeden tryb klikania mapy naraz
      if (this.app.state.reportMode) $('reportBtn').click();
      if (this.app.state.layers.hazards) this.app.toggleLayer('hazards', true);
    }
    this.on = on;
    this.app.state.wpEdit = on;
    this.btn.classList.toggle('on', on);
    this.btn.setAttribute('aria-pressed', String(on));
    $('main').classList.toggle('editing', on);
    this.card.hidden = !on;
    this.app.emit('wpedit', on);
    if (!on) { clearTimeout(this.timer); return; }
    this.status = this.app.state.route ? 'ok' : null;
    this.#render();
    if (!this.app.state.route) this.#replan(0);                       // od razu trasa bieżącego planu
  }

  // ---------- mapa ----------
  #px(e) {
    const r = this.map.c.getBoundingClientRect();
    return { px: (e.clientX - r.left) / r.width * MAIN_W, py: (e.clientY - r.top) / r.height * MAIN_H };
  }
  #hit(px, py) {
    return this.app.m.waypoints.findIndex((w) => Math.hypot(this.map.sx(w.x) - px, this.map.sy(w.y) - py) < HIT_PX);
  }

  #down(e) {
    if (!this.on || e.button !== 0) return;
    const { px, py } = this.#px(e), i = this.#hit(px, py);
    if (i >= 0) {
      this.drag = { i, moved: false };
      this.map.c.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      return;
    }
    const p = this.map.worldAt(e.clientX, e.clientY), list = this.app.m.waypoints;
    if (!p) return;
    if (list.length >= MAX_WAYPOINTS) { this.app.setAlert({ category: t('wpe.title'), text: t('wpe.max', { n: MAX_WAYPOINTS }) }); return; }
    this.app.setWaypoints([...list, { id: '', x: Math.round(p.x), y: Math.round(p.y), stopMin: NEW_STOP_MIN }]);
    this.#replan();
  }

  #move(e) {
    if (!this.drag) return;
    const p = this.map.worldAt(e.clientX, e.clientY);
    if (!p) return;
    const wp = this.app.m.waypoints[this.drag.i];          // mapa rysuje punkty co klatkę — widać ruch od razu
    wp.x = Math.round(p.x);
    wp.y = Math.round(p.y);
    this.drag.moved = true;
  }

  #up() {
    if (!this.drag) return;
    const { moved } = this.drag;
    this.drag = null;
    if (!moved) return;
    this.app.setWaypoints(this.app.m.waypoints);
    this.#replan();
  }

  // ---------- lista ----------
  #click(e) {
    const b = e.target.closest('button[data-a]');
    if (!b || b.disabled) return;
    const list = this.app.m.waypoints, i = Number(b.dataset.i);
    if (b.dataset.a === 'del' && list.length > 1) { this.app.setWaypoints(list.filter((_, k) => k !== i)); this.#replan(); }
    if (b.dataset.a === 'up' && i > 0) {
      const next = [...list];
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      this.app.setWaypoints(next);
      this.#replan();
    }
    if (b.dataset.a === 'reset') { this.app.restoreDefaultWaypoints(); this.#replan(); }
    if (b.dataset.a === 'done') this.toggle(false);
  }

  #change(e) {
    const input = e.target.closest('input[data-i]');
    if (!input) return;
    const wp = this.app.m.waypoints[Number(input.dataset.i)];
    if (!wp) return;
    wp.stopMin = Math.max(0, Math.min(120, Math.round(Number(input.value) || 0)));
    this.app.setWaypoints(this.app.m.waypoints);
    this.#replan();
  }

  #replan(ms = REPLAN_MS) {
    clearTimeout(this.timer);
    this.status = 'busy';
    this.#render();
    this.timer = setTimeout(async () => {
      const route = await this.app.planInitial({ animate: false, quiet: true });
      if (!this.on) return;
      this.status = route ? 'ok' : 'fail';
      this.#render();
    }, ms);
  }

  #render() {
    const app = this.app, list = app.m.waypoints, r = app.state.route, hazards = app.world.rasters.hazards;
    const rows = list.map((w, i) => {
      const nogo = hazards?.sample(w.x, w.y) === 2;
      return `<div class="wpe-row"><b>${esc(w.id)}</b>
        <span class="xy">${int(w.x)}, ${int(w.y)} m${nogo ? ` <span class="warn" title="${esc(t('wpe.nogo'))}" aria-label="${esc(t('wpe.nogo'))}">⚠</span>` : ''}</span>
        <label>${t('wpe.stop')} <input type="number" min="0" max="120" step="5" value="${int(w.stopMin ?? 0)}" data-i="${i}" aria-label="${esc(t('wpe.stopAria', { wp: w.id }))}"> min</label>
        <button class="btn mini" data-a="up" data-i="${i}" ${i ? '' : 'disabled'} aria-label="${esc(t('wpe.upAria', { wp: w.id }))}">↑</button>
        <button class="btn mini" data-a="del" data-i="${i}" ${list.length > 1 ? '' : 'disabled'} aria-label="${esc(t('wpe.delAria', { wp: w.id }))}">×</button></div>`;
    }).join('');
    const sum = this.status === 'busy' ? `<span class="muted">${t('wpe.busy')}</span>`
      : this.status === 'fail' ? `<span class="warn">${esc(tx(app.lastPlanError || t('noRoute')))}</span>`
        : r ? `${t('wpe.sum')} ${[km(r.lengthM), hm(r.durationH), r.o2L == null ? null : `${int(r.o2L)} L O₂`, esc(tx(r.rating))].filter(Boolean).join(' · ')}` : '';
    this.card.innerHTML = `<b>${t('wpe.title')}</b><p class="muted">${t('wpe.hint', { n: MAX_WAYPOINTS })}</p>
      <div class="wpe-list">${rows}</div><p class="wpe-sum" role="status">${sum}</p>
      <div class="pc-row"><button class="btn" data-a="reset" ${app.waypointsCustom ? '' : 'disabled'}>${t('wpe.reset')}</button>
        <button class="btn primary" data-a="done">${t('wpe.done')}</button></div>`;
  }
}
