// Baza z zewnątrz: moduł dzienny (walec) ze śluzą, rampą i oknami, hala z łukowym dachem (węzeł i sypialnie),
// laboratorium, szklarnia, pole paneli i maszt. Wymiary z core/habitat.js; tam, gdzie moduły się łączą, ściany mają
// prawdziwe otwory — od środka widać przez nie sąsiednie pomieszczenie, nie skorupę.
import * as THREE from 'three';
import { AIRLOCK, DOOR, FLOOR, GREEN, HALL, HULL, LAB, MAST, PANELS, RAMP, WINDOWS } from '../core/habitat.js';
import { circlePath, placeShape, rectPath, roofArc, sectionShape, wallShape } from './habitatShapes.js';

const MAT = () => ({
  white: new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.55, metalness: 0.08 }),
  shield: new THREE.MeshStandardMaterial({ color: 0xc9b9a3, roughness: 0.85, metalness: 0.02 }),   // osłona z workami regolitu
  grey: new THREE.MeshStandardMaterial({ color: 0x5b5650, roughness: 0.6, metalness: 0.45 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x1f1b18, roughness: 0.92 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x1b2a33, roughness: 0.12, metalness: 0.6 }),
  accent: new THREE.MeshStandardMaterial({ color: 0xf17778, roughness: 0.5 }),
  panel: new THREE.MeshStandardMaterial({ color: 0x1d2c4a, roughness: 0.3, metalness: 0.5 }),
  lamp: new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xffc070, emissiveIntensity: 1.2 }),
});

