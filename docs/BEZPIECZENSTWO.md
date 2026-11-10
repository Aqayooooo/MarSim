# MarSim — bezpieczeństwo i droga do wdrożenia

## Co jest zrobione

| Obszar | Stan |
|---|---|
| Walidacja wejścia | Każde zapytanie API sprawdza model pydantic (`backend/server.py`): typy, zakresy, dozwolone wartości, granice mapy. Błąd → 422 z opisem. |
| Obsługa błędów | Nieobsłużony wyjątek → 500 z ogólnym komunikatem (bez szczegółów technicznych) i wpis w dzienniku zdarzeń. Błąd kroku symulacji nie zatrzymuje serwera. |
| Udostępniane pliki | Serwer udostępnia tylko `index.html`, `styles.css`, `src/`, `vendor/`, `data/demo/` i pliki bieżącej misji. Nie udostępnia `.git`, konfiguracji, kodu backendu ani bazy. Ścieżki typu `../` są blokowane. |
| Sieć | Domyślnie serwer słucha tylko na `127.0.0.1`. Na zewnątrz (np. Docker) trzeba jawnie ustawić `MARSIM_HOST=0.0.0.0`. |
| Dziennik zdarzeń | SQLite (`backend/live/store.py`), wpisy połączone skrótami SHA-256. `/api/log/verify` sprawdza łańcuch, `/api/log/export` daje CSV. Starsze wpisy bez skrótu są oznaczone osobno. |
| Sekrety | Klucz NASA API tylko w zmiennej `NASA_API_KEY`, nie w repozytorium. |
| Kontener | Docker uruchamia proces jako zwykły użytkownik (`marsim`), dane w wolumenie `/data`. |
| Zależności | Biblioteki interfejsu w `vendor/` w ustalonych wersjach (three.js 0.160.0), bez CDN w czasie pracy. |

## Czego nie ma (świadomie, na konkurs)

- **Logowania i ról.** Każdy, kto ma dostęp do adresu, może sterować EVA. Dlatego serwer domyślnie słucha tylko lokalnie.
- **HTTPS.** Do pracy w sieci potrzebny jest serwer pośredniczący z TLS (np. Caddy lub nginx).
- **Podpisu wpisów dziennika.** Dziennik da się zmienić bezpośrednio w pliku bazy.

## Droga do wdrożenia

1. **Role**:
   - *dowódca EVA*: start/pauza EVA, zmiany trasy, harmonogram;
   - *załoga*: zgłoszenia z terenu, telemetria własnego skafandra, odczyt;
   - *kontrola misji*: odczyt i wiadomości DTN;
   - *obserwator*: tylko odczyt.

   Realizacja: tokeny (np. OIDC) i sprawdzanie roli w zależnościach FastAPI dla każdej ścieżki.
2. **Telemetria skafandra**: uwierzytelnienie urządzenia (certyfikat klienta, mTLS) i odrzucanie danych spoza zakresów fizycznych (już robi to walidacja).
3. **Dziennik**: przechowywanie niezależnej kopii i podpisywanie skrótu końcowego. Obecny łańcuch wykrywa zmianę powiązanych wpisów, ale osoba z dostępem do bazy może przeliczyć cały łańcuch albo usunąć jego końcówkę.
4. **Oprogramowanie dla lotów załogowych**: NASA NPR 7150.2 (klasyfikacja oprogramowania, prawdopodobnie klasa C/D dla narzędzia planistycznego), NASA-STD-8739.8 (zapewnienie jakości oprogramowania), analiza zagrożeń oprogramowania, niezależna weryfikacja i walidacja.
5. **Dostępność**: pełny audyt WCAG 2.1 AA (czytnik ekranu, kontrast, klawiatura) i układ elastyczny zamiast stałego ekranu 1664×744.
