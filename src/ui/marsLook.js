// Wygląd Marsa w 3D: paleta terenu, cieniowanie rzeźby z DEM, tekstura detalu z bliska, ściany bloku terenu,
// niebo ze słońcem, kształty kamieni i drobne kamyki wokół obserwatora. Wszystko liczone w przeglądarce, bez plików.
import * as THREE from 'three';
import { mulberry } from '../core/rocks.js';

// paleta terenu (sRGB): ciemny bazaltowy piasek → rdzawy regolit → jasne skały i pył
const RAMP = ['#2a1c16', '#6b402a', '#b2744a', '#e3bb92'];
// niebo w dzień (sRGB 0–1, bez konwersji w shaderze): zenit, horyzont, grunt pod horyzontem, poświata wokół słońca
const SKY = { zenith: '#6f4a35', horizon: '#d2a37a', ground: '#7a5038', halo: '#c9d2d8' };
export const FOG_COLOR = SKY.horizon;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const srgb = (hex) => { const n = parseInt(hex.slice(1), 16); return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };

/** Kafelkowalny szum (kilka oktaw) w kanwie — tekstura detalu gruntu i kamieni. */
export function detailTexture(size = 256, seed = 11) {
  const rnd = mulberry(seed), out = new Float32Array(size * size);
  for (const [n, amp] of [[6, 0.42], [12, 0.26], [24, 0.17], [48, 0.1], [96, 0.05]]) {
    const grid = Float32Array.from({ length: n * n }, () => rnd());
    const g = (a, b) => grid[((b % n) + n) % n * n + ((a % n) + n) % n];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = x / size * n, fy = y / size * n, i = Math.floor(fx), j = Math.floor(fy);
      const tx = fx - i, ty = fy - j, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      out[y * size + x] += amp * (g(i, j) * (1 - sx) * (1 - sy) + g(i + 1, j) * sx * (1 - sy) + g(i, j + 1) * (1 - sx) * sy + g(i + 1, j + 1) * sx * sy);
    }
  }
  for (let k = 0; k < size * size * 0.03; k++) out[Math.floor(rnd() * size * size)] += (rnd() - 0.5) * 0.35;   // ziarna
  let lo = Infinity, hi = -Infinity;
  for (const v of out) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), im = g.createImageData(size, size);
  out.forEach((v, k) => { const b = Math.round((v - lo) / (hi - lo) * 255); im.data.set([b, b, b, 255], k * 4); });
  g.putImageData(im, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Cieniowanie rzeźby z DEM (zagłębienia ciemniejsze, grzbiety jaśniejsze) jako kolory wierzchołków. */
export function reliefColors(t) {
  const w = t.w, h = t.hgt, H = t.h, W1 = w + 1;
  const sat = new Float64Array(W1 * (h + 1));
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    sat[(j + 1) * W1 + i + 1] = H[j * w + i] + sat[j * W1 + i + 1] + sat[(j + 1) * W1 + i] - sat[j * W1 + i];
  }
  const mean = (i, j, r) => {
    const i0 = Math.max(0, i - r), j0 = Math.max(0, j - r), i1 = Math.min(w - 1, i + r), j1 = Math.min(h - 1, j + r);
    return (sat[(j1 + 1) * W1 + i1 + 1] - sat[j0 * W1 + i1 + 1] - sat[(j1 + 1) * W1 + i0] + sat[j0 * W1 + i0]) / ((i1 - i0 + 1) * (j1 - j0 + 1));
  };
  const diff = new Float32Array(w * h);
  let s2 = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, d = (H[k] - mean(i, j, 3)) + 0.5 * (H[k] - mean(i, j, 10));
    diff[k] = d; s2 += d * d;
  }
  const sd = Math.sqrt(s2 / diff.length) || 1, col = new Float32Array(w * h * 3);
  diff.forEach((d, k) => {
    const s = 1 + 0.16 * clamp(d / sd, -2.5, 2.5);
    col.set([s, s * (s < 1 ? 0.97 : 1), s * (s < 1 ? 0.94 : 1)], k * 3);   // zagłębienia lekko chłodniejsze
  });
  return col;
}

