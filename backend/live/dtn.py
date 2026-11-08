"""Łączność z Ziemią w trybie „zapisz i przekaż dalej” (DTN, Delay/Disruption Tolerant Networking).

Habitat działa samodzielnie w sieci lokalnej. Wiadomości do Ziemi trafiają do kolejki i są „dostarczane” po czasie
przelotu światła (3–22 min) — gdy łącze jest dostępne (nie w koniunkcji Słońca, nie w przerwie łączności).
Odpowiedzi Ziemi wracają po kolejnym opóźnieniu. Czas: zegar misji (sekundy), opóźnienie: z położeń planet w dniu misji.
"""
from __future__ import annotations

import heapq
import itertools
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta

from backend.models.orbits import earth_mars

_ids = itertools.count(1)


@dataclass
class Bundle:
    id: int
    direction: str          # "do Ziemi" | "z Ziemi"
    kind: str               # alert, raport, telemetria, potwierdzenie, decyzja
    text: str
    created_s: float
    deliver_s: float
    delivered: bool = False
    meta: dict = field(default_factory=dict)


class DtnLink:
    HISTORY = 200       # tyle ostatnich paczek trzymamy do podglądu; niedostarczone są zawsze w self.pending

    def __init__(self, mission_date: datetime):
        self.date = mission_date
        self.queue: list[Bundle] = []      # historia w kolejności nadania
        self.pending: list[Bundle] = []    # jeszcze niedostarczone
        self.outage_until_s = -1.0
        self.replies = {}
        self.last_step = 0.0
        self.blocked_since = None

    def geometry(self, t_s: float) -> dict:
        return earth_mars(self.date + timedelta(seconds=t_s))

    def status(self, t_s: float) -> dict:
        g = self.geometry(t_s)
        up = not g["conjunction"] and t_s >= self.outage_until_s
        return {"up": up, "oneWayMin": round(g["oneWayMin"], 1), "distanceMkm": round(g["distanceKm"] / 1e6, 1),
                "conjunction": g["conjunction"], "pendingOut": sum(b.direction == "do Ziemi" for b in self.pending),
                "pendingIn": sum(b.direction == "z Ziemi" for b in self.pending),
                "recent": [asdict(b) for b in heapq.nlargest(12, self.queue, key=lambda b: b.created_s)]}

    def _add(self, b: Bundle):
        self.queue.append(b)
        self.pending.append(b)
        if len(self.queue) > self.HISTORY:
            del self.queue[:len(self.queue) - self.HISTORY]

    def send(self, t_s: float, kind: str, text: str, meta: dict | None = None, reply: str | None = None) -> Bundle:
        delay = self.geometry(t_s)["oneWayMin"] * 60
        b = Bundle(next(_ids), "do Ziemi", kind, text, t_s, max(t_s, self.outage_until_s) + delay, meta=meta or {})
        self._add(b)
        if reply:  # automatyczne potwierdzenie z kontroli misji po pełnej drodze tam i z powrotem (+2 min na decyzję)
            answer = Bundle(next(_ids), "z Ziemi", "potwierdzenie", reply, t_s, b.deliver_s + delay + 120, meta={"re": b.id})
            self.replies[b.id] = answer
            self._add(answer)
        return b

    def step(self, t_s: float) -> list[Bundle]:
        """Dostarcza paczki, których czas minął (gdy łącze działa). Zwraca nowo dostarczone."""
        if not self.pending or t_s < self.outage_until_s or self.geometry(t_s)["conjunction"]:
            if self.blocked_since is None:
                self.blocked_since = self.last_step
            self.last_step = t_s
            return []
        if self.blocked_since is not None:
            duration = t_s - self.blocked_since
            for b in self.pending:
                b.deliver_s += duration
            self.blocked_since = None
        self.last_step = t_s
        for b in self.pending:
            if b.direction == "do Ziemi" and self.outage_until_s > b.created_s and b.deliver_s < self.outage_until_s:
                b.deliver_s = self.outage_until_s + self.geometry(t_s)["oneWayMin"] * 60
                if b.id in self.replies:
                    self.replies[b.id].deliver_s = b.deliver_s + self.geometry(t_s)["oneWayMin"] * 60 + 120
        done = [b for b in self.pending if t_s >= b.deliver_s]
        if done:
            for b in done:
                b.delivered = True
                if b.direction == "z Ziemi":
                    self.replies.pop(b.meta.get("re"), None)
            self.pending = [b for b in self.pending if not b.delivered]
        return done
