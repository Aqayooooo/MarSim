"""Slajd 7 · Wdrożenie: stan prac, cztery liczby, następne kroki i zdanie zamykające.

Mars po lewej (backdrop), cała treść w kolumnie po prawej: x=1100, szerokość 692 px.
"""
from common import Slide, backdrop, chrome, BONE, BONE2, BONE3, HAIR, ACCENT_HI, SANS

NB = " "  # twarda spacja, jak &nbsp; w index.html

X, WC = 1100, 692          # lewa krawędź i szerokość kolumny

FIGS = [
    ("290", "testów backendu"),
    ("30", "testów sterowania EVA"),
    ("407", "kluczy PL/EN"),
    ("2", f"obszary misji: Gale i{NB}Jezero"),
]

STEPS = [
    f"Kalibracja modelu tlenu danymi z{NB}prawdziwego skafandra",
    f"Sprawdzenie wykrywania głazów na zdjęciach z{NB}łazika",
    f"Próba z{NB}załogą w{NB}misji analogowej",
]

NOTES = [
    "Mówi: Osoba 1 · ok. 1:00",
    "MarSim działa dziś, w wersji 1.4: 290 testów backendu, 30 testów sterowania wyjściem, testy w prawdziwej "
    "przeglądarce i 407 kluczy tłumaczeń. Działa bez internetu, zapisuje stan wyjścia co 5 sekund i po awarii "
    "serwera wznawia je w pauzie. Każdy produkt danych ma sumę SHA-256, więc wynik można odtworzyć.",
    "Mówimy też wprost o ograniczeniach. Model tlenu trzeba skalibrować danymi z prawdziwego skafandra, a wykrywanie "
    "głazów sprawdzić na zdjęciach z łazika. Następny krok to próba z załogą w misji analogowej.",
    "Zanim astronauta wyjdzie ze śluzy, trasa jest już policzona. Dziękujemy. Chętnie pokażemy MarSim na żywo "
    "i odpowiemy na pytania.",
    "→ Pokaz na żywo poprowadzi Osoba 3, a widok z hełmu skomentuje Osoba 4.",
]


def build(prs):
    s = Slide(prs, "7 · Wdrożenie")
    backdrop(s, 6)

    # kicker i tytuł (h2 66 px → 33 pt)
    with s.step("rise"):                                   # --d:0 → 150 ms
        s.kicker(X, 124, "Stan prac · wersja 1.4", w=WC)
    with s.step("rise"):                                   # --d:1 → 320 ms
        s.title(X, 158, WC, 162, ["Stan prac", [(f"i{NB}", {}), ("następne kroki", {"italic": True})]],
                size=33, name="Tytuł")

    # cztery liczby z cienką linią nad każdą (.figs.rule)
    gap = 20
    cw = (WC - 3 * gap) / 4
    fy = 340
    with s.step("rise"):                                   # --d:2 → 490 ms, cały rząd z liniami
        for i, (n, label) in enumerate(FIGS):
            fx = X + i * (cw + gap)
            s.line(fx, fy, fx + cw, fy, HAIR, 1, name=f"Liczba {i + 1} linia")
            s.text(fx, fy + 16, cw, 64, n, size=26, color=BONE, spacing=-0.6, line=1.0, name=f"Liczba {i + 1}")
            s.text(fx, fy + 86, cw, 64, label, size=11, color=BONE, line=1.15, name=f"Liczba {i + 1} opis")

    # akapit (.body)
    with s.step("rise"):                                   # --d:3 → 660 ms
        s.text(X, 514, WC, 124,
               f"Działa bez internetu. Stan wyjścia zapisuje co 5 sekund i{NB}wznawia go po awarii serwera. "
               "Każdy produkt danych ma sumę SHA-256.",
               size=14, color=BONE2, line=1.2, name="Akapit")

    # numerowana lista kroków (.steps): linie między wierszami, numer w kolorze akcentu
    pad, lh = 9, 28 * 1.2 * 1.05          # odstęp w wierszu, wysokość linii tekstu 14 pt
    ry = 656
    # --d:4: wiersze wchodzą po kolei (830, 1000, 1170 ms), każdy z linią nad sobą; dolna linia z ostatnim
    for i, (t, nl) in enumerate(zip(STEPS, (2, 2, 1))):
        rh = 2 * pad + nl * lh
        with s.step("rise"):
            s.line(X, ry, X + WC, ry, HAIR, 1, name=f"Krok {i + 1} linia")
            s.text(X, ry + pad + 9, 56, 24, f"{i + 1:02d}", size=10, color=ACCENT_HI, spacing=1.2, line=1.0,
                   name=f"Krok {i + 1} numer")
            s.text(X + 56, ry + pad, WC - 56, nl * lh + 2, t, size=14, color=BONE2, line=1.05,
                   name=f"Krok {i + 1}")
            if i == len(STEPS) - 1:
                s.line(X, ry + rh, X + WC, ry + rh, HAIR, 1, name="Kroki linia dolna")
        ry += rh

    # zdanie zamykające (.closing, kursywa); --d:6 → wyraźnie na końcu
    with s.step("rise", delay=1500):
        s.text(X, ry + 20, WC, 88,
               f"Zanim astronauta wyjdzie ze{NB}śluzy, trasa jest już policzona.",
               size=17, color=BONE, italic=True, line=1.05, name="Zdanie zamykające")

    chrome(s, 6)
    s.notes("\n\n".join(NOTES))
    return [s]
