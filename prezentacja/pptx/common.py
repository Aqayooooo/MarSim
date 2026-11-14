"""Wspólne narzędzia do budowy prezentacji MarSim w PowerPoincie.

Współrzędne podaje się w pikselach sceny 1920×1080 (tak jak w index.html), rozmiary krojów w punktach.
Slajd PowerPointa to 13,333 × 7,5 cala, więc 1 px sceny = 1/144 cala, a 1 pt = 2 px sceny.

Każde wywołanie rysuje element w .pptx i jednocześnie w podglądzie PNG (PIL), bo w tym środowisku
nie ma LibreOffice. Podgląd zawija tekst metrykami Liberation Sans/Mono (te same szerokości co Arial
i Courier New) i zgłasza tekst, który nie mieści się w swoim polu.
"""
import contextlib
import copy
import json
from pathlib import Path

from lxml import etree
from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Pt

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / "assets"
RENDER = HERE / "render"
PREVIEW = HERE / "preview"
W, H = 1920, 1080
EMU_PX = 6350  # 914400 / 144

# ---------- paleta (z index.html) ----------
INK = "050505"        # tło
GRAPHITE = "1A1A1A"   # tło pod zrzutami
BONE = "F2F0EC"       # tekst główny
BONE2 = "C0BEBA"      # --bone-2 na czarnym (74%)
BONE3 = "8A8987"      # --bone-3 na czarnym (56%)
HAIR = "2A2928"       # --hair: cienkie linie (14%)
ACCENT = "303F86"
ACCENT_HI = "8F9BE0"

SANS = "Arial"        # w index.html Inter; Arial jest w każdym Office i ma metrycznego odpowiednika do podglądu
MONO = "Courier New"  # tylko menu slajdów, jak JetBrains Mono w index.html

NAV = ["Okładka", "Środowisko", "Dane", "Trasa", "Wizjer", "Łazik i baza", "Wdrożenie"]
TOPIC = ["Otwarcie", "Środowisko", "Dane NASA", "Planer trasy", "Wizjer hełmu", "Łazik i habitat", "Wdrożenie"]

_FONTS = {
    (SANS, False, False): "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    (SANS, True, False): "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    (SANS, False, True): "/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf",
    (SANS, True, True): "/usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf",
    (MONO, False, False): "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
    (MONO, True, False): "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
    (MONO, False, True): "/usr/share/fonts/truetype/liberation/LiberationMono-Italic.ttf",
    (MONO, True, True): "/usr/share/fonts/truetype/liberation/LiberationMono-BoldItalic.ttf",
}
_font_cache = {}


def E(px):
    return Emu(int(round(px * EMU_PX)))


def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _pil_font(face, bold, italic, size_px):
    key = (face, bold, italic, round(size_px * 4))
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(_FONTS[(face, bold, italic)], max(1, int(round(size_px))))
    return _font_cache[key]


def _alpha_el(alpha):
    el = etree.SubElement(etree.Element("dummy"), qn("a:alpha"))
    el.set("val", str(int(round(alpha * 100000))))
    return el


def _set_fill(shape, color, alpha=1.0):
    shape.fill.solid()
    shape.fill.fore_color.rgb = RGBColor.from_string(color)
    if alpha < 1:
        shape.fill._xPr.find(qn("a:solidFill"))[0].append(_alpha_el(alpha))


def _set_line(line, color, width_px, alpha=1.0):
    if color is None:
        line.fill.background()
        return
    line.color.rgb = RGBColor.from_string(color)
    line.width = E(width_px)
    if alpha < 1:
        line._ln.find(qn("a:solidFill"))[0].append(_alpha_el(alpha))


