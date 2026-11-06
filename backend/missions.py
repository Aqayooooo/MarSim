"""Misje (obszary EVA): konfiguracja w backend/config/missions/<id>.json, produkty NASA w backend/sources/<id>.json.

Wybór misji w skryptach: --mission <id>, zmienna MARSIM_MISSION albo domyślna (pierwsza na liście DEFAULT_ORDER).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent
CONFIG_DIR = BACKEND / "config" / "missions"
SOURCES_DIR = BACKEND / "sources"
DEFAULT = "mount-sharp"


def ids() -> list[str]:
    found = sorted(p.stem for p in CONFIG_DIR.glob("*.json"))
    return sorted(found, key=lambda i: (i != DEFAULT, i))


def config(mission_id: str) -> dict:
    p = CONFIG_DIR / f"{mission_id}.json"
    if not p.exists():
        raise SystemExit(f"Nieznana misja „{mission_id}”. Dostępne: {', '.join(ids())}")
    return json.loads(p.read_text(encoding="utf-8"))


def sources(mission_id: str) -> dict:
    return json.loads((SOURCES_DIR / f"{mission_id}.json").read_text(encoding="utf-8"))


def from_argv(argv: list[str] | None = None) -> str:
    argv = sys.argv if argv is None else argv
    if "--mission" in argv:
        return argv[argv.index("--mission") + 1]
    return os.environ.get("MARSIM_MISSION", DEFAULT)
