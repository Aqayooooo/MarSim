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
cd "$(dirname "$(readlink -f "$0")")"
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

open_browser() {   # otwiera przeglądarkę, gdy serwer zacznie odpowiadać (maks. ok. 30 s)
  local url="$1" probe="$2"
  [[ -n "${MARSIM_NO_BROWSER:-}" ]] && return 0
  (
    for _ in $(seq 60); do
      if "$PY" -c "import urllib.request,sys; urllib.request.urlopen(sys.argv[1], timeout=1)" "$probe" 2>/dev/null; then
        if command -v xdg-open >/dev/null; then xdg-open "$url" >/dev/null 2>&1
        elif command -v open >/dev/null; then open "$url"
        fi
        exit 0
      fi
      sleep 0.5
    done
  ) &
}

port_busy() { "$PY" -c "import socket,sys; s=socket.socket(); s.settimeout(.5); sys.exit(0 if s.connect_ex(('127.0.0.1', int(sys.argv[1])))==0 else 1)" "$1"; }

if [[ "$MODE" == "demo" ]]; then
  PORT="${PORT:-5173}"
  say "Tryb demo (bez backendu): http://localhost:$PORT/$LANGQ"
  open_browser "http://localhost:$PORT/$LANGQ" "http://localhost:$PORT/index.html"
  exec "$PY" tools/serve.py "$PORT"
fi

PORT="${PORT:-8000}"
if port_busy "$PORT"; then
  if "$PY" -c "import urllib.request,sys; urllib.request.urlopen(sys.argv[1], timeout=2)" "http://localhost:$PORT/api/health" 2>/dev/null; then
    say "MarSim już działa na porcie $PORT — otwieram przeglądarkę."
    MARSIM_NO_BROWSER="${MARSIM_NO_BROWSER:-}" open_browser "http://localhost:$PORT/$LANGQ" "http://localhost:$PORT/api/health"
    wait; exit 0
  fi
  fail "Port $PORT jest zajęty przez inny program. Spróbuj: PORT=8001 ./uruchom.sh"
fi

VPY="$ROOT/.venv/bin/python"
if [[ ! -x "$VPY" ]] || ! "$VPY" -c 'import fastapi, uvicorn, numpy, scipy, skimage, PIL' 2>/dev/null; then
  say "Pierwsze uruchomienie: tworzę środowisko .venv i instaluję pakiety (wymaga internetu, raz)…"
  rm -rf "$ROOT/.venv"
  "$PY" -m venv .venv || fail "Nie udało się utworzyć .venv. Na Ubuntu/Debianie: sudo apt install python3-venv"
  "$VPY" -m pip install --disable-pip-version-check -q -r requirements-runtime.txt || fail "Instalacja pakietów nie powiodła się. Tryb awaryjny bez backendu: ./uruchom.sh demo"
fi

say "Start backendu: http://localhost:$PORT/$LANGQ"
say "Ctrl+C albo zamknięcie okna zatrzymuje serwer."
open_browser "http://localhost:$PORT/$LANGQ" "http://localhost:$PORT/api/health"
exec "$VPY" backend/server.py "$PORT"