class Slide:
    """Jeden slajd: element w .pptx + ten sam element w podglądzie PNG."""

    def __init__(self, prs, label):
        self.label = label
        self.sl = prs.slides.add_slide(prs.slide_layouts[6])  # pusty układ
        bg = self.sl.background.fill
        bg.solid()
        bg.fore_color.rgb = RGBColor.from_string(INK)
        self.img = Image.new("RGBA", (W, H), hex_rgb(INK) + (255,))
        self.warnings = []
        self._n = 0
        self._step = None   # bieżący krok animacji (with s.step(...))
        self._steps = []    # [{'effect', 'delay', 'dur', 'ids': [...]}]

    # ---------- podgląd ----------
    def _blend(self, layer):
        self.img = Image.alpha_composite(self.img, layer)

    # ---------- animacje wejścia ----------
    @contextlib.contextmanager
    def step(self, effect="rise", delay=None, dur=None, click=0, exit=False, shapes=()):
        """Wszystko, co narysujesz wewnątrz `with s.step(...)`, wejdzie razem jako jeden krok animacji.

        Kroki startują same po wejściu na slajd, jeden po drugim (co STEP_GAP ms), jak .rv w index.html.
        effect: "rise" (zanikanie + lekki ruch w górę, tekst), "wipe" (odsłanianie z góry, zrzuty),
                "fade" (samo zanikanie: linie, kółka, drobne elementy).
        delay: własny start kroku w ms (od wejścia na slajd albo od kliknięcia).
        click: 0 = start sam po wejściu na slajd; 1, 2… = start po 1., 2.… kliknięciu.
        exit:  True = kształty znikają (tylko "fade") zamiast się pojawiać.
        shapes: kształty narysowane wcześniej, które też należą do tego kroku (np. do zniknięcia).
        """
        assert self._step is None, "kroki animacji nie mogą być zagnieżdżone"
        assert not exit or effect == "fade", "znikanie obsługuje tylko efekt fade"
        self._step = dict(effect=effect, delay=delay, dur=dur, click=click, exit=exit,
                          ids=[sh.shape_id for sh in shapes])
        try:
            yield self
        finally:
            if self._step["ids"]:
                self._steps.append(self._step)
            self._step = None

    def _track(self, shape):
        if self._step is not None:
            self._step["ids"].append(shape.shape_id)
        return shape

    def apply_animations(self):
        """Zapisuje kroki jako oś czasu PowerPointa (<p:timing>). Wywołuje build.py/preview.py."""
        if self._steps:
            apply_timing(self.sl, self._steps)

    def _name(self, name, kind):
        self._n += 1
        return name or f"{kind} {self._n}"

    # ---------- tekst ----------
    def text(self, x, y, w, h, content, size=14, color=BONE, font=SANS, bold=False, italic=False,
             align="left", spacing=0, line=1.15, upper=False, anchor="top", name=None, para_after=0):
        """Pole tekstowe bez wewnętrznych marginesów.

        content: str albo lista akapitów; akapit to str albo lista przebiegów (tekst, {opcje}).
        Opcje przebiegu: italic, bold, color, size, font, sub (indeks dolny).
        "\n" w str dzieli akapity. spacing = odstęp liter w pt (jak letter-spacing).
        """
        paras = _normalize(content)
        if upper:
            paras = [[(t.upper(), o) for t, o in p] for p in paras]
        tb = self.sl.shapes.add_textbox(E(x), E(y), E(w), E(h))
        tb.name = self._name(name, "Tekst")
        tf = tb.text_frame
        tf.word_wrap = True
        tf.auto_size = MSO_AUTO_SIZE.NONE
        tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
        tf.vertical_anchor = {"top": MSO_ANCHOR.TOP, "middle": MSO_ANCHOR.MIDDLE, "bottom": MSO_ANCHOR.BOTTOM}[anchor]
        for pi, runs in enumerate(paras):
            p = tf.paragraphs[0] if pi == 0 else tf.add_paragraph()
            p.alignment = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}[align]
            p.line_spacing = line
            if para_after:
                p.space_after = Pt(para_after)
            for t, o in runs:
                r = p.add_run()
                r.text = t
                f = r.font
                f.name = o.get("font", font)
                f.size = Pt(o.get("size", size))
                f.bold = o.get("bold", bold)
                f.italic = o.get("italic", italic)
                f.color.rgb = RGBColor.from_string(o.get("color", color))
                rPr = r._r.get_or_add_rPr()
                if spacing:
                    rPr.set("spc", str(int(round(spacing * 100))))
                if o.get("sub"):
                    rPr.set("baseline", "-25000")
        self._preview_text(x, y, w, h, paras, size, color, font, bold, italic, align, spacing, line, anchor, para_after, tb.name)
        return self._track(tb)

    def _preview_text(self, x, y, w, h, paras, size, color, font, bold, italic, align, spacing, line, anchor, para_after, name):
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        lines = []  # (lista fragmentów [(tekst, font, kolor, szer)], wysokość linii)
        overflow_w = False
        for runs in paras:
            words = []  # słowa z informacją o przebiegu
            for t, o in runs:
                fsize = o.get("size", size) * 2
                f = _pil_font(o.get("font", font), o.get("bold", bold), o.get("italic", italic), fsize * (.62 if o.get("sub") else 1))
                col = o.get("color", color)
                for k, part in enumerate(t.replace(" ", "\u0001").split(" ")):
                    words.append((part.replace("\u0001", " "), f, col, fsize, k > 0))
            cur, cur_w, max_fs = [], 0.0, size * 2
            for word, f, col, fsize, space_before in words:
                sp = (f.getlength(" ") + spacing * 2) if (space_before and cur) else 0
                ww = f.getlength(word) + spacing * 2 * len(word)
                if cur and cur_w + sp + ww > w + .5:
                    lines.append((cur, max_fs))
                    cur, cur_w, max_fs, sp = [], 0.0, fsize, 0
                if ww > w + .5:
                    overflow_w = True
                cur.append((sp, word, f, col, ww))
                cur_w += sp + ww
                max_fs = max(max_fs, fsize)
            lines.append((cur, max_fs))
            if para_after:
                lines.append(([], para_after * 2 / line / 1.2))
        heights = [fs * 1.2 * line for _, fs in lines]
        total = sum(heights)
        ty = y if anchor == "top" else (y + (h - total) / 2 if anchor == "middle" else y + h - total)
        for (frags, fs), lh in zip(lines, heights):
            lw = sum(sp + ww for sp, _, _, _, ww in frags)
            tx = x if align == "left" else (x + (w - lw) / 2 if align == "center" else x + w - lw)
            base = ty + lh * .8
            for sp, word, f, col, ww in frags:
                tx += sp
                if spacing:
                    for ch in word:
                        d.text((tx, base), ch, font=f, fill=hex_rgb(col) + (255,), anchor="ls")
                        tx += f.getlength(ch) + spacing * 2
                else:
                    d.text((tx, base), word, font=f, fill=hex_rgb(col) + (255,), anchor="ls")
                    tx += ww
            ty += lh
        self._blend(layer)
        if total > h + 2 or overflow_w:
            why = "słowo szersze niż pole" if overflow_w else f"tekst ma {total:.0f} px wysokości, pole {h} px"
            self.warnings.append(f"PRZEPEŁNIENIE „{name}”: {why}")
            dd = ImageDraw.Draw(self.img)
            dd.rectangle([x, y, x + w, y + h], outline=(255, 60, 60, 255), width=2)
        if x < 0 or y < 0 or x + w > W or y + h > H:
            self.warnings.append(f"POZA SLAJDEM „{name}”: {x},{y} {w}×{h}")

    # ---------- obrazy ----------
    def image(self, path, x, y, w, h, name=None, cover=True, alpha=1.0, alt=""):
        """Obraz w prostokącie. cover=True przycina jak object-fit: cover."""
        path = Path(path)
        if not path.is_absolute():
            path = HERE / path if (HERE / path).exists() else ASSETS / path
        pic = self.sl.shapes.add_picture(str(path), E(x), E(y), E(w), E(h))
        pic.name = self._name(name, "Obraz")
        if alt:
            pic._element.nvPicPr.cNvPr.set("descr", alt)
        src = Image.open(path).convert("RGBA")
        if cover:
            sr, br = src.width / src.height, w / h
            if sr > br:
                c = (1 - br / sr) / 2
                pic.crop_left = pic.crop_right = c
                cw = src.width * (1 - 2 * c)
                src = src.crop((int(src.width * c), 0, int(src.width * c + cw), src.height))
            elif sr < br:
                c = (1 - sr / br) / 2
                pic.crop_top = pic.crop_bottom = c
                ch = src.height * (1 - 2 * c)
                src = src.crop((0, int(src.height * c), src.width, int(src.height * c + ch)))
        if alpha < 1:
            blip = pic._element.find(".//" + qn("a:blip"))
            am = etree.SubElement(blip, qn("a:alphaModFix"))
            am.set("amt", str(int(alpha * 100000)))
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        im = src.resize((max(1, int(round(w))), max(1, int(round(h)))), Image.LANCZOS)
        if alpha < 1:
            a = im.getchannel("A").point(lambda v: int(v * alpha))
            im.putalpha(a)
        layer.paste(im, (int(round(x)), int(round(y))), im)
        self._blend(layer)
        return self._track(pic)

    # ---------- kształty ----------
    def rect(self, x, y, w, h, fill=None, alpha=1.0, line=None, line_w=1, line_alpha=1.0, name=None):
        sh = self.sl.shapes.add_shape(MSO_SHAPE.RECTANGLE, E(x), E(y), E(w), E(h))
        sh.name = self._name(name, "Prostokąt")
        sh.shadow.inherit = False
        if fill:
            _set_fill(sh, fill, alpha)
        else:
            sh.fill.background()
        _set_line(sh.line, line, line_w, line_alpha)
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        d.rectangle([x, y, x + w, y + h], fill=(hex_rgb(fill) + (int(alpha * 255),)) if fill else None,
                    outline=(hex_rgb(line) + (int(line_alpha * 255),)) if line else None, width=max(1, int(line_w)))
        self._blend(layer)
        return self._track(sh)

    def ellipse(self, cx, cy, r, fill=None, alpha=1.0, line=None, line_w=1, line_alpha=1.0, name=None):
        sh = self.sl.shapes.add_shape(MSO_SHAPE.OVAL, E(cx - r), E(cy - r), E(2 * r), E(2 * r))
        sh.name = self._name(name, "Elipsa")
        sh.shadow.inherit = False
        if fill:
            _set_fill(sh, fill, alpha)
        else:
            sh.fill.background()
        _set_line(sh.line, line, line_w, line_alpha)
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(hex_rgb(fill) + (int(alpha * 255),)) if fill else None,
                  outline=(hex_rgb(line) + (int(line_alpha * 255),)) if line else None, width=max(1, int(round(line_w))))
        self._blend(layer)
        return self._track(sh)

    def line(self, x1, y1, x2, y2, color=BONE, width=1, alpha=1.0, name=None):
        ln = self.sl.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, E(x1), E(y1), E(x2), E(y2))
        ln.name = self._name(name, "Linia")
        _set_line(ln.line, color, width, alpha)
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(layer).line([x1, y1, x2, y2], fill=hex_rgb(color) + (int(alpha * 255),), width=max(1, int(round(width))))
        self._blend(layer)
        return self._track(ln)

    def notes(self, text):
        """Notatki prowadzącego (widok prezentera). Akapity oddziel pustą linią."""
        self.sl.notes_slide.notes_text_frame.text = text

    # ---------- elementy wspólne ----------
    def kicker(self, x, y, text, w=900):
        """Mały nagłówek nad tytułem: krótka linia w kolorze akcentu + tekst wersalikami."""
        self.line(x, y + 10, x + 28, y + 10, ACCENT_HI, 1, name=None)
        self.text(x + 44, y, w - 44, 28, text, size=10, color=BONE3, upper=True, spacing=2.2)

    def title(self, x, y, w, h, content, size=46, name="Tytuł"):
        """Tytuł slajdu (h1/h2). Część pisaną kursywą podaj jako przebieg (tekst, {'italic': True})."""
        return self.text(x, y, w, h, content, size=size, bold=False, line=1.0, spacing=-0.8, name=name)

    def save_preview(self, path):
        PREVIEW.mkdir(exist_ok=True)
        self.img.convert("RGB").save(path, quality=90)


