// Widok 3D (three.js): teren z DEM, trasa, punkty, łazik, głazy.
// Tryby: "orbit" (przewyższenie ×10, kamera orbitalna) i "helmet" (skala 1:1, widok z hełmu EV1,
// chodzenie WASD z kolizjami: teren pod nogami, limit nachylenia, głazy, granice obszaru).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MAIN_W, MAIN_H } from './map2d.js';
import { headingDeg } from '../core/path.js';
import { t as tr } from '../i18n.js';
import { clearings, makeRocks, mulberry } from '../core/rocks.js';
import { HelmetInterior } from './helmetInterior.js';
import { HABITAT_FOOTPRINT } from '../core/habitat.js';
import { HabitatView } from './habitatView.js';
import { FOG_COLOR, ROVER_BOOM_PIVOT, ROVER_FOOTPRINT, Pebbles, approxSun, detailTexture, habitatModel, orbitBackground, reliefColors, rockColor, rockGeometries, roverModel, skyDome, sunVector, terrainBlock, terrainMaterial } from './marsLook.js';

const EX_ORBIT = 10, EYE = 1.7, FOV = 45;
// chodzenie w hełmie jak w grze: tempo ×1…×32 (kółko, + −), bieg (Shift), skok (spacja) w grawitacji Marsa
export const WALK_MS = 2.0, PACE_LEVELS = [1, 2, 4, 8, 16, 32], SPRINT = 3;
const G_MARS = 3.71, JUMP_MS = 2.2, ACCEL = 9, LOOK_SENS = 0.12;
// ręczna jazda łazikiem (F w hełmie): rozstaw osi jak w NASA SEV, kamera na obrotowym, wysuwanym wysięgniku na dachu
const RIDE_WHEELBASE = 4, RIDE_RADIUS = 2.2, RIDE_MAX_SLOPE = 30, RIDE_REACH_M = 8, BOOM_MIN = 6, BOOM_MAX = 18;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
/** Koła (x, z, r) z układu modelu → plan (środek cx, cy; obrót wokół pionu). */
const rotate = (list, cx, cy, angle) => list.map(([x, z, r]) => ({
  x: cx + x * Math.cos(angle) + z * Math.sin(angle), y: cy - x * Math.sin(angle) + z * Math.cos(angle), r, collide: true,
}));


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
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.detail = detailTexture();
    this.detail.repeat.set(2, 2);
    el.appendChild(r.domElement);
    r.domElement.style.width = `${MAIN_W}px`;
    r.domElement.style.height = `${MAIN_H}px`;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, MAIN_W / MAIN_H, 0.2, 40000);
    this.interior = new HelmetInterior(this.camera);
    this.scene.add(this.camera);
    this.world = new THREE.Group();          // skalowana w pionie przez przewyższenie
    this.scene.add(this.world);
    this.markers = new THREE.Group();
    this.scene.add(this.markers);

    this.#lights();
    this.#buildTerrain();
    this.#buildSky();
    this.#buildRover();
    this.rocks = [];
    this.rockGeos = rockGeometries(3);
    this.rockMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, bumpMap: this.detail, bumpScale: 2.5 });
    this.#scatterRocks();
    this.pebbles = new Pebbles({ terrain: this.t, sand: app.world.rasters.sand, X: (x) => this.X(x), Z: (y) => this.Z(y), material: this.rockMat });
    this.scene.add(this.pebbles.mesh);
    this.#buildWaypoints();
    const boomMat = new THREE.MeshStandardMaterial({ color: 0x6b655e, roughness: 0.45, metalness: 0.6 });
    this.boom = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.08, 1, 10), boomMat);   // długość: skala y
    this.boomHead = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.26, 0.3), boomMat);
    this.boom.castShadow = this.boomHead.castShadow = true;
    this.boom.visible = this.boomHead.visible = false;
    this.scene.add(this.boom, this.boomHead);
    this.ride = null;
    this.flash = null;   // krótki komunikat na wizjerze (np. „łazik za daleko”)

    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 60;
    this.controls.maxDistance = 3000;

    this.helmet = { x: app.m.rover.x, y: app.m.rover.y, yaw: 45, pitch: -4, keys: new Set(), auto: null, warn: null, speed: 0,
      pace: 0, vx: 0, vy: 0, z: 0, vz: 0, bob: 0, jump: false };
    this.chase = { yawOff: 0, pitch: 20, dist: 22, cabin: false };    // kamera jazdy łazikiem (mysz: obrót, kółko: odległość, C: kabina)
    this.#input();

    app.on('route', () => this.#buildRoute());
    app.on('waypoints', () => this.#buildWaypoints());
    app.on('drive', () => this.#buildDriveRoute());
    app.on('obstacle', (ob) => this.#addBoulderField(ob));
    app.on('reset', () => this.reset());
    this.reset();
  }

  // ---------- budowa sceny ----------
  #lights() {
    this.hemi = new THREE.HemisphereLight(0xffe0c4, 0x3b2519, 0.85);
    const sun = this.sun = new THREE.DirectionalLight(0xfff0dc, 2.25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    this.scene.add(this.hemi, sun, sun.target);
  }

  /** Słońce z zegara misji (backend: położenie z modelu; bez serwera: przybliżenie), cień wokół obserwatora albo całego obszaru. */
  #syncSun() {
    const env = this.app.sim.snap?.env;
    const s = env?.sunAzDeg != null ? { az: env.sunAzDeg, el: env.sunElevDeg } : approxSun(this.app.sim.min / 60, this.app.m.area?.center?.lat ?? 0);
    const dir = sunVector(s.az, s.el), ground = this.mode === 'helmet' || this.mode === 'drive';
    this.sky.uniforms.uSun.value.copy(dir);
    const half = ground ? 45 : Math.max(this.W, this.H) * 0.62, dist = ground ? 300 : 2500;
    let c;
    if (ground) {   // środek cienia na siatce tekseli i na gruncie: cień nie drga przy kroku ani przy obracaniu głowy
      const texel = (2 * half) / this.sun.shadow.mapSize.x, p = this.camera.position;
      const x = Math.round(p.x / texel) * texel, z = Math.round(p.z / texel) * texel;
      c = new THREE.Vector3(x, this.t.height(x + this.W / 2, z + this.H / 2), z);
    } else c = new THREE.Vector3(0, (this.t.maxH - this.t.minH) / 2 * this.ex, 0);
    this.sun.target.position.copy(c);
    this.sun.position.set(c.x + dir.x * dist, c.y + dir.y * dist, c.z + dir.z * dist);
    this.sun.shadow.normalBias = ground ? 0.05 : 2.5;
    const cam = this.sun.shadow.camera;
    if (cam.right !== half) {
      Object.assign(cam, { left: -half, right: half, top: half, bottom: -half, near: 1, far: dist * 2 + 600 });
      cam.updateProjectionMatrix();
    }
  }

  /** Stan sceny zależny od kamery: niebo, słońce, kamyki wokół obserwatora. */
  #syncFrame() {
    this.sky.mesh.position.copy(this.camera.position);
    this.#syncSun();
    if (this.mode === 'helmet') { const p = this.ride ? this.app.roverPos() : this.helmet; this.pebbles.update(p.x, p.y); }
    else if (this.mode === 'drive') { const p = this.app.roverPos(); this.pebbles.update(p.x, p.y); }
  }

  X(x) { return x - this.W / 2; }
  Z(y) { return y - this.H / 2; }

  #buildTerrain() {
    const t = this.t, w = t.w, h = t.hgt;
    const pos = new Float32Array(w * h * 3), uv = new Float32Array(w * h * 2), uv1 = new Float32Array(w * h * 2);
    const DETAIL_TILE_M = 3.2;   // jeden kafelek tekstury detalu na tyle metrów gruntu
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = j * w + i, x = (i + 0.5) * t.cell, y = (j + 0.5) * t.cell;
      pos[k * 3] = this.X(x); pos[k * 3 + 1] = t.h[k] - t.minH; pos[k * 3 + 2] = this.Z(y);
      uv[k * 2] = x / this.W; uv[k * 2 + 1] = y / this.H;
      uv1[k * 2] = x / DETAIL_TILE_M; uv1[k * 2 + 1] = y / DETAIL_TILE_M;
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
    g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
    g.setAttribute('color', new THREE.BufferAttribute(reliefColors(t), 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const tex = new THREE.Texture(this.app.world.rasters.optical.image);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    const detail = this.detail.clone();
    detail.repeat.set(1, 1);
    detail.channel = 1;
    detail.needsUpdate = true;
    const { mat, uniforms } = terrainMaterial(tex, detail);
    this.terrainMat = mat;
    this.terrainU = uniforms;
    this.terrainMesh = new THREE.Mesh(g, this.terrainMat);
    this.terrainMesh.castShadow = true;
    this.terrainMesh.receiveShadow = true;
    this.world.add(this.terrainMesh);
    this.block = terrainBlock(t, (x) => this.X(x), (y) => this.Z(y));   // ściany i cień bloku — tylko w widoku orbitalnym
    this.world.add(this.block);
  }

  #buildSky() {
    this.sky = skyDome();
    this.scene.add(this.sky.mesh);
    this.orbitBg = orbitBackground();
  }

  #buildRover() {
    this.roverMesh = roverModel();
    this.scene.add(this.roverMesh);
    this.roverSprite = this.#markerSprite(tr('map.rover'), '#F17778');
    this.markers.add(this.roverSprite);
    const hab = this.app.m.habitat;
    if (hab) {
      this.habitatMesh = habitatModel(hab.mastM ?? 10);
      this.habitatMesh.rotation.y = 0.35;
      this.scene.add(this.habitatMesh);
      this.habitatSprite = this.#markerSprite(tr('map.habitat'), '#FFFFFF');
      this.markers.add(this.habitatSprite);
      this.hab = new HabitatView(this.app, this.habitatMesh);   // wnętrze, śluza i stanowiska (E)
    }
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
    for (const o of this.wpObjs || []) { this.markers.remove(o.sprite, o.pole); o.sprite.material.map.dispose(); o.sprite.material.dispose(); }
    this.wpObjs = this.app.m.waypoints.map((wp) => {
      const sprite = this.#markerSprite(wp.id);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.6, 6), new THREE.MeshBasicMaterial({ color: 0xffdc52 }));
      this.markers.add(sprite, pole);
      return { wp, sprite, pole };
    });
  }

  #scatterRocks() {
    // ta sama lista co w planerze jazdy łazikiem (core/rocks.js) — trasa omija dokładnie to, co widać
    const w = this.app.world;
    this.rocks = makeRocks({ W: this.W, H: this.H, hazards: w.rasters.hazards, boulders: w.rasters.boulders, keepClear: clearings(this.app.m) });
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
    for (const m of this.rockMeshes || []) { this.scene.remove(m); m.dispose(); }
    const groups = this.rockGeos.map(() => []);
    this.rocks.forEach((rk, i) => groups[i % groups.length].push(rk));   // kilka kształtów kamieni na zmianę
    this.rockMeshes = groups.map((list, v) => {
      const m = new THREE.InstancedMesh(this.rockGeos[v], this.rockMat, Math.max(1, list.length));
      m.count = list.length;
      m.castShadow = m.receiveShadow = true;
      m.userData.rocks = list;
      list.forEach((rk, i) => m.setColorAt(i, rockColor(mulberry(Math.round(rk.x * 31 + rk.y * 17)))));
      this.scene.add(m);
      return m;
    });
    this.#placeRocks();
  }
  #placeRocks() {
    const o = new THREE.Object3D();
    for (const m of this.rockMeshes) {
      m.userData.rocks.forEach((rk, i) => {
        o.position.set(this.X(rk.x), this.t.height(rk.x, rk.y) * this.ex + rk.r * 0.15, this.Z(rk.y));
        o.rotation.set(rk.rot * 0.2, rk.rot * 1.7, rk.rot * 0.1);
        o.scale.set(rk.r, rk.h ? rk.h / 1.25 : rk.r * 0.75, rk.r * 0.9);
        o.updateMatrix();
        m.setMatrixAt(i, o.matrix);
      });
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.visible = this.mode === 'helmet' || this.mode === 'drive';
    }
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

  // trasa A→B jazdy łazikiem (turkusowa, jak na mapie 2D)
  #buildDriveRoute() {
    for (const m of this.driveMeshes || []) { this.world.remove(m); m.geometry.dispose(); }
    this.driveMeshes = []; this.driveOrbit = []; this.driveNear = [];
    const d = this.app.drive;
    if (d && d.poly.pts.length > 1) {
      const pts = d.poly.pts;
      this.driveOrbit = [this.#ribbon(pts, 9, 0.8, 0x04201c, 0.7), this.#ribbon(pts, 5, 1.0, 0x5ee6d0, 1)];
      this.driveNear = [this.#ribbon(pts, 2.4, 0.06, 0x5ee6d0, 0.55)];
      this.driveMeshes = [...this.driveOrbit, ...this.driveNear];
      this.world.add(...this.driveMeshes);
    }
    this.#applyMode();
  }

  // ---------- tryby ----------
  reset() {
    this.flight = null;
    this.helmet.auto = null;
    this.terrainU.uMars.value = 1;
    this.#buildRoute();
    this.#buildDriveRoute();
    this.rocks = this.rocks.filter((r) => !r.field);
    if (this.rockMeshes) this.#rebuildRocks();
    this.setMode('orbit', { keepCamera: false });
  }

  /** Przewyższenie dla trybu: z poziomu gruntu (hełm, jazda) skala 1:1, z orbity — przewyższone. */
  #exFor(mode) { return mode === 'helmet' || mode === 'drive' ? 1 : this.exOrbit; }

  setMode(mode, { keepCamera = true } = {}) {
    const first = this.mode !== mode || !keepCamera;
    this.mode = mode;
    if (mode !== 'helmet') {
      if (this.ride) this.#exitRide();
      this.helmet.keys.clear();
      Object.assign(this.helmet, { vx: 0, vy: 0, z: 0, vz: 0, jump: false });
      if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock?.();
    }
    this.ex = this.#exFor(mode);
    if (mode === 'drive') this.camYaw = undefined;
    this.#applyMode();
    if (mode === 'orbit' && first && !this.flight) this.#defaultOrbit();
    if (mode === 'helmet' && first && !this.helmet.auto) this.#placeHelmetAtCrew();
    this.resize(this.renderScale ?? 1);
  }

  #applyMode() {
    const ground = this.mode === 'helmet' || this.mode === 'drive';   // widok z poziomu gruntu, skala 1:1
    this.world.scale.y = this.ex;
    this.scene.background = ground ? null : this.orbitBg;
    this.scene.fog = ground ? new THREE.Fog(FOG_COLOR, 220, 2400) : null;
    this.sky.mesh.visible = ground;
    this.block.visible = !ground;
    this.pebbles.mesh.visible = ground;
    this.terrainMat.bumpScale = ground ? 1.4 : 0;   // detal gruntu tylko z bliska
    this.terrainU.uDetail.value = ground ? 1 : 0;
    (this.routeOrbit || []).forEach((m) => (m.visible = !ground));
    (this.routeHelmet || []).forEach((m) => (m.visible = ground));
    (this.driveOrbit || []).forEach((m) => (m.visible = !ground));
    (this.driveNear || []).forEach((m) => (m.visible = ground));
    this.controls.enabled = !ground && !this.flight;
    this.camera.fov = this.mode === 'helmet' ? 64 : FOV;
    this.camera.near = this.mode === 'helmet' ? .1 : ground ? .15 : 2;
    this.camera.far = ground ? 16000 : 40000;   // węższy zakres głębi z gruntu: bez migotania stykających się powierzchni
    this.interior.setVisible(this.mode === 'helmet' && !this.ride);
    this.camera.updateProjectionMatrix();
    if (this.rockMeshes) this.#placeRocks();
    this.#placeMarkers();
  }

  #placeMarkers() {
    const helmet = this.mode === 'helmet', st = this.app.state;
    const walls = helmet && this.hab?.indoors && this.hab.zone.id !== 'ramp';   // w habitacie etykiety nie prześwitują przez ściany
    for (const o of this.wpObjs) {
      const h = this.t.height(o.wp.x, o.wp.y) * this.ex;
      o.pole.visible = helmet && !!st.route;
      o.sprite.visible = !!st.route && !walls;
      o.pole.position.set(this.X(o.wp.x), h + 1.3, this.Z(o.wp.y));
      o.sprite.position.set(this.X(o.wp.x), h + (helmet ? 2.7 : 4), this.Z(o.wp.y));
    }
    const drive = this.mode === 'drive';
    const rp = this.app.roverPos();
    const rh = this.t.height(rp.x, rp.y) * this.ex;
    this.roverMesh.position.set(this.X(rp.x), rh, this.Z(rp.y));
    const cabin = (drive && this.chase.cabin) || this.ride?.cabin;
    this.roverMesh.visible = (helmet || drive) && !cabin;   // z kabiny łazika nie widać jego bryły
    const hab = this.app.m.habitat;
    if (this.habitatMesh) {
      const hh = this.t.height(hab.x, hab.y) * this.ex;
      this.habitatMesh.position.set(this.X(hab.x), hh, this.Z(hab.y));
      this.habitatMesh.visible = helmet || drive;
      this.habitatSprite.visible = (helmet && !(this.hab?.dist < 25)) || drive;   // z orbity etykieta nachodziłaby na łazik; z bliska zasłaniałaby śluzę
      this.habitatSprite.position.set(this.X(hab.x), hh + 7, this.Z(hab.y));
    }
    const heading = this.app.drive ? (drive && this.camYaw !== undefined ? this.camYaw : this.app.drive.heading()) : this.ride ? this.ride.heading : null;
    if (heading !== null) {
      let pitch = 0, roll = 0;
      if (this.ex === 1) {   // z gruntu łazik pochyla się razem z terenem (wzdłuż i w poprzek)
        const a = heading * Math.PI / 180, fx = Math.sin(a), fy = -Math.cos(a), rx = Math.cos(a), ry = Math.sin(a), H = (dx, dy) => this.t.height(rp.x + dx, rp.y + dy);
        pitch = Math.atan2(H(fx * 2.2, fy * 2.2) - H(-fx * 2.2, -fy * 2.2), 4.4);
        roll = Math.atan2(H(rx * 1.3, ry * 1.3) - H(-rx * 1.3, -ry * 1.3), 2.6);
      }
      this.roverMesh.rotation.set(-roll, Math.PI / 2 - heading * Math.PI / 180, pitch, 'YZX');
    }
    this.roverSprite.visible = !drive && !walls;
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
    this.#setSpherical(tgt, 1380, 0.98, 0.35);
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
    this.terrainU.uMars.value = 0;   // start jak na mapie 2D: samo zdjęcie, potem barwy Marsa
    this.controls.enabled = false;
    this.#flightStep(0);
  }
  #flightStep(dt) {
    const f = this.flight;
    f.t += dt;
    const k = clamp01(f.t / f.dur);
    this.terrainU.uMars.value = clamp01(f.t / 0.6);
    const m = ease(clamp01((f.t - 0.6) / (f.dur - 0.6)));
    const tgt = f.startTarget.clone().lerp(f.endTarget, m);
    this.#setSpherical(tgt, f.r0 + (720 - f.r0) * m, 0.02 + (1.08 - 0.02) * m, 0.9 * m);
    if (k >= 1) { this.controls.target.copy(tgt); this.flight = null; this.controls.enabled = true; this.controls.update(); }
  }

  #placeHelmetAtCrew() {
    const sim = this.app.sim, p = this.app.state.crewVisible ? sim.crewPos(0) : { x: this.app.m.rover.x + 6, y: this.app.m.rover.y - 6 };
    const next = this.app.m.waypoints[Math.min(sim.nextWp, this.app.m.waypoints.length - 1)];
    const rv = this.app.roverPos(), d = Math.hypot(next.x - p.x, next.y - p.y) || 1;
    const clear = Math.hypot(p.x - rv.x, p.y - rv.y) < 4 ? 4 : 0;   // nie w bryle łazika: kilka kroków w stronę celu
    Object.assign(this.helmet, { x: p.x + (next.x - p.x) / d * clear, y: p.y + (next.y - p.y) / d * clear, pitch: -4 });
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
  /** Tempo marszu: o stopień szybciej (+1) albo wolniej (−1). */
  changePace(step) {
    const h = this.helmet;
    h.pace = Math.max(0, Math.min(PACE_LEVELS.length - 1, h.pace + step));
    this.app.emit('pace', PACE_LEVELS[h.pace]);
  }

  #input() {
    const el = this.renderer.domElement, h = this.helmet;
    let drag = null;
    // mysz jak w grze: kliknięcie przechwytuje kursor (Esc zwalnia); na ekranie dotykowym — przeciąganie
    el.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'helmet') return;
      if (e.pointerType === 'mouse' && el.requestPointerLock && document.pointerLockElement !== el) {
        try { el.requestPointerLock()?.catch?.(() => {}); } catch { /* przeglądarka bez blokady kursora — zostaje przeciąganie */ }
      }
      drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === el; this.app.emit('pointerlock', this.locked); });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || this.mode !== 'helmet') return;
      if (this.ride) { this.#rideLook(e.movementX * 0.15, e.movementY * 0.12); return; }
      h.yaw = (h.yaw + e.movementX * LOOK_SENS + 360) % 360;
      h.pitch = Math.max(-70, Math.min(60, h.pitch - e.movementY * LOOK_SENS));
      h.auto = null;
    });
    el.addEventListener('wheel', (e) => {
      if (this.mode !== 'helmet') return;
      e.preventDefault();
      if (this.ride && !this.ride.cabin) this.ride.boom = Math.max(BOOM_MIN, Math.min(BOOM_MAX, this.ride.boom * (e.deltaY > 0 ? 1.12 : 1 / 1.12)));   // wysuwanie wysięgnika
      else this.changePace(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    el.addEventListener('pointermove', (e) => {
      if (!drag || this.locked) return;
      if (this.ride) { this.#rideLook(-(e.clientX - drag.x) * 0.3, (e.clientY - drag.y) * 0.25); drag = { x: e.clientX, y: e.clientY }; return; }
      h.yaw = (h.yaw - (e.clientX - drag.x) * 0.25 + 360) % 360;
      h.pitch = Math.max(-60, Math.min(45, h.pitch + (e.clientY - drag.y) * 0.2));
      drag = { x: e.clientX, y: e.clientY };
      h.auto = null;
    });
    el.addEventListener('pointerup', () => { drag = null; });
    // jazda łazikiem: przeciąganie obraca kamerę wokół łazika, kółko zmienia odległość, C = kamera z kabiny
    let cdrag = null;
    const c = this.chase;
    el.addEventListener('pointerdown', (e) => { if (this.mode === 'drive') { cdrag = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); } });
    el.addEventListener('pointermove', (e) => {
      if (!cdrag) return;
      c.yawOff = (c.yawOff - (e.clientX - cdrag.x) * 0.3) % 360;
      c.pitch = Math.max(3, Math.min(75, c.pitch + (e.clientY - cdrag.y) * 0.2));
      cdrag = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', () => { cdrag = null; });
    el.addEventListener('wheel', (e) => { if (this.mode !== 'drive') return; e.preventDefault(); c.dist = Math.max(7, Math.min(150, c.dist * (e.deltaY > 0 ? 1.12 : 1 / 1.12))); }, { passive: false });
    addEventListener('keydown', (e) => { if (this.mode === 'drive' && e.code === 'KeyC' && !e.target.closest?.('input,select,textarea')) this.toggleCabin(); });
    const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'];
    addEventListener('keydown', (e) => {
      if (this.app.state.view !== 'helmet' || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input,select,textarea,[contenteditable],[role="dialog"]')) return;
      if (keys.includes(e.code)) { h.keys.add(e.code); h.auto = null; e.preventDefault(); return; }
      if (e.code === 'KeyF') { this.toggleRide(); e.preventDefault(); return; }
      if (e.code === 'KeyE' && !this.ride) { this.useStation(); e.preventDefault(); return; }
      if (e.code === 'Space' && this.ride) { h.keys.add('Space'); e.preventDefault(); return; }   // w łaziku: hamulec ręczny
      if (e.code === 'KeyC' && this.ride) { this.ride.cabin = !this.ride.cabin; this.rideCam = null; this.app.emit('ride', true); e.preventDefault(); return; }
      if (e.code === 'Space') { h.jump = true; h.auto = null; e.preventDefault(); return; }
      if (e.code === 'Equal' || e.code === 'NumpadAdd') { this.changePace(1); e.preventDefault(); }
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') { this.changePace(-1); e.preventDefault(); }
    });
    addEventListener('keyup', (e) => h.keys.delete(e.code));
    addEventListener('blur', () => h.keys.clear());
  }

  // ---------- jazda łazikiem (F w hełmie) ----------
  /** Wsiada albo wysiada. Wsiąść można tylko blisko łazika i gdy nie jedzie on trasą A→B. */
  toggleRide() {
    if (this.mode !== 'helmet') return;
    if (this.ride) { this.#exitRide(); return; }
    const h = this.helmet, rp = this.app.roverPos();
    if (this.app.drive) { this.flash = { text: tr('ride.busy'), t: performance.now() }; return; }
    if (Math.hypot(rp.x - h.x, rp.y - h.y) > RIDE_REACH_M) { this.flash = { text: tr('ride.far'), t: performance.now() }; return; }
    this.#solids();   // obrys habitatu do kolizji łazika
    this.app.roverAt = { x: rp.x, y: rp.y };
    const heading = ((90 - this.roverMesh.rotation.y * 180 / Math.PI) % 360 + 360) % 360;
    this.ride = { heading, speed: 0, steer: 0, camYaw: 0, camPitch: 18, lookPitch: -6, boom: 10, cabin: false, warn: null };
    this.rideCam = null;
    Object.assign(h, { vx: 0, vy: 0, z: 0, vz: 0 });
    this.interior.setVisible(false);
    this.app.emit('ride', true);
  }

  #exitRide() {
    const r = this.ride, h = this.helmet;
    if (!r) return;
    const p = this.app.roverPos(), a = r.heading * Math.PI / 180;
    // wyjście przez śluzę skafandra z tyłu kabiny: kilka kroków za łazikiem
    Object.assign(h, { x: Math.max(3, Math.min(this.W - 3, p.x - Math.sin(a) * 4.2)), y: Math.max(3, Math.min(this.H - 3, p.y + Math.cos(a) * 4.2)), yaw: (r.heading + 180) % 360, pitch: -4, vx: 0, vy: 0 });
    this.ride = null;
    this.rideCam = null;
    this.boom.visible = this.boomHead.visible = false;
    this.interior.setVisible(this.mode === 'helmet');
    this.app.emit('ride', false);
  }

  #rideLook(dyaw, dpitch) {
    const r = this.ride;
    r.camYaw = ((r.camYaw + dyaw + 540) % 360) - 180;
    if (r.cabin) { r.camYaw = Math.max(-110, Math.min(110, r.camYaw)); r.lookPitch = Math.max(-35, Math.min(30, r.lookPitch - dpitch)); } else r.camPitch = Math.max(3, Math.min(70, r.camPitch + dpitch));
  }

  /** Napęd: W/S gaz i hamulec (wstecz do 40%), A/D skręt kół; bez gazu A/D obraca łazik w miejscu (wszystkie pary kół skrętne). */
  #rideStep(dt) {
    const r = this.ride, h = this.helmet, k = h.keys, app = this.app;
    if (!app.roverAt || app.drive) { this.#exitRide(); return; }
    r.warn = null;
    const thr = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const steer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const vmax = app.m.rover.speedKmh / 3.6 * PACE_LEVELS[h.pace] * (k.has('ShiftLeft') || k.has('ShiftRight') ? SPRINT : 1);
    // hamulec: S w trakcie jazdy do przodu (albo W na wstecznym) najpierw zatrzymuje, dopiero potem zmienia kierunek;
    // spacja — hamulec ręczny; bez gazu łazik toczy się i zwalnia
    const handbrake = k.has('Space'), braking = handbrake || (thr !== 0 && Math.abs(r.speed) > 0.05 && Math.sign(thr) !== Math.sign(r.speed));
    const target = braking ? 0 : thr > 0 ? vmax : thr < 0 ? -0.4 * vmax : 0;
    const rate = handbrake ? Math.max(7, vmax * 3) : braking ? Math.max(5, vmax * 2) : thr === 0 ? Math.max(1.5, vmax * 0.8) : Math.max(1.2, vmax * 0.6);
    r.speed += Math.max(-rate * dt, Math.min(rate * dt, target - r.speed));
    r.braking = braking && Math.abs(r.speed) > 0.05;
    r.steer += (steer * 0.55 - r.steer) * Math.min(1, 5 * dt);
    if (Math.abs(r.speed) > 0.05) r.heading += r.speed / RIDE_WHEELBASE * Math.tan(r.steer) * dt * 180 / Math.PI;
    else if (steer && !thr) r.heading += steer * 25 * dt;
    r.heading = (r.heading + 360) % 360;
    const d = r.speed * dt, a = r.heading * Math.PI / 180;
    if (d) {
      const n = Math.max(1, Math.ceil(Math.abs(d) / 0.5));
      for (let i = 0; i < n; i++) { const w = this.#rideMove(Math.sin(a) * d / n, -Math.cos(a) * d / n); if (w) { r.warn = w; r.speed = 0; break; } }
    }
    this.#rideCamera(dt);
  }

  /** Ruch łazika z kolizjami: granica mapy, stok pod górę ponad limit, duże głazy i habitat. */
  #rideMove(dx, dy) {
    const p = this.app.roverAt, t = this.t;
    let nx = p.x + dx, ny = p.y + dy;
    if (!t.inside(nx, ny, 4)) return tr('hud.edge');
    if (t.height(nx, ny) > t.height(p.x, p.y) && t.slope(nx, ny) > RIDE_MAX_SLOPE) return tr('hud.steep', { a: Math.round(t.slope(nx, ny)) });
    const solids = this.rocks.filter((rk) => rk.collide && rk.r > 0.35).concat(this.habSolids || []);
    for (const s of solids) {
      const ex = nx - s.x, ey = ny - s.y, dd = Math.hypot(ex, ey), min = s.r + RIDE_RADIUS;
      if (dd < min) { nx = s.x + (ex / (dd || 1)) * min; ny = s.y + (ey / (dd || 1)) * min; }
    }
    const moved = Math.hypot(nx - p.x, ny - p.y), want = Math.hypot(dx, dy);
    if (Math.hypot(nx - p.x - dx, ny - p.y - dy) > 0.001 && moved < want * 0.3) return tr('ride.blocked');
    p.x = nx; p.y = ny;
    return null;
  }

  /** Kamera z wysięgnika (sprężyste nadążanie jak w grach, ale zawsze na końcu ramienia) albo z fotela kierowcy. */
  #rideCamera(dt) {
    const r = this.ride, p = this.app.roverPos(), t = this.t, g = t.height(p.x, p.y);
    const a = r.heading * Math.PI / 180, fx = Math.sin(a), fy = -Math.cos(a);
    this.camera.up.set(0, 1, 0);
    if (r.cabin) {
      const ex = p.x + fx * 1.4, ey = p.y + fy * 1.4, eye = g + 2.45;
      const yaw = (r.heading + r.camYaw) * Math.PI / 180, pit = r.lookPitch * Math.PI / 180;
      this.camera.position.set(this.X(ex), eye, this.Z(ey));
      this.camera.lookAt(this.X(ex) + Math.sin(yaw) * Math.cos(pit), eye + Math.sin(pit), this.Z(ey) - Math.cos(yaw) * Math.cos(pit));
      this.boom.visible = this.boomHead.visible = false;
      return;
    }
    const px = p.x + fx * ROVER_BOOM_PIVOT.x, py = p.y + fy * ROVER_BOOM_PIVOT.x, pz = g + ROVER_BOOM_PIVOT.y;
    const yaw = (r.heading + r.camYaw) * Math.PI / 180, pit = r.camPitch * Math.PI / 180;
    const cx = px - Math.sin(yaw) * r.boom * Math.cos(pit), cy = py + Math.cos(yaw) * r.boom * Math.cos(pit);
    const cz = Math.max(pz + r.boom * Math.sin(pit), (t.inside(cx, cy) ? t.height(cx, cy) : g) + 0.8);
    const target = new THREE.Vector3(this.X(cx), cz, this.Z(cy));
    if (!this.rideCam) this.rideCam = target.clone();
    else this.rideCam.lerp(target, 1 - Math.exp(-10 * dt));
    this.camera.position.copy(this.rideCam);
    this.camera.lookAt(this.X(p.x + fx * 1.5), g + 1.8, this.Z(p.y + fy * 1.5));
    // ramię wysięgnika: od obrotowej podstawy na dachu do mocowania kamery (pod obiektywem, więc nie zasłania widoku)
    const base = new THREE.Vector3(this.X(px), pz, this.Z(py)), tip = this.rideCam.clone().add(new THREE.Vector3(0, -0.45, 0));
    const dir = tip.clone().sub(base), len = dir.length();
    this.boom.position.copy(base).addScaledVector(dir, 0.5);
    this.boom.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    this.boom.scale.set(1, len, 1);
    this.boomHead.position.copy(this.rideCam).add(new THREE.Vector3(0, -0.3, 0));
    this.boomHead.lookAt(this.X(p.x), g + 1.5, this.Z(p.y));
    this.boom.visible = this.boomHead.visible = true;
  }

  /** Dane dla wskaźników jazdy łazikiem. */
  rideInfo() {
    const r = this.ride, p = this.app.roverPos();
    return {
      speed: Math.abs(r.speed) * 3.6, reverse: r.speed < -0.05, heading: Math.round(r.heading) % 360, slope: this.t.slope(p.x, p.y),
      pace: PACE_LEVELS[this.helmet.pace], cabin: r.cabin, boom: r.boom, warn: r.warn || (r.braking ? tr('ride.brake') : null), locked: !!this.locked,
    };
  }

  /** Krok z kolizjami; przy przeszkodzie próba ślizgu wzdłuż osi (jak w grach), żeby nie stawać w miejscu. */
  #step(dx, dy) {
    const warn = this.#tryMove(dx, dy);
    if (!warn) return null;
    if (Math.abs(dx) > 1e-4 && !this.#tryMove(dx, 0)) return null;
    if (Math.abs(dy) > 1e-4 && !this.#tryMove(0, dy)) return null;
    return warn;
  }

  /** Bryły do kolizji w hełmie: kamienie i łazik (obrys z kół). Habitat ma własne ściany i drzwi (core/habitat.js). */
  #solids() {
    const hab = this.app.m.habitat;
    this.habSolids ||= hab ? rotate(HABITAT_FOOTPRINT, hab.x, hab.y, this.habitatMesh?.rotation.y ?? 0) : [];   // obrys dla łazika
    const rp = this.app.roverPos();
    return this.rocks.concat(rotate(ROVER_FOOTPRINT, rp.x, rp.y, this.roverMesh.rotation.y));
  }

  /** Ruch z kolizjami. Zwraca powód zatrzymania albo null. */
  #tryMove(dx, dy) {
    const h = this.helmet, t = this.t, max = this.app.m.eva.maxSlopeDeg;
    let nx = h.x + dx, ny = h.y + dy;
    if (!t.inside(nx, ny, 3)) return tr('hud.edge');
    const d = Math.hypot(dx, dy);
    if (this.hab?.zoneAtPlan(nx, ny)) {   // we wnętrzu habitatu i na rampie: podłoga zamiast gruntu, ściany i drzwi
      h.x = nx; h.y = ny;
      return null;
    }
    if (this.hab && !this.hab.canStandPlan(nx, ny)) return tr('hab.wall');
    const rise = t.height(nx, ny) - t.height(h.x, h.y);
    const ang = Math.atan2(rise, d) * 180 / Math.PI;
    if (rise > 0 && ang > max) return tr('hud.steep', { a: Math.round(ang) });
    for (const rk of this.#solids()) {
      if (!rk.collide) continue;
      const ex = nx - rk.x, ey = ny - rk.y, dd = Math.hypot(ex, ey), min = rk.r + 0.35;
      if (dd < min) { nx = rk.x + (ex / (dd || 1)) * min; ny = rk.y + (ey / (dd || 1)) * min; }
    }
    if (Math.hypot(nx - h.x - dx, ny - h.y - dy) > 0.001 && Math.hypot(nx - h.x, ny - h.y) < d * 0.3) return tr('hud.boulder');
    if (this.hab && !this.hab.canStandPlan(nx, ny)) return tr('hab.wall');   // kamień nie może wypchnąć w ścianę
    h.x = nx; h.y = ny;
    return null;
  }

  /** Wysokość, po której się chodzi: grunt, podłoga habitatu albo rampa (przejście od progu do gruntu). */
  #groundAt(x, y) {
    const g = this.t.height(x, y), f = this.hab?.floorAtPlan(x, y);
    if (!f) return g;
    const base = this.t.height(this.app.m.habitat.x, this.app.m.habitat.y);
    return base + f.h + (g - base - f.h) * f.k;
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
      // prędkość docelowa z klawiszy; płynne przyspieszanie i hamowanie
      const sprint = k.has('ShiftLeft') || k.has('ShiftRight') ? SPRINT : 1;
      const indoors = this.hab?.indoors && this.hab.zone.id !== 'ramp';
      const v = Math.min(WALK_MS * PACE_LEVELS[h.pace] * sprint, indoors ? 3.5 : Infinity), y = h.yaw * Math.PI / 180;   // w ciasnym wnętrzu bez tempa ×32
      let tx = 0, ty = 0;
      if (fwd || side) {
        const fx = Math.sin(y), fy = -Math.cos(y), rx = Math.cos(y), ry = Math.sin(y);
        tx = fx * fwd + rx * side; ty = fy * fwd + ry * side;
        const L = Math.hypot(tx, ty); tx = tx / L * v; ty = ty / L * v;
      }
      const a = Math.min(1, ACCEL * dt);
      h.vx += (tx - h.vx) * a; h.vy += (ty - h.vy) * a;
      if (Math.hypot(h.vx, h.vy) < 0.02 && !fwd && !side) { h.vx = 0; h.vy = 0; }
      const mx = h.vx * dt, my = h.vy * dt, dist = Math.hypot(mx, my);
      if (dist > 0) {
        const steps = Math.max(1, Math.ceil(dist / 0.4));
        for (let i = 0; i < steps; i++) { const w = this.#step(mx / steps, my / steps); if (w) { h.warn = w; h.vx = h.vy = 0; break; } }
      }
      h.speed = Math.hypot(h.vx, h.vy) * 3.6;
      // skok i lot w grawitacji Marsa (0,38 g)
      if (h.jump && h.z === 0) h.vz = JUMP_MS;
      h.jump = false;
      if (h.z > 0 || h.vz > 0) {
        h.vz -= G_MARS * dt; h.z += h.vz * dt;
        if (h.z <= 0) { h.z = 0; h.vz = 0; }
        if (indoors && h.z > 0.3) { h.z = 0.3; h.vz = Math.min(0, h.vz); }   // sufit
      }
      // kołysanie kroku (słabsze przy dużym tempie)
      const moving = Math.hypot(h.vx, h.vy);
      h.bob = h.z === 0 && moving > 0.1 ? h.bob + dt * Math.min(moving, 3) * 4.2 : h.bob * 0.9;
    }
    this.hab?.track(h.x, h.y, h.yaw);
    const ground = this.#groundAt(h.x, h.y);
    const bob = h.auto ? 0 : Math.sin(h.bob) * 0.035 / Math.max(1, PACE_LEVELS[h.pace] / 4);
    const eye = ground + EYE + (h.z || 0) + bob;
    const y = h.yaw * Math.PI / 180, p = h.pitch * Math.PI / 180;
    this.camera.position.set(this.X(h.x), eye, this.Z(h.y));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.X(h.x) + Math.sin(y) * Math.cos(p), eye + Math.sin(p), this.Z(h.y) - Math.cos(y) * Math.cos(p));
  }

  toggleCabin() { this.chase.cabin = !this.chase.cabin; this.chase.yawOff = 0; this.app.emit('drive-cam', this.chase.cabin); }
  resetChase() { Object.assign(this.chase, { yawOff: 0, pitch: 20, dist: 22 }); }

  /** Kamera jazdy: za łazikiem (pościg) albo z kabiny; kurs wygładzony, kamera nigdy pod gruntem. */
  #driveStep(dt) {
    const d = this.app.drive, c = this.chase, t = this.t;
    const p = this.app.roverPos();
    const yaw = d ? d.heading() : (this.camYaw ?? 0);
    this.camYaw = this.camYaw === undefined ? yaw : (this.camYaw + ((((yaw - this.camYaw) % 360) + 540) % 360 - 180) * Math.min(1, dt * 2.5) + 360) % 360;
    const g = t.height(p.x, p.y);
    this.camera.up.set(0, 1, 0);
    if (c.cabin) {
      const y = (this.camYaw + c.yawOff) * Math.PI / 180, fx = Math.sin(y), fy = -Math.cos(y);
      const ax = p.x + fx * 40, ay = p.y + fy * 40;
      this.camera.position.set(this.X(p.x + fx * 1.2), g + 2.3, this.Z(p.y + fy * 1.2));
      this.camera.lookAt(this.X(ax), (t.inside(ax, ay) ? t.height(ax, ay) : g) + 1.4, this.Z(ay));
      return;
    }
    const y = (this.camYaw + c.yawOff) * Math.PI / 180, ph = c.pitch * Math.PI / 180;
    const back = c.dist * Math.cos(ph), up = c.dist * Math.sin(ph);
    let cx = p.x - Math.sin(y) * back, cy = p.y + Math.cos(y) * back;
    cx = Math.max(1, Math.min(this.W - 1, cx)); cy = Math.max(1, Math.min(this.H - 1, cy));
    this.camera.position.set(this.X(cx), Math.max(t.height(cx, cy) + 1.5, g + up), this.Z(cy));
    this.camera.lookAt(this.X(p.x), g + 1.5, this.Z(p.y));
  }

  /** Dane dla HUD hełmu. */
  hudInfo() {
    const h = this.helmet, app = this.app, wps = app.m.waypoints;
    let target, dist;
    if (h.auto) {
      const idx = wps.findIndex((_, i) => Math.abs(app.state.route.wpS[i] - h.auto.toS) < 1);
      target = wps[idx]?.id || 'CEL'; dist = Math.abs(h.auto.s - h.auto.toS);
    } else {
      const wp = app.navTarget();
      target = wp.id; dist = Math.hypot(wp.x - h.x, wp.y - h.y);
    }
    const haz = app.world.rasters.hazards.sample(h.x, h.y);
    const rp = app.roverPos(), nearRover = !app.drive && Math.hypot(rp.x - h.x, rp.y - h.y) <= RIDE_REACH_M;
    const flash = this.flash && performance.now() - this.flash.t < 2500 ? this.flash.text : null;
    return {
      heading: Math.round(h.yaw) % 360, target, dist, speed: h.speed, pace: PACE_LEVELS[h.pace], locked: !!this.locked,
      slope: this.t.slope(h.x, h.y), zone: haz, warn: h.warn || flash || (nearRover && !h.auto ? tr('ride.hint') : null) || this.hab?.info().flash || (!h.auto && this.hab?.prompt()) || null, timelapse: h.auto?.timelapse ?? 1,
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
    this.interior.setVisible(false);
    this.#syncFrame();
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/jpeg', 0.88);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(size.x, size.y, false);
    this.camera.aspect = saved.aspect; this.camera.updateProjectionMatrix();
    Object.assign(this.helmet, { x: saved.hx, y: saved.hy, yaw: saved.yaw, pitch: saved.pitch, auto: saved.auto });
    this.flight = saved.flight;
    this.mode = saved.mode; this.ex = this.#exFor(saved.mode); this.#applyMode();
    this.camera.position.copy(saved.pos); this.camera.quaternion.copy(saved.quat);
    return url;
  }

  resize(scale) {
    this.renderScale = scale;
    const w = this.el.clientWidth || MAIN_W, h = this.el.clientHeight || MAIN_H;
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(Math.round(w * scale), Math.round(h * scale), false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.interior.resize();
  }

  /** Klawisz E: stanowisko habitatu w zasięgu (śluza, światło, konsola…). */
  useStation() {
    if (this.mode !== 'helmet' || this.ride || !this.hab) return false;
    return this.hab.use();
  }

  /** Wskaźniki habitatu zamiast wizjera: w środku albo na rampie przed śluzą. */
  get inHabitat() { return this.mode === 'helmet' && !this.ride && !!this.hab?.zone; }
  habInfo() { return this.hab.info(); }

  #habitatStep(dt) {
    const walking = this.mode === 'helmet' && !this.ride;
    if (!walking) { this.hab.zone = null; this.hab.station = null; }
    const inside = this.hab.step(dt, walking && this.hab.dist < 30);
    // pod dachem światło nieba słabnie, wnętrze oświetlają lampy; po zdjęciu hełmu znika jego obręcz
    this.hemi.intensity = inside ? (this.hab.systems.lights ? 0.32 : 0.08) : 0.85;
    if (walking) this.interior.group.visible = !this.hab.helmetOff;
  }

  render(dt) {
    this.#placeMarkers();
    if (this.mode === 'helmet') { if (this.ride) this.#rideStep(dt); else this.#helmetStep(dt); }
    if (this.hab) this.#habitatStep(dt);
    else if (this.mode === 'drive') this.#driveStep(dt);
    else if (this.flight) this.#flightStep(dt);
    else this.controls.update();
    this.#syncFrame();
    this.renderer.render(this.scene, this.camera);
  }
}
