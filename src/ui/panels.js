// Panele boczne i nakładki DOM nad mapą. Aktualizowane z pętli, zmieniają DOM tylko przy zmianie.
import { num, int, hm, clock, km, parseClock } from '../core/format.js';
import { $, esc, setText, setHidden, setClass } from '../core/dom.js';
import { t, tx, plural } from '../i18n.js';
import { layerKey } from './help.js';

const O2_BAR_PX = 190;
const O2_LOW_PCT = 40, O2_CRITICAL_PCT = 25;        // progi kolorów jak na urządzeniu w hełmie
const RESERVE_LOW_H = 1, RESERVE_CRITICAL_H = 0.3;

export class Panels {
  constructor(app) {
    this.app = app;
    const m = app.m;
    setText($('missionTitle'), tx(m.mission.title));
    $('missionTitle').title = tx(m.mission.title);
    $('sourceLabel').title = tx(m.mission.sourceLabel);
    setText($('sourceLabel'), tx(m.mission.sourceLabel));
    setText($('locLabel'), tx(m.area.label));
    this.#buildLayers();
    this.#buildO2();
    this.#syncWpView();
    app.on('waypoints', () => this.#syncWpView());
    app.on('layers', () => this.#syncLayers());
    app.on('reset', () => { this.#syncLayers(); $('wpView').classList.remove('open'); });
    app.on('wpview', (id) => this.#showWpView(id));
    this.#syncLayers();
  }

  #buildLayers() {
    const list = $('layerList');
    list.innerHTML = '';
    this.rows = {};
    this.app.m.layers.forEach((l, index) => {
      const r = document.createElement('div');
      r.className = 'lrow';
      r.tabIndex = 0;
      r.setAttribute('role', 'switch');
      const key = layerKey(index);
      r.innerHTML = `<i class="sw"></i><div class="nm"></div><div class="ds"></div>${key ? `<span class="key" aria-hidden="true">${key}</span>` : ''}<span class="tg"></span>`;
      r.querySelector('.nm').textContent = tx(l.name);
      r.querySelector('.ds').textContent = tx(l.desc);
      r.setAttribute('aria-label', `${tx(l.name)}: ${tx(l.desc)}`);
      const toggle = () => this.app.toggleLayer(l.id);
      r.addEventListener('click', toggle);
      r.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } });
      list.appendChild(r);
      this.rows[l.id] = r;
    });
  }

  #syncLayers() {
    const st = this.app.state;
    for (const l of this.app.m.layers) {
      const r = this.rows[l.id], on = st.layers[l.id].on;
      setClass(r, 'on', on);
      setClass(r, 'hi', st.focus === l.id);
      r.setAttribute('aria-checked', String(on));
      r.querySelector('.sw').style.background = on ? l.colorOn : l.colorOff;
    }
    const L = this.app.m.layers.find((l) => l.id === st.legend);
    const lg = $('legend');
    lg.innerHTML = '';
    if (st.legend === 'shadow' && this.app.world.rasters.shadow) {
      const hrs = this.app.world.rasters.shadow.hours, w = document.createElement('div');
      w.className = 'hourpick';
      w.innerHTML = `<span>${t('shadow.hour')} <b></b></span><input type="range" min="${hrs[0]}" max="${hrs[hrs.length - 1]}" step="1" aria-label="${t('shadow.hour')}">`;
      const inp = w.querySelector('input'), b = w.querySelector('b');
      inp.value = this.app.shadowHour; b.textContent = `${String(this.app.shadowHour).padStart(2, '0')}:00`;
      inp.addEventListener('input', () => { b.textContent = `${String(inp.value).padStart(2, '0')}:00`; this.app.shadowHour = +inp.value; });
      lg.appendChild(w);
    }
    for (const e of L?.legend || []) {
      const d = document.createElement('div');
      d.className = 'lg';
      d.innerHTML = '<i></i><span></span>';
      d.querySelector('i').style.background = e.color;
      d.querySelector('span').textContent = tx(e.text);
      lg.appendChild(d);
    }
  }

