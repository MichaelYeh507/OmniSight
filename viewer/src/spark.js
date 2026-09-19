// Optional Gaussian-splat renderer for the static map (?renderer=spark). Owner: Dev B.
//
// This does NOT reconstruct anything: it renders the exact LiDAR points A already
// fused, but draws each one as a flat oriented Gaussian disk (a "splat") instead of a
// round dot. Each splat lies in the surface it belongs to -- oriented by the point's
// normal, sized by its radius -- so overlapping disks read as a smooth, solid surface.
// Points stays the default and the fallback; per the honesty rule we only call this
// Gaussian splatting when this path actually ships.
//
// Loaded dynamically so the default points build never pulls in the Spark bundle.
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

// A splat is a 3D Gaussian: three std-devs (scales) rotated by a quaternion. For a
// surface disk we make two axes wide (in the tangent plane) and one axis thin (along
// the normal). SCALE widens the disk past the point radius so neighbours just overlap
// and fill gaps without smearing detail; THIN keeps the sheet flat; the reference thin
// axis is local +Z.
const SCALE = 1.05;
const THIN = 0.1;
const OPACITY = 1.0;

export class SparkCloud {
  /**
   * @param renderer THREE.WebGLRenderer already driving the scene
   * @param scene    the THREE.Scene (the SparkRenderer attaches here)
   * @param datasets one or more point sets to splat together, each
   *                 { count, positions(3N f32), normals(3N f32), colors(4N u8),
   *                 radius(N f32) } -- e.g. [data.static, data.alignment]
   * @param opts { sizeScale } extra multiplier from ?psize
   */
  constructor(renderer, scene, datasets, { sizeScale = 1 } = {}) {
    this.spark = new SparkRenderer({ renderer });
    scene.add(this.spark);

    const sets = (Array.isArray(datasets) ? datasets : [datasets]).filter((d) => d && d.count);
    const total = sets.reduce((s, d) => s + d.count, 0);
    const scale = SCALE * (sizeScale || 1);

    // Reused scratch objects: allocating per splat would thrash GC across 100k+ points.
    const center = new THREE.Vector3();
    const scales = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const color = new THREE.Color();
    const normal = new THREE.Vector3();
    const localThinAxis = new THREE.Vector3(0, 0, 1);

    this.mesh = new SplatMesh({
      maxSplats: total,
      constructSplats: (splats) => {
        for (const { count, positions, normals, colors, radius } of sets) {
          for (let i = 0; i < count; i++) {
            center.set(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);

            if (normals) normal.set(normals[3 * i], normals[3 * i + 1], normals[3 * i + 2]);
            if (!normals || !Number.isFinite(normal.x) || normal.lengthSq() < 1e-8) normal.copy(localThinAxis);
            else normal.normalize();
            quaternion.setFromUnitVectors(localThinAxis, normal); // local +Z -> surface normal

            const r = Math.max(radius[i] * scale, 1e-4);
            scales.set(r, r, Math.max(r * THIN, 1e-4)); // wide, wide, thin along the normal

            // Recorded RGB bytes are sRGB; tag them so three converts correctly on output.
            color.setRGB(colors[4 * i] / 255, colors[4 * i + 1] / 255, colors[4 * i + 2] / 255, THREE.SRGBColorSpace);

            splats.pushSplat(center, scales, quaternion, OPACITY, color);
          }
        }
      },
    });
  }

  /** The SplatMesh; add it to the group that alignment nudges (sceneRoot). */
  get object() {
    return this.mesh;
  }

  dispose() {
    this.mesh?.dispose?.();
    this.spark?.parent?.remove(this.spark);
    this.spark?.dispose?.();
  }
}
