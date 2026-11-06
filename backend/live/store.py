"""Trwały zapis stanu w SQLite: dziennik zdarzeń (audyt), zgłoszenia z terenu, harmonogram wyjść.

Dziennik jest tylko dopisywany (bez edycji i usuwania), każdy wpis ma czas UTC, czas misji i identyfikator sesji EVA.
Plik bazy leży w katalogu danych (MARSIM_DATA / paths.local.json / ./data), poza repozytorium.
Stan symulacji (pozycja załogi, bieżąca trasa) nie jest odtwarzany po restarcie — po restarcie EVA zaczyna się od nowa,
a historia zostaje w dzienniku.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    utc TEXT NOT NULL,
    session INTEGER NOT NULL,
    mission_t REAL NOT NULL,
    clock TEXT,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    meta TEXT
);
CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    utc TEXT NOT NULL,
    session INTEGER NOT NULL,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def _utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Store:
    def __init__(self, path: Path | str):
        self.path = Path(path) if str(path) != ":memory:" else path
        if isinstance(self.path, Path):
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self.db = sqlite3.connect(str(self.path), check_same_thread=False)
        self.db.executescript(SCHEMA)
        self.db.commit()
        self.session = 0

    # ---------- sesje EVA ----------
    def new_session(self) -> int:
        with self._lock:
            row = self.db.execute("SELECT value FROM meta WHERE key='session'").fetchone()
            self.session = (int(row[0]) if row else 0) + 1
            self.db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('session', ?)", (str(self.session),))
            self.db.commit()
        return self.session

    # ---------- dziennik ----------
    def log(self, kind: str, text: str, mission_t: float = 0.0, clock: str | None = None, meta: dict | None = None) -> None:
        with self._lock:
            self.db.execute("INSERT INTO events(utc, session, mission_t, clock, kind, text, meta) VALUES(?,?,?,?,?,?,?)",
                            (_utc(), self.session, float(mission_t), clock, kind, text,
                             json.dumps(meta, ensure_ascii=False, default=str) if meta else None))
            self.db.commit()

    def events(self, limit: int = 100, session: int | None = None) -> list[dict]:
        q = "SELECT id, utc, session, mission_t, clock, kind, text, meta FROM events"
        args: tuple = ()
        if session is not None:
            q += " WHERE session = ?"
            args = (session,)
        q += " ORDER BY id DESC LIMIT ?"
        with self._lock:
            rows = self.db.execute(q, args + (int(limit),)).fetchall()
        return [{"id": r[0], "utc": r[1], "session": r[2], "missionT": r[3], "clock": r[4], "kind": r[5], "text": r[6],
                 **({"meta": json.loads(r[7])} if r[7] else {})} for r in rows]

    # ---------- zgłoszenia ----------
    def add_observation(self, obs: dict) -> None:
        with self._lock:
            self.db.execute("INSERT INTO observations(utc, session, data) VALUES(?,?,?)",
                            (_utc(), self.session, json.dumps(obs, ensure_ascii=False, default=str)))
            self.db.commit()

    def observations(self, limit: int = 200) -> list[dict]:
        with self._lock:
            rows = self.db.execute("SELECT id, utc, session, data FROM observations ORDER BY id DESC LIMIT ?", (int(limit),)).fetchall()
        return [{"id": r[0], "utc": r[1], "session": r[2], **json.loads(r[3])} for r in rows]

    # ---------- harmonogram ----------
    def schedule_load(self) -> list[dict] | None:
        with self._lock:
            n = self.db.execute("SELECT value FROM meta WHERE key='scheduleInit'").fetchone()
            rows = self.db.execute("SELECT data FROM schedule").fetchall()
        return [json.loads(r[0]) for r in rows] if n else None

    def schedule_save(self, items: list[dict]) -> None:
        with self._lock:
            self.db.execute("DELETE FROM schedule")
            self.db.executemany("INSERT INTO schedule(id, data) VALUES(?, ?)",
                                [(i["id"], json.dumps(i, ensure_ascii=False)) for i in items])
            self.db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('scheduleInit', '1')")
            self.db.commit()

    def close(self) -> None:
        self.db.close()
