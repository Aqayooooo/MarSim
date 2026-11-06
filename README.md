# MarSim (interfejs STRATA) — mapa i planer wyjścia (EVA) dla astronautów na Marsie

Interfejs na NASA Space Apps (wyzwanie o mapie dla astronautów na Marsie). Pokazuje warstwy danych o terenie, wyznacza bezpieczną trasę pieszą,
śledzi załogę (pozycja, tlen, zapas na powrót), reaguje na zagrożenia (głazy, burza słoneczna) i pozwala przejść trasę w 3D z perspektywy hełmu.

Etap: **sam interfejs**. Dane w `data/demo/` są syntetyczne; backend podłączy się według `docs/KONTRAKT_DANYCH.md`.

## Uruchomienie na dowolnym komputerze

Działa na Windows, macOS i Linux. Potrzebne: **Git**, **Python 3.10+**, przeglądarka z WebGL. Node.js tylko do generatora danych przykładowych.

### A. Sam interfejs na danych przykładowych (1 minuta)

```
git clone https://github.com/<konto>/MarSim.git
cd MarSim
python tools/serve.py
```

Otwórz http://localhost:5173 (z `?demo` prezentacja rusza sama). Nic nie trzeba instalować.

### B. Pełna wersja z backendem i prawdziwymi danymi NASA

```
python -m venv .venv
# Windows:  .venv\Scripts\activate      macOS/Linux:  source .venv/bin/activate
pip install -r requirements.txt
python backend/fetch_data.py          # pobiera produkty NASA do data/raw (kilkaset MB, raz)
python backend/build.py               # przetwarza je do data/missions/mount-sharp
python backend/server.py              # backend + UI na http://localhost:8000
```

Otwórz http://localhost:8000. UI sam wykryje backend i użyje prawdziwych danych.

### Kontynuowanie prac

- Plan i status etapów: [docs/PLAN.md](docs/PLAN.md). Zacznij od pierwszego etapu oznaczonego ☐ lub ◐.
- Format danych między backendem a UI: [docs/KONTRAKT_DANYCH.md](docs/KONTRAKT_DANYCH.md).
- Testy backendu: `python -m pytest backend/tests`. Test planera w Node: `node tools/test-planner.mjs`.
- Dane przykładowe od nowa (Node 18+): `node tools/generate-mock-data.mjs`.

## Obsługa

- **Warstwy**: kliknięcie wiersza w lewym panelu włącza lub wyłącza warstwę.
- **Mapa 2D / 3D / Hełm EV1**: przełącznik w nagłówku. W 3D: przeciąganie obraca, kółko przybliża.
- **Hełm EV1**: W A S D lub strzałki to chodzenie, przeciąganie myszą to rozglądanie, Shift przyspiesza (×8).
  Kolizje: astronauta idzie po powierzchni terenu, nie wejdzie na zbocze powyżej `eva.maxSlopeDeg` (25°), omija głazy i nie wyjdzie poza mapę.
  HUD ostrzega o strefach zakazanych i nierównym terenie.
- **Start EVA**: wyznacza trasę i uruchamia marsz załogi (ponowne kliknięcie to pauza).
- **▶ Prezentacja**: scenariusz 8 kroków jak w nagraniu wzorcowym.

## Struktura

```
index.html, styles.css      ekran 1664×744 skalowany do okna
src/main.js                 start, pętla klatek, przyciski, HUD
src/app.js                  stan i akcje (warstwy, trasa, EVA, zdarzenia)
src/demo.js                 reżyser prezentacji
src/core/                   teren (DEM), linie, symulacja EVA, formatowanie liczb
src/data/source.js          JEDYNE miejsce styku z danymi (pliki albo backend)
src/data/mockPlanner.js     zaślepka backendu: A* (do zastąpienia przez POST /plan)
src/ui/map2d.js             mapa 2D (canvas)
src/ui/panels.js            panele boczne i nakładki
src/ui/view3d.js            3D i widok z hełmu (three.js 0.160 z CDN)
tools/                      serwer, generator danych, test planera
docs/KONTRAKT_DANYCH.md     format danych dla backendu
```

## Uwagi

- three.js i czcionki ładują się z CDN, więc pierwsze uruchomienie wymaga internetu. Na konkurs offline: pobrać `three.module.js` i dodatki do `vendor/` i zmienić importmap w `index.html`.
- Zdjęcie w karcie „Widok w WP2” to render z modelu terenu, a nie zdjęcie Mastcam (brak prawdziwych danych na tym etapie).
