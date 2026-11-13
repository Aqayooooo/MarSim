// Reżyser prezentacji: 6 kroków, łącznie najwyżej ok. 30 s. Każdy krok ma stały czas; krok 03 (EVA) pokazuje
// zdarzenia symulacji (nowa trasa, burza słoneczna), jeśli zdążą zajść w swoim oknie — inaczej idzie dalej.
import { t, tx } from './i18n.js';

const STOP = Symbol('stop');
const MAX_S = 29.5;   // twardy limit długości prezentacji (s)

export class Director {
  constructor(app, getView3d, loadView3d = async () => getView3d()) {
    this.app = app;
    this.view3d = getView3d;
    this.loadView3d = loadView3d;
    this.token = 0;
    this.playing = false;
    this.clock = () => performance.now() / 1000;   // sekundy czasu rzeczywistego (testy podstawiają własny zegar)
  }

  stop() {
    this.token++;
    this.view3d()?.demoCleanup?.();
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
    // czas rzeczywisty, a nie zegar aplikacji: na wolnym komputerze (mało klatek) prezentacja też trwa ≤ 30 s
    const now = () => this.clock(), end = now() + MAX_S;
    const left = () => Math.max(0, end - now());
    const until = (cond, s) => new Promise((res, rej) => {
      const t0 = now();
      const chk = () => {
        if (this.token !== my) return rej(STOP);
        const v = cond();
        if (v) return res(v);
        if (now() - t0 >= Math.min(s, left())) return res(null);
        setTimeout(chk, 50);
      };
      chk();
    });
    const wait = (s) => until(() => false, s);   // czeka s sekund, ale nie dłużej niż do końca limitu
    // widok 3D; null, gdy przeglądarka nie ma WebGL — wtedy kroki 3D są pomijane, a prezentacja kończy się na mapie
    const v3d = async () => { let v = null; try { await this.loadView3d(); v = this.view3d(); } catch { /* bez 3D */ } alive(); return v; };

    try {
      // 01 · warstwy NASA (z trasą łazika NASA) — 3 s
      app.reset(true, { bare: true });
      app.autoEvents = false;
      app.setView('map');
      await wait(0.3);
      const nasaRover = app.world?.rasters?.rover?.rover;
      app.setCaption('01', nasaRover ? t('demo.c1r', { rover: nasaRover }) : t('demo.c1'));
      const layers = app.m.layers, step = 2.4 / Math.max(1, layers.length);
      for (const l of layers) { alive(); app.toggleLayer(l.id, true); await wait(step); }
      await wait(0.3);

      // 02 · bezpieczna trasa i porównanie wariantów — ok. 4 s
      app.setCaption('02', t('demo.c2'));
      app.clearFocus('hazards');
      const route = await app.planInitial({ animate: true });
      alive();
      if (!route) throw new Error(t('noRoute'));
      await wait(2.4);
      if (app.state.route?.alternatives) {
        app.setCaption('02', t('demo.c2b'));
        app.emit('compare', true);
        await wait(1.8);
        app.emit('compare', false);
      }

      // 03 · EVA na żywo: załoga, O₂, zdarzenia — 6 s
      app.setCaption('03', t('demo.c3', { crew: app.m.crew.map((c) => c.id).join(t('and')) }));
      app.showCrew();
      const started = await app.startEva(1200);
      alive();
      if (!started) throw new Error(app.state.alert?.text || t('eva.error'));
      const evaEnd = now() + 6;
      const rp = await until(() => app.lastReplan, 3.2);
      if (rp) {
        const d = Math.round(rp.deltaM ?? 0);
        app.setCaption('03', t('demo.c4', { d: `${d >= 0 ? '+' : '−'}${Math.abs(d)}` }));
      }
      if (await until(() => app.sim.sep, Math.max(0, evaEnd - now() - 1.6))) app.setCaption('03', t('demo.c5'));
      await wait(Math.max(0, evaEnd - now()));
      if (!(await app.pauseEva(true))) throw new Error(app.state.alert?.text || t('eva.error'));
      alive();
      app.endSep();
      app.setAlert(null);

      // 04 · ta sama trasa w 3D — 5 s
      const view = await v3d();
      if (view) {
        app.setCaption('04', t('demo.c7', { x: view.exOrbit ?? 10 }));
        app.setView('orbit');
        view.flyover(4.6);
        await wait(5.0);
        app.setView('helmet');
      }

      // 05 · habitat od środka: moduł dzienny, mesa, systemy bazy — 5 s
      if (view && left() > 2.5 && view.habitatTour?.(Math.min(4.8, left() - 2))) {
        app.setCaption('05', t('demo.c8'));
        await wait(Math.min(5.0, left() - 2));
      }

      // 06 · jazda łazikiem z kamerą na wysięgniku — do 4,5 s (reszta limitu)
      if (view && left() > 1.5 && view.demoRide?.()) {
        app.setCaption('06', t('demo.c9'));
        await wait(Math.max(0, left() - 0.4));
      }
      app.state.fadeOut = true;
      await new Promise((r) => setTimeout(r, 400));
      alive();
      view?.demoCleanup?.();
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
