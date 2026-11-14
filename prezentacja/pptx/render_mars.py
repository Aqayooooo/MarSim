"""Renderuje Marsa dla każdego slajdu jako przezroczysty PNG (te same kompozycje co POSES w index.html).

Wynik: render/mars-N.png, render/glow-N.png oraz render/poses.json z położeniem obrazów
i znaczników Jezero/Gale w pikselach sceny 1920×1080.
Uruchom: python render_mars.py   (wymaga numpy i Pillow)
"""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / "assets"
OUT = HERE / "render"
OUT.mkdir(exist_ok=True)
SS = 1.5  # nadpróbkowanie względem pikseli sceny

POSES = [
    dict(x=1272, y=560, r=410, tilt=.12, roll=-.30, sun=[-.85, .35, .55], disc=dict(x=1440, y=404, r=318, a=1), ring=dict(x=1272, y=560, r=508, a=.22), mk=0, atmo=1),
    dict(x=330, y=930, r=560, tilt=.25, roll=.18, sun=[.8, .5, .35], disc=dict(x=196, y=420, r=214, a=1), ring=dict(x=330, y=930, r=660, a=.16), mk=0, atmo=1),
    dict(x=1400, y=548, r=330, tilt=.14, roll=0, lon=113, sun=[-.45, .4, .8], disc=dict(x=1400, y=548, r=330, a=0), ring=dict(x=1400, y=548, r=414, a=.34), mk=1, atmo=1),
    dict(x=1346, y=533, r=600, tilt=.322, roll=0, lon=77.45, sun=[-.3, .55, -.78], disc=dict(x=1346, y=533, r=400, a=0), ring=dict(x=1346, y=533, r=700, a=0), mk=0, atmo=1.6, lum=.8),
    dict(x=1716, y=200, r=60, tilt=.1, roll=-.2, sun=[-.7, .4, .6], disc=dict(x=1716, y=200, r=40, a=0), ring=dict(x=1716, y=200, r=86, a=.4), mk=0, atmo=1),
    dict(x=420, y=1290, r=430, tilt=.3, roll=.1, sun=[.15, .95, .25], disc=dict(x=420, y=1290, r=300, a=0), ring=dict(x=420, y=1290, r=500, a=.18), mk=0, atmo=1.2),
    dict(x=600, y=584, r=392, tilt=.1, roll=.26, sun=[.86, .3, .45], disc=dict(x=402, y=424, r=300, a=1), ring=dict(x=600, y=584, r=500, a=.2), mk=0, atmo=1),
]
SITES = {"Jezero": (18.4447, 77.4508), "Gale": (-4.6735, 137.3762)}
DEG = math.pi / 180


