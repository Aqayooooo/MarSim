"""Składa całą prezentację z modułów slides/s1.py … s7.py.

Uruchom: python build.py   → ../MarSim-prezentacja.pptx oraz preview/deck-*.jpg
Każdy moduł ma funkcję build(prs), która zwraca listę obiektów common.Slide (zwykle jeden;
slajd 5 zwraca dwa: wizjer w normie i w alarmie).
"""
import importlib
import sys

from common import HERE, PREVIEW, add_morph, new_presentation

OUT = HERE.parent / "MarSim-prezentacja.pptx"


def main():
    prs = new_presentation()
    n, warn = 0, []
    for i in range(1, 8):
        mod = importlib.import_module(f"slides.s{i}")
        for s in mod.build(prs):
            n += 1
            add_morph(s.sl)
            s.apply_animations()
            s.save_preview(PREVIEW / f"deck-{n:02d}.jpg")
            warn += [f"[{s.label}] {w}" for w in s.warnings]
    prs.save(OUT)
    print(f"Zapisano {OUT} ({n} slajdów)")
    for w in warn:
        print(w)
    return 1 if warn else 0


if __name__ == "__main__":
    sys.exit(main())
