"""Slajd 3 · Dane: tabela instrumentów NASA po lewej, Mars ze znacznikami Jezero i Gale po prawej."""
from common import Slide, backdrop, chrome, BONE, BONE2, BONE3, HAIR

X = 128                      # lewa krawędź treści
TABLE_W = 812                # tabela kończy się na x=940, przed etykietą Jezero (x≥969) i orbitą (x≥986)
COL_NAME, COL_RES = 350, 116
GAP = 14
X_RES = X + COL_NAME + GAP
X_USE = X_RES + COL_RES + GAP
COL_USE = X + TABLE_W - X_USE

NAME_PX, MISSION_PX, LINE_PX = 34, 24, 34   # wysokości linii: nazwa 14 pt, misja 10 pt, tekst 14 pt
PAD = 4

INSTRUMENTS = [
    # nazwa, misja, rozdzielczość (linie), zastosowanie (linie)
    ("HiRISE", "Mars Reconnaissance Orbiter", ["0,25 m"], ["głazy od 1 m,", "nachylenie zboczy"]),
    ("CTX", "Mars Reconnaissance Orbiter", ["6 m"], ["kontekst terenu"]),
    ("CRISM", "Mars Reconnaissance Orbiter", ["18 m"], ["minerały, w tym oliwin"]),
    ("THEMIS", "Mars Odyssey", ["100 m"], ["luźny piasek, w którym", "można ugrzęznąć"]),
    ("MOLA", "Mars Global Surveyor", ["463 m"], ["wysokość terenu"]),
    ("DONKI · NOAA SWPC", "pogoda kosmiczna", ["na żywo"], ["burze słoneczne, protony"]),
]

SITES = {
    # nazwa: (strona etykiety, linie danych)
    "Jezero": ("l", ["18,44° N · 77,45° E", "340 głazów ≥ 1 m"]),
    "Gale": ("r", ["4,67° S · 137,38° E", "wydmy i boxwork", "1220 głazów ≥ 1 m"]),
}

NOTES = """Mówi: Osoba 2 · ok. 1:00

Wyzwanie NASA Martian Map prosi o warstwową mapę miejsca albo trasy na Marsie, zbudowaną z danych wielu misji. Mapa ma pomóc zaplanować wyjście: trasę i cele, bieżące warunki i naukę po drodze.

Łączymy pięć instrumentów orbitalnych. HiRISE daje zdjęcia 25 centymetrów na piksel i model wysokości z dokładnością 20 centymetrów. Z cieni na tych zdjęciach wykrywamy głazy od metra wzwyż: w Jezero jest ich 340, a w kraterze Gale 1220: 649 przy wydmach Bagnold i 571 przy formacjach boxwork na zboczu Mount Sharp, które bada teraz łazik Curiosity. THEMIS pokazuje luźny piasek, CRISM minerały, MOLA kontroluje wysokości, a DONKI i NOAA dają pogodę kosmiczną na żywo. W każdym obszarze na mapie jest też prawdziwa trasa łazika NASA, Curiosity albo Perseverance, z postojami i zdjęciami z kamery Navcam.

Nie używamy uczenia maszynowego. Każda warstwa ma opisaną metodę i źródło, więc wiadomo, skąd wzięła się każda decyzja na mapie.

→ Jak z tych warstw powstaje trasa, pokaże Osoba 3."""


def marker(s, name, x, y, side, lines):
    """Znacznik miejsca jak .mk w index.html: kółko, kreska 56 px, nazwa kursywą i linie danych (2–3)."""
    s.ellipse(x, y, 6, line=BONE, line_w=1, name=f"Znacznik {name} obrys")
    s.ellipse(x, y, 2, fill=BONE, name=f"Znacznik {name} kropka")
    w = 230
    if side == "l":
        s.line(x - 68, y, x - 12, y, BONE, 1, alpha=.7, name=f"Znacznik {name} kreska")
        tx, align = x - 80 - w, "right"
    else:
        s.line(x + 12, y, x + 68, y, BONE, 1, alpha=.7, name=f"Znacznik {name} kreska")
        tx, align = x + 80, "left"
    s.text(tx, y - 30, w, 38, [[(name, {"italic": True})]], size=15, color=BONE, align=align, line=1.0,
           name=f"Znacznik {name} nazwa")
    s.text(tx, y + 10, w, 30 * len(lines), lines, size=10, color=BONE, align=align, line=1.2, spacing=.4,
           name=f"Znacznik {name} dane")


def build(prs):
    s = Slide(prs, "3 · Dane")
    pose = backdrop(s, 2)

    with s.step("rise"):            # kicker (--d:0)
        s.kicker(X, 120, "Wyzwanie NASA: Martian Map")
    with s.step("rise"):            # tytuł (--d:1)
        s.title(X, 152, 880, 224, [
            [("Dane z pięciu", {})],
            [("instrumentów ", {}), ("NASA", {"italic": True})],
        ])
    with s.step("rise"):            # akapit (--d:2)
        s.text(X, 390, 780, 124,
               "Wyzwanie prosi o warstwową mapę z danych wielu misji NASA, która pomoże zaplanować "
               "wyjście: trasę i cele, bieżące warunki oraz naukę po drodze.",
               size=14, color=BONE2, line=1.2, name="Opis wyzwania")

    # tabela instrumentów (--d:3): pola tekstowe + cienkie linie HAIR;
    # trzy kroki po dwa wiersze, linia pod wierszem wchodzi razem z nim
    y = 530
    rows = list(enumerate(INSTRUMENTS, 1))
    for g in range(0, len(rows), 2):
        with s.step("rise"):
            if g == 0:
                s.line(X, y, X + TABLE_W, y, HAIR, 1, name="Tabela linia 0")
            for k, (inst, mission, res, use) in rows[g:g + 2]:
                h = max(NAME_PX + MISSION_PX, LINE_PX * len(res), LINE_PX * len(use)) + 2 * PAD
                top = y + PAD + 2
                s.text(X, top, COL_NAME, NAME_PX, inst, size=14, color=BONE, line=1.0, name=f"Instrument {k} nazwa")
                s.text(X, top + NAME_PX, COL_NAME, MISSION_PX, mission, size=10, color=BONE3,
                       upper=True, line=1.0, name=f"Instrument {k} misja")
                s.text(X_RES, top, COL_RES, LINE_PX * len(res), res, size=14, color=BONE2, line=1.0,
                       name=f"Instrument {k} rozdzielczość")
                s.text(X_USE, top, COL_USE, LINE_PX * len(use), use, size=14, color=BONE2, line=1.0,
                       name=f"Instrument {k} zastosowanie")
                y += h
                s.line(X, y, X + TABLE_W, y, HAIR, 1, name=f"Tabela linia {k}")

    with s.step("rise"):            # tag (--d:5)
        s.text(X, y + 16, 1130, 30,
               "Bez uczenia maszynowego: głazy wykrywamy z cieni na zdjęciach, a każda decyzja na mapie "
               "ma podane źródło i metodę.",
               size=10, color=BONE3, line=1.2, name="Podpis metody")

    with s.step("fade"):            # znaczniki Jezero i Gale: na końcu, gdy planeta dojedzie
        for name, (side, lines) in SITES.items():
            p = pose["sites"][name]
            marker(s, name, p["x"], p["y"], side, lines)

    chrome(s, 2)
    s.notes(NOTES)
    return [s]
