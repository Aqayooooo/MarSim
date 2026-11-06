// Reżyser prezentacji: 8 kroków jak w nagraniu. Kroki 04–06 czekają na zdarzenia symulacji,
// więc scenariusz działa także na innym terenie i innej trasie.
const STOP = Symbol('stop');

export class Director {
  constructor(app, getView3d) {
    this.app = app;
    this.view3d = getView3d;
    this.token = 0;
    this.playing = false;
  }

  stop() { this.token++; this.playing = false; this.app.autoEvents = true; this.app.emit('director', false); }

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
      app.reset();
      app.autoEvents = false;
      app.setView('map');
      await wait(0.6);
      app.setCaption('01', 'Sześć warstw danych NASA nałożonych na obszar EVA');
      for (const l of app.m.layers) { alive(); app.toggleLayer(l.id, true); await wait(1.2); }

      app.setCaption('02', 'Planowanie bezpiecznej trasy: nachylenie, piasek, skarpy, wysiłek');
      app.clearFocus('hazards');
      await wait(0.36);
      await app.planInitial({ animate: true });
      await wait(3.64);

      app.setCaption('03', `${app.m.crew.map((c) => c.id).join(' i ')} w drodze: pozycja, zużycie O₂, zapas na powrót`);
      app.showCrew();
      await wait(0.2);
      app.startEva(470);

      const wps = app.m.waypoints, done = () => app.sim.nextWp >= wps.length;
      const rp = await until(() => app.lastReplan || (done() && {}));
      if (app.lastReplan) {
        const d = Math.round(rp.deltaM ?? 0);
        app.setCaption('04', `Pole głazów na trasie: nowa trasa wyznaczona (${d >= 0 ? '+' : '−'}${Math.abs(d)} m)`);
      }
      await until(() => app.sim.sep || done());
      if (app.sim.sep) app.setCaption('05', 'Burza słoneczna (DONKI): załoga poza strefą schronu, łazik jedzie do niej');

      await until(done);
      const wp = wps[wps.length - 1];
      app.setCaption('06', `${wp.id} osiągnięty: widok terenu${wp.target ? ` i ${wp.target}` : ''}`);
      app.setTimeScale(150);
      await wait(2.0);
      app.endSep();
      await wait(0.8);
      app.setAlert(null);
      await wait(0.48);

      app.setCaption('07', `Ta sama trasa w 3D, rzeźba terenu przewyższona ×${this.view3d()?.exOrbit ?? 10}`);
      app.setView('orbit');
      this.view3d()?.flyover(7.5);
      await wait(8.0);

      app.setCaption('08', `Widok z hełmu ${app.m.crew[0].id}: powrót pieszo po trasie`);
      const r = app.state.route;
      app.setView('helmet');
      this.view3d()?.autoWalk({ fromS: r.wpS[r.wpS.length - 1], toS: r.wpS[0], timelapse: 15 });
      await wait(10.7);
      app.state.fadeOut = true;
      await wait(0.6);
      app.sim.running = false;
    } catch (e) {
      if (e !== STOP) throw e;
      return;
    }
    if (this.token === my) { this.playing = false; app.autoEvents = true; app.emit('director', false); }
  }
}
