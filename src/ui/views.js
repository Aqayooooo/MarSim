// Widoki dodatkowe: urządzenie w hełmie (mały ekran), raport ryzyka, plan wyjść, zgłoszenia z terenu.
import { intervalHtml, loadSensitivity, robust, variantsTable } from './sensitivity.js';
import { $, esc } from '../core/dom.js';
import { num, int, hm, clock, km as kmFmt } from '../core/format.js';
import { headingDeg } from '../core/path.js';
import { MAIN_W, MAIN_H, ALT_COLORS } from './map2d.js';
import { t, tx } from '../i18n.js';
import { Drive } from '../core/drive.js';

const NEED_BACKEND = () => `<h2>${t('need.title')}</h2><p class="muted">${t('need.text')}</p>`;
// bez serwera: zapisane odpowiedzi backendu (tools/export_backend_sample.py), tylko do odczytu
const SAMPLE_NOTE = (meta) => `<p class="sampleNote">${t('sample.note', { d: esc(String(meta?.generatedUtc ?? '').slice(0, 10) || '—') })}</p>`;

// ---------------- urządzenie w hełmie ----------------
export class DeviceView {
  constructor(app) {
    this.app = app;
    this.el = $('device');
    this.el.innerHTML = `<div class="dev" role="region" aria-label="${t('view.device')}">
      <div class="top"><span id="dvWho">EV1</span><span id="dvClock">--:--</span><span id="dvLink">⇄</span></div>
      <div class="cell"><span class="k">O₂</span><span class="v" id="dvO2">--</span><span class="s" id="dvO2s"></span></div>
      <div class="cell"><span class="k">${t('dev.return')}</span><span class="v" id="dvWb">--</span><span class="s">${t('dev.returnSub')}</span></div>
      <div class="cell nav"><span class="k" id="dvTgt">${t('dev.target')}</span>
        <svg viewBox="-50 -50 100 100" aria-hidden="true"><circle r="46" fill="none" stroke="#333" stroke-width="2"/><path id="dvArrow" d="M0,-38 L14,10 L0,2 L-14,10 Z" fill="#FFDC52"/></svg>
        <span class="v dist" id="dvDist">--</span><span class="s">${t('dev.meters')}</span></div>
      <div class="cell"><span class="k">CO₂</span><span class="v" id="dvCo2">--</span><span class="s">mmHg</span></div>
      <div class="cell"><span class="k">${t('dev.battery')}</span><span class="v" id="dvBat">--</span><span class="s" id="dvHr"></span></div>
      <div class="msg ok" id="dvMsg" role="status">OK</div></div>
      <div class="devnote">${t('dev.note')}</div>`;
  }

  update() {
    const app = this.app, sim = app.sim, snap = sim.snap, c = snap?.crew?.[0], r = app.state.route;
    const set = (id, v, cls) => { const e = $(id); if (e.textContent !== v) e.textContent = v; if (cls !== undefined) e.className = `v ${cls}`; };
    $('dvWho').textContent = `${sim.crew[0]?.id ?? app.m.crew[0].id} · ${t('dev.route')} ${r?.letter ?? '—'}`;
    $('dvClock').textContent = `${clock(sim.min)} LTST`;
    const o2 = c ? c.o2Pct : sim.crew[0].o2;
    set('dvO2', `${Math.round(o2)}%`, o2 > 40 ? 'ok' : o2 > 25 ? 'warnc' : 'bad');
    $('dvO2s').textContent = c ? `${int(c.o2L)} L` : '';
    const wbH = sim.reserveH();
    set('dvWb', hm(wbH).replace(' h', ''), wbH > 1 ? 'ok' : wbH > 0.3 ? 'warnc' : 'bad');
    set('dvCo2', c ? num(c.co2mmHg, 1) : '—', !c ? '' : c.co2mmHg < 4 ? 'ok' : c.co2mmHg < 7.6 ? 'warnc' : 'bad');
    set('dvBat', c ? `${int(c.batteryPct)}%` : '—', !c ? '' : c.batteryPct > 30 ? 'ok' : 'warnc');
    $('dvHr').textContent = c ? `♥ ${c.hr} · ${int(c.metabolicW)} W` : '';
    const link = snap?.link;
    $('dvLink').textContent = c ? `${c.comms > 0 ? t('dev.habitat') : t('dev.noLink')}${link ? ` · ${t('dev.earth')} ${num(link.oneWayMin, 0)}′` : ''}` : '';
    // nawigacja do następnego punktu
    const wp = app.navTarget();
    const p = sim.crewPos(0);
    let rel = 0;
    if (r) {
      const brg = headingDeg(wp.x - p.x, wp.y - p.y);
      const hdg = r.poly.heading(Math.min(sim.crewS + 2, r.poly.length - 1));
      rel = brg - hdg;
      $('dvTgt').textContent = wp.reached ? `${wp.id} ✓` : wp.id;
      $('dvDist').textContent = String(Math.round(Math.hypot(wp.x - p.x, wp.y - p.y)));
    } else {
      $('dvTgt').textContent = t('dev.target');
      $('dvDist').textContent = '—';
    }
    $('dvArrow').setAttribute('transform', `rotate(${rel})`);
    // jeden komunikat — najważniejszy
    const walking = sim.running && (app.phase === 'walking' || app.phase === 'returning');
    let msg = `OK · ${walking ? t('dev.walk') : t('dev.stop')}`, cls = 'ok';
    if (c && !c.walkback.ok) { msg = t('dev.goBack'); cls = 'bad'; }
    else if (sim.sep) { msg = t('dev.sep'); cls = 'bad'; }
    else if (c && c.zone === 2) { msg = t('dev.nogo'); cls = 'bad'; }
    else if (c && c.comms === 0) { msg = t('dev.nocomms'); cls = 'warnc'; }
    else if (wbH < 0.5) { msg = t('dev.lowReserve'); cls = 'warnc'; }
    const m = $('dvMsg');
    if (m.textContent !== msg) { m.textContent = msg; m.className = `msg ${cls}`; }
  }
}

