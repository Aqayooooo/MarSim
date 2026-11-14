"""Slajd 5 · Wizjer: jeden slajd, dwa stany. Po wejściu stan „w normie”; kliknięcie przełącza na alarm tlenu
(zdjęcie alarmu przenika przez zdjęcie normy, zmienia się wskaźnik stanu i objaśnienie stanu skafandra)."""
from contextlib import nullcontext

from common import (Slide, backdrop, chrome, _pil_font, SANS, INK, BONE, BONE2, BONE3, HAIR,
                    STEP_START, STEP_GAP)

IDX = 4
# zrzut wizjera (px sceny), jak .shot.hud w index.html
HX, HY, HW, HH = 128, 318, 1600, 662

ALT_NORM = ("Widok z hełmu w MarSim: kurs, odległość do WP2, łazik na trasie, "
            "tlen i energia w normie")
ALT_ALARM = "Ten sam widok w stanie alarmu: wizjer w barwie alarmowej, tlen 18%, energia 22%"

# objaśnienia: ułamki szerokości i wysokości zrzutu (CALLOUTS z index.html); pola box lekko przesunięte,
# bo tekst 14 pt jest prawie dwa razy większy niż 15 px w HTML
CALLOUTS = [
    dict(at=(.5, .143), box=(.64, .025), label="Kurs", text="Kurs i pas horyzontu"),
    dict(at=(.16, .385), box=(.035, .5), label="Nawigacja", text="Odległość do punktu trasy"),
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


def _callout(s, c, text, step, delay_dot=None, delay_box=None, parts=("dot", "box")):
    """Rysuje objaśnienie; zwraca listę kształtów etykiety (linia, tło, krawędź, teksty)."""
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
    box = []
    if "dot" in parts:
        with step("fade", delay=delay_dot):
            box.append(s.line(ax + (tx - ax) / d * 7, ay + (ty - ay) / d * 7, tx, ty, BONE, 1, alpha=.75,
                              name=f"{name} – linia"))
            s.ellipse(ax, ay, 7, line=BONE, line_w=1.2, name=f"{name} – kółko")
            s.ellipse(ax, ay, 2.2, fill=BONE, name=f"{name} – punkt")
    else:  # sama etykieta z linią (drugi stan): kółko już jest
        with step("fade", delay=delay_dot):
            box.append(s.line(ax + (tx - ax) / d * 7, ay + (ty - ay) / d * 7, tx, ty, BONE, 1, alpha=.75,
                              name=f"{name} – linia (alarm)"))
    with step("fade", delay=delay_box):
        box.append(s.rect(bx, by, bw, bh, fill=INK, alpha=.5, name=f"{name} – tło"))
        box.append(s.line(bx, by, bx, by + bh, BONE, 1, name=f"{name} – krawędź"))
        box.append(s.text(bx + PAD_X, by + PAD_Y, inner_w, lb_h, c["label"], size=LB_SIZE, color=BONE3, upper=True,
                          spacing=LB_SPACING, name=f"{name} – etykieta"))
        box.append(s.text(bx + PAD_X, by + PAD_Y + lb_h + LB_GAP, inner_w, tx_h, text, size=CO_SIZE, color=BONE,
                          line=CO_LINE, name=f"{name} – tekst"))
    return box


def _state(s, active, suffix=""):
    out = []
    x, y = 1040, 272
    for i, t in enumerate(["1 · W normie", "2 · Alarm tlenu"]):
        w = _spaced_width(t.upper(), ST_SIZE, ST_SPACING)
        on = i == active
        out.append(s.text(x, y, w + 8, 28, t, size=ST_SIZE, color=BONE if on else BONE3, upper=True,
                          spacing=ST_SPACING, name=f"Stan {i + 1}{suffix}"))
        if on:
            out.append(s.line(x, y + 32, x + w - ST_SPACING * 2, y + 32, BONE, 1, name=f"Stan podkreślenie{suffix}"))
        x += w + ST_GAP
    return out


def _slide(prs, mode):
    """mode="deck": jeden slajd z animacjami (norma, po kliknięciu alarm).
    mode="norm" / "alarm": statyczny podgląd jednego stanu (tylko do sprawdzania wyglądu)."""
    s = Slide(prs, {"deck": "5 · Wizjer", "norm": "5 · podgląd: norma", "alarm": "5 · podgląd: alarm"}[mode])
    backdrop(s, IDX)
    anim = mode == "deck"
    step = s.step if anim else (lambda *a, **k: nullcontext())
    alarm_only = mode == "alarm"

    with step("rise", delay=_at(0)):
        s.kicker(128, 104, "Wizjer hełmu")
    with step("rise", delay=_at(1)):
        s.title(128, 138, 900, 176, ["Wizjer: nawigacja", [("i ", {}), ("stan skafandra", {"italic": True})]],
                size=36)
    with step("rise", delay=_at(2)):
        s.text(1040, 128, 560, 126,
               "Wizjer pokazuje zawsze osobę w najgorszym stanie, bo załoga wraca razem. "
               "Te same liczby widzi konsola w habitacie.",
               size=14, color=BONE2, line=1.25, name="Opis")
    if not alarm_only:
        with step("rise", delay=_at(3)):
            st_norm = _state(s, 0)

    with step("wipe", delay=_at(1)):
        s.rect(HX, HY, HW, HH, fill="1A1A1A", name="Wizjer tło")
        if not alarm_only:
            s.image("hud.jpg", HX, HY, HW, HH, name="Wizjer norma", cover=True, alt=ALT_NORM)
    if mode != "norm":
        # po kliknięciu: zdjęcie alarmu przenika przez zdjęcie normy
        with step("fade", click=1, delay=0, dur=700):
            s.image("hud-alarm.jpg", HX, HY, HW, HH, name="Wizjer alarm", cover=True, alt=ALT_ALARM)
    with step("wipe", delay=_at(1)):
        s.rect(HX, HY, HW, HH, line=HAIR, name="Wizjer obrys")

    for c in CALLOUTS:
        if "text" in c:
            _callout(s, c, c["text"], step, _at(5), _at(6))
        elif alarm_only:
            _callout(s, c, c["alt"], step)
        else:
            box_norm = _callout(s, c, c["norm"], step, _at(5), _at(6))

    if anim:
        last = CALLOUTS[-1]
        # kliknięcie: stary wskaźnik stanu i stara etykieta znikają, nowe się pojawiają
        with step("fade", click=1, exit=True, delay=0, dur=400, shapes=st_norm + box_norm):
            pass
        with step("fade", click=1, delay=250, dur=500):
            _state(s, 1, suffix=" (alarm)")
        _callout(s, last, last["alt"], lambda *a, **k: s.step("fade", click=1, delay=250, dur=500),
                 parts=("box",))
    elif alarm_only:
        _state(s, 1)

    chrome(s, IDX)
    return s


def build(prs, mode="deck"):
    s = _slide(prs, mode)
    s.notes(
        "Mówi: Osoba 4 · ok. 1:00\n\n"
        "Tak wygląda MarSim w hełmie. Wizjer pokazuje tylko to, czego astronauta potrzebuje w tej chwili. "
        "Na górze kurs, po lewej odległość do następnego punktu trasy, a trasa jest "
        "narysowana na gruncie. Na trasie stoi łazik.\n\n"
        "Po prawej tlen i energia. Wizjer pokazuje zawsze osobę w najgorszym stanie, bo załoga wraca razem. "
        "Teraz wszystko jest w normie.\n\n"
        "[Kliknij: alarm tlenu] Gdy tlenu jest mniej niż rezerwa misji, cały wizjer zmienia barwę na alarmową, "
        "a paski pokazują, ile zostało tlenu i energii. Konsola w habitacie widzi "
        "dokładnie te same liczby."
    )
    return [s]
