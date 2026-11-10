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

## Do wykonania

- Kalibracja modelu tlenu na danych ze skafandra lub misji analogowej.
- Porównanie wykrytych głazów z ręcznie oznaczonymi obrazami oraz trasami łazików.
- Analiza wrażliwości na limit nachylenia i prezentacja przedziałów niepewności wyników.
- Układ dostosowany do tabletów i telefonów oraz pełny audyt dostępności.
- Powtarzalne testy interfejsu w przeglądarce i test obrazu Docker.
- Uwierzytelnianie, role, ochrona telemetrii i niezależna kopia dziennika przed udostępnieniem serwera w sieci.
- Edycja punktów EVA na mapie, okna czasowe i współdzielenie zasobów przez wiele zespołów.

Te prace wymagają osobnych kryteriów odbioru. Działające demo nie potwierdza gotowości do wykorzystania operacyjnego w prawdziwej misji.
