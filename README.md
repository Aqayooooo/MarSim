# MarSim — mapa i planer wyjść (EVA) dla astronautów na Marsie

Projekt na **NASA Space Apps Challenge 2026** (wydarzenie lokalne: Stalowa Wola), wyzwanie o mapie dla astronautów na Marsie.
*English summary below.*

MarSim pokazuje teren z prawdziwych danych NASA i wyznacza bezpieczną trasę pieszą. W czasie wyjścia śledzi załogę: pozycję, tlen i zapas na powrót do habitatu. Reaguje na zagrożenia (głazy, burza słoneczna), a trasę można przejść w 3D z perspektywy hełmu.

- **Dwa obszary misji** (przełącznik w nagłówku), każdy to wycinek 1440 × 960 m:
  - krater Gale, wydmy Bagnold u podnóża Mount Sharp (4,67° S, 137,38° E);
  - krater Jezero, okolica lądowiska łazika Perseverance (18,44° N, 77,45° E).
- **Dane:** HiRISE (DTM 1 m i zdjęcia 0,25 m), CTX, THEMIS, MOLA, CRISM, NASA DONKI, NOAA SWPC. Pełna lista z adresami i sumami SHA-256 jest w [data-sources.json](data-sources.json).
- **Bez uczenia maszynowego w produkcie.** Głazy wykrywa geometria cieni, piasek pięć wskaźników fizycznych, minerały parametry spektralne CRISM, a trasę algorytm A* z modelem wysiłku.

## Uruchomienie

Wymagania: Windows, macOS albo Linux, **Python 3.10+** i przeglądarka z WebGL. Po pierwszej instalacji pakietów **działa bez internetu**: three.js i czcionki są w `vendor/`, a pogoda kosmiczna ma pamięć podręczną.

### Windows: jedno kliknięcie

| Polecenie | Co robi |
|---|---|
| `URUCHOM.bat` | pełna wersja z backendem: http://localhost:8000 (przy pierwszym uruchomieniu tworzy `.venv` i instaluje pakiety) |
| `URUCHOM.bat en` | to samo po angielsku |
| `URUCHOM.bat demo` | sam interfejs na danych przykładowych, bez instalacji: http://localhost:5173 |

### Ręcznie (każdy system)

```
python -m venv .venv
# Windows: .venv\Scripts\activate     macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python backend/server.py              # http://localhost:8000
```

### Docker

```
docker build -t marsim .
docker run --rm -p 8000:8000 -v marsim-data:/data marsim
```

### Przebudowa danych NASA (opcjonalnie)

Gotowe pliki misji są w `data/missions/<misja>/` (`mount-sharp`, `jezero`). Surowe produkty (ok. 0,5 GB na misję) trafiają poza repozytorium. Katalog wskazuje zmienna `MARSIM_DATA` albo plik `backend/config/paths.local.json`, np. `{ "dataDir": "D:/MarSim-data" }`.

```
python backend/fetch_data.py --mission jezero    # pobiera brakujące produkty, liczy SHA-256
python backend/build.py --mission jezero         # pełny potok → data/missions/jezero
python backend/build.py --mission jezero --only-minerals   # tylko warstwa CRISM
python tools/make_data_sources.py                # odświeża data-sources.json
```

## Obsługa

- **Obszar misji**: lista w nagłówku (Gale / Jezero). Każdy obszar ma osobną bazę (dziennik, zgłoszenia, harmonogram).
- **PL / EN**: przełącznik w nagłówku (albo `?lang=en` w adresie).
- **Warstwy**: kliknięcie albo spacja na wierszu w lewym panelu.
- **Mapa 2D / 3D / Hełm EV1 / Urządzenie / Raport / Plan wyjść**: zakładki w nagłówku.
- **Hełm**: klawisze W A S D lub strzałki to chodzenie, mysz to rozglądanie, Shift przyspiesza. Kolizje z terenem powyżej 25° i z głazami.
- **⇄ Porównaj trasy** (na mapie, z backendem): dlaczego wybrano tę trasę. Planer porównuje ją z linią prostą, najkrótszą bezpieczną i wariantem bez stref „uwaga” i podaje liczbowe powody (metry w strefach zakazanych, nachylenie, tlen, czas).
- **Start EVA**: wyznacza trasę i rusza z załogą. **▶ Prezentacja** odtwarza scenariusz w 8 krokach.
- **＋ Zgłoś z terenu**: kliknięcie na mapie dodaje przeszkodę albo bezpieczne przejście. Trasa przelicza się, jeśli trzeba.

## Co jest w środku

