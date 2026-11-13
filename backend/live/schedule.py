"""Planowanie wielu wyjść: harmonogram, zapasy habitatu, odpoczynek załogi, światło dzienne.

Reguły w RULES to założenia planistyczne do uzgodnienia z lekarzem lotu, nie normy NASA.
"""

from __future__ import annotations

from backend.live.checkpoint import LEGACY_CREW_IDS
from backend.models import sun

MAX_EVA_H = 8.0
MAX_CONSECUTIVE_SOLS = 3
WEEKLY_LIMIT_H = 24.0
WEEK_SOLS = 7
DAYLIGHT_MARGIN_H = 0.5
USABLE_STORES = 0.8  # 20% zapasów habitatu zostaje jako rezerwa
O2_MARGIN = 1.1  # +10% na nieszczelności i płukanie śluzy
SUIT_POWER_W = 95.0  # średni pobór mocy skafandra
WATER_L_PER_H = 0.6  # woda chłodząca i do picia na osobę

RULES = [
    "jedno wyjście na sol na osobę, maks. 8 h;",
    "po 3 kolejnych solach z wyjściem — sol odpoczynku;",
    "maks. 24 h EVA na osobę w 7 solach;",
    "wyjście w dzień: start ≥ 30 min po wschodzie, powrót ≥ 30 min przed zachodem;",
    "tlen i energia na wszystkie wyjścia ≤ zapasy habitatu minus 20% rezerwy.",
]


def default_schedule(first_sol: int, start_ltst: str = "09:30") -> list[dict]:
    """Przykładowy plan na pierwsze sole misji (z solem odpoczynku po trzech wyjściach z rzędu)."""
    plan = [
        (0, start_ltst, 2.5, ["Bartek", "Hubert"], "trawers do WP2, rozpoznanie terenu"),
        (1, "10:00", 3.0, ["Bartek", "Hubert"], "rozmieszczenie nadajników UWB"),
        (2, "09:30", 4.0, ["Bartek"], "serwis łazika"),
        (4, "09:00", 3.5, ["Bartek", "Hubert"], "pobranie próbek skał"),
    ]
    return [
        {"id": f"EVA-{n}", "sol": first_sol + offset, "startLtst": start, "durationH": hours, "crew": crew, "purpose": purpose}
        for n, (offset, start, hours, crew, purpose) in enumerate(plan, start=1)
    ]


def _hours(clock: str) -> float:
    h, m = clock.split(":")
    return int(h) + int(m) / 60


def _sort_key(item: dict) -> tuple:
    return item["sol"], _hours(item["startLtst"])


