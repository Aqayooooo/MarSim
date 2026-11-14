#!/usr/bin/env bash
# ============================================================
#  MarSim — szybkie uruchomienie (Linux / macOS), odpowiednik URUCHOM.bat
#    ./uruchom.sh            pełna wersja z backendem i danymi NASA (http://localhost:8000)
#    ./uruchom.sh demo       sam interfejs na danych przykładowych (http://localhost:5173)
#    ./uruchom.sh en         pełna wersja po angielsku
#    ./uruchom.sh install    dodaje MarSim do menu aplikacji (skrót .desktop)
#  Zmienne: PORT=8001 ./uruchom.sh   MARSIM_NO_BROWSER=1 ./uruchom.sh
#  Jeśli port jest już zajęty przez MarSim, skrypt tylko otwiera przeglądarkę.
# ============================================================
set -euo pipefail
SELF="$0"
if command -v readlink >/dev/null && readlink -f "$0" >/dev/null 2>&1; then SELF="$(readlink -f "$0")"; fi
cd "$(dirname "$SELF")"
ROOT="$PWD"

say() { printf '\033[1;31m[MarSim]\033[0m %s\n' "$*"; }
fail() { say "$*"; [[ -t 0 ]] || sleep 8; exit 1; }

LANGQ=""
MODE="full"
for a in "$@"; do
  case "$a" in
    en|EN) LANGQ="?lang=en" ;;
    demo|DEMO) MODE="demo" ;;
    install) MODE="install" ;;
    -h|--help) sed -n '3,10p' "$0"; exit 0 ;;
  esac
done

if [[ "$MODE" == "install" ]]; then
  APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$APPS"
  ICON="$ROOT/docs/img/marsim-icon.svg"
  [[ -f "$ICON" ]] || ICON="applications-science"
  cat > "$APPS/marsim.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=MarSim
Comment=Mapa i planer wyjść (EVA) na Marsie
Exec="$ROOT/uruchom.sh"
Path=$ROOT
Icon=$ICON
Terminal=true
Categories=Science;Education;
Actions=demo;english;

[Desktop Action demo]
Name=MarSim — tryb demo (bez backendu)
Exec="$ROOT/uruchom.sh" demo

[Desktop Action english]
Name=MarSim — English
Exec="$ROOT/uruchom.sh" en
EOF
  chmod +x "$APPS/marsim.desktop"
  command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" >/dev/null 2>&1 || true
  say "Dodano skrót: $APPS/marsim.desktop (MarSim w menu aplikacji)."
  exit 0
fi

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then PY="$c"; break; fi
done
[[ -n "$PY" ]] || fail "Nie znaleziono Pythona 3.10+. Zainstaluj go (np. sudo apt install python3 python3-venv)."

helper() { "$PY" "$ROOT/tools/launcher.py" "$@"; }

open_browser() {   # otwiera przeglądarkę, gdy serwer zacznie odpowiadać (maks. ok. 30 s)
  [[ -n "${MARSIM_NO_BROWSER:-}" ]] && return 0
  helper open "$1" "$2" >/dev/null 2>&1 &
}

if [[ "$MODE" == "demo" ]]; then
  PORT="${PORT:-5173}"
  if helper busy "$PORT"; then
    if helper up "http://localhost:$PORT/index.html"; then
      say "Coś już serwuje interfejs na porcie $PORT — otwieram przeglądarkę."
      open_browser "http://localhost:$PORT/$LANGQ" "http://localhost:$PORT/index.html"; wait; exit 0
    fi
    fail "Port $PORT jest zajęty przez inny program. Spróbuj: PORT=5174 ./uruchom.sh demo"
  fi
  say "Tryb demo (bez backendu): http://localhost:$PORT/$LANGQ"
  open_browser "http://localhost:$PORT/$LANGQ" "http://localhost:$PORT/index.html"
  exec "$PY" tools/serve.py "$PORT"
fi

PORT="${PORT:-8000}"
if helper busy "$PORT"; then
  if helper up "http://localhost:$PORT/api/health"; then
    say "MarSim już działa na porcie $PORT — otwieram przeglądarkę."
    open_browser "http://localhost:$PORT/$LANGQ" "http://localhost:$PORT/api/health"; wait; exit 0
  fi
  fail "Port $PORT jest zajęty przez inny program. Spróbuj: PORT=8001 ./uruchom.sh"
fi

VPY="$ROOT/.venv/bin/python"
if ! "$VPY" -c 'import fastapi, uvicorn, numpy, scipy, skimage, PIL' 2>/dev/null; then
  say "Pierwsze uruchomienie: przygotowuję środowisko .venv i instaluję pakiety (wymaga internetu, raz)…"
  if ! "$VPY" -c 'pass' 2>/dev/null; then   # brak .venv albo uszkodzone (np. usunięty Python bazowy)
    "$PY" -m venv --clear .venv || fail "Nie udało się utworzyć .venv. Na Ubuntu/Debianie: sudo apt install python3-venv"
  fi
  "$VPY" -m pip --version >/dev/null 2>&1 || "$VPY" -m ensurepip --upgrade >/dev/null 2>&1 \
    || fail "W .venv brakuje pip. Na Ubuntu/Debianie: sudo apt install python3-venv, potem usuń katalog .venv"
  "$VPY" -m pip install --disable-pip-version-check -r requirements-runtime.txt \
    || fail "Instalacja pakietów nie powiodła się. Tryb awaryjny bez backendu: ./uruchom.sh demo"
fi

say "Start backendu: http://localhost:$PORT/$LANGQ"
say "Ctrl+C albo zamknięcie okna zatrzymuje serwer."
open_browser "http://localhost:$PORT/$LANGQ" "http://localhost:$PORT/api/health"
exec "$VPY" backend/server.py "$PORT"
