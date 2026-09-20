// Person ghosts: the latest people.bin frame at the replay clock, drawn as a glowing
// red-orange figure that shows through walls (depthTest off). When no newer frame
// exists the last one is held and fades over GHOST_FADE seconds, with a
// "person · last seen N s ago" label at its centroid. The label is always "person":
// no identity, no threat level (design doc, Locked scope).
import * as THREE from 'three';
import { ghostStateAt } from './scene-data.js';
import { makeLabel } from './label.js';

export const GHOST_TINT = new THREE.Color(1.0, 0.36, 0.12);
const LABEL_COLOR = '#ff8a4a';
const GHOST_REF_OVERLAP = 1.5; // the generated capsule's overlap figure: the look tuned by eye
const GHOST_VOXEL = 0.05; // metres, for the occupancy estimate

const vertexShader = /* glsl */ `
  attribute vec4 aColor;
  uniform float uViewportH;
  uniform float uMinPx;
  uniform float uMaxPx;
  uniform float uRadius;
  uniform float uSizeScale;
  uniform float uRefPx;
  varying vec4 vColor;
  varying float vCover;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float px = uRadius * projectionMatrix[1][1] * uViewportH / max(-mv.z, 0.01);
    gl_PointSize = clamp(px * uSizeScale, uMinPx, uMaxPx);
    // a person a metre from the lens draws big overlapping points; additive blending then burns to white.
    // Scale alpha down with on-screen size so the summed brightness stays roughly what it is at a few metres.
    float cover = clamp(uRefPx / gl_PointSize, 0.0, 1.0);
    vCover = cover * cover;
    vColor = aColor;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uTint;
  uniform float uAlpha;
  varying vec4 vColor;
  varying float vCover;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d2 = dot(c, c);
    if (d2 > 0.25) discard;
    // soft round splat, tinted by the highlight colour, a little of the source luminance kept
    float lum = dot(vColor.rgb, vec3(0.299, 0.587, 0.114));
    float soft = 1.0 - smoothstep(0.12, 0.25, d2);
    // normal (over) blending: overlapping points converge to the tint instead of summing to white on bright
    // surfaces; a lighter core keeps a little glow. The person stays orange whatever sits behind it.
    vec3 tint = uTint * (0.75 + 0.25 * lum);
    gl_FragColor = vec4(mix(tint, vec3(1.0, 0.82, 0.55), 0.35 * soft), uAlpha * vColor.a * (0.45 + 0.4 * soft) * max(vCover, 0.15));
  }
`;

export class Ghosts {
  /**
   * people: { entries (sorted by t, each with start/count/centroid), positions (3N f32), rgba (4N u8), total }
   * opts: { maxPx, sizeScale, radius }
   */
  constructor(people, opts = {}) {
    this.entries = people.entries;
    this.group = new THREE.Group();
    this.group.name = 'ghosts';

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(people.positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(people.rgba, 4, true));
    geometry.setDrawRange(0, 0);
    this.uniforms = {
      uViewportH: { value: 1080 },
      uMinPx: { value: 2 },
      uMaxPx: { value: Math.min(opts.maxPx ?? 24, 256) },
      uRefPx: { value: opts.refPx ?? 10 }, // point size (px) at which the additive alpha is at full strength
      uRadius: { value: opts.radius ?? 0.02 },
      uSizeScale: { value: opts.sizeScale ?? 1 },
      uTint: { value: GHOST_TINT.clone() },
      uAlpha: { value: 1 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthTest: false, // a person shows through the whole wall, not only through the portal
      depthWrite: false,
      blending: THREE.NormalBlending, // over, not additive: see the fragment shader
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 10;
    const size = new THREE.Vector2();
    points.onBeforeRender = (renderer, _scene, camera) => {
      this.uniforms.uViewportH.value = camera.viewport ? camera.viewport.w : renderer.getDrawingBufferSize(size).y;
    };
    this.points = points;
    this.geometry = geometry;
    this.material = material;
    this.group.add(points);

    // Per-frame alpha normalisation. With additive blending the summed brightness scales with how densely a
    // frame's points cover the surface they sit on: overlap ~ 4 * count * r^2 / (occupied 5 cm voxels * 0.05^2).
    // The generated capsule (2000 points over ~930 voxels, overlap ~1.4) is the look tuned by eye; a real frame that
    // packs the same count into a torso-sized patch (~170 voxels) is dimmed towards it instead of burning to white.
    const r = opts.radius ?? 0.02;
    const P = people.positions;
    this.alphaScale = this.entries.map((e) => {
      const occupied = new Set();
      for (let i = e.start; i < e.start + e.count; i++) {
        const ix = Math.floor(P[3 * i] / GHOST_VOXEL) + 2048;
        const iy = Math.floor(P[3 * i + 1] / GHOST_VOXEL) + 2048;
        const iz = Math.floor(P[3 * i + 2] / GHOST_VOXEL) + 2048;
        occupied.add((ix * 4096 + iy) * 4096 + iz);
      }
      const overlap = 4 * e.count * r * r / Math.max(occupied.size, 1) / (GHOST_VOXEL * GHOST_VOXEL);
      return Math.min(1, Math.sqrt(GHOST_REF_OVERLAP / Math.max(overlap, 1e-6))); // with over-blending a dense frame still reads as solid orange, a sparse one stays soft
    });
    this.label = makeLabel({ color: LABEL_COLOR, width: 0.9 });
    this.group.add(this.label.sprite);
    // a thin bracket around the figure (chamfered top-left corner, like the reference HUD's person boxes), always facing
    // the viewer; the tag sits at its top-right. Sized for a standing person around the centroid.
    const bw = 0.36; // half width
    const bh = 0.95; // half height
    const ch = 0.12; // chamfer
    const box = [
      -bw + ch, bh, 0, bw, bh, 0,  bw, bh, 0, bw, -bh, 0,  bw, -bh, 0, -bw, -bh, 0,  -bw, -bh, 0, -bw, bh - ch, 0,  -bw, bh - ch, 0, -bw + ch, bh, 0,
    ];
    this.bracket = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(box, 3)),
      new THREE.LineBasicMaterial({ color: LABEL_COLOR, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false }),
    );
    this.bracket.renderOrder = 10;
    this.bracket.frustumCulled = false;
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._bw = bw;
    this._bh = bh;
    this.group.add(this.bracket);

    this.reveal = 1;
    this.state = null;
    this.group.visible = false;
  }

