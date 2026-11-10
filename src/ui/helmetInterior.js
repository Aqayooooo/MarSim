// Wnętrze hełmu jest geometrią 3D przy kamerze. Nie zasłania zdjęć punktów trasy.
import * as THREE from 'three';

function opening(scale = 1) {
  const p = new THREE.Path();
  p.moveTo(-.70 * scale, .91 * scale);
  p.bezierCurveTo(-.96 * scale, .89 * scale, -1.00 * scale, .52 * scale, -.97 * scale, .05 * scale);
  p.bezierCurveTo(-.95 * scale, -.54 * scale, -.85 * scale, -.79 * scale, -.57 * scale, -.84 * scale);
  p.bezierCurveTo(-.20 * scale, -.97 * scale, .20 * scale, -.97 * scale, .57 * scale, -.84 * scale);
  p.bezierCurveTo(.85 * scale, -.79 * scale, .95 * scale, -.54 * scale, .97 * scale, .05 * scale);
  p.bezierCurveTo(1.00 * scale, .52 * scale, .96 * scale, .89 * scale, .70 * scale, .91 * scale);
  p.bezierCurveTo(.30 * scale, 1.01 * scale, -.30 * scale, 1.01 * scale, -.70 * scale, .91 * scale);
  return p;
}

function rim(outer, inner, material, depth, z = 0) {
  const shape = new THREE.Shape(outer.getPoints(80));
  shape.holes.push(inner);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: material.type !== 'MeshBasicMaterial', bevelSize: .009,
    bevelThickness: .009, bevelSegments: 3, steps: 1, curveSegments: 32 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.z = z;
  mesh.renderOrder = 10;
  return mesh;
}

export class HelmetInterior {
  constructor(camera) {
    this.camera = camera;
    this.group = new THREE.Group();
    this.group.visible = false;
    camera.add(this.group);
    const metal = new THREE.MeshStandardMaterial({ color: '#36434a', metalness: .78, roughness: .37, fog: false });
    const rubber = new THREE.MeshStandardMaterial({ color: '#080e12', metalness: .1, roughness: .88, fog: false });
    const edge = new THREE.MeshStandardMaterial({ color: '#687b82', metalness: .88, roughness: .3, fog: false });
    const cyan = new THREE.MeshBasicMaterial({ color: '#68dee0', fog: false });
    const outer = new THREE.Path();
    outer.moveTo(-1.7, -1.7); outer.lineTo(1.7, -1.7); outer.lineTo(1.7, 1.7); outer.lineTo(-1.7, 1.7); outer.closePath();
    this.group.add(rim(outer, opening(1.05), rubber, .045, -.02));
    this.group.add(rim(opening(1.05), opening(.97), metal, .036, .02));
    this.group.add(rim(opening(.974), opening(.964), edge, .008, .057));
    this.group.add(rim(opening(.958), opening(.954), cyan, .002, .056));
    this.screws = [];
    for (const side of [-1, 1]) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(.10, .38, .065), metal);
      plate.position.set(side * .85, -.18, .045);
      plate.rotation.z = side * -.10;
      this.group.add(plate);
      for (const y of [-.31, -.05, .68]) {
        const screw = new THREE.Mesh(new THREE.CylinderGeometry(.027, .027, .018, 20), edge);
        screw.rotation.x = Math.PI / 2;
        screw.position.set(side * (y > 0 ? .80 : .84), y, .09);
        const socket = new THREE.Mesh(new THREE.CylinderGeometry(.012, .012, .004, 6), rubber);
        socket.position.y = .011;
        screw.add(socket);
        this.group.add(screw);
        this.screws.push(screw);
      }
      for (let i = 0; i < 4; i++) {
        const vent = new THREE.Mesh(new THREE.BoxGeometry(.026, .10, .025), rubber);
        vent.position.set(side * (.70 + i * .035), -.85 + i * .017, .06);
        vent.rotation.z = side * -.35;
        this.group.add(vent);
      }
      const light = new THREE.Mesh(new THREE.BoxGeometry(.008, .16, .006), cyan);
      light.position.set(side * .81, -.18, .09);
      this.group.add(light);
    }
    const chin = new THREE.Mesh(new THREE.BoxGeometry(.64, .13, .085), metal);
    chin.position.set(0, -.82, .07);
    this.group.add(chin);
    for (let i = -4; i <= 4; i++) {
      const vent = new THREE.Mesh(new THREE.BoxGeometry(.013, .07, .008), rubber);
      vent.position.set(i * .036, -.79, .12);
      this.group.add(vent);
    }
    const lamp = new THREE.PointLight('#c5e8f1', 1.2, 3);
    lamp.position.set(-.2, .2, .5);
    this.group.add(lamp);
    this.resize();
  }

  resize() {
    const distance = .65;
    const height = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * distance;
    this.group.position.z = -distance;
    this.group.scale.set(height * this.camera.aspect, height, 1);
    for (const screw of this.screws) screw.scale.x = 1 / this.camera.aspect;
  }

  setVisible(on) { this.group.visible = on; this.resize(); }
}
