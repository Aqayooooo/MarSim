// Kolor tekstu paneli nad widokiem 3D (src/ui/backdrop.js): odwrotność tła, ciągłość, kontrast, łagodzenie.
// Uruchomienie: node --test tools/test-backdrop.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { textColorFor, ease, lum, luminance, lightness, contrast, toSrgb, TUNING, Backdrop } from '../src/ui/backdrop.js';

const srgb = (t) => t.fg.map((v) => Math.round(toSrgb(v)));
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

test('czarne tło → prawie biały tekst, białe → prawie czarny', () => {
  for (const v of srgb(textColorFor(0, 0, 0))) assert.ok(v >= 240, `czarne tło: ${v}`);
  for (const v of srgb(textColorFor(255, 255, 255))) assert.ok(v <= 30, `białe tło: ${v}`);
  assert.ok(contrast(lum(...textColorFor(0, 0, 0).fg), 0) >= 15 && contrast(lum(...textColorFor(255, 255, 255).fg), 1) >= 15);
});

test('barwa tekstu to odwrotność barwy tła', () => {
  const [r, , b] = srgb(textColorFor(140, 90, 55));      // pomarańczowy cień → niebieskawy tekst
  assert.ok(b > r, `pomarańcz → ${r}/${b}`);
  const [r2, g2, b2] = srgb(textColorFor(90, 130, 200)); // niebieski → ciepły tekst
  assert.ok(r2 > b2 && g2 >= b2, `niebieski → ${r2},${g2},${b2}`);
});

test('ciągłość: brak skoku czerń/biel na całej skali szarości i przy małych zmianach koloru', () => {
  let worst = 0, prev = srgb(textColorFor(0, 0, 0));
  for (let v = 1; v <= 255; v++) {
    const cur = srgb(textColorFor(v, v, v));
    worst = Math.max(worst, maxDiff(cur, prev));
    prev = cur;
  }
  assert.ok(worst <= 8, `największy krok na skali szarości: ${worst}`);
  // losowe kolory: zmiana tła o ±2 daje ograniczoną zmianę tekstu, a ±0,05 — prawie żadną (ciągłość, nie tylko mały krok)
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const [eps, bound] of [[2, 64], [0.05, 3]]) {
    let worstRnd = 0;
    for (let i = 0; i < 5000; i++) {
      const c = [rnd() * 251 + 2, rnd() * 251 + 2, rnd() * 251 + 2];
      const d = c.map((v) => v + (rnd() * 2 - 1) * eps);
      worstRnd = Math.max(worstRnd, maxDiff(srgb(textColorFor(...c)), srgb(textColorFor(...d))));
    }
    assert.ok(worstRnd <= bound, `największa zmiana przy ±${eps}: ${worstRnd}`);
  }
});

test('kontrast: daleko od środka tekst sam, w środku z obwódką', () => {
  let worst = 99, at = -1;
  for (let v = 0; v <= 255; v++) {
    const t = textColorFor(v, v, v), Yt = lum(...t.fg), Yb = luminance(v, v, v), L = lightness(Yb) * 100;
    const ownC = contrast(Yt, Yb), c = Math.max(ownC, contrast(Yt, t.halo));
    if (c < worst) { worst = c; at = v; }
    // ciemne tło i typowy marsjański teren / niebo (L* ≥ 55): sam tekst ma kontrast ≥ 4,5
    if (L <= 30 || L >= 55) assert.ok(ownC >= 4.5, `tło ${v} (L* ${L.toFixed(0)}): kontrast tekstu ${ownC.toFixed(2)}`);
  }
  // przejście tekst = tło jest nieuniknione przy ciągłej funkcji; wąskie pasmo L* ok. 38–48 ratuje obwódka
  assert.ok(worst >= 2, `najsłabszy kontrast (tekst/tło lub tekst/obwódka) ${worst.toFixed(2)} przy tle ${at}`);
  // tło o jasności „środka”: tekst tej samej jasności, ale obwódka mocno odróżnia
  const g = Math.round(toSrgb(((TUNING.mid + 0.16) / 1.16) ** 3));
  const t = textColorFor(g, g, g);
  assert.ok(contrast(lum(...t.fg), t.halo) >= 4.5, 'obwódka w punkcie środka');
});

