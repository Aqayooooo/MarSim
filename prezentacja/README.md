# Prezentacja MarSim

Siedem slajdów z obracającym się modelem Marsa 3D (three.js), zrzutami z aplikacji i notatkami dla czterech mówców.

## Uruchomienie

Z katalogu głównego repozytorium:

```
python -m http.server 8080
```

Potem otwórz http://localhost:8080/prezentacja/. Działa bez internetu: three.js bierze z `vendor/`, kroje pisma z `prezentacja/fonts/`.

## Sterowanie

| Klawisz | Działanie |
|---|---|
| → / spacja / klik | następny krok lub slajd |
| ← | poprzedni |
| 1–7 | skok do slajdu |
| N | notatki prowadzącego (pełny tekst) |
| R | podział ról |
| F | pełny ekran |

Na slajdzie 5 pierwsze kliknięcie przełącza wizjer ze stanu „w normie” na alarm tlenu.

## Podział ról

Cztery role zamiast czterech kawałków slajdów. Każda ma temat na slajdach, zadanie poza slajdami i zakres pytań, na które odpowiada. Prowadzący otwiera i zamyka, więc kolejność mówców to 1 → 2 → 3 → 4 → 1.

| Rola | Mówca | Slajdy | Czas | Na slajdach | Poza slajdami | Odpowiada na pytania o |
|---|---|---|---|---|---|---|
| Prowadzenie | Osoba 1 | 1 i 7 | ok. 1:40 | otwarcie: problem i dla kogo jest MarSim; zamknięcie: stan prac, ograniczenia, następne kroki | zapowiada pokaz, prowadzi pytania i kieruje je do właściwej osoby | cel projektu, stan prac, plany |
| Dane | Osoba 2 | 2–3 | ok. 2:05 | środowisko Marsa w liczbach i dane NASA w warstwach mapy | pilnuje czasu całego wystąpienia | źródła danych, dokładność, metody |
| Planer i pokaz | Osoba 3 | 4 | ok. 1:15 + pokaz | planer trasy: A*, wysiłek i tlen, nachylenie, zakazy | uruchamia MarSim przed wystąpieniem, w pokazie obsługuje aplikację i opowiada o planowaniu trasy | algorytm trasy, model tlenu, testy |
| Załoga | Osoba 4 | 5–6 | ok. 2:00 | wizjer hełmu w dwóch stanach, łazik i habitat | w pokazie komentuje widok z hełmu i alarm tlenu; gdy pokaz zawiedzie, omawia zrzuty ze slajdów 4–6 | wizjer, łazik, habitat |

Zastępstwa, gdy kogoś zabraknie: Dane ↔ Planer i pokaz, Prowadzenie ↔ Załoga.

Wszystko ustawia się na początku skryptu w `index.html`: imiona w tablicy `SPEAKERS`, przypisanie slajdów w `SPEAKER_OF`, czasy w `TIME`, opisy ról w `ROLES`, a obsadę pokazu w `DEMO`. Numery slajdów i czas każdej roli w panelu (klawisz R) liczą się z tych tablic same, a zdania przekazujące głos w notatkach biorą imię następnego mówcy.

## Źródła

- Tekstura Marsa: mozaika Viking, NASA (NASA 3D Resources), barwy przyciemnione do prezentacji.
- Zrzuty: MarSim 1.4 z backendem, krater Jezero, sol 212.
- Liczby o środowisku: SAM i RAD (Curiosity), REMS (Gale); liczby trasy z raportu backendu MarSim.
- Kroje: Bodoni Moda, Inter, JetBrains Mono (SIL OFL 1.1).