def _normalize(content):
    if isinstance(content, str):
        return [[(p, {})] for p in content.split("\n")]
    paras = []
    for p in content:
        if isinstance(p, str):
            paras.append([(p, {})])
        else:
            paras.append([(t, dict(o)) for t, o in p])
    return paras


# ---------- scena wspólna dla wszystkich slajdów ----------
POSES = json.loads((RENDER / "poses.json").read_text()) if (RENDER / "poses.json").exists() else None


def backdrop(s, idx):
    """Siatka, poświata, orbita i Mars dla slajdu idx (0–6). Rysuj przed treścią.

    Nazwy z prefiksem !! pozwalają przejściu Przekształcenie (Morph) dopasować Marsa między slajdami."""
    for gx in (128, 683, 1237, 1792):
        s.line(gx, 0, gx, H, BONE, 1, alpha=.06, name=f"Siatka {gx}")
    p = POSES[idx]
    if p["glow"]:
        g = p["glow"]
        s.image(RENDER / Path(g["file"]).name, g["x"], g["y"], g["w"], g["h"], name="!!Poświata", cover=False)
    if p["ring"]:
        r = p["ring"]
        s.ellipse(r["cx"], r["cy"], r["r"], line=BONE, line_w=1, line_alpha=r["alpha"], name="!!Orbita")
    m = p["mars"]
    s.image(RENDER / Path(m["file"]).name, m["x"], m["y"], m["w"], m["h"], name="!!Mars", cover=False,
            alt="Mars, model planety")
    return p


