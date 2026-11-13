// Karta postoju prawdziwego łazika NASA (warstwa „Trasa łazika”): sol, data i zdjęcia Navcam z tego miejsca.
// Miniatury są w danych misji (działają offline); pełny rozmiar i strona NASA otwierają się z sieci.
import { $, esc } from '../core/dom.js';
import { t } from '../i18n.js';

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const dir = (az) => DIRS[Math.round(((az % 360) + 360) % 360 / 45) % 8];

export class RoverCard {
  constructor(app) {
    this.app = app;
    this.el = $('roverCard');
    this.stop = null;
    this.el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) this.close(); });
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.el.hidden) this.close(); });
    app.on('view', () => this.close());
    app.on('layers', () => { if (!app.state.layers?.rover?.on) this.close(); });
  }

  close() { this.el.hidden = true; this.stop = null; this.app.emit('rover-stop', null); }

  /** Otwiera kartę postoju (obiekt z roverTrack.json → stops). */
  open(stop) {
    const T = this.app.world.rasters.rover;
    if (!T || !stop) return this.close();
    const idx = T.stops.indexOf(stop);
    const photos = (T.photos || []).filter((p) => p.stop === idx);
    const online = navigator.onLine !== false;
    const imgs = photos.map((p) => `
      <figure>
        <a href="${esc(p.large)}" target="_blank" rel="noopener" title="${esc(t('rover.full'))}"${online ? '' : ' aria-disabled="true"'}>
          <img src="${esc(this.app.ds.fileUrl(p.thumb))}" alt="${esc(t('rover.alt', { cam: p.cam, d: dir(p.az) }))}" loading="lazy">
        </a>
        <figcaption>${esc(p.cam)} · ${esc(t('rover.toward', { d: dir(p.az), az: Math.round(p.az) }))}</figcaption>
      </figure>`).join('');
    this.el.innerHTML = `
      <header><b>${esc(T.rover)} · SOL ${stop.sol}</b><button type="button" class="btn" data-close aria-label="${esc(t('rover.close'))}">×</button></header>
      <p class="rc-meta">${esc(stop.date || '—')} · site ${stop.site}, drive ${stop.drive}${stop.yaw != null ? ` · ${esc(t('rover.heading', { h: Math.round((stop.yaw + 360) % 360) }))}` : ''}</p>
      ${photos.length ? `<div class="rc-photos">${imgs}</div>` : `<p class="rc-none">${esc(t('rover.noPhotos'))}</p>`}
      <p class="rc-note">${esc(t('rover.note'))} ${esc(photos[0]?.credit || 'NASA/JPL-Caltech')}.${photos.length && !online ? ` ${esc(t('rover.offline'))}` : ''}</p>`;
    this.el.hidden = false;
    this.stop = stop;
    this.app.emit('rover-stop', stop);
  }
}
