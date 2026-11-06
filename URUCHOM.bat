@echo off
setlocal
rem ============================================================
rem  MarSim - szybkie uruchomienie
rem    URUCHOM.bat          pelna wersja z backendem i danymi NASA (http://localhost:8000)
rem    URUCHOM.bat demo     sam interfejs na danych przykladowych (http://localhost:5173)
rem    URUCHOM.bat en       pelna wersja po angielsku
rem  Dziala bez internetu po pierwszej instalacji (biblioteki i czcionki sa w vendor\).
rem ============================================================
cd /d "%~dp0"
title MarSim

set "PY=python"
where python >nul 2>nul || (
  where py >nul 2>nul && (set "PY=py -3") || (
    echo [MarSim] Nie znaleziono Pythona 3.10+. Zainstaluj go z https://www.python.org i zaznacz "Add to PATH".
    pause & exit /b 1
  )
)

set "LANGQ="
if /i "%~1"=="en" set "LANGQ=?lang=en"
if /i "%~2"=="en" set "LANGQ=?lang=en"

if /i "%~1"=="demo" goto demo

if not exist ".venv\Scripts\python.exe" (
  echo [MarSim] Pierwsze uruchomienie: tworze srodowisko .venv i instaluje pakiety ^(wymaga internetu, raz^)...
  %PY% -m venv .venv || goto fail
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt || goto fail
)

set "PORT=8000"
echo [MarSim] Start backendu: http://localhost:%PORT%/%LANGQ%
echo [MarSim] Zamkniecie tego okna albo Ctrl+C zatrzymuje serwer.
call :open http://localhost:%PORT%/%LANGQ% http://localhost:%PORT%/api/health
".venv\Scripts\python.exe" backend\server.py %PORT%
if errorlevel 1 goto fail
exit /b 0

:demo
set "PORT=5173"
echo [MarSim] Tryb demo (bez backendu): http://localhost:%PORT%/%LANGQ%
call :open http://localhost:%PORT%/%LANGQ% http://localhost:%PORT%/index.html
%PY% tools\serve.py %PORT%
exit /b 0

:open
rem otwiera przegladarke, gdy serwer zacznie odpowiadac (maks. ok. 30 s)
if defined MARSIM_NO_BROWSER exit /b 0
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command "for($i=0;$i -lt 60;$i++){try{Invoke-WebRequest '%~2' -UseBasicParsing -TimeoutSec 1 | Out-Null; Start-Process '%~1'; break}catch{Start-Sleep -Milliseconds 500}}"
exit /b 0

:fail
echo.
echo [MarSim] Uruchomienie nie powiodlo sie. Tryb awaryjny bez backendu: URUCHOM.bat demo
pause
exit /b 1
