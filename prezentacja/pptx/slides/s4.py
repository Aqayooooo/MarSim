"""Slajd 4 · Trasa: planer trasy według zużycia tlenu, liczby trasy A i zrzut mapy MarSim."""
from common import Slide, backdrop, chrome, BONE, BONE2, BONE3, HAIR, GRAPHITE

X = 128          # lewa kolumna
COL_W = 600      # szerokość siatki liczb (węższa niż w HTML, żeby linie nie wchodziły na brzeg Marsa)
BODY_W = 620     # szerokość akapitu
GAP_X = 40       # odstęp między kolumnami liczb
FIG_W = (COL_W - GAP_X) / 2

FIGS = [
    ("1,22", "km", "trasa A, dwa punkty EVA", "wydajność 97% wobec linii prostej"),
    ("75", "min", "czas z postojami", "przedział 62–87 min"),
    ("7,6°", "±1,5°", "największe nachylenie", "DTM HiRISE, σz 0,2 m"),
    ("92", "L O₂", "zużycie tlenu", "przedział 62–120 L"),
]

NOTES = (
    "Mówi: Osoba 3 · ok. 1:15\n\n"
    "Na tej mapie planer wyznacza trasę algorytmem A*. Kosztem jest wysiłek, liczony modelem Pandolfa "
    "przeliczonym na grawitację Marsa. Z wysiłku wynika zużycie tlenu.\n\n"
    "Zakazane są zbocza, których nachylenie z marginesem dwóch sigma przekracza 25 stopni, i piasek "
    "o prawdopodobieństwie powyżej 0,6. Głazy omijamy o 6 metrów.\n\n"
    "Trasa A w Jezero ma 1,22 kilometra i zajmuje 75 minut z dwoma postojami. Największe nachylenie to "
    "7,6 stopnia, plus minus 1,5. Zużycie tlenu szacujemy na 92 litry, w przedziale od 62 do 120. Na mapie "
    "widać też schron w zasięgu 15 minut. Funkcja Porównaj trasy pokazuje, dlaczego wybrano tę drogę "
    "zamiast linii prostej.\n\n"
    "→ Jak to wygląda z perspektywy astronauty, pokaże Osoba 4."
)


def build(prs):
    s = Slide(prs, "4 · Trasa")
    backdrop(s, 3)

    # ---------- lewa kolumna ----------
    # animacje jak --d w index.html: kicker 0, tytuł i zrzut 1, liczby 2, podpis 3, akapit 4
    # (zrzut rysowany na końcu, żeby przykrył Marsa, więc akapit, zrzut i podpis mają jawne delay=)
    with s.step("rise"):                                   # --d:0 → 150 ms
        s.kicker(X, 146, "Planer trasy · krater Jezero, sol 212", w=700)
    # tytuł jak Slide.title, ale interlinia 0,88 (w PowerPoincie to mniej więcej line-height:1 z CSS)
    with s.step("rise"):                                   # --d:1 → 320 ms
        s.text(X, 184, 700, 196, [
            [("Trasa według", {})],
            [("zużycia ", {}), ("tlenu", {"italic": True})],
        ], size=46, bold=False, line=0.88, spacing=-0.8, name="Tytuł")

    # siatka 2×2 liczb, linia HAIR nad każdą (jak .figs.rule); wiersze o wysokości najwyższej komórki
    tops = [404, 612]
    with s.step("rise"):                                   # --d:2 → 490 ms
        for i, (n, unit, label, sub) in enumerate(FIGS):
            col, row = i % 2, i // 2
            fx = X + col * (FIG_W + GAP_X)
            fy = tops[row]
            k = i + 1
            s.line(fx, fy, fx + FIG_W, fy, HAIR, 1, name=f"Liczba {k} linia")
            s.text(fx, fy + 16, FIG_W, 70, [[(n, {}), ("\u2009" + unit, {"size": 12, "color": BONE2})]],
                   size=29, color=BONE, spacing=-0.5, line=1.0, name=f"Liczba {k} wartość")
            s.text(fx, fy + 92, FIG_W, 34, label, size=12, color=BONE, line=1.15, name=f"Liczba {k} etykieta")
            s.text(fx, fy + 130, FIG_W, 56, sub, size=10, color=BONE3, line=1.15, name=f"Liczba {k} podpis")

    with s.step("rise", delay=830):                        # --d:4
        s.text(X, 796, BODY_W, 184,
               "Trasę wyznacza A* z\u00a0modelem wysiłku Pandolfa dla 0,38 g. Zakaz: nachylenie z\u00a0marginesem 2σ "
               "powyżej 25° i\u00a0piasek powyżej 0,6. Głazy omijane o\u00a06 m, schron w\u00a0zasięgu 15 minut.",
               size=14, color=BONE2, line=1.35, name="Opis algorytmu")

    # ---------- zrzut mapy (po backdrop, przykrywa Marsa) ----------
    sx, sy, sw, sh = 900, 236, 892, 594
    with s.step("wipe", delay=320):                        # --d:1, razem z tytułem
        s.rect(sx, sy, sw, sh, fill=GRAPHITE, name="Zrzut mapy tło")
        s.image("map.jpg", sx, sy, sw, sh, name="Zrzut mapy krateru Jezero", cover=True,
                alt="Mapa MarSim krateru Jezero z warstwą zagrożeń, trasą A, łazikiem, habitatem i punktami EVA")
        s.rect(sx, sy, sw, sh, line=HAIR, name="Zrzut mapy obrys")
    with s.step("rise", delay=660):                        # --d:3
        s.text(sx, 848, sw, 28,
               "Zrzut z MarSim · warstwa zagrożeń, trasa A, łazik, habitat i załoga EV1–EV2",
               size=10, color=BONE3, spacing=0.8, line=1.2, name="Podpis zrzutu mapy")

    chrome(s, 3)
    s.notes(NOTES)
    return [s]
