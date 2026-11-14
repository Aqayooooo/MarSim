"""Slajd 5 · Wizjer: dwa stany (norma i alarm tlenu), między nimi przejście Przekształcenie."""
from contextlib import nullcontext

from common import (Slide, backdrop, chrome, _pil_font, SANS, INK, BONE, BONE2, BONE3, HAIR,
                    STEP_START, STEP_GAP)

IDX = 4
# zrzut wizjera (px sceny), jak .shot.hud w index.html
HX, HY, HW, HH = 128, 318, 1600, 662

ALT_NORM = ("Widok z hełmu w MarSim: kurs, odległość do WP2 z przyciskami teleportu, łazik na trasie, "
            "tlen i energia w normie")
ALT_ALARM = "Ten sam widok w stanie alarmu: wizjer w barwie alarmowej, tlen 18%, energia 22%"

# objaśnienia: ułamki szerokości i wysokości zrzutu (CALLOUTS z index.html); pola box lekko przesunięte,
# bo tekst 14 pt jest prawie dwa razy większy niż 15 px w HTML
CALLOUTS = [
    dict(at=(.5, .143), box=(.64, .025), label="Kurs", text="Kurs i pas horyzontu"),
    dict(at=(.16, .385), box=(.035, .5), label="Nawigacja", text="Odległość do punktu trasy i teleport"),
    dict(at=(.57, .47), box=(.6825, .19), label="Łazik", text="Schron i przekaźnik w\u00a0zasięgu wzroku"),
    dict(at=(.55, .72), box=(.25, .79), label="Trasa", text="Bezpieczna trasa na gruncie"),
    dict(at=(.767, .686), box=(.715, .43), label="Stan skafandra",
         norm="Osoba w najgorszym stanie: tlen i energia",
         alt="Poniżej rezerwy: cały wizjer w barwie alarmowej"),
]

CO_SIZE, CO_LINE = 14, 1.15        # tekst objaśnienia
LB_SIZE, LB_SPACING = 10, 1.6      # etykieta wersalikami (letter-spacing .16em)
PAD_X, PAD_Y, LB_GAP = 16, 11, 4
CO_MAXW = 360                      # max. szerokość tekstu (px sceny)

ST_SIZE, ST_SPACING, ST_GAP = 10, 1.6, 34   # wskaźnik stanu


def _wrap(text, size_pt, maxw):
    """Zawija tekst jak podgląd (metryki Arial); zwraca listę linii i szerokość najdłuższej."""
    f = _pil_font(SANS, False, False, size_pt * 2)
    words = text.split(" ")
    lines, cur = [], ""
    for w in words:
        cand = (cur + " " + w) if cur else w
        if cur and f.getlength(cand) > maxw:
            lines.append(cur)
            cur = w
        else:
            cur = cand
    lines.append(cur)
    return lines, max(f.getlength(l) for l in lines)


def _spaced_width(text, size_pt, spacing_pt):
    f = _pil_font(SANS, False, False, size_pt * 2)
    return sum(f.getlength(ch) + spacing_pt * 2 for ch in text)


def _at(d):
    """Start kroku w ms dla wartości --d z index.html."""
    return STEP_START + d * STEP_GAP


def _callout(s, c, text, step):
    ax, ay = HX + c["at"][0] * HW, HY + c["at"][1] * HH
    bx, by = HX + c["box"][0] * HW, HY + c["box"][1] * HH
    lines, tw = _wrap(text, CO_SIZE, c.get("maxw", CO_MAXW))
    lw = _spaced_width(c["label"].upper(), LB_SIZE, LB_SPACING)
    inner_w = max(tw, lw) + 6                      # zapas, by PowerPoint nie zawinął inaczej
    lb_h = round(LB_SIZE * 2 * 1.2 * 1.15)
    tx_h = round(len(lines) * CO_SIZE * 2 * 1.2 * CO_LINE)
    bw = inner_w + 2 * PAD_X
    bh = PAD_Y + lb_h + LB_GAP + tx_h + PAD_Y
    name = f"Objaśnienie {c['label']}"

    # linia od kółka do najbliższej krawędzi etykiety (jak buildCallouts)
    tx = bx if ax < bx else (bx + bw if ax > bx + bw else ax)
    ty = by if ay < by else (by + bh if ay > by + bh else by + bh / 2)
    d = ((tx - ax) ** 2 + (ty - ay) ** 2) ** .5 or 1
    # dwa kroki o stałym starcie (--d:5): najpierw kółka z liniami, potem etykiety;
    # kolejność rysowania (warstwy) zostaje bez zmian
    with step("fade", delay=_at(5)):
        s.line(ax + (tx - ax) / d * 7, ay + (ty - ay) / d * 7, tx, ty, BONE, 1, alpha=.75,
               name=f"{name} – linia")
        s.ellipse(ax, ay, 7, line=BONE, line_w=1.2, name=f"{name} – kółko")
        s.ellipse(ax, ay, 2.2, fill=BONE, name=f"{name} – punkt")

    with step("fade", delay=_at(6)):
        s.rect(bx, by, bw, bh, fill=INK, alpha=.5, name=f"{name} – tło")
        s.line(bx, by, bx, by + bh, BONE, 1, name=f"{name} – krawędź")
        s.text(bx + PAD_X, by + PAD_Y, inner_w, lb_h, c["label"], size=LB_SIZE, color=BONE3, upper=True,
               spacing=LB_SPACING, name=f"{name} – etykieta")
        s.text(bx + PAD_X, by + PAD_Y + lb_h + LB_GAP, inner_w, tx_h, text, size=CO_SIZE, color=BONE,
               line=CO_LINE, name=f"{name} – tekst")
    return (bx, by, bw, bh)


