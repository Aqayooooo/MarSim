// Reżyser prezentacji: 8 kroków jak w nagraniu. Kroki 04–06 czekają na zdarzenia symulacji,
// więc scenariusz działa także na innym terenie i innej trasie.
import { t, tx } from './i18n.js';

const STOP = Symbol('stop');

export class Director {
  constructor(app, getView3d, loadView3d = async () => getView3d()) {
    this.app = app;
    this.view3d = getView3d;
    this.loadView3d = loadView3d;
    this.token = 0;
    this.playing = false;
  }

  stop() {
    this.token++;
    this.playing = false;
    this.app.autoEvents = true;
    this.app.state.fadeOut = false;
    this.app.setCaption(null);
    this.app.emit('compare', false);
    this.app.pauseEva(true);
    this.app.emit('director', false);
  }

  async play() {
    const my = ++this.token, app = this.app;
    this.playing = true;
    app.emit('director', true);
    const alive = () => { if (this.token !== my) throw STOP; };
    const wait = (s) => new Promise((res, rej) => {
      const t0 = app.now;
      const chk = () => { if (this.token !== my) return rej(STOP); if (app.now - t0 >= s) return res(); requestAnimationFrame(chk); };
      chk();
    });
    // czeka na warunek stanu (odporne na kolejność zdarzeń na innym terenie)
    const until = (cond) => new Promise((res, rej) => {
      const chk = () => { if (this.token !== my) return rej(STOP); const v = cond(); if (v) return res(v); requestAnimationFrame(chk); };
      chk();
    });

    try {
      app.reset(true, { bare: true });
      app.autoEvents = false;
      app.setView('map');
      await wait(0.6);
      app.setCaption('01', t('demo.c1'));
      for (const l of app.m.layers) { alive(); app.toggleLayer(l.id, true); await wait(1.2); }

      app.setCaption('02', t('demo.c2'));
      app.clearFocus('hazards');
      await wait(0.36);
      const route = await app.planInitial({ animate: true });
      alive();
      if (!route) throw new Error(t('noRoute'));
      await wait(3.64);
      if (app.state.route?.alternatives) {           // „dlaczego ta trasa”: porównanie wariantów przez chwilę
        app.setCaption('02', t('demo.c2b'));
        app.emit('compare', true);
        await wait(5.5);
        app.emit('compare', false);
      }

      app.setCaption('03', t('demo.c3', { crew: app.m.crew.map((c) => c.id).join(t('and')) }));
      app.showCrew();
      await wait(0.2);
      const started = await app.startEva(470);
      alive();
      if (!started) throw new Error(app.state.alert?.text || t('eva.error'));

      const wps = app.m.waypoints, done = () => app.sim.nextWp >= wps.length;
      const rp = await until(() => app.lastReplan || (done() && {}));
      if (app.lastReplan) {
        const d = Math.round(rp.deltaM ?? 0);
        app.setCaption('04', t('demo.c4', { d: `${d >= 0 ? '+' : '−'}${Math.abs(d)}` }));
      }
      await until(() => app.sim.sep || done());
      if (app.sim.sep) app.setCaption('05', t('demo.c5'));

      await until(done);
      const wp = wps[wps.length - 1];
      app.setCaption('06', t('demo.c6', { wp: wp.id, t: wp.target ? t('demo.c6t', { t: tx(wp.target) }) : '' }));
      app.setTimeScale(150);
      await wait(2.0);
      app.endSep();
      await wait(0.8);
      app.setAlert(null);
      await wait(0.48);

      app.setCaption('07', t('demo.c7', { x: this.view3d()?.exOrbit ?? 10 }));
      app.setView('orbit');
      await this.loadView3d();
      alive();
      this.view3d()?.flyover(7.5);
      await wait(8.0);

      app.setCaption('08', t('demo.c8', { id: app.m.crew[0].id }));
      const r = app.state.route;
      app.setView('helmet');
      this.view3d()?.autoWalk({ fromS: r.wpS[r.wpS.length - 1], toS: r.wpS[0], timelapse: 15 });
      await wait(10.7);
      app.state.fadeOut = true;
      await wait(0.6);
      if (!(await app.pauseEva(true))) throw new Error(app.state.alert?.text || t('eva.error'));
      alive();
      await wait(0.8);
      app.setView('map');               // po prezentacji zostaje mapa z przebytą trasą, a nie czarny ekran
      app.setCaption(null);
      app.state.fadeOut = false;
    } catch (e) {
      if (this.token !== my) return;
      this.stop();
      if (e !== STOP) app.setAlert({ category: t('noRoute'), text: e.message });
      return;
    }
    if (this.token === my) { this.playing = false; app.autoEvents = true; app.emit('director', false); }
  }
}
