"""Łączność DTN, harmonogram wyjść (reguły sprawdzone własną implementacją) i trwałość SQLite."""

import random
from datetime import datetime, timezone

import pytest

from backend import missions as mis
from backend.live.dtn import DtnLink
from backend.live.schedule import Scheduler
from backend.live.store import Store
from backend.models import sun

DATE = datetime(2037, 1, 10, tzinfo=timezone.utc)


# ---------------- DTN ----------------
def test_message_and_reply_arrive_after_light_time():
    link = DtnLink(DATE)
    one_way = link.geometry(0)["oneWayMin"] * 60
    b = link.send(0, "raport", "test", reply="ok")
    assert b.deliver_s == pytest.approx(one_way)
    assert link.step(one_way - 1) == []
    assert [x.id for x in link.step(one_way + 1)] == [b.id]
    assert link.step(2 * one_way + 119) == []
    back = link.step(2 * one_way + 121)
    assert len(back) == 1 and back[0].direction == "z Ziemi"
    assert link.pending == []


def test_message_after_idle_period_is_not_delayed_by_idle_time():
    """Cisza w eterze (brak paczek w kolejce) nie jest przerwą łącza i nie może opóźniać następnej wiadomości."""
    link = DtnLink(DATE)
    for t in range(0, 7200, 10):  # 2 h bez żadnych wiadomości
        link.step(t)
    one_way = link.geometry(7200)["oneWayMin"] * 60
    b = link.send(7200, "raport", "pierwsza wiadomość po ciszy")
    link.step(7210)
    assert b.deliver_s == pytest.approx(7200 + one_way, abs=1), (
        f"opóźnienie {(b.deliver_s - 7200) / 60:.1f} min zamiast {one_way / 60:.1f} min"
    )


def test_outage_holds_messages_until_link_returns():
    link = DtnLink(DATE)
    one_way = link.geometry(0)["oneWayMin"] * 60
    link.step(0)
    link.outage_until_s = 1800
    b = link.send(100, "alert", "w trakcie przerwy")
    for t in range(100, 1800, 20):
        assert link.step(t) == []
    assert not link.status(900)["up"] and link.status(1800)["up"]
    assert b.deliver_s >= 1800 + one_way - 1
    assert b.deliver_s <= 1800 + one_way + 60, f"paczka opóźniona o {(b.deliver_s - 1800 - one_way) / 60:.1f} min ponad przerwę"


def test_message_sent_before_outage_waits_for_it_to_end():
    link = DtnLink(DATE)
    b = link.send(0, "raport", "tuż przed przerwą")
    link.step(1)
    link.outage_until_s = 30 + 1800
    t = 30
    while not b.delivered and t < 4 * 3600:
        link.step(t)
        t += 15
    assert b.delivered and t >= 1830


def test_history_trim_never_loses_pending():
    link = DtnLink(DATE)
    sent = [link.send(i, "telemetria", f"m{i}") for i in range(500)]
    assert len(link.queue) <= DtnLink.HISTORY
    assert len(link.pending) == 500
    delivered = link.step(1e6)
    assert {b.id for b in delivered} == {b.id for b in sent}


def test_bundle_ids_are_per_link():
    a, b = DtnLink(DATE), DtnLink(DATE)
    first = a.send(0, "x", "x").id
    assert b.send(0, "x", "x").id == first, "identyfikatory paczek są wspólne dla wszystkich misji/sesji"


# ---------------- harmonogram ----------------
CREW = [{"id": "Bartek"}, {"id": "Hubert"}]
STORES = {"o2TanksL": 6000, "batteriesWh": 12000, "waterL": 300}


def scheduler(items=None, lat=-4.67, decl=-10.0):
    store = Store(":memory:")
    if items is not None:
        store.schedule_save(items)
    return Scheduler(store, CREW, STORES, lat, decl)


def item(i, sol, start="10:00", dur=2.0, crew=("Bartek",)):
    return {"id": f"E{i}", "sol": sol, "startLtst": start, "durationH": dur, "crew": list(crew), "purpose": "t"}


def reference_rules(items, sunrise, sunset):
    """Reguły z docstringu modułu, zaimplementowane niezależnie. Zwraca zbiór (reguła, kto/co)."""
    out = set()
    for it in items:
        h, m = map(int, it["startLtst"].split(":"))
        s = h + m / 60
        if it["durationH"] > 8:
            out.add(("long", it["id"]))
        if s < sunrise + 0.5:
            out.add(("dawn", it["id"]))
        if s + it["durationH"] > sunset - 0.5:
            out.add(("dusk", it["id"]))
    for c in {c for it in items for c in it["crew"]}:
        mine = [it for it in items if c in it["crew"]]
        sols = [it["sol"] for it in mine]
        if len(sols) != len(set(sols)):
            out.add(("twice", c))
        days = set(sols)
        if any(all(d + k in days for k in range(4)) for d in days):
            out.add(("rest", c))
        if any(sum(it["durationH"] for it in mine if d <= it["sol"] < d + 7) > 24 for d in days):
            out.add(("week", c))
    return out