// ---------------- raport ----------------
export class ReportView {
  constructor(app) { this.app = app; this.el = $('report'); }

  async open() {
    if (!this.app.remote) {
      const [rep, sw, log, state, meta, sens] = await Promise.all(['report', 'spaceweather', 'log', 'state', 'meta', 'sensitivity'].map((n) => this.app.ds.sample(n)));
      if (!rep) { this.el.innerHTML = NEED_BACKEND(); return; }
      this.render(rep, sw || { summary: '—' }, log || { events: [] }, { sample: meta, snap: state, sens });
      return;
    }
    this.el.innerHTML = `<p class="muted">${t('rep.loading')}</p>`;
    try {
      const [rep, sw, log, audit, sens] = await Promise.all([this.app.ds.get('report'), this.app.ds.get('spaceweather'),
        this.app.ds.get('log?limit=12').catch(() => ({ events: [] })), this.app.ds.get('log/verify').catch(() => null), loadSensitivity(this.app)]);
      this.render(rep, sw, log, { audit, sens });
    } catch (e) { this.el.innerHTML = `<p class="warn">${esc(t('rep.error', { e: e.message }))}</p>`; }
  }

  render(r, sw, log, { sample = null, snap: sampleSnap = null, audit = null, sens = null } = {}) {
    if (!r.ok) { this.el.innerHTML = `<h2>${t('rep.title')}</h2><p class="muted">${esc(tx(r.error))}</p>`; return; }
    const e = r.effectiveness, snap = sampleSnap || this.app.sim.snap;
    const riskClass = (likelihood, severity) => { const v = likelihood * severity; return v >= 15 ? 'r-hi' : v >= 8 ? 'r-mid' : 'r-lo'; };
    const P = t('rep.matrixP'), S = t('rep.matrixS');
    let matrix = '<div class="matrix" role="table"><div class="ax"></div>' + [1, 2, 3, 4, 5].map((s) => `<div class="ax top">${S}${s}</div>`).join('');
    r.riskMatrix.forEach((row, i) => {
      const l = 5 - i;
      matrix += `<div class="ax">${P}${l}</div>` + row.map((n, j) => `<div class="${riskClass(l, j + 1)}">${esc(n || '')}</div>`).join('');
    });
    matrix += `</div><p class="note">${t('rep.matrixNote')}</p>`;
    const assumptions = (r.assumptions || []).map((a) => `<div><dt>${esc(t(`as.${a.id}`))}</dt><dd>${esc(num(a.value, Number.isInteger(a.value) ? 0 : 2))}${a.unit ? ` ${esc(a.unit)}` : ''}</dd></div>`).join('');
    const auditBadge = !audit ? '' : audit.ok
      ? ` <span class="badge good">${esc(t('rep.auditOk', { n: audit.checked }))}</span>`
      : ` <span class="badge poor">${esc(t('rep.auditBad', { id: audit.brokenAt }))}</span>`;
    const link = snap?.link, pv = r.provenance;
    const events = log?.events || [];
    this.el.innerHTML = `${sample ? SAMPLE_NOTE(sample) : ''}
      <h2>${t('rep.summary')}</h2>
      <ul class="summary">${r.summary.map((s) => `<li>${esc(tx(s))}</li>`).join('')}</ul>
      <h2>${t('rep.eff')}</h2>
      <div class="kpis">
        <div class="kpi"><b>${num(e.probabilityComplete * 100, 0)}%</b><span>${t('rep.kComplete')}</span></div>
        <div class="kpi"><b>${int(e.o2MarginL)} L</b><span>${t('rep.kO2')}</span></div>
        <div class="kpi"><b>${num(e.routeEfficiency * 100, 0)}%</b><span>${t('rep.kEff')}</span></div>
        <div class="kpi"><b>${hm(e.durationH)}</b><span>${t('rep.kDur')}</span></div>
      </div>
      <p class="note">${esc(tx(e.note))}</p>
      <h2>${t('rep.hazards')}</h2>
      <div class="two"><table><tr><th>#</th><th>${t('rep.thHazard')}</th><th>${t('rep.thRisk')}</th><th>${t('rep.thValue')}</th><th>${t('rep.thBasis')}</th><th>${t('rep.thMit')}</th></tr>
        ${r.hazards.map((h) => `<tr><td>${esc(h.id)}</td><td>${esc(tx(h.hazard))}</td><td><span class="lvl">${esc(tx(h.level))} ${esc(h.likelihood)}×${esc(h.severity)}</span></td>
          <td>${esc(tx(h.value))}</td><td class="muted">${esc(tx(h.basis))}</td><td class="muted">${esc(tx(h.mitigation))}</td></tr>`).join('')}</table>
        <div>${matrix}</div></div>
      ${assumptions ? `<h2>${t('rep.assume')}</h2><dl class="facts">${assumptions}</dl><p class="note">${t('rep.assumeNote')}</p>` : ''}
      ${r.uncertainty || sens?.ok ? `<h2>${t('rep.sens')}</h2>${intervalHtml(r.uncertainty || sens.interval)}
        ${sens?.ok ? `<p class="muted">${t('rep.sensLead')}</p>${variantsTable(sens)}${robust(sens.variants) ? `<p class="ok">${t('sens.robust')}</p>` : ''}` : ''}` : ''}
      <h2>${t('rep.data')}</h2>
      <table><tr><th>${t('rep.thProduct')}</th><th>${t('rep.thInstr')}</th><th>${t('rep.thUse')}</th><th>SHA-256</th></tr>
        ${r.dataBasis.map((d) => `<tr><td><code>${esc(d.source)}</code></td><td>${esc(d.instrument)}</td><td class="muted">${esc(tx(d.use))}</td><td><code>${esc(d.sha256 || t('rep.remote'))}</code></td></tr>`).join('')}</table>
      <p class="note">${esc(t('rep.prov', { v: pv.pipelineVersion, b: pv.builtUtc, ep: num(pv.dtmPrecision.epM, 2), sz: num(pv.dtmPrecision.sigmaZUsedM, 2),
        dm: num(pv.checks.dtmMinusMolaM ?? 0, 1), cc: num(pv.checks.hiriseVsCtxCorrelation ?? 0, 2), n: pv.outputsHashed }))}</p>
      <h2>${t('rep.sw')}</h2>
      <p>${esc(tx(sw.summary))} <span class="muted">· ${t('rep.swSource')}: ${esc(tx(sw.source || '—'))} · ${esc(tx(sw.note || ''))}</span></p>
      ${(sw.events || []).length ? `<table><tr><th>${t('rep.thType')}</th><th>${t('rep.thTime')}</th><th>${t('rep.thDesc')}</th></tr>${sw.events.map((ev) => `<tr><td>${esc(ev.type)}</td><td>${esc(ev.time)}</td><td class="muted">${esc(tx(ev.note))}</td></tr>`).join('')}</table>` : ''}
      <h2>${t('rep.link')}</h2>
      ${link ? `<p>${t('rep.linkLine', { d: num(link.oneWayMin, 1), km: num(link.distanceMkm, 0), state: link.up ? `<span class="ok">${t('rep.linkUp')}</span>` : `<span class="warn">${t('rep.linkDown')}</span>`, out: link.pendingOut, inn: link.pendingIn })}</p>
        <table><tr><th>${t('rep.thDir')}</th><th>${t('rep.thKind')}</th><th>${t('rep.thText')}</th><th>${t('rep.thState')}</th></tr>${link.recent.map((b) => `<tr><td>${esc(tx(b.direction))}</td><td>${esc(tx(b.kind))}</td><td>${esc(tx(b.text))}</td>
        <td>${b.delivered ? `<span class="ok">${t('rep.delivered')}</span>` : `<span class="muted">${t('rep.inMin', { m: num(Math.max(0, (b.deliver_s - snap.t) / 60), 1) })}</span>`}</td></tr>`).join('')}</table>
        ${sample ? '' : `<div class="row"><button class="btn" id="rpOutage">${t('rep.outage')}</button><button class="btn" id="rpRefresh">${t('rep.refresh')}</button></div>`}` : ''}
      <h2>${t('rep.audit')}${auditBadge}</h2>
      ${sample ? '' : `<p class="note"><a href="${esc(this.app.ds.api('log/export'))}" download>${t('rep.csv')}</a></p>`}
      ${events.length ? `<table><tr><th>${t('rep.thUtc')}</th><th>${t('rep.thKind')}</th><th>${t('rep.thText')}</th></tr>${events.map((ev) => `<tr><td class="muted">${esc(ev.utc)}</td><td>${esc(tx(ev.kind))}</td><td>${esc(tx(ev.text))}</td></tr>`).join('')}</table>`
        : `<p class="muted">${t('rep.auditEmpty')}</p>`}`;
    $('rpOutage')?.addEventListener('click', () => this.app.ds.post('eva/inject', { kind: 'link-outage' }).then(() => this.open()));
    $('rpRefresh')?.addEventListener('click', () => this.open());
  }
}

