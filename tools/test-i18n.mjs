// Test tłumaczeń:  node tools/test-i18n.mjs
// 1) każdy klucz interfejsu ma wersję PL i EN, 2) teksty z backendu i z danych misji mają tłumaczenie EN.
import { readFileSync } from 'node:fs';

globalThis.location = { search: '?lang=en', href: 'http://localhost/?lang=en' };
const { t, tx, lang } = await import('../src/i18n.js');
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.error('✗', msg); } };

check(lang === 'en', 'język EN z adresu');

// klucze: porównanie zestawów w pliku źródłowym
const src = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
const block = (name) => src.slice(src.indexOf(`  ${name}: {`), src.indexOf('\n  },', src.indexOf(`  ${name}: {`)));
const keys = (b) => new Set([...b.matchAll(/'([\w.ąćęłńóśźż]+)':/g)].map((m) => m[1]));
const pl = keys(block('pl')), en = keys(block('en'));
for (const k of pl) check(en.has(k), `brak EN dla klucza ${k}`);
for (const k of en) check(pl.has(k), `brak PL dla klucza ${k}`);

// użyte w kodzie klucze t('...') muszą istnieć
for (const f of ['src/main.js', 'src/app.js', 'src/demo.js', 'src/ui/panels.js', 'src/ui/views.js', 'src/ui/map2d.js', 'src/ui/view3d.js', 'index.html']) {
  const s = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  for (const m of s.matchAll(/\b(?:t|tr)\('([\w.ąćęłńóśźż]+)'/g)) check(pl.has(m[1]), `${f}: nieznany klucz ${m[1]}`);
  for (const m of s.matchAll(/data-i18n(?:-html|-title|-aria)?="([\w.ąćęłńóśźż]+)"/g)) check(pl.has(m[1]), `${f}: nieznany klucz ${m[1]}`);
}

// teksty z danych misji
const polish = /[ąćęłńóśźż]/i;
for (const f of ['data/missions/mount-sharp/mission.json', 'data/missions/jezero/mission.json', 'data/demo/mission.json']) {
  const m = JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
  const texts = [m.mission.title, m.mission.sourceLabel, m.area.label, ...m.layers.flatMap((l) => [l.name, l.desc, ...(l.legend || []).map((e) => e.text)]),
    ...(m.events || []).flatMap((e) => [e.alert?.category, e.alert?.text?.replace('{dist}', '120'), e.source])].filter(Boolean);
  const sameOk = /^(HiRISE|THEMIS|CTX|CRISM|MOLA|RAD|DONKI|NOAA|MT SHARP)\b|^[A-Z0-9 ·+/_,.-]+$/;
  for (const s of texts) check(!polish.test(tx(s)) && (tx(s) !== s || sameOk.test(s)), `${f}: brak tłumaczenia „${s}” → „${tx(s)}”`);
}

// przykładowe teksty z backendu (raport, harmonogram, pogoda kosmiczna, dziennik)
const samples = [
  'Trasa A: 1,24 km, 54 min, 2 przystanki, ocena: bezpieczna z uwagami.',
  'Nachylenie maks. 14,2° ±1,5° (DTM HiRISE 2014, σz 0,2 m).',
  'Ryzyka średnie/wysokie: Utrata łączności z habitatem, Strome zbocze.',
  'Szansa ukończenia: 91% · zapas O₂ ponad rezerwę: 210 L.',
  'maks. 14,2° ±1,5° (2σ: 17,2°)', 'maks. prawdopodobieństwo 0,41 (pewność min. 0,33)', '7 głazów ≤15 m od trasy, największy 2,1 m',
  '120 m trasy bez zasięgu (9%)', 'potrzeba 210 L, dostępne 416 L ponad rezerwę', 'koniec ok. 11:20 LTST, zmierzch 17:55',
  'dawka EVA ok. 45 μSv; Brak danych o pogodzie kosmicznej', 'grunt −40…−5 °C', '60 m trasy z < 3 nadajnikami w zasięgu',
  'Protony ≥10 MeV przy Ziemi: 0,23 pfu (burza: brak); zdarzenia DONKI z 7 dni: 0',
  'EV1: więcej niż jedno wyjście w tym samym solu', 'EVA-3: wyjście dłuższe niż 8 h', 'Tlen: plan wymaga 900 L, dostępne 4800 L (80% zapasów)',
  'POGODA KOSMICZNA: ostrzeżenie SEP · łazik jedzie do załogi', 'Nowa trasa B (zgłoszenie: glazy): +84 m', 'załoga: glazy (500, 400) r=25 m',
  'Kontrola misji: przyjęto „Trasa A: 874 m, 70 min, 56 L O₂, bezpieczna z uwagami”', 'dawka EVA ok. 31 μSv; brak danych pogody kosmicznej',
  'WP2 osiągnięty', 'Nowa sesja EVA nr 3', 'Zapisano EVA-9: sol 160, 10:00, 2.5 h', 'Brak bezpiecznego przejścia do WP1',
  'rozmieszczenie nadajników UWB', 'jedno wyjście na sol na osobę, maks. 8 h;', 'Dron: pole głazów na trasie, 120 m przed nami',
];
for (const s of samples) check(!polish.test(tx(s)) && tx(s) !== s, `brak tłumaczenia „${s}” → „${tx(s)}”`);
check(t('route', { l: 'B' }) === 'ROUTE B', 'zmienne w t()');

if (fail) { console.error(`\n${fail} błędów`); process.exit(1); }
console.log(`i18n OK: ${pl.size} kluczy PL/EN, ${samples.length} tekstów backendu`);
