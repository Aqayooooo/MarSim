"""Wspólne narzędzia testów backendu: silniki misji, klient API, pomocnicze funkcje geometrii.

Każdy test dostaje własną bazę (pamięć albo katalog tymczasowy) — testy nie dotykają baz w katalogu danych.
"""

import math
import pathlib
import sys

import numpy as np
import pytest

REPO = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from backend import missions as mis
from backend.live.engine import EvaEngine
from backend.live.store import Store
from backend.paths import MISSIONS

MISSION_IDS = ["mount-sharp", "jezero"]


def make_engine(mission_id: str, store: Store | None = None) -> EvaEngine:
    return EvaEngine(MISSIONS / mission_id, mis.config(mission_id), store=store or Store(":memory:"), live_feeds=False)


@pytest.fixture(params=MISSION_IDS)
def engine(request):
    return make_engine(request.param)


@pytest.fixture
def gale():
    return make_engine("mount-sharp")


@pytest.fixture
def client(tmp_path):
    from fastapi.testclient import TestClient

    from backend.server import create_app

    app = create_app(start_loop=False, live_feeds=False, db_dir=tmp_path)
    with TestClient(app) as c:
        yield c


def densify(path, step=0.25):
    """Punkty co `step` metrów wzdłuż łamanej."""
    out = []
    for a, b in zip(path[:-1], path[1:]):
        d = math.hypot(b["x"] - a["x"], b["y"] - a["y"])
        n = max(1, int(math.ceil(d / step)))
        for k in range(n):
            t = k / n
            out.append((a["x"] + (b["x"] - a["x"]) * t, a["y"] + (b["y"] - a["y"]) * t))
    out.append((path[-1]["x"], path[-1]["y"]))
    return np.array(out)


def cells(eng, xy):
    h, w = eng.dem.shape
    rows = np.clip((xy[:, 1] // eng.cell).astype(int), 0, h - 1)
    cols = np.clip((xy[:, 0] // eng.cell).astype(int), 0, w - 1)
    return rows, cols


def run(eng, mission_seconds: float, dt_real: float = 0.1):
    """Kroki symulacji aż minie zadany czas misji."""
    end = eng.t + mission_seconds
    while eng.t < end - 1e-9:
        before = eng.t
        eng.step(dt_real)
        if eng.t == before:  # zatrzymana
            break
