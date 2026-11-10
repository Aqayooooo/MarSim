// Drobne narzędzia DOM wspólne dla widoków. Settery zmieniają dokument tylko wtedy, gdy wartość się różni,
// więc można je wołać w każdej klatce.
export const $ = (id) => document.getElementById(id);

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
/** Tekst bezpieczny do wstawienia w HTML (także w atrybucie w cudzysłowie). */
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ENTITIES[c]);

export function setText(el, value) { if (el.textContent !== value) el.textContent = value; }
export function setHidden(el, hidden) { if (el.hidden !== hidden) el.hidden = hidden; }
export function setClass(el, name, on) { if (el.classList.contains(name) !== on) el.classList.toggle(name, on); }

/** Czy zdarzenie klawiatury trafia w pole, w którym użytkownik pisze albo które samo obsługuje klawisz. */
export const isTyping = (e) => !!e.target.closest?.('input, select, textarea, [contenteditable]');