/** Materiał terenu: zdjęcie HiRISE w palecie Marsa, detal z bliska, cieniowanie rzeźby (kolory wierzchołków). */
export function terrainMaterial(map, detail) {
  const uniforms = {
    uMars: { value: 1 }, uDetail: { value: 1 }, uDetailNear: { value: 10 }, uDetailFar: { value: 90 },
    uRamp0: { value: new THREE.Color(RAMP[0]) }, uRamp1: { value: new THREE.Color(RAMP[1]) },
    uRamp2: { value: new THREE.Color(RAMP[2]) }, uRamp3: { value: new THREE.Color(RAMP[3]) },
  };
  const mat = new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 0.97, metalness: 0, bumpMap: detail, bumpScale: 0 });
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uMars, uDetail, uDetailNear, uDetailFar;
uniform vec3 uRamp0, uRamp1, uRamp2, uRamp3;
vec3 marsRamp( float l ) {
  vec3 c = mix( uRamp0, uRamp1, smoothstep( 0.0, 0.34, l ) );
  c = mix( c, uRamp2, smoothstep( 0.26, 0.68, l ) );
  return mix( c, uRamp3, smoothstep( 0.62, 1.0, l ) );
}`)
      .replace('#include <map_fragment>', `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  float lumL = dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  diffuseColor.rgb *= mix( sampledDiffuseColor.rgb, marsRamp( pow( lumL, 1.0 / 2.2 ) ), uMars );
#endif
#ifdef USE_BUMPMAP
  float nearK = ( 1.0 - smoothstep( uDetailNear, uDetailFar, length( vViewPosition ) ) ) * uDetail;
  float d1 = texture2D( bumpMap, vBumpMapUv ).r;
  float d2 = texture2D( bumpMap, vBumpMapUv * 0.137 + 0.31 ).r;
  diffuseColor.rgb *= mix( 1.0, ( 0.74 + 0.52 * d1 ) * ( 0.84 + 0.32 * d2 ), nearK );
#endif`);
  };
  mat.customProgramCacheKey = () => 'marsim-terrain';
  return { mat, uniforms };
}

