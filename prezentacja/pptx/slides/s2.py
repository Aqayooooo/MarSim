"""Slajd 2 · Środowisko: skład atmosfery i warunki pracy na Marsie (prawa połowa sceny, Mars w lewym dolnym rogu)."""
from common import Slide, backdrop, chrome, BONE, BONE2, BONE3, HAIR, ACCENT_HI, SANS, _pil_font

X, WID = 940, 852          # kolumna treści jak w index.html (prawa krawędź 1792 = licznik w górnym pasku)

ATM = [  # (udział jak flex w HTML, kolor, krycie, nazwa)
    (95.1, BONE, .86, "CO2"),
    (2.6, BONE, .5, "N2"),
    (1.9, BONE, .3, "Ar"),
    (.16, ACCENT_HI, 1.0, "O2"),
    (.24, BONE, .18, "CO i inne"),
]

LEGEND = [  # przebiegi jednej pozycji legendy; O₂ w kolorze akcentu
    [("CO", {}), ("2", {"sub": True}), (" 95,1%", {})],
    [("N", {}), ("2", {"sub": True}), (" 2,6%", {})],
    [("Ar 1,9%", {})],
    [("O", {"color": ACCENT_HI}), ("2", {"sub": True, "color": ACCENT_HI}), (" 0,16%", {"color": ACCENT_HI})],
    [("CO i inne 0,2%", {})],
]

FIGS = [  # (liczba, jednostka, etykieta, podpis)
    ("0,6", "kPa", "ciśnienie przy powierzchni", "ok. 0,6% ziemskiego"),
    ("−60", "°C", "średnia temperatura", "nocą w Gale zwykle <\u00a0−70\u00a0°C"),
    ("0,38", "g", "grawitacja", "3,71 m/s² · inny chód i wysiłek"),
    ("0,64", "mSv", "dawka promieniowania na sol", "pomiar RAD, łazik Curiosity"),
    ("3–22", "min", "opóźnienie sygnału z Ziemi", "w jedną stronę"),
    ("24:39", "h", "długość sola", "zegar misji w czasie marsjańskim"),
]

NOTES = """Mówi: Osoba 2 · ok. 1:05

Atmosfera Marsa to w 95 procentach dwutlenek węgla. Tlenu jest 0,16 procent. Ciśnienie przy powierzchni wynosi około 0,6 kilopaskala, mniej niż jeden procent ziemskiego. Bez skafandra człowiek traci przytomność w kilkanaście sekund.

Średnia temperatura to około minus 60 stopni. Grawitacja 0,38 g zmienia chód i wysiłek, a więc i zużycie tlenu. Dawka promieniowania na powierzchni to około 0,64 milisiwerta na sol, a burza słoneczna może ją gwałtownie podnieść.

Do tego opóźnienie łączności. Decyzja o powrocie musi zapaść na miejscu, w hełmie. Na dole slajdu widać te same wielkości w panelu MarSim, przeliczone dla bieżącego sola i godziny.

→ Teraz o tym, skąd bierzemy dane o terenie."""


def _run_width(runs, size, spacing=0.0):
    """Szerokość przebiegów w px sceny (tak jak liczy podgląd: indeks dolny w 62% rozmiaru)."""
    total = 0.0
    for t, o in runs:
        f = _pil_font(SANS, False, False, size * 2 * (.62 if o.get("sub") else 1))
        total += f.getlength(t) + spacing * 2 * len(t)
    return total


def _bar(s, y, h=12, gap=2, min_w=2):
    free = WID - gap * (len(ATM) - 1)
    total = sum(a[0] for a in ATM)
    widths = [max(min_w, free * a[0] / total) for a in ATM]
    widths[0] -= sum(widths) - free          # nadwyżkę z min. szerokości oddaje największy odcinek
    x = X
    for (_, color, alpha, label), w in zip(ATM, widths):
        s.rect(x, y, w, h, fill=color, alpha=alpha, name=f"Atmosfera {label}")
        x += w + gap


