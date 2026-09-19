// The responder (the phone that recorded the scene) drawn as a camera frustum at the
// interpolated trajectory pose, with a trail of every earlier position. Both ignore
// depth so they show through the wall like the ghosts do.
import * as THREE from 'three';
import { poseAt } from './scene-data.js';

const FRUSTUM_COLOR = 0x4dd9ff;
const TRAIL_COLOR = 0x2aa9cc;

function frustumGeometry(w = 0.16, h = 0.12, d = 0.3) {
  // three.js camera convention: the camera looks along its own -Z (docs/CONTRACT.md, clarification 4)
  const c = [
    [-w, -h, -d],
    [w, -h, -d],
    [w, h, -d],
    [-w, h, -d],
  ];
  const seg = [];
  for (let i = 0; i < 4; i++) {
    seg.push(0, 0, 0, ...c[i]); // apex to corner
    seg.push(...c[i], ...c[(i + 1) % 4]); // far rectangle
  }
  seg.push(-0.06, h, -d, 0, h + 0.08, -d, 0, h + 0.08, -d, 0.06, h, -d); // "up" mark
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
  return g;
}

export class Responder {
  /** trajectory: sorted [{ t, source, position [x,y,z], quaternion [x,y,z,w] }] */
  constructor(trajectory) {
    this.trajectory = trajectory;
    this.group = new THREE.Group();
    this.group.name = 'responder';

    this.frustum = new THREE.LineSegments(
      frustumGeometry(),
      new THREE.LineBasicMaterial({ color: FRUSTUM_COLOR, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }),
    );
    this.frustum.renderOrder = 9;
    this.frustum.frustumCulled = false;

    const n = trajectory.length;
    const positions = new Float32Array(3 * n);
    trajectory.forEach((p, i) => positions.set(p.position, 3 * i));
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    trailGeometry.setDrawRange(0, 0);
    this.trail = new THREE.Line(
      trailGeometry,
      new THREE.LineBasicMaterial({ color: TRAIL_COLOR, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false }),
    );
    this.trail.renderOrder = 8;
    this.trail.frustumCulled = false;

    this.group.add(this.trail, this.frustum);
    this.state = null;
  }

  /** Move the frustum to the pose at replay time t and extend the trail up to it. */
  update(t) {
    const p = poseAt(this.trajectory, t);
    if (!p) {
      this.group.visible = false;
      this.state = null;
      return null;
    }
    this.group.visible = true;
    this.frustum.position.fromArray(p.position);
    this.frustum.quaternion.fromArray(p.quaternion);
    const trailPoints = Math.min(this.trajectory.length, p.index + 1);
    this.trail.geometry.setDrawRange(0, trailPoints);
    this.state = { index: p.index, position: p.position, trailPoints };
    return this.state;
  }

  dispose() {
    this.frustum.geometry.dispose();
    this.frustum.material.dispose();
    this.trail.geometry.dispose();
    this.trail.material.dispose();
  }
}
