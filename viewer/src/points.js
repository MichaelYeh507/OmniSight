// Point renderer: THREE.Points with a custom shader. Reveal (aTime > uClock hides the
// splat) and staleness (colour fades toward blue-gray with age) both happen on the GPU,
// so every chunk is uploaded once and playback only changes uniforms and the draw range.
import * as THREE from 'three';

export const STALE_START = 5; // seconds of full colour
export const STALE_END = 30; // fully stale from here on
const STALE_COLOR = new THREE.Color(0.55, 0.62, 0.72);

// Colour treatments of the static map (?look=). "color" keeps the recorded RGB and fades it
// toward STALE_COLOR; the palette looks map fresh -> stale onto two colours instead.
export const LOOKS = {
  color: null,
  xray: { fresh: 0x9ef4ff, stale: 0x24476b }, // reference: glowing cyan x-ray walls on black
  blueprint: { fresh: 0x34486a, stale: 0xa8b6c8 }, // reference: architectural wireframe on white; drawn with half-size points so surfaces stipple
};

const vertexShader = /* glsl */ `
  attribute vec4 aColor;
  attribute float aRadius;
  attribute float aTime;
  uniform float uClock;
  uniform float uIgnoreTime;   // 1.0: always visible, never stale (alignment cloud)
  uniform float uViewportH;    // drawing-buffer or XR-view height in pixels
  uniform float uMinPx;
  uniform float uMaxPx;
  uniform float uSizeScale;
  uniform vec3 uClipMax;       // cutaway: hide points above y or beyond z (recording frame)
  varying vec4 vColor;
  varying float vAge;
  void main() {
    if ((uIgnoreTime < 0.5 && aTime > uClock) || position.y > uClipMax.y || position.z > uClipMax.z) {
      // not seen yet: park it outside clip space, never rasterised
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vColor = vec4(0.0);
      vAge = 0.0;
      return;
    }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // pixel diameter of a disk of radius aRadius at depth -mv.z, valid per XR view too
    float px = aRadius * projectionMatrix[1][1] * uViewportH / max(-mv.z, 0.01);
    gl_PointSize = clamp(px * uSizeScale, uMinPx, uMaxPx);
    vColor = aColor;
    vAge = uIgnoreTime > 0.5 ? 0.0 : (uClock - aTime);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uStaleStart;
  uniform float uStaleEnd;
  uniform vec3 uStaleColor;
  uniform float uRound;
  uniform float uBrightness;
  uniform float uXray;        // 0: recorded colour, 1: palette look
  uniform vec3 uXrayFresh;
  uniform vec3 uXrayStale;
  varying vec4 vColor;
  varying float vAge;
  void main() {
    if (uRound > 0.5) {
      vec2 c = gl_PointCoord - 0.5;
      if (dot(c, c) > 0.25) discard;
    }
    float k = smoothstep(uStaleStart, uStaleEnd, vAge);
    float lum = dot(vColor.rgb, vec3(0.299, 0.587, 0.114));
    vec3 stale = uStaleColor * (0.35 + 0.65 * lum);
    // colours are sRGB bytes written straight to the sRGB framebuffer: no conversion
    vec3 recorded = mix(vColor.rgb, stale, k);
    // palette look: fresh-to-stale colours scaled by the recorded luminance, so texture and edges survive
    vec3 palette = mix(uXrayFresh, uXrayStale, k) * (0.4 + 0.8 * lum);
    gl_FragColor = vec4(mix(recorded, palette, uXray) * uBrightness, 1.0);
  }
`;

/** Largest point size this GPU rasterises; the shader clamps to it. */
export function maxPointSize(renderer) {
  const gl = renderer.getContext();
  const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  return range ? range[1] : 64;
}

export class PointCloud {
  /**
   * data: { count, positions (3N f32), colors (4N u8), radius (N f32), tSeen (N f32) }
   * opts: { ignoreTime, round, maxPx, sizeScale, brightness, renderOrder }
   */
  constructor(data, opts = {}) {
    this.count = data.count;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(data.colors, 4, true));
    geometry.setAttribute('aRadius', new THREE.BufferAttribute(data.radius, 1));
    geometry.setAttribute('aTime', new THREE.BufferAttribute(data.tSeen, 1));
    geometry.setDrawRange(0, opts.ignoreTime ? data.count : 0);

    this.uniforms = {
      uClock: { value: 0 },
      uIgnoreTime: { value: opts.ignoreTime ? 1 : 0 },
      uViewportH: { value: 1080 },
      uMinPx: { value: 1 },
      uMaxPx: { value: Math.min(opts.maxPx ?? 24, 256) },
      uSizeScale: { value: opts.sizeScale ?? 1 },
      uStaleStart: { value: STALE_START },
      uStaleEnd: { value: STALE_END },
      uStaleColor: { value: STALE_COLOR.clone() },
      uRound: { value: opts.round ? 1 : 0 },
      uBrightness: { value: opts.brightness ?? 1 },
      uXray: { value: 0 },
      uClipMax: { value: new THREE.Vector3(1e9, 1e9, 1e9) },
      uXrayFresh: { value: new THREE.Color(LOOKS.xray.fresh) },
      uXrayStale: { value: new THREE.Color(LOOKS.xray.stale) },
    };
    const material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader, fragmentShader });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false; // one huge object; culling it whole is never right
    points.renderOrder = opts.renderOrder ?? 0;
    const size = new THREE.Vector2();
    points.onBeforeRender = (renderer, _scene, camera) => {
      // XR sub-cameras carry their own viewport; on a flat screen use the drawing buffer
      this.uniforms.uViewportH.value = camera.viewport ? camera.viewport.w : renderer.getDrawingBufferSize(size).y;
    };
    this.object = points;
    this.geometry = geometry;
    this.material = material;
    this.drawCount = geometry.drawRange.count;
  }

  setClock(t) {
    this.uniforms.uClock.value = t;
  }

  /** How many splats to submit this frame (time-sorted, so a prefix). */
  setDrawCount(n) {
    const c = Math.max(0, Math.min(this.count, n | 0));
    if (c !== this.drawCount) {
      this.drawCount = c;
      this.geometry.setDrawRange(0, c);
    }
  }

  /** Cutaway clip: { y, z } hides points above y or with z beyond z; null shows everything. */
  setCutaway(clip) {
    this.uniforms.uClipMax.value.set(1e9, clip ? clip.y : 1e9, clip ? clip.z : 1e9);
  }

  /** Switch the colour treatment: 'color', 'xray' or 'blueprint'. */
  setLook(look) {
    const palette = LOOKS[look];
    this.uniforms.uXray.value = palette ? 1 : 0;
    if (palette) {
      this.uniforms.uXrayFresh.value.set(palette.fresh);
      this.uniforms.uXrayStale.value.set(palette.stale);
    }
  }

  setStaleness(start, end) {
    this.uniforms.uStaleStart.value = start;
    this.uniforms.uStaleEnd.value = end;
  }

  set visible(v) {
    this.object.visible = v;
  }
  get visible() {
    return this.object.visible;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
