@echo off
setlocal
rem ============================================================
rem  MarSim - szybkie uruchomienie (Windows), odpowiednik uruchom.sh
rem    URUCHOM.bat          pelna wersja z backendem i danymi NASA (http://localhost:8000)
rem    URUCHOM.bat demo     sam interfejs na danych przykladowych (http://localhost:5173)
rem    URUCHOM.bat en       pelna wersja po angielsku (mozna laczyc: URUCHOM.bat demo en)
rem  Zmienne: set PORT=8001   set MARSIM_NO_BROWSER=1
rem  Jesli port jest juz zajety przez MarSim, skrypt tylko otwiera przegladarke.
rem  Dziala bez internetu po pierwszej instalacji (biblioteki i czcionki sa w vendor\).
rem ============================================================
cd /d "%~dp0"
title MarSim

set "LANGQ="
set "MODE=full"
:args
if "%~1"=="" goto args_done
if /i "%~1"=="en" set "LANGQ=?lang=en"
if /i "%~1"=="demo" set "MODE=demo"
if /i "%~1"=="-h" goto help
if /i "%~1"=="--help" goto help
if /i "%~1"=="/?" goto help
shift
goto args
:args_done

rem prawdziwy Python 3.10+ (alias "python" ze Sklepu Microsoft nie przejdzie tego testu)
set "PY="
for %%C in ("python" "py -3" "python3") do if not defined PY (
  %%~C -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>nul && set "PY=%%~C"
)
if not defined PY (
  echo [MarSim] Nie znaleziono Pythona 3.10+. Zainstaluj go z https://www.python.org i zaznacz "Add python.exe to PATH".
  pause
  exit /b 1
)

if /i "%MODE%"=="demo" goto demo

if not defined PORT set "PORT=8000"
%PY% tools\launcher.py busy %PORT% || goto venv
%PY% tools\launcher.py up http://localhost:%PORT%/api/health || goto busy
echo [MarSim] MarSim juz dziala na porcie %PORT% - otwieram przegladarke.
call :open "http://localhost:%PORT%/%LANGQ%" "http://localhost:%PORT%/api/health"
exit /b 0

:venv
set "VPY=.venv\Scripts\python.exe"
"%VPY%" -c "import fastapi, uvicorn, numpy, scipy, skimage, PIL" >nul 2>nul && goto run
echo [MarSim] Pierwsze uruchomienie: przygotowuje srodowisko .venv i instaluje pakiety (wymaga internetu, raz)...
"%VPY%" -c "pass" >nul 2>nul && goto pip
rem brak .venv albo uszkodzone (np. odinstalowany Python bazowy)
%PY% -m venv --clear .venv || goto fail
:pip
"%VPY%" -m pip --version >nul 2>nul || "%VPY%" -m ensurepip --upgrade >nul 2>nul || goto fail
"%VPY%" -m pip install --disable-pip-version-check -r requirements-runtime.txt || goto fail

:run
echo [MarSim] Start backendu: http://localhost:%PORT%/%LANGQ%
echo [MarSim] Zamkniecie tego okna albo Ctrl+C zatrzymuje serwer.
call :open "http://localhost:%PORT%/%LANGQ%" "http://localhost:%PORT%/api/health"
"%VPY%" backend\server.py %PORT%
if errorlevel 1 goto fail
exit /b 0

:demo
if not defined PORT set "PORT=5173"
%PY% tools\launcher.py busy %PORT% || goto demo_run
%PY% tools\launcher.py up http://localhost:%PORT%/index.html || goto busy
echo [MarSim] Cos juz serwuje interfejs na porcie %PORT% - otwieram przegladarke.
call :open "http://localhost:%PORT%/%LANGQ%" "http://localhost:%PORT%/index.html"
exit /b 0
:demo_run
echo [MarSim] Tryb demo (bez backendu): http://localhost:%PORT%/%LANGQ%
call :open "http://localhost:%PORT%/%LANGQ%" "http://localhost:%PORT%/index.html"
%PY% tools\serve.py %PORT%
exit /b 0

:open
rem otwiera przegladarke w tle, gdy serwer zacznie odpowiadac (maks. ok. 30 s)
if defined MARSIM_NO_BROWSER exit /b 0
start "" /b %PY% tools\launcher.py open %1 %2
exit /b 0

:busy
echo [MarSim] Port %PORT% jest zajety przez inny program. Wybierz inny, np.:  set PORT=8001 ^& URUCHOM.bat
pause
exit /b 1

:help
echo   URUCHOM.bat          pelna wersja z backendem i danymi NASA (http://localhost:8000)
echo   URUCHOM.bat demo     sam interfejs na danych przykladowych (http://localhost:5173)
echo   URUCHOM.bat en       pelna wersja po angielsku (mozna laczyc: URUCHOM.bat demo en)
echo   Zmienne: set PORT=8001   set MARSIM_NO_BROWSER=1
exit /b 0

:fail
echo.
echo [MarSim] Uruchomienie nie powiodlo sie. Tryb awaryjny bez backendu: URUCHOM.bat demo
pause
exit /b 1
