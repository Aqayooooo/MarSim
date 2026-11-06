// Zapis liczb i czasu zależny od języka: PL — przecinek dziesiętny i długi minus, EN — kropka. Czas „g:mm h”.
import { lang } from '../i18n.js';

const dec = (s) => (lang === 'pl' ? s.replace('.', ',').replace('-', '−') : s.replace('-', '−'));
export const num = (v, d = 1) => dec(v.toFixed(d));
export const int = (v) => String(Math.round(v)).replace('-', '−');
export const hm = (hours) => {
  const m = Math.max(0, Math.round(hours * 60));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;
};
export const clock = (min) => {
  const m = ((Math.floor(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
export const parseClock = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
export const km = (m) => `${num(m / 1000, 2)} km`;
