// Widoki dodatkowe: urządzenie w hełmie (mały ekran), raport ryzyka, plan wyjść, zgłoszenia z terenu.
import { num, int, hm, clock } from '../core/format.js';
import { headingDeg } from '../core/path.js';
import { MAIN_W, MAIN_H } from './map2d.js';
import { t, tx } from '../i18n.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const NEED_BACKEND = () => `<h2>${t('need.title')}</h2><p class="muted">${t('need.text')}</p>`;

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
        <span class="v" id="dvDist" style="font-size:24px">--</span><span class="s">${t('dev.meters')}</span></div>
      <div class="cell"><span class="k">CO₂</span><span class="v" id="dvCo2">--</span><span class="s">mmHg</span></div>
      <div class="cell"><span class="k">${t('dev.battery')}</span><span class="v" id="dvBat">--</span><span class="s" id="dvHr"></span></div>
      <div class="msg ok" id="dvMsg" role="status">OK</div></div>
      <div class="devnote">${t('dev.note')}</div>`;
  }

  update() {
    const app = this.app, sim = app.sim, snap = sim.snap, c = snap?.crew?.[0], r = app.state.route;
    const set = (id, v, cls) => { const e = $(id); if (e.textContent !== v) e.textContent = v; if (cls !== undefined) e.className = `v ${cls}`; };
    $('dvWho').textContent = `${app.m.crew[0].id} · ${t('dev.route')} ${r?.letter ?? '—'}`;
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
    const wps = app.m.waypoints, wp = wps[Math.min(sim.nextWp, wps.length - 1)];
    const p = sim.crewPos(0);
    let rel = 0;
    if (r && wp) {
      const brg = headingDeg(wp.x - p.x, wp.y - p.y);
      const hdg = r.poly.heading(Math.min(sim.crewS + 2, r.poly.length - 1));
      rel = brg - hdg;
      $('dvTgt').textContent = sim.nextWp >= wps.length ? `${wp.id} ✓` : wp.id;
      $('dvDist').textContent = String(Math.round(Math.hypot(wp.x - p.x, wp.y - p.y)));
    }
    $('dvArrow').setAttribute('transform', `rotate(${rel})`);
    // jeden komunikat — najważniejszy
    let msg = `OK · ${sim.running ? t('dev.walk') : t('dev.stop')}`, cls = 'ok';
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
    if (!this.app.remote) { this.el.innerHTML = NEED_BACKEND(); return; }
    this.el.innerHTML = `<p class="muted">${t('rep.loading')}</p>`;
    try {
      const [rep, sw, log] = await Promise.all([this.app.ds.get('report'), this.app.ds.get('spaceweather'), this.app.ds.get('log?limit=12').catch(() => ({ events: [] }))]);
      this.render(rep, sw, log);
    } catch (e) { this.el.innerHTML = `<p class="warn">${esc(t('rep.error', { e: e.message }))}</p>`; }
  }

  render(r, sw, log) {
    if (!r.ok) { this.el.innerHTML = `<h2>${t('rep.title')}</h2><p class="muted">${esc(tx(r.error))}</p>`; return; }
    const e = r.effectiveness, snap = this.app.sim.snap;
    const color = (l, s) => { const v = l * s; return v >= 15 ? '#5a1408' : v >= 8 ? '#4d3608' : '#12301d'; };
    const P = t('rep.matrixP'), S = t('rep.matrixS');
    let matrix = '<div class="matrix" role="table"><div class="ax"></div>' + [1, 2, 3, 4, 5].map((s) => `<div class="ax" style="justify-content:center">${S}${s}</div>`).join('');
    r.riskMatrix.forEach((row, i) => {
      const l = 5 - i;
      matrix += `<div class="ax">${P}${l}</div>` + row.map((n, j) => `<div style="background:${color(l, j + 1)}">${n || ''}</div>`).join('');
    });
    matrix += `</div><p class="muted" style="font-size:11px">${t('rep.matrixNote')}</p>`;
    const link = snap?.link, pv = r.provenance;
    const events = log?.events || [];
    this.el.innerHTML = `
      <h2>${t('rep.summary')}</h2>
      <ul class="summary">${r.summary.map((s) => `<li>${esc(tx(s))}</li>`).join('')}</ul>
      <h2>${t('rep.eff')}</h2>
      <div class="kpis">
        <div class="kpi"><b>${num(e.probabilityComplete * 100, 0)}%</b><span>${t('rep.kComplete')}</span></div>
        <div class="kpi"><b>${int(e.o2MarginL)} L</b><span>${t('rep.kO2')}</span></div>
        <div class="kpi"><b>${num(e.routeEfficiency * 100, 0)}%</b><span>${t('rep.kEff')}</span></div>
        <div class="kpi"><b>${hm(e.durationH)}</b><span>${t('rep.kDur')}</span></div>
      </div>
      <p class="muted" style="font-size:12px">${esc(tx(e.note))}</p>
      <h2>${t('rep.hazards')}</h2>
      <div class="two"><table><tr><th>#</th><th>${t('rep.thHazard')}</th><th>${t('rep.thRisk')}</th><th>${t('rep.thValue')}</th><th>${t('rep.thBasis')}</th><th>${t('rep.thMit')}</th></tr>
        ${r.hazards.map((h) => `<tr><td>${h.id}</td><td>${esc(tx(h.hazard))}</td><td><span class="lvl ${h.level}">${esc(tx(h.level))} ${h.likelihood}×${h.severity}</span></td>
          <td>${esc(tx(h.value))}</td><td class="muted">${esc(tx(h.basis))}</td><td class="muted">${esc(tx(h.mitigation))}</td></tr>`).join('')}</table>
        <div>${matrix}</div></div>
      <h2>${t('rep.data')}</h2>
      <table><tr><th>${t('rep.thProduct')}</th><th>${t('rep.thInstr')}</th><th>${t('rep.thUse')}</th><th>SHA-256</th></tr>
        ${r.dataBasis.map((d) => `<tr><td><code>${esc(d.source)}</code></td><td>${esc(d.instrument)}</td><td class="muted">${esc(tx(d.use))}</td><td><code>${esc(d.sha256 || t('rep.remote'))}</code></td></tr>`).join('')}</table>
      <p class="muted" style="font-size:12px">${esc(t('rep.prov', { v: pv.pipelineVersion, b: pv.builtUtc, ep: num(pv.dtmPrecision.epM, 2), sz: num(pv.dtmPrecision.sigmaZUsedM, 2),
        dm: num(pv.checks.dtmMinusMolaM ?? 0, 1), cc: num(pv.checks.hiriseVsCtxCorrelation ?? 0, 2), n: pv.outputsHashed }))}</p>
      <h2>${t('rep.sw')}</h2>
      <p>${esc(tx(sw.summary))} <span class="muted">· ${t('rep.swSource')}: ${esc(tx(sw.source || '—'))} · ${esc(tx(sw.note || ''))}</span></p>
      ${(sw.events || []).length ? `<table><tr><th>${t('rep.thType')}</th><th>${t('rep.thTime')}</th><th>${t('rep.thDesc')}</th></tr>${sw.events.map((ev) => `<tr><td>${esc(ev.type)}</td><td>${esc(ev.time)}</td><td class="muted">${esc(tx(ev.note))}</td></tr>`).join('')}</table>` : ''}
      <h2>${t('rep.link')}</h2>
      ${link ? `<p>${t('rep.linkLine', { d: num(link.oneWayMin, 1), km: num(link.distanceMkm, 0), state: link.up ? `<span class="ok">${t('rep.linkUp')}</span>` : `<span class="warn">${t('rep.linkDown')}</span>`, out: link.pendingOut, inn: link.pendingIn })}</p>
        <table><tr><th>${t('rep.thDir')}</th><th>${t('rep.thKind')}</th><th>${t('rep.thText')}</th><th>${t('rep.thState')}</th></tr>${link.recent.map((b) => `<tr><td>${esc(tx(b.direction))}</td><td>${esc(tx(b.kind))}</td><td>${esc(tx(b.text))}</td>
        <td>${b.delivered ? `<span class="ok">${t('rep.delivered')}</span>` : `<span class="muted">${t('rep.inMin', { m: num(Math.max(0, (b.deliver_s - snap.t) / 60), 1) })}</span>`}</td></tr>`).join('')}</table>
        <div class="row"><button class="btn" id="rpOutage">${t('rep.outage')}</button><button class="btn" id="rpRefresh">${t('rep.refresh')}</button></div>` : ''}
      <h2>${t('rep.audit')}</h2>
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
    if (!this.app.remote) { this.el.innerHTML = NEED_BACKEND(); return; }
    this.render(await this.app.ds.get('schedule'));
  }

  render(d, error) {
    const crew = this.app.m.crew.map((c) => c.id);
    this.el.innerHTML = `
      <h2>${t('sc.title')}</h2>
      <table><tr><th>EVA</th><th>Sol</th><th>${t('sc.thStart')}</th><th>${t('sc.thCrew')}</th><th>${t('sc.thPurpose')}</th><th>O₂</th><th>${t('sc.thEnergy')}</th><th>${t('sc.thNotes')}</th><th></th></tr>
        ${d.items.map((i) => `<tr><td><b>${esc(i.id)}</b></td><td>${i.sol}</td><td>${esc(i.startLtst)}–${esc(i.endLtst)}</td><td>${esc(i.crew.join(', '))}</td>
          <td class="muted">${esc(tx(i.purpose))}</td><td>${int(i.o2L)} L</td><td>${int(i.batteryWh)} Wh</td>
          <td>${i.issues.length ? `<span class="warn">${esc(i.issues.map(tx).join('; '))}</span>` : '<span class="ok">OK</span>'}</td>
          <td><button class="btn" data-del="${esc(i.id)}" aria-label="${t('sc.delete')} ${esc(i.id)}">${t('sc.delete')}</button></td></tr>`).join('')}</table>
      <h2>${t('sc.stores')}</h2>
      <div class="kpis">
        <div class="kpi"><b>${int(d.consumables.o2NeededL)} / ${int(d.consumables.o2AvailableL)} L</b><span>${t('sc.kO2')}</span></div>
        <div class="kpi"><b>${int(d.consumables.batteryWh)} Wh</b><span>${t('sc.kWh')}</span></div>
        <div class="kpi"><b>${num(d.consumables.waterL, 1)} L</b><span>${t('sc.kWater')}</span></div>
        <div class="kpi"><b>${clock(d.daylight.sunriseLtst * 60)}–${clock(d.daylight.sunsetLtst * 60)}</b><span>${t('sc.kDay')}</span></div>
      </div>
      <h2>${t('sc.rules')}</h2>
      ${d.issues.length ? `<ul>${d.issues.map((x) => `<li class="warn">${esc(tx(x))}</li>`).join('')}</ul>` : `<p class="ok">${t('sc.allOk')}</p>`}
      <p class="muted" style="font-size:12px">${esc(t('sc.rulesLine', { r: d.rules.map(tx).join(' · ') }))}</p>
      <h2>${t('sc.add')}</h2>
      ${error ? `<p class="warn" role="alert">${esc(t('sc.error', { e: error }))}</p>` : ''}
      <div class="row">
        <input id="scId" placeholder="EVA-5" size="7" aria-label="EVA ID"> sol <input id="scSol" type="number" value="${(d.items.at(-1)?.sol ?? 147) + 1}" style="width:70px" aria-label="sol">
        ${t('sc.start')} <input id="scStart" value="09:30" size="5" aria-label="${t('sc.start')} (LTST)"> ${t('sc.dur')} <input id="scDur" type="number" step="0.5" value="3" style="width:60px" aria-label="${t('sc.dur')}">
        ${crew.map((c) => `<label><input type="checkbox" class="scCrew" value="${c}" checked> ${c}</label>`).join(' ')}
        <input id="scPurpose" placeholder="${t('sc.purpose')}" size="22" aria-label="${t('sc.purpose')}"> <button class="btn accent" id="scAdd">${t('sc.save')}</button>
      </div>`;
    this.el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => this.render(await this.app.ds.del(`schedule/${encodeURIComponent(b.dataset.del)}`))));
    $('scAdd').addEventListener('click', async () => {
      const item = { id: $('scId').value || `EVA-${d.items.length + 1}`, sol: +$('scSol').value, startLtst: $('scStart').value, durationH: +$('scDur').value,
        crew: [...this.el.querySelectorAll('.scCrew:checked')].map((x) => x.value), purpose: $('scPurpose').value || t('sc.defaultPurpose') };
      try { this.render(await this.app.ds.post('schedule', item)); } catch (e) { this.render(d, e.message); }
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