```
index.html, styles.css     ekran 1664×744 skalowany do okna
src/                       interfejs (moduły ES, bez kompilacji)
  i18n.js                  tłumaczenia PL/EN
  data/source.js           jedyne miejsce styku z danymi (pliki albo backend)
  ui/                      mapa 2D, 3D i hełm, panele, raport, harmonogram
vendor/                    three.js 0.160.0 i czcionki (offline)
backend/
  server.py                API (FastAPI) + walidacja pydantic, wiele misji (/api/missions)
  config/missions/<id>.json  konfiguracja obszaru: wycinek, habitat, trasa, załoga, produkty NASA
  sources/<id>.json        produkty NASA do pobrania dla obszaru
  live/                    silnik EVA, SQLite (store.py), raport, harmonogram, DTN, pogoda kosmiczna
  pipeline/                teren, głazy, piasek, minerały (CRISM), środowisko
  build.py, fetch_data.py  potok danych NASA
data/missions/<id>/        gotowe warstwy misji + provenance.json (pochodzenie i sumy kontrolne)
data/demo/                 dane syntetyczne (tryb bez backendu)
data-sources.json          wykaz użytych danych
docs/                      plan, kontrakt danych, bezpieczeństwo
```

**Zapis stanu.** Dziennik zdarzeń, zgłoszenia z terenu i harmonogram trafiają do bazy SQLite `marsim-<misja>.db` w katalogu danych i przetrwają restart. Przebieg symulacji EVA po restarcie zaczyna się od nowa, a historia zostaje w dzienniku (`GET /api/log`).

**Testy.**
- `python -m pytest backend/tests` (42 testy: potok, API, walidacja, zapis po restarcie, przełączanie misji, bezpieczeństwo trasy);
- `node tools/test-planner.mjs`;
- `node tools/test-i18n.mjs`.

Uruchamia je też CI (`.github/workflows/ci.yml`).

**Klucz NASA API.** DONKI działa na wspólnym kluczu `DEMO_KEY` o niskich limitach. Własny, darmowy klucz z https://api.nasa.gov ustaw w zmiennej `NASA_API_KEY`.

## Ograniczenia (uczciwie)

- Widok w punkcie WP2 to **render z modelu terenu HiRISE**, nie zdjęcie z kamery łazika. Interfejs to podpisuje.
- Model tlenu (równanie Pandolfa przeliczone na 0,38 g) nie jest skalibrowany danymi z prawdziwego skafandra.
- Wykrywanie głazów widzi obiekty od ok. 1 m. Mniejsze kamienie nie są widoczne z orbity.
- Brak logowania i ról. Serwer domyślnie słucha tylko lokalnie. Szczegóły: [docs/BEZPIECZENSTWO.md](docs/BEZPIECZENSTWO.md).
- Układ ekranu jest stały (skalowany), nie przebudowuje się na telefon. Dostępność poprawiona, ale bez pełnego audytu WCAG.
- Wersja pod linkiem (GitHub Pages) jest w planie: [docs/PLAN.md](docs/PLAN.md).
- Mapa piasku i zagrożeń jest względna dla wycinka (wskaźniki porównują miejsca w obrębie obszaru), więc procent „piasku” w różnych obszarach nie jest bezpośrednio porównywalny.

## Dokumenty

- [docs/PLAN.md](docs/PLAN.md): etapy i stan prac;
- [docs/KONTRAKT_DANYCH.md](docs/KONTRAKT_DANYCH.md): format danych między backendem a UI;
- [docs/BEZPIECZENSTWO.md](docs/BEZPIECZENSTWO.md): bezpieczeństwo i droga do wdrożenia;
- [docs/ROADMAPA.md](docs/ROADMAPA.md): przegląd i lista ulepszeń do poziomu profesjonalnego.

## Licencja i podziękowania

Kod: licencja MIT ([LICENSE](LICENSE)). three.js: MIT. Czcionki Inter i JetBrains Mono: SIL OFL 1.1.

Dane: NASA/JPL-Caltech/University of Arizona (HiRISE), NASA/JPL/MSSS (CTX), NASA/JPL/ASU (THEMIS), NASA/GSFC (MOLA), NASA/JPL/JHUAPL (CRISM), USGS Astrogeology (mozaiki), NASA CCMC (DONKI), NOAA SWPC. Projekt nie jest popierany przez NASA.

---

## English summary

**MarSim** is a map and EVA planner for astronauts on Mars, built for NASA Space Apps Challenge 2026. It uses real NASA data for two areas, the Bagnold dunes in Gale crater and the Perseverance landing site in Jezero crater:
- HiRISE DTM and orthoimages, CTX, THEMIS, MOLA and CRISM;
- live DONKI and NOAA space weather.

It shows hazard layers with uncertainty and plans a safe walking route. During the EVA it tracks crew oxygen and the walk-back limit, and replans around field reports. The route can also be viewed in 3D or from a helmet camera.

- **Run (Windows):** double-click `URUCHOM.bat`, or `URUCHOM.bat en` for English.
- **Run (any OS):** `pip install -r requirements.txt`, then `python backend/server.py`, then open http://localhost:8000.

It works offline after the first install. All data products are listed in [data-sources.json](data-sources.json).
