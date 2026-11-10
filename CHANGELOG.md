# Historia zmian MarSim

Najnowsze na górze. Daty z commitów na gałęzi `pages-demo`, z której publikowane jest demo online.

## 2026-11-10 (noc): wygląd, własny plan wyjścia, telefon, niepewność, testy w przeglądarce

- **Wygląd 3D:**
  - teren w palecie Marsa z cieniowaniem rzeźby z DEM i fakturą gruntu z bliska;
  - niebo ze słońcem według zegara misji i mgiełka na horyzoncie;
  - cienie słońca, kamienie o nieregularnych kształtach i drobne kamyki wokół obserwatora;
  - model łazika ciśnieniowego (sześć kół, kabina, śluzy skafandrów) i habitatu (moduły, panele, maszt łączności);
  - z orbity blok terenu z warstwami skalnymi i cieniem.
- **Punkty EVA:** edytor planu wyjścia na mapie: dodawanie kliknięciem, przeciąganie, postój, kolejność, usuwanie i powrót do punktów misji. Plan zostaje w przeglądarce. `GET /api/route` zwraca listę punktów, więc z backendem plan odtwarza się po odświeżeniu.
- **Telefon i tablet:** układ kolumnowy, nagłówek w kilku rzędach, powiększone napisy na mapie i wysoki obszar raportu. W hełmie są przyciski marszu dla ekranu dotykowego, a na tablecie w pionie panele stoją obok siebie.
- **Niepewność i wrażliwość:**
  - `GET /api/sensitivity` zwraca trasę planu przy limitach nachylenia 20–30°;
  - przedział tlenu i czasu bierze pod uwagę nachylenie od 0σ do 3σ niepewności DTM, model wysiłku ±20% i prędkość ±15%;
  - na mapie jest karta **Co jeśli?**, a w raporcie sekcja „Niepewność i wrażliwość”.
- **UX:** karta „Jak zacząć” przy pierwszym wejściu, pasek postępu wczytywania i odczyt terenu pod kursorem. Naprawiono nachodzenie macierzy ryzyka na tabelę w raporcie. Doszła też ikona strony.
- **Testy:**
  - testy w przeglądarce (Playwright): wersja bez serwera, edytor punktów, telefon i backend;
  - w CI budowa obrazu Docker i sprawdzenie API w kontenerze;
  - nowe testy backendu dla analizy wrażliwości i listy punktów.

## 2026-11-10 (wieczór): poprawki po przeglądzie

Commit `965278a`.

- **Koniec wyjścia:** EVA i postoje w punktach trasy kończą się, gdy dojdzie cała załoga. Wcześniej wyjście kończyło się, gdy EV2 był jeszcze 14 m od habitatu. Dotyczy backendu i wersji bez serwera.
- **Raport:** w trakcie wyjścia ryzyko braku tlenu (H5) liczy się z bieżącego tlenu osoby w najgorszym stanie, a nie tylko z planu trasy.
- **Wizjer hełmu:** pokazuje tlen osoby w najgorszym stanie z jej identyfikatorem. Próg alarmu wynika z rezerwy tlenu misji (20%), a nie ze stałej 25%.
- **Wersja bez serwera:** te same alarmy tlenu co w backendzie. Zapas na powrót liczony jest do habitatu, jak w backendzie.
- **Harmonogram:** pierwsze wyjście na bieżący sol ustala godzinę startu i skład załogi EVA po resecie. W „Planie wyjść” można edytować wpis.
- **API:** `POST /api/plan` w trakcie i po zakończeniu EVA zwraca 409. Telemetria `o2L` ponad pojemność butli zwraca 422. Stan EVA ma pole `paused`.
- **Poprawki drobne:** scenariusz pokazowy nie przerywa kroku symulacji, gdy na trasie nie ma punktu, na który czeka zdarzenie. Po trasie Z następna to A.
- **Testy:** 14 nowych testów (10 backendu, 4 interfejsu).

## 2026-11-10: backend 1.4, hełm 3D

Commity `bb28714`, `6346aab`, `edb6b54`, `b6764af`, `fc4cc61`.

- Wznowienie EVA po restarcie serwera, dziennik z łańcuchem skrótów SHA-256 i eksport CSV, opcje uruchamiania serwera.
- Pełne sterowanie EVA w interfejsie: pauza, powrót do habitatu, nowe wyjście, profil wysokości, pomoc i skróty.
- Hełm astronauty jako model 3D z panelem stanu na wizjerze i przykładem alarmu.
- Poprawki po niezależnych testach backendu i interfejsu.

## 2026-11-08: przegląd kodu

Commity `efef3ec`, `072df4a`.

- Poprawki sesji EVA, punktów trasy, bezpieczeństwa i pobierania danych; przyspieszenie działania.

## 2026-11-07: wersja bez serwera i jazda łazikiem

- Demo na GitHub Pages z zapisanymi odpowiedziami backendu.
- Wyznaczanie trasy kliknięciem na mapie i jazda łazikiem po trasie w 3D.
- Odczyt warstw w przeglądarce Brave, odświeżanie strony na żywo w serwerze deweloperskim.

## 2026-11-06: pierwsza wersja

- Mapa 2D, teren 3D, widok z hełmu i prezentacja.
- Potok danych NASA (HiRISE, CTX, THEMIS, MOLA, CRISM), backend na żywo: EVA, telemetria, UWB, DTN, pogoda kosmiczna, harmonogram, raport.
- PL/EN, praca bez internetu, SQLite, CI, Docker, drugi obszar: krater Jezero.
