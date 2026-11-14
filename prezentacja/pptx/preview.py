"""Podgląd jednego slajdu: python preview.py 3

Buduje tylko moduł slides/s3.py, zapisuje preview/slide-3.jpg (i slide-3b.jpg itd. dla kolejnych
stanów) oraz preview/slide-3.pptx, a potem wypisuje ostrzeżenia o przepełnionym tekście.
"""
import importlib
import sys

from common import PREVIEW, add_morph, new_presentation

i = int(sys.argv[1])
prs = new_presentation()
slides = importlib.import_module(f"slides.s{i}").build(prs)
PREVIEW.mkdir(exist_ok=True)
for k, s in enumerate(slides):
    add_morph(s.sl)
    s.apply_animations()
    path = PREVIEW / f"slide-{i}{'' if k == 0 else chr(ord('a') + k)}.jpg"
    s.save_preview(path)
    print("podgląd:", path)
    for w in s.warnings:
        print("  ", w)
prs.save(PREVIEW / f"slide-{i}.pptx")
print("pptx:", PREVIEW / f"slide-{i}.pptx")
