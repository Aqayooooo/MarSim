# MarSim — stan i dalsze prace

Stan na 10 listopada 2026. Wyniki ostatnich kontroli są w [README](../README.md).

## Zrobione

- Porównanie wariantów trasy z powodami wyboru oraz sekcja założeń i progów w raporcie.
- Profil wysokości trasy ze strefami „uwaga”, punktami trasy i pozycją załogi.
- Zapis trwającej EVA i wznowienie po restarcie w stanie pauzy.
- Dziennik z łańcuchem SHA-256, kontrola integralności i eksport CSV.
- Pełny cykl sterowania EVA, powrót do habitatu i nowe wyjście.
- Sygnalizacja utraty połączenia oraz synchronizacja nowych sesji między kartami.
- Skróty klawiszowe, pomoc, tłumaczenia PL/EN i uporządkowane moduły interfejsu.
- Opcje uruchamiania serwera, opis API oraz testy backendu, sterowania i planera w CI.
- [Opis planera](PLANER.md): wejścia, wyniki, ograniczenia i sposób sprawdzania tras.
- Edycja punktów EVA na mapie (dodawanie, przesuwanie, postój, kolejność) z zapisem planu w przeglądarce.
- Analiza wrażliwości na limit nachylenia (20–30°) i przedział niepewności tlenu i czasu w raporcie.
- Układ dla telefonów i tabletów (kolumnowy, z przyciskami marszu w hełmie na ekranie dotykowym).
- Testy interfejsu w prawdziwej przeglądarce (Playwright) i sprawdzanie obrazu Docker w CI.
- Nowy wygląd widoków 3D: paleta i faktura terenu, niebo, cienie, modele łazika i habitatu.

## Do wykonania

- Kalibracja modelu tlenu na danych ze skafandra lub misji analogowej.
- Porównanie wykrytych głazów z ręcznie oznaczonymi obrazami oraz trasami łazików.
- Kalibracja założonych niepewności (model wysiłku ±20%, prędkość ±15%) i wrażliwość na inne parametry (rezerwa tlenu, próg piasku).
- Pełny audyt dostępności (WCAG), także w układzie na telefon.
- Uwierzytelnianie, role, ochrona telemetrii i niezależna kopia dziennika przed udostępnieniem serwera w sieci.
- Okna czasowe punktów EVA i współdzielenie zasobów przez wiele zespołów.

Te prace wymagają osobnych kryteriów odbioru. Działające demo nie potwierdza gotowości do wykorzystania operacyjnego w prawdziwej misji.
