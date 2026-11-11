// Wnętrze habitatu w 3D: wyłożenie modułu, śluzy i szklarni, przesuwane drzwi, meble, rośliny, lampy i ekrany
// (kanwy odświeżane z danych misji). Układ i wymiary z core/habitat.js; dodawane do grupy modelu habitatu.
import * as THREE from 'three';
import { AIRLOCK, DOOR, FLOOR, FURNITURE, GREEN, HULL, WINDOW as WIN } from '../core/habitat.js';
import { mulberry } from '../core/rocks.js';

const rectPath = (x0, y0, x1, y1) => { const p = new THREE.Path(); p.moveTo(x0, y0); p.lineTo(x0, y1); p.lineTo(x1, y1); p.lineTo(x1, y0); p.closePath(); return p; };

function gratingTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#4a4f55'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#2b2f33';
  for (let k = 0; k < 128; k += 16) { g.fillRect(k, 0, 3, 128); g.fillRect(0, k, 128, 3); }
  g.fillStyle = '#5c6268'; g.fillRect(0, 62, 128, 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function panelTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#d8d4cc'; g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#b3aea5'; g.lineWidth = 2;
  for (let x = 0; x <= 256; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke(); }
  g.beginPath(); g.moveTo(0, 64); g.lineTo(256, 64); g.stroke();
  g.fillStyle = '#9d988f';
  for (let x = 6; x < 256; x += 64) for (const y of [6, 58, 70, 122]) { g.fillRect(x, y, 3, 3); g.fillRect(x + 52, y, 3, 3); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Ekran: kanwa jako tekstura świecąca (bez mgły i cieni). draw(g, w, h) rysuje zawartość. */
export class Screen {
  constructor(w = 512, h = 300, width = 1, height = 0.6) {
    this.canvas = document.createElement('canvas'); this.canvas.width = w; this.canvas.height = h;
    this.g = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: this.tex, fog: false, toneMapped: false }));
    this.mesh.userData.screen = true;
  }
  draw(fn) { fn(this.g, this.canvas.width, this.canvas.height); this.tex.needsUpdate = true; }
}

