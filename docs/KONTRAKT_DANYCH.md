# Kontrakt danych UI ↔ backend (wersja 1)

UI MarSim nie interpretuje surowych danych NASA. Dostaje gotowe, przetworzone pliki i jeden endpoint do planowania trasy.
Backend ma wygenerować dokładnie te pliki; wtedy UI zadziała bez zmian w kodzie.

Dane przykładowe w `data/demo/` są **syntetyczne**: wygenerował je `tools/generate-mock-data.mjs`, który udaje backend.

## Układ współrzędnych

- Lokalny, w metrach. `x` rośnie na wschód, `y` na południe, punkt `(0,0)` to lewy górny róg obszaru (północny zachód).
- Wszystkie rastry pokrywają ten sam prostokąt `area.widthM × area.heightM` i są wyrównane do lewego górnego rogu.
- Wysokości w metrach. UI liczy je względem najniższego punktu, więc wartość bezwzględna nie ma znaczenia.

## Pliki misji (katalog misji)

| Plik | Format | Opis |
| --- | --- | --- |
| `mission.json` | JSON | Opis misji, warstw, punktów, załogi, zdarzeń (niżej) |
| `dem.f32` | float32 little-endian, wiersz po wierszu, `width × height` | Model wysokości (z HiRISE DTM) |
| `optical.png` | PNG 8-bit, skala szarości | Zdjęcie (np. kadr HiRISE), dowolna rozdzielczość pokrywająca obszar |
| `hazards.png` | PNG 8-bit, klasy | 0 = przejezdne, 1 = uwaga (nierówno), 2 = zakaz (piasek, skarpy, za stromo) |
| `thermal.png` | PNG 8-bit, wartości 0–255 | Bezwładność termiczna (THEMIS), mapowana liniowo na `valueRange` |
| `minerals.png` | PNG 8-bit, klasy | 0 = brak, dalej klasy opisane w `classes` (CRISM) |

Nazwy plików są dowolne: UI bierze je z `mission.json`.

## `mission.json`

```jsonc
{
  "contractVersion": 1,
  "synthetic": false,                       // true tylko dla danych testowych
  "mission": { "id": "eva-1", "title": "EVA-1 · …", "sourceLabel": "Dane: HiRISE, THEMIS, CRISM", "sol": 147, "startClock": "09:20" },
  "area": { "label": "MT SHARP · BOXWORK · HiRISE", "widthM": 1440, "heightM": 960 },
  "dem": { "file": "dem.f32", "encoding": "float32le", "width": 480, "height": 320, "cellM": 3, "unit": "m" },
  "layers": [                               // kolejność = kolejność w panelu; id są stałe
    { "id": "optical",  "name": "Optyczna",   "desc": "HiRISE 25 cm/px", "colorOff": "#45403F", "colorOn": "#9F9F9E",
      "raster": { "file": "optical.png", "encoding": "png-gray8", "width": 1440, "height": 960, "cellM": 1 },
      "legend": [{ "color": "#9F9F9E", "text": "HiRISE, grudzień 2006" }] },
    { "id": "terrain",  "derivedFrom": "dem", … },          // nachylenie liczy UI z DEM
    { "id": "thermal",  "raster": { …, "cellM": 100, "valueRange": [100, 600] }, … },
    { "id": "minerals", "raster": { …, "encoding": "png-class8", "classes": { "1": { "color": "#AE7EFF", "text": "spoiwo grzbietów" } } }, … },
    { "id": "hazards",  "raster": { …, "encoding": "png-class8", "classes": { "1": {…}, "2": {…} } }, … },
    { "id": "sky", … }                                      // bez rastra: włącza dane środowiskowe
  ],
  "rover": { "x": 350, "y": 720, "speedKmh": 12 },
  "waypoints": [ { "id": "WP1", "x": 560, "y": 470, "stopMin": 15, "target": null, "view": null },
                 { "id": "WP2", "x": 985, "y": 180, "stopMin": 15, "target": "cel próbki S-02",
                   "view": { "source": "render", "caption": "Render z DTM · widok z hełmu" } } ],
  "crew": [ { "id": "EV1", "o2": 100, "o2RatePctH": 12 }, { "id": "EV2", "o2": 100, "o2RatePctH": 14 } ],
  "eva": { "walkKmh": 2.5, "maxSlopeDeg": 25, "o2ReservePct": 55, "sepO2Factor": 1.25, "shelterMin": 15, "shelterRadiusM": 400 },
  "environment": { "doseUsvh": 27, "dustTau": 0.52, "wind": { "meanMs": 7, "spreadMs": 1, "fromDeg": 315 },
                   "temperature": [["09:20", -41], ["11:30", -25]] },
  "events": [ … ]                          // scenariusz zdarzeń, patrz plik przykładowy
}
```

`view.source` może być `"render"` (UI renderuje widok z modelu terenu) albo, w przyszłości, adresem zdjęcia (np. Mastcam).

## Plan trasy: `POST {api}/plan`

UI w trybie `?api=…` wysyła:

```json
{ "missionId": "eva-1",
  "start": { "x": 350, "y": 720 },
  "waypoints": [ { "id": "WP1", "x": 560, "y": 470, "stopMin": 15 }, { "id": "WP2", "x": 985, "y": 180, "stopMin": 15 } ],
  "obstacles": [ { "x": 700, "y": 300, "radiusM": 55 } ] }
```