  /** Punkt z widokiem terenu: wskazany w misji albo ostatni punkt planu. */
  #syncWpView() {
    const wps = this.app.m.waypoints, wp = wps.find((w) => w.view) || wps[wps.length - 1];
    this.viewWp = wp.id;
    setText($('wpViewHead'), t('wp.view', { wp: wp.id }));
    setText($('wpLocked'), t('wp.locked', { wp: wp.id }));
    $('wpShot').querySelector('img').alt = t('wp.alt', { wp: wp.id });
  }

  #buildO2() {
    const box = $('o2Rows');
    box.innerHTML = '';
    this.o2 = this.app.m.crew.map((c) => {
      const r = document.createElement('div');
      r.className = 'o2';
      r.innerHTML = `<div class="o2top"><b></b><div class="bar"><i></i></div><span></span></div><div class="tele"></div>`;
      r.querySelector('b').textContent = c.id;
      box.appendChild(r);
      return { row: r, bar: r.querySelector('.bar'), fill: r.querySelector('i'), val: r.querySelector('span'), tele: r.querySelector('.tele') };
    });
  }

  #showWpView(id) {
    if (id !== this.viewWp) return;
    const v = this.app.state.wpView[id];
    const box = $('wpView');
    box.querySelector('img').src = v.src;
    setText(box.querySelector('.cap'), `${tx(v.caption)} · ${t('wp.note')}`);
    requestAnimationFrame(() => box.classList.add('open'));
  }

  /** Wywoływane w każdej klatce. */
  update() {
    const app = this.app, st = app.state, sim = app.sim, m = app.m;
    // zegar i środowisko
    const snap = sim.snap;
    const link = snap?.link;
    setText($('clock'), `SOL ${m.mission.sol} · ${clock(sim.min)}${link ? ` ⇄${num(link.oneWayMin, 0)}′${link.up ? '' : '✕'}` : ''}`);
    const env = m.environment, on = app.envOn;
    setText($('cDose').querySelector('.cv'), on ? int(snap ? snap.env.doseUsvh : env.doseUsvh) : '--');
    setText($('cWind').querySelector('.cv'), on ? num(st.wind, 1) : '--');
    setText($('cTemp').querySelector('.cl'), snap ? t('card.ground') : t('card.temp'));
    setText($('cTemp').querySelector('.cv'), on ? int(snap ? snap.env.groundTempC : tempAt(env.temperature, sim.min)) : '--');
    setText($('cTau').querySelector('.cv'), on ? num(snap ? snap.env.tau : env.dustTau, 2) : '--');
    const career = snap?.crew?.length ? Math.max(...snap.crew.map((c) => c.career.fraction)) : null;
    setText($('cDoseSub'), on && career !== null ? t('card.career', { p: num(career * 100, 0) }) : '');
    setClass($('cDose'), 'hi', st.doseHi);
    // tlen i zapas
    // wiersze według identyfikatora: harmonogram może wysłać tylko część załogi
    const present = new Set(sim.crew.map((c) => c.id));
    m.crew.forEach((c, k) => { this.o2[k].row.hidden = !present.has(c.id); });
    sim.crew.forEach((c, j) => {
      const i = m.crew.findIndex((x) => x.id === c.id);
      if (i < 0) return;
      const p = Math.round(c.o2);
      const w = `${(c.o2 / 100) * O2_BAR_PX}px`;
      if (this.o2[i].fill.style.width !== w) this.o2[i].fill.style.width = w;
      setClass(this.o2[i].bar, 'low', p <= O2_LOW_PCT && p > O2_CRITICAL_PCT);
      setClass(this.o2[i].bar, 'crit', p <= O2_CRITICAL_PCT);
      setText(this.o2[i].val, `${p}%`);
      const tl = snap?.crew?.[j];
      setText(this.o2[i].tele, tl ? t('tele', { co2: num(tl.co2mmHg, 1), bat: int(tl.batteryPct), hr: tl.hr, kpa: num(tl.pressureKPa, 1) }) : '');
    });
    const reserveH = sim.reserveH(), underway = app.phase !== 'idle' && app.phase !== 'done';
    setText($('reserve'), hm(reserveH));
    setClass($('reserve'), 'low', underway && reserveH <= RESERVE_LOW_H && reserveH > RESERVE_CRITICAL_H);
    setClass($('reserve'), 'crit', underway && reserveH <= RESERVE_CRITICAL_H);
    // nakładki mapy
    const isMap = st.view === 'map';
    const r = st.route;
    const card = $('routeCard');
    setHidden(card, !(isMap && r && app.now >= st.routeCardAt));
    if (r) {
      const u = r.uncertainty, dem = app.m.dem;
      const extra = u ? `<br><span class="u">${t('route.slope', { s: num(u.maxSlopeDeg, 0), sg: num(Math.max(1, u.maxSlopeSigmaDeg), 0), y: esc(dem.year) || '' })}</span>`
        + `<br><span class="u">${t(r.o2L == null ? 'route.sandOnly' : 'route.sand', { p: num(u.maxSandProb * 100, 0), o2: int(r.o2L ?? 0) })}</span>` : '';
      const html = `<b>${t('route', { l: esc(r.letter) })}</b> <span class="g">${esc(tx(r.rating))}</span><br>${km(r.lengthM)} · ${hm(r.durationH)}<br>${esc(r.stops)} ${plural(r.stops)}${extra}`;
      if (card.dataset.k !== html) { card.innerHTML = html; card.dataset.k = html; }
    }
    const al = $('alert');
    setHidden(al, !(st.alert && isMap));
    if (st.alert) { setText(al.querySelector('.a1'), st.alert.category); setText(al.querySelector('.a2'), st.alert.text); }
    const cap = $('caption');
    setHidden(cap, !st.caption);
    if (st.caption) { setText(cap.querySelector('.n'), st.caption.n); setText(cap.querySelector('.t'), st.caption.text); }
    setHidden($('scale'), !isMap);
    setHidden($('locLabel'), !isMap);
    setClass($('fade'), 'on', st.fadeOut);
  }
}


export function tempAt(curve, min) {
  const pts = curve.map(([c, t]) => [parseClock(c), t]);
  if (min <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (min <= pts[i][0]) { const [a, ta] = pts[i - 1], [b, tb] = pts[i]; return ta + (tb - ta) * (min - a) / (b - a); }
  }
  return pts[pts.length - 1][1];
}
