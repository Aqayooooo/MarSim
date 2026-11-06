// Polski zapis liczb i czasu: przecinek dziesiętny, długi minus, „g:mm h”.
export const num = (v, d = 1) => v.toFixed(d).replace('.', ',').replace('-', '−');
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
