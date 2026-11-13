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
for (const f of ['src/main.js', 'src/app.js', 'src/demo.js', 'src/ui/panels.js', 'src/ui/views.js', 'src/ui/map2d.js', 'src/ui/view3d.js', 'src/ui/profile.js', 'src/ui/evaControls.js', 'src/ui/help.js', 'src/ui/helmetHud.js', 'src/ui/rideHud.js', 'src/ui/habHud.js', 'src/ui/habitatView.js', 'index.html']) {
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
  // nazwy własne (instrumenty, łaziki z latami misji) są takie same w obu językach
  const sameOk = /^(HiRISE|THEMIS|CTX|CRISM|MOLA|RAD|DONKI|NOAA|MT SHARP)\b|^(Curiosity|Perseverance) \d{4}–\d{4}$|^[A-Z0-9 ·+/_,.-]+$/;
  for (const s of texts) check(!polish.test(tx(s)) && (tx(s) !== s || sameOk.test(s)), `${f}: brak tłumaczenia „${s}” → „${tx(s)}”`);
}

// opisy źródeł danych (raport → „Podstawa danych”: część opisu po „ — ”, jak w backend/live/report.py)
for (const id of ['mount-sharp', 'jezero']) {
  const p = JSON.parse(readFileSync(new URL(`../data/missions/${id}/provenance.json`, import.meta.url), 'utf8'));
  for (const s of p.sources || []) {
    const use = s.description.split(' — ').at(-1);
    check(!polish.test(tx(use)), `${id}/provenance.json: brak tłumaczenia opisu źródła „${use}” → „${tx(use)}”`);
  }
}

// przykładowe teksty z backendu (raport, harmonogram, pogoda kosmiczna, dziennik)
const samples = [
  'Trasa A: 1,24 km, 54 min, 2 przystanki, ocena: bezpieczna z uwagami.',
  'Nachylenie maks. 14,2° ±1,5° (DTM HiRISE 2014, σz 0,2 m).',
  'Ryzyka średnie/wysokie: Utrata łączności z habitatem, Strome zbocze.',
  'Szansa ukończenia: 91% · zapas O₂ ponad rezerwę: 210 L.',
  'maks. 14,2° ±1,5° (2σ: 17,2°)', 'maks. prawdopodobieństwo 0,41 (pewność min. 0,33)', '7 głazów ≤15 m od trasy, największy 2,1 m',
  '120 m trasy bez zasięgu (9%)', 'potrzeba 210 L, dostępne 416 L ponad rezerwę', 'Hubert: 10% O₂, na powrót potrzeba 61 L, dostępne −26 L ponad rezerwę', 'koniec ok. 11:20 LTST, zmierzch 17:55',
  'dawka EVA ok. 45 μSv; Brak danych o pogodzie kosmicznej', 'grunt −40…−5 °C', '60 m trasy z < 3 nadajnikami w zasięgu',
  'Protony ≥10 MeV przy Ziemi: 0,23 pfu (burza: brak); zdarzenia DONKI z 7 dni: 0',
  'Bartek: więcej niż jedno wyjście w tym samym solu', 'EVA-3: wyjście dłuższe niż 8 h', 'Tlen: plan wymaga 900 L, dostępne 4800 L (80% zapasów)',
  'Energia: sol 148 wymaga 11400 Wh, dostępne 9600 Wh (80% baterii)',
  'TLEN: Bartek: tlen poniżej rezerwy 20%', 'TLEN: Hubert: za mało tlenu na powrót pieszo — wezwij łazik', 'Bartek: zapas na powrót pieszo poniżej 15 min — zawróć',
  'WP2 osiągnięty — cel wyjścia, czas zaplanować powrót', 'EVA zakończona: załoga w habitacie po 142 min, zużycie O₂ do 151 L',
  'Nowa trasa C (powrót do habitatu): +640 m', 'Zmieniono EVA-9: sol 160, 10:00, 3 h', 'trawers do WP2, rozpoznanie terenu', 'pobranie próbek skał',
  'POGODA KOSMICZNA: ostrzeżenie SEP · łazik jedzie do załogi', 'Nowa trasa B (zgłoszenie: glazy): +84 m', 'załoga: glazy (500, 400) r=25 m',
  'Kontrola misji: przyjęto „Trasa A: 874 m, 70 min, 56 L O₂, bezpieczna z uwagami”', 'dawka EVA ok. 31 μSv; brak danych pogody kosmicznej',
  'WP2 osiągnięty', 'Nowa sesja EVA nr 3', 'Zapisano EVA-9: sol 160, 10:00, 2.5 h', 'Brak bezpiecznego przejścia do WP1',
  'rozmieszczenie nadajników UWB', 'Błędne dane zapytania — startLtst: String should match pattern', 'jedno wyjście na sol na osobę, maks. 8 h;', 'Dron: pole głazów na trasie, 120 m przed nami',
];
for (const s of samples) check(!polish.test(tx(s)) && tx(s) !== s, `brak tłumaczenia „${s}” → „${tx(s)}”`);
check(t('route', { l: 'B' }) === 'ROUTE B', 'zmienne w t()');
check(tx('Trasa C: 0,68 km, 26 min, 1 przystanek, ocena: bezpieczna.').includes('1 stop,'), 'liczba pojedyncza: 1 stop');
check(tx('Trasa C: 0,68 km, 26 min, 0 przystanków, ocena: bezpieczna.').includes('0 stops,'), 'liczba mnoga: 0 stops');

if (fail) { console.error(`\n${fail} błędów`); process.exit(1); }
console.log(`i18n OK: ${pl.size} kluczy PL/EN, ${samples.length} tekstów backendu`);
