"""Trwały zapis stanu w SQLite: dziennik zdarzeń (audyt), zgłoszenia z terenu, harmonogram wyjść, punkt kontrolny EVA.

Dziennik jest tylko dopisywany (bez edycji i usuwania). Każdy wpis ma czas UTC, czas misji, identyfikator sesji EVA
i skrót SHA-256 liczony z treści wpisu oraz skrótu poprzedniego wpisu. Zmiana albo usunięcie dowolnego wpisu przerywa
łańcuch, co wykrywa `verify_log()`.

Plik bazy leży w katalogu danych (MARSIM_DATA / paths.local.json / ./data), poza repozytorium.
"""

from __future__ import annotations

import hashlib
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
    meta TEXT,
    hash TEXT
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


GENESIS_HASH = "0" * 64
EVENT_COLUMNS = "id, utc, session, mission_t, clock, kind, text, meta"
CHECKPOINT_KEY = "checkpoint"


def _utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def event_hash(previous: str, utc: str, session: int, mission_t: float, clock: str | None, kind: str, text: str, meta: str | None) -> str:
    """Skrót wpisu dziennika: SHA-256 z poprzedniego skrótu i pól wpisu w ustalonej kolejności."""
    record = json.dumps([previous, utc, session, mission_t, clock, kind, text, meta], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(record.encode("utf-8")).hexdigest()


class Store:
    def __init__(self, path: Path | str):
        self.path = Path(path) if str(path) != ":memory:" else path
        if isinstance(self.path, Path):
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self.db = sqlite3.connect(str(self.path), check_same_thread=False)
        self.db.executescript(SCHEMA)
        if "hash" not in {row[1] for row in self.db.execute("PRAGMA table_info(events)")}:
            self.db.execute("ALTER TABLE events ADD COLUMN hash TEXT")  # baza sprzed wersji 1.4: starsze wpisy zostają bez skrótu
        self.db.commit()
        self.session = 0
        last = self.db.execute("SELECT hash FROM events WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1").fetchone()
        self._last_hash = last[0] if last else GENESIS_HASH

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
        meta_json = json.dumps(meta, ensure_ascii=False, default=str) if meta else None
        with self._lock:
            utc = _utc()
            digest = event_hash(self._last_hash, utc, self.session, float(mission_t), clock, kind, text, meta_json)
            self.db.execute(
                "INSERT INTO events(utc, session, mission_t, clock, kind, text, meta, hash) VALUES(?,?,?,?,?,?,?,?)",
                (utc, self.session, float(mission_t), clock, kind, text, meta_json, digest),
            )
            self.db.commit()
            self._last_hash = digest

    def events(self, limit: int = 100, session: int | None = None) -> list[dict]:
        q = "SELECT id, utc, session, mission_t, clock, kind, text, meta FROM events"
        args: tuple = ()
        if session is not None:
            q += " WHERE session = ?"
            args = (session,)
        q += " ORDER BY id DESC LIMIT ?"
        with self._lock:
            rows = self.db.execute(q, args + (int(limit),)).fetchall()
        return [
            {
                "id": r[0],
                "utc": r[1],
                "session": r[2],
                "missionT": r[3],
                "clock": r[4],
                "kind": r[5],
                "text": r[6],
                **({"meta": json.loads(r[7])} if r[7] else {}),
            }
            for r in rows
        ]

    def events_oldest_first(self, session: int | None = None) -> list[tuple]:
        """Cały dziennik w kolejności zapisu (eksport): wiersze (id, utc, sesja, czas misji, zegar, rodzaj, tekst, meta, skrót)."""
        q = f"SELECT {EVENT_COLUMNS}, hash FROM events"
        args: tuple = ()
        if session is not None:
            q += " WHERE session = ?"
            args = (session,)
        with self._lock:
            return self.db.execute(q + " ORDER BY id", args).fetchall()

    def verify_log(self) -> dict:
        """Sprawdza łańcuch skrótów dziennika. `brokenAt`: id pierwszego wpisu, który nie zgadza się z łańcuchem."""
        with self._lock:
            rows = self.db.execute(f"SELECT {EVENT_COLUMNS}, hash FROM events ORDER BY id").fetchall()
        previous, checked, legacy = GENESIS_HASH, 0, 0
        for event_id, utc, session, mission_t, clock, kind, text, meta, digest in rows:
            if digest is None:
                if checked:  # wpis bez skrótu w środku łańcucha: ktoś go podmienił
                    return {"ok": False, "checked": checked, "legacy": legacy, "brokenAt": event_id}
                legacy += 1
                continue
            if digest != event_hash(previous, utc, session, mission_t, clock, kind, text, meta):
                return {"ok": False, "checked": checked, "legacy": legacy, "brokenAt": event_id}
            previous = digest
            checked += 1
        return {"ok": True, "checked": checked, "legacy": legacy, "brokenAt": None, "head": previous if checked else None}

    # ---------- punkt kontrolny EVA ----------
    def checkpoint_save(self, state: dict) -> None:
        with self._lock:
            self.db.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)",
                (CHECKPOINT_KEY, json.dumps(state, ensure_ascii=False, default=float)),
            )
            self.db.commit()

    def checkpoint_load(self) -> dict | None:
        with self._lock:
            row = self.db.execute("SELECT value FROM meta WHERE key = ?", (CHECKPOINT_KEY,)).fetchone()
        try:
            return json.loads(row[0]) if row else None
        except ValueError:
            return None

    def checkpoint_clear(self) -> None:
        with self._lock:
            self.db.execute("DELETE FROM meta WHERE key = ?", (CHECKPOINT_KEY,))
            self.db.commit()

    def resume_session(self, session: int) -> None:
        """Kontynuuje sesję EVA sprzed restartu (bez nadawania nowego numeru)."""
        self.session = int(session)

    # ---------- zgłoszenia ----------
    def add_observation(self, obs: dict) -> None:
        with self._lock:
            self.db.execute(
                "INSERT INTO observations(utc, session, data) VALUES(?,?,?)",
                (_utc(), self.session, json.dumps(obs, ensure_ascii=False, default=str)),
            )
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
            self.db.executemany(
                "INSERT INTO schedule(id, data) VALUES(?, ?)", [(i["id"], json.dumps(i, ensure_ascii=False)) for i in items]
            )
            self.db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('scheduleInit', '1')")
            self.db.commit()

    def close(self) -> None:
        self.db.close()
