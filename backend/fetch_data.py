"""Pobiera produkty NASA z backend/sources/<misja>.json do data/raw/ (wznawianie, SHA-256).

    python backend/fetch_data.py                     # pobierz brakujące (misja domyślna)
    python backend/fetch_data.py --mission jezero    # inna misja
    python backend/fetch_data.py --check             # pokaż stan i sumy kontrolne
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.paths import RAW  # noqa: E402  (D:/MarSim-data/raw albo ./data/raw)
from backend import missions  # noqa: E402
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def remote_size(url: str) -> int | None:
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=60) as r:
        n = r.headers.get("Content-Length")
        return int(n) if n else None


def download(url: str, dest: Path) -> None:
    """Pobiera z wznawianiem. curl (wbudowany w Windows 10+, macOS, Linux) jest wielokrotnie szybszy niż urllib."""
    curl = shutil.which("curl")
    if curl:
        tmp = dest.with_suffix(dest.suffix + ".part")
        r = subprocess.run([curl, "-fL", "--retry", "10", "--retry-delay", "3", "-C", "-", "-o", str(tmp), url])
        if r.returncode == 0:
            tmp.replace(dest)
            return
        print(f"  curl zakończył się kodem {r.returncode}; próbuję urllib", flush=True)
    download_urllib(url, dest)


def download_urllib(url: str, dest: Path) -> None:
    total = remote_size(url)
    tmp = dest.with_suffix(dest.suffix + ".part")
    complete = False
    for attempt in range(20):
        have = tmp.stat().st_size if tmp.exists() else 0
        if total and have > total:            # .part dłuższy niż plik (sklejony wcześniej) — pobieramy od nowa
            tmp.unlink()
            have = 0
        if total and have == total:
            complete = True
            break
        req = urllib.request.Request(url, headers={"Range": f"bytes={have}-"} if have else {})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                if have and r.status != 206:      # serwer zignorował Range i wysyła cały plik — zaczynamy od zera, bez sklejania
                    have = 0
                with tmp.open("ab" if have else "wb") as f:
                    last = time.time()
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                        have += len(chunk)
                        if time.time() - last > 5:
                            pct = f"{have / total * 100:5.1f}%" if total else f"{have >> 20} MB"
                            print(f"  {dest.name}: {pct}", flush=True)
                            last = time.time()
            if not total or have >= total:
                complete = not total or have == total
                break
        except Exception as e:  # przerwane połączenie: wznów od miejsca przerwania
            print(f"  przerwano ({e}); ponawiam {attempt + 1}/20", flush=True)
            time.sleep(3)
    if not complete:   # niepełny plik zostaje jako .part (do wznowienia), nigdy jako gotowy produkt z sumą kontrolną
        size = tmp.stat().st_size if tmp.exists() else 0
        raise RuntimeError(f"Nie udało się pobrać {dest.name}: {size} z {total or '?'} B — uruchom ponownie, pobieranie zostanie wznowione")
    tmp.replace(dest)


def main() -> int:
    RAW.mkdir(parents=True, exist_ok=True)
    mission = missions.from_argv()
    SOURCES = missions.sources(mission)
    print(f"Misja: {mission}")
    check = "--check" in sys.argv
    manifest = {}
    for p in SOURCES["products"]:
        if p.get("remote"):
            print(f"[zdalny] {p['id']}: czytany fragmentami z {p['url']}")
            manifest[p["id"]] = {"url": p["url"], "remote": True}
            continue
        dest = RAW / p["file"]
        if not dest.exists():
            if check:
                print(f"[BRAK]  {p['id']}")
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            print(f"[pobieram] {p['id']} → {dest}")
            download(p["url"], dest)
        digest = sha256(dest)
        manifest[p["id"]] = {"url": p["url"], "file": str(dest), "bytes": dest.stat().st_size, "sha256": digest}
        print(f"[OK]    {p['id']}  {dest.stat().st_size:>11} B  sha256 {digest[:16]}…")
    (RAW / f"manifest-{mission}.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