// ---------------- plan wyjść ----------------
export class ScheduleView {
  constructor(app) { this.app = app; this.el = $('schedule'); }

  async open() {
    if (!this.app.remote) {
      const [d, meta] = await Promise.all([this.app.ds.sample('schedule'), this.app.ds.sample('meta')]);
      if (!d) { this.el.innerHTML = NEED_BACKEND(); return; }
      this.render(d, null, meta);
      return;
    }
    try { this.render(await this.app.ds.get('schedule')); } catch (e) { this.el.innerHTML = `<p class="warn" role="alert">${esc(t('err.api', { e: e.message }))}</p>`; }
  }

  render(d, error, sample = null) {
    const crew = this.app.m.crew.map((c) => c.id);
    this.el.innerHTML = `${sample ? SAMPLE_NOTE(sample) : ''}
      <h2>${t('sc.title')}</h2>
      <table><tr><th>EVA</th><th>Sol</th><th>${t('sc.thStart')}</th><th>${t('sc.thCrew')}</th><th>${t('sc.thPurpose')}</th><th>O₂</th><th>${t('sc.thEnergy')}</th><th>${t('sc.thNotes')}</th>${sample ? '' : '<th></th>'}</tr>
        ${d.items.map((i) => `<tr><td><b>${esc(i.id)}</b></td><td>${esc(i.sol)}</td><td>${esc(i.startLtst)}–${esc(i.endLtst)}</td><td>${esc(i.crew.join(', '))}</td>
          <td class="muted">${esc(tx(i.purpose))}</td><td>${int(i.o2L)} L</td><td>${int(i.batteryWh)} Wh</td>
          <td>${i.issues.length ? `<span class="warn">${esc(i.issues.map(tx).join('; '))}</span>` : '<span class="ok">OK</span>'}</td>
          ${sample ? '' : `<td><button class="btn" data-edit="${esc(i.id)}" aria-label="${t('sc.edit')} ${esc(i.id)}">${t('sc.edit')}</button> <button class="btn" data-del="${esc(i.id)}" aria-label="${t('sc.delete')} ${esc(i.id)}">${t('sc.delete')}</button></td>`}</tr>`).join('')}</table>
      ${sample ? '' : `<p class="note">${t('sc.liveNote')}</p>`}
      <h2>${t('sc.stores')}</h2>
      <div class="kpis">
        <div class="kpi"><b>${int(d.consumables.o2NeededL)} / ${int(d.consumables.o2AvailableL)} L</b><span>${t('sc.kO2')}</span></div>
        <div class="kpi"><b>${int(d.consumables.batteryWh)}${d.consumables.batteryAvailableWh != null ? ` / ${int(d.consumables.batteryAvailableWh)}` : ''} Wh</b><span>${t('sc.kWh')}</span></div>
        <div class="kpi"><b>${num(d.consumables.waterL, 1)} L</b><span>${t('sc.kWater')}</span></div>
        <div class="kpi"><b>${clock(d.daylight.sunriseLtst * 60)}–${clock(d.daylight.sunsetLtst * 60)}</b><span>${t('sc.kDay')}</span></div>
      </div>
      <h2>${t('sc.rules')}</h2>
      ${d.issues.length ? `<ul>${d.issues.map((x) => `<li class="warn">${esc(tx(x))}</li>`).join('')}</ul>` : `<p class="ok">${t('sc.allOk')}</p>`}
      <p class="note">${esc(t('sc.rulesLine', { r: d.rules.map(tx).join(' · ') }))}</p>
      ${sample ? '' : `<h2>${t('sc.add')}</h2>
      ${error ? `<p class="warn" role="alert">${esc(t('sc.error', { e: error }))}</p>` : ''}
      <div class="row">
        <input id="scId" placeholder="EVA-5" size="7" aria-label="EVA ID"> sol <input id="scSol" class="narrow" type="number" value="${(d.items.at(-1)?.sol ?? this.app.m.mission.sol) + 1}" aria-label="sol">
        ${t('sc.start')} <input id="scStart" value="09:30" size="5" aria-label="${t('sc.start')} (LTST)"> ${t('sc.dur')} <input id="scDur" class="narrow" type="number" step="0.5" value="3" aria-label="${t('sc.dur')}">
        ${crew.map((c) => `<label><input type="checkbox" class="scCrew" value="${esc(c)}" checked> ${esc(c)}</label>`).join(' ')}
        <input id="scPurpose" placeholder="${t('sc.purpose')}" size="22" aria-label="${t('sc.purpose')}"> <button class="btn accent" id="scAdd">${t('sc.save')}</button>
      </div>`}`;
    if (sample) return;
    this.el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      try { this.render(await this.app.ds.del(`schedule/${encodeURIComponent(b.dataset.del)}`)); } catch (e) { this.render(d, e.message); }
    }));
    this.el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const i = d.items.find((x) => x.id === b.dataset.edit);
      if (!i) return;
      $('scId').value = i.id; $('scSol').value = i.sol; $('scStart').value = i.startLtst; $('scDur').value = i.durationH; $('scPurpose').value = i.purpose;
      this.el.querySelectorAll('.scCrew').forEach((x) => { x.checked = i.crew.includes(x.value); });
      $('scId').focus();
    }));
    $('scAdd').addEventListener('click', async () => {
      const item = { id: $('scId').value || `EVA-${Math.max(0, ...d.items.map(i => Number(i.id.match(/^EVA-(\d+)$/)?.[1]) || 0)) + 1}`, sol: +$('scSol').value, startLtst: $('scStart').value, durationH: +$('scDur').value,
        crew: [...this.el.querySelectorAll('.scCrew:checked')].map((x) => x.value), purpose: $('scPurpose').value || t('sc.defaultPurpose') };
      const exists = d.items.some((i) => i.id === item.id);   // istniejący identyfikator — zmiana wpisu (PUT)
      try { this.render(await (exists ? this.app.ds.put(`schedule/${encodeURIComponent(item.id)}`, item) : this.app.ds.post('schedule', item))); } catch (e) { this.render(d, e.message); }
    });
  }
}