def _state(s, active):
    x, y = 1040, 272
    for i, t in enumerate(["1 · W normie", "2 · Alarm tlenu"]):
        w = _spaced_width(t.upper(), ST_SIZE, ST_SPACING)
        on = i == active
        s.text(x, y, w + 8, 28, t, size=ST_SIZE, color=BONE if on else BONE3, upper=True,
               spacing=ST_SPACING, name=f"Stan {i + 1}")
        if on:
            s.line(x, y + 32, x + w - ST_SPACING * 2, y + 32, BONE, 1, name="Stan podkreślenie")
        x += w + ST_GAP


def _state_slide(prs, label, active, img, alt, animate):
    """animate=False (5b): bez kroków, treść widoczna od razu, bo stan wchodzi Przekształceniem z 5a."""
    s = Slide(prs, label)
    backdrop(s, IDX)
    step = s.step if animate else (lambda *a, **k: nullcontext())

    with step("rise", delay=_at(0)):
        s.kicker(128, 104, "Wizjer hełmu")
    with step("rise", delay=_at(1)):
        s.title(128, 138, 900, 176, ["Wizjer: nawigacja", [("i ", {}), ("stan skafandra", {"italic": True})]],
                size=36)
    with step("rise", delay=_at(2)):
        s.text(1040, 128, 560, 126,
               "Dane skafandra liczy serwer misji. Wizjer pokazuje zawsze osobę w najgorszym stanie, "
               "bo załoga wraca razem.",
               size=14, color=BONE2, line=1.25, name="Opis")
    with step("rise", delay=_at(3)):
        _state(s, active)

    with step("wipe", delay=_at(1)):
        s.rect(HX, HY, HW, HH, fill="1A1A1A", name="Wizjer tło")
        s.image(img, HX, HY, HW, HH, name="!!Wizjer", cover=True, alt=alt)
        s.rect(HX, HY, HW, HH, line=HAIR, name="Wizjer obrys")

    for c in CALLOUTS:
        _callout(s, c, c.get("text") or (c["norm"] if active == 0 else c["alt"]), step)

    chrome(s, IDX)
    return s


def build(prs):
    a = _state_slide(prs, "5a · Wizjer w normie", 0, "hud.jpg", ALT_NORM, animate=True)
    a.notes(
        "Mówi: Osoba 4 · ok. 1:00\n\n"
        "Tak wygląda MarSim w hełmie. Wizjer pokazuje tylko to, czego astronauta potrzebuje w tej chwili. "
        "Na górze kurs, po lewej odległość do następnego punktu trasy i przyciski teleportu, a trasa jest "
        "narysowana na gruncie. Na trasie stoi łazik.\n\n"
        "Po prawej tlen i energia. Wizjer pokazuje zawsze osobę w najgorszym stanie, bo załoga wraca razem. "
        "Teraz wszystko jest w normie."
    )
    b = _state_slide(prs, "5b · Wizjer alarm", 1, "hud-alarm.jpg", ALT_ALARM, animate=False)
    b.notes(
        "Mówi: Osoba 4 · stan 2 po kliknięciu (alarm tlenu)\n\n"
        "Gdy tlenu jest mniej niż rezerwa misji, cały wizjer zmienia barwę na alarmową, a paski pokazują, "
        "ile zostało tlenu i energii. Wszystko to liczy serwer misji, więc wizjer pokazuje te same liczby "
        "co konsola w habitacie."
    )
    return [a, b]
