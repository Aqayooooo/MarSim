# Prezentacja MarSim w PowerPoincie

Generator pliku `../MarSim-prezentacja.pptx`: te same 7 slajdów co `../index.html`
(na slajdzie 5 kliknięcie przełącza wizjer z normy na alarm tlenu), z notatkami prowadzącego,
przejściem Przekształcenie (Morph) i animacjami wejścia.

## Budowanie

Wymaga Pythona z `python-pptx`, `numpy` i `Pillow`:

```
python -m venv .venv && .venv/bin/pip install python-pptx numpy pillow
.venv/bin/python render_mars.py   # tylko po zmianie ujęć Marsa: render/mars-N.png, render/poses.json
.venv/bin/python build.py         # ../MarSim-prezentacja.pptx i podglądy preview/deck-NN.jpg
.venv/bin/python preview.py 3     # podgląd jednego slajdu: preview/slide-3.jpg
```

## Pliki

- `common.py`: wspólny wygląd (kolory, kroje, górny pasek, stopka, Mars), rysowanie elementów
  w .pptx i jednocześnie w podglądzie PNG, animacje wejścia (`with s.step(...)`) i przejście Morph.
- `slides/s1.py` … `s7.py`: treść poszczególnych slajdów. Współrzędne w pikselach sceny 1920×1080
  jak w `index.html`, rozmiary krojów w punktach (1 pt = 2 px sceny).
- `render_mars.py`: render planety dla każdego slajdu z `../assets/mars.jpg`.

## Animacje

Kroki z `with s.step("rise" | "wipe" | "fade")` startują same po wejściu na slajd, co `STEP_GAP` ms.
Tempo: `STEP_START`, `STEP_GAP` i `DUR` w `common.py`. Mars nie ma animacji: przesuwa go Morph,
bo na każdym slajdzie obraz planety ma tę samą nazwę `!!Mars`.