// ---------------- zgłoszenia z terenu ----------------
export class FieldReports {
  constructor(app, map) {
    this.app = app; this.map = map;
    const btn = $('reportBtn'), form = $('obsForm'), main = $('main');
    let at = null;
    btn.addEventListener('click', () => {
      app.state.reportMode = !app.state.reportMode;
      btn.classList.toggle('on', app.state.reportMode);
      btn.setAttribute('aria-pressed', String(app.state.reportMode));
      main.classList.toggle('reporting', app.state.reportMode);
      form.hidden = true;
    });
    $('map').addEventListener('click', (e) => {
      if (!app.state.reportMode) return;
      const r = $('map').getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width * MAIN_W, py = (e.clientY - r.top) / r.height * MAIN_H;
      at = { x: (px - map.ox) / map.ps, y: (py - map.oy) / map.ps };
      form.style.left = `${Math.min(MAIN_W - 262, px + 10)}px`;
      form.style.top = `${Math.min(MAIN_H - 200, py + 10)}px`;
      form.hidden = false;
      $('obsKind').focus();
    });
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') form.hidden = true; });
    $('obsCancel').addEventListener('click', () => { form.hidden = true; });
    $('obsOk').addEventListener('click', async () => {
      if (!at) return;
      form.hidden = true;
      const obs = { kind: $('obsKind').value, x: Math.round(at.x), y: Math.round(at.y), radiusM: +$('obsR').value, source: $('obsSrc').value };
      let res;
      try { res = await app.reportObservation(obs); } catch (e) { app.setAlert({ category: t('obs.alert'), text: t('err.api', { e: e.message }) }); return; }
      app.setAlert({ category: t('obs.alert'), text: `${$('obsSrc').selectedOptions[0].text}: ${$('obsKind').selectedOptions[0].text}, r = ${obs.radiusM} m${res?.replanned ? t('obs.newRoute') : ''}` });
      app.state.reportMode = false; btn.classList.remove('on'); btn.setAttribute('aria-pressed', 'false'); main.classList.remove('reporting');
    });
  }
}

