// The portal: a depth-only plane at the wall with a circular hole that follows the gaze.
// The plane writes depth but no colour, so the recorded room behind the wall fails the
// depth test everywhere except inside the hole, where the camera feed shows the real
// wall around a "window" into the room. Ghosts and the responder ignore depth and stay
// visible through the whole wall. A thin additive ring marks the hole's edge.
import * as THREE from 'three';
import { intersectWallPlane } from './scene-data.js';

export const PORTAL_RADIUS = 0.6; // metres
const RING_COLOR = 0x4dd9ff;
const OCCLUDER_HALF = 20; // metres; big enough to cover any view of the wall

export class Portal {
  constructor({ wallZ, radius = PORTAL_RADIUS }) {
    this.wallZ = wallZ;
    this.radius = radius;
    this.group = new THREE.Group();
    this.group.name = 'portal';

    const shape = new THREE.Shape();
    shape.moveTo(-OCCLUDER_HALF, -OCCLUDER_HALF);
    shape.lineTo(OCCLUDER_HALF, -OCCLUDER_HALF);
    shape.lineTo(OCCLUDER_HALF, OCCLUDER_HALF);
    shape.lineTo(-OCCLUDER_HALF, OCCLUDER_HALF);
    shape.closePath();
    const hole = new THREE.Path();
    hole.absarc(0, 0, radius, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    this.occluder = new THREE.Mesh(
      new THREE.ShapeGeometry(shape, 48), // lies in XY, normal +Z: already parallel to the wall plane z = wallZ
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide }),
    );
    this.occluder.renderOrder = -1; // opaque queue sorts by renderOrder first, so depth lands before the points draw
    this.occluder.frustumCulled = false;

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(radius, radius + 0.04, 64),
      new THREE.MeshBasicMaterial({
        color: RING_COLOR,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.ring.renderOrder = 9;
    this.ring.frustumCulled = false;

    this.group.add(this.occluder, this.ring);
    this.hit = [0, 0, wallZ];
    this.enabled = false;
    this.group.visible = false;
    this.state = { enabled: false, hit: this.hit, miss: false };
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._inverse = new THREE.Matrix4();
    this.place();
  }

  place() {
    const [x, y] = this.hit;
    this.occluder.position.set(x, y, this.wallZ + 0.02); // a hair outside the wall: no z-fighting with the wall's own points
    this.ring.position.set(x, y, this.wallZ + 0.03);
  }

  setEnabled(v) {
    this.enabled = !!v;
    this.group.visible = this.enabled;
  }

  /**
   * Center the hole where the camera's forward ray meets the wall plane, in sceneRoot
   * space (alignment nudges move sceneRoot, so the wall plane moves with it). On a miss
   * the hole stays where it last was.
   */
  update(camera, sceneRoot) {
    if (!this.enabled) {
      this.state = { enabled: false, hit: this.hit, miss: false };
      return this.state;
    }
    sceneRoot.updateMatrixWorld();
    this._origin.setFromMatrixPosition(camera.matrixWorld);
    this._dir.set(0, 0, -1).transformDirection(camera.matrixWorld);
    this._inverse.copy(sceneRoot.matrixWorld).invert();
    this._origin.applyMatrix4(this._inverse);
    this._dir.transformDirection(this._inverse);
    const hit = intersectWallPlane([this._origin.x, this._origin.y, this._origin.z], [this._dir.x, this._dir.y, this._dir.z], this.wallZ);
    if (hit) {
      this.hit = hit;
      this.place();
    }
    this.state = { enabled: true, hit: this.hit, miss: !hit };
    return this.state;
  }

  dispose() {
    this.occluder.geometry.dispose();
    this.occluder.material.dispose();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
  }
}
