// Wnętrze bazy w 3D: moduł dzienny, śluza, hala z węzłem (mesa) i korytarzem sypialni (4 kajuty, łazienka, siłownia),
// laboratorium z punktem medycznym i szklarnia. Ściany, drzwi, meble, rośliny, lampy i ekrany (kanwy z danymi misji).
// Wnętrze ma własną scenę i własne światła (ui/habitatView.js) — słońce nie przenika przez cienkie ściany.
import * as THREE from 'three';
import { AIRLOCK, CEIL, CORRIDOR, DOOR, FLOOR, FURNITURE, GREEN, HALL, HULL, LAB, OPENINGS, ROOMS, WINDOWS } from '../core/habitat.js';
import { mulberry } from '../core/rocks.js';
import { circlePath, placeShape, rectPath, wallShape } from './habitatShapes.js';

function canvasTexture(size, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = size[0]; c.height = size[1];
  draw(c.getContext('2d'), size[0], size[1]);
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
const grating = () => canvasTexture([128, 128], (g) => {
  g.fillStyle = '#4a4f55'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#2b2f33';
  for (let k = 0; k < 128; k += 16) { g.fillRect(k, 0, 3, 128); g.fillRect(0, k, 128, 3); }
});
const vinyl = () => canvasTexture([128, 128], (g) => {
  g.fillStyle = '#8a8478'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#77716a'; g.lineWidth = 2; g.strokeRect(1, 1, 126, 62); g.strokeRect(1, 65, 126, 62);
});
const panels = () => canvasTexture([256, 128], (g) => {
  g.fillStyle = '#d8d4cc'; g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#b3aea5'; g.lineWidth = 2;
  for (let x = 0; x <= 256; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke(); }
  g.beginPath(); g.moveTo(0, 64); g.lineTo(256, 64); g.stroke();
  g.fillStyle = '#9d988f';
  for (let x = 6; x < 256; x += 64) for (const y of [6, 58, 70, 122]) { g.fillRect(x, y, 3, 3); g.fillRect(x + 52, y, 3, 3); }
});

/** Ekran: kanwa jako tekstura świecąca (bez mgły i cieni). */
export class Screen {
  constructor(w = 512, h = 300, width = 1, height = 0.6) {
    this.canvas = document.createElement('canvas'); this.canvas.width = w; this.canvas.height = h;
    this.g = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: this.tex, fog: false, toneMapped: false }));
  }
  draw(fn) { fn(this.g, this.canvas.width, this.canvas.height); this.tex.needsUpdate = true; }
}

const CREW_COLORS = [0x3d5873, 0x7a3d3d, 0x3d6b4a, 0x6b5a2e];