// ---------------- porównanie tras: „dlaczego ta trasa” ----------------
export function reasonText(r) {
  if (r.code === 'forbidden') {
    const parts = ['steep', 'sand', 'boulders'].filter((k) => r[k] > 0).map((k) => t(`why.part.${k}`, { m: int(r[k]) }));
    return t('why.forbidden', { m: int(r.m), parts: parts.join(', ') });
  }
  const p = {};
  for (const [k, v] of Object.entries(r)) p[k] = typeof v === 'number' ? (Number.isInteger(v) ? int(v) : num(v, 1)) : v;
  return t(`why.${r.code}`, p);
}

export class RouteCompare {
  constructor(app) {
    this.app = app;
    this.btn = $('altBtn');
    this.el = $('altPanel');
    this.btn.addEventListener('click', () => this.toggle());
    app.on('route', () => { this.sync(); if (app.state.altOpen) this.render(); });
    app.on('view', () => this.sync());
    app.on('reset', () => { app.state.altOpen = false; this.sync(); });
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.toggle(false); });
    app.on('compare', (on) => this.toggle(on));
  }

  get alts() { return this.app.state.route?.alternatives || null; }

  sync() {
    const st = this.app.state, ok = !!this.alts && st.view === 'map';
    this.btn.hidden = !ok;
    if (!ok) st.altOpen = false;
    this.el.hidden = !st.altOpen;
    this.btn.classList.toggle('on', st.altOpen);
    this.btn.setAttribute('aria-expanded', String(st.altOpen));
  }

  toggle(on = !this.app.state.altOpen) {
    this.app.state.altOpen = on && !!this.alts;
    this.app.state.altHi = null;
    if (this.app.state.altOpen) this.render();
    this.sync();
  }

  render() {
    const alts = this.alts;
    if (!alts) return;
    const deg = this.app.m.eva.maxSlopeDeg;
    const order = ['chosen', 'shortest', 'straight', 'strict'];
    const rows = [...alts].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).map((a) => {
      const nums = a.ok ? t('alt.nums', { len: kmFmt(a.lengthM), time: hm(a.durationH), o2: int(a.o2L) }) : '—';
      return `<div class="row" tabindex="0" role="button" data-id="${esc(a.id)}" aria-label="${esc(t(`alt.v.${a.id}`))}">
        <i class="sw" data-color="${ALT_COLORS[a.id]}"></i>
        <div><span class="nm">${esc(t(`alt.v.${a.id}`))}</span>${a.verdict === 'chosen' ? '' : `<span class="badge">${esc(t(`alt.b.${a.verdict}`))}</span>`}</div>
        <div class="nums">${nums}</div>
        <div class="rs">${a.reasons.map((r) => esc(reasonText(r))).join(' · ')}</div></div>`;
    }).join('');
    this.el.innerHTML = `<h3>${t('alt.title')}</h3><p class="why">${t('alt.intro', { deg: esc(deg) })}</p>${rows}<div class="foot">${t('alt.foot')}</div>`;
    this.el.querySelectorAll('.sw').forEach((sw) => { sw.style.background = sw.dataset.color; });
    this.el.querySelectorAll('.row').forEach((r) => {
      const pick = () => { this.app.state.altHi = this.app.state.altHi === r.dataset.id ? null : r.dataset.id;
        this.el.querySelectorAll('.row').forEach((x) => x.classList.toggle('hi', x.dataset.id === this.app.state.altHi)); };
      r.addEventListener('click', pick);
      r.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
  }
}