/** Warstwy skalne na ścianach bloku terenu (widok orbitalny). */
function strataTexture(seed = 5) {
  const rnd = mulberry(seed), c = document.createElement('canvas'); c.width = 8; c.height = 512;
  const g = c.getContext('2d'), tones = ['#7d4c33', '#9a6143', '#5e3a29', '#b07a55', '#6c4430', '#8a5a3e'];
  for (let y = 0; y < 512;) {
    const hgt = 6 + rnd() * 34;
    g.fillStyle = tones[Math.floor(rnd() * tones.length)];
    g.fillRect(0, y, 8, hgt);
    if (rnd() < 0.35) { g.fillStyle = 'rgba(232,196,150,.45)'; g.fillRect(0, y, 8, 1.5); }
    y += hgt;
  }
  const fade = g.createLinearGradient(0, 0, 0, 512);
  fade.addColorStop(0, 'rgba(0,0,0,0)'); fade.addColorStop(1, 'rgba(10,5,3,.78)');
  g.fillStyle = fade; g.fillRect(0, 0, 8, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/** Ściany bloku terenu i miękki cień pod nim — widok orbitalny wygląda jak wycięty przekrój geologiczny. */
export function terrainBlock(t, X, Z) {
  const group = new THREE.Group(), range = t.maxH - t.minH, base = -Math.max(12, range * 0.45);
  const ring = [];
  const at = (i, j) => ({ x: (i + 0.5) * t.cell, y: (j + 0.5) * t.cell, h: t.at(i, j) - t.minH });
  for (let i = 0; i < t.w; i++) ring.push(at(i, 0));
  for (let j = 1; j < t.hgt; j++) ring.push(at(t.w - 1, j));
  for (let i = t.w - 2; i >= 0; i--) ring.push(at(i, t.hgt - 1));
  for (let j = t.hgt - 2; j >= 0; j--) ring.push(at(0, j));
  const pos = new Float32Array(ring.length * 6), uv = new Float32Array(ring.length * 4), idx = [];
  let run = 0;
  ring.forEach((p, k) => {
    if (k) run += Math.hypot(p.x - ring[k - 1].x, p.y - ring[k - 1].y);
    pos.set([X(p.x), p.h, Z(p.y), X(p.x), base, Z(p.y)], k * 6);
    uv.set([run / 80, (p.h - base) / (range - base), run / 80, 0], k * 4);
    if (k) { const a = (k - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const walls = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: strataTexture(), roughness: 1, side: THREE.DoubleSide }));
  const sc = document.createElement('canvas'); sc.width = sc.height = 256;
  const sg = sc.getContext('2d'), rg = sg.createRadialGradient(128, 128, 30, 128, 128, 128);
  rg.addColorStop(0, 'rgba(0,0,0,.6)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
  sg.fillStyle = rg; sg.fillRect(0, 0, 256, 256);
  const shadowTex = new THREE.CanvasTexture(sc);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(t.widthM * 1.45, t.heightM * 1.55),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, color: 0x000000 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = base - 0.5;
  group.add(walls, shadow);
  return group;
}

/** Tło widoku orbitalnego: ciemna poświata zamiast płaskiego koloru. */
export function orbitBackground() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d'), rg = g.createRadialGradient(256, 300, 20, 256, 256, 380);
  rg.addColorStop(0, '#3d271b'); rg.addColorStop(0.55, '#1b110b'); rg.addColorStop(1, '#060302');
  g.fillStyle = rg; g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Kopuła nieba (widok z gruntu): gradient od horyzontu do zenitu, tarcza słońca i niebieskawa poświata wokół niej. */
export function skyDome() {
  const uniforms = {
    uSun: { value: new THREE.Vector3(0, 1, 0) },
    uZenith: { value: srgb(SKY.zenith) }, uHorizon: { value: srgb(SKY.horizon) }, uGround: { value: srgb(SKY.ground) }, uHalo: { value: srgb(SKY.halo) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize( position ); gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
    fragmentShader: `uniform vec3 uSun, uZenith, uHorizon, uGround, uHalo; varying vec3 vDir;
void main() {
  vec3 d = normalize( vDir );
  float e = d.y, s = max( dot( d, normalize( uSun ) ), 0.0 );
  vec3 c = mix( uHorizon, uZenith, pow( clamp( e, 0.0, 1.0 ), 0.5 ) );
  c = mix( c, uGround, smoothstep( 0.0, -0.06, e ) );
  c += uHalo * ( pow( s, 48.0 ) * 0.45 + pow( s, 6.0 ) * 0.08 );
  c = mix( c, vec3( 1.0, 0.98, 0.94 ), smoothstep( 0.99955, 0.99975, s ) );
  gl_FragColor = vec4( c, 1.0 );
}`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  mesh.scale.setScalar(15000);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}

/** Kierunek do słońca w układzie sceny (x na wschód, z na południe) z azymutu (od północy) i wysokości. */
export function sunVector(azDeg, elDeg) {
  const az = azDeg * Math.PI / 180, el = Math.max(6, elDeg) * Math.PI / 180;
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

export { approxSun } from '../core/environment.js';   // położenie słońca bez backendu

/** Kilka kształtów kamieni: bryły z nieregularnymi wypukłościami i spłaszczonym spodem. */
export function rockGeometries(count = 3) {
  return Array.from({ length: count }, (_, v) => {
    const rnd = mulberry(101 + v * 17);
    const lumps = Array.from({ length: 7 }, () => {
      const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
      return { x: r * Math.cos(a), y: z, z: r * Math.sin(a), k: (rnd() - 0.35) * 0.42 };
    });
    const g = new THREE.IcosahedronGeometry(1, 2), p = g.attributes.position, q = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      q.fromBufferAttribute(p, i).normalize();
      let r = 1;
      for (const l of lumps) r += l.k * Math.exp(-(1 - (q.x * l.x + q.y * l.y + q.z * l.z)) * 5);
      q.multiplyScalar(r);
      if (q.y < -0.25) q.y = -0.25 + (q.y + 0.25) * 0.35;   // spód osadzony w gruncie
      p.setXYZ(i, q.x, q.y, q.z);
    }
    g.computeVertexNormals();
    return g;
  });
}

/** Barwa kamienia: od rdzawobrązowej do szarego bazaltu, z wariancją jasności. */
export function rockColor(rnd) {
  const base = rnd() < 0.3 ? [0.16, 0.135, 0.12] : [0.26, 0.15, 0.09];   // liniowe RGB: szary bazalt / rdzawy brąz
  const k = 0.7 + rnd() * 0.6;
  return new THREE.Color(base[0] * k, base[1] * k, base[2] * k);
}

/**
 * Drobne kamyki (2–11 cm, przysypane pyłem) wokół obserwatora w widoku z gruntu. Bez kolizji — tylko faktura podłoża.
 * Układ zależy od kafelka terenu (ziarno z jego współrzędnych), więc kamyki nie przeskakują przy chodzeniu.
 */
export class Pebbles {
  constructor({ terrain, sand, X, Z, material, count = 1800 }) {
    Object.assign(this, { terrain, sand, X, Z, count });
    const g = new THREE.IcosahedronGeometry(1, 0), p = g.attributes.position, rnd = mulberry(77), q = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      q.fromBufferAttribute(p, i);
      const k = 0.75 + 0.5 * mulberry(Math.round((q.x * 7 + q.y * 13 + q.z * 29) * 1000))();
      p.setXYZ(i, q.x * k, q.y * k * 0.6, q.z * k);
    }
    g.computeVertexNormals();
    this.mesh = new THREE.InstancedMesh(g, material, count);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    const soil = new THREE.Color('#9c6642');                      // barwa regolitu: kamyki przysypane pyłem zlewają się z gruntem
    this.colors = Array.from({ length: 16 }, () => rockColor(rnd).lerp(soil, 0.45));
    this.cx = this.cy = Infinity;
  }

  update(x, y) {
    if (Math.hypot(x - this.cx, y - this.cy) < 5) return;
    this.cx = x; this.cy = y;
    const TILE = 6, R = 42, t = this.terrain, o = new THREE.Object3D();
    let n = 0;
    for (let tj = Math.floor((y - R) / TILE); tj <= Math.floor((y + R) / TILE); tj++) {
      for (let ti = Math.floor((x - R) / TILE); ti <= Math.floor((x + R) / TILE); ti++) {
        const cx = (ti + 0.5) * TILE, cy = (tj + 0.5) * TILE;
        if (Math.hypot(cx - x, cy - y) > R || !t.inside(cx, cy)) continue;
        const rnd = mulberry((ti * 73856093) ^ (tj * 19349663));
        const sandy = this.sand ? this.sand.sample(cx, cy) / 255 : 0;
        const per = Math.round(12 * (1 - 0.85 * sandy));
        for (let k = 0; k < per && n < this.count; k++) {
          const px = (ti + rnd()) * TILE, py = (tj + rnd()) * TILE, s = 0.02 + rnd() ** 3 * 0.1;
          o.position.set(this.X(px), t.height(px, py) - s * 0.15, this.Z(py));   // częściowo zagłębione w gruncie
          o.rotation.set(rnd() * 0.6, rnd() * 6.28, rnd() * 0.6);
          o.scale.set(s, s, s * (0.7 + rnd() * 0.6));
          o.updateMatrix();
          this.mesh.setMatrixAt(n, o.matrix);
          this.mesh.setColorAt(n, this.colors[Math.floor(rnd() * this.colors.length)]);
          n++;
        }
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

function shadowed(group) {
  group.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  return group;
}

const MAT = () => ({
  white: new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.55, metalness: 0.08 }),
  grey: new THREE.MeshStandardMaterial({ color: 0x5b5650, roughness: 0.6, metalness: 0.45 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x1f1b18, roughness: 0.92 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x1b2a33, roughness: 0.12, metalness: 0.6 }),
  accent: new THREE.MeshStandardMaterial({ color: 0xf17778, roughness: 0.5 }),
  panel: new THREE.MeshStandardMaterial({ color: 0x1d2c4a, roughness: 0.3, metalness: 0.5 }),
  lamp: new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xffc070, emissiveIntensity: 1.2 }),
});

/**
 * Ciśnieniowy łazik załogowy wzorowany na koncepcji NASA SEV (Space Exploration Vehicle): kabina ok. 4,5 m długości
 * i 3 m wysokości, rozstaw osi 4 m, koła ⌀ 0,99 m × 0,3 m (12 kół w 6 skrętnych parach), dwie śluzy skafandrów z tyłu
 * z przypiętymi skafandrami, duże okna z przodu, radiator i reflektory na dachu. Na dachu z tyłu obrotowa podstawa
 * wysięgnika kamery (sam wysięgnik rysuje widok 3D, bo zmienia długość i kierunek). Przód = +x, spód = y 0.
 */
export function roverModel() {
  const g = new THREE.Group(), m = MAT();
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); g.add(o); return o; };
  // podwozie: rama i 6 skrętnych modułów po 2 koła (rozstaw osi 4 m)
  add(new THREE.BoxGeometry(4.6, 0.32, 1.9), m.grey, 0, 1.0, 0);
  const wheel = new THREE.CylinderGeometry(0.495, 0.495, 0.3, 28); wheel.rotateX(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.2, 0.2, 0.32, 12); hub.rotateX(Math.PI / 2);
  for (const x of [-2, 0, 2]) for (const side of [-1, 1]) {
    add(new THREE.BoxGeometry(0.22, 0.75, 0.22), m.grey, x, 1.0, side * 1.05);               // pionowa kolumna skrętu
    add(new THREE.BoxGeometry(0.9, 0.16, 0.2), m.grey, x, 0.55, side * 1.25);                // wahacz pary kół
    for (const dz of [0.95, 1.55]) { add(wheel, m.dark, x, 0.495, side * dz); add(hub, m.grey, x, 0.495, side * dz); }
  }
  // kabina: zaokrąglony profil boczny wyciągnięty na szerokość
  const side = new THREE.Shape();
  side.moveTo(-2.25, 0); side.lineTo(1.55, 0); side.quadraticCurveTo(2.3, 0, 2.3, 0.55); side.lineTo(1.95, 1.55);
  side.quadraticCurveTo(1.75, 1.85, 1.3, 1.85); side.lineTo(-1.95, 1.85); side.quadraticCurveTo(-2.25, 1.85, -2.25, 1.5); side.lineTo(-2.25, 0);
  const cab = new THREE.ExtrudeGeometry(side, { depth: 2.2, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.1, bevelSegments: 3, curveSegments: 10 });
  cab.translate(0, 0, -1.1);
  add(cab, m.white, 0, 1.15, 0);
  // okna: duża szyba przednia, dolne okna do jazdy i obserwacji gruntu, okna boczne
  add(new THREE.BoxGeometry(0.06, 0.95, 2.0), m.glass, 2.2, 2.25, 0, 0, 0, 0.34);
  for (const z of [-0.55, 0.55]) add(new THREE.BoxGeometry(0.06, 0.42, 0.75), m.glass, 2.33, 1.5, z);
  for (const z of [-1.21, 1.21]) { add(new THREE.BoxGeometry(1.3, 0.5, 0.04), m.glass, 0.95, 2.35, z); add(new THREE.BoxGeometry(0.8, 0.4, 0.04), m.glass, -0.6, 2.35, z); }
  add(new THREE.BoxGeometry(4.1, 0.14, 2.42), m.accent, -0.05, 1.75, 0);
  // śluzy skafandrów z tyłu z przypiętymi skafandrami (plecak + hełm na zewnątrz kabiny)
  for (const z of [-0.55, 0.55]) {
    add(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 28), m.grey, -2.4, 2.05, z, 0, 0, Math.PI / 2);
    add(new THREE.BoxGeometry(0.42, 0.85, 0.62), m.white, -2.68, 2.0, z);                     // plecak skafandra
    add(new THREE.SphereGeometry(0.24, 18, 12), m.white, -2.62, 2.62, z);                     // hełm
    add(new THREE.BoxGeometry(0.34, 0.6, 0.24), m.white, -2.62, 1.35, z + (z < 0 ? -0.12 : 0.12));   // nogawki zwisają do śluzy
  }
  // dach: radiator, reflektory, antena, podstawa wysięgnika kamery
  add(new THREE.BoxGeometry(2.0, 0.06, 1.7), m.panel, 0.1, 3.08, 0);
  for (const z of [-0.8, -0.27, 0.27, 0.8]) add(new THREE.BoxGeometry(0.1, 0.12, 0.28), m.lamp, 1.55, 3.07, z);
  for (const z of [-0.7, 0.7]) add(new THREE.BoxGeometry(0.06, 0.14, 0.32), m.lamp, 2.35, 0.95, z);
  add(new THREE.CylinderGeometry(0.04, 0.04, 0.8, 8), m.grey, -0.4, 3.45, 0.85);
  add(new THREE.SphereGeometry(0.26, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), m.white, -0.4, 3.85, 0.85, -0.5, 0, 0);
  add(new THREE.CylinderGeometry(0.2, 0.26, 0.35, 16), m.grey, -1.5, 3.2, 0);                // obrotowa podstawa wysięgnika
  return shadowed(g);
}
/** Mocowanie wysięgnika kamery na dachu łazika (w układzie modelu). */
export const ROVER_BOOM_PIVOT = { x: -1.5, y: 3.35 };

export const ROVER_FOOTPRINT = [[-1.9, 0, 1.9], [0, 0, 1.9], [1.9, 0, 1.9]];   // łazik ok. 5 × 3,4 m z kołami

export { habitatModel } from './habitatExterior.js';   // baza z zewnątrz
