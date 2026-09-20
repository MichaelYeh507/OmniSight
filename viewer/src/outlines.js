// Object outlines: the "3D sketch" of the reference image (translucent cyan room, furniture as hot-red
// wireframe). <scene>/outlines.json lists hand-annotated boxes:
//   [{ "label": "bed", "center": [x, y, z], "size": [w, h, d], "yaw": 0, "t": 12.4 }]
// in the recording frame, metres, yaw in degrees about Y. `t` is the replay time the outline draws
// itself in; without it the viewer takes the time the map first saw the box's own points, so a sketch
// never appears before its surface does. Outlines ignore depth (they show through the wall like ghosts
// do) and carry age like everything else: full opacity for 5 s, settling to 55 % by 30 s.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { makeLabel } from './label.js';
import { STALE_START, STALE_END } from './points.js';

export const OUTLINE_COLOR = 0xff2d55; // the reference's hot red; the person stays orange
const OUTLINE_LABEL = '#ff6b85';
const OUTLINE_BLUEPRINT = 0xd8321a;
export const OUTLINE_REVEAL = 0.6; // seconds a box takes to draw itself in
const CORE_PX = 1.8;
const GLOW_PX = 7;

// the 12 edges of a unit cube centred on the origin, as line-segment pairs
const UNIT_EDGES = (() => {
  const c = [];
  for (let i = 0; i < 8; i++) c.push([(i & 1 ? 0.5 : -0.5), (i & 2 ? 0.5 : -0.5), (i & 4 ? 0.5 : -0.5)]);
  const pairs = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  return pairs.flatMap(([a, b]) => [...c[a], ...c[b]]);
})();

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** First-seen time of a box: the 10th percentile of tSeen over the static points inside it (or +inf). */
export function firstSeenInBox(staticData, box) {
  const { positions, tSeen, count } = staticData;
  const [cx, cy, cz] = box.center;
  const [sx, sy, sz] = box.size;
  const yaw = (box.yaw || 0) * Math.PI / 180;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const ts = [];
  for (let i = 0; i < count; i++) {
    const dx = positions[3 * i] - cx, dy = positions[3 * i + 1] - cy, dz = positions[3 * i + 2] - cz;
    const lx = cos * dx - sin * dz, lz = sin * dx + cos * dz; // into the box frame
    if (Math.abs(lx) <= sx / 2 && Math.abs(dy) <= sy / 2 && Math.abs(lz) <= sz / 2) ts.push(tSeen[i]);
  }
  if (!ts.length) return Infinity;
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length * 0.1)];
}

/**
 * Patch a LineMaterial so its fragments fade with the soft x-ray spot (the same uHole uniform PointCloud
 * fills per view: centre x, y, radius in pixels, feather). Radius 0 = no masking.
 */
function maskWithSpot(material, holeUniform) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHole = holeUniform;
    shader.fragmentShader = shader.fragmentShader
      .replace('uniform float opacity;', 'uniform float opacity;\nuniform vec4 uHole;')
      .replace('gl_FragColor = vec4( diffuseColor.rgb, alpha );',
        `float spot = 1.0;
        if (uHole.z > 0.0) {
          spot = 1.0 - smoothstep(uHole.z * (1.0 - uHole.w), uHole.z, distance(gl_FragCoord.xy, uHole.xy));
          if (spot < 0.01) discard;
        }
        gl_FragColor = vec4( diffuseColor.rgb, alpha * spot );`);
  };
  material.customProgramCacheKey = () => 'omni-spot';
}

