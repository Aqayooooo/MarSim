// Kształty wspólne dla bryły bazy z zewnątrz i jej wnętrza: przekrój hali z łukowym dachem, prostokątne otwory.
import * as THREE from 'three';

/** Prostokątny otwór (ścieżka) w układzie kształtu. */
export function rectPath(x0, y0, x1, y1) {
  const p = new THREE.Path();
  p.moveTo(x0, y0); p.lineTo(x0, y1); p.lineTo(x1, y1); p.lineTo(x1, y0); p.closePath();
  return p;
}

/** Łuk dachu nad szerokością 2·half o strzałce sag: promień i środek (wysokość) okręgu. */
export function roofArc(half, wallTop, sag) {
  const r = (half * half + sag * sag) / (2 * sag);
  return { r, yc: wallTop + sag - r, a: Math.asin(half / r) };
}

/** Przekrój modułu: ściany od bottom do wallTop i łukowy dach; u — w poprzek (−half…half), v — w górę. */
export function sectionShape(half, bottom, wallTop, sag, segments = 24) {
  const { r, yc } = roofArc(half, wallTop, sag), s = new THREE.Shape();
  s.moveTo(-half, bottom); s.lineTo(half, bottom); s.lineTo(half, wallTop);
  for (let i = 1; i < segments; i++) { const u = half - 2 * half * i / segments; s.lineTo(u, yc + Math.sqrt(r * r - u * u)); }
  s.lineTo(-half, wallTop); s.closePath();
  return s;
}

/** Prostokąt (u0…u1, v0…v1) z otworami — płaska ściana w układzie kształtu. */
export function wallShape(u0, v0, u1, v1, holes = []) {
  const s = new THREE.Shape();
  s.moveTo(u0, v0); s.lineTo(u1, v0); s.lineTo(u1, v1); s.lineTo(u0, v1); s.closePath();
  s.holes.push(...holes);
  return s;
}

/** Okrągły otwór. */
export function circlePath(u, v, r) {
  const p = new THREE.Path();
  p.absarc(u, v, r, 0, Math.PI * 2, true);
  return p;
}

/**
 * Płaska ściana z kształtu ustawiona w przestrzeni: normal — kierunek, w który patrzy przód ('+x','-x','+z','-z','+y','-y').
 * Kształt: u w poziomie wzdłuż ściany (dla ścian x — oś z, dla ścian z — oś x), v w górę. Bez lustrzanego odbicia osi.
 */
export function placeShape(shape, normal, at, segments = 24) {
  const g = new THREE.ShapeGeometry(shape, segments);
  // ShapeGeometry: przód w +z, u = x, v = y. Obrót tak, by u szło wzdłuż właściwej osi bez odbicia.
  if (normal === '-z') g.rotateY(Math.PI), g.scale(-1, 1, 1), flip(g);
  else if (normal === '+x') g.rotateY(Math.PI / 2), g.scale(1, 1, -1), flip(g);
  else if (normal === '-x') g.rotateY(-Math.PI / 2);
  const p = at ?? 0;
  if (normal[1] === 'x') g.translate(p, 0, 0); else g.translate(0, 0, p);
  return g;
}

/** Odwraca kolejność wierzchołków trójkątów (po odbiciu lustrzanym przód znów patrzy na zewnątrz). */
function flip(g) {
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  g.computeVertexNormals();
  return g;
}
