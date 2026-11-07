// Tłumaczenia interfejsu (PL/EN).
// t(klucz, {zmienne}) — teksty interfejsu. tx(tekst) — teksty z danych misji i z backendu (pisane po polsku),
// tłumaczone dokładnym dopasowaniem albo wzorcem; nieznany tekst zostaje bez zmian.
// Język: ?lang=en|pl → zapisany wybór → pl. Zmiana języka przeładowuje stronę.

export const LANGS = ['pl', 'en'];
const KEY = 'marsim.lang';

function pick() {
  if (typeof location === 'undefined') return 'pl';   // Node (testy)
  const q = new URLSearchParams(location.search).get('lang');
  if (LANGS.includes(q)) return q;
  try { const s = localStorage.getItem(KEY); if (LANGS.includes(s)) return s; } catch { /* brak dostępu do pamięci */ }
  return 'pl';
}

export const lang = pick();

export function setLang(l) {
  if (!LANGS.includes(l) || l === lang) return;
  try { localStorage.setItem(KEY, l); } catch { /* brak dostępu do pamięci */ }
  const u = new URL(location.href);
  u.searchParams.set('lang', l);
  location.replace(u.toString());
}

const UI = {
  pl: {
    'doc.title': 'MarSim · planowanie EVA na Marsie', 'skip': 'Przejdź do mapy', 'map.aria': 'Mapa obszaru EVA z warstwami danych i trasą',
    'lang.label': 'Język', 'mission.label': 'Obszar misji', 'mission.error': 'Nie udało się przełączyć misji.', 'mission.demo': 'Demo · dane syntetyczne',
    'sample.note': 'Przykładowe dane z backendu, zapisane {d}. Ta wersja działa bez serwera, więc widok jest tylko do odczytu — pełną wersję uruchamia <code>URUCHOM.bat</code>.',
    'view.aria': 'Widok',
    'view.map': 'Mapa 2D', 'view.orbit': '3D', 'view.helmet': 'Hełm EV1', 'view.device': 'Urządzenie', 'view.report': 'Raport', 'view.schedule': 'Plan wyjść',
    'eva.title': 'Wyznacz trasę i rozpocznij wyjście', 'eva.start': 'Start EVA', 'eva.pause': 'Pauza EVA', 'eva.resume': 'Wznów EVA',
    'demo.title': 'Odtwórz prezentację 8 kroków', 'demo.play': '▶ Prezentacja', 'demo.stop': '■ Zatrzymaj',
    'layers.head': 'Warstwy danych', 'layers.aria': 'Warstwy danych: kliknij lub naciśnij spację, aby włączyć',
    'hud.help': 'W A S D — chodzenie · przeciągnij — rozglądanie · Shift — szybciej',
    'obs.btn': '＋ Zgłoś z terenu', 'obs.btnTitle': 'Zgłoś przeszkodę lub bezpieczne przejście kliknięciem na mapie',
    'obs.title': 'Zgłoszenie z terenu', 'obs.kind': 'Rodzaj', 'obs.radius': 'Promień', 'obs.source': 'Źródło',
    'obs.k.glazy': 'głazy', 'obs.k.piasek': 'luźny piasek', 'obs.k.osuwisko': 'osuwisko / skarpa', 'obs.k.inne': 'inna przeszkoda', 'obs.k.bezpieczne': 'bezpieczne przejście',
    'obs.s.załoga': 'załoga', 'obs.s.łazik': 'łazik', 'obs.s.dron': 'dron',
    'obs.send': 'Wyślij', 'obs.cancel': 'Anuluj', 'obs.alert': 'ZGŁOSZENIE Z TERENU', 'obs.newRoute': ' · nowa trasa',
    'loading': 'Wczytywanie danych terenu…', 'loading.fail': 'Nie udało się wczytać danych: {e}',
    'card.dose': 'Dawka<br>μSv/h', 'card.wind': 'Wiatr m/s', 'card.temp': 'Temp. °C', 'card.ground': 'Grunt °C', 'card.tau': 'Pył τ',
    'card.career': 'kariera {p}%',
    'crew.o2': 'Załoga O<span class="sub2">₂</span>', 'reserve': 'Zapas na powrót',
    'wp.view': 'Widok w {wp}', 'wp.locked': 'odblokuje się w {wp}', 'wp.alt': 'Render terenu z modelu wysokości w punkcie {wp}',
    'wp.note': 'nie zdjęcie z kamery',
    'tele': 'CO₂ {co2} mmHg · bat. {bat}% · ♥ {hr} · {kpa} kPa',
    'route': 'TRASA {l}', 'route.slope': 'nachylenie maks. {s}° ±{sg}° · DTM {y}', 'route.sand': 'piasek ≤ {p}% · O₂ {o2} L',
    'stops.1': 'przystanek', 'stops.few': 'przystanki', 'stops.many': 'przystanków',
    'view3d.label': 'WIDOK 3D · PRZEWYŻSZENIE ×{x}',
    'hud.title': 'HEŁM {id}', 'hud.heading': 'KURS {h}°', 'hud.to': 'DO {t}: {d} M', 'hud.slope': 'NACHYLENIE',
    'hud.nogo': 'STREFA ZAKAZANA: PIASEK / SKARPA', 'hud.caution': 'UWAGA: NIERÓWNY TEREN',
    'hud.steep': 'ZA STROMO · {a}°', 'hud.boulder': 'GŁAZ NA DRODZE',
    'map.rover': 'ŁAZIK', 'map.habitat': 'HABITAT', 'map.shelter': 'SCHRON ≤ {m} MIN', 'map.scaleAria': 'Skala mapy',
    'lbl.glazy': 'GŁAZY', 'lbl.piasek': 'PIASEK', 'lbl.osuwisko': 'OSUWISKO', 'lbl.inne': 'PRZESZKODA', 'lbl.bezpieczne': 'BEZPIECZNIE',
    'noRoute': 'BRAK TRASY',
    'shadow.hour': 'Godzina LTST:',
    'demo.c1': 'Warstwy danych NASA nałożone na obszar EVA',
    'demo.c2': 'Planowanie bezpiecznej trasy: nachylenie, piasek, skarpy, wysiłek',
    'demo.c2b': 'Dlaczego ta trasa: linia prosta wchodzi w strefy zakazane, najkrótsza zużywa więcej tlenu',
    'demo.c3': '{crew} w drodze: pozycja, zużycie O₂, zapas na powrót',
    'demo.c4': 'Pole głazów na trasie: nowa trasa wyznaczona ({d} m)',
    'demo.c5': 'Burza słoneczna (DONKI): załoga poza strefą schronu, łazik jedzie do niej',
    'demo.c6': '{wp} osiągnięty: widok terenu{t}', 'demo.c6t': ' i {t}',
    'demo.c7': 'Ta sama trasa w 3D, rzeźba terenu przewyższona ×{x}',
    'demo.c8': 'Widok z hełmu {id}: powrót pieszo po trasie',
    'and': ' i ',
    // urządzenie
    'dev.return': 'POWRÓT', 'dev.returnSub': 'zapas pieszo', 'dev.target': 'CEL', 'dev.meters': 'metrów', 'dev.battery': 'BATERIA',
    'dev.route': 'TRASA', 'dev.habitat': '◉ habitat', 'dev.noLink': '○ brak łączn.', 'dev.earth': 'Ziemia',
    'dev.walk': 'MARSZ', 'dev.stop': 'POSTÓJ', 'dev.goBack': 'WRACAJ: GRANICA POWROTU', 'dev.sep': 'BURZA SŁONECZNA · DO SCHRONU',
    'dev.nogo': 'STREFA ZAKAZANA', 'dev.nocomms': 'BRAK ŁĄCZNOŚCI Z HABITATEM', 'dev.lowReserve': 'MAŁY ZAPAS NA POWRÓT',
    'dev.note': 'Podgląd ekranu urządzenia na przedramieniu / w hełmie (480×320): tylko najważniejsze dane, duże cyfry, jeden komunikat.',
    // backend wymagany
    'need.title': 'Wymaga backendu',
    'need.text': 'Ten widok korzysta z obliczeń backendu na prawdziwych danych NASA. Uruchom <code>URUCHOM.bat</code> (albo <code>python backend/server.py</code>) i otwórz <code>http://localhost:8000</code>.',
    // raport
    'rep.loading': 'Liczę raport…', 'rep.error': 'Błąd raportu: {e}', 'rep.title': 'Raport',
    'rep.summary': 'Podsumowanie (skrót danych i ocen)', 'rep.eff': 'Skuteczność misji',
    'rep.kComplete': 'szansa ukończenia trasy', 'rep.kO2': 'zapas O₂ ponad rezerwę', 'rep.kEff': 'efektywność trasy (linia prosta / trasa)', 'rep.kDur': 'czas z przystankami',
    'rep.hazards': 'Analiza zagrożeń i ryzyka', 'rep.thHazard': 'Zagrożenie', 'rep.thRisk': 'Ryzyko', 'rep.thValue': 'Wartość na trasie', 'rep.thBasis': 'Na czym oparto', 'rep.thMit': 'Środki',
    'rep.matrixNote': 'P — prawdopodobieństwo, S — skutek', 'rep.matrixP': 'P', 'rep.matrixS': 'S',
    'rep.data': 'Dane źródłowe (pochodzenie)', 'rep.thProduct': 'Produkt', 'rep.thInstr': 'Instrument', 'rep.thUse': 'Użycie', 'rep.remote': 'zdalny fragment',
    'rep.prov': 'Potok v{v}, zbudowany {b} · dokładność DTM: EP {ep} m, użyto σz {sz} m · kontrola DTM−MOLA: {dm} m · korelacja HiRISE–CTX: {cc} · {n} plików wynikowych z sumą SHA-256 (provenance.json).',
    'rep.sw': 'Pogoda kosmiczna (NASA DONKI, NOAA SWPC)', 'rep.swSource': 'źródło', 'rep.thType': 'Typ', 'rep.thTime': 'Czas (UTC)', 'rep.thDesc': 'Opis',
    'rep.link': 'Łączność z Ziemią (DTN)',
    'rep.linkLine': 'Opóźnienie w jedną stronę: <b>{d} min</b> · odległość {km} mln km · łącze {state} · w kolejce do Ziemi: {out}, z Ziemi: {inn}',
    'rep.linkUp': 'dostępne', 'rep.linkDown': 'przerwane',
    'rep.thDir': 'Kierunek', 'rep.thKind': 'Rodzaj', 'rep.thText': 'Treść', 'rep.thState': 'Stan', 'rep.delivered': 'dostarczono', 'rep.inMin': 'za {m} min',
    'rep.outage': 'Symuluj przerwę łącza (30 min)', 'rep.refresh': 'Odśwież raport',
    'rep.audit': 'Dziennik zdarzeń (zapisany w bazie)', 'rep.thUtc': 'Czas (UTC)', 'rep.auditEmpty': 'Brak zapisanych zdarzeń.',
    // harmonogram
    'sc.title': 'Harmonogram wyjść', 'sc.thStart': 'Start–koniec (LTST)', 'sc.thCrew': 'Załoga', 'sc.thPurpose': 'Cel', 'sc.thEnergy': 'Energia', 'sc.thNotes': 'Uwagi',
    'sc.delete': 'Usuń', 'sc.stores': 'Zapasy habitatu i światło',
    'sc.kO2': 'tlen: plan / dostępne (80% zapasów)', 'sc.kWh': 'energia skafandrów', 'sc.kWater': 'woda pitna podczas EVA', 'sc.kDay': 'dzień (LTST)',
    'sc.rules': 'Kontrola reguł', 'sc.allOk': 'Wszystkie reguły spełnione.', 'sc.rulesLine': 'Reguły: {r}',
    'sc.add': 'Dodaj lub zmień wyjście', 'sc.start': 'start', 'sc.dur': 'czas [h]', 'sc.purpose': 'cel wyjścia', 'sc.save': 'Zapisz', 'sc.defaultPurpose': 'wyjście',
    'sc.error': 'Nie zapisano: {e}',
    'err.api': 'Błąd serwera: {e}',
    'alt.btn': '⇄ Porównaj trasy', 'alt.btnTitle': 'Pokaż, dlaczego wybrano tę trasę i czym przegrywają inne warianty',
    'alt.title': 'Dlaczego ta trasa?', 'alt.close': 'Zamknij',
    'alt.intro': 'Planer szuka trasy o <b>najmniejszym zużyciu tlenu</b> (model wysiłku dla 0,38 g), która <b>nie wchodzi w strefy zakazane</b> (nachylenie + 2σ powyżej {deg}°, luźny piasek, głazy). Poniżej ta sama trasa porównana z innymi wariantami.',
    'alt.v.chosen': 'Wybrana', 'alt.v.straight': 'Linia prosta', 'alt.v.shortest': 'Najkrótsza bezpieczna', 'alt.v.strict': 'Bez stref „uwaga”',
    'alt.b.chosen': 'wybrana', 'alt.b.unsafe': 'niebezpieczna', 'alt.b.worse': 'gorsza', 'alt.b.impossible': 'niemożliwa', 'alt.b.same': 'ta sama',
    'alt.nums': '{len} · {time} · O₂ {o2} L',
    'alt.foot': 'Wszystkie wartości policzone na tych samych danych (DTM HiRISE z niepewnością ±σ, wykryte głazy, mapa piasku). Kliknij wiersz, aby wyróżnić wariant na mapie.',
    'why.minO2': 'najmniejsze zużycie tlenu: {o2} L', 'why.noForbidden': '0 m w strefach zakazanych',
    'why.margin2s': 'nachylenie liczone z marginesem błędu DTM (+2σ), limit {deg}°', 'why.cautionShare': '{m} m ({pct}%) w strefach „uwaga” — tam marsz wolniej i z asekuracją',
    'why.forbidden': '{m} m przez strefy zakazane ({parts})', 'why.part.steep': 'stromo {m} m', 'why.part.sand': 'luźny piasek {m} m', 'why.part.boulders': 'głazy {m} m',
    'why.tooSteep': 'nachylenie do {deg}° (limit {max}°)', 'why.shorter': 'krótsza o {m} m', 'why.longer': 'dłuższa o {m} m',
    'why.moreO2': '+{l} L tlenu', 'why.slower': 'wolniejsza o {min} min (trudniejszy teren)', 'why.fasterButUnsafe': 'szybsza o {min} min, ale przez zakaz',
    'why.moreCaution': '+{m} m w strefach „uwaga”', 'why.lessComms': '+{m} m bez łączności z habitatem', 'why.noPath': 'nie istnieje — strefy „uwaga” zamykają każde przejście',
    'why.sameAsChosen': 'pokrywa się z wybraną trasą',
  },
  en: {
    'doc.title': 'MarSim · Mars EVA planning', 'skip': 'Skip to map', 'map.aria': 'Map of the EVA area with data layers and route',
    'lang.label': 'Language', 'mission.label': 'Mission area', 'mission.error': 'Could not switch the mission.', 'mission.demo': 'Demo · synthetic data',
    'sample.note': 'Sample backend data, recorded {d}. This version runs without a server, so the view is read-only — <code>URUCHOM.bat</code> starts the full version.',
    'view.aria': 'View',
    'view.map': '2D map', 'view.orbit': '3D', 'view.helmet': 'EV1 helmet', 'view.device': 'Device', 'view.report': 'Report', 'view.schedule': 'EVA plan',
    'eva.title': 'Plan the route and start the EVA', 'eva.start': 'Start EVA', 'eva.pause': 'Pause EVA', 'eva.resume': 'Resume EVA',
    'demo.title': 'Play the 8-step presentation', 'demo.play': '▶ Presentation', 'demo.stop': '■ Stop',
    'layers.head': 'Data layers', 'layers.aria': 'Data layers: click or press space to toggle',
    'hud.help': 'W A S D — walk · drag — look around · Shift — faster',
    'obs.btn': '＋ Field report', 'obs.btnTitle': 'Report an obstacle or a safe passage by clicking on the map',
    'obs.title': 'Field report', 'obs.kind': 'Type', 'obs.radius': 'Radius', 'obs.source': 'Source',
    'obs.k.glazy': 'boulders', 'obs.k.piasek': 'loose sand', 'obs.k.osuwisko': 'landslide / scarp', 'obs.k.inne': 'other obstacle', 'obs.k.bezpieczne': 'safe passage',
    'obs.s.załoga': 'crew', 'obs.s.łazik': 'rover', 'obs.s.dron': 'drone',
    'obs.send': 'Send', 'obs.cancel': 'Cancel', 'obs.alert': 'FIELD REPORT', 'obs.newRoute': ' · new route',
    'loading': 'Loading terrain data…', 'loading.fail': 'Could not load data: {e}',
    'card.dose': 'Dose<br>μSv/h', 'card.wind': 'Wind m/s', 'card.temp': 'Temp. °C', 'card.ground': 'Ground °C', 'card.tau': 'Dust τ',
    'card.career': 'career {p}%',
    'crew.o2': 'Crew O<span class="sub2">₂</span>', 'reserve': 'Return margin',
    'wp.view': 'View at {wp}', 'wp.locked': 'unlocks at {wp}', 'wp.alt': 'Terrain render from the elevation model at {wp}',
    'wp.note': 'not a camera photo',
    'tele': 'CO₂ {co2} mmHg · bat. {bat}% · ♥ {hr} · {kpa} kPa',
    'route': 'ROUTE {l}', 'route.slope': 'max slope {s}° ±{sg}° · DTM {y}', 'route.sand': 'sand ≤ {p}% · O₂ {o2} L',
    'stops.1': 'stop', 'stops.few': 'stops', 'stops.many': 'stops',
    'view3d.label': '3D VIEW · VERTICAL EXAGGERATION ×{x}',
    'hud.title': 'HELMET {id}', 'hud.heading': 'HEADING {h}°', 'hud.to': 'TO {t}: {d} M', 'hud.slope': 'SLOPE',
    'hud.nogo': 'NO-GO ZONE: SAND / SCARP', 'hud.caution': 'CAUTION: ROUGH TERRAIN',
    'hud.steep': 'TOO STEEP · {a}°', 'hud.boulder': 'BOULDER AHEAD',
    'map.rover': 'ROVER', 'map.habitat': 'HABITAT', 'map.shelter': 'SHELTER ≤ {m} MIN', 'map.scaleAria': 'Map scale',
    'lbl.glazy': 'BOULDERS', 'lbl.piasek': 'SAND', 'lbl.osuwisko': 'LANDSLIDE', 'lbl.inne': 'OBSTACLE', 'lbl.bezpieczne': 'SAFE',
    'noRoute': 'NO ROUTE',
    'shadow.hour': 'LTST hour:',
    'demo.c1': 'NASA data layers over the EVA area',
    'demo.c2': 'Safe route planning: slope, sand, scarps, effort',
    'demo.c2b': 'Why this route: the straight line crosses no-go zones, the shortest one uses more oxygen',
    'demo.c3': '{crew} on the move: position, O₂ use, return margin',
    'demo.c4': 'Boulder field on the route: new route planned ({d} m)',
    'demo.c5': 'Solar storm (DONKI): crew outside the shelter zone, rover is driving to them',
    'demo.c6': '{wp} reached: terrain view{t}', 'demo.c6t': ' and {t}',
    'demo.c7': 'The same route in 3D, relief exaggerated ×{x}',
    'demo.c8': 'View from {id} helmet: walking back along the route',
    'and': ' and ',
    'dev.return': 'RETURN', 'dev.returnSub': 'walk-back margin', 'dev.target': 'TARGET', 'dev.meters': 'meters', 'dev.battery': 'BATTERY',
    'dev.route': 'ROUTE', 'dev.habitat': '◉ habitat', 'dev.noLink': '○ no link', 'dev.earth': 'Earth',
    'dev.walk': 'WALKING', 'dev.stop': 'STOPPED', 'dev.goBack': 'TURN BACK: RETURN LIMIT', 'dev.sep': 'SOLAR STORM · TAKE SHELTER',
    'dev.nogo': 'NO-GO ZONE', 'dev.nocomms': 'NO LINK TO HABITAT', 'dev.lowReserve': 'LOW RETURN MARGIN',
    'dev.note': 'Preview of the wrist / helmet device screen (480×320): only key data, large digits, one message.',
    'need.title': 'Backend required',
    'need.text': 'This view uses backend calculations on real NASA data. Run <code>URUCHOM.bat</code> (or <code>python backend/server.py</code>) and open <code>http://localhost:8000</code>.',
    'rep.loading': 'Building report…', 'rep.error': 'Report error: {e}', 'rep.title': 'Report',
    'rep.summary': 'Summary (data and assessments)', 'rep.eff': 'Mission effectiveness',
    'rep.kComplete': 'chance of completing the route', 'rep.kO2': 'O₂ above reserve', 'rep.kEff': 'route efficiency (straight line / route)', 'rep.kDur': 'duration incl. stops',
    'rep.hazards': 'Hazard and risk analysis', 'rep.thHazard': 'Hazard', 'rep.thRisk': 'Risk', 'rep.thValue': 'Value on route', 'rep.thBasis': 'Based on', 'rep.thMit': 'Mitigation',
    'rep.matrixNote': 'L — likelihood, S — severity', 'rep.matrixP': 'L', 'rep.matrixS': 'S',
    'rep.data': 'Source data (provenance)', 'rep.thProduct': 'Product', 'rep.thInstr': 'Instrument', 'rep.thUse': 'Use', 'rep.remote': 'remote subset',
    'rep.prov': 'Pipeline v{v}, built {b} · DTM precision: EP {ep} m, σz used {sz} m · DTM−MOLA check: {dm} m · HiRISE–CTX correlation: {cc} · {n} output files with SHA-256 (provenance.json).',
    'rep.sw': 'Space weather (NASA DONKI, NOAA SWPC)', 'rep.swSource': 'source', 'rep.thType': 'Type', 'rep.thTime': 'Time (UTC)', 'rep.thDesc': 'Description',
    'rep.link': 'Link to Earth (DTN)',
    'rep.linkLine': 'One-way delay: <b>{d} min</b> · distance {km} million km · link {state} · queued to Earth: {out}, from Earth: {inn}',
    'rep.linkUp': 'up', 'rep.linkDown': 'down',
    'rep.thDir': 'Direction', 'rep.thKind': 'Kind', 'rep.thText': 'Content', 'rep.thState': 'Status', 'rep.delivered': 'delivered', 'rep.inMin': 'in {m} min',
    'rep.outage': 'Simulate link outage (30 min)', 'rep.refresh': 'Refresh report',
    'rep.audit': 'Event log (stored in database)', 'rep.thUtc': 'Time (UTC)', 'rep.auditEmpty': 'No stored events.',
    'sc.title': 'EVA schedule', 'sc.thStart': 'Start–end (LTST)', 'sc.thCrew': 'Crew', 'sc.thPurpose': 'Purpose', 'sc.thEnergy': 'Energy', 'sc.thNotes': 'Notes',
    'sc.delete': 'Delete', 'sc.stores': 'Habitat consumables and daylight',
    'sc.kO2': 'oxygen: planned / available (80% of stores)', 'sc.kWh': 'suit energy', 'sc.kWater': 'drinking water during EVA', 'sc.kDay': 'daylight (LTST)',
    'sc.rules': 'Rule check', 'sc.allOk': 'All rules satisfied.', 'sc.rulesLine': 'Rules: {r}',
    'sc.add': 'Add or change an EVA', 'sc.start': 'start', 'sc.dur': 'duration [h]', 'sc.purpose': 'EVA purpose', 'sc.save': 'Save', 'sc.defaultPurpose': 'EVA',
    'sc.error': 'Not saved: {e}',
    'err.api': 'Server error: {e}',
    'alt.btn': '⇄ Compare routes', 'alt.btnTitle': 'Show why this route was chosen and how other options fall short',
    'alt.title': 'Why this route?', 'alt.close': 'Close',
    'alt.intro': 'The planner looks for the route with the <b>lowest oxygen use</b> (effort model for 0.38 g) that <b>never enters no-go zones</b> (slope + 2σ above {deg}°, loose sand, boulders). Below, the same route compared with other options.',
    'alt.v.chosen': 'Chosen', 'alt.v.straight': 'Straight line', 'alt.v.shortest': 'Shortest safe', 'alt.v.strict': 'No caution zones',
    'alt.b.chosen': 'chosen', 'alt.b.unsafe': 'unsafe', 'alt.b.worse': 'worse', 'alt.b.impossible': 'impossible', 'alt.b.same': 'same',
    'alt.nums': '{len} · {time} · O₂ {o2} L',
    'alt.foot': 'All values computed on the same data (HiRISE DTM with ±σ uncertainty, detected boulders, sand map). Click a row to highlight the option on the map.',
    'why.minO2': 'lowest oxygen use: {o2} L', 'why.noForbidden': '0 m in no-go zones',
    'why.margin2s': 'slope taken with the DTM error margin (+2σ), limit {deg}°', 'why.cautionShare': '{m} m ({pct}%) in caution zones — slower walking with belay there',
    'why.forbidden': '{m} m through no-go zones ({parts})', 'why.part.steep': 'steep {m} m', 'why.part.sand': 'loose sand {m} m', 'why.part.boulders': 'boulders {m} m',
    'why.tooSteep': 'slope up to {deg}° (limit {max}°)', 'why.shorter': '{m} m shorter', 'why.longer': '{m} m longer',
    'why.moreO2': '+{l} L oxygen', 'why.slower': '{min} min slower (harder terrain)', 'why.fasterButUnsafe': '{min} min faster, but through no-go zones',
    'why.moreCaution': '+{m} m in caution zones', 'why.lessComms': '+{m} m without a link to the habitat', 'why.noPath': 'does not exist — caution zones close every passage',
    'why.sameAsChosen': 'same as the chosen route',
  },
};