export function habitatModel(mastM = 10) {
  const g = new THREE.Group(), m = MAT();
  const add = (geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); g.add(o); return o; };
  const doorHole = (c, half) => rectPath(c - half, FLOOR, c + half, DOOR.top);

  // ---------- moduł dzienny: walec od hali do śluzy ----------
  const { r, cy, x0, x1 } = HULL, len = x1 - x0;
  const body = new THREE.CylinderGeometry(r, r, len, 48, 1, true); body.rotateZ(Math.PI / 2);
  add(body, m.white, (x0 + x1) / 2, cy);
  const front = new THREE.Shape(); front.absarc(0, cy, r, 0, Math.PI * 2, false);
  front.holes.push(rectPath(-AIRLOCK.z, AIRLOCK.y0, AIRLOCK.z, AIRLOCK.y1));
  add(placeShape(front, '+x', x1, 48), m.white);
  for (const x of [x0 + 0.6, (x0 + x1) / 2, x1 - 0.6]) {
    const hoop = new THREE.CylinderGeometry(r + 0.06, r + 0.06, 0.28, 48, 1, true); hoop.rotateZ(Math.PI / 2);
    add(hoop, m.grey, x, cy);
  }
  add(new THREE.BoxGeometry(len - 1, 0.14, 2.2), m.accent, (x0 + x1) / 2, cy + r + 0.02);
  for (const x of [x0 + 1.2, x1 - 0.8]) for (const z of [-1.3, 1.3]) {
    add(new THREE.BoxGeometry(0.2, 1.6, 0.2), m.grey, x, -0.1, z);   // podpory sięgają pod grunt na pochyłym terenie
  }
  for (const w of WINDOWS) {   // szyba tylko od zewnątrz — od środka widać przez otwór teren
    const wc = (w.x0 + w.x1) / 2, ww = w.x1 - w.x0, z = w.side * (r + 0.025);
    add(new THREE.PlaneGeometry(ww, 1.05), m.glass, wc, cy - 0.12, z, 0, w.side > 0 ? 0 : Math.PI, 0);
    for (const y of [cy + 0.45, cy - 0.69]) add(new THREE.BoxGeometry(ww + 0.2, 0.1, 0.1), m.grey, wc, y, w.side * (r - 0.02 + (y > cy ? 0 : 0.05)));
  }

  // ---------- śluza, drzwi zewnętrzne i rampa ----------
  const A = AIRLOCK, aw = A.x1 - A.x0, ah = A.y1 - A.y0, hide = new THREE.MeshBasicMaterial({ visible: false });
  add(new THREE.BoxGeometry(aw, ah, 2 * A.z), [hide, hide, m.white, m.white, m.white, m.white], (A.x0 + A.x1) / 2, (A.y0 + A.y1) / 2);
  add(placeShape(wallShape(-A.z, A.y0, A.z, A.y1, [doorHole(0, DOOR.half)]), '+x', A.x1), m.white);
  add(new THREE.BoxGeometry(0.08, 0.1, 2 * DOOR.half + 0.3), m.grey, A.x1 + 0.03, DOOR.top + 0.05, 0);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.08, DOOR.top - FLOOR, 0.1), m.grey, A.x1 + 0.03, (FLOOR + DOOR.top) / 2, s * (DOOR.half + 0.1));
  add(new THREE.BoxGeometry(aw + 0.1, 0.14, 2 * A.z + 0.1), m.accent, (A.x0 + A.x1) / 2, A.y1);
  const rl = Math.hypot(RAMP.x1 - RAMP.x0, FLOOR), ra = -Math.atan2(FLOOR, RAMP.x1 - RAMP.x0);   // w dół ku +x
  add(new THREE.BoxGeometry(rl, 0.08, 2 * RAMP.half), m.grey, (RAMP.x0 + RAMP.x1) / 2, FLOOR / 2 - 0.04, 0, 0, 0, ra);
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(rl, 0.05, 0.05), m.grey, (RAMP.x0 + RAMP.x1) / 2, FLOOR / 2 + 0.95, s * RAMP.half, 0, 0, ra);
    for (const k of [0.15, 0.55, 0.92]) add(new THREE.BoxGeometry(0.04, 0.95, 0.04), m.grey, RAMP.x0 + (RAMP.x1 - RAMP.x0) * k, FLOOR * (1 - k) + 0.47, s * RAMP.half);
  }

  // ---------- hala (węzeł i sypialnie) ----------
  const H = HALL, hl = H.x1 - H.x0, hc = (H.x0 + H.x1) / 2;
  const hallFront = sectionShape(H.z, H.skirt, H.wallTop, H.roofSag); hallFront.holes.push(circlePath(0, cy, r));
  add(placeShape(hallFront, '+x', H.x1), m.shield);
  add(placeShape(sectionShape(H.z, H.skirt, H.wallTop, H.roofSag), '-x', H.x0), m.shield);
  const sideN = wallShape(H.x0, H.skirt, H.x1, H.wallTop, [circlePath(GREEN.x, GREEN.cy, GREEN.r)]);
  add(placeShape(sideN, '+z', H.z), m.shield);
  for (const [a, b] of [[H.x0, LAB.x0], [LAB.x1, H.x1]]) add(placeShape(wallShape(a, H.skirt, b, H.wallTop), '-z', -H.z), m.shield);
  const hr = roofArc(H.z, H.wallTop, H.roofSag);
  const roof = new THREE.CylinderGeometry(hr.r, hr.r, hl, 40, 1, true, 3 * Math.PI / 2 - hr.a, 2 * hr.a); roof.rotateZ(-Math.PI / 2);
  add(roof, m.shield, hc, hr.yc);
  for (let x = H.x0 + 1.2; x < H.x1 - 0.5; x += 2.6) {   // żebra konstrukcji na dachu
    const rib = new THREE.CylinderGeometry(hr.r + 0.05, hr.r + 0.05, 0.16, 40, 1, true, 3 * Math.PI / 2 - hr.a, 2 * hr.a); rib.rotateZ(-Math.PI / 2);
    add(rib, m.grey, x, hr.yc);
    if (x > LAB.x0 - 0.3 && x < LAB.x1 + 0.3) continue;   // nie przed przejściem do laboratorium i szklarni
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.16, H.wallTop - H.skirt, 0.1), m.grey, x, (H.wallTop + H.skirt) / 2, s * (H.z + 0.05));
  }
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(hl, 0.12, 0.08), m.accent, hc, H.wallTop - 0.1, s * (H.z + 0.06));
  for (const x of [-11.3, -13.9, -17.5]) for (const s of [-1, 1]) {   // małe okna kajut (od środka zasłonięte roletą)
    add(new THREE.CircleGeometry(0.28, 20), m.glass, x, 2.4, s * (H.z + 0.02), 0, s > 0 ? 0 : Math.PI, 0);
    add(new THREE.TorusGeometry(0.3, 0.04, 6, 20), m.grey, x, 2.4, s * (H.z + 0.03));
  }

  // ---------- laboratorium ----------
  const L = LAB, lw = (L.x1 - L.x0) / 2, lc = (L.x0 + L.x1) / 2, ll = L.z1 - L.z0;
  add(placeShape(wallShape(L.z0, H.skirt, L.z1, H.wallTop), '-x', L.x0), m.shield);
  add(placeShape(wallShape(L.z0, H.skirt, L.z1, H.wallTop), '+x', L.x1), m.shield);
  const labEnd = sectionShape(lw, H.skirt, H.wallTop, H.roofSag);
  const endGeo = placeShape(labEnd, '-z', L.z0); endGeo.translate(lc, 0, 0); add(endGeo, m.shield);
  const lr = roofArc(lw, H.wallTop, H.roofSag);
  const labRoof = new THREE.CylinderGeometry(lr.r, lr.r, ll, 32, 1, true, Math.PI - lr.a, 2 * lr.a); labRoof.rotateX(Math.PI / 2);
  add(labRoof, m.shield, lc, lr.yc, (L.z0 + L.z1) / 2);
  // szczyt dachu laboratorium nad ścianą hali (od strony hali dach jest niżej)
  const gable = new THREE.Shape(); gable.moveTo(-lw, H.wallTop);
  for (let i = 0; i <= 16; i++) { const u = -lw + 2 * lw * i / 16; gable.lineTo(u, lr.yc + Math.sqrt(lr.r * lr.r - u * u)); }
  const gableMesh = add(new THREE.ShapeGeometry(gable), m.shield.clone(), lc, 0, L.z1);
  gableMesh.material.side = THREE.DoubleSide;
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.08, 0.12, ll), m.accent, lc + s * (lw + 0.06), H.wallTop - 0.1, (L.z0 + L.z1) / 2);
  add(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 8), m.grey, lc + 1.2, lr.yc + lr.r + 0.7, -7.5);   // antena laboratorium

  // ---------- szklarnia ----------
  const G = GREEN, glen = G.z1 - G.z0;
  const gb = new THREE.CylinderGeometry(G.r, G.r, glen, 36, 1, true); gb.rotateX(Math.PI / 2);
  add(gb, m.white, G.x, G.cy, (G.z0 + G.z1) / 2);
  add(new THREE.SphereGeometry(G.r, 36, 18, 0, Math.PI), m.white, G.x, G.cy, G.z1);   // półkula po stronie +z
  for (const z of [G.z0 + 1.2, (G.z0 + G.z1) / 2, G.z1 - 0.6]) {
    const hoop = new THREE.CylinderGeometry(G.r + 0.05, G.r + 0.05, 0.22, 36, 1, true); hoop.rotateX(Math.PI / 2);
    add(hoop, m.grey, G.x, G.cy, z);
  }
  const strip = new THREE.CylinderGeometry(G.r + 0.012, G.r + 0.012, glen - 1.0, 24, 1, true, Math.PI * 0.62, Math.PI * 0.76);
  strip.rotateX(Math.PI / 2);
  add(strip, m.glass, G.x, G.cy, (G.z0 + G.z1) / 2 + 0.2);   // przeszklony dach szklarni
  for (const z of [G.z0 + 1.0, G.z1 - 0.8]) for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.16, 1.2, 0.16), m.grey, G.x + s * 1.2, 0.1, z);

  // ---------- pole paneli i maszt ----------
  for (const p of PANELS) {
    for (const dx of [-p.w / 2 + 0.4, p.w / 2 - 0.4]) add(new THREE.CylinderGeometry(0.06, 0.06, 1.5, 8), m.grey, p.x + dx, 0.75, p.z);
    add(new THREE.BoxGeometry(p.w, 0.06, p.d), m.panel, p.x, 1.55, p.z, -0.55, 0, 0);
  }
  add(new THREE.CylinderGeometry(0.08, 0.12, mastM, 10), m.grey, MAST.x, mastM / 2, MAST.z);
  add(new THREE.SphereGeometry(0.55, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), m.white, MAST.x, mastM + 0.2, MAST.z, -0.6, 0.8, 0);
  add(new THREE.SphereGeometry(0.12, 10, 8), m.lamp, MAST.x, mastM + 0.65, MAST.z);

  g.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  return g;
}
