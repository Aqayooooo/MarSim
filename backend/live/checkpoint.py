"""Punkt kontrolny EVA: zapis stanu silnika do bazy i odtworzenie go po restarcie serwera.

Zapisywany jest stan wyjścia (czas misji, trasa, pozycja załogi, zasoby skafandrów, zgłoszenia, alarmy). Nie są
zapisywane wiadomości DTN będące w drodze ani chwilowe odczyty czujników: po wznowieniu łącze startuje puste,
a czujniki odświeżają się w pierwszym kroku. Wznowione wyjście jest wstrzymane, dopóki operator go nie ruszy.
"""

from __future__ import annotations

import dataclasses
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from backend.live.engine import EvaEngine

FORMAT = 1
_SCALARS = (
    "t", "finished", "returning", "route_blocked", "time_scale", "route_version", "crew_s", "next_wp", "stop_until",
    "sep", "sim_pfu", "scenario",
)  # fmt: skip
_LISTS = ("reached", "alerts", "obstacles", "observations", "discarded", "log")
_PERSON_FIELDS = ("o2_l", "battery_left_wh", "co2_absorbed_l", "dose_msv")
_MEMBER_FIELDS = ("metabolic", "co2mmHg", "moved", "evaDoseUsv")
LEGACY_CREW_IDS = {"EV1": "Bartek", "EV2": "Hubert"}  # identyfikatory załogi sprzed wersji z imionami


def capture(engine: EvaEngine) -> dict:
    """Stan silnika jako słownik gotowy do zapisu w JSON. Wywoływać pod blokadą silnika."""
    return {
        "format": FORMAT,
        "mission": engine.cfg["id"],
        "session": engine.store.session,
        **{name: getattr(engine, name) for name in _SCALARS},
        **{name: list(getattr(engine, name)) for name in _LISTS},
        "route": engine.route,
        "waypoints": engine.waypoints,
        "rover": dict(engine.rover),
        "gap": engine.gap,
        "start_min": engine.start_min,
        "fired": sorted(engine.fired),
        "fired_at": dict(engine.fired_at),
        "warned": [list(key) for key in engine._warned],
        "crew": [
            {
                "id": member["cfg"]["id"],
                **{name: getattr(member["person"], name) for name in _PERSON_FIELDS},
                **{name: member[name] for name in _MEMBER_FIELDS},
            }
            for member in engine.crew
        ],
    }


def usable(state: dict | None, mission_id: str) -> bool:
    """Czy punkt kontrolny dotyczy tej misji i trwającego wyjścia (rozpoczętego i niezakończonego)."""
    return bool(
        state
        and state.get("format") == FORMAT
        and state.get("mission") == mission_id
        and state.get("route")
        and state.get("t", 0) > 0
        and not state.get("finished")
    )


def restore(engine: EvaEngine, state: dict) -> None:
    """Odtwarza stan zapisany przez `capture` na świeżo wyczyszczonym silniku. Wyjście zostaje wstrzymane."""
    known = {c["id"]: c for c in engine.cfg["crew"]}
    saved_ids = [LEGACY_CREW_IDS.get(saved["id"], saved["id"]) for saved in state["crew"]]
    if not saved_ids or any(i not in known for i in saved_ids):
        raise ValueError("skład załogi w punkcie kontrolnym nie zgadza się z konfiguracją misji")
    engine.crew = [engine.new_member(known[i]) for i in saved_ids]  # załoga wyjścia, nawet gdy harmonogram się zmienił
    for name in _LISTS:
        setattr(engine, name, list(state[name]))
    engine.fired = set(state["fired"])
    engine.fired_at = dict(state["fired_at"])
    engine._warned = {tuple(LEGACY_CREW_IDS.get(k, k) for k in key) for key in state["warned"]}
    engine.rover = dict(state["rover"])
    for member, saved in zip(engine.crew, state["crew"]):
        member["person"] = dataclasses.replace(member["person"], **{name: saved[name] for name in _PERSON_FIELDS})
        member.update({name: saved[name] for name in _MEMBER_FIELDS})
    engine.rebuild_hazards()  # zgłoszenia „bezpieczne” i przeszkody wracają na mapę kosztów
    version = state["route_version"]
    engine._set_route(state["route"], state["waypoints"])
    for name in _SCALARS:
        setattr(engine, name, state[name])
    engine.gap = state.get("gap", engine.gap)  # starsze punkty kontrolne nie mają tych pól
    engine.start_min = state.get("start_min", engine.start_min)
    engine.route_version = version
    engine.route["version"] = version
    engine.running = False