/** Buduje wnętrze; zwraca grupę i uchwyty do drzwi, lamp, ekranów i roślin. */
export function buildInterior() {
  const group = new THREE.Group();
  group.name = 'habitat-interior';
  const grating = gratingTexture(), panels = panelTexture();
  const M = {
    wall: new THREE.MeshStandardMaterial({ color: 0xffffff, map: panels, roughness: 0.75, side: THREE.BackSide }),
    wallF: new THREE.MeshStandardMaterial({ color: 0xffffff, map: panels, roughness: 0.75 }),
    floor: new THREE.MeshStandardMaterial({ color: 0xffffff, map: grating, roughness: 0.6, metalness: 0.4 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x7d838a, roughness: 0.4, metalness: 0.6 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x24282c, roughness: 0.7, metalness: 0.3 }),
    fabric: new THREE.MeshStandardMaterial({ color: 0x3d5873, roughness: 0.95 }),
    pillow: new THREE.MeshStandardMaterial({ color: 0xd9d4c8, roughness: 1 }),
    suit: new THREE.MeshStandardMaterial({ color: 0xece8e0, roughness: 0.65 }),
    visor: new THREE.MeshStandardMaterial({ color: 0xc9a040, roughness: 0.1, metalness: 0.9 }),
    accent: new THREE.MeshStandardMaterial({ color: 0xf17778, roughness: 0.5 }),
    soil: new THREE.MeshStandardMaterial({ color: 0x3b2a1e, roughness: 1 }),
    leaf: new THREE.MeshStandardMaterial({ color: 0x4f9a3c, roughness: 0.8 }),
    tomato: new THREE.MeshStandardMaterial({ color: 0xd8432c, roughness: 0.5 }),
    door: new THREE.MeshStandardMaterial({ color: 0xb9b4aa, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide }),
    strip: new THREE.MeshStandardMaterial({ color: 0xfff3dc, emissive: 0xfff0d8, emissiveIntensity: 1.4 }),
    grow: new THREE.MeshStandardMaterial({ color: 0xff8ce8, emissive: 0xff5ad8, emissiveIntensity: 1.6 }),
    status: new THREE.MeshStandardMaterial({ color: 0x40ff80, emissive: 0x40ff80, emissiveIntensity: 2 }),
  };
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = group) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); parent.add(o); return o; };
  const { cy, x0, x1, lining: R } = HULL;

  // ---------- moduł główny: wyłożenie (z otworami na przejście do szklarni i okno), podłoga, grodzie ----------
  const tube = (a, b, gap) => {
    const len = b - a, geo = gap
      ? new THREE.CylinderGeometry(R, R, len, 40, 1, true, gap[1], Math.PI * 2 - (gap[1] - gap[0]))
      : new THREE.CylinderGeometry(R, R, len, 40, 1, true);
    geo.rotateZ(-Math.PI / 2);   // kąt 0 = +z, π/2 = dół, π = −z
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 6, uv.getY(i) * len / 2);
    add(geo, M.wall, (a + b) / 2, cy, 0);
  };
  const G = GREEN;
  tube(x0, G.hatch.x0); tube(G.hatch.x0, G.hatch.x1, [-0.3, 1.2]); tube(G.hatch.x1, WIN.x0); tube(WIN.x0, WIN.x1, [Math.PI - 0.32, Math.PI + 0.2]); tube(WIN.x1, x1);
  const floorW = 2 * Math.sqrt(R * R - (cy - FLOOR) ** 2);
  const floorGeo = new THREE.PlaneGeometry(x1 - x0, floorW); floorGeo.rotateX(-Math.PI / 2);
  grating.repeat.set(1, 1);
  const fuv = floorGeo.attributes.uv; for (let i = 0; i < fuv.count; i++) fuv.setXY(i, fuv.getX(i) * (x1 - x0) / 1.2, fuv.getY(i) * floorW / 1.2);
  add(floorGeo, M.floor, (x0 + x1) / 2, FLOOR, 0);
  add(new THREE.CircleGeometry(R, 40), M.wallF, x0, cy, 0, 0, Math.PI / 2, 0);   // gródź tylna (przodem do +x)
  const bulk = new THREE.Shape(); bulk.absarc(0, 0, R, 0, Math.PI * 2, false);
  bulk.holes.push(rectPath(-DOOR.half, FLOOR - cy, DOOR.half, DOOR.top - cy));
  const bulkGeo = new THREE.ShapeGeometry(bulk, 40); bulkGeo.rotateY(-Math.PI / 2);   // przodem do −x (do wnętrza modułu)
  add(bulkGeo, M.wallF, x1, cy, 0);
  // lampy sufitowe i listwy
  for (const x of [-3, -0.5, 2]) add(new THREE.BoxGeometry(1.6, 0.05, 0.22), M.strip, x, cy + R - 0.06, 0);
  for (const z of [-1, 1]) add(new THREE.BoxGeometry(x1 - x0, 0.06, 0.06), M.accent, (x0 + x1) / 2, FLOOR + 0.03, z * (floorW / 2 - 0.03));
  // okno: rama od środka
  const wc = (WIN.x0 + WIN.x1) / 2, ww = WIN.x1 - WIN.x0;
  for (const y of [cy + 0.43, cy - 0.68]) add(new THREE.BoxGeometry(ww + 0.06, 0.08, 0.18), M.metal, wc, y, -R + 0.05);
  for (const x of [WIN.x0, WIN.x1]) add(new THREE.BoxGeometry(0.08, 1.15, 0.18), M.metal, x, cy - 0.12, -R + 0.08);

  // ---------- meble ----------
  const F = Object.fromEntries(FURNITURE.map((f) => [f.id, f]));
  const box = (f, y0, y1, mat, inset = 0) => add(new THREE.BoxGeometry(f.x1 - f.x0 - inset, y1 - y0, f.z1 - f.z0 - inset), mat, (f.x0 + f.x1) / 2, (y0 + y1) / 2, (f.z0 + f.z1) / 2);
  for (const f of [F.bunkS, F.bunkN]) {   // koje piętrowe
    for (const y of [FLOOR + 0.35, FLOOR + 1.45]) {
      box({ ...f, z0: f.z0 + 0.05, z1: f.z1 - 0.05 }, y - 0.08, y, M.metal);
      box({ ...f, x0: f.x0 + 0.05, x1: f.x1 - 0.05, z0: f.z0 + 0.1, z1: f.z1 - 0.1 }, y, y + 0.14, M.fabric);
      add(new THREE.BoxGeometry(0.4, 0.1, 0.4), M.pillow, f.x0 + 0.3, y + 0.19, (f.z0 + f.z1) / 2);
    }
    for (const x of [f.x0 + 0.04, f.x1 - 0.04]) add(new THREE.BoxGeometry(0.06, 1.6, 0.06), M.metal, x, FLOOR + 0.8, f.z0 < 0 ? f.z1 - 0.06 : f.z0 + 0.06);
  }
  // podtrzymywanie życia: szafa z panelami i ekranem
  box(F.life, FLOOR, FLOOR + 2.0, M.dark);
  for (let k = 0; k < 4; k++) add(new THREE.BoxGeometry(0.7, 0.02, 0.02), M.metal, (F.life.x0 + F.life.x1) / 2, FLOOR + 0.25 + k * 0.12, F.life.z1 + 0.01);
  // konsola misji pod oknem
  box({ ...F.console, z1: F.console.z1 }, FLOOR + 0.72, FLOOR + 0.78, M.metal);
  box({ ...F.console, z0: F.console.z0, z1: F.console.z0 + 0.2 }, FLOOR, FLOOR + 0.72, M.dark);
  add(new THREE.CylinderGeometry(0.2, 0.22, 0.08, 16), M.fabric, 1.45, FLOOR + 0.48, -0.75);   // krzesło
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.44, 8), M.metal, 1.45, FLOOR + 0.22, -0.75);
  // kuchnia: blat, szafki, podgrzewacz
  box(F.galley, FLOOR, FLOOR + 0.9, M.wallF, 0.02);
  box({ ...F.galley, z0: F.galley.z0 - 0.03 }, FLOOR + 0.9, FLOOR + 0.94, M.metal);
  add(new THREE.BoxGeometry(0.5, 0.3, 0.35), M.dark, F.galley.x0 + 0.4, FLOOR + 1.1, 1.3);
  box({ ...F.galley, z0: 1.3 }, FLOOR + 1.55, FLOOR + 2.05, M.wallF, 0.02);
  // skafandry na ścianie przy śluzie
  box({ ...F.suits, z0: F.suits.z1 - 0.12 }, FLOOR + 0.2, FLOOR + 2.1, M.metal);
  for (const x of [F.suits.x0 + 0.38, F.suits.x1 - 0.38]) {
    const z = F.suits.z1 - 0.32;
    add(new THREE.BoxGeometry(0.5, 0.7, 0.32), M.suit, x, FLOOR + 1.35, z);                       // tułów
    add(new THREE.SphereGeometry(0.17, 16, 12), M.suit, x, FLOOR + 1.88, z);                        // hełm
    add(new THREE.SphereGeometry(0.12, 12, 8, 0, Math.PI), M.visor, x, FLOOR + 1.88, z - 0.08, 0, Math.PI, 0);
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(0.15, 0.6, 0.15), M.suit, x + s * 0.32, FLOOR + 1.3, z);            // ręce
      add(new THREE.BoxGeometry(0.17, 0.75, 0.18), M.suit, x + s * 0.13, FLOOR + 0.6, z);           // nogi
    }
    add(new THREE.BoxGeometry(0.42, 0.06, 0.02), M.accent, x, FLOOR + 1.55, z - 0.17);
  }

  // ---------- przejście i szklarnia ----------
  const H = G.hatch, hw = H.x1 - H.x0, hh = H.top - FLOOR;
  const pz0 = 1.3, pz1 = G.z0, pl = pz1 - pz0;
  for (const [x, ry] of [[H.x0, Math.PI / 2], [H.x1, -Math.PI / 2]]) add(new THREE.PlaneGeometry(pl, hh), M.wallF, x, FLOOR + hh / 2, (pz0 + pz1) / 2, 0, ry, 0);
  add(new THREE.PlaneGeometry(hw, pl), M.wallF, (H.x0 + H.x1) / 2, H.top, (pz0 + pz1) / 2, Math.PI / 2, 0, 0);
  add(new THREE.PlaneGeometry(hw, pl), M.floor, (H.x0 + H.x1) / 2, FLOOR + 0.002, (pz0 + pz1) / 2, -Math.PI / 2, 0, 0);
  const gl = G.z1 - G.z0, gw = 2 * Math.sqrt(G.lining ** 2 - (G.cy - FLOOR) ** 2);
  const gt = new THREE.CylinderGeometry(G.lining, G.lining, gl, 32, 1, true); gt.rotateX(Math.PI / 2);
  add(gt, M.wall, G.x, G.cy, (G.z0 + G.z1) / 2);
  add(new THREE.CircleGeometry(G.lining, 32), M.wallF, G.x, G.cy, G.z1, 0, Math.PI, 0);
  const gfront = new THREE.Shape(); gfront.absarc(0, 0, G.lining, 0, Math.PI * 2, false);
  gfront.holes.push(rectPath(H.x0 - G.x, FLOOR - G.cy, H.x1 - G.x, H.top - G.cy));
  add(new THREE.ShapeGeometry(gfront, 32), M.wallF, G.x, G.cy, G.z0);
  add(new THREE.PlaneGeometry(gw, gl), M.floor, G.x, FLOOR, (G.z0 + G.z1) / 2, -Math.PI / 2, 0, 0);
  // grządki hydroponiczne po obu stronach i rośliny
  const plants = [];
  const leafGeo = new THREE.IcosahedronGeometry(1, 0), fruitGeo = new THREE.SphereGeometry(1, 8, 6);
  const rnd = mulberry(42);
  for (const side of [-1, 1]) {
    const px = G.x + side * (gw / 2 - 0.33);
    add(new THREE.BoxGeometry(0.6, 0.55, gl - 0.5), M.wallF, px, FLOOR + 0.28, (G.z0 + G.z1) / 2);
    add(new THREE.BoxGeometry(0.54, 0.04, gl - 0.56), M.soil, px, FLOOR + 0.56, (G.z0 + G.z1) / 2);
    add(new THREE.BoxGeometry(0.6, 0.04, gl - 0.5), M.metal, px, FLOOR + 1.35, (G.z0 + G.z1) / 2);    // półka górna
    add(new THREE.BoxGeometry(0.54, 0.04, gl - 0.56), M.soil, px, FLOOR + 1.39, (G.z0 + G.z1) / 2);
    add(new THREE.BoxGeometry(0.08, 0.03, gl - 0.6), M.grow, px, G.cy + 1.15, (G.z0 + G.z1) / 2);
    for (const shelf of [FLOOR + 0.58, FLOOR + 1.41]) {
      for (let z = G.z0 + 0.45; z < G.z1 - 0.3; z += 0.42) {
        const p = new THREE.Group();
        p.position.set(px + (rnd() - 0.5) * 0.15, shelf, z + (rnd() - 0.5) * 0.1);
        const s = 0.13 + rnd() * 0.07;
        for (let k = 0; k < 3; k++) add(leafGeo, M.leaf, (rnd() - 0.5) * 0.12, s * (0.6 + k * 0.5), (rnd() - 0.5) * 0.12, rnd(), rnd() * 6, 0, p).scale.setScalar(s * (1 - k * 0.2));
        if (rnd() < 0.45) add(fruitGeo, M.tomato, (rnd() - 0.5) * 0.15, s * 0.9, 0.08, 0, 0, 0, p).scale.setScalar(0.035);
        group.add(p);
        plants.push(p);
      }
    }
  }

  // ---------- śluza: ściany z otworami na drzwi, ławka, panel ----------
  const A = AIRLOCK.in, aw = A.x1 - A.x0, ah = A.top - FLOOR;
  const end = (x, ry) => {
    const s = new THREE.Shape(); s.moveTo(-A.z, 0); s.lineTo(A.z, 0); s.lineTo(A.z, ah); s.lineTo(-A.z, ah); s.closePath();
    s.holes.push(rectPath(-DOOR.half, 0, DOOR.half, DOOR.top - FLOOR));
    const geo = new THREE.ShapeGeometry(s); geo.rotateY(ry);
    add(geo, M.wallF, x, FLOOR, 0);
  };
  end(A.x0, Math.PI / 2); end(A.x1, -Math.PI / 2);
  add(new THREE.PlaneGeometry(aw, 2 * A.z), M.floor, (A.x0 + A.x1) / 2, FLOOR, 0, -Math.PI / 2, 0, 0);
  add(new THREE.PlaneGeometry(aw, 2 * A.z), M.wallF, (A.x0 + A.x1) / 2, A.top, 0, Math.PI / 2, 0, 0);
  for (const s of [-1, 1]) add(new THREE.PlaneGeometry(aw, ah), M.wallF, (A.x0 + A.x1) / 2, FLOOR + ah / 2, s * A.z, 0, s < 0 ? 0 : Math.PI, 0);
  add(new THREE.BoxGeometry(1.3, 0.08, 0.4), M.metal, 6.0, FLOOR + 0.45, A.z - 0.22);   // ławka
  add(new THREE.BoxGeometry(1.3, 0.45, 0.06), M.dark, 6.0, FLOOR + 0.22, A.z - 0.05);
  const airLamp = add(new THREE.BoxGeometry(0.9, 0.05, 0.12), M.status.clone(), (A.x0 + A.x1) / 2, A.top - 0.03, 0);
  const outLamp = add(new THREE.BoxGeometry(0.06, 0.12, 0.5), M.status.clone(), AIRLOCK.x1 + 0.06, DOOR.top + 0.25, 0);
  // drzwi przesuwne (wewnętrzne między grodzią a ścianą śluzy, zewnętrzne w ścianie czołowej)
  const doorGeo = new THREE.BoxGeometry(0.03, DOOR.top - FLOOR, 2 * DOOR.half + 0.06);
  const inner = add(doorGeo, M.door, (HULL.x1 + A.x0) / 2, (FLOOR + DOOR.top) / 2, 0);
  const outer = add(doorGeo, M.door, (A.x1 + AIRLOCK.x1) / 2, (FLOOR + DOOR.top) / 2, 0);
  for (const d of [inner, outer]) add(new THREE.BoxGeometry(0.05, 0.6, 0.06), M.accent, 0, 0, -DOOR.half + 0.12, 0, 0, 0, d);   // uchwyt
  // ościeżnice zakrywają szczeliny, w których chowają się drzwi
  for (const [a, b] of [[HULL.x1, A.x0], [A.x1, AIRLOCK.x1]]) {
    const cx = (a + b) / 2, d = b - a + 0.02;
    add(new THREE.BoxGeometry(d, 0.06, 2 * DOOR.half + 0.12), M.metal, cx, DOOR.top + 0.03, 0);
    add(new THREE.BoxGeometry(d, DOOR.top - FLOOR, 0.06), M.metal, cx, (FLOOR + DOOR.top) / 2, DOOR.half + 0.03);
    add(new THREE.BoxGeometry(d, 0.02, 2 * DOOR.half), M.floor, cx, FLOOR - 0.005, 0);
  }

  // ---------- ekrany ----------
  const screens = {
    console: new Screen(640, 360, 1.15, 0.65),
    life: new Screen(400, 400, 0.62, 0.62),
    airlock: new Screen(400, 260, 0.5, 0.32),
    hatch: new Screen(400, 260, 0.42, 0.27),
    outer: new Screen(400, 260, 0.5, 0.32),
    green: new Screen(400, 260, 0.6, 0.39),
    lights: new Screen(200, 200, 0.18, 0.18),
  };
  const place = (s, x, y, z, ry, rx = 0) => { s.mesh.position.set(x, y, z); s.mesh.rotation.set(rx, ry, 0, 'YXZ'); group.add(s.mesh); };
  place(screens.console, 1.45, FLOOR + 1.18, -1.38, 0, -0.12);
  add(new THREE.BoxGeometry(1.25, 0.75, 0.04), M.dark, 1.45, FLOOR + 1.18, -1.415, -0.12, 0, 0);
  place(screens.life, (F.life.x0 + F.life.x1) / 2, FLOOR + 1.35, F.life.z1 + 0.012, 0);
  place(screens.airlock, 5.9, FLOOR + 1.45, -A.z + 0.012, 0);
  place(screens.hatch, HULL.x1 - 0.012, FLOOR + 1.45, -0.95, -Math.PI / 2);
  place(screens.lights, HULL.x1 - 0.012, FLOOR + 1.3, 0.95, -Math.PI / 2);
  place(screens.outer, AIRLOCK.x1 + 0.012, FLOOR + 1.45, -0.95, Math.PI / 2);
  place(screens.green, G.x, FLOOR + 1.45, G.z1 - 0.05, Math.PI);

  // ---------- światła ----------
  const lamps = [-3, -0.5, 2].map((x) => { const l = new THREE.PointLight(0xfff0dc, 0, 7.5, 1.6); l.position.set(x, cy + R - 0.35, 0); group.add(l); return l; });
  const airLight = new THREE.PointLight(0x60ff90, 0, 4.5, 1.6); airLight.position.set(5.9, A.top - 0.25, 0); group.add(airLight);
  const growLight = new THREE.PointLight(0xff70e0, 0, 6, 1.6); growLight.position.set(G.x, G.cy + 1.0, (G.z0 + G.z1) / 2); group.add(growLight);

  group.traverse((o) => { if (o.isMesh && !o.userData.screen && !o.material.emissive?.getHex()) o.receiveShadow = true; });   // skorupa zasłania słońce
  return { group, doors: { inner, outer }, lamps, airLight, growLight, airLamp, outLamp, strips: M.strip, grow: M.grow, screens, plants };
}
