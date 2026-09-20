// Responders (the phones that recorded the scene), one per source id in trajectory.json: a camera
// frustum at the interpolated pose plus a trail of every earlier position of that source. Both
// ignore depth so they show through the wall like the ghosts do. With two or more sources each
// frustum gets its own colour and a label from manifest.sources ("Two recorded walkthroughs
// replayed together" is the honesty caption for that case).
import * as THREE from 'three';
import { poseAt, splitTrajectory } from './scene-data.js';
import { makeLabel } from './label.js';

export const RESPONDER_COLORS = [
  { frustum: 0x4dd9ff, trail: 0x2aa9cc, label: '#7fe6ff' }, // cyan, matches the x-ray look
  { frustum: 0xffd24d, trail: 0xcc9a2a, label: '#ffe08a' }, // amber: distinct from ghosts (red-orange) and the portal ring
  { frustum: 0xff4dd9, trail: 0xcc2aa9, label: '#ff9ae8' },
  { frustum: 0x7dff4d, trail: 0x4ecc2a, label: '#b4ff8a' },
];

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
  /**
   * trajectory: sorted [{ t, source, position [x,y,z], quaternion [x,y,z,w] }] of ONE source.
   * opts: { source, colors (RESPONDER_COLORS entry), label (text, or null for no sprite) }
   */
  constructor(trajectory, { source = 0, colors = RESPONDER_COLORS[0], label = null } = {}) {
    this.trajectory = trajectory;
    this.source = source;
    this.colors = colors;
    this.labelText = label;
    this.group = new THREE.Group();
    this.group.name = source ? `responder-${source}` : 'responder';
    this.group.userData.source = source;

    this.frustum = new THREE.LineSegments(
      frustumGeometry(),
      new THREE.LineBasicMaterial({ color: colors.frustum, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }),
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
      new THREE.LineBasicMaterial({ color: colors.trail, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false }),
    );
    this.trail.renderOrder = 8;
    this.trail.frustumCulled = false;

    this.group.add(this.trail, this.frustum);
    // the label needs a 2D canvas; skipped in Node tests
    this.label = label && typeof document !== 'undefined' ? makeLabel({ color: colors.label, width: 0.7 }) : null;
    if (this.label) {
      this.label.setText(label);
      this.group.add(this.label.sprite);
    }
    this.state = null;
  }

  /**
   * Clip the trail to the far side of a wall plane ({ normal, d } with the normal pointing outside, scene-data
   * parseWall), so a viewer outside sees the teammate's path inside the room but not the stretch beside them.
   * null removes the clip. Planes are world space: pass sceneRoot's matrixWorld when it is not the identity.
   */
  setWallClip(plane, depth = 0, matrixWorld = null) {
    if (!plane) {
      this.trail.material.clippingPlanes = null;
      this.trail.material.needsUpdate = true;
      return;
    }
    // keep points with n.p - d < -depth, i.e. (-n).p + (d - depth) > 0 in three.js's clip convention
    const clip = new THREE.Plane(new THREE.Vector3(-plane.normal[0], -plane.normal[1], -plane.normal[2]), plane.d - depth);
    if (matrixWorld) clip.applyMatrix4(matrixWorld);
    this.trail.material.clippingPlanes = [clip];
    this.trail.material.needsUpdate = true;
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
    if (this.label) this.label.sprite.position.set(p.position[0], p.position[1] + 0.3, p.position[2]);
    const trailPoints = Math.min(this.trajectory.length, p.index + 1);
    this.trail.geometry.setDrawRange(0, trailPoints);
    this.state = { source: this.source, index: p.index, position: p.position, trailPoints };
    return this.state;
  }

  dispose() {
    this.frustum.geometry.dispose();
    this.frustum.material.dispose();
    this.trail.geometry.dispose();
    this.trail.material.dispose();
    this.label?.dispose();
  }
}

export class Responders {
  /** One Responder per source id in a merged trajectory. sources: manifest.sources (labels), used only with 2+ sources. */
  constructor(trajectory, sources = []) {
    this.group = new THREE.Group();
    this.group.name = 'responders';
    const groups = splitTrajectory(trajectory);
    this.items = groups.map(({ source, entries }, i) => {
      const meta = Array.isArray(sources) ? sources.find((s) => s && s.id === source) : null;
      const label = groups.length > 1 ? (meta && meta.label) || `Responder ${source + 1}` : null;
      const responder = new Responder(entries, { source, colors: RESPONDER_COLORS[i % RESPONDER_COLORS.length], label });
      this.group.add(responder.group);
      return responder;
    });
    this.state = [];
  }

  /** [{ source, label, color }] for the HUD legend (empty with a single responder). */
  get legend() {
    return this.items.length > 1 ? this.items.map((r) => ({ source: r.source, label: r.labelText, color: r.colors.frustum })) : [];
  }

  /** Trail clip at a wall plane for every responder (see Responder.setWallClip). */
  setWallClip(plane, depth = 0, matrixWorld = null) {
    for (const r of this.items) r.setWallClip(plane, depth, matrixWorld);
  }

  /** Update every responder for replay time t; returns their states (one per visible source). */
  update(t) {
    this.state = this.items.map((r) => r.update(t)).filter(Boolean);
    return this.state;
  }

  dispose() {
    for (const r of this.items) r.dispose();
  }
}