// ---------------- własna trasa: start i cel klikane na mapie, algorytm Dijkstry ----------------
export class PathPicker {
  constructor(app, map) {
    this.app = app; this.map = map;
    this.btn = $('pickBtn'); this.card = $('pickCard');
    this.on = false;
    this.btn.addEventListener('click', () => this.toggle());
    this.card.addEventListener('click', (e) => { const b = e.target.closest('button[data-a]'); if (b) this.#act(b.dataset.a); });
    $('reportBtn').addEventListener('click', () => { if (this.on) this.toggle(false); });
    $('map').addEventListener('click', (e) => this.#click(e));
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.on) this.toggle(false); });
    app.on('reset', () => this.toggle(false));
    app.on('view', (v) => { if (v !== 'map' && this.on) this.toggle(false); this.btn.hidden = v !== 'map'; });
  }

  toggle(on = !this.on) {
    this.on = on;
    if (on && this.app.state.reportMode) $('reportBtn').click();       // tylko jeden tryb klikania naraz
    this.btn.classList.toggle('on', on);
    this.btn.setAttribute('aria-pressed', String(on));
    $('main').classList.toggle('picking', on);
    if (!on) { this.app.state.pick = null; this.card.hidden = true; return; }
    this.app.state.pick = { start: null, end: null, path: null };
    if (this.app.state.layers.hazards) this.app.toggleLayer('hazards', true);   // widać strefy zakazu, przez które trasa nie przejdzie
    this.#card(`<b>${t('pick.title')}</b>${t('pick.start')}<div class="pc-row"><button class="btn" data-a="fromRover">${t('pick.fromRover')}</button></div>`);
  }