  /** X-ray reveal, 0..1: multiplies every alpha; 0 hides the ghost entirely (camera view). */
  setReveal(r) {
    this.reveal = Math.min(1, Math.max(0, Number.isFinite(r) ? r : 1));
  }

  /** Additive glow on dark looks; solid red on the white blueprint look. */
  setLook(look) {
    const blueprint = look === 'blueprint';
    this.material.blending = THREE.NormalBlending;
    this.material.needsUpdate = true;
    this.uniforms.uTint.value.set(blueprint ? 0xd8321a : GHOST_TINT.getHex());
  }

  /**
   * Face the bracket to `camera` and hang the tag off its top-right corner. Called from the main loop with the
   * camera that will draw this frame (in onBeforeRender the sprite had already been sorted with last frame's
   * position, which made the tag lag and pop while the camera moved).
   */
  face(camera, sceneRoot) {
    if (!this.group.visible) return;
    // billboard in sceneRoot space: undo the root's rotation so the bracket faces the world-space camera
    sceneRoot.getWorldQuaternion(this._q).invert();
    this.bracket.quaternion.copy(this._q).multiply(camera.quaternion);
    this._right.setFromMatrixColumn(camera.matrixWorld, 0).normalize().applyQuaternion(this._q);
    this._up.setFromMatrixColumn(camera.matrixWorld, 1).normalize().applyQuaternion(this._q);
    this.label.sprite.position.copy(this.bracket.position).addScaledVector(this._right, this._bw + 0.05).addScaledVector(this._up, this._bh - 0.02);
  }

  /** Update for replay time t. Returns the ghost state (or null) for the debug surface. */
  update(t) {
    const s = ghostStateAt(this.entries, t);
    if (!s || s.alpha <= 0 || s.entry.count === 0 || this.reveal <= 0) {
      this.group.visible = false;
      this.state = s ? { ...s, entry: undefined, visible: false } : null;
      return this.state;
    }
    this.group.visible = true;
    this.geometry.setDrawRange(s.entry.start, s.entry.count);
    this.uniforms.uAlpha.value = s.alpha * (this.alphaScale[s.index] ?? 1) * this.reveal;
    const [cx, cy, cz] = s.entry.centroid;
    this.bracket.position.set(cx, cy + 0.15, cz); // the centroid of the visible points sits around the chest
    this.label.setText('Person', s.seen ? 'now' : `${s.lastSeen} s ago`);
    const labelAlpha = (s.seen ? 0.95 : 0.35 + 0.65 * s.alpha) * this.reveal;
    this.label.setOpacity(labelAlpha);
    this.bracket.material.opacity = 0.85 * labelAlpha;
    this.state = { index: s.index, t: s.entry.t, age: s.age, seen: s.seen, alpha: s.alpha, lastSeen: s.lastSeen, visible: true, count: s.entry.count, centroid: s.entry.centroid };
    return this.state;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.label.dispose();
    this.bracket.geometry.dispose();
    this.bracket.material.dispose();
  }
}
