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

const vertexShader = /* glsl */ `
  attribute vec4 aColor;
  uniform float uViewportH;
  uniform float uMinPx;
  uniform float uMaxPx;
  uniform float uRadius;
  uniform float uSizeScale;
  varying vec4 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float px = uRadius * projectionMatrix[1][1] * uViewportH / max(-mv.z, 0.01);
    gl_PointSize = clamp(px * uSizeScale, uMinPx, uMaxPx);
    vColor = aColor;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uTint;
  uniform float uAlpha;
  varying vec4 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d2 = dot(c, c);
    if (d2 > 0.25) discard;
    // soft round splat, tinted by the highlight colour, a little of the source luminance kept
    float lum = dot(vColor.rgb, vec3(0.299, 0.587, 0.114));
    float soft = 1.0 - smoothstep(0.12, 0.25, d2);
    // additive blending: keep per-point alpha low so overlaps stay red-orange instead of burning to white
    gl_FragColor = vec4(uTint * (0.6 + 0.4 * lum), uAlpha * vColor.a * (0.16 + 0.34 * soft));
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
      uMaxPx: { value: Math.min(opts.maxPx ?? 32, 256) },
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
      blending: THREE.AdditiveBlending,
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

    this.label = makeLabel({ color: LABEL_COLOR });
    this.group.add(this.label.sprite);

    this.state = null;
    this.group.visible = false;
  }

  /** Additive glow on dark looks; solid red on the white blueprint look. */
  setLook(look) {
    const blueprint = look === 'blueprint';
    this.material.blending = blueprint ? THREE.NormalBlending : THREE.AdditiveBlending;
    this.material.needsUpdate = true;
    this.uniforms.uTint.value.set(blueprint ? 0xd8321a : GHOST_TINT.getHex());
  }

  /** Update for replay time t. Returns the ghost state (or null) for the debug surface. */
  update(t) {
    const s = ghostStateAt(this.entries, t);
    if (!s || s.alpha <= 0 || s.entry.count === 0) {
      this.group.visible = false;
      this.state = s ? { ...s, entry: undefined, visible: false } : null;
      return this.state;
    }
    this.group.visible = true;
    this.geometry.setDrawRange(s.entry.start, s.entry.count);
    this.uniforms.uAlpha.value = s.alpha;
    const [cx, cy, cz] = s.entry.centroid;
    this.label.sprite.position.set(cx, cy + 1.0, cz);
    this.label.setText(s.seen ? 'person' : `person · last seen ${s.lastSeen} s ago`);
    this.label.setOpacity(s.seen ? 0.9 : 0.35 + 0.65 * s.alpha);
    this.state = { index: s.index, t: s.entry.t, age: s.age, seen: s.seen, alpha: s.alpha, lastSeen: s.lastSeen, visible: true, count: s.entry.count, centroid: s.entry.centroid };
    return this.state;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.label.dispose();
  }
}