export function buildInterior() {
  const group = new THREE.Group();
  group.name = 'habitat-interior';
  const wallTex = panels();
  const M = {
    wall: new THREE.MeshStandardMaterial({ color: 0xffffff, map: wallTex, roughness: 0.75, side: THREE.BackSide }),
    wallF: new THREE.MeshStandardMaterial({ color: 0xffffff, map: wallTex, roughness: 0.75 }),
    wall2: new THREE.MeshStandardMaterial({ color: 0xffffff, map: wallTex, roughness: 0.75, side: THREE.DoubleSide }),
    plain: new THREE.MeshStandardMaterial({ color: 0xe4e0d8, roughness: 0.8 }),
    ceil: new THREE.MeshStandardMaterial({ color: 0xcfcac1, roughness: 0.9 }),
    floor: new THREE.MeshStandardMaterial({ color: 0xffffff, map: grating(), roughness: 0.6, metalness: 0.4 }),
    vinyl: new THREE.MeshStandardMaterial({ color: 0xffffff, map: vinyl(), roughness: 0.7 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x7d838a, roughness: 0.4, metalness: 0.6 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x24282c, roughness: 0.7, metalness: 0.3 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x8b6b4a, roughness: 0.7 }),
    pillow: new THREE.MeshStandardMaterial({ color: 0xd9d4c8, roughness: 1 }),
    suit: new THREE.MeshStandardMaterial({ color: 0xece8e0, roughness: 0.65 }),
    visor: new THREE.MeshStandardMaterial({ color: 0xc9a040, roughness: 0.1, metalness: 0.9 }),
    accent: new THREE.MeshStandardMaterial({ color: 0xf17778, roughness: 0.5 }),
    soil: new THREE.MeshStandardMaterial({ color: 0x3b2a1e, roughness: 1 }),
    leaf: new THREE.MeshStandardMaterial({ color: 0x4f9a3c, roughness: 0.8 }),
    tomato: new THREE.MeshStandardMaterial({ color: 0xd8432c, roughness: 0.5 }),
    door: new THREE.MeshStandardMaterial({ color: 0xb9b4aa, roughness: 0.5, metalness: 0.3 }),
    glass: new THREE.MeshStandardMaterial({ color: 0xbfe3ee, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.25, depthWrite: false }),
    blind: new THREE.MeshStandardMaterial({ color: 0x55606a, roughness: 0.9 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x151719, roughness: 0.95 }),
    white: new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.3 }),
    strip: new THREE.MeshStandardMaterial({ color: 0xfff3dc, emissive: 0xfff0d8, emissiveIntensity: 1.4 }),
    grow: new THREE.MeshStandardMaterial({ color: 0xff8ce8, emissive: 0xff5ad8, emissiveIntensity: 1.6 }),
    status: new THREE.MeshStandardMaterial({ color: 0x40ff80, emissive: 0x40ff80, emissiveIntensity: 2 }),
  };
  const add = (geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, parent = group) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); parent.add(o); return o; };
  const box = (x0, x1, y0, y1, z0, z1, mat, parent) => add(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, 0, 0, 0, parent);
  const fbox = (f, y0, y1, mat, inset = 0) => box(f.x0 + inset, f.x1 - inset, y0, y1, f.z0 + inset, f.z1 - inset, mat);
  const F = Object.fromEntries(FURNITURE.map((f) => [f.id, f]));
  const plane = (x0, x1, z0, z1, y, mat, down = false, tile = 1.2) => {
    const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0); geo.rotateX(down ? Math.PI / 2 : -Math.PI / 2);
    const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (x1 - x0) / tile, uv.getY(i) * (z1 - z0) / tile);
    return add(geo, mat, (x0 + x1) / 2, y, (z0 + z1) / 2);
  };
  const wall = (shape, normal, at, mat = M.wallF) => {
    const geo = placeShape(shape, normal, at);
    const uv = geo.attributes.uv, pos = geo.attributes.position;
    for (let i = 0; i < uv.count; i++) {   // kafle paneli 4 × 2 m niezależnie od rozmiaru ściany
      const u = normal[1] === 'x' ? pos.getZ(i) : pos.getX(i);
      uv.setXY(i, u / 4, pos.getY(i) / 2);
    }
    return add(geo, mat);
  };
  const doorHole = (c, half) => rectPath(c - half, FLOOR, c + half, DOOR.top);
  /** Ościeżnica w szczelinie a…b między dwiema ścianami (oś: x — ściany prostopadłe do x). */
  const jamb = (axis, a, b, c, half) => {
    const d = b - a + 0.02, m = (a + b) / 2, h = DOOR.top - FLOOR;
    const put = (along, across, y, w, hh, t) => (axis === 'x'
      ? box(m - w / 2, m + w / 2, y, y + hh, across - t / 2, across + t / 2, M.metal)
      : box(across - t / 2, across + t / 2, y, y + hh, m - w / 2, m + w / 2, M.metal));
    for (const s of [-1, 1]) put(m, c + s * (half + 0.03), FLOOR, d, h, 0.06);
    put(m, c, DOOR.top, d, 0.06, 2 * half + 0.12);
    put(m, c, FLOOR - 0.01, d, 0.012, 2 * half);
  };
  const { cy, x0, x1, lining: R } = HULL;
  const lights = [];
  const lamp = (x, y, z, color = 0xfff0dc, base = 4, dist = 7) => { const l = new THREE.PointLight(color, 0, dist, 1.6); l.position.set(x, y, z); group.add(l); const e = { light: l, base }; lights.push(e); return e; };

  // ================= moduł dzienny =================
  const tube = (a, b, gap) => {
    const len = b - a, geo = gap
      ? new THREE.CylinderGeometry(R, R, len, 48, 1, true, gap[1], Math.PI * 2 - (gap[1] - gap[0]))
      : new THREE.CylinderGeometry(R, R, len, 48, 1, true);
    geo.rotateZ(-Math.PI / 2);   // kąt 0 = +z, π/2 = dół, π = −z
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 6, uv.getY(i) * len / 2);
    add(geo, M.wall, (a + b) / 2, cy, 0);
  };
  const [wS, wN] = [WINDOWS.find((w) => w.side < 0), WINDOWS.find((w) => w.side > 0)];
  tube(x0, wN.x0); tube(wN.x0, wN.x1, [-0.2, 0.32]); tube(wN.x1, wS.x0); tube(wS.x0, wS.x1, [Math.PI - 0.32, Math.PI + 0.2]); tube(wS.x1, x1);
  for (const w of WINDOWS) {   // ramy okien od środka
    const wc = (w.x0 + w.x1) / 2, ww = w.x1 - w.x0, z = w.side * (R - 0.05);
    for (const y of [cy + 0.43, cy - 0.68]) add(new THREE.BoxGeometry(ww + 0.06, 0.08, 0.18), M.metal, wc, y, z);
    for (const x of [w.x0, w.x1]) add(new THREE.BoxGeometry(0.08, 1.15, 0.18), M.metal, x, cy - 0.12, w.side * (R - 0.08));
  }
  const floorW = 2 * Math.sqrt(R * R - (cy - FLOOR) ** 2);
  plane(x0, x1, -floorW / 2, floorW / 2, FLOOR, M.floor);
  const disc = (holeC, half) => { const s = new THREE.Shape(); s.absarc(0, cy, R, 0, Math.PI * 2, false); s.holes.push(doorHole(holeC, half)); return s; };
  wall(disc(0, DOOR.half), '-x', x1);                         // gródź przy śluzie
  wall(disc(0, OPENINGS.common.half), '+x', x0);              // gródź przy hali
  for (const x of [-2.5, 0.5, 3]) add(new THREE.BoxGeometry(1.6, 0.05, 0.22), M.strip, x, cy + R - 0.06, 0);
  for (const z of [-1, 1]) add(new THREE.BoxGeometry(x1 - x0, 0.06, 0.06), M.accent, (x0 + x1) / 2, FLOOR + 0.03, z * (floorW / 2 - 0.03));
  lamp(-2.2, cy + R - 0.4, 0); lamp(2.2, cy + R - 0.4, 0);
  // podtrzymywanie życia
  fbox(F.life, FLOOR, FLOOR + 2.0, M.dark);
  for (let k = 0; k < 4; k++) add(new THREE.BoxGeometry(0.7, 0.02, 0.02), M.metal, (F.life.x0 + F.life.x1) / 2, FLOOR + 0.25 + k * 0.12, F.life.z1 + 0.01);
  // konsola misji
  box(F.console.x0, F.console.x1, FLOOR + 0.72, FLOOR + 0.78, F.console.z0, F.console.z1, M.metal);
  box(F.console.x0, F.console.x1, FLOOR, FLOOR + 0.72, F.console.z0, F.console.z0 + 0.2, M.dark);
  add(new THREE.CylinderGeometry(0.2, 0.22, 0.08, 16), M.blind, 1.45, FLOOR + 0.48, -0.75);
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.44, 8), M.metal, 1.45, FLOOR + 0.22, -0.75);
  // kuchnia
  fbox(F.galley, FLOOR, FLOOR + 0.9, M.plain, 0.02);
  box(F.galley.x0, F.galley.x1, FLOOR + 0.9, FLOOR + 0.94, F.galley.z0 - 0.03, F.galley.z1, M.metal);
  add(new THREE.BoxGeometry(0.5, 0.3, 0.35), M.dark, F.galley.x0 + 0.4, FLOOR + 1.1, 1.3);
  add(new THREE.BoxGeometry(0.6, 1.7, 0.5), M.white, F.galley.x1 - 0.35, FLOOR + 0.85, 1.32);   // lodówka
  box(F.galley.x0, F.galley.x1 - 0.7, FLOOR + 1.55, FLOOR + 2.05, 1.3, F.galley.z1, M.plain);
  // skafandry
  box(F.suits.x0, F.suits.x1, FLOOR + 0.2, FLOOR + 2.1, F.suits.z1 - 0.12, F.suits.z1, M.metal);
  for (const x of [F.suits.x0 + 0.38, F.suits.x1 - 0.38]) {
    const z = F.suits.z1 - 0.32;
    add(new THREE.BoxGeometry(0.5, 0.7, 0.32), M.suit, x, FLOOR + 1.35, z);
    add(new THREE.SphereGeometry(0.17, 16, 12), M.suit, x, FLOOR + 1.88, z);
    add(new THREE.SphereGeometry(0.12, 12, 8, 0, Math.PI), M.visor, x, FLOOR + 1.88, z - 0.08, 0, Math.PI, 0);
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(0.15, 0.6, 0.15), M.suit, x + s * 0.32, FLOOR + 1.3, z);
      add(new THREE.BoxGeometry(0.17, 0.75, 0.18), M.suit, x + s * 0.13, FLOOR + 0.6, z);
    }
    add(new THREE.BoxGeometry(0.42, 0.06, 0.02), M.accent, x, FLOOR + 1.55, z - 0.17);
  }
  // kanapa pod oknem i apteczka
  fbox({ ...F.sofa, z0: F.sofa.z0 + 0.05 }, FLOOR, FLOOR + 0.42, M.blind);
  box(F.sofa.x0, F.sofa.x1, FLOOR + 0.42, FLOOR + 0.95, F.sofa.z1 - 0.18, F.sofa.z1, M.blind);
  for (const k of [0, 1, 2]) add(new THREE.BoxGeometry(0.7, 0.12, 0.45), new THREE.MeshStandardMaterial({ color: CREW_COLORS[k], roughness: 0.95 }), F.sofa.x0 + 0.42 + k * 0.75, FLOOR + 0.48, 1.3);
  fbox(F.medkit, FLOOR + 0.9, FLOOR + 1.8, M.white);
  add(new THREE.BoxGeometry(0.3, 0.08, 0.01), M.accent, (F.medkit.x0 + F.medkit.x1) / 2, FLOOR + 1.35, F.medkit.z1 + 0.006);
  add(new THREE.BoxGeometry(0.08, 0.3, 0.01), M.accent, (F.medkit.x0 + F.medkit.x1) / 2, FLOOR + 1.35, F.medkit.z1 + 0.006);

  // ================= śluza =================
  const A = AIRLOCK.in, aw = A.x1 - A.x0, ah = A.top - FLOOR;
  wall(wallShape(-A.z, FLOOR - 0.02, A.z, A.top, [doorHole(0, DOOR.half)]), '+x', A.x0);
  wall(wallShape(-A.z, FLOOR - 0.02, A.z, A.top, [doorHole(0, DOOR.half)]), '-x', A.x1);
  plane(A.x0, A.x1, -A.z, A.z, FLOOR, M.floor);
  plane(A.x0, A.x1, -A.z, A.z, A.top, M.ceil, true);
  wall(wallShape(A.x0, FLOOR - 0.02, A.x1, A.top), '+z', -A.z);
  wall(wallShape(A.x0, FLOOR - 0.02, A.x1, A.top), '-z', A.z);
  add(new THREE.BoxGeometry(1.3, 0.08, 0.4), M.metal, 6.0, FLOOR + 0.45, A.z - 0.22);
  add(new THREE.BoxGeometry(1.3, 0.45, 0.06), M.dark, 6.0, FLOOR + 0.22, A.z - 0.05);
  const airLamp = add(new THREE.BoxGeometry(0.9, 0.05, 0.12), M.status.clone(), (A.x0 + A.x1) / 2, A.top - 0.03, 0);
  const outLamp = add(new THREE.BoxGeometry(0.06, 0.12, 0.5), M.status.clone(), AIRLOCK.x1 + 0.06, DOOR.top + 0.25, 0);
  const doorGeo = new THREE.BoxGeometry(0.03, DOOR.top - FLOOR, 2 * DOOR.half + 0.06);
  const inner = add(doorGeo, M.door, (HULL.x1 + A.x0) / 2, (FLOOR + DOOR.top) / 2, 0);
  const outer = add(doorGeo, M.door, (A.x1 + AIRLOCK.x1) / 2, (FLOOR + DOOR.top) / 2, 0);
  for (const d of [inner, outer]) add(new THREE.BoxGeometry(0.05, 0.6, 0.06), M.accent, 0, 0, -DOOR.half + 0.12, 0, 0, 0, d);
  jamb('x', HULL.x1, A.x0, 0, DOOR.half);
  jamb('x', A.x1, AIRLOCK.x1, 0, DOOR.half);
  const airLight = new THREE.PointLight(0x60ff90, 0, 4.5, 1.6); airLight.position.set(5.9, A.top - 0.25, 0); group.add(airLight);

  // ================= hala: węzeł (mesa) i korytarz sypialni =================
  const H = HALL, I = H.inset, hx0 = H.x0 + I, hx1 = H.x1 - I, hz = H.z - I, P = H.partition;
  plane(P, hx1, -hz, hz, FLOOR, M.floor);
  plane(hx0, P, -hz, hz, FLOOR, M.vinyl, false, 1.0);
  plane(hx0, hx1, -hz, hz, CEIL, M.ceil, true);
  wall(wallShape(-hz, FLOOR - 0.02, hz, CEIL, [doorHole(0, OPENINGS.common.half)]), '-x', hx1);
  jamb('x', hx1, H.x1, 0, OPENINGS.common.half);
  wall(wallShape(-hz, FLOOR - 0.02, hz, CEIL), '+x', hx0);
  wall(wallShape(hx0, FLOOR - 0.02, hx1, CEIL, [doorHole(GREEN.x, OPENINGS.green.half)]), '-z', hz);
  wall(wallShape(hx0, FLOOR - 0.02, hx1, CEIL, [doorHole(GREEN.x, OPENINGS.lab.half)]), '+z', -hz);
  wall(wallShape(-hz, FLOOR - 0.02, hz, CEIL, [doorHole(0, OPENINGS.sleep.half)]), '+x', P, M.wall2);   // ściana węzeł | sypialnie
  jamb('x', P - 0.06, P + 0.06, 0, OPENINGS.sleep.half);
  for (const s of [-1, 1]) {   // ściany korytarza z drzwiami do pomieszczeń
    const holes = ROOMS.filter((r) => r.side === s).map((r) => rectPath(r.door.x0, FLOOR, r.door.x1, DOOR.top));
    wall(wallShape(hx0, FLOOR - 0.02, P, CEIL, holes), '+z', s * CORRIDOR, M.wall2);
    for (const r of ROOMS.filter((q) => q.side === s)) jamb('z', s * CORRIDOR - 0.06, s * CORRIDOR + 0.06, (r.door.x0 + r.door.x1) / 2, (r.door.x1 - r.door.x0) / 2);
    for (const x of [-12.6, -15.2]) {   // ściany między pomieszczeniami
      const [a, b] = s > 0 ? [CORRIDOR, hz] : [-hz, -CORRIDOR];
      wall(wallShape(a, FLOOR - 0.02, b, CEIL), '+x', x, M.wall2);
    }
  }
  for (const [x, z] of [[-7.3, -1.2], [-7.3, 1.2], [-6, 0], [-8.6, 0]]) add(new THREE.BoxGeometry(0.9, 0.04, 0.22), M.strip, x, CEIL - 0.03, z);
  for (let x = -18.5; x < -10.5; x += 2.2) add(new THREE.BoxGeometry(1.0, 0.04, 0.2), M.strip, x, CEIL - 0.03, 0);
  lamp(-7.3, CEIL - 0.3, 0, 0xfff0dc, 5, 8);
  lamp(-15, CEIL - 0.3, 0, 0xfff0dc, 3, 8);
  // mesa: stół z taboretami, magazyn, szafki, zbiorniki wody
  const T = F.table;
  fbox(T, FLOOR + 0.72, FLOOR + 0.77, M.wood);
  for (const [sx, sz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) add(new THREE.CylinderGeometry(0.03, 0.03, 0.72, 8), M.metal, T.x0 + 0.1 + sx * (T.x1 - T.x0 - 0.2), FLOOR + 0.36, T.z0 + 0.1 + sz * (T.z1 - T.z0 - 0.2));
  for (const [x, z] of [[T.x0 - 0.35, (T.z0 + T.z1) / 2], [T.x1 + 0.35, (T.z0 + T.z1) / 2], [(T.x0 + T.x1) / 2, T.z0 - 0.35]]) {
    add(new THREE.CylinderGeometry(0.2, 0.2, 0.06, 14), M.blind, x, FLOOR + 0.46, z);
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.44, 8), M.metal, x, FLOOR + 0.22, z);
  }
  for (const [mx, mz] of [[-6.2, 1.6], [-5.6, 2.0]]) add(new THREE.CylinderGeometry(0.05, 0.04, 0.1, 10), M.accent, mx, FLOOR + 0.82, mz);   // kubki
  for (const y of [FLOOR + 0.05, FLOOR + 0.75, FLOOR + 1.45, FLOOR + 2.15]) box(F.stores.x0, F.stores.x1, y, y + 0.04, F.stores.z0, F.stores.z1, M.metal);
  const rnd = mulberry(7);
  for (let k = 0; k < 9; k++) {
    const bx = F.stores.x0 + 0.25 + (k % 3) * 0.5, by = FLOOR + 0.09 + Math.floor(k / 3) * 0.7, s = 0.25 + rnd() * 0.15;
    add(new THREE.BoxGeometry(0.4, s, 0.4), new THREE.MeshStandardMaterial({ color: [0xd8cdb5, 0x9eb0c0, 0xc7a37a][k % 3], roughness: 0.9 }), bx, by + s / 2, -2.55);
  }
  fbox(F.lockers, FLOOR, FLOOR + 2.1, M.metal, 0.01);
  for (let k = 0; k < 3; k++) add(new THREE.BoxGeometry(0.02, 1.9, 0.5), M.dark, F.lockers.x0 + 0.48 * (k + 1), FLOOR + 1.05, 2.55);
  for (let k = 0; k < 3; k++) add(new THREE.CylinderGeometry(0.22, 0.22, 1.4, 16), M.white, F.rack.x0 + 0.25 + k * 0.45, FLOOR + 0.7, -2.58);

  // kajuty
  const cabins = {};
  ROOMS.filter((r) => r.id.startsWith('cabin')).forEach((r, k) => {
    const bed = F[`${r.id}Bed`], desk = F[`${r.id}Desk`], s = r.side, wallZ = s * hz;
    fbox(bed, FLOOR, FLOOR + 0.35, M.wood);
    fbox(bed, FLOOR + 0.35, FLOOR + 0.52, M.pillow, 0.04);
    box(bed.x0 + 0.5, bed.x1 - 0.02, FLOOR + 0.52, FLOOR + 0.56, bed.z0 + 0.02, bed.z1 - 0.02, new THREE.MeshStandardMaterial({ color: CREW_COLORS[k], roughness: 0.95 }));
    add(new THREE.BoxGeometry(0.4, 0.1, 0.55), M.pillow, bed.x0 + 0.27, FLOOR + 0.6, (bed.z0 + bed.z1) / 2);
    box(bed.x0, bed.x1, FLOOR + 1.6, FLOOR + 1.64, s > 0 ? hz - 0.35 : -hz, s > 0 ? hz : -hz + 0.35, M.wood);   // półka nad łóżkiem
    add(new THREE.PlaneGeometry(0.75, 0.75), M.blind, (r.x0 + r.x1) / 2 - 0.05, 2.4, wallZ - s * 0.01, 0, s > 0 ? Math.PI : 0, 0);   // roleta okna
    fbox(desk, FLOOR + 0.72, FLOOR + 0.76, M.wood);
    box(desk.x0 + 0.03, desk.x1 - 0.03, FLOOR, FLOOR + 0.72, s > 0 ? hz - 0.08 : -hz, s > 0 ? hz : -hz + 0.08, M.metal);
    add(new THREE.BoxGeometry(0.06, 0.4, 0.05), M.metal, desk.x0 + 0.1, FLOOR + 0.96, wallZ - s * 0.2);   // lampka
    const bulbMat = M.strip.clone();
    add(new THREE.SphereGeometry(0.05, 10, 8), bulbMat, desk.x0 + 0.1, FLOOR + 1.18, wallZ - s * 0.24);
    const light = lamp(desk.x0 + 0.1, FLOOR + 1.3, wallZ - s * 0.5, 0xffd9a0, 1.6, 3.5);
    cabins[r.id] = { light, bulb: bulbMat };
  });

  // siłownia
  const tm = F.treadmill, bk = F.bike;
  fbox(tm, FLOOR, FLOOR + 0.18, M.dark);
  const beltTex = canvasTexture([64, 64], (g) => { g.fillStyle = '#1a1c1e'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#2c3034'; for (let y = 0; y < 64; y += 8) g.fillRect(0, y, 64, 3); });
  beltTex.repeat.set(1, 4);
  const belt = box(tm.x0 + 0.15, tm.x1 - 0.15, FLOOR + 0.18, FLOOR + 0.2, tm.z0 + 0.1, tm.z1 - 0.1, new THREE.MeshStandardMaterial({ map: beltTex, roughness: 0.9 }));
  for (const z of [tm.z0 + 0.05, tm.z1 - 0.05]) add(new THREE.BoxGeometry(0.05, 1.0, 0.05), M.metal, tm.x1 - 0.1, FLOOR + 0.6, z);
  box(tm.x1 - 0.15, tm.x1 - 0.05, FLOOR + 1.05, FLOOR + 1.12, tm.z0, tm.z1, M.metal);
  for (const z of [tm.z0 + 0.05, tm.z1 - 0.05]) add(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 8), new THREE.MeshStandardMaterial({ color: 0xb0b0b0 }), (tm.x0 + tm.x1) / 2, FLOOR + 1.0, z);   // uprząż (mała grawitacja)
  box(bk.x0 + 0.1, bk.x1 - 0.1, FLOOR, FLOOR + 0.06, bk.z0 + 0.1, bk.z1 - 0.1, M.metal);
  add(new THREE.CylinderGeometry(0.28, 0.28, 0.06, 20), M.dark, (bk.x0 + bk.x1) / 2 + 0.2, FLOOR + 0.35, (bk.z0 + bk.z1) / 2, Math.PI / 2, 0, 0);
  add(new THREE.BoxGeometry(0.06, 0.8, 0.06), M.metal, (bk.x0 + bk.x1) / 2 - 0.15, FLOOR + 0.45, (bk.z0 + bk.z1) / 2, 0, 0, 0.3);
  add(new THREE.BoxGeometry(0.25, 0.06, 0.18), M.blind, (bk.x0 + bk.x1) / 2 - 0.25, FLOOR + 0.85, (bk.z0 + bk.z1) / 2);
  plane(-19.7, -15.4, 1.2, 2.75, FLOOR + 0.005, M.blind);   // mata
  lamp(-17.5, CEIL - 0.3, 1.9, 0xfff0dc, 2.5, 5);

  // łazienka
  const tl = F.toilet, sk = F.sink, wr = F.wrs, sh = F.shower;
  // toaleta: zbiornik przy ścianie (łazienka po stronie −z, ściana przy z0), miska od strony pomieszczenia
  box(tl.x0 + 0.05, tl.x1 - 0.05, FLOOR, FLOOR + 0.42, tl.z0, tl.z1 - 0.1, M.white);
  add(new THREE.CylinderGeometry(0.2, 0.17, 0.1, 16), M.white, (tl.x0 + tl.x1) / 2, FLOOR + 0.47, (tl.z0 + tl.z1) / 2 + 0.05);
  box(tl.x0 + 0.05, tl.x1 - 0.05, FLOOR + 0.42, FLOOR + 1.1, tl.z0, tl.z0 + 0.2, M.metal);
  fbox(sk, FLOOR, FLOOR + 0.8, M.plain);
  add(new THREE.CylinderGeometry(0.2, 0.15, 0.08, 16), M.white, (sk.x0 + sk.x1) / 2, FLOOR + 0.84, (sk.z0 + sk.z1) / 2);
  add(new THREE.PlaneGeometry(0.6, 0.5), new THREE.MeshStandardMaterial({ color: 0xcfe0e6, roughness: 0.05, metalness: 0.9 }), (sk.x0 + sk.x1) / 2, FLOOR + 1.45, -hz + 0.01);   // lustro
  fbox(wr, FLOOR, FLOOR + 1.9, M.dark, 0.01);
  for (let k = 0; k < 2; k++) add(new THREE.CylinderGeometry(0.12, 0.12, 0.7, 12), M.white, wr.x0 + 0.2 + k * 0.4, FLOOR + 0.45, (wr.z0 + wr.z1) / 2);
  box(sh.x0, sh.x1, FLOOR, FLOOR + 0.06, sh.z0, sh.z1, M.white);
  const shower = new THREE.CylinderGeometry(0.5, 0.5, 2.1, 24, 1, true, 0, Math.PI * 1.6); add(shower, M.glass, (sh.x0 + sh.x1) / 2, FLOOR + 1.1, (sh.z0 + sh.z1) / 2);
  add(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 12), M.metal, (sh.x0 + sh.x1) / 2, FLOOR + 2.1, (sh.z0 + sh.z1) / 2);
  plane(-19.7, -15.4, -2.75, -1.15, FLOOR + 0.004, new THREE.MeshStandardMaterial({ color: 0xa9c4cc, roughness: 0.4 }));   // płytki
  lamp(-17.5, CEIL - 0.3, -1.9, 0xeaf6ff, 2.5, 5);

  // ================= laboratorium z punktem medycznym =================
  const L = LAB, lx0 = L.x0 + I, lx1 = L.x1 - I, lz0 = L.z0 + I, lz1 = L.z1;
  plane(lx0, lx1, lz0, -hz, FLOOR, M.vinyl, false, 1.0);
  plane(lx0, lx1, lz0, -hz, CEIL, M.ceil, true);
  wall(wallShape(lz0, FLOOR - 0.02, lz1, CEIL), '+x', lx0);
  wall(wallShape(lz0, FLOOR - 0.02, lz1, CEIL), '-x', lx1);
  wall(wallShape(lx0, FLOOR - 0.02, lx1, CEIL), '+z', lz0);
  wall(wallShape(lx0, FLOOR - 0.02, lx1, CEIL, [doorHole(GREEN.x, OPENINGS.lab.half)]), '-z', lz1);
  jamb('z', lz1, -hz, GREEN.x, OPENINGS.lab.half);
  for (const f of [F.benchW, F.benchE]) {
    fbox(f, FLOOR + 0.85, FLOOR + 0.9, M.white);
    fbox(f, FLOOR, FLOOR + 0.85, M.plain, 0.03);
    const wx = f === F.benchW ? lx0 : lx1, s = f === F.benchW ? 1 : -1;
    box(Math.min(wx, wx + s * 0.35), Math.max(wx, wx + s * 0.35), FLOOR + 1.6, FLOOR + 1.64, f.z0, f.z1, M.metal);   // półka
  }
  const mx = (F.benchW.x0 + F.benchW.x1) / 2;
  add(new THREE.CylinderGeometry(0.06, 0.09, 0.35, 12), M.dark, mx, FLOOR + 1.08, -4.2);   // mikroskop
  add(new THREE.CylinderGeometry(0.025, 0.025, 0.2, 8), M.metal, mx + 0.08, FLOOR + 1.25, -4.2, 0, 0, -0.6);
  const gb = box(F.benchW.x0 + 0.05, F.benchW.x1 - 0.05, FLOOR + 0.9, FLOOR + 1.45, -6.2, -5.2, M.glass);   // komora rękawicowa
  for (const z of [-5.95, -5.45]) add(new THREE.TorusGeometry(0.08, 0.02, 6, 16), M.rubber, F.benchW.x1 - 0.05, FLOOR + 1.15, z, 0, Math.PI / 2, 0);
  gb.renderOrder = 2;
  for (let k = 0; k < 6; k++) add(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 8), new THREE.MeshStandardMaterial({ color: [0xb5653d, 0x8a8a8a, 0xd4b06a][k % 3], roughness: 0.8 }), (F.benchE.x0 + F.benchE.x1) / 2 - 0.15 + (k % 2) * 0.3, FLOOR + 0.96, -7.6 + Math.floor(k / 2) * 0.18);   // próbki
  add(new THREE.BoxGeometry(0.55, 0.9, 0.6), M.white, lx1 - 0.35, FLOOR + 0.45, -8.45);   // zamrażarka próbek
  const mb = F.medbed;
  box(mb.x0 + 0.05, mb.x1 - 0.05, FLOOR, FLOOR + 0.7, mb.z0 + 0.05, mb.z1 - 0.05, M.metal);
  box(mb.x0 + 0.05, mb.x1 - 0.05, FLOOR + 0.7, FLOOR + 0.82, mb.z0 + 0.08, mb.z1 - 0.08, new THREE.MeshStandardMaterial({ color: 0x5f8fa0, roughness: 0.8 }));
  add(new THREE.CylinderGeometry(0.02, 0.02, 1.6, 8), M.metal, mb.x1 + 0.1, FLOOR + 0.8, mb.z1 - 0.1);   // stojak kroplówki
  for (const z of [-4.5, -7]) add(new THREE.BoxGeometry(0.22, 0.04, 1.6), M.strip, -7.25, CEIL - 0.03, z);
  lamp(-7.25, CEIL - 0.3, -5.8, 0xf4fbff, 4, 7);

  // ================= szklarnia =================
  const G = GREEN, gl = G.z1 - G.z0, gw = 2 * Math.sqrt(G.lining ** 2 - (G.cy - FLOOR) ** 2);
  const gt = new THREE.CylinderGeometry(G.lining, G.lining, gl, 36, 1, true); gt.rotateX(Math.PI / 2);
  const guv = gt.attributes.uv; for (let i = 0; i < guv.count; i++) guv.setXY(i, guv.getX(i) * 5, guv.getY(i) * gl / 2);
  add(gt, M.wall, G.x, G.cy, (G.z0 + G.z1) / 2);
  const gDisc = (holes) => { const s = new THREE.Shape(); s.absarc(G.x, G.cy, G.lining, 0, Math.PI * 2, false); s.holes.push(...holes); return s; };
  wall(gDisc([]), '-z', G.z1);
  wall(gDisc([doorHole(G.x, OPENINGS.green.half)]), '+z', G.z0);
  jamb('z', hz, G.z0, G.x, OPENINGS.green.half);
  plane(G.x - gw / 2, G.x + gw / 2, G.z0, G.z1, FLOOR, M.floor);
  const plants = [], leafGeo = new THREE.IcosahedronGeometry(1, 1), fruitGeo = new THREE.SphereGeometry(1, 8, 6);
  const prnd = mulberry(42);
  for (const side of [-1, 1]) {
    const px = G.x + side * (gw / 2 - 0.3), zc = (G.z0 + G.z1) / 2, zl = gl - 0.7;
    add(new THREE.BoxGeometry(0.52, 0.55, zl), M.plain, px, FLOOR + 0.28, zc);
    add(new THREE.BoxGeometry(0.46, 0.04, zl - 0.06), M.soil, px, FLOOR + 0.57, zc);
    add(new THREE.BoxGeometry(0.52, 0.04, zl), M.metal, px + side * 0.08, FLOOR + 1.35, zc);
    add(new THREE.BoxGeometry(0.42, 0.04, zl - 0.06), M.soil, px + side * 0.08, FLOOR + 1.39, zc);
    add(new THREE.BoxGeometry(0.08, 0.03, zl), M.grow, px, G.cy + 1.1, zc);
    for (const [shelf, dx] of [[FLOOR + 0.59, 0], [FLOOR + 1.41, side * 0.08]]) {
      for (let z = G.z0 + 0.6; z < G.z1 - 0.4; z += 0.36) {
        const p = new THREE.Group();
        p.position.set(px + dx + (prnd() - 0.5) * 0.12, shelf, z + (prnd() - 0.5) * 0.08);
        const s = 0.09 + prnd() * 0.05;
        for (let k = 0; k < 4; k++) add(leafGeo, M.leaf, (prnd() - 0.5) * 0.12, s * (0.5 + k * 0.45), (prnd() - 0.5) * 0.12, prnd(), prnd() * 6, 0, p).scale.set(s * (1 - k * 0.15), s * 0.7, s * (1 - k * 0.15));
        if (prnd() < 0.4) add(fruitGeo, M.tomato, (prnd() - 0.5) * 0.15, s * 0.8, 0.07, 0, 0, 0, p).scale.setScalar(0.03);
        group.add(p);
        plants.push(p);
      }
    }
  }
  const growLight = new THREE.PointLight(0xff70e0, 0, 7, 1.6); growLight.position.set(G.x, G.cy + 1.0, (G.z0 + G.z1) / 2); group.add(growLight);

  // ================= ekrany =================
  const screens = {
    console: new Screen(640, 360, 1.15, 0.65), life: new Screen(400, 400, 0.62, 0.62),
    airlock: new Screen(400, 260, 0.5, 0.32), hatch: new Screen(400, 260, 0.42, 0.27), outer: new Screen(400, 260, 0.5, 0.32),
    green: new Screen(400, 260, 0.6, 0.39), lights: new Screen(200, 200, 0.18, 0.18), map: new Screen(640, 400, 1.2, 0.75),
    gym: new Screen(400, 260, 0.4, 0.26), water: new Screen(400, 300, 0.5, 0.375), lab: new Screen(640, 400, 0.9, 0.56), med: new Screen(400, 300, 0.55, 0.41),
    ...Object.fromEntries(ROOMS.filter((r) => r.id.startsWith('cabin')).map((r) => [r.id, new Screen(320, 200, 0.32, 0.2)])),
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
  place(screens.map, hx1 - 0.012, FLOOR + 1.35, -1.4, -Math.PI / 2);
  add(new THREE.BoxGeometry(0.03, 0.85, 1.3), M.dark, hx1 - 0.002, FLOOR + 1.35, -1.4);
  place(screens.gym, tm.x1 - 0.1, FLOOR + 1.3, (tm.z0 + tm.z1) / 2, -Math.PI / 2, 0);
  place(screens.water, (wr.x0 + wr.x1) / 2, FLOOR + 1.45, wr.z1 + 0.012, 0);
  place(screens.lab, lx1 - 0.012, FLOOR + 1.3, -5.8, -Math.PI / 2);
  place(screens.med, -7.25, FLOOR + 1.6, lz0 + 0.012, 0);
  for (const r of ROOMS.filter((q) => q.id.startsWith('cabin'))) {
    const d = F[`${r.id}Desk`], s = r.side;
    place(screens[r.id], (d.x0 + d.x1) / 2, FLOOR + 0.9, s * (hz - 0.3), s > 0 ? Math.PI : 0, -0.5);
  }

  return { group, doors: { inner, outer }, lights, cabins, airLight, growLight, airLamp, outLamp, strips: M.strip, grow: M.grow, screens, plants, belt: beltTex };
}
