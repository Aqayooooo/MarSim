"""Slajd 1 · Okładka: tytuł po lewej, Mars po prawej (rysuje go backdrop)."""
from common import Slide, backdrop, chrome, BONE2, BONE3

NB = "\u00a0"  # twarda spacja (&nbsp; w index.html)

X = 128          # lewa krawędź tekstu, jak w HTML
KICKER_Y = 222
TITLE_Y = 266
TITLE_H = 430    # trzy linie po 58 pt
LEDE_Y = 720
LEDE_W = 660     # poszerzone z 560 px, bo lede ma 14 pt zamiast 12 pt; tarcza Marsa zaczyna się ok. x=860
LEDE_H = 222
TAG_Y = 952


def build(prs):
    s = Slide(prs, "1 · Okładka")
    backdrop(s, 0)

    # Kolejność jak .rv w index.html: kicker --d:0, tytuł --d:1, lede --d:3, tag --d:4.
    # Przerwa po tytule (brak --d:2) zachowana: start = 150 + d·170 ms.
    with s.step("rise"):                      # kicker, --d:0 → 150 ms
        s.kicker(X, KICKER_Y, "MarSim · planowanie wyjść EVA na Marsie", w=700)
    with s.step("rise"):                      # tytuł, --d:1 → 320 ms
        s.title(X, TITLE_Y, 720, TITLE_H, [
            f"Mapa i{NB}planer",
            "wyjść EVA",
            [("na ", {}), ("Marsie", {"italic": True})],
        ], size=58, name="Tytuł")
    with s.step("rise", delay=660):           # lede, --d:3
        s.text(X, LEDE_Y, LEDE_W, LEDE_H,
               f"Mapa i{NB}planer wyjść na powierzchnię Marsa. Łączy dane pięciu instrumentów orbitalnych NASA "
               f"z{NB}pogodą kosmiczną i{NB}prowadzi załogę od śluzy do celu i{NB}z{NB}powrotem.",
               size=14, color=BONE2, line=1.3, name="Wstęp")
    with s.step("rise", delay=830):           # tag, --d:4
        s.text(X, TAG_Y, 700, 28, "Teren pokazu: krater Jezero, lądowisko łazika Perseverance",
               size=10, color=BONE3, spacing=0.8, name="Teren pokazu")

    chrome(s, 0)
    s.notes(
        "Mówi: Osoba 1 · ok. 0:40\n\n"
        "Dzień dobry, jesteśmy zespołem MarSim.\n\n"
        "Pierwsza załoga, która wyjdzie przez śluzę na powierzchnię Marsa, będzie miała tylko to, co niesie: "
        "tlen, energię i czas. Pomoc z Ziemi nie przyjdzie na czas, bo sygnał leci od 3 do 22 minut w jedną stronę.\n\n"
        "MarSim to mapa i planer wyjść, który liczy to za nią: którędy iść, ile to kosztuje i kiedy najpóźniej "
        "trzeba zawrócić. Pokażemy go na prawdziwym terenie krateru Jezero, przy lądowisku łazika Perseverance.\n\n"
        "→ W jakim środowisku pracuje astronauta, opowie Osoba 2."
    )
    return [s]
