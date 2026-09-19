// Node-side encoder for the OmniSight scene format (docs/CONTRACT.md). Used by the
// tests, by make-scene.mjs and for cross-language checks against common/omni_format.py.
import fs from 'node:fs';
import path from 'node:path';
import { HEADER_SIZE, MAGIC, VERSION, BYTES_PER_GHOST_POINT, chunkSize } from '../src/format.js';

/** Encode one chunk. Arrays: positions/normals 3N float, radius/tSeen N float, rgbs 4N bytes. */
export function encodeChunk({ tStart, tEnd, positions, normals, radius, tSeen, rgbs }) {
  const n = radius.length;
  const check = (arr, len, label) => {
    if (arr.length !== len) throw new Error(`encodeChunk: ${label} has ${arr.length} elements, expected ${len} for N=${n}`);
  };
  check(positions, 3 * n, 'positions');
  check(normals, 3 * n, 'normals');
  check(tSeen, n, 'tSeen');
  check(rgbs, 4 * n, 'rgbs');
  const buf = new ArrayBuffer(chunkSize(n));
  const dv = new DataView(buf);
  for (let i = 0; i < 4; i++) dv.setUint8(i, MAGIC.charCodeAt(i));
  dv.setUint32(4, VERSION, true);
  dv.setUint32(8, n, true);
  dv.setFloat32(12, tStart, true);
  dv.setFloat32(16, tEnd, true);
  dv.setUint32(20, 0, true);
  let o = HEADER_SIZE;
  new Float32Array(buf, o, 3 * n).set(positions);
  o += 12 * n;
  new Float32Array(buf, o, 3 * n).set(normals);
  o += 12 * n;
  new Float32Array(buf, o, n).set(radius);
  o += 4 * n;
  new Float32Array(buf, o, n).set(tSeen);
  o += 4 * n;
  new Uint8Array(buf, o, 4 * n).set(rgbs);
  return new Uint8Array(buf);
}

const round = (v, d) => Number(v.toFixed(d));

/**
 * Encode ghost frames into people.bin bytes plus the people.json index.
 * frames: [{ t, frame, positions: Float32Array(3n), rgba: Uint8Array(4n) }] sorted by t.
 */
export function encodePeople(frames) {
  const total = frames.reduce((s, f) => s + f.positions.length / 3, 0);
  const buf = new ArrayBuffer(BYTES_PER_GHOST_POINT * total);
  const index = [];
  let offset = 0;
  frames.forEach((f, i) => {
    const n = f.positions.length / 3;
    if (!Number.isInteger(n) || f.rgba.length !== 4 * n) {
      throw new Error(`encodePeople: frame ${i} has ${f.positions.length} position values and ${f.rgba.length} rgba bytes`);
    }
    new Float32Array(buf, offset, 3 * n).set(f.positions);
    new Uint8Array(buf, offset + 12 * n, 4 * n).set(f.rgba);
    const c = [0, 0, 0];
    for (let k = 0; k < n; k++) {
      c[0] += f.positions[3 * k];
      c[1] += f.positions[3 * k + 1];
      c[2] += f.positions[3 * k + 2];
    }
    index.push({
      t: round(f.t, 3),
      frame: f.frame ?? i,
      offset,
      count: n,
      centroid: n ? c.map((v) => round(v / n, 4)) : [0, 0, 0],
    });
    offset += BYTES_PER_GHOST_POINT * n;
  });
  return { bin: new Uint8Array(buf), index };
}

/**
 * Write a whole scene folder.
 * scene: { manifest, chunks: [{ file, bytes }], alignment: Uint8Array|null,
 *          trajectory: [...], people: { bin, index }|null }
 */
export function writeScene(dir, scene) {
  fs.rmSync(path.join(dir, 'chunks'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
  for (const c of scene.chunks) fs.writeFileSync(path.join(dir, c.file), c.bytes);
  const alignName = scene.manifest.alignment_chunk || 'alignment.bin';
  if (scene.alignment) fs.writeFileSync(path.join(dir, alignName), scene.alignment);
  else fs.rmSync(path.join(dir, alignName), { force: true });
  fs.writeFileSync(path.join(dir, 'trajectory.json'), JSON.stringify(scene.trajectory));
  if (scene.people) {
    fs.writeFileSync(path.join(dir, 'people.bin'), scene.people.bin);
    fs.writeFileSync(path.join(dir, 'people.json'), JSON.stringify(scene.people.index));
  } else {
    fs.rmSync(path.join(dir, 'people.bin'), { force: true });
    fs.rmSync(path.join(dir, 'people.json'), { force: true });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(scene.manifest, null, 2) + '\n');
}