def _legend(s, y, size=10, spacing=.6, gap=34):
    x = X
    for i, runs in enumerate(LEGEND):
        w = _run_width(runs, size, spacing) + 4
        s.text(x, y, w, 26, [runs], size=size, color=BONE2, spacing=spacing, name=f"Legenda {i + 1}")
        x += w + gap


def _lines(text, size, w, spacing=0.0):
    """Liczba wierszy po zawinięciu (te same metryki i reguła co podgląd)."""
    f = _pil_font(SANS, False, False, size * 2)
    n, cur = 1, 0.0
    for word in text.split(" "):
        ww = f.getlength(word) + spacing * 2 * len(word)
        sp = f.getlength(" ") + spacing * 2 if cur else 0
        if cur and cur + sp + ww > w + .5:
            n, cur = n + 1, ww
        else:
            cur += sp + ww
    return n


def _figs(s, y0, cols=3, col_gap=34, row_gap=30):
    """Siatka liczb: linia HAIR, liczba z jednostką, etykieta, podpis (podpis zaraz pod etykietą, jak w HTML)."""
    cw = (WID - col_gap * (cols - 1)) / cols
    L_SIZE, L_LINE, S_SIZE, S_LINE, S_SP = 11.5, 1.05, 10, 1.08, .2
    l_lh, s_lh = L_SIZE * 2 * 1.2 * L_LINE, S_SIZE * 2 * 1.2 * S_LINE
    y = y0
    for r in range(0, len(FIGS), cols):
        row = FIGS[r:r + cols]
        bottoms = []
        with s.step("rise"):                 # każdy rząd liczb to osobny krok: siatka wjeżdża falą
            for c, (n, unit, label, sub) in enumerate(row):
                i = r + c
                x = X + c * (cw + col_gap)
                s.line(x, y, x + cw, y, HAIR, 1, name=f"Liczba {i + 1} linia")
                s.text(x, y + 14, cw, 64, [[(n, {}), (" " + unit, {"size": 12, "color": BONE2})]],
                       size=29, line=.9, spacing=-.7, name=f"Liczba {i + 1}")
                lh = _lines(label, L_SIZE, cw) * l_lh
                s.text(x, y + 86, cw, lh + 2, label, size=L_SIZE, line=L_LINE, name=f"Liczba {i + 1} etykieta")
                sy = y + 86 + lh + 6
                sh = _lines(sub, S_SIZE, cw, S_SP) * s_lh
                s.text(x, sy, cw, sh + 2, sub, size=S_SIZE, color=BONE3, line=S_LINE, spacing=S_SP,
                       name=f"Liczba {i + 1} podpis")
                bottoms.append(sy + sh)
        y = max(bottoms) + row_gap
    return y


def build(prs):
    s = Slide(prs, "2 · Środowisko")
    backdrop(s, 1)

    with s.step("rise"):                     # kicker (--d:0)
        s.kicker(X, 132, "Środowisko pracy astronauty", w=WID)
    with s.step("rise"):                     # tytuł (--d:1)
        s.title(X, 170, WID, 226, ["Warunki pracy", [("na ", {}), ("Marsie", {"italic": True})]], size=46)

    with s.step("rise"):                     # blok atmosfery: podpis, pasek, legenda (--d:2)
        s.text(X, 414, WID, 26, "Skład atmosfery przy powierzchni · spektrometr SAM, łazik Curiosity",
               size=10, color=BONE3, spacing=.8, name="Atmosfera podpis")
        _bar(s, 450)
        _legend(s, 476)

    end = _figs(s, 534)                      # siatka liczb (--d:3): dwa kroki, górny i dolny rząd

    with s.step("rise"):                     # tag z odczytem panelu (--d:5)
        s.text(X, end + 4, WID, 26, "Panel MarSim, sol 212, 10:11: grunt −43 °C · wiatr 7,2 m/s · pył 0,50 · 27 µSv/h",
               size=10, color=BONE3, spacing=.3, name="Panel MarSim odczyt")

    chrome(s, 1)
    s.notes(NOTES)
    return [s]
