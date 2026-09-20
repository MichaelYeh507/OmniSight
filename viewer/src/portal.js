// The portal: a depth-only plane on the wall with a circular hole that follows the gaze.
// The plane writes depth but no colour, so the recorded room behind the wall fails the
// depth test everywhere except inside the hole, where the camera feed shows the real
// wall around a "window" into the room. Ghosts and the responder ignore depth and stay
// visible through the whole wall. A thin additive ring marks the hole's edge.
//
// The wall is any plane (scene-data parseWall): the group is placed so that, in its own
// frame, the wall is z = 0 with +Z pointing outside, and everything below works in that
// frame. The hole is cut in the fragment shader, so its radius can animate (the iris that
// opens when x-ray is switched on) without rebuilding geometry.
import * as THREE from 'three';
import { intersectWallPlane, clampWallHit, parseWall } from './scene-data.js';

export const PORTAL_RADIUS = 0.6; // metres
export const PORTAL_REACH = 3; // metres the hole may slide from the point straight ahead; keeps the occluder over the wall at grazing angles
const RING_COLOR = 0x4dd9ff;
const OCCLUDER_HALF = 20; // metres; big enough to cover any view of the wall
const OCCLUDER_LIFT = 0.02; // a hair outside the wall: no z-fighting with the wall's own points

const occluderVertex = /* glsl */ `
  varying vec2 vLocal;
  void main() {
    vLocal = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const occluderFragment = /* glsl */ `
  uniform vec2 uHole;
  uniform float uRadius;
  varying vec2 vLocal;
  void main() {
    if (distance(vLocal, uHole) < uRadius) discard; // the window; everything else writes depth only
    gl_FragColor = vec4(0.0);
  }
`;

export class Portal {
  /**
   * { plane } from parseWall, or the contract's { wallZ }; { radius } overrides the hole size.
   * style 'ring' (the original): a depth-only occluder with a hard hole and a cyan rim. 'soft' (default): no
   * occluder and no rim; the points shader fades the room in around the same gaze hit (PointCloud.setHole),
   * so this object only tracks where the viewer looks.
   */
  constructor({ plane = null, wallZ = null, radius = PORTAL_RADIUS, style = 'soft' }) {
    this.plane = plane || parseWall(null, wallZ);
    if (!this.plane) throw new Error('Portal needs a wall plane');
    this.wallZ = wallZ;
    this.radius = radius;
    this.style = style === 'ring' ? 'ring' : 'soft';
    this.group = new THREE.Group();
    this.group.name = 'portal';
    // local frame: wall at z = 0, +Z outside; the group's origin is the wall point nearest the scene origin
    const normal = new THREE.Vector3().fromArray(this.plane.normal).normalize();
    this.group.position.copy(normal).multiplyScalar(this.plane.d);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);

    this.occluder = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * OCCLUDER_HALF, 2 * OCCLUDER_HALF), // lies in XY, normal +Z: parallel to the wall
      new THREE.ShaderMaterial({
        uniforms: { uHole: { value: new THREE.Vector2(0, 0) }, uRadius: { value: radius } },
        vertexShader: occluderVertex,
        fragmentShader: occluderFragment,
        colorWrite: false,
        depthWrite: true,
        side: THREE.DoubleSide,
      }),
    );
    this.occluder.position.z = OCCLUDER_LIFT;
    this.occluder.renderOrder = -1; // opaque queue sorts by renderOrder first, so depth lands before the points draw
    this.occluder.frustumCulled = false;

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(radius, radius * 1.06, 64), // rim 6 % of the radius: the same weight at any hole size
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
    this.occluder.visible = this.ring.visible = this.style === 'ring';
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._inverse = new THREE.Matrix4();
    this._tmp = new THREE.Vector3();
    this.hit = [0, 0, 0]; // local: on the wall, straight ahead of the scene origin
    this.open = 1;
    this.enabled = false;
    this.group.visible = false;
    this.state = { enabled: false, hit: this.toRoot(this.hit), miss: false, clamped: false, outside: true, open: 1 };
    this.place();
  }

  /** Local wall coordinates -> sceneRoot coordinates (what the debug surface and tests read). */
  toRoot([x, y, z]) {
    this.group.updateMatrix();
    const v = this._tmp.set(x, y, z).applyMatrix4(this.group.matrix);
    return [v.x, v.y, v.z];
  }

  place() {
    const [x, y] = this.hit;
    this.occluder.material.uniforms.uHole.value.set(x, y);
    this.ring.position.set(x, y, OCCLUDER_LIFT + 0.01);
  }

  setEnabled(v) {
    this.enabled = !!v;
    this.group.visible = this.enabled && this.open > 0;
  }

  /** Iris: 0 closes the hole completely (solid occluder, no ring), 1 is the full PORTAL_RADIUS window. */
  setOpen(p) {
    this.open = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 1));
    this.occluder.material.uniforms.uRadius.value = this.radius * this.open;
    this.ring.scale.setScalar(Math.max(this.open, 1e-3));
    this.ring.material.opacity = 0.85 * this.open;
    this.group.visible = this.enabled && this.open > 0;
  }

  /**
   * Center the hole where the camera's forward ray meets the wall plane, in the portal's
   * local frame under sceneRoot (alignment nudges move sceneRoot, so the wall moves with it).
   * On a miss the hole stays where it last was; a far grazing hit is pulled back to PORTAL_REACH.
   * `outside` says which side of the wall the camera is on (true: looking in through the wall).
   */
  update(camera, sceneRoot) {
    if (!this.enabled) {
      this.state = { enabled: false, hit: this.toRoot(this.hit), miss: false, clamped: false, outside: this.state.outside, open: this.open };
      return this.state;
    }
    sceneRoot.updateMatrixWorld();
    this._origin.setFromMatrixPosition(camera.matrixWorld);
    this._dir.set(0, 0, -1).transformDirection(camera.matrixWorld);
    this._inverse.copy(this.group.matrixWorld).invert();
    this._origin.applyMatrix4(this._inverse);
    this._dir.transformDirection(this._inverse);
    const origin = [this._origin.x, this._origin.y, this._origin.z];
    const hit = intersectWallPlane(origin, [this._dir.x, this._dir.y, this._dir.z], 0);
    let clamped = false;
    if (hit) {
      ({ hit: this.hit, clamped } = clampWallHit(hit, [origin[0], origin[1]], PORTAL_REACH));
      this.place();
    }
    this.state = { enabled: true, hit: this.toRoot(this.hit), miss: !hit, clamped, outside: origin[2] > 0, open: this.open };
    return this.state;
  }

  dispose() {
    this.occluder.geometry.dispose();
    this.occluder.material.dispose();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
  }
}
