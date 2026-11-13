// Załoga z imionami w interfejsie:  node --test tools/test-crew-names.mjs
// Bartek i Hubert (EVA), Mateusz i Eryk (baza): etykiety kajut, zakładka hełmu, tłumaczenie alarmów z imieniem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.location = { search: '?lang=en', href: 'http://localhost/?lang=en' };
const { t, tx } = await import('../src/i18n.js');
const src = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('kajuty nazwane imionami (PL i EN)', () => {
  const pl = ['Kajuta Bartka', 'Kajuta Huberta', 'Kajuta Mateusza', 'Kajuta Eryka'];
  const en = ['Bartek’s cabin', 'Hubert’s cabin', 'Mateusz’s cabin', 'Eryk’s cabin'];
  pl.forEach((label, k) => {
    assert.ok(src.includes(`'hab.zone.cabin${k + 1}': '${label}'`), label);
    assert.ok(src.includes(`'hab.st.cabin${k + 1}': '${label}'`), label);
  });
  en.forEach((label, k) => {
    assert.equal(t(`hab.zone.cabin${k + 1}`), label);
    assert.equal(t(`hab.st.cabin${k + 1}`), label);
  });
  assert.doesNotMatch(src, /Kajuta \d|Cabin \d/);
});

test('zakładka hełmu i wizjer należą do Bartka', () => {
  assert.equal(t('view.helmet'), 'Bartek’s helmet');
  assert.match(read('index.html'), /data-i18n="view\.helmet">Hełm Bartka</);
  assert.match(read('src/ui/helmetHud.js'), /\/ Bartek</);
  assert.doesNotMatch(read('index.html') + read('src/ui/views.js') + read('src/ui/helmetHud.js') + src, /\bEV[12]\b/);
});

test('baza: Mateusz i Eryk zostają w habitacie', () => {
  assert.match(read('src/ui/habitatView.js'), /CREW_NAMES = \['Mateusz', 'Eryk'\]/);
  assert.equal(t('hab.cab.eva'), 'EVA team');
  assert.equal(t('hab.cab.base'), 'in the base');
});

test('alarmy z imieniem tłumaczą się na EN', () => {
  assert.equal(tx('Hubert: tlen poniżej rezerwy 20%'), 'Hubert: oxygen below the 20% reserve');
  assert.equal(tx('Bartek: zapas na powrót pieszo poniżej 15 min — zawróć'), 'Bartek: walk-back margin below 15 min — turn back');
  assert.equal(tx('Hubert: 10% O₂, na powrót potrzeba 61 L, dostępne −26 L ponad rezerwę'),
    'Hubert: 10% O₂, 61 L needed to return, −26 L available above reserve');
  assert.equal(tx('Bartek: więcej niż jedno wyjście w tym samym solu'), 'Bartek: more than one EVA in the same sol');
  assert.equal(tx('TLEN: Hubert: tlen poniżej rezerwy 20%'), `${tx('TLEN')}: Hubert: oxygen below the 20% reserve`);
});

test('dane demo i mock: załoga Bartek, Hubert', () => {
  const demo = JSON.parse(read('data/demo/mission.json'));
  assert.deepEqual(demo.crew.map((c) => c.id), ['Bartek', 'Hubert']);
  assert.match(read('tools/generate-mock-data.mjs'), /id: 'Bartek'.*\n.*id: 'Hubert'/);
});
