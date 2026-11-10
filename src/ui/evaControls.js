// Sterowanie wyjściem: przycisk Start/Pauza/Wznów/Nowe wyjście, powrót do habitatu i pasek stanu w prawym panelu.
// Etykiety wynikają z fazy wyjścia (app.phase), więc są poprawne także po odświeżeniu strony w trakcie EVA.
import { $, setText, setHidden } from '../core/dom.js';
import { t } from '../i18n.js';

const START_LAYERS = ['optical', 'terrain', 'hazards'];
const ROUTE_ANIMATION_S = 3.4;          // przeszukiwanie + rysowanie trasy, zanim załoga ruszy
const START_TIME_SCALE = 470;
const CAN_RETURN = ['walking', 'stop', 'atTarget'];

export class EvaControls {
  constructor(app, director) {
    this.app = app;
    this.director = director;
    this.starting = false;
    this.btn = $('evaBtn');
    this.returnBtn = $('returnBtn');
    this.status = $('evaStatus');
    this.btn.addEventListener('click', () => this.toggle());
    this.returnBtn.addEventListener('click', () => this.returnHome());
  }

  /** Start, pauza, wznowienie albo nowe wyjście — zależnie od fazy. */
  async toggle() {
    const app = this.app;
    if (this.director.playing || this.starting) return;
    this.starting = true;
    try {
      if (app.phase === 'done') { app.reset(); await app.pendingReset; return; }
      if (app.sim.running) { await app.pauseEva(true); return; }
      if (app.phase !== 'idle') { await app.pauseEva(false); return; }
      for (const id of START_LAYERS) app.toggleLayer(id, true);
      app.setView('map');
      const route = await app.planInitial({ animate: true });
      if (!route || !this.starting || this.director.playing) return;
      await new Promise((resolve) => setTimeout(resolve, ROUTE_ANIMATION_S * 1000));
      if (this.starting && !this.director.playing && app.state.route === route) await app.startEva(START_TIME_SCALE);
    } catch (e) {
      app.setAlert({ category: t('eva.error'), text: e.message });
    } finally {
      this.starting = false;
    }
  }

  async returnHome() {
    if (this.director.playing || this.starting || !CAN_RETURN.includes(this.app.phase)) return;
    this.starting = true;
    this.app.setView('map');
    try { return await this.app.returnToHabitat(); } catch (e) {
      this.app.setAlert({ category: t('eva.error'), text: e.message });
    } finally { this.starting = false; }
  }

  /** Co klatkę. */
  update() {
    const app = this.app, phase = app.phase, demo = this.director.playing;
    const label = phase === 'done' ? 'eva.new' : app.sim.running ? 'eva.pause' : phase === 'idle' ? 'eva.start' : 'eva.resume';
    setText(this.btn, t(label));
    this.btn.disabled = demo || this.starting;
    this.btn.classList.toggle('primary', phase === 'idle' || phase === 'done' || app.paused);
    setHidden(this.returnBtn, demo || !CAN_RETURN.includes(phase));
    this.returnBtn.disabled = this.starting;

    const target = app.navTarget();
    let text = t(`phase.${phase}`, { wp: phase === 'stop' ? app.sim.reached.at(-1) ?? target.id : target.id });
    if (app.paused) text = t('phase.paused', { p: text });
    if (demo) text = `${t('phase.demo')} · ${text}`;
    setText(this.status.querySelector('.txt'), text);
    const tone = phase === 'done' ? 'done' : app.paused || phase === 'atTarget' ? 'hold' : phase === 'idle' ? '' : 'go';
    if (this.status.dataset.tone !== tone) { this.status.dataset.tone = tone; this.status.className = `status ${tone}`; }
  }
}
