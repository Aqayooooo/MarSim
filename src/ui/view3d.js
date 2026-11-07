// Widok 3D (three.js): teren z DEM, trasa, punkty, łazik, głazy.
// Tryby: "orbit" (przewyższenie ×10, kamera orbitalna) i "helmet" (skala 1:1, widok z hełmu EV1,
// chodzenie WASD z kolizjami: teren pod nogami, limit nachylenia, głazy, granice obszaru).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MAIN_W, MAIN_H } from './map2d.js';
import { headingDeg } from '../core/path.js';
import { t as tr } from '../i18n.js';

const EX_ORBIT = 10, EYE = 1.7, FOV = 45;
const OCHRE = new THREE.Color(1.55, 0.98, 0.66);
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export class View3D {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.t = app.world.terrain;
    this.W = this.t.widthM; this.H = this.t.heightM;
    this.mode = 'orbit';
    // przewyższenie dobrane do rzeźby: ok. 160 m pozornej wysokości (×10 dla płaskiego terenu, mniej dla stromego)
    this.exOrbit = Math.max(1, Math.min(EX_ORBIT, Math.round(160 / Math.max(1, this.t.maxH - this.t.minH))));
    this.ex = this.exOrbit;

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true });
    r.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(r.domElement);
    r.domElement.style.width = `${MAIN_W}px`;
    r.domElement.style.height = `${MAIN_H}px`;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, MAIN_W / MAIN_H, 0.2, 40000);
    this.world = new THREE.Group();          // skalowana w pionie przez przewyższenie
    this.scene.add(this.world);
    this.markers = new THREE.Group();
    this.scene.add(this.markers);

    this.#lights();
    this.#buildTerrain();
    this.#buildSky();
    this.#buildRover();
    this.rocks = [];
    this.#scatterRocks();
    this.#buildWaypoints();

    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 60;
    this.controls.maxDistance = 3000;

    this.helmet = { x: app.m.rover.x, y: app.m.rover.y, yaw: 45, pitch: -4, keys: new Set(), auto: null, warn: null, speed: 0 };
    this.#input();

    app.on('route', () => this.#buildRoute());
    app.on('obstacle', (ob) => this.#addBoulderField(ob));
    app.on('reset', () => this.reset());
    this.reset();
  }

  // ---------- budowa sceny ----------
  #lights() {
    this.scene.add(new THREE.HemisphereLight(0xffe2cc, 0x3a2418, 1.1));
    const sun = new THREE.DirectionalLight(0xfff0dc, 2.4);
    sun.position.set(-900, 700, -500);
    this.scene.add(sun);
  }

  X(x) { return x - this.W / 2; }
  Z(y) { return y - this.H / 2; }

  #buildTerrain() {
    const t = this.t, w = t.w, h = t.hgt;
    const pos = new Float32Array(w * h * 3), uv = new Float32Array(w * h * 2);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = j * w + i, x = (i + 0.5) * t.cell, y = (j + 0.5) * t.cell;
      pos[k * 3] = this.X(x); pos[k * 3 + 1] = t.h[k] - t.minH; pos[k * 3 + 2] = this.Z(y);
      uv[k * 2] = x / this.W; uv[k * 2 + 1] = y / this.H;
    }
    const idx = new Uint32Array((w - 1) * (h - 1) * 6);
    let n = 0;
    for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) {
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      idx.set([a, c, b, b, c, d], n); n += 6;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const tex = new THREE.Texture(this.app.world.rasters.optical.image);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    this.terrainMat = new THREE.MeshLambertMaterial({ map: tex, color: OCHRE.clone() });
    this.terrainMesh = new THREE.Mesh(g, this.terrainMat);
    this.world.add(this.terrainMesh);
  }

  #buildSky() {
    const c = document.createElement('canvas'); c.width = 4; c.height = 256;
    const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#271910'); gr.addColorStop(0.62, '#845738'); gr.addColorStop(1, '#9a6a48');
    g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
    this.skyTex = new THREE.CanvasTexture(c);
    this.skyTex.colorSpace = THREE.SRGBColorSpace;
    this.orbitBg = new THREE.Color('#2C1C14');
  }

  #buildRover() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.2, 2.2), new THREE.MeshLambertMaterial({ color: 0xe8e2d8 }));
    body.position.y = 1.1;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(3.25, 0.25, 2.25), new THREE.MeshLambertMaterial({ color: 0xf17778 }));
    stripe.position.y = 1.5;
    g.add(body, stripe);
    for (const [x, z] of [[-1.1, -1.2], [1.1, -1.2], [-1.1, 1.2], [1.1, 1.2]]) {
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.35, 14), new THREE.MeshLambertMaterial({ color: 0x2a2420 }));
      wh.rotation.x = Math.PI / 2; wh.position.set(x, 0.45, z); g.add(wh);
    }
    this.roverMesh = g;
    this.scene.add(g);
    this.roverSprite = this.#markerSprite(tr('map.rover'), '#F17778');
    this.markers.add(this.roverSprite);
  }

  #markerSprite(text, color = '#FFDC52', filled = false) {
    const c = document.createElement('canvas'); c.width = 200; c.height = 56;
    const g = c.getContext('2d');
    g.font = "700 22px 'JetBrains Mono', Consolas, monospace";
    const tw = g.measureText(text).width;
    g.fillStyle = '#000'; g.fillRect(36, 4, tw + 14, 30);
    g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(text, 43, 20);
    g.beginPath(); g.moveTo(20, 26); g.lineTo(31, 37); g.lineTo(20, 48); g.lineTo(9, 37); g.closePath();
    g.fillStyle = filled ? color : '#000'; g.fill(); g.lineWidth = 4; g.strokeStyle = color; g.stroke();
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false }));
    s.center.set(20 / 200, 1 - 37 / 56);
    const k = 2 * Math.tan(FOV / 2 * Math.PI / 180) / MAIN_H;
    s.scale.set(150 * k, 42 * k, 1);
    s.renderOrder = 10;
    return s;
  }

  #buildWaypoints() {
    this.wpObjs = this.app.m.waypoints.map((wp) => {
      const sprite = this.#markerSprite(wp.id);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.6, 6), new THREE.MeshBasicMaterial({ color: 0xffdc52 }));
      this.markers.add(sprite, pole);
      return { wp, sprite, pole };
    });
  }

  #scatterRocks() {
    const rnd = mulberry(7);
    for (let n = 0; n < 1400; n++) {
      const x = rnd() * this.W, y = rnd() * this.H;
      const haz = this.app.world.rasters.hazards.sample(x, y);
      if (haz === 2 && rnd() < 0.9) continue;            // mało kamieni na piasku
      const r = 0.12 + rnd() ** 3 * 0.55;
      this.rocks.push({ x, y, r, rot: rnd() * 6.28, collide: r > 0.35 });
    }
    // prawdziwe głazy wykryte metodą cieni (średnica i wysokość z pomiaru); pewne — z kolizją
    for (const b of this.app.world.rasters.boulders?.boulders || []) {
      this.rocks.push({ x: b.x, y: b.y, r: b.diameterM / 2, h: Math.max(0.3, b.heightM), rot: rnd() * 6.28, collide: b.confidence >= 0.5, real: true });
    }
    this.#rebuildRocks();
  }

  #addBoulderField(ob) {
    const rnd = mulberry(Math.round(ob.x * 13 + ob.y));
    for (let n = 0; n < 220; n++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * ob.radiusM;
      const r = 0.35 + rnd() ** 2 * 1.4;
      this.rocks.push({ x: ob.x + Math.cos(a) * d, y: ob.y + Math.sin(a) * d, r, rot: rnd() * 6.28, collide: true, field: true });
    }
    this.#rebuildRocks();
  }

  #rebuildRocks() {
    if (this.rockMesh) { this.scene.remove(this.rockMesh); this.rockMesh.geometry.dispose(); }
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const m = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0x7a5038 }), this.rocks.length);
    this.rockMesh = m;
    this.scene.add(m);
    this.#placeRocks();
  }
  #placeRocks() {
    const m = this.rockMesh, o = new THREE.Object3D();
    this.rocks.forEach((rk, i) => {
      o.position.set(this.X(rk.x), this.t.height(rk.x, rk.y) * this.ex + rk.r * 0.25, this.Z(rk.y));
      o.rotation.set(rk.rot, rk.rot * 1.7, 0);
      o.scale.set(rk.r, rk.h ? rk.h / 1.6 : rk.r * 0.7, rk.r * 0.9);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    m.visible = this.mode === 'helmet';
  }

  #ribbon(pts, width, lift, color, opacity) {
    const dense = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(L / 2));
      for (let s = 0; s < n; s++) dense.push({ x: a.x + (b.x - a.x) * s / n, y: a.y + (b.y - a.y) * s / n });
    }
    dense.push(pts[pts.length - 1]);
    const pos = new Float32Array(dense.length * 6), idx = [];
    dense.forEach((p, i) => {
      const a = dense[Math.max(0, i - 1)], b = dense[Math.min(dense.length - 1, i + 1)];
      let dx = b.x - a.x, dy = b.y - a.y; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const nx = -dy * width / 2, ny = dx * width / 2;
      for (const [k, sx, sy] of [[0, p.x + nx, p.y + ny], [1, p.x - nx, p.y - ny]]) {
        pos.set([this.X(sx), this.t.height(sx, sy) + lift, this.Z(sy)], (i * 2 + k) * 3);
      }
      if (i > 0) { const q = (i - 1) * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    return new THREE.Mesh(g, mat);
  }

  #buildRoute() {
    for (const m of this.routeMeshes || []) { this.world.remove(m); m.geometry.dispose(); }
    const r = this.app.state.route;
    this.routeMeshes = [];
    if (!r) return;
    const pts = r.poly.pts;
    this.routeOrbit = [this.#ribbon(pts, 11, 0.7, 0x1a0f05, 0.75), this.#ribbon(pts, 6, 0.9, 0xffdc52, 1)];
    this.routeHelmet = [this.#ribbon(pts, 0.9, 0.05, 0xe0af3b, 0.5)];
    this.routeMeshes = [...this.routeOrbit, ...this.routeHelmet];
    this.world.add(...this.routeMeshes);
    this.#applyMode();
  }

  // ---------- tryby ----------
  reset() {
    this.flight = null;
    this.helmet.auto = null;
    this.terrainMat.color.copy(OCHRE);
    this.#buildRoute();
    this.rocks = this.rocks.filter((r) => !r.field);
    if (this.rockMesh) this.#rebuildRocks();
    this.setMode('orbit', { keepCamera: false });
  }

  setMode(mode, { keepCamera = true } = {}) {
    const first = this.mode !== mode || !keepCamera;
    this.mode = mode;
    this.ex = mode === 'helmet' ? 1 : this.exOrbit;
    this.#applyMode();
    if (mode === 'orbit' && first && !this.flight) this.#defaultOrbit();
    if (mode === 'helmet' && first && !this.helmet.auto) this.#placeHelmetAtCrew();
  }

  #applyMode() {
    const helmet = this.mode === 'helmet';
    this.world.scale.y = this.ex;
    this.scene.background = helmet ? this.skyTex : this.orbitBg;
    this.scene.fog = helmet ? new THREE.Fog(0x8a5c3c, 250, 1700) : null;
    (this.routeOrbit || []).forEach((m) => (m.visible = !helmet));
    (this.routeHelmet || []).forEach((m) => (m.visible = helmet));
    this.controls.enabled = !helmet && !this.flight;
    this.camera.near = helmet ? 0.1 : 2;
    this.camera.updateProjectionMatrix();
    if (this.rockMesh) this.#placeRocks();
    this.#placeMarkers();
  }

  #placeMarkers() {
    const helmet = this.mode === 'helmet', st = this.app.state;
    for (const o of this.wpObjs) {
      const h = this.t.height(o.wp.x, o.wp.y) * this.ex;
      o.pole.visible = helmet && !!st.route;
      o.sprite.visible = !!st.route;
      o.pole.position.set(this.X(o.wp.x), h + 1.3, this.Z(o.wp.y));
      o.sprite.position.set(this.X(o.wp.x), h + (helmet ? 2.7 : 4), this.Z(o.wp.y));
    }
    const rp = this.app.sim.roverPos();
    const rh = this.t.height(rp.x, rp.y) * this.ex;
    this.roverMesh.position.set(this.X(rp.x), rh, this.Z(rp.y));
    this.roverMesh.visible = helmet;
    this.roverSprite.position.set(this.X(rp.x), rh + (helmet ? 3 : 4), this.Z(rp.y));
  }

  #center() {
    const r = this.app.state.route;
    if (!r) return { x: this.W / 2, y: this.H / 2 };
    let sx = 0, sy = 0; for (const p of r.poly.pts) { sx += p.x; sy += p.y; }
    return { x: sx / r.poly.pts.length, y: sy / r.poly.pts.length };
  }
  #setSpherical(target, r, phi, theta) {
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(target.x + r * Math.sin(phi) * Math.sin(theta), target.y + r * Math.cos(phi), target.z + r * Math.sin(phi) * Math.cos(theta));
    this.camera.lookAt(target);
  }
  #defaultOrbit() {
    const c = this.#center(), tgt = new THREE.Vector3(this.X(c.x), this.t.height(c.x, c.y) * this.ex, this.Z(c.y));
    this.controls.target.copy(tgt);
    this.#setSpherical(tgt, 1150, 0.95, 0.35);
    this.controls.update();
  }

  /** Przelot jak w nagraniu: z góry (kadr mapy 2D) → pochylenie, obrót i obniżenie. */
  flyover(dur = 7.5) {
    this.setMode('orbit');
    const midH = (this.t.maxH - this.t.minH) / 2 * this.ex;
    const startTarget = new THREE.Vector3(0, midH, 0);
    const c = this.#center(), endTarget = new THREE.Vector3(this.X(c.x), this.t.height(c.x, c.y) * this.ex, this.Z(c.y));
    const r0 = (this.H / 2) / Math.tan(FOV / 2 * Math.PI / 180);
    this.flight = { t: 0, dur, startTarget, endTarget, r0 };
    this.terrainMat.color.setRGB(1, 1, 1);
    this.controls.enabled = false;
    this.#flightStep(0);
  }
  #flightStep(dt) {
    const f = this.flight;
    f.t += dt;
    const k = clamp01(f.t / f.dur);
    const tex = clamp01(f.t / 0.6);
    this.terrainMat.color.setRGB(1 + (OCHRE.r - 1) * tex, 1 + (OCHRE.g - 1) * tex, 1 + (OCHRE.b - 1) * tex);
    const m = ease(clamp01((f.t - 0.6) / (f.dur - 0.6)));
    const tgt = f.startTarget.clone().lerp(f.endTarget, m);
    this.#setSpherical(tgt, f.r0 + (720 - f.r0) * m, 0.02 + (1.08 - 0.02) * m, 0.9 * m);
    if (k >= 1) { this.controls.target.copy(tgt); this.flight = null; this.controls.enabled = true; this.controls.update(); }
  }

  #placeHelmetAtCrew() {
    const sim = this.app.sim, p = this.app.state.crewVisible ? sim.crewPos(0) : { x: this.app.m.rover.x + 6, y: this.app.m.rover.y - 6 };
    Object.assign(this.helmet, { x: p.x, y: p.y, pitch: -4 });
    const next = this.app.m.waypoints[Math.min(sim.nextWp, this.app.m.waypoints.length - 1)];
    this.helmet.yaw = headingDeg(next.x - p.x, next.y - p.y);
  }

  /** Automatyczny marsz po trasie (timelapse), np. powrót z WP2 do WP1. */
  autoWalk({ fromS, toS, timelapse = 15 }) {
    this.setMode('helmet');
    this.helmet.auto = { s: fromS, toS, dir: Math.sign(toS - fromS) || -1, v: this.app.m.eva.walkKmh / 3.6 * timelapse, timelapse };
    const p = this.app.state.route.poly.at(fromS);
    Object.assign(this.helmet, { x: p.x, y: p.y, pitch: -6, yaw: this.app.state.route.poly.heading(fromS, this.helmet.auto.dir) });
  }

  // ---------- sterowanie w hełmie ----------
  #input() {
    const el = this.renderer.domElement, h = this.helmet;
    let drag = null;
    el.addEventListener('pointerdown', (e) => { if (this.mode === 'helmet') { drag = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); } });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      h.yaw = (h.yaw - (e.clientX - drag.x) * 0.25 + 360) % 360;
      h.pitch = Math.max(-60, Math.min(45, h.pitch + (e.clientY - drag.y) * 0.2));
      drag = { x: e.clientX, y: e.clientY };
      h.auto = null;
    });
    el.addEventListener('pointerup', () => { drag = null; });
    const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'];
    addEventListener('keydown', (e) => { if (this.mode === 'helmet' && keys.includes(e.code)) { h.keys.add(e.code); h.auto = null; e.preventDefault(); } });
    addEventListener('keyup', (e) => h.keys.delete(e.code));
    addEventListener('blur', () => h.keys.clear());
  }

  /** Ruch z kolizjami. Zwraca powód zatrzymania albo null. */
  #tryMove(dx, dy) {
    const h = this.helmet, t = this.t, max = this.app.m.eva.maxSlopeDeg;
    let nx = h.x + dx, ny = h.y + dy;
    if (!t.inside(nx, ny, 3)) return 'KONIEC OBSZARU MAPY';
    const d = Math.hypot(dx, dy);
    const rise = t.height(nx, ny) - t.height(h.x, h.y);
    const ang = Math.atan2(rise, d) * 180 / Math.PI;
    if (rise > 0 && ang > max) return tr('hud.steep', { a: Math.round(ang) });
    for (const rk of this.rocks) {
      if (!rk.collide) continue;
      const ex = nx - rk.x, ey = ny - rk.y, dd = Math.hypot(ex, ey), min = rk.r + 0.35;
      if (dd < min) { nx = rk.x + (ex / (dd || 1)) * min; ny = rk.y + (ey / (dd || 1)) * min; }
    }
    if (Math.hypot(nx - h.x - dx, ny - h.y - dy) > 0.001 && Math.hypot(nx - h.x, ny - h.y) < d * 0.3) return tr('hud.boulder');
    h.x = nx; h.y = ny;
    return null;
  }

  #helmetStep(dt) {
    const h = this.helmet, k = h.keys;
    h.warn = null;
    h.speed = 0;
    if (h.auto) {
      const a = h.auto, poly = this.app.state.route.poly;
      a.s += a.dir * a.v * dt;
      if ((a.dir < 0 && a.s <= a.toS) || (a.dir > 0 && a.s >= a.toS)) a.s = a.toS;
      const p = poly.at(a.s);
      h.x = p.x; h.y = p.y;
      const target = poly.heading(a.s, a.dir);
      let d = ((target - h.yaw + 540) % 360) - 180;
      h.yaw = (h.yaw + d * Math.min(1, dt * 3) + 360) % 360;
      h.speed = a.v / a.timelapse * 3.6;
    } else {
      const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
      const side = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
      const turn = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0);
      h.yaw = (h.yaw + turn * 70 * dt + 360) % 360;
      if (fwd || side) {
        const run = k.has('ShiftLeft') || k.has('ShiftRight') ? 8 : 1;
        const v = 1.4 * run, y = h.yaw * Math.PI / 180;
        const fx = Math.sin(y), fy = -Math.cos(y), rx = Math.cos(y), ry = Math.sin(y);
        let mx = (fx * fwd + rx * side), my = (fy * fwd + ry * side);
        const L = Math.hypot(mx, my); mx = mx / L * v * dt; my = my / L * v * dt;
        const steps = Math.max(1, Math.ceil(Math.hypot(mx, my) / 0.4));
        for (let i = 0; i < steps; i++) { const w = this.#tryMove(mx / steps, my / steps); if (w) { h.warn = w; break; } }
        h.speed = v * 3.6;
      }
    }
    const ground = this.t.height(h.x, h.y);
    const y = h.yaw * Math.PI / 180, p = h.pitch * Math.PI / 180;
    this.camera.position.set(this.X(h.x), ground + EYE, this.Z(h.y));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.X(h.x) + Math.sin(y) * Math.cos(p), ground + EYE + Math.sin(p), this.Z(h.y) - Math.cos(y) * Math.cos(p));
  }

  /** Dane dla HUD hełmu. */
  hudInfo() {
    const h = this.helmet, app = this.app, wps = app.m.waypoints;
    let target, dist;
    if (h.auto) {
      const idx = wps.findIndex((_, i) => Math.abs(app.state.route.wpS[i] - h.auto.toS) < 1);
      target = wps[idx]?.id || 'CEL'; dist = Math.abs(h.auto.s - h.auto.toS);
    } else {
      const wp = wps[Math.min(app.sim.nextWp, wps.length - 1)];
      target = wp.id; dist = Math.hypot(wp.x - h.x, wp.y - h.y);
    }
    const haz = app.world.rasters.hazards.sample(h.x, h.y);
    return {
      heading: Math.round(h.yaw) % 360, target, dist, speed: h.speed,
      slope: this.t.slope(h.x, h.y), zone: haz, warn: h.warn, timelapse: h.auto?.timelapse ?? 1,
    };
  }

  /** Render widoku z poziomu gruntu w punkcie (do karty „Widok w WP”). */
  snapshot(at, headingDegValue, w = 572, h = 324) {
    const saved = { mode: this.mode, pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), aspect: this.camera.aspect, hx: this.helmet.x, hy: this.helmet.y, yaw: this.helmet.yaw, pitch: this.helmet.pitch, auto: this.helmet.auto, flight: this.flight };
    const size = this.renderer.getSize(new THREE.Vector2()), pr = this.renderer.getPixelRatio();
    this.flight = null;
    this.mode = 'helmet'; this.ex = 1; this.#applyMode();
    Object.assign(this.helmet, { x: at.x, y: at.y, yaw: headingDegValue, pitch: -7, auto: null });
    this.#helmetStep(0);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/jpeg', 0.88);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(size.x, size.y, false);
    this.camera.aspect = saved.aspect; this.camera.updateProjectionMatrix();
    Object.assign(this.helmet, { x: saved.hx, y: saved.hy, yaw: saved.yaw, pitch: saved.pitch, auto: saved.auto });
    this.flight = saved.flight;
    this.mode = saved.mode; this.ex = saved.mode === 'helmet' ? 1 : this.exOrbit; this.#applyMode();
    this.camera.position.copy(saved.pos); this.camera.quaternion.copy(saved.quat);
    return url;
  }

  resize(scale) {
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(Math.round(MAIN_W * scale), Math.round(MAIN_H * scale), false);
    this.camera.aspect = MAIN_W / MAIN_H;
    this.camera.updateProjectionMatrix();
  }

  render(dt) {
    this.#placeMarkers();
    if (this.mode === 'helmet') this.#helmetStep(dt);
    else if (this.flight) this.#flightStep(dt);
    else this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