def chrome(s, idx, count=7):
    """Górny pasek (znak MarSim, menu slajdów, licznik) i dolny pasek z tematem slajdu. Rysuj na końcu."""
    s.text(128, 42, 160, 44, [[("MarSim", {"italic": True, "bold": True})]], size=15, name="Znak")
    s.text(258, 52, 220, 26, "Martian Map", size=9, color=BONE3, upper=True, spacing=2.4, name="Znak podpis")
    # menu: pozycje jak w index.html (Courier New 8,5 pt, odstęp liter 0,2 em)
    x = 640
    for i, n in enumerate(NAV):
        f = _pil_font(MONO, False, False, 17)
        wpx = sum(f.getlength(ch) + 3.4 for ch in n.upper())
        s.text(x, 52, wpx + 6, 24, n, size=8.5, font=MONO, upper=True, spacing=1.7,
               color=BONE if i == idx else BONE3, name=f"Menu {i + 1}")
        if i == idx:
            s.line(x, 76, x + wpx - 3.4, 76, BONE, 1, name="Menu podkreślenie")
        x += wpx + 30
    s.text(1640, 44, 152, 40, [[(f"{idx + 1:02d}", {}), (f" / {count:02d}", {"size": 8, "color": BONE3})]],
           size=13, align="right", name="Licznik")
    label = f"{idx + 1:02d} · {TOPIC[idx]}"
    if idx == 5:  # na slajdzie 6 stopka leży na jasnym Marsie: ciemne tło pod tekstem
        f = _pil_font(SANS, False, False, 18)
        tw = sum(f.getlength(ch) + 3.6 for ch in label.upper())
        s.rect(116, 1014, tw + 24, 36, fill=INK, alpha=.82, name="Stopka tło")
    s.text(128, 1020, 700, 28, label, size=9, color=BONE3 if idx != 5 else BONE2, upper=True, spacing=1.8,
           name="Stopka")


