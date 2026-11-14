"""Pomocnik launcherów uruchom.sh i URUCHOM.bat (wspólna logika zamiast skryptów wklejanych w powłokę).

python tools/launcher.py busy <port>              kod 0, gdy port na 127.0.0.1 jest zajęty
python tools/launcher.py up <url>                 kod 0, gdy adres odpowiada (bez proxy)
python tools/launcher.py open <url> <probe> [s]   czeka, aż <probe> odpowie (domyślnie 30 s), i otwiera <url>
"""

import socket
import sys
import time
import urllib.request
import webbrowser

# bez proxy: zmienne http_proxy nie mogą przechwytywać zapytań do localhost
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def busy(port: str) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", int(port))) == 0


def up(url: str, timeout: float = 2) -> bool:
    try:
        OPENER.open(url, timeout=timeout).close()
        return True
    except Exception:
        return False


def open_when_ready(url: str, probe: str, seconds: float = 30) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if up(probe, timeout=1):
            webbrowser.open(url)
            return True
        time.sleep(0.5)
    return False


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "busy":
        return 0 if busy(argv[1]) else 1
    if len(argv) >= 2 and argv[0] == "up":
        return 0 if up(argv[1]) else 1
    if len(argv) >= 3 and argv[0] == "open":
        return 0 if open_when_ready(argv[1], argv[2], float(argv[3]) if len(argv) > 3 else 30) else 1
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
