// Scalanie nieruchomych brył o wspólnym materiale w jedną siatkę: setki małych obiektów (meble, listki, ramy)
// zamiast setek wywołań rysowania dają kilkadziesiąt. Wygląd bez zmian — te same materiały, te same trójkąty.
import * as THREE from 'three';

const ATTRS = ['position', 'normal', 'uv'];

/**
 * Scala siatki w obrębie root według materiału (i ustawień cieni). Pomija: obiekty z keep (i ich potomków),
 * materiały przezroczyste, tablice materiałów, siatki instancyjne i z własnym renderOrder.
 * Zwraca liczbę siatek przed i po scaleniu.
 */
export function mergeStatic(root, keep = []) {
  const skip = new Set(keep);
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert(), m = new THREE.Matrix4();
  const buckets = new Map(), victims = [];
  let before = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    before++;
    if (o.isInstancedMesh || Array.isArray(o.material) || o.material.transparent || o.renderOrder || o.morphTargetInfluences) return;
    for (let p = o; p && p !== root; p = p.parent) if (skip.has(p)) return;
    const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}`;
    if (!buckets.has(key)) buckets.set(key, { material: o.material, cast: o.castShadow, receive: o.receiveShadow, list: [] });
    m.multiplyMatrices(inv, o.matrixWorld);
    buckets.get(key).list.push({ geo: o.geometry, matrix: m.clone() });
    victims.push(o);
  });
  for (const o of victims) o.removeFromParent();
  for (const b of buckets.values()) {
    const mesh = new THREE.Mesh(merge(b.list), b.material);
    mesh.castShadow = b.cast; mesh.receiveShadow = b.receive;
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
  }
  // puste grupy (np. rośliny po scaleniu listków) — mniej obiektów do przeglądania co klatkę
  const empty = [];
  root.traverse((o) => { if (o !== root && !o.isMesh && !o.isLight && o.children.length === 0 && o.type === 'Group') empty.push(o); });
  for (const o of empty) o.removeFromParent();
  let after = 0;
  root.traverse((o) => { if (o.isMesh) after++; });
  return { before, after };
}

/** Łączy geometrie (każdą z własną macierzą) w jedną; indeksowaną, gdy wszystkie są indeksowane. */
function merge(list) {
  const indexed = list.every(({ geo }) => geo.index);
  const parts = list.map(({ geo, matrix }) => {
    let g = geo.clone();
    if (!indexed && g.index) g = g.toNonIndexed();
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(matrix);
    return g;
  });
  const count = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  for (const name of ATTRS) {
    const size = name === 'uv' ? 2 : 3, arr = new Float32Array(count * size);
    let off = 0;
    for (const g of parts) {
      const a = g.attributes[name];
      if (a) for (let i = 0; i < a.count; i++) for (let c = 0; c < size; c++) arr[off + i * size + c] = a.getComponent(i, c);
      off += g.attributes.position.count * size;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  if (indexed) {
    const total = parts.reduce((s, g) => s + g.index.count, 0);
    const idx = count > 65535 ? new Uint32Array(total) : new Uint16Array(total);
    let off = 0, base = 0;
    for (const g of parts) {
      const a = g.index.array;
      for (let i = 0; i < a.length; i++) idx[off + i] = a[i] + base;
      off += a.length; base += g.attributes.position.count;
    }
    out.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  for (const g of parts) g.dispose();
  out.computeBoundingSphere();
  return out;
}