def new_presentation():
    prs = Presentation()
    prs.slide_width = E(W)
    prs.slide_height = E(H)
    import datetime
    cp = prs.core_properties
    now = datetime.datetime.now().replace(microsecond=0)
    cp.title, cp.subject, cp.comments, cp.author, cp.last_modified_by = "Prezentacja MarSim", "", "", "", ""
    cp.created = cp.modified = now
    return prs


MORPH = (
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
    '<mc:Choice xmlns:p159="http://schemas.microsoft.com/office/powerpoint/2015/09/main" Requires="p159">'
    '<p:transition xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" spd="slow" '
    'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" p14:dur="1600">'
    '<p159:morph option="byObject"/></p:transition></mc:Choice>'
    '<mc:Fallback><p:transition xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" spd="slow">'
    '<p:fade/></p:transition></mc:Fallback></mc:AlternateContent>'
)


def add_morph(slide):
    """Przejście Przekształcenie (Morph) na wejściu slajdu; starszy PowerPoint pokaże zanikanie."""
    el = etree.fromstring(MORPH)
    sld = slide._element
    anchor = sld.find(qn("p:timing"))
    if anchor is None:
        anchor = sld.find(qn("p:extLst"))
    if anchor is not None:
        anchor.addprevious(el)
    else:
        sld.append(el)


# ---------- animacje wejścia: <p:timing> ----------
STEP_START = 150   # ms od wejścia na slajd do pierwszego kroku
STEP_GAP = 170     # ms między kolejnymi krokami
DUR = {"rise": 900, "wipe": 1200, "fade": 600}
PRESET = {"rise": ("42", "0"), "wipe": ("22", "1"), "fade": ("10", "0")}  # Unoszenie, Wymazywanie z góry, Zanikanie
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"