def rx(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def ry(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rz(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def spin_for(i, p):
    if "lon" in p:
        return -(90 + p["lon"]) * DEG
    return -(90 + 40) * DEG + i * 0.55  # w HTML planeta obraca się stale; tu każdy slajd ma inny kąt


tex = np.asarray(Image.open(ASSETS / "mars.jpg").convert("RGB"), dtype=np.float32) / 255.0
relief = np.asarray(Image.open(ASSETS / "mars-relief.jpg").convert("L"), dtype=np.float32) / 255.0
TH, TW = tex.shape[:2]
lin = tex ** 2.2  # do przestrzeni liniowej


def render(i, p):
    R = p["r"]
    size = int(math.ceil(2 * R * 1.06 * SS))  # zapas na poświatę atmosfery
    c = size / 2
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float32)
    sx = (xs + .5 - c) / (R * SS)
    sy = -(ys + .5 - c) / (R * SS)
    d2 = sx * sx + sy * sy
    inside = d2 <= 1.0
    sz = np.sqrt(np.clip(1 - d2, 0, 1))
    view = np.stack([sx, sy, sz], -1)  # normalna w układzie świata (kamera patrzy wzdłuż -z)

    M = rz(p["roll"]) @ rx(p["tilt"])  # Euler 'ZYX' z y = 0
    P = M @ ry(spin_for(i, p))
    local = view @ P  # = P^T · v dla każdego piksela
    lat = np.arcsin(np.clip(local[..., 1], -1, 1))
    lon = np.arctan2(-local[..., 2], local[..., 0])
    u = ((lon / (2 * math.pi) + .5) * TW).astype(int) % TW
    v = np.clip(((.5 - lat / math.pi) * TH).astype(int), 0, TH - 1)
    albedo = lin[v, u]
    bump = relief[v, u]

    sun = np.array(p["sun"], dtype=np.float32)
    sun /= np.linalg.norm(sun)
    ndl = np.clip(view @ sun, 0, 1)
    rim_dir = np.array([-sun[0], -sun[1] * .4, -.85], dtype=np.float32)
    rim_dir /= np.linalg.norm(rim_dir)
    rim = np.clip(view @ rim_dir, 0, 1)
    lum = p.get("lum", 1.0)
    shade = (ndl ** .9) * 1.55 * (0.88 + 0.24 * bump)
    color = albedo * shade[..., None] * np.array([1.0, .95, .89]) * lum
    color += albedo * rim[..., None] * .22 * np.array([.38, .44, .78])
    color += albedo * .03 * np.array([.16, .19, .38])

    # poświata atmosfery: krawędź tarczy, w stronę słońca ciepła, w cieniu chłodna
    f = (1 - np.clip(sz, 0, 1)) ** 3.2
    lit = np.clip((view @ sun + .2) / .75, 0, 1)
    lit = lit * lit * (3 - 2 * lit)
    atm_col = np.array([.98, .64, .44]) * lit[..., None] + np.array([.30, .36, .72]) * (1 - lit[..., None]) * .42
    color += atm_col * (f * p["atmo"] * .85)[..., None]

    rgb = np.clip(color, 0, 1) ** (1 / 2.2)
    # wygładzona krawędź tarczy + cienka zewnętrzna poświata
    dist = np.sqrt(d2)
    edge = np.clip((1.0 - dist) * R * SS + .5, 0, 1)
    halo = np.clip(1 - (dist - 1) / .05, 0, 1) ** 2 * (dist > 1) * .45 * p["atmo"]
    halo_col = np.array([.98, .70, .52]) * np.clip(lit, .25, 1)[..., None]
    out_rgb = np.where(inside[..., None], rgb, np.clip(halo_col, 0, 1))
    alpha = np.where(inside, edge, halo * .6)
    img = np.dstack([out_rgb, alpha]).astype(np.float32)
    Image.fromarray((img * 255).astype(np.uint8), "RGBA").save(OUT / f"mars-{i + 1}.png", optimize=True)
    return size / SS


def glow(i, d):
    """Miękka poświata za planetą (#disc w index.html): radialny gradient, rozmyty."""
    R = d["r"]
    ext = R * 1.25
    size = int(math.ceil(2 * ext * .5))  # gradient jest gładki, połowa rozdzielczości wystarczy
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float32)
    t = np.sqrt((xs + .5 - size / 2) ** 2 + (ys + .5 - size / 2) ** 2) / (R * .5)
    stops = [(0, .42), (.30, .20), (.55, .07), (.72, 0)]
    a = np.interp(t, [s[0] for s in stops], [s[1] for s in stops])
    rgba = np.zeros((size, size, 4), np.float32)
    rgba[..., :3] = np.array([242, 240, 236]) / 255
    rgba[..., 3] = a * d["a"]
    Image.fromarray((rgba * 255).astype(np.uint8), "RGBA").save(OUT / f"glow-{i + 1}.png", optimize=True)
    return ext


def site_screen(p, i, lat, lon):
    d = np.array([math.cos(lat * DEG) * math.cos(lon * DEG), math.sin(lat * DEG), -math.cos(lat * DEG) * math.sin(lon * DEG)])
    M = rz(p["roll"]) @ rx(p["tilt"])
    w = M @ ry(spin_for(i, p)) @ d
    facing = float(w[2])
    return dict(x=round(p["x"] + w[0] * p["r"], 1), y=round(p["y"] - w[1] * p["r"], 1), facing=round(facing, 3))


meta = []
for i, p in enumerate(POSES):
    half = render(i, p)
    gext = glow(i, p["disc"]) if p["disc"]["a"] > 0 else None
    meta.append(dict(
        slide=i + 1,
        mars=dict(file=f"render/mars-{i + 1}.png", x=p["x"] - half / 2 * 1, y=p["y"] - half / 2, w=half, h=half,
                  cx=p["x"], cy=p["y"], r=p["r"]),
        glow=None if gext is None else dict(file=f"render/glow-{i + 1}.png", x=p["disc"]["x"] - gext, y=p["disc"]["y"] - gext, w=2 * gext, h=2 * gext),
        ring=None if p["ring"]["a"] <= 0 else dict(cx=p["ring"]["x"], cy=p["ring"]["y"], r=p["ring"]["r"], alpha=p["ring"]["a"]),
        sites={k: site_screen(p, i, *v) for k, v in SITES.items()} if p["mk"] else {},
    ))
    print(f"slajd {i + 1}: Mars r={p['r']} px")
(OUT / "poses.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False))
