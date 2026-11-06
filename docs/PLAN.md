# MarSim — plan prac

## Stan na 2026-11-06

- Obszar: wydmy Bagnold u podnóża Mount Sharp (krater Gale), środek 4,6735° S, 137,3762° E, wycinek 1440 × 960 m.
- Dane: DTM HiRISE DTEEC_040770_1755_039280_1755_U01, ortoobrazy ESP_039280_1755 (0,25 m i 1 m), THEMIS (podczerwień nocna, 100 m), CTX (Gale), MOLA.
- Wyniki potoku: 649 kandydatów na głazy (155 pewnych), piasek ok. 48% obszaru, niepewność nachylenia (mediana) ±1,5°, DTM−MOLA 11,3 m.
- Działa: backend (`backend/server.py`), UI w trybie z backendem i bez niego, 7 testów (`python -m pytest backend/tests`).
- Do zrobienia: CRISM (minerały) — nie podłączone; kalibracja modelu tlenu danymi z prawdziwego skafandra; walidacja głazów z obrazami z łazika.

Dokument opisuje, **co** budujemy, **w jakiej kolejności** i **po czym poznać, że działa**.
Każdy etap ma listę plików i test odbioru, więc pracę może podjąć ktokolwiek, na dowolnym komputerze (instrukcja w README).
Status przy każdym etapie: ☐ do zrobienia · ◐ w trakcie · ☑ zrobione.

## 0. Architektura docelowa

```
NASA PDS / USGS / DONKI / NOAA
        │  backend/fetch_data.py        (pobieranie + sumy kontrolne)
        ▼
data/raw/…  (surowe produkty, poza git)
        │  backend/build.py             (potok przetwarzania)
        ▼
data/missions/<id>/  mission.json, dem.f32, optical.png, hazards.png, boulders.json,
                     sand.png, slope_sigma.png, comms.png, shadow_*.png, provenance.json
        │  backend/server.py (FastAPI, port 8000)
        ▼
UI (index.html)  ←→  /plan /walkback /emergency /telemetry /position /observations
                     /spaceweather /dose /link /schedule /report
```

Zasada: UI nie liczy niczego, co wpływa na bezpieczeństwo. Liczy to backend, a wynik zapisuje razem z pochodzeniem danych.
Bez backendu UI dalej działa na danych przykładowych (`python tools/serve.py`).

## Etap 1 ☑ Prawdziwe dane NASA

- `backend/sources.json`: lista produktów z identyfikatorami PDS, adresem URL, wersją i datą pozyskania.
  - HiRISE DTM (1 m/px, PDS `.IMG`) i ortoobraz (25 cm/px, `.JP2`) dla obszaru Mount Sharp (krater Gale).
  - CTX (6 m/px): kontekst wokół obszaru HiRISE.
  - THEMIS: bezwładność termiczna (~100 m/px).
  - CRISM: produkt MTRDR lub parametry mineralne (~18 m/px), jeśli dostępny dla obszaru.
  - MOLA MEGDR: wysokości regionalne (~460 m/px) do kontroli DTM.
- `backend/fetch_data.py`: pobiera tylko brakujące pliki, wznawia przerwane pobierania, liczy SHA-256.
- Układ współrzędnych: produkty HiRISE są w projekcji równokątnej na sferze Mars 2000 (IAU), długość planetocentryczna wschodnia.
  Potok przelicza wszystko do jednego układu metrycznego obszaru i zapisuje narożniki w stopniach (lat/lon).
- **Test:** `python backend/fetch_data.py --check` wypisuje każdy plik z sumą SHA-256 i statusem OK.

## Etap 2 ☑ Teren, nachylenie z marginesem błędu, pochodzenie

- `backend/pipeline/terrain.py`: wycięcie obszaru, przeskalowanie DTM, nachylenie, nierówności.
- **Niepewność nachylenia:** z dokładności pionowej DTM (z etykiety PDS albo z raportu DTM, typowo 0,2–0,5 m)
  i rozmiaru komórki: σ_nachylenia ≈ atan(√2·σz / (2·d)). Wynik to raster `slope_sigma`.
- `provenance.json`: dla każdej warstwy identyfikator produktu, wersja, data zdjęcia, rozdzielczość, suma SHA-256, wersja potoku, parametry.
- **Test:** karta trasy pokazuje np. „nachylenie maks. 12° ±3° · DTM HiRISE 2014”, a raport wymienia źródła z sumami.

## Etap 3 ☑ Wykrywanie głazów i piasku (bez AI)

- `backend/pipeline/boulders.py`: metoda cieni.
  1. Kierunek padania światła i wysokość Słońca z etykiety PDS zdjęcia.
  2. Próg ciemnych pikseli (lokalny, względem tła), segmentacja obszarów cienia.
  3. Cień przypisany do głazu, gdy leży po stronie przeciwnej do Słońca od jasnej plamki.
  4. Wysokość głazu = długość cienia × tan(wysokość Słońca); średnica z szerokości cienia prostopadle do kierunku światła.
  5. Wynik: `boulders.json` (x, y, średnica, wysokość, pewność) oraz mapa gęstości skał.
  - Ograniczenie: wykrywalne od ok. 1–1,5 m średnicy (3–6 pikseli przy 25 cm/px).
