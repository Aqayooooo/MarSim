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

| Mówca | Slajdy | Zakres | Czas |
|---|---|---|---|
| Osoba 1 | 1–2 | otwarcie i środowisko Marsa w liczbach | ok. 1:45 |
| Osoba 2 | 3–4 | dane NASA i planer trasy | ok. 2:15 |
| Osoba 3 | 5–6 | wizjer hełmu, łazik i habitat | ok. 2:00 |
| Osoba 4 | 7 + pokaz | stan prac, ograniczenia, zakończenie, pokaz na żywo i pytania | ok. 1:00 + pokaz |

Imiona wpisuje się w jednym miejscu: tablica `SPEAKERS` na początku skryptu w `index.html`.

## Źródła

- Tekstura Marsa: mozaika Viking, NASA (NASA 3D Resources), barwy przyciemnione do prezentacji.
- Zrzuty: MarSim 1.4 z backendem, krater Jezero, sol 212.
- Liczby o środowisku: SAM i RAD (Curiosity), REMS (Gale); liczby trasy z raportu backendu MarSim.
- Kroje: Bodoni Moda, Inter, JetBrains Mono (SIL OFL 1.1).
