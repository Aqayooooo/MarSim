# Planer MarSim

## Wejścia

Planer używa siatki terenu, nachylenia z niepewnością, piasku, głazów i stref zakazanych. Zapytanie zawiera start oraz uporządkowane punkty trasy z czasem postoju. Zgłoszenia z terenu zmieniają bieżącą mapę przeszkód. Konfiguracja misji określa parametry załogi i limity EVA.

Pliki `provenance.json` w katalogach misji opisują źródła, przetwarzanie i sumy kontrolne warstw. Lista produktów jest w [data-sources.json](../data-sources.json).

## Wyniki

Backend (`backend/planning.py`) wyznacza trasę na siatce kosztu tlenu. Zwraca jej geometrię, punkty postoju, długość, czas, zapotrzebowanie na tlen i ocenę ryzyka. Czas postoju zwiększa czas misji oraz zapotrzebowanie na tlen. Porównanie wariantów wyjaśnia różnice względem linii prostej, najkrótszej bezpiecznej trasy i wariantu bez stref „uwaga”.

Raport pokazuje użyte założenia i progi. Cele w niedostępnych komórkach oraz brak przejścia dają błąd. Po wygładzeniu planer sprawdza komórki przecięte przez odcinki trasy. Jeśli nowe zagrożenie odcina dalszą drogę, marsz zostaje zablokowany do wyznaczenia dostępnej trasy.

## Wersja bez serwera

Pierwsza standardowa trasa na danych NASA może pochodzić z zapisanej odpowiedzi backendu. Kolejne trasy liczy lokalny planer (`src/data/mockPlanner.js`). Lokalna symulacja używa uproszczonego zużycia tlenu i prędkości marszu; jej wyniki nie zastępują modelu backendu. Raport i harmonogram w tym trybie są zapisanymi przykładami, a nie oceną bieżącego przebiegu.

## Granice modelu

- Model wysiłku nie jest skalibrowany na danych z rzeczywistego skafandra.
- Zdjęcia orbitalne nie pozwalają wykryć wszystkich małych kamieni ani aktualnych zmian terenu.
- Warstwy piasku i zagrożeń zależą od rozdzielczości i jakości źródeł. Wskaźniki piasku są względne dla obszaru.
- Jedna trasa i jej ocena nie opisują wszystkich możliwych zagrożeń. Pogoda kosmiczna może być nieaktualna; interfejs podaje źródło i dostępność.
- Zgodność sum kontrolnych potwierdza spójność plików, nie ich dokładność naukową.

## Weryfikacja

Testy backendu sprawdzają cele w zakazie, odcinki przecinające zakaz, przeszkody, postoje i zapas na powrót. Testy lokalnego planera badają demo i oba obszary NASA. Testy sterowania przechodzą całą lokalną EVA ze zdarzeniami oraz powrotem i sprawdzają błędy API, pauzę oraz spóźnione odpowiedzi. Polecenia uruchomienia są w [README](../README.md).
