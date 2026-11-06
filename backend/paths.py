"""Gdzie leżą duże pliki (surowe dane NASA i pamięć podręczna potoku).

Kolejność: zmienna środowiskowa MARSIM_DATA → backend/config/paths.local.json {"dataDir": "..."} → <repo>/data.
paths.local.json nie trafia do gita — każdy komputer ma własny (np. D:/MarSim-data).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def data_dir() -> Path:
    env = os.environ.get("MARSIM_DATA")
    if env:
        return Path(env)
    local = Path(__file__).parent / "config" / "paths.local.json"
    if local.exists():
        return Path(json.loads(local.read_text(encoding="utf-8"))["dataDir"])
    return REPO / "data"


RAW = data_dir() / "raw"
CACHE = data_dir() / "cache"
MISSIONS = REPO / "data" / "missions"      # wynik potoku dla UI (mały, w repozytorium)