def flagged(evaluation):
    out = set()
    for text in evaluation["issues"]:
        who = text.split(":")[0]
        if "dłuższe niż 8 h" in text:
            out.add(("long", who))
        elif "przed świtem" in text:
            out.add(("dawn", who))
        elif "po zmierzchu" in text:
            out.add(("dusk", who))
        elif "więcej niż jedno wyjście" in text:
            out.add(("twice", who))
        elif "z rzędu" in text:
            out.add(("rest", who))
        elif "w 7 solach" in text:
            out.add(("week", who))
    return out


def test_rest_rule_with_two_exits_on_one_sol():
    """Sole 1,2,2,3,4 to nadal 4 sole z rzędu — zdublowany sol nie może kasować licznika."""
    s = scheduler([item(1, 1), item(2, 2), item(3, 2, start="14:00"), item(4, 3), item(5, 4)])
    assert ("rest", "Bartek") in flagged(s.evaluate())


def test_rules_match_reference_on_random_schedules():
    rng = random.Random(20261109)
    mismatches = []
    for case in range(300):
        items = [
            item(
                i,
                rng.randint(1, 9),
                start=f"{rng.randint(5, 17):02d}:{rng.choice([0, 15, 30, 45]):02d}",
                dur=rng.choice([1.0, 2.5, 4.0, 6.5, 8.0, 9.5]),
                crew=rng.choice([("Bartek",), ("Hubert",), ("Bartek", "Hubert")]),
            )
            for i in range(rng.randint(1, 9))
        ]
        s = scheduler(items)
        ev = s.evaluate()
        day = ev["daylight"]
        expected, got = reference_rules(items, day["sunriseLtst"], day["sunsetLtst"]), flagged(ev)
        if expected != got:
            mismatches.append((case, sorted(expected ^ got)))
    assert not mismatches, f"{len(mismatches)}/300 planów ocenionych inaczej niż wg reguł, np. {mismatches[:3]}"


def test_daylight_window_is_symmetric_and_plausible():
    ev = scheduler([item(1, 1)]).evaluate()
    d = ev["daylight"]
    assert d["sunriseLtst"] + d["sunsetLtst"] == pytest.approx(24.0, abs=0.02)
    assert d["sunsetLtst"] == pytest.approx(sun.sunset_ltst(-4.67, -10.0), abs=0.01)


def test_consumables_budget():
    s = scheduler([item(1, 1, dur=2.0, crew=("Bartek", "Hubert")), item(2, 2, dur=3.0)])
    c = s.evaluate()["consumables"]
    assert c["o2NeededL"] == round(50.0 * 1.1 * (2.0 * 2 + 3.0))
    assert c["o2AvailableL"] == 4800
    assert c["waterL"] == pytest.approx(0.6 * 7.0)
    big = scheduler([item(i, i, dur=8.0, crew=("Bartek", "Hubert")) for i in range(1, 9)]).evaluate()
    assert any(t.startswith("Tlen") for t in big["issues"])


def test_duplicate_crew_member_is_not_counted_twice():
    s = scheduler([item(1, 1, dur=2.0, crew=("Bartek", "Bartek"))])
    assert s.evaluate()["consumables"]["o2NeededL"] == round(50.0 * 1.1 * 2.0)


@pytest.mark.parametrize("mission_id", ["mount-sharp", "jezero"])
def test_default_schedule_matches_mission_sol(mission_id):
    """Domyślny plan wyjść powinien zaczynać się w solu misji, nie w solu innej misji."""
    from conftest import make_engine

    eng = make_engine(mission_id)
    sols = [i["sol"] for i in eng.scheduler.items]
    assert min(sols) == mis.config(mission_id)["sol"], f"misja w solu {mis.config(mission_id)['sol']}, plan od sola {min(sols)}"


def test_default_schedule_has_no_issues(gale):
    assert gale.scheduler.evaluate()["issues"] == []


# ---------------- SQLite ----------------
def test_store_persists_between_processes(tmp_path):
    path = tmp_path / "m.db"
    a = Store(path)
    assert a.new_session() == 1
    a.log("EVA", "pierwszy", 12.5, "09:20", {"k": "ąę"})
    a.add_observation({"kind": "glazy", "x": 1.0})
    a.schedule_save([item(1, 1)])
    a.close()
    b = Store(path)
    assert b.new_session() == 2
    ev = b.events(10)
    assert ev[0]["text"] == "pierwszy" and ev[0]["meta"] == {"k": "ąę"} and ev[0]["session"] == 1
    assert b.observations()[0]["kind"] == "glazy"
    assert [i["id"] for i in b.schedule_load()] == ["E1"]
    b.close()


def test_empty_schedule_stays_empty_after_restart(tmp_path):
    a = Store(tmp_path / "m.db")
    assert a.schedule_load() is None  # nowa baza: jeszcze nie zapisano → domyślny plan
    a.schedule_save([])
    a.close()
    assert Store(tmp_path / "m.db").schedule_load() == []


def test_event_log_filters_and_limits(tmp_path):
    s = Store(tmp_path / "m.db")
    s.new_session()
    for i in range(30):
        s.log("EVA", f"a{i}")
    s.new_session()
    for i in range(5):
        s.log("EVA", f"b{i}")
    assert len(s.events(100)) == 35
    assert [e["text"] for e in s.events(3)] == ["b4", "b3", "b2"]
    assert len(s.events(100, session=1)) == 30 and len(s.events(100, session=2)) == 5