test('łagodzenie: zbiega, monotonicznie, bez przestrzelenia', () => {
  for (const [from, to] of [[0, 1], [1, 0], [0.3, 0.31]]) {
    let v = from, prev = from;
    for (let i = 0; i < 200; i++) {
      v = ease(v, to, 1 / 60, 0.5);
      assert.ok(Math.abs(to - v) <= Math.abs(to - prev) + 1e-15, 'monotonicznie');
      assert.ok((to - from) * (to - v) >= -1e-15, 'bez przestrzelenia');
      prev = v;
    }
    assert.ok(Math.abs(to - v) <= Math.abs(to - from) * Math.exp(-200 / 60 / 0.5) * 1.0001 + 1e-12, 'zbieżność wykładnicza');
  }
  assert.equal(ease(0.2, 0.9, 0, 0.5), 0.2);
  assert.equal(ease(0.2, 0.9, -1, 0.5), 0.2);
  assert.ok(Math.abs(ease(0.2, 0.9, 100, 0.5) - 0.9) < 1e-12);
  assert.ok(ease(0, 1, 1e9, 0.5) <= 1);
});

// --- klasa Backdrop na atrapach DOM ---
function fakeDom() {
  const frame = { rgb: [0, 0, 0] };
  const mkEl = () => {
    const props = new Map(), attrs = new Set();
    return {
      props, attrs, isConnected: true, offsetParent: {},
      getBoundingClientRect: () => ({ left: 10, top: 5, right: 60, bottom: 30, width: 50, height: 25 }),
      style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
      setAttribute: (k) => attrs.add(k), hasAttribute: (k) => attrs.has(k), removeAttribute: (k) => attrs.delete(k),
    };
  };
  const els = { '#caption': [mkEl()] };
  globalThis.document = {
    createElement: () => ({ getContext: () => ({
      drawImage() {},
      getImageData: (x, y, w, h) => {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < data.length; i += 4) data.set([...frame.rgb, 255], i);
        return { data };
      },
    }) }),
    querySelectorAll: (s) => els[s] || [],
  };
  globalThis.getComputedStyle = () => ({ position: 'absolute', backgroundColor: 'rgba(0, 0, 0, 0)' });
  const gl = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 96, height: 40 }) };
  return { frame, els, gl };
}
const fgOf = (el) => el.props.get('--hud-fg').match(/\d+/g).map(Number);

test('Backdrop: pierwszy pomiar od razu, potem płynnie; clear() sprząta; brak paneli nie szkodzi', () => {
  const { frame, els, gl } = fakeDom();
  const bd = new Backdrop(gl);
  const el = els['#caption'][0];
  frame.rgb = [0, 0, 0];
  let t = 1000;
  bd.sample(t);
  assert.ok(el.attrs.has('data-adapt'));
  assert.deepEqual(fgOf(el), srgb(textColorFor(0, 0, 0)), 'wejście do 3D: od razu kolor docelowy');
  assert.ok(bd.last > 0);
  frame.rgb = [255, 255, 255];                // nagle białe tło
  let prev = fgOf(el)[0], steps = 0;
  for (let i = 0; i < 300; i++) {
    t += 1000 / 60; bd.sample(t);
    const v = fgOf(el)[0];
    assert.ok(v <= prev, 'tylko w stronę celu');
    assert.ok(prev - v <= 12, `krok na klatkę ${prev - v}`);
    if (v !== prev) steps++;
    prev = v;
  }
  assert.ok(Math.abs(prev - srgb(textColorFor(255, 255, 255))[0]) <= 1, `po 5 s u celu: ${prev}`);
  assert.ok(steps > 20, 'zmiana rozłożona na wiele klatek');
  // panel usunięty z DOM
  el.isConnected = false; els['#caption'] = [];
  t += 200; bd.sample(t);
  assert.equal(bd.state.size, 0);
  // clear()
  el.isConnected = true; els['#caption'] = [el];
  t += 200; bd.sample(t);
  bd.clear();
  assert.equal(el.props.size, 0);
  assert.ok(!el.attrs.has('data-adapt'));
  assert.equal(bd.last, 0);
  delete globalThis.document; delete globalThis.getComputedStyle;
});
