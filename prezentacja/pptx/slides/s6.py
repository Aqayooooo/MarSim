"""Slajd 6 · Łazik i baza: łazik ciśnieniowy i habitat w planie EVA."""
from common import (Slide, backdrop, chrome, _pil_font, STEP_START, STEP_GAP, ACCENT_HI, BONE, BONE2, BONE3, GRAPHITE, HAIR, INK, SANS)

NB = " "  # twarda spacja (&nbsp; w index.html)

SPECS = [
    ("Łazik · wzór NASA SEV", [
        ("4,5 × 3 m", " kabina"),
        ("Schron", " dla załogi na trasie"),
        ("2 śluzy", " skafandrów"),
        ("6–18 m", " wysięgnik kamery"),
    ]),
    ("Habitat", [
        ("56,5 kPa", ": krótsze przygotowanie"),
        ("4 kajuty", f" i{NB}laboratorium"),
        ("MOXIE", f" i{NB}szklarnia"),
        ("Zapas", " energii i tlenu na bieżąco"),
    ]),
]

SHOTS = [
    ("rover-boom.jpg", 760, 236, 1032, 427, "Łazik · kamera na wysięgniku",
     "Łazik ciśnieniowy na trasie, widok z kamery na wysięgniku, w tle habitat", "Zrzut łazik"),
    ("habitat-module.jpg", 760, 679, 508, 210, "Moduł dzienny",
     "Wnętrze modułu dziennego habitatu z konsolą misji", "Zrzut moduł dzienny"),
    ("greenhouse.jpg", 1284, 679, 508, 210, "Szklarnia",
     "Szklarnia habitatu z lampami wzrostowymi", "Zrzut szklarnia"),
]

SPEC_PT = 14          # rozmiar pozycji listy
SPEC_LINE = 1.0      # interlinia pozycji
SPEC_PAD = 7          # odstęp tekstu od linii nad i pod (px)


def _line_count(text, w, size):
    """Liczba wierszy tekstu w polu szerokości w (te same metryki co podgląd)."""
    f = _pil_font(SANS, False, False, size * 2)
    n, cur = 1, 0.0
    for k, word in enumerate(text.split(" ")):
        ww = f.getlength(word)
        sp = f.getlength(" ") if k and cur else 0
        if cur and cur + sp + ww > w + .5:
            n, cur = n + 1, ww
        else:
            cur += sp + ww
    return n


def _chip(s, x, y, h, label):
    """Etykieta .chip w lewym dolnym rogu zrzutu: welon INK .78 + tekst 10 pt wersalikami."""
    size, spacing = 10, 1.6
    f = _pil_font(SANS, False, False, size * 2)
    tw = sum(f.getlength(ch) + spacing * 2 for ch in label.upper())
    pad_x, pad_y, th = 12, 7, 28
    cw, ch = tw + 2 * pad_x, th + 2 * pad_y
    cx, cy = x + 16, y + h - 14 - ch
    s.rect(cx, cy, cw, ch, fill=INK, alpha=.78, name=f"Etykieta tło · {label}")
    s.text(cx + pad_x, cy + pad_y, tw + 4, th, label, size=size, color=BONE, upper=True, spacing=spacing,
           anchor="middle", name=f"Etykieta · {label}")


def build(prs):
    s = Slide(prs, "6 · Łazik i baza")
    backdrop(s, 5)

    # ---------- lewa kolumna ----------
    x0, wcol = 128, 600
    # animacje wejścia jak .rv w index.html: kicker (--d:0), tytuł (1), opis (2), specyfikacje (3)
    with s.step("rise"):
        # kicker jak Slide.kicker, ale z opisowymi nazwami kształtów
        s.line(x0, 146, x0 + 28, 146, ACCENT_HI, 1, name="Nadtytuł kreska")
        s.text(x0 + 44, 136, wcol - 44, 28, f"Łazik ciśnieniowy i{NB}habitat", size=10, color=BONE3, upper=True,
               spacing=2.2, name="Nadtytuł")
    with s.step("rise"):
        # tytuł h2 76 px; interlinia 0,92, żeby zmieścić specyfikacje nad Marsem
        s.text(x0, 174, 600, 170, [
            [(f"Łazik i{NB}habitat", {})],
            [(f"w{NB}planie ", {}), ("EVA", {"italic": True})],
        ], size=38, line=0.92, spacing=-0.8, name="Tytuł")
    with s.step("rise"):
        s.text(x0, 362, wcol, 130,
               f"Wyjście zaczyna się przy skafandrach w{NB}habitacie. Łazik może dojechać do załogi jako schron "
               f"i{NB}przekaźnik łączności.",
               size=14, color=BONE2, line=1.25, name="Opis")

    gap = 40
    cw = (wcol - gap) / 2
    top = 510
    with s.step("rise"):
        for ci, (head, items) in enumerate(SPECS):
            cx = x0 + ci * (cw + gap)
            s.text(cx, top, cw, 28, head, size=10, color=BONE3, upper=True, spacing=0.8,
                   name=f"Specyfikacja {ci + 1} nagłówek")
            y = top + 32
            s.line(cx, y, cx + cw, y, HAIR, 1, name=f"Specyfikacja {ci + 1} linia 0")
            for ii, (b, rest) in enumerate(items):
                lines = _line_count(b + rest, cw, SPEC_PT)
                th = lines * SPEC_PT * 2 * 1.2 * SPEC_LINE
                s.text(cx, y + SPEC_PAD, cw, th, [[(b, {"color": BONE}), (rest, {})]],
                       size=SPEC_PT, color=BONE2, line=SPEC_LINE, name=f"Specyfikacja {ci + 1} pozycja {ii + 1}")
                y += th + 2 * SPEC_PAD
                s.line(cx, y, cx + cw, y, HAIR, 1, name=f"Specyfikacja {ci + 1} linia {ii + 1}")

    # ---------- zrzuty ----------
    # .shot --d:1, 2, 3: każdy zrzut startuje razem z krokiem tekstu o tym samym --d
    for d, (fn, x, y, w, h, chip, alt, name) in enumerate(SHOTS, start=1):
        with s.step("wipe", delay=STEP_START + d * STEP_GAP):
            s.rect(x, y, w, h, fill=GRAPHITE, name=f"{name} tło")
            s.image(fn, x, y, w, h, cover=True, alt=alt, name=name)
            s.rect(x, y, w, h, line=HAIR, name=f"{name} obrys")
            _chip(s, x, y, h, chip)

    chrome(s, 5)
    s.notes(
        "Mówi: Osoba 4 · ok. 1:00\n\n"
        "Astronauta nie jest sam. W tym samym planie jest łazik ciśnieniowy i habitat. Łazik wzorowaliśmy na "
        "koncepcji NASA Space Exploration Vehicle: kabina 4,5 na 3 metry i dwie śluzy skafandrów "
        "z tyłu. Służy jako schron i przekaźnik łączności.\n\n"
        "Habitat ma atmosferę eksploracyjną NASA: 56,5 kilopaskala i 34 procent tlenu, co skraca przygotowanie "
        "do wyjścia. Są w nim moduł dzienny, kajuty, laboratorium, szklarnia i MOXIE, czyli wytwarzanie tlenu "
        "z dwutlenku węgla. Panel habitatu pokazuje na bieżąco zapas energii i tlenu.\n\n"
        "→ Na ile to jest gotowe do użycia, powie Osoba 1."
    )
    return [s]