export function t(key, vars) {
  let s = UI[lang][key] ?? UI.pl[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  return s;
}

export function plural(n) {
  if (lang === 'en') return n === 1 ? t('stops.1') : t('stops.many');
  return n === 1 ? t('stops.1') : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? t('stops.few') : t('stops.many');
}

// ---------- teksty z danych misji i z backendu ----------
const EXACT = {
  // mission.json: warstwy, legenda, tytuły
  'Dane NASA: HiRISE, THEMIS, CTX, MOLA, CRISM': 'NASA data: HiRISE, THEMIS, CTX, MOLA, CRISM',
  'oliwin wyraźny (bazalt lub piasek bazaltowy)': 'clear olivine (basalt or basaltic sand)', 'oliwin słaby / materiał mieszany': 'weak olivine / mixed material',
  'piroksen': 'pyroxene', 'uwodnienie / siarczany (słaby sygnał)': 'hydration / sulfates (weak signal)', 'krzemiany warstwowe Fe/Mg': 'Fe/Mg phyllosilicates',
  'minerały: oliwin, piroksen, uwodnienie, siarczany': 'minerals: olivine, pyroxene, hydration, sulfates',
  'Optyczna': 'Optical', 'Teren': 'Terrain', 'Termiczna': 'Thermal', 'Piasek': 'Sand', 'Głazy': 'Boulders', 'Zagrożenia': 'Hazards',
  'Łączność': 'Comms', 'Cień': 'Shadow', 'Niebo': 'Sky', 'Minerały': 'Minerals',
  'HiRISE 25 cm/px': 'HiRISE 25 cm/px', 'THEMIS noc 100 m/px': 'THEMIS night 100 m/px', '5 wskaźników, bez AI': '5 indicators, no AI',
  'metoda cieni, ≥1 m': 'shadow method, ≥1 m', 'nachylenie+2σ, piasek, głazy': 'slope+2σ, sand, boulders', 'o godzinie (suwak)': 'by hour (slider)',
  'RAD + DONKI + NOAA': 'RAD + DONKI + NOAA', 'jaśniej = bardziej stromo': 'brighter = steeper',
  'chłodno nocą: luźny materiał': 'cool at night: loose material', 'ciepło nocą: lita skała': 'warm at night: bedrock',
  'prawdopodobieństwo piasku': 'sand probability', 'kreskowanie: niska pewność': 'hatching: low confidence',
  'głaz (średnica w skali)': 'boulder (diameter to scale)', 'niska pewność wykrycia': 'low detection confidence',
  'zakaz: piasek, stromo, głazy': 'no-go: sand, steep, boulders', 'uwaga: nierówno': 'caution: rough',
  'brak zasięgu radiowego': 'no radio coverage', 'zasięg na granicy': 'marginal coverage', 'cień terenu o wybranej godzinie': 'terrain shadow at the selected hour',
  'wiatr z modelu, dawka z pomiaru RAD': 'wind from model, dose from RAD measurements',
  'Dane NASA: HiRISE, THEMIS, CTX, MOLA': 'NASA data: HiRISE, THEMIS, CTX, MOLA',
  'EVA-1 · trawers przez wydmy Bagnold · krater Gale': 'EVA-1 · traverse across the Bagnold dunes · Gale crater',
  'GALE · WYDMY BAGNOLD · HiRISE': 'GALE · BAGNOLD DUNES · HiRISE',
  'Render z DTM HiRISE · widok z hełmu': 'HiRISE DTM render · helmet view',
  'punkt obserwacyjny nad wydmami': 'the lookout above the dunes',
  'EVA-1 · dno krateru Jezero przy miejscu lądowania Perseverance': 'EVA-1 · Jezero crater floor near the Perseverance landing site',
  'JEZERO · LĄDOWISKO PERSEVERANCE · HiRISE': 'JEZERO · PERSEVERANCE LANDING SITE · HiRISE',
  'punkt obserwacyjny nad polem zmarszczek piaskowych': 'the lookout above the sand ripple field',
  // dane przykładowe
  'Dane przykładowe (syntetyczne)': 'Sample data (synthetic)', 'HiRISE, grudzień 2006': 'HiRISE, December 2006', 'EVA-1 · trawers przez boxwork · krater Gale': 'EVA-1 · traverse across boxwork · Gale crater',
  'MT SHARP · BOXWORK · DEMO': 'MT SHARP · BOXWORK · DEMO', 'CRISM 18 m/px': 'CRISM 18 m/px', 'THEMIS 100 m/px': 'THEMIS 100 m/px', 'RAD + MAVEN': 'RAD + MAVEN',
  'Render z DTM · widok z hełmu': 'DTM render · helmet view', 'nachylenie z DTM': 'slope from DTM', 'piasek, skarpy': 'sand, scarps',
  'lita skała': 'bedrock', 'luźny piasek': 'loose sand', 'skały z siarczanami': 'sulfate-bearing rocks', 'spoiwo grzbietów': 'ridge cement',
  'wiatr 7 m/s z NW': 'wind 7 m/s from NW', 'zakaz: piasek, skarpy': 'no-go: sand, scarps', 'cel próbki S-02': 'sample target S-02',
  // alarmy
  'ZAGROŻENIE': 'HAZARD', 'POGODA KOSMICZNA': 'SPACE WEATHER', 'BRAK TRASY': 'NO ROUTE', 'ZGŁOSZENIE Z TERENU': 'FIELD REPORT',
  'ostrzeżenie SEP · łazik jedzie do załogi': 'SEP warning · rover driving to the crew',
  'DONKI (symulacja zdarzenia)': 'DONKI (simulated event)', 'zgłoszenie z terenu (dron)': 'field report (drone)',
  // ocena trasy
  'bezpieczna': 'safe', 'bezpieczna z uwagami': 'safe with cautions',
  // raport: zagrożenia
  'Strome zbocze (poślizg, upadek)': 'Steep slope (slip, fall)', 'Luźny piasek (zakopanie, wysiłek)': 'Loose sand (sinking, effort)',
  'Głazy przy trasie (potknięcie, uszkodzenie skafandra)': 'Boulders near the route (trip, suit damage)',
  'Utrata łączności z habitatem': 'Loss of link to habitat', 'Niewystarczający zapas tlenu': 'Insufficient oxygen',
  'Zmrok przed powrotem': 'Dusk before return', 'Promieniowanie (GCR i burza słoneczna)': 'Radiation (GCR and solar storm)',
  'Niska temperatura (skafander, baterie)': 'Low temperature (suit, batteries)', 'Utrata dokładnej pozycji': 'Loss of accurate position',
  'wysokie': 'high', 'średnie': 'medium', 'niskie': 'low',
  '5 wskaźników: ciemność, zmarszczki, THEMIS, gładkość obrazu i DTM': '5 indicators: darkness, ripples, THEMIS, image and DTM smoothness',
  'trasa omija nachylenie+2σ > 25°; kijki, asekuracja': 'route avoids slope+2σ > 25°; poles, belay',
  'trasa omija piasek > 0,6; uwaga przy 0,35–0,6': 'route avoids sand > 0.6; caution at 0.35–0.6',
  'metoda cieni na HiRISE 0,25 m; wykrywalne ≥1 m': 'shadow method on HiRISE 0.25 m; detectable ≥1 m',
  'omijanie o ≥6 m; mniejsze kamienie niewidoczne z orbity': 'keep ≥6 m away; smaller rocks are not visible from orbit',
  'przekaźnik na łaziku; zgłoszenia co 10 min': 'relay on the rover; check-in every 10 min',
  'model wysiłku Pandolfa (0,38 g) skalibrowany do EVA Apollo': 'Pandolf effort model (0.38 g) calibrated to Apollo EVAs',
  'granica powrotu pieszego na mapie; rezerwa 20%': 'walk-back limit on the map; 20% reserve',
  'położenie Słońca (Allison & McEwen 2000) i cienie z DTM': 'Sun position (Allison & McEwen 2000) and DTM shadows',
  'planowany powrót ≥30 min przed zmierzchem': 'planned return ≥30 min before dusk',
  'RAD (Curiosity) 0,64 mSv/sol; DONKI i NOAA SWPC': 'RAD (Curiosity) 0.64 mSv/sol; DONKI and NOAA SWPC',
  'schron ≤15 min; przerwanie EVA przy S2+': 'shelter ≤15 min; abort EVA at S2+',
  'model cieplny z bezwładności termicznej (szacunek)': 'thermal model from thermal inertia (estimate)',
  'ogrzewanie skafandra; kontrola baterii': 'suit heating; battery checks',
  'nadajniki UWB w linii widoczności + odometria': 'line-of-sight UWB beacons + odometry', 'dodatkowe nadajniki na trasie': 'extra beacons along the route',
  'Prawdopodobieństwo z macierzy ryzyka (założone wartości), do kalibracji danymi z misji analogowych.':
    'Probability from the risk matrix (assumed values), to be calibrated with analog-mission data.',
  // pochodzenie danych
  'Model wysokości HiRISE, 1,01 m/px, projekcja równokątna, sfera Mars 2000 (r = 3396,19 km)': 'HiRISE elevation model, 1.01 m/px, equirectangular, Mars 2000 sphere (r = 3396.19 km)',
  'Ortoobraz HiRISE 0,25 m/px (do wykrywania głazów)': 'HiRISE orthoimage 0.25 m/px (boulder detection)',
  'Ortoobraz HiRISE 1 m/px (podgląd, mapa bazowa)': 'HiRISE orthoimage 1 m/px (preview, base map)',
  'Etykieta PDS zdjęcia: kąt padania i azymut Słońca, czas, Ls': 'PDS image label: Sun incidence and azimuth, time, Ls',
  'Etykieta PDS drugiego zdjęcia pary stereo (kąt emisji do oceny dokładności DTM)': 'PDS label of the second stereo image (emission angle for DTM precision)',
  'jakościowa bezwładność termiczna': 'qualitative thermal inertia', 'kontrola spójności zdjęcia': 'image consistency check',
  'kontrola wysokości bezwzględnej DTM': 'absolute DTM elevation check',
  // pogoda kosmiczna
  'Pomiary przy Ziemi — dla Marsa wskaźnik orientacyjny.': 'Measured near Earth — only an indicator for Mars.',
  'Brak danych o pogodzie kosmicznej': 'No space weather data', 'pobieranie…': 'fetching…', 'sieć': 'network', 'bufor (brak sieci)': 'cache (offline)',
  'brak danych': 'no data', 'zdarzenie cząstek energetycznych': 'solar energetic particle event',
  // harmonogram
  'trawers do WP2, rozpoznanie wydm': 'traverse to WP2, dune survey', 'rozmieszczenie nadajników UWB': 'UWB beacon deployment',
  'serwis łazika': 'rover service', 'pomiary na krawędzi krateru': 'crater rim measurements', 'wyjście': 'EVA',
  'wyjście dłuższe niż 8 h': 'EVA longer than 8 h',
  'jedno wyjście na sol na osobę, maks. 8 h;': 'one EVA per sol per person, max 8 h;',
  'po 3 kolejnych solach z wyjściem — sol odpoczynku;': 'after 3 consecutive EVA sols — a rest sol;',
  'maks. 24 h EVA na osobę w 7 solach;': 'max 24 h of EVA per person in 7 sols;',
  'wyjście w dzień: start ≥ 30 min po wschodzie, powrót ≥ 30 min przed zachodem;': 'daylight EVA: start ≥ 30 min after sunrise, return ≥ 30 min before sunset;',
  'tlen i energia na wszystkie wyjścia ≤ zapasy habitatu minus 20% rezerwy.': 'oxygen and energy for all EVAs ≤ habitat stores minus 20% reserve.',
  // łącze DTN
  'potwierdzenie': 'acknowledgement', 'brak danych pogody kosmicznej': 'no space weather data',
  'do Ziemi': 'to Earth', 'z Ziemi': 'from Earth', 'wiadomość': 'message', 'Koniec alarmu SEP': 'SEP alert ended',
  'Przerwa łącza z Ziemią na 30 min': 'Link to Earth down for 30 min', 'Kontrola misji: wiadomość odebrana': 'Mission control: message received',
  'harmonogram': 'schedule', 'błąd': 'error', 'skafander': 'suit', 'model': 'model',
  'trasa': 'route', 'alert': 'alert', 'zgłoszenie': 'report', 'łączność': 'comms', 'punkt': 'waypoint', 'EVA': 'EVA',
  'Brak trasy — najpierw wyznacz trasę.': 'No route — plan a route first.',
};

const WORDS = { glazy: 'boulders', piasek: 'sand', osuwisko: 'landslide', inne: 'obstacle', bezpieczne: 'safe passage', 'załoga': 'crew', 'łazik': 'rover', dron: 'drone', brak: 'none' };
const w = (s) => WORDS[s] ?? EXACT[s] ?? s;

// wzorce dla tekstów z liczbami (backend pisze po polsku)
const PATTERNS = [
  [/^Dron: pole głazów na trasie, (.+) m przed nami$/, (m) => `Drone: boulder field on the route, ${m[1]} m ahead`],
  [/^Pole głazów na trasie, (.+) m przed nami$/, (m) => `Boulder field on the route, ${m[1]} m ahead`],
  [/^nachylenie ±(.+)° z DTM$/, (m) => `slope ±${m[1]}° from DTM`],
  [/^z habitatu, maszt (.+) m$/, (m) => `from habitat, ${m[1]} m mast`],
  [/^Brak bezpiecznego przejścia do (.+)$/, (m) => `No safe passage to ${m[1]}`],
  [/^maks\. (.+)° ±(.+)° \(2σ: (.+)°\)$/, (m) => `max ${m[1]}° ±${m[2]}° (2σ: ${m[3]}°)`],
  [/^maks\. prawdopodobieństwo (.+) \(pewność min\. (.+)\)$/, (m) => `max probability ${m[1]} (min. confidence ${m[2]})`],
  [/^(\d+) głazów ≤15 m od trasy(?:, największy (.+) m)?$/, (m) => `${m[1]} boulders ≤15 m from the route${m[2] ? `, largest ${m[2]} m` : ''}`],
  [/^(.+) m trasy bez zasięgu \((.+)%\)$/, (m) => `${m[1]} m of route without coverage (${m[2]}%)`],
  [/^potrzeba (.+) L, dostępne (.+) L ponad rezerwę$/, (m) => `${m[1]} L needed, ${m[2]} L available above reserve`],
  [/^koniec ok\. (.+) LTST, zmierzch (.+)$/, (m) => `ends ~${m[1]} LTST, dusk ${m[2]}`],
  [/^dawka EVA ok\. (.+) μSv; (.+)$/, (m) => `EVA dose ~${m[1]} μSv; ${tx(m[2])}`],
  [/^grunt (.+)…(.+) °C$/, (m) => `ground ${m[1]}…${m[2]} °C`],
  [/^(.+) m trasy z < 3 nadajnikami w zasięgu$/, (m) => `${m[1]} m of route with < 3 beacons in range`],
  [/^DTM HiRISE (.+), σz (.+) m$/, (m) => `HiRISE DTM ${m[1]}, σz ${m[2]} m`],
  [/^linia widoczności z masztu (.+) m na DTM$/, (m) => `line of sight from a ${m[1]} m mast over the DTM`],
  [/^Trasa (\w+): (.+) km, (.+) min, (\d+) przystank\w*, ocena: (.+)\.$/, (m) => `Route ${m[1]}: ${m[2]} km, ${m[3]} min, ${m[4]} stops, rating: ${w(m[5])}.`],
  [/^Nachylenie maks\. (.+)° ±(.+)° \(DTM HiRISE (.+), σz (.+) m\)\.$/, (m) => `Max slope ${m[1]}° ±${m[2]}° (HiRISE DTM ${m[3]}, σz ${m[4]} m).`],
  [/^Ryzyka średnie\/wysokie: (.+)\.$/, (m) => `Medium/high risks: ${m[1] === 'brak' ? 'none' : m[1].split(', ').map((h) => trHazardShort(h)).join(', ')}.`],
  [/^Szansa ukończenia: (.+)% · zapas O₂ ponad rezerwę: (.+) L\.$/, (m) => `Chance of completion: ${m[1]}% · O₂ above reserve: ${m[2]} L.`],
  [/^Protony ≥10 MeV przy Ziemi: (.+) pfu \(burza: (.+)\); zdarzenia DONKI z 7 dni: (\d+)$/, (m) => `Protons ≥10 MeV near Earth: ${m[1]} pfu (storm: ${w(m[2])}); DONKI events in 7 days: ${m[3]}`],
  [/^Błąd pobierania: (.+)$/, (m) => `Fetch error: ${m[1]}`],
  [/^prędkość (.+) km\/s$/, (m) => `speed ${m[1]} km/s`],
  [/^rozbłysk klasy (.+)$/, (m) => `class ${m[1]} flare`],
  [/^start przed świtem\+30 min \(świt (.+) LTST\)$/, (m) => `start before sunrise+30 min (sunrise ${m[1]} LTST)`],
  [/^powrót po zmierzchu−30 min \(zmierzch (.+) LTST\)$/, (m) => `return after sunset−30 min (sunset ${m[1]} LTST)`],
  [/^(\w+): więcej niż jedno wyjście w tym samym solu$/, (m) => `${m[1]}: more than one EVA in the same sol`],
  [/^(\w+): 4 sole z rzędu z wyjściem \(sol (\d+)\) — potrzebny sol odpoczynku$/, (m) => `${m[1]}: 4 EVA sols in a row (sol ${m[2]}) — rest sol needed`],
  [/^(\w+): (.+) h EVA w 7 solach od sola (\d+) \(limit 24 h\)$/, (m) => `${m[1]}: ${m[2]} h of EVA in 7 sols from sol ${m[3]} (limit 24 h)`],
  [/^Tlen: plan wymaga (.+) L, dostępne (.+) L \(80% zapasów\)$/, (m) => `Oxygen: plan needs ${m[1]} L, ${m[2]} L available (80% of stores)`],
  [/^Trasa (\w+): (.+) m, (.+) min, (.+) L O₂, (.+)$/, (m) => `Route ${m[1]}: ${m[2]} m, ${m[3]} min, ${m[4]} L O₂, ${w(m[5])}`],
  [/^Nowa trasa (\w+) \((.+)\): (.+) m$/, (m) => `New route ${m[1]} (${tx(m[2])}): ${m[3]} m`],
  [/^zgłoszenie: (.+)$/, (m) => `report: ${w(m[1])}`],
  [/^(\S+): (\S+) \((.+)\) r=(.+) m$/, (m) => `${w(m[1])}: ${w(m[2])} (${m[3]}) r=${m[4]} m`],
  [/^(\w+) osiągnięty$/, (m) => `${m[1]} reached`],
  [/^Kontrola misji: przyjęto „(.+)”$/, (m) => `Mission control: received “${tx(m[1])}”`],
  [/^Start EVA ×(.+)$/, (m) => `EVA start ×${m[1]}`],
  [/^Zapisano ([\w-]+): sol (\d+), (.+), (.+) h$/, (m) => `Saved ${m[1]}: sol ${m[2]}, ${m[3]}, ${m[4]} h`],
  [/^Usunięto ([\w-]+)$/, (m) => `Deleted ${m[1]}`],
  [/^Nowa sesja EVA nr (\d+)$/, (m) => `New EVA session no. ${m[1]}`],
  // „EVA-1: …”, „EV1: …”, „POGODA KOSMICZNA: …” — przedrostek + znany tekst
  [/^([A-Z][A-Z0-9-]*\d): (.+)$/, (m) => `${m[1]}: ${tx(m[2])}`],
  [/^([A-ZĄĆĘŁŃÓŚŹŻ ]{3,}): (.+)$/, (m) => `${tx(m[1])}: ${tx(m[2])}`],
];
function trHazardShort(h) {
  if (EXACT[h]) return EXACT[h];
  const full = Object.keys(EXACT).find((k) => k.startsWith(`${h} (`));
  return full ? EXACT[full].split(' (')[0] : h;
}

const decimalDots = (s) => s.replace(/(\d),(\d)/g, '$1.$2');

/** Tłumaczy tekst z danych lub backendu na bieżący język (dla PL zwraca bez zmian). */
export function tx(s) {
  if (lang === 'pl' || typeof s !== 'string' || !s) return s;
  if (EXACT[s] !== undefined) return EXACT[s];
  for (const [re, fn] of PATTERNS) {
    const m = s.match(re);
    if (m) { const r = fn(m); if (r) return decimalDots(r); }
  }
  return decimalDots(s);
}

/** Wypełnia elementy z atrybutami data-i18n* w dokumencie. */
export function applyStatic(root = document) {
  document.documentElement.lang = lang;
  document.title = t('doc.title');
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
}
