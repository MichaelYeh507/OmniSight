// Re-splits a scene at a different wall plane without touching the recording: every point from chunks/ and
// alignment.bin is re-bucketed by its own t_seen into 0.5 s chunks (z <= wall_z) or into alignment.bin (z > wall_z).
// Use it when a take was exported with the wrong --wall-z (A's pipeline default is -1.8) and re-running the pipeline
// is not possible here, e.g. the masked scene needs C's segmentation model.
//   node scripts/resplit-scene.mjs --in public/scenes/room012_masked --out public/scenes/room012_video --wall-z 1.5
import fs from 'node:fs';
import path from 'node:path';
import { parseChunk } from '../src/format.js';
import { encodeChunk, writeScene } from './omni-format.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const inDir = flag('in', null);
const outDir = flag('out', null);
const wallZ = Number(flag('wall-z', NaN));
if (!inDir || !outDir || !Number.isFinite(wallZ)) throw new Error('usage: --in <scene dir> --out <scene dir> --wall-z <z>');
const WINDOW = 0.5;

const manifest = JSON.parse(fs.readFileSync(path.join(inDir, 'manifest.json'), 'utf8'));
const read = (file) => { const b = fs.readFileSync(path.join(inDir, file)); return parseChunk(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), file); };
const parts = manifest.chunks.map((c) => read(c.file));
if (manifest.alignment_chunk && fs.existsSync(path.join(inDir, manifest.alignment_chunk))) parts.push(read(manifest.alignment_chunk));
const total = parts.reduce((s, p) => s + p.n, 0);
const all = { positions: new Float32Array(3 * total), normals: new Float32Array(3 * total), radius: new Float32Array(total), tSeen: new Float32Array(total), rgbs: new Uint8Array(4 * total) };
let o = 0;
for (const p of parts) {
  all.positions.set(p.positions, 3 * o); all.normals.set(p.normals, 3 * o); all.radius.set(p.radius, o); all.tSeen.set(p.tSeen, o); all.rgbs.set(p.rgbs, 4 * o);
  o += p.n;
}
const pick = (indices) => ({
  positions: Float32Array.from(indices.flatMap((i) => [all.positions[3 * i], all.positions[3 * i + 1], all.positions[3 * i + 2]])),
  normals: Float32Array.from(indices.flatMap((i) => [all.normals[3 * i], all.normals[3 * i + 1], all.normals[3 * i + 2]])),
  radius: Float32Array.from(indices, (i) => all.radius[i]),
  tSeen: Float32Array.from(indices, (i) => all.tSeen[i]),
  rgbs: Uint8Array.from(indices.flatMap((i) => [all.rgbs[4 * i], all.rgbs[4 * i + 1], all.rgbs[4 * i + 2], all.rgbs[4 * i + 3]])),
});
const buckets = new Map();
const outside = [];
for (let i = 0; i < total; i++) {
  if (all.positions[3 * i + 2] > wallZ) { outside.push(i); continue; }
  const b = Math.floor(all.tSeen[i] / WINDOW);
  if (!buckets.has(b)) buckets.set(b, []);
  buckets.get(b).push(i);
}
const chunks = [];
const manifestChunks = [];
for (const b of [...buckets.keys()].sort((x, y) => x - y)) {
  const idx = buckets.get(b);
  const tStart = b * WINDOW, tEnd = (b + 1) * WINDOW;
  const file = `chunks/${String(b).padStart(4, '0')}.bin`;
  chunks.push({ file, bytes: encodeChunk({ tStart, tEnd, ...pick(idx) }) });
  manifestChunks.push({ file, t_start: tStart, t_end: tEnd, count: idx.length });
}
const alignEnd = outside.length ? Math.max(WINDOW, Math.max(...outside.map((i) => all.tSeen[i])) + WINDOW) : WINDOW;
const alignment = encodeChunk({ tStart: 0, tEnd: alignEnd, ...pick(outside) });
const trajectory = JSON.parse(fs.readFileSync(path.join(inDir, 'trajectory.json'), 'utf8'));
const people = fs.existsSync(path.join(inDir, 'people.json'))
  ? { index: JSON.parse(fs.readFileSync(path.join(inDir, 'people.json'), 'utf8')), bin: fs.readFileSync(path.join(inDir, 'people.bin')) }
  : null;
const name = path.basename(path.resolve(outDir));
const out = { ...manifest, scene: name, wall_z: wallZ, chunks: manifestChunks, alignment_chunk: 'alignment.bin',
  duration: Math.max(manifest.duration, manifestChunks.length ? manifestChunks[manifestChunks.length - 1].t_end : 0) };
fs.mkdirSync(outDir, { recursive: true });
writeScene(outDir, { manifest: out, chunks, alignment, trajectory, people });
console.log(`${outDir}: ${total - outside.length} static points in ${chunks.length} chunks, ${outside.length} alignment points, wall_z ${wallZ} (was ${manifest.wall_z})`);