class Scheduler:
    def __init__(
        self,
        store,
        crew_cfg: list[dict],
        stores: dict,
        lat: float,
        decl: float,
        o2_rate_lh: float = 50.0,
        first_sol: int = 1,
        start_ltst: str = "09:30",
    ):
        """store: backend.live.store.Store — harmonogram jest zapisywany w SQLite.
        o2_rate_lh: średnie zużycie O₂ podczas EVA (L/h na osobę), z modelu wysiłku."""
        self.store = store
        self.crew_ids = [c["id"] for c in crew_cfg]
        self.stores = stores
        self.lat, self.decl = lat, decl
        self.o2_rate_lh = o2_rate_lh
        saved = store.schedule_load()
        if saved is None:
            saved = [i for i in default_schedule(first_sol, start_ltst) if set(i["crew"]) <= set(self.crew_ids)]
        else:  # harmonogram zapisany przed zmianą identyfikatorów załogi (EV1/EV2 → imiona)
            saved = [{**i, "crew": [LEGACY_CREW_IDS.get(c, c) for c in i.get("crew", [])]} for i in saved]
        self.items = sorted(saved, key=_sort_key)

    def save(self) -> None:
        self.store.schedule_save(self.items)

    def has(self, item_id: str) -> bool:
        return any(i["id"] == item_id for i in self.items)

    def upsert(self, item: dict) -> None:
        self.items = sorted([i for i in self.items if i["id"] != item["id"]] + [item], key=_sort_key)
        self.save()

    def delete(self, item_id: str) -> None:
        self.items = [i for i in self.items if i["id"] != item_id]
        self.save()

    def _crew_issues(self, person: str, exits: list[dict]) -> list[str]:
        issues = []
        sols = [i["sol"] for i in exits]
        days = sorted(set(sols))
        if len(sols) != len(days):
            issues.append(f"{person}: więcej niż jedno wyjście w tym samym solu")
        run = 1
        for previous, sol in zip(days, days[1:]):
            run = run + 1 if sol == previous + 1 else 1
            if run > MAX_CONSECUTIVE_SOLS:
                issues.append(f"{person}: {MAX_CONSECUTIVE_SOLS + 1} sole z rzędu z wyjściem (sol {sol}) — potrzebny sol odpoczynku")
        for first in days:
            hours = sum(i["durationH"] for i in exits if first <= i["sol"] < first + WEEK_SOLS)
            if hours > WEEKLY_LIMIT_H:
                issues.append(f"{person}: {hours:.1f} h EVA w {WEEK_SOLS} solach od sola {first} (limit {WEEKLY_LIMIT_H:.0f} h)")
                break
        return issues

    def evaluate(self) -> dict:
        sunset = sun.sunset_ltst(self.lat, self.decl)
        sunrise = 24 - sunset
        issues, per_item = [], []
        o2_total = person_hours = 0.0
        wh_by_sol: dict[int, float] = {}
        by_crew: dict[str, list[dict]] = {}
        for item in self.items:
            start, hours = _hours(item["startLtst"]), item["durationH"]
            crew = list(dict.fromkeys(item["crew"]))  # ta sama osoba wpisana dwa razy liczy się raz
            o2 = self.o2_rate_lh * hours * len(crew) * O2_MARGIN
            wh = SUIT_POWER_W * hours * len(crew)
            o2_total += o2
            person_hours += hours * len(crew)
            wh_by_sol[item["sol"]] = wh_by_sol.get(item["sol"], 0.0) + wh
            notes = []
            if hours > MAX_EVA_H:
                notes.append(f"wyjście dłuższe niż {MAX_EVA_H:.0f} h")
            if start < sunrise + DAYLIGHT_MARGIN_H:
                notes.append(f"start przed świtem+30 min (świt {sunrise:.2f} LTST)")
            if start + hours > sunset - DAYLIGHT_MARGIN_H:
                notes.append(f"powrót po zmierzchu−30 min (zmierzch {sunset:.2f} LTST)")
            for person in crew:
                by_crew.setdefault(person, []).append(item)
            issues += [f"{item['id']}: {note}" for note in notes]
            per_item.append({**item, "o2L": round(o2), "batteryWh": round(wh), "endLtst": sun.fmt_ltst(start + hours), "issues": notes})
        for person, exits in by_crew.items():
            issues += self._crew_issues(person, exits)
        o2_available = self.stores["o2TanksL"] * USABLE_STORES
        wh_per_sol = self.stores["batteriesWh"] * USABLE_STORES  # baterie są ładowane co sol
        if o2_total > o2_available:
            issues.append(f"Tlen: plan wymaga {o2_total:.0f} L, dostępne {o2_available:.0f} L (80% zapasów)")
        for sol, needed in sorted(wh_by_sol.items()):
            if needed > wh_per_sol:
                issues.append(f"Energia: sol {sol} wymaga {needed:.0f} Wh, dostępne {wh_per_sol:.0f} Wh (80% baterii)")
        return {
            "items": per_item,
            "issues": sorted(set(issues)),
            "consumables": {
                "o2NeededL": round(o2_total),
                "o2AvailableL": round(o2_available),
                "batteryWh": round(sum(wh_by_sol.values())),
                "batteryAvailableWh": round(wh_per_sol * max(1, len(wh_by_sol))),
                "waterL": round(person_hours * WATER_L_PER_H, 1),
            },
            "daylight": {"sunriseLtst": round(sunrise, 2), "sunsetLtst": round(sunset, 2)},
            "rules": RULES,
        }