def _effect_xml(ids, st, spid, grp, start, node):
    dur = st["dur"] or DUR[st["effect"]]
    tgt = f'<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl>'
    vis = lambda val, delay: (f'<p:set><p:cBhvr><p:cTn id="{next(ids)}" dur="1" fill="hold"><p:stCondLst><p:cond delay="{delay}"/></p:stCondLst></p:cTn>'
                              f'{tgt}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>'
                              f'<p:to><p:strVal val="{val}"/></p:to></p:set>')
    if st["exit"]:
        beh = (f'<p:animEffect transition="out" filter="fade"><p:cBhvr><p:cTn id="{next(ids)}" dur="{dur}"/>{tgt}</p:cBhvr></p:animEffect>'
               + vis("hidden", dur - 1))
        preset, sub, cls = "10", "0", "exit"
    else:
        beh = vis("visible", 0)
        flt = "wipe(down)" if st["effect"] == "wipe" else "fade"
        beh += f'<p:animEffect transition="in" filter="{flt}"><p:cBhvr><p:cTn id="{next(ids)}" dur="{dur}"/>{tgt}</p:cBhvr></p:animEffect>'
        if st["effect"] == "rise":
            for attr, a, b in (("ppt_x", "#ppt_x", "#ppt_x"), ("ppt_y", "#ppt_y+0.028", "#ppt_y")):
                beh += (f'<p:anim calcmode="lin" valueType="num"><p:cBhvr><p:cTn id="{next(ids)}" dur="{dur}" decel="100000" fill="hold"/>'
                        f'{tgt}<p:attrNameLst><p:attrName>{attr}</p:attrName></p:attrNameLst></p:cBhvr>'
                        f'<p:tavLst><p:tav tm="0"><p:val><p:strVal val="{a}"/></p:val></p:tav>'
                        f'<p:tav tm="100000"><p:val><p:strVal val="{b}"/></p:val></p:tav></p:tavLst></p:anim>')
        preset, sub = PRESET[st["effect"]]
        cls = "entr"
    return (f'<p:par><p:cTn id="{next(ids)}" presetID="{preset}" presetClass="{cls}" presetSubtype="{sub}" '
            f'fill="hold" grpId="{grp}" nodeType="{node}"><p:stCondLst><p:cond delay="{start}"/></p:stCondLst>'
            f'<p:childTnLst>{beh}</p:childTnLst></p:cTn></p:par>')


def apply_timing(slide, steps):
    """Oś czasu: grupa 0 startuje sama z wejściem na slajd, grupy 1, 2… po kolejnych kliknięciach."""
    ids = iter(range(3, 100_000))
    groups = {}
    for st in steps:
        groups.setdefault(st["click"], []).append(st)
    grp_count, built = {}, []          # grpId: kolejna animacja tego samego kształtu dostaje następny numer
    pars = []
    for click in sorted(groups):
        effects = []
        for k, st in enumerate(groups[click]):
            base = STEP_START if click == 0 else 0
            start = st["delay"] if st["delay"] is not None else base + k * STEP_GAP
            for spid in st["ids"]:
                grp = grp_count.get(spid, 0)
                grp_count[spid] = grp + 1
                built.append((spid, grp))
                node = "clickEffect" if (click > 0 and not effects) else "withEffect"
                effects.append(_effect_xml(ids, st, spid, grp, start, node))
        cond = ('<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>'
                if click == 0 else '<p:cond delay="indefinite"/>')
        pars.append(f'<p:par><p:cTn id="X" fill="hold"><p:stCondLst>{cond}</p:stCondLst><p:childTnLst>'
                    f'<p:par><p:cTn id="X" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst>'
                    f'<p:childTnLst>{"".join(effects)}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>')
    xml = (f'<p:timing xmlns:p="{P_NS}"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'
           f'<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>'
           f'{"".join(pars)}'
           f'</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>'
           f'<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>'
           f'</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>')
    el = etree.fromstring(xml)
    # numery cTn muszą rosnąć w kolejności dokumentu: przenumeruj od nowa
    for n, ctn in enumerate(el.iter(qn("p:cTn")), start=1):
        ctn.set("id", str(n))
    # bldLst: wpisy dla kształtów p:sp (pola tekstowe i figury), po jednym na każdą animację
    sp_ids = {int(sp.find(".//" + qn("p:cNvPr")).get("id")) for sp in slide.shapes._spTree.iter(qn("p:sp"))}
    bld = [(i, g) for i, g in dict.fromkeys(built) if i in sp_ids]
    if bld:
        bl = etree.SubElement(el, qn("p:bldLst"))
        for i, g in bld:
            b_ = etree.SubElement(bl, qn("p:bldP"))
            b_.set("spid", str(i))
            b_.set("grpId", str(g))
    sld = slide._element
    old = sld.find(qn("p:timing"))
    if old is not None:
        sld.remove(old)
    ext = sld.find(qn("p:extLst"))
    if ext is not None:
        ext.addprevious(el)
    else:
        sld.append(el)