  #act(a) {
    const st = this.app.state;
    if (a === 'fromRover') {                     // start = tam, gdzie stoi łazik (także po poprzedniej jeździe)
      st.pick = { start: this.app.roverPos(), end: null, path: null };
      this.#card(`<b>${t('pick.title')}</b>${t('pick.end')}`);
      return;
    }
    if ((a === 'drive3d' || a === 'drive2d') && st.pick?.path) {
      const path = st.pick.path;
      this.toggle(false);
      this.app.startDrive(path);
      if (a === 'drive3d') this.app.setView('drive');
    }
  }

  // czy punkt leży w strefie zakazu (ta sama reguła co w planerze: klasa 2 albo stok ponad limit)
  #nogo(p) {
    const hz = this.app.world.rasters.hazards, C = hz.cellM;
    const i = Math.min(hz.width - 1, Math.floor(p.x / C)), j = Math.min(hz.height - 1, Math.floor(p.y / C));
    return hz.data[j * hz.width + i] === 2 || this.app.world.terrain.slope(p.x, p.y) > this.app.m.eva.maxSlopeDeg;
  }

  #card(html) { this.card.innerHTML = html; this.card.hidden = false; }

  #click(e) {
    if (!this.on || this.app.state.reportMode) return;
    const r = $('map').getBoundingClientRect(), m = this.map, area = this.app.m.area;
    const px = (e.clientX - r.left) / r.width * MAIN_W, py = (e.clientY - r.top) / r.height * MAIN_H;
    const p = { x: Math.min(area.widthM - 1, Math.max(1, (px - m.ox) / m.ps)), y: Math.min(area.heightM - 1, Math.max(1, (py - m.oy) / m.ps)) };
    const st = this.app.state;
    if (!st.pick.start || st.pick.end) {                                 // pierwszy klik (albo trzeci): nowy start
      st.pick = { start: p, end: null, path: null };
      this.#card(`<b>${t('pick.title')}</b>${t('pick.end')}`);
      return;
    }
    st.pick.end = p;
    const res = this.app.ds.planDijkstra({ start: st.pick.start, end: p, obstacles: st.obstacles });
    if (!res.ok) {
      const why = [this.#nogo(st.pick.start) && t('pick.startLbl'), this.#nogo(p) && t('pick.endLbl')].filter(Boolean);
      const msg = why.length ? t('pick.inNogo', { p: why.join(' + ') }) : t('pick.none');
      this.#card(`<b>${t('pick.title')}</b><span class="warn">${msg}</span><br>${t('pick.again')}`);
      return;
    }
    st.pick.path = res.path;
    this.#card(`<b>${t('pick.title')}</b><span class="big">${t('pick.result', { len: kmFmt(res.lengthM), time: hm(res.durationH), rover: fmtS(new Drive(res.path, { terrain: this.app.world.terrain, hazards: this.app.world.rasters.hazards, speedKmh: this.app.m.rover.speedKmh }).etaS()) })}</span><br>
      ${t('pick.stats', { n: int(res.visited), ms: int(res.ms), deg: esc(this.app.m.eva.maxSlopeDeg) })}<br><span class="muted">${t('pick.again')}</span>
      <div class="pc-row"><button class="btn accent" data-a="drive3d">${t('pick.drive3d')}</button><button class="btn" data-a="drive2d">${t('pick.drive2d')}</button></div>`);
  }
}

// ---------------- jazda łazikiem po trasie A→B: panel sterowania ----------------
const fmtS = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };

export class DriveHud {
  constructor(app, getView3d) {
    this.app = app; this.v3 = getView3d; this.el = $('driveHud');
    this.el.addEventListener('click', (e) => { const b = e.target.closest('button[data-a]'); if (b) this.act(b.dataset.a); });
    addEventListener('keydown', (e) => {
      if (!app.drive || this.el.hidden || e.target.closest?.('input,select,textarea')) return;
      const a = { Space: 'pause', Equal: 'faster', NumpadAdd: 'faster', BracketRight: 'faster', Minus: 'slower', NumpadSubtract: 'slower', BracketLeft: 'slower' }[e.code];
      if (a) { e.preventDefault(); this.act(a); }
    });
    for (const ev of ['drive', 'drive-done', 'drive-cam', 'view']) app.on(ev, () => this.build());
    app.on('reset', () => this.build());
    this.build();
  }

  act(a) {
    const app = this.app, d = app.drive;
    if (!d) return;
    if (a === 'pause') { if (d.done) d.restart(); else d.running = !d.running; }
    else if (a === 'faster') d.faster(1);
    else if (a === 'slower') d.faster(-1);
    else if (a === 'restart') d.restart();
    else if (a === 'view') { app.setView(app.state.view === 'drive' ? 'map' : 'drive'); return; }
    else if (a === 'cam') { this.v3()?.toggleCabin(); return; }
    else if (a === 'stop') { app.stopDrive(); if (app.state.view === 'drive') app.setView('map'); return; }
    this.build();
  }

  build() {
    const app = this.app, d = app.drive, v = app.state.view;
    this.el.hidden = !d || !['map', 'drive', 'orbit'].includes(v);
    if (this.el.hidden) return;
    const cabin = this.v3()?.chase.cabin;
    this.el.innerHTML = `
      <div class="dh-top"><b>${t('drive.title')}</b><span id="dhLine"></span></div>
      <div class="dh-row">
        <button class="btn accent" data-a="pause">${d.done ? t('drive.again') : d.running ? t('drive.pause') : t('drive.play')}</button>
        <span class="dh-speed"><button class="btn" data-a="slower" aria-label="${t('drive.slower')}">−</button><span class="dh-x" title="${t('drive.speedTitle')}">×${d.timeScale}</span><button class="btn" data-a="faster" aria-label="${t('drive.faster')}">+</button></span>
        <button class="btn" data-a="restart">${t('drive.restart')}</button>
        <button class="btn" data-a="view">${v === 'drive' ? t('drive.toMap') : t('drive.to3d')}</button>
        ${v === 'drive' ? `<button class="btn" data-a="cam">${cabin ? t('drive.camChase') : t('drive.camCabin')}</button>` : ''}
        <button class="btn" data-a="stop">${t('drive.stop')}</button>
      </div>
      <div class="dh-help">${v === 'drive' ? t('drive.help3d') : t('drive.help')}</div>`;
    this.update();
  }

  /** Co klatkę: liczby (bez przebudowy przycisków). */
  update() {
    const d = this.app.drive, el = $('dhLine');
    if (!d || !el || this.el.hidden) return;
    if (this.wasRunning !== d.running) { this.wasRunning = d.running; this.build(); return; }
    const p = d.pos(), zone = this.app.world.rasters.hazards.sample(p.x, p.y), slope = this.app.world.terrain.slope(p.x, p.y);
    const txt = d.done
      ? t('drive.done', { m: int(d.length), time: fmtS(d.t) })
      : t('drive.line', { v: num(d.speedMs * 3.6, 1), s: int(d.s), L: int(d.length), eta: fmtS(d.etaS()), real: fmtS(d.etaS() / d.timeScale), deg: Math.round(slope) })
        + (zone === 1 ? ` · <span class="warn">${t('drive.caution')}</span>` : '') + (d.running ? '' : ` · <span class="muted">${t('drive.paused')}</span>`);
    if (el.innerHTML !== txt) el.innerHTML = txt;
  }
}