export class Outlines {
  /**
   * list: outlines.json entries. opts: { staticData (for missing `t`), labels: true, hole: the PointCloud's uHole
   * uniform (outlines then show only inside the soft x-ray spot) }
   */
  constructor(list, { staticData = null, labels = true, hole = null } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'outlines';
    this.hole = hole;
    this.resolution = new THREE.Vector2(1920, 1080);
    const size = new THREE.Vector2();
    const onBeforeRender = (renderer, _scene, camera) => {
      // fat lines are sized in pixels: tell the material how big the view is (per XR view when presenting)
      if (camera.viewport) this.resolution.set(camera.viewport.z, camera.viewport.w);
      else renderer.getDrawingBufferSize(size), this.resolution.copy(size);
      this.lastCamera = camera; // for the tag gating in update(): the view the sketch was last drawn with
      this.lastViewport = camera.viewport ? [camera.viewport.x, camera.viewport.y, camera.viewport.z, camera.viewport.w] : [0, 0, this.resolution.x, this.resolution.y];
    };
    const geometry = new LineSegmentsGeometry().setPositions(UNIT_EDGES);
    this.items = list.map((box, i) => {
      const t = Number.isFinite(box.t) ? box.t : staticData ? firstSeenInBox(staticData, box) : 0;
      const core = new LineMaterial({ color: OUTLINE_COLOR, linewidth: CORE_PX, transparent: true, opacity: 1, depthTest: false, depthWrite: false, worldUnits: false });
      const glow = new LineMaterial({ color: OUTLINE_COLOR, linewidth: GLOW_PX, transparent: true, opacity: 0.12, depthTest: false, depthWrite: false, worldUnits: false, blending: THREE.AdditiveBlending });
      core.resolution = this.resolution;
      glow.resolution = this.resolution;
      if (hole) { maskWithSpot(core, hole); maskWithSpot(glow, hole); }
      const node = new THREE.Group();
      node.name = `outline-${i}`;
      node.position.fromArray(box.center);
      node.rotation.y = (box.yaw || 0) * Math.PI / 180;
      const lines = [glow, core].map((m, k) => {
        const mesh = new LineSegments2(geometry, m);
        mesh.scale.fromArray(box.size);
        mesh.renderOrder = 7 + k * 0.1; // under ghosts and the ring, over the points
        mesh.frustumCulled = false;
        mesh.onBeforeRender = onBeforeRender;
        return mesh;
      });
      node.add(...lines);
      let label = null;
      if (labels && box.label && typeof document !== 'undefined') {
        label = makeLabel({ color: OUTLINE_LABEL, width: 0.8 });
        label.setText(box.label);
        label.sprite.position.set(-box.size[0] / 2, Math.min(box.size[1] / 2 + 0.16, 0.55), 0); // above the box's left edge, hanging right; tall boxes keep the tag near eye height
        label.sprite.renderOrder = 11;
        node.add(label.sprite);
      }
      node.visible = false;
      this.group.add(node);
      return { box: { ...box, t }, node, glow: lines[0], core: lines[1], glowMat: glow, coreMat: core, label, t, size: [...box.size] };
    });
    this.geometry = geometry;
    this.blueprint = false;
    this.state = [];
  }

  setLook(look) {
    this.blueprint = look === 'blueprint';
    for (const it of this.items) {
      it.coreMat.color.set(this.blueprint ? OUTLINE_BLUEPRINT : OUTLINE_COLOR);
      it.glow.visible = !this.blueprint;
    }
  }

  /** Replay time t and the x-ray reveal (0..1). Returns [{ label, t, visible, alpha }] for the debug surface. */
  update(t, reveal = 1) {
    // tags are sprites, not maskable per fragment: show a tag only while its box centre lies inside the spot (last projected view)
    const hole = this.hole ? this.hole.value : null;
    const spotOn = hole && hole.z > 0;
    if (spotOn && !this._proj) { this._proj = new THREE.Vector3(); }
    this.state = this.items.map((it) => {
      const p = OUTLINE_REVEAL > 0 ? Math.min(1, Math.max(0, (t - it.t) / OUTLINE_REVEAL)) : t >= it.t ? 1 : 0;
      const visible = p > 0 && reveal > 0;
      it.node.visible = visible;
      if (!visible) return { label: it.box.label, t: it.t, visible: false, alpha: 0 };
      const ease = 1 - (1 - p) * (1 - p);
      const age = t - it.t;
      const alpha = (1 - 0.45 * smoothstep(STALE_START, STALE_END, age)) * ease * reveal;
      const s = 0.7 + 0.3 * ease; // draws itself in from the centre
      it.core.scale.set(it.size[0] * s, it.size[1] * s, it.size[2] * s);
      it.glow.scale.copy(it.core.scale);
      it.coreMat.opacity = alpha;
      it.glowMat.opacity = 0.12 * alpha;
      if (it.label) {
        let tag = 0.92 * alpha;
        if (spotOn && this.lastCamera && this.lastViewport) {
          const [vx, vy, vw, vh] = this.lastViewport;
          it.node.getWorldPosition(this._proj).project(this.lastCamera);
          const px = vx + (this._proj.x + 1) / 2 * vw;
          const py = vy + (this._proj.y + 1) / 2 * vh;
          const d = Math.hypot(px - hole.x, py - hole.y);
          tag *= Math.max(0, Math.min(1, (hole.z - d) / (hole.z * hole.w + 1e-3)));
        }
        it.label.setOpacity(tag);
      }
      return { label: it.box.label, t: it.t, visible: true, alpha };
    });
    return this.state;
  }

  dispose() {
    this.geometry.dispose();
    for (const it of this.items) { it.coreMat.dispose(); it.glowMat.dispose(); it.label?.dispose(); }
  }
}