- `backend/pipeline/sand.py`: zestawienie warstw, każda daje wynik 0–1:
  - niska bezwładność termiczna (THEMIS),
  - ciemne i gładkie miejsca na zdjęciu,
  - falisty wzór zmarszczek: moc widma w paśmie długości fali 2–15 m (analiza Fouriera w oknach),
  - małe nierówności w DTM.
  - Wynik: prawdopodobieństwo piasku oraz pewność (ile wskaźników się zgadza).
- **Test:** na przykładowym kadrze głazy > 1,5 m są zaznaczone, a pola wydm mają prawdopodobieństwo piasku > 0,6.

## Etap 4 ☑ Środowisko: łączność, światło, temperatura, promieniowanie

- `comms.py`: mapa zasięgu radiowego z anteny habitatu (linia widoczności po DTM, wysokość masztu z konfiguracji).
- `illumination.py`: położenie Słońca na Marsie (algorytm Allison & McEwen 2000, jak w Mars24), cienie terenu co godzinę, godzina zmierzchu.
- `thermal_model.py`: temperatura powierzchni w ciągu sola z bezwładności termicznej, albedo i oświetlenia (uproszczony model 1-D).
- Promieniowanie: prognozy burz słonecznych z NASA DONKI (zdarzenia SEP, CME) i NOAA SWPC, z pamięcią podręczną na brak łączności.
  Dawka skumulowana każdego astronauty i limity NASA-STD-3001 (dawka w karierze 600 mSv; ostrzeżenia przy progach).
- **Test:** warstwy „Łączność” i „Cień o godzinie” widoczne w UI; karta dawki pokazuje dawkę skumulowaną i % limitu.

## Etap 5 ☑ Backend na żywo

- `backend/server.py` (FastAPI):
  - `POST /plan`: A* z kosztem nachylenia (z marginesem: nachylenie + 2σ), piasku, głazów; zwraca trasę, długość, czas, tlen i niepewność.
  - `GET /walkback`: granica powrotu pieszego, czyli gdzie załoga zdąży wrócić do habitatu na zapasach skafandra, nawet bez łazika.
  - `GET /emergency`: trasy awaryjne do łazika i habitatu z bieżącej pozycji, przeliczane na bieżąco.
  - `POST /telemetry` + `GET /telemetry/stream` (SSE): tlen, CO₂, bateria, ciśnienie, temperatura, tętno.
    Na razie z symulatora skafandra; prawdziwy skafander wysyła te same pola.
  - `GET /position`: pozycja bez GPS z trilateracji nadajników radiowych (UWB) i odometrii, z elipsą błędu.
  - `POST /observations`: zgłoszenie z terenu (załoga, łazik, dron) zmienia mapę zagrożeń i trafia do pochodzenia danych.
  - `GET /link`: kolejka „store-and-forward” (DTN) do Ziemi z opóźnieniem 3–22 min; habitat działa bez Ziemi.
  - `GET/POST /schedule`: wiele wyjść, zapasy (tlen, woda, baterie), odpoczynek załogi.
  - `GET /report`: analiza zagrożeń, skuteczności misji i ryzyka z krótkim podsumowaniem danych, na których oparto ocenę.
- Model tlenu: wydatek energii z równania Pandolfa (ciężar ciała, sprzętu, nachylenie, prędkość) dla grawitacji 0,38 g,
  przeliczony na zużycie O₂ (≈ 20,1 kJ na litr O₂). Parametry skafandra i ludzi w `backend/config/crew.json`.
- **Test:** `python -m pytest backend/tests` przechodzi; `/plan` dla trasy przez pole głazów omija wykryte głazy.

## Etap 6 ☑ UI: dane, niepewność, raport, plan wyjść

- Nowe warstwy: Głazy (wykryte), Piasek (prawdopodobieństwo), Łączność, Cień o godzinie (suwak godziny).
- Karta trasy: „TRASA A bezpieczna” + „nachylenie maks. 12° ±3°” + źródła.
- Na mapie: granica powrotu pieszego i trasy awaryjne.
- Zakładka „Raport”: zagrożenia, ryzyko, skuteczność misji, podsumowanie danych i pochodzenie.
- Zakładka „Plan wyjść”: harmonogram EVA, zapasy i odpoczynek.
- Wskaźnik łączności z Ziemią: opóźnienie, kolejka wiadomości.

## Etap 7 ☑ UI: urządzenie w hełmie i zgłoszenia z terenu

- Zakładka „Hełm”: minimalistyczny ekran małego urządzenia (np. 480×320) z najważniejszymi danymi:
  O₂, CO₂, bateria, granica powrotu, kierunek i odległość do celu, ostrzeżenie. Duże cyfry, wysoki kontrast, zero zbędnych elementów.
- Zgłoszenie z terenu: kliknięcie na mapie → typ (głaz, piasek, osuwisko, bezpieczne przejście) → aktualizacja mapy i trasy.

## Etap 8 ◐ Testy całości

- Prezentacja 8 kroków na prawdziwych danych.
- Testy jednostkowe potoku (głazy, piasek, nachylenie, A*, tlen) na małych wycinkach.
- Sprawdzenie w przeglądarce: każda warstwa, raport, plan wyjść, hełm, zgłoszenia.

## Poza zakresem (świadomie)

- Praca bez internetu: biblioteki z CDN zostają na razie.
- Cele badawcze i katalog próbek.
- Certyfikacja NASA (NPR 7150.2, NASA-STD-8739.8): opisana w docs jako droga do wdrożenia, nie realizowana.
