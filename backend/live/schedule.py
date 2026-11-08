"""Planowanie wielu wyjść: harmonogram, zapasy habitatu, odpoczynek załogi, światło dzienne.

Reguły (założenia planistyczne do uzgodnienia z lekarzem lotu, nie normy NASA):
- jedno wyjście na sol na osobę, maks. 8 h;
- po 3 kolejnych solach z wyjściem — sol odpoczynku;
- maks. 24 h EVA na osobę w 7 solach;
- wyjście w dzień: start ≥ 30 min po wschodzie, powrót ≥ 30 min przed zachodem;
- tlen i energia na wszystkie wyjścia ≤ zapasy habitatu minus 20% rezerwy.
"""
from __future__ import annotations

from pathlib import Path

from backend.models import sun


def default_schedule() -> list[dict]:
    return [
        {"id": "EVA-1", "sol": 147, "startLtst": "09:20", "durationH": 2.5, "crew": ["EV1", "EV2"], "purpose": "trawers do WP2, rozpoznanie wydm"},
        {"id": "EVA-2", "sol": 148, "startLtst": "10:00", "durationH": 3.0, "crew": ["EV1", "EV2"], "purpose": "rozmieszczenie nadajników UWB"},
        {"id": "EVA-3", "sol": 149, "startLtst": "09:30", "durationH": 4.0, "crew": ["EV1"], "purpose": "serwis łazika"},
        {"id": "EVA-4", "sol": 150, "startLtst": "09:00", "durationH": 3.5, "crew": ["EV1", "EV2"], "purpose": "pomiary na krawędzi krateru"},
    ]


def _h(s: str) -> float:
    a, b = s.split(":")
    return int(a) + int(b) / 60


class Scheduler:
    def __init__(self, store, crew_cfg: list[dict], stores: dict, lat: float, decl: float, o2_rate_lh: float = 50.0):
        """store: backend.live.store.Store — harmonogram jest zapisywany w SQLite."""
        self.store = store
        self.crew_cfg = {c["id"]: c for c in crew_cfg}
        self.stores = stores
        self.lat, self.decl = lat, decl
        self.o2_rate_lh = o2_rate_lh   # średnie zużycie O₂ podczas EVA (L/h na osobę), z modelu wysiłku
        saved = store.schedule_load()
        self.items = saved if saved is not None else default_schedule()
        self.items.sort(key=lambda i: (i["sol"], _h(i["startLtst"])))

    def save(self):
        self.store.schedule_save(self.items)

    def upsert(self, item: dict):
        self.items = [i for i in self.items if i["id"] != item["id"]] + [item]
        self.items.sort(key=lambda i: (i["sol"], _h(i["startLtst"])))
        self.save()

    def delete(self, item_id: str):
        self.items = [i for i in self.items if i["id"] != item_id]
        self.save()

    def evaluate(self) -> dict:
        sunset = sun.sunset_ltst(self.lat, self.decl)
        sunrise = 24 - sunset
        issues, per_item = [], []
        o2_total = wh_total = 0.0
        by_crew: dict[str, list[dict]] = {}
        for it in self.items:
            start, dur = _h(it["startLtst"]), it["durationH"]
            n = len(it["crew"])
            o2 = self.o2_rate_lh * dur * n * 1.1                     # +10% na nieszczelności i rezerwę
            wh = 95 * dur * n
            o2_total += o2; wh_total += wh
            notes = []
            if dur > 8:
                notes.append("wyjście dłuższe niż 8 h")
            if start < sunrise + 0.5:
                notes.append(f"start przed świtem+30 min (świt {sunrise:.2f} LTST)")
            if start + dur > sunset - 0.5:
                notes.append(f"powrót po zmierzchu−30 min (zmierzch {sunset:.2f} LTST)")
            for c in it["crew"]:
                by_crew.setdefault(c, []).append(it)
            per_item.append({**it, "o2L": round(o2), "batteryWh": round(wh), "endLtst": sun.fmt_ltst(start + dur), "issues": notes})
        for c, its in by_crew.items():
            sols = sorted(i["sol"] for i in its)
            if len(sols) != len(set(sols)):
                issues.append(f"{c}: więcej niż jedno wyjście w tym samym solu")
            run = 1
            for a, b in zip(sols, sols[1:]):
                run = run + 1 if b == a + 1 else 1
                if run > 3:
                    issues.append(f"{c}: 4 sole z rzędu z wyjściem (sol {b}) — potrzebny sol odpoczynku")
            for s0 in sols:
                hrs = sum(i["durationH"] for i in its if s0 <= i["sol"] < s0 + 7)
                if hrs > 24:
                    issues.append(f"{c}: {hrs:.1f} h EVA w 7 solach od sola {s0} (limit 24 h)")
                    break
        o2_avail = self.stores["o2TanksL"] * 0.8
        n_sols = max(1, len({i['sol'] for i in self.items}))
        wh_avail = self.stores["batteriesWh"] * 0.8 * n_sols          # baterie ładowane co sol
        if o2_total > o2_avail:
            issues.append(f"Tlen: plan wymaga {o2_total:.0f} L, dostępne {o2_avail:.0f} L (80% zapasów)")
        if wh_total > wh_avail:
            issues.append(f"Energia: plan wymaga {wh_total:.0f} Wh, dostępne {wh_avail:.0f} Wh (80% baterii × {n_sols} sol)")
        for it in per_item:
            issues += [f"{it['id']}: {n}" for n in it["issues"]]
        return {"items": per_item, "issues": sorted(set(issues)),
                "consumables": {"o2NeededL": round(o2_total), "o2AvailableL": round(o2_avail), "batteryWh": round(wh_total),
                                "batteryAvailableWh": round(wh_avail),
                                "waterL": round(sum(i["durationH"] * len(i["crew"]) for i in self.items) * 0.6, 1)},
                "daylight": {"sunriseLtst": round(sunrise, 2), "sunsetLtst": round(sunset, 2)},
                "rules": [l.strip("- ").strip() for l in (__doc__ or "").splitlines() if l.strip().startswith("-")]}
