"""Odświeża pola kosztu powrotu do habitatu (o2ToHabitat.f32, timeToHabitat.f32) po zmianie planera.

Pola liczy ten sam kod co backend na żywo, z gotowych warstw misji w data/missions/<id>/ — bez surowych produktów NASA
i bez ponownego uruchamiania całego potoku. Sumy kontrolne w provenance.json są aktualizowane.

    python tools/refresh_cost_fields.py              # wszystkie zbudowane misje
    python tools/refresh_cost_fields.py jezero       # jedna misja
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from backend import missions, planning  # noqa: E402
from backend.live.engine import EvaEngine  # noqa: E402
from backend.paths import MISSIONS  # noqa: E402


def refresh(mission_id: str) -> None:
    mission_dir = MISSIONS / mission_id
    engine = EvaEngine(mission_dir, missions.config(mission_id), live_feeds=False)
    habitat = engine.cfg["habitat"]
    provenance_path = mission_dir / "provenance.json"
    provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    for name, kind in (("o2ToHabitat.f32", "o2"), ("timeToHabitat.f32", "time")):
        field = planning.cost_field(engine.model, habitat, kind)
        field.astype("<f4").tofile(mission_dir / name)
        provenance.setdefault("outputs", {})[name] = hashlib.sha256((mission_dir / name).read_bytes()).hexdigest()
        reachable = field < planning.UNREACHABLE
        print(f"{mission_id}/{name}: osiągalne {reachable.mean() * 100:.1f}% obszaru, maks. {field[reachable].max():.1f}")
    provenance_path.write_text(json.dumps(provenance, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    for mission in sys.argv[1:] or [m for m in missions.ids() if (MISSIONS / m / "mission.json").exists()]:
        refresh(mission)
