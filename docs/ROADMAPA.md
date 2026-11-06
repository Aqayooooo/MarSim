# MarSim — droga do poziomu profesjonalnego (instytucjonalnego)

Przegląd z 6.11.2026. Lista jest pomyślana jako „przedsmak”: co pokazać na konkursie jako kierunek. Nie jest to plan do pełnej realizacji przed Space Apps.
Oznaczenia: ★ zrobić przed konkursem (mały koszt, duży efekt), ◆ pokazać jako kierunek (makieta lub opis), ○ dalsza przyszłość.

## Stan po przeglądzie

Sprawdzone w przeglądarce na obu obszarach (Gale, Jezero), po polsku i po angielsku:
- warstwy, mapa 2D, 3D, hełm, urządzenie, raport, plan wyjść, zgłoszenie z terenu z przeliczeniem trasy;
- pełna prezentacja 8 kroków;
- przełączanie obszarów;
- tryb bez backendu.

Konsola przeglądarki bez błędów. Testy: 42 pytest, test planera, test tłumaczeń.

Naprawione w tym przeglądzie:
- **Błąd bezpieczeństwa planera:** wygładzanie trasy ścinało narożniki przez strefy zakazane (na Jezero 12 m trasy w zakazie). Teraz skrót jest dozwolony tylko wtedy, gdy nie wchodzi w zakaz. Test regresyjny pilnuje 0 m w zakazie na obu obszarach.
- **Stary kod w przeglądarce po aktualizacji:** pliki interfejsu nie miały nagłówka wymuszającego sprawdzenie. Teraz `Cache-Control: no-cache`.
- **Drobne usterki:** nachodzący tekst w karcie dawki, zdublowany podpis „Render…” w widoku punktu.

Nowe: **„Dlaczego ta trasa?”** (przycisk „⇄ Porównaj trasy” i krok 02 prezentacji). Planer liczy cztery warianty na tych samych danych i podaje liczbowe powody, czemu inne przegrywają:
- linia prosta: przez zakaz, za stromo;
- najkrótsza bezpieczna: więcej tlenu, wolniej, więcej terenu „uwaga”;
- bez stref „uwaga”: nie istnieje.

## 1. Zaufanie do decyzji (wyjaśnialność)

- ★ Porównanie wariantów trasy z powodami. **Zrobione.**
- ★ W raporcie dodać sekcję „Założenia i progi”: limit nachylenia 25°, margines 2σ, próg piasku 0,6, rezerwa O₂ 20%, z odnośnikiem do źródła lub decyzji. Dziś są rozproszone w kodzie i konfiguracji.
- ◆ Profil trasy: wykres wysokości i nachylenia ±σ wzdłuż trasy z zaznaczonymi strefami „uwaga”.
- ◆ Analiza wrażliwości: „gdyby limit nachylenia był 20°, trasa wydłuża się o X m”. Suwak w panelu porównania.
- ○ Niepewność wyniku: zamiast jednej liczby O₂ przedział, np. metodą Monte Carlo na σ DTM i parametrach modelu wysiłku.

## 2. Jakość danych i walidacja

- ★ Na mapie oznaczyć obszary bez danych lub o niskiej pewności. Dziś pewność piasku jest kreskowana, ale głazy poniżej 1 m są niewidoczne bez ostrzeżenia na mapie.
- ◆ Walidacja na prawdziwej trasie łazika: porównać mapę zagrożeń z trasą Perseverance w Jezero (trasy z NASA PDS) i z miejscami, gdzie łazik zwalniał. To mocny argument dla jury.
- ◆ Weryfikacja głazów: zestawić wykrycia z ręcznie oznaczonym fragmentem (precyzja i czułość).
- ○ Kalibracja modelu tlenu danymi z analogów (testy skafandrów NASA, NBL, misje analogowe).

## 3. Bezpieczeństwo i role

- ◆ Logowanie i role: dowódca, załoga, kontrola misji, obserwator. Na konkurs wystarczy przełącznik roli w interfejsie, który ukrywa przyciski sterowania. Opis w [BEZPIECZENSTWO.md](BEZPIECZENSTWO.md).
- ◆ Dziennik zdarzeń z łańcuchem skrótów (każdy wpis zawiera hash poprzedniego) i eksport do PDF lub CSV do raportu po misji.
- ○ HTTPS, uwierzytelnianie urządzeń skafandra (mTLS), klasyfikacja oprogramowania wg NASA NPR 7150.2.

## 4. Niezawodność

- ★ Wznowienie EVA po restarcie serwera. Dziś po restarcie symulacja zaczyna od nowa, a historia zostaje w dzienniku. Wystarczy zapisywać migawkę stanu co kilka sekund.
- ◆ Tryb degradacji: wyraźny pasek „pracuję na danych z pamięci podręcznej” lub „brak łączności z backendem”, gdy coś odpada.
- ○ Testy interfejsu w przeglądarce (Playwright) w CI, testy obciążeniowe strumienia telemetrii.

## 5. Interfejs i dostępność

- ★ Skróty klawiaturowe z ekranem pomocy (?): warstwy 1–9, M/3/H dla widoków, C dla porównania tras.
- ◆ Układ elastyczny zamiast stałego ekranu 1664×744 (tablet w habitacie, telefon kontroli misji).
- ◆ Tryb wysokiego kontrastu i pełny audyt WCAG 2.1 AA (czytnik ekranu, kontrast kolorów warstw).
- ○ Wersja na urządzenie na przedramieniu jako osobna strona z dużymi elementami.

## 6. Operacje misji

- ◆ Planowanie trasy przez klikanie punktów na mapie i przeciąganie punktów trasy. Dziś punkty trasy są w konfiguracji.
- ◆ Okna czasowe: trasa liczona z uwzględnieniem cienia o danej godzinie i zmierzchu (dane już są w warstwie „Cień”).
- ○ Wiele zespołów EVA naraz, kolizje z łazikiem, rezerwacja zasobów habitatu.

## 7. Proces i dokumentacja

- ★ Publiczne repozytorium z działającym CI (plik gotowy, czeka na uprawnienie `workflow` w tokenie GitHuba).
- ★ Krótki „Model card” planera: wejścia, wyjścia, ograniczenia, znane błędy (jedna strona w docs).
- ◆ Wersja demo pod linkiem (GitHub Pages w trybie bez backendu).
- ○ Rejestr zmian (CHANGELOG) i wersjonowanie danych misji obok wersji kodu.
