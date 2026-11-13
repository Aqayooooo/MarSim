"""Załoga z imionami: Bartek i Hubert wychodzą na EVA (dawniej EV1/EV2), Mateusz i Eryk zostają w bazie.

Sprawdza konfigurację misji i dane bez serwera, a także zgodność wstecz: punkt kontrolny i harmonogram zapisane
w bazie przed zmianą (z identyfikatorami EV1/EV2) wczytują się z nowymi imionami.
"""

import json

import pytest
from conftest import REPO, make_engine

from backend import missions as mis
from backend.live import checkpoint
from backend.live.store import Store

EVA_CREW = ["Bartek", "Hubert"]
MISSION_FILES = [
    "backend/config/missions/mount-sharp.json",
    "backend/config/missions/jezero.json",
    "data/missions/mount-sharp/mission.json",
    "data/missions/jezero/mission.json",
    "data/demo/mission.json",
]


@pytest.mark.parametrize("path", MISSION_FILES)
def test_mission_crew_has_names(path):
    crew = json.loads((REPO / path).read_text(encoding="utf-8"))["crew"]
    assert [c["id"] for c in crew] == EVA_CREW


@pytest.mark.parametrize("path", [*MISSION_FILES, *sorted(str(p.relative_to(REPO)) for p in REPO.glob("data/missions/*/backend/*.json"))])
def test_no_numbered_crew_ids_left(path):
    text = (REPO / path).read_text(encoding="utf-8")
    assert '"EV1"' not in text and '"EV2"' not in text and "EV1:" not in text and "EV2:" not in text


@pytest.mark.parametrize("mission_id", ["mount-sharp", "jezero"])
def test_default_schedule_uses_names(mission_id):
    engine = make_engine(mission_id)
    crews = [set(i["crew"]) for i in engine.scheduler.items]
    assert crews and all(c <= set(EVA_CREW) for c in crews)
    assert any(c == set(EVA_CREW) for c in crews)
    snap_ids = [c["id"] for c in engine.snapshot()["crew"]]
    assert snap_ids and set(snap_ids) <= set(EVA_CREW)


def test_alerts_name_the_crew_member():
    engine = make_engine("mount-sharp")
    assert engine.start(600) is None
    cap = engine.crew[1]["person"].o2_capacity_l
    engine.apply_telemetry("Hubert", {"o2L": cap * 0.10})
    for _ in range(40):
        engine.step(0.1)
    texts = [a["text"] if isinstance(a, dict) else str(a) for a in engine.snapshot()["alerts"]]
    assert any(t.startswith("Hubert: ") for t in texts), texts
    assert not any("EV1" in t or "EV2" in t for t in texts)


def test_legacy_checkpoint_with_numbered_ids_resumes(tmp_path):
    path = tmp_path / "a.db"
    before = make_engine("mount-sharp", Store(path))
    assert before.start(600) is None
    for _ in range(int(900 / (0.1 * before.time_scale))):
        before.step(0.1)
    before.pause()
    state = json.loads(json.dumps(checkpoint.capture(before), default=float))
    o2 = [c["o2_l"] for c in state["crew"]]
    for saved, legacy in zip(state["crew"], ["EV1", "EV2"]):
        saved["id"] = legacy  # zapis sprzed zmiany identyfikatorów
    state["warned"] = [["o2", "EV2"]]
    before.store.checkpoint_save(state)
    before.store.close()

    after = make_engine("mount-sharp", Store(path))
    assert after.resumed
    assert [m["cfg"]["id"] for m in after.crew] == EVA_CREW
    assert [m["person"].o2_l for m in after.crew] == pytest.approx(o2)
    assert ("o2", "Hubert") in after._warned


def test_legacy_schedule_items_are_renamed(tmp_path):
    path = tmp_path / "a.db"
    store = Store(path)
    store.schedule_save([{"id": "EVA-7", "sol": 150, "startLtst": "10:00", "durationH": 2.0, "crew": ["EV1", "EV2"], "purpose": "test"}])
    store.close()
    engine = make_engine("mount-sharp", Store(path))
    assert [i["crew"] for i in engine.scheduler.items] == [EVA_CREW]


def test_config_loader_returns_named_crew():
    for mission_id in ("mount-sharp", "jezero"):
        assert [c["id"] for c in mis.config(mission_id)["crew"]] == EVA_CREW
