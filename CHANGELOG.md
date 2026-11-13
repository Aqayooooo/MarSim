# Historia zmian MarSim

Najnowsze na górze. Daty z commitów na gałęzi `pages-demo`, z której publikowane jest demo online.

## Niewydane

- **Załoga z imionami.** Na EVA wychodzą Bartek i Hubert (dawniej EV1 i EV2), a Mateusz i Eryk zostają w bazie. Imiona są identyfikatorami załogi w konfiguracji misji, API, harmonogramie, alarmach i raporcie. Kajuty nazywają się Kajuta Bartka, Huberta, Mateusza i Eryka, a zakładka widoku astronauty to **Hełm Bartka**. Ekran w kajucie pokazuje stałego lokatora i to, czy jest w składzie EVA (wcześniej przypisanie przesuwało się, gdy harmonogram wysyłał tylko część załogi). Punkt kontrolny EVA i harmonogram zapisane w bazie z EV1/EV2 wczytują się z nowymi imionami. Testy: `backend/tests/test_crew_names.py`, `tools/test-crew-names.mjs`.
- **Szybsza aplikacja** (wyniki tras, symulacji i obrazu bez zmian, sprawdzone bit w bit i co do piksela): graf kosztów budowany wprost jako macierz CSR, pamięć ostatnich wyników Dijkstry (ponowne planowanie tej samej trasy 3–5× szybciej), trasy awaryjne nie są liczone ponownie na postoju, szybsze sprawdzanie odcinków przy prostowaniu trasy; krok symulacji ok. 1,7× szybszy. Serwer kompresuje odpowiedzi (gzip), a pliki misji mają ETag — odświeżenie strony pobiera ok. 37 KB zamiast 4,2 MB. Teren 3D i kamienie są dzielone na kafle, więc karta graficzna pomija to, czego nie widać (hełm: 1,24 mln → 0,62 mln trójkątów, habitat: → 0,23 mln). Mapa 2D szybciej rysuje warstwy.
- **Poprawki z testów i przeglądu:** telemetria osoby z załogi, która nie bierze udziału w bieżącym wyjściu, daje 409 zamiast „nieznany członek załogi”; przedział czasu „co jeśli” liczony jako t/1,15…t/0,85; powrót do habitatu przed startem EVA jest odrzucany; krótki komunikat dla współrzędnych spoza mapy; odmiana „przystanek/przystanki/przystanków” w raporcie i jej tłumaczenie; brakujące tłumaczenia EN (źródła danych łazików, błędy zapisu planu); formularz planu wyjść nie gubi wpisanych danych po błędzie; raport nie pyta o „co jeśli” bez trasy. Telefon: imiona nie chowają się pod paskiem O₂, tabela planu przewija się w poziomie, przyciski mapy są klikalne przy otwartym profilu, skala nie zasłania alertu. `npm run test:browser` działa na Linuksie (Python z `.venv`, GPU, gdy jest).
- **Testy:** 279 nowych niezależnych testów (`backend/tests/test_independent_*.py`, `tools/test-independent*.mjs`, `npm run test:independent`) i testy regresyjne poprawek (`backend/tests/test_debug_regressions.py`).
- **Większa baza.** Za modułem dziennym jest hala z łukowym dachem. Mieści węzeł z mesą (stół, magazyn, szafki, zbiorniki wody, ekran z planem bazy) oraz korytarz sypialni. Przy korytarzu są 4 kajuty (łóżko, biurko z ekranem, lampka), łazienka (toaleta, umywalka, prysznic, odzysk wody) i siłownia (bieżnia z uprzężą, rower). Z węzła prowadzą przejścia do laboratorium (stoły, mikroskop, komora rękawicowa, próbki, łóżko medyczne) i do większej szklarni. Moduł dzienny ma kanapę pod drugim oknem i apteczkę.
- Nowe stanowiska (**E**): plan bazy z oznaczeniem „tu jesteś” i trybem nocnym, lampki w kajutach, bieżnia, odzysk wody, analiza próbek z punktów EVA (wysokość, nachylenie, minerały, piasek z warstw misji) i badanie załogi. Model bazy liczy też wodę (zbiornik 400 l, odzysk 93%), a panel Habitat pokazuje jej stan.
- **Poprawki wyglądu:** wnętrze ma własną scenę i własne lampy, więc słońce nie przenika już przez cienkie ściany i nie ma pasków cieni. Połączenia modułów mają prawdziwe otwory w skorupie: przejście ze szklarni nie jest już zasłonięte. Hełm rysuje się na końcu i nie przecina ścian.
- Poprawka: kamera orbitalna i kamera jazdy znowu się aktualizują, gdy w misji jest habitat (błąd w kolejności kroków renderowania).
- Hełm jak w grze: sterowanie myszą po kliknięciu widoku (Esc zwalnia), płynne ruszanie i hamowanie, ślizg wzdłuż przeszkód, kołysanie kroku. Tempo marszu ×1…×32 (kółko myszy, + −), bieg Shift (×3), skok spacją w grawitacji Marsa. Tempo widać na wizjerze.
- Jazda łazikiem pod **F** w hełmie: napęd i skręt jak w samochodzie, obrót w miejscu, przechył na terenie, kolizje. Kamera z trzeciej osoby na widocznym, obrotowym i wysuwanym wysięgniku na dachu. C przełącza na kamerę kabinową, a do sterowania służą wskaźniki jazdy i przyciski dotykowe.
- Dokładniejszy model łazika wzorowany na koncepcji NASA SEV (wymiary, 12 kół, śluzy z przypiętymi skafandrami, okna, radiator). Doszły kolizje z habitatem i łazikiem przy chodzeniu oraz poprawki migotania i cieni przy habitacie, a marsz przyspieszył do 2 m/s.
- **Habitat od środka.** Do habitatu wchodzi się po rampie przez śluzę. Panel w śluzie (**E**) zamyka drzwi, napełnia ją do ciśnienia kabiny 56,5 kPa (atmosfera eksploracyjna NASA, 34% O₂) i otwiera drzwi do modułu; w drugą stronę odpompowuje powietrze. Drzwi przesuwają się i blokują przejście, a światło śluzy jest czerwone przy próżni, żółte w trakcie cyklu i zielone pod ciśnieniem. W module są koje, kuchnia, skafandry, szafa podtrzymywania życia, konsola misji i okno, przez które widać teren. Obok jest szklarnia z grządkami i lampami LED. Po wejściu pod ciśnienie hełm się zdejmuje, a wizjer zastępują wskaźniki habitatu.
- Działające stanowiska (**E**): konsola z trzema stronami (misja, środowisko, energia), MOXIE na szafie podtrzymywania życia, lampy szklarni, światło, wywołanie śluzy z modułu. Stanowisko skafandrów rozpoczyna wyjście EVA. Ekrany pokazują dane z zegara misji.
- **Systemy habitatu w czasie misji** (`src/core/habitat.js`): moc paneli słonecznych zależy od wysokości słońca i zapylenia τ, a pobór od grzania, MOXIE, lamp, światła i pompy śluzy. Bateria 30 kWh i zbiornik O₂ 60 kg zmieniają się razem z zegarem misji. Poniżej 15% baterii habitat sam odłącza MOXIE i lampy szklarni, a po naładowaniu do 35% włącza je z powrotem. Nowy panel **Habitat** po prawej pokazuje baterię, zbiornik tlenu i bilans mocy. Model jest uproszczony i służy do pokazania zależności.
- Nowa bryła habitatu: moduł na podporach, śluza z rampą i poręczami, szklarnia, okno, większe pole paneli (ok. 40 m²). Kolizje habitatu liczone są ze ścian, drzwi i mebli, a nie z kół. Ten sam plan wnętrza obsługuje widok 3D i testy.
- Testy: `npm run test:habitat` (strefy, kolizje, śluza, stanowiska, bilans energii i tlenu) oraz test w przeglądarce, w którym postać wchodzi z rampy przez śluzę do modułu.
- Poprawka: `POST /api/plan` jest odrzucany od razu po starcie EVA, także zanim minie pierwszy krok symulacji.

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