Backend odpowiada:

```json
{ "ok": true,
  "path": [ { "x": 350, "y": 720 }, … , { "x": 985, "y": 180 } ],
  "waypointIndex": [13, 26],
  "lengthM": 932, "durationH": 0.9, "stops": 2, "rating": "bezpieczna",
  "expanded": [ { "x": 300, "y": 690 }, … ] }
```

- `path` zaczyna się dokładnie w `start` i przechodzi dokładnie przez każdy punkt WP; `waypointIndex[i]` to indeks WP nr i w `path`.
- `expanded` (opcjonalnie): próbka odwiedzonych komórek w kolejności przeszukiwania, do animacji kropek.
- Przy braku trasy: `{ "ok": false, "error": "Brak bezpiecznego przejścia do WP2" }`.

W trybie plikowym tę samą odpowiedź daje `src/data/mockPlanner.js` (A* na siatce zagrożeń i nachylenia).

## Tryby uruchomienia UI

- `http://localhost:5173/`: dane z `data/demo/`.
- `?data=data/inna-misja`: inny katalog z plikami w tym formacie (np. wynik backendu zapisany na dysk).
- `?api=http://localhost:8000`: pliki z `{api}/missions/current/…`, trasa z `POST {api}/plan`.
- `?demo`: automatyczny start prezentacji.

## Wersja 2 (prawdziwe dane, backend)

`contractVersion: 2` dodaje do wersji 1:

- `rasters`: siatki float32 obok DEM: `slope` (°), `slopeSigma` (σ nachylenia, °), `o2ToHabitat` (litry O₂ potrzebne na dojście do habitatu), `timeToHabitat` (s).
- Nowe warstwy: `sand` (prawdopodobieństwo 0–255 + `confidence`), `boulders` (`vector`: `boulders.json` z polami x, y, diameterM, heightM, confidence),
  `comms` (klasy 0 brak zasięgu, 1 granica, 2 zasięg), `shadow` (`hourly`: `shadow_HH.png` dla godzin LTST).
- `habitat`, `sun` (Ls, deklinacja, zmierzch, wysokość Słońca co godzinę), `dem.source`, `dem.year`, `dem.sigmaZM`.
- `provenance.json` (obok): źródła z URL i SHA-256, geometria zdjęć, dokładność DTM, metody, kontrole spójności, sumy SHA-256 plików wynikowych.

API backendu (`python backend/server.py`, port 8000):

| Metoda i ścieżka | Co robi |
| --- | --- |
| `GET /api/health` | wykrycie backendu przez UI |
| `GET /missions/current/{plik}` | pliki misji |
| `POST /api/plan` | trasa (A* po koszcie O₂ z nachyleniem + 2σ, piaskiem, głazami, zgłoszeniami); tylko przed startem EVA, w trakcie i po zakończeniu — 409 |
| `GET /api/route` | aktualna trasa, odrzucone odcinki i lista punktów (`waypoints`) bieżącego planu |
| `GET /api/sensitivity` | „co jeśli”: trasa planu przy limitach nachylenia 20–30° (`variants`: limit, długość, czas, tlen, ścieżka albo błąd) oraz `interval` — przedział tlenu i czasu (nachylenie 0σ–3σ, model wysiłku ±20%, prędkość ±15%); bez trasy — 409 |
| `GET /api/stream` (SSE) / `GET /api/state` | stan EVA 4×/s: zegar, załoga (pozycja + elipsa błędu, O₂, CO₂, bateria, ciśnienie, tętno, dawka, granica powrotu), łazik, środowisko, alerty, trasy awaryjne, łącze z Ziemią. `phase`: idle, walking, stop, atTarget, returning, done; `paused`: `true`, gdy rozpoczęte i niezakończone wyjście jest wstrzymane (`phase` pokazuje wtedy fazę sprzed pauzy); `gap`: odstęp EV2 za EV1 w metrach (w punkcie trasy maleje do 0 — punkt jest osiągnięty, gdy dojdzie ostatnia osoba) |
| `POST /api/eva/{start,pause,reset,timescale,inject}` | sterowanie EVA; `inject`: `boulders`, `sep`, `sep-end`, `link-outage` |
| `POST /api/telemetry` | wejście z prawdziwego skafandra (wyłącza model dla tej osoby); `o2L` ponad pojemność butli — 422 |
| `GET/POST /api/observations` | zgłoszenia z terenu (załoga, łazik, dron) — zmieniają mapę i trasę |
| `GET /api/spaceweather` | NASA DONKI + NOAA SWPC (z buforem na brak sieci) |
| `GET /api/link`, `POST /api/link/send` | kolejka DTN do Ziemi z opóźnieniem z położeń planet |
| `GET/POST/PUT/DELETE /api/schedule` | harmonogram wyjść, zapasy, odpoczynek, światło dzienne; pierwsze wyjście na sol misji ustala godzinę startu i załogę EVA po resecie |
| `GET /api/report` | analiza zagrożeń, ryzyka i skuteczności + skrót danych źródłowych; pole `uncertainty` — przedział tlenu i czasu trasy |
| `GET /api/provenance` | pełne pochodzenie danych |
