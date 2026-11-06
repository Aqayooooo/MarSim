// Panele boczne i nakładki DOM nad mapą. Aktualizowane z pętli, zmieniają DOM tylko przy zmianie.
import { num, int, hm, clock, km, parseClock } from '../core/format.js';

const $ = (id) => document.getElementById(id);
function setText(el, v) { if (el.textContent !== v) el.textContent = v; }
function setHidden(el, h) { if (el.hidden !== h) el.hidden = h; }
function setClass(el, c, on) { if (el.classList.contains(c) !== on) el.classList.toggle(c, on); }

export class Panels {
  constructor(app) {
    this.app = app;
    const m = app.m;
    setText($('missionTitle'), m.mission.title);
    setText($('sourceLabel'), m.mission.sourceLabel);
    setText($('locLabel'), m.area.label);
    this.#buildLayers();
    this.#buildO2();
    const wp = m.waypoints.find((w) => w.view) || m.waypoints[m.waypoints.length - 1];
    this.viewWp = wp.id;
    setText($('wpViewHead'), `Widok w ${wp.id}`);
    setText($('wpLocked'), `odblokuje się w ${wp.id}`);
    app.on('layers', () => this.#syncLayers());
    app.on('reset', () => { this.#syncLayers(); $('wpView').classList.remove('open'); });
    app.on('wpview', (id) => this.#showWpView(id));
    this.#syncLayers();
  }

  #buildLayers() {
    const list = $('layerList');
    list.innerHTML = '';
    this.rows = {};
    for (const l of this.app.m.layers) {
      const r = document.createElement('div');
      r.className = 'lrow';
      r.tabIndex = 0;
      r.setAttribute('role', 'switch');
      r.innerHTML = `<i class="sw"></i><div class="nm"></div><div class="ds"></div><span class="tg"></span>`;
      r.querySelector('.nm').textContent = l.name;
      r.querySelector('.ds').textContent = l.desc;
      const toggle = () => this.app.toggleLayer(l.id);
      r.addEventListener('click', toggle);
      r.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } });
      list.appendChild(r);
      this.rows[l.id] = r;
    }
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
      w.innerHTML = `<span>Godzina LTST: <b></b></span><input type="range" min="${hrs[0]}" max="${hrs[hrs.length - 1]}" step="1">`;
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
      d.querySelector('span').textContent = e.text;
      lg.appendChild(d);
    }
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
      return { fill: r.querySelector('i'), val: r.querySelector('span'), tele: r.querySelector('.tele') };
    });
  }

  #showWpView(id) {
    if (id !== this.viewWp) return;
    const v = this.app.state.wpView[id];
    const box = $('wpView');
    box.querySelector('img').src = v.src;
    setText(box.querySelector('.cap'), v.caption);
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
    setText($('cTemp').querySelector('.cl'), snap ? 'Grunt °C' : 'Temp. °C');
    setText($('cTemp').querySelector('.cv'), on ? int(snap ? snap.env.groundTempC : tempAt(env.temperature, sim.min)) : '--');
    setText($('cTau').querySelector('.cv'), on ? num(snap ? snap.env.tau : env.dustTau, 2) : '--');
    const career = snap?.crew?.length ? Math.max(...snap.crew.map((c) => c.career.fraction)) : null;
    setText($('cDoseSub'), on && career !== null ? `limit kariery ${num(career * 100, 0)}%` : '');
    setClass($('cDose'), 'hi', st.doseHi);
    // tlen i zapas
    sim.crew.forEach((c, i) => {
      const p = Math.round(c.o2);
      const w = `${(c.o2 / 100) * 190}px`;
      if (this.o2[i].fill.style.width !== w) this.o2[i].fill.style.width = w;
      setText(this.o2[i].val, `${p}%`);
      const t = snap?.crew?.[i];
      setText(this.o2[i].tele, t ? `CO₂ ${num(t.co2mmHg, 1)} mmHg · bat ${int(t.batteryPct)}% · ♥ ${t.hr} · ${num(t.pressureKPa, 1)} kPa` : '');
    });
    setText($('reserve'), hm(sim.reserveH()));
    // nakładki mapy
    const isMap = st.view === 'map';
    const r = st.route;
    const card = $('routeCard');
    setHidden(card, !(isMap && r && app.now >= st.routeCardAt));
    if (r) {
      const u = r.uncertainty, dem = app.m.dem;
      const extra = u ? `<br><span class="u">nachylenie maks. ${num(u.maxSlopeDeg, 0)}° ±${num(Math.max(1, u.maxSlopeSigmaDeg), 0)}° · DTM ${dem.year || ''}</span>`
        + `<br><span class="u">piasek ≤ ${num(u.maxSandProb * 100, 0)}% · O₂ ${int(r.o2L ?? 0)} L</span>` : '';
      const html = `<b>TRASA ${r.letter}</b> <span class="g">${r.rating}</span><br>${km(r.lengthM)} · ${hm(r.durationH)}<br>${r.stops} ${plural(r.stops)}${extra}`;
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

function plural(n) { return n === 1 ? 'przystanek' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? 'przystanki' : 'przystanków'; }

export function tempAt(curve, min) {
  const pts = curve.map(([c, t]) => [parseClock(c), t]);
  if (min <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (min <= pts[i][0]) { const [a, ta] = pts[i - 1], [b, tb] = pts[i]; return ta + (tb - ta) * (min - a) / (b - a); }
  }
  return pts[pts.length - 1][1];
}
