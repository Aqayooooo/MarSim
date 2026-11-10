"""Łączność z Ziemią w trybie „zapisz i przekaż dalej” (DTN, Delay/Disruption Tolerant Networking).

Habitat działa samodzielnie w sieci lokalnej. Wiadomości do Ziemi trafiają do kolejki i są dostarczane po czasie
przelotu światła (3–22 min), o ile łącze działa: nie trwa koniunkcja Słońca ani zgłoszona przerwa. Paczki, których
nie udało się dostarczyć przed przerwą, są nadawane ponownie po jej końcu. Odpowiedź Ziemi wraca po kolejnym
opóźnieniu i dwóch minutach na decyzję. Czas: zegar misji (sekundy), opóźnienie: z położeń planet w dniu misji.
"""

from __future__ import annotations

import heapq
import itertools
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta

from backend.models.orbits import earth_mars

TO_EARTH = "do Ziemi"
FROM_EARTH = "z Ziemi"
REPLY_DECISION_S = 120.0  # tyle kontrola misji potrzebuje na potwierdzenie


@dataclass
class Bundle:
    id: int
    direction: str  # TO_EARTH | FROM_EARTH
    kind: str  # alert, raport, telemetria, potwierdzenie, decyzja
    text: str
    created_s: float
    deliver_s: float
    delivered: bool = False
    meta: dict = field(default_factory=dict)


class DtnLink:
    HISTORY = 200  # tyle ostatnich paczek trzymamy do podglądu; niedostarczone są zawsze w self.pending
    RECENT = 12  # tyle paczek pokazuje status()

    def __init__(self, mission_date: datetime):
        self.date = mission_date
        self.queue: list[Bundle] = []  # historia w kolejności nadania
        self.pending: list[Bundle] = []  # jeszcze niedostarczone
        self.outage_from_s = -1.0
        self.outage_until_s = -1.0
        self.replies: dict[int, Bundle] = {}  # identyfikator paczki do Ziemi → oczekiwana odpowiedź
        self.last_step = 0.0
        self.blocked_since: float | None = None
        self._ids = itertools.count(1)

    def geometry(self, t_s: float) -> dict:
        return earth_mars(self.date + timedelta(seconds=t_s))

    def _delay_s(self, t_s: float) -> float:
        return self.geometry(t_s)["oneWayMin"] * 60

    def _blocked(self, t_s: float) -> bool:
        return t_s < self.outage_until_s or self.geometry(t_s)["conjunction"]

    def status(self, t_s: float) -> dict:
        g = self.geometry(t_s)
        return {
            "up": not self._blocked(t_s),
            "oneWayMin": round(g["oneWayMin"], 1),
            "distanceMkm": round(g["distanceKm"] / 1e6, 1),
            "conjunction": g["conjunction"],
            "pendingOut": sum(b.direction == TO_EARTH for b in self.pending),
            "pendingIn": sum(b.direction == FROM_EARTH for b in self.pending),
            "recent": [asdict(b) for b in heapq.nlargest(self.RECENT, self.queue, key=lambda b: b.created_s)],
        }

    def start_outage(self, t_s: float, duration_s: float) -> None:
        """Zgłoszona przerwa łącza (np. przelot przekaźnika poza zasięgiem) o znanym czasie trwania."""
        self.outage_from_s = t_s
        self.outage_until_s = t_s + duration_s

    def _add(self, b: Bundle) -> None:
        self.queue.append(b)
        self.pending.append(b)
        if len(self.queue) > self.HISTORY:
            del self.queue[: len(self.queue) - self.HISTORY]

    def send(self, t_s: float, kind: str, text: str, meta: dict | None = None, reply: str | None = None) -> Bundle:
        """Nadaje paczkę do Ziemi. reply: treść automatycznego potwierdzenia z kontroli misji."""
        delay = self._delay_s(t_s)
        b = Bundle(next(self._ids), TO_EARTH, kind, text, t_s, max(t_s, self.outage_until_s) + delay, meta=meta or {})
        self._add(b)
        if reply:
            answer = Bundle(
                next(self._ids), FROM_EARTH, "potwierdzenie", reply, t_s, b.deliver_s + delay + REPLY_DECISION_S, meta={"re": b.id}
            )
            self.replies[b.id] = answer
            self._add(answer)
        return b

    def _resume(self, restored_s: float) -> None:
        """Łącze wróciło: paczki, które miały dojść w czasie przerwy, wyruszają ponownie w chwili jej końca."""
        delay = self._delay_s(restored_s)
        for b in self.pending:
            if b.created_s >= restored_s or b.deliver_s < self.blocked_since:
                continue
            if b.direction == TO_EARTH:
                b.deliver_s = max(b.deliver_s, restored_s + delay)
                answer = self.replies.get(b.id)
                if answer is not None:
                    answer.deliver_s = max(answer.deliver_s, b.deliver_s + delay + REPLY_DECISION_S)
            elif b.meta.get("re") not in self.replies:  # odpowiedź była już w drodze
                b.deliver_s = max(b.deliver_s, restored_s + delay)

    def step(self, t_s: float) -> list[Bundle]:
        """Dostarcza paczki, których czas minął (gdy łącze działa). Zwraca nowo dostarczone."""
        if self.blocked_since is None and self.last_step < self.outage_until_s <= t_s:
            self.blocked_since = max(self.outage_from_s, self.last_step)  # cała przerwa minęła między krokami
        if self._blocked(t_s):
            if self.blocked_since is None:
                self.blocked_since = t_s
            self.last_step = t_s
            return []
        if self.blocked_since is not None:
            ended_by_schedule = self.blocked_since < self.outage_until_s <= t_s
            self._resume(self.outage_until_s if ended_by_schedule else t_s)
            self.blocked_since = None
        self.last_step = t_s
        done = [b for b in self.pending if t_s >= b.deliver_s]
        for b in done:
            b.delivered = True
            self.replies.pop(b.id, None)
        if done:
            self.pending = [b for b in self.pending if not b.delivered]
        return done
