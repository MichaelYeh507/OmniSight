// Run with `npm test` (node --test). Covers the JS side of docs/CONTRACT.md:
// encode -> parse round trips, rejection of broken files, the generated box scene
// passing the validator, and the validator catching a corrupted chunk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseChunk, parsePeople, concatPeople, chunkSize, HEADER_SIZE } from '../src/format.js';
import { encodeChunk, encodePeople, writeScene } from '../scripts/omni-format.mjs';
import { makeScene } from '../scripts/make-scene.mjs';
import { validateScene } from '../scripts/validate-scene.mjs';

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function randomSplats(n, seed = 7) {
  const r = lcg(seed);
  const positions = new Float32Array(3 * n).map(() => r() * 6 - 3);
  const normals = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const v = [r() - 0.5, r() - 0.5, r() - 0.5];
    const len = Math.hypot(...v) || 1;
    normals.set(v.map((c) => c / len), 3 * i);
  }
  const radius = new Float32Array(n).map(() => 0.005 + r() * 0.045);
  const tSeen = Float32Array.from({ length: n }, () => r() * 0.5).sort();
  const rgbs = new Uint8Array(4 * n).map((_, i) => (i % 4 === 3 ? 0 : Math.floor(r() * 256)));
  return { tStart: 0, tEnd: 0.5, positions, normals, radius, tSeen, rgbs };
}

const tmpDir = () => {
  const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omni-")), "test_scene");
  fs.mkdirSync(d);
  return d;
};

test('chunk encode -> parse round trip', () => {
  const n = 1234;
  const s = randomSplats(n);
  const bytes = encodeChunk(s);
  assert.equal(bytes.byteLength, chunkSize(n));
  assert.equal(bytes.byteLength, 24 + 36 * n);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'OMNI');

  const c = parseChunk(bytes.buffer);
  assert.equal(c.n, n);
  assert.equal(c.version, 1);
  assert.equal(c.tStart, 0);
  assert.equal(c.tEnd, 0.5);
  assert.deepEqual(c.positions, s.positions);
  assert.deepEqual(c.normals, s.normals);
  assert.deepEqual(c.radius, s.radius);
  assert.deepEqual(c.tSeen, s.tSeen);
  assert.deepEqual(c.rgbs, s.rgbs);
  // views are zero-copy and 4-byte aligned
  assert.equal(c.positions.buffer, bytes.buffer);
  for (const a of [c.positions, c.normals, c.radius, c.tSeen]) assert.equal(a.byteOffset % 4, 0);
});

test('empty chunk is header only', () => {
  const bytes = encodeChunk(randomSplats(0));
  assert.equal(bytes.byteLength, HEADER_SIZE);
  assert.equal(parseChunk(bytes.buffer).n, 0);
});

test('parser accepts Node Buffers at a slab offset', () => {
  const bytes = encodeChunk(randomSplats(10));
  const slab = Buffer.alloc(bytes.byteLength + 3);
  slab.set(bytes, 3);
  const c = parseChunk(slab.subarray(3));
  assert.equal(c.n, 10);
});

test('parser rejects truncated, mislabelled and mis-versioned files', () => {
  const bytes = encodeChunk(randomSplats(50));
  assert.throws(() => parseChunk(bytes.buffer.slice(0, bytes.byteLength - 1)), /bytes but the header says N=50/);
  assert.throws(() => parseChunk(bytes.buffer.slice(0, 10)), /shorter than the 24-byte header/);
  const bad = new Uint8Array(bytes);
  bad[0] = 'X'.charCodeAt(0);
  assert.throws(() => parseChunk(bad.buffer), /bad magic/);
  const v2 = new Uint8Array(bytes);
  new DataView(v2.buffer).setUint32(4, 2, true);
  assert.throws(() => parseChunk(v2.buffer), /version 2, expected 1/);
});

test('people encode -> parse: offsets, counts, centroids, concat starts', () => {
  const r = lcg(3);
  const frames = [100, 101, 102].map((n, i) => ({
    t: 12.4 + i * 0.1,
    frame: 372 + i,
    positions: new Float32Array(3 * n).map(() => r() * 4 - 2),
    rgba: new Uint8Array(4 * n).map(() => Math.floor(r() * 256)),
  }));
  const { bin, index } = encodePeople(frames);
  assert.equal(bin.byteLength, 16 * (100 + 101 + 102));
  assert.deepEqual(index.map((e) => e.offset), [0, 1600, 1600 + 1616]);
  assert.deepEqual(index.map((e) => e.count), [100, 101, 102]);

  const { entries, totalPoints } = parsePeople(index, bin.buffer);
  assert.equal(totalPoints, 303);
  assert.deepEqual(entries.map((e) => e.start), [0, 100, 201]);
  entries.forEach((e, i) => {
    assert.deepEqual(e.positions, frames[i].positions);
    assert.deepEqual(e.rgba, frames[i].rgba);
    const c = [0, 0, 0];
    for (let k = 0; k < e.count; k++) for (let d = 0; d < 3; d++) c[d] += e.positions[3 * k + d];
    for (let d = 0; d < 3; d++) assert.ok(Math.abs(c[d] / e.count - e.centroid[d]) < 1e-3);
  });

  const packed = concatPeople(entries);
  assert.equal(packed.total, 303);
  assert.deepEqual(packed.positions.subarray(3 * 100, 3 * 201), frames[1].positions);
  assert.deepEqual(packed.rgba.subarray(4 * 201), frames[2].rgba);

  // a wrong offset is a contract violation
  const broken = index.map((e) => ({ ...e }));
  broken[1].offset += 16;
  assert.throws(() => parsePeople(broken, bin.buffer), /offset 1616, expected 1600/);
  // an unsorted index is too
  const unsorted = index.map((e) => ({ ...e }));
  unsorted[2].t = 0;
  assert.throws(() => parsePeople(unsorted, bin.buffer), /sort people.json by t/);
});

test('generated box scene passes the validator', () => {
  const dir = tmpDir();
  const scene = makeScene({ name: path.basename(dir), points: 3000, duration: 4, person: '1:2', personPoints: 50, personFps: 5 });
  writeScene(dir, scene);
  const r = validateScene(dir);
  assert.deepEqual(r.errors, []);
  assert.ok(r.ok);
  assert.ok(r.stats.staticPoints > 2000 && r.stats.staticPoints < 4000, `static points ${r.stats.staticPoints}`);
  assert.ok(r.stats.alignmentPoints > 0);
  assert.equal(r.stats.peopleFrames, 6); // 1.0, 1.2, ..., 2.0 at 5 fps
  assert.equal(scene.manifest.duration, 4);
  assert.deepEqual(scene.trajectory[0].position, [0, 0, 0]);
  assert.deepEqual(scene.trajectory[0].quaternion, [0, 0, 0, 1]);
  // reveal order: the first chunk starts at 0 and chunks are contiguous half-second windows
  assert.equal(scene.manifest.chunks[0].t_start, 0);
  for (const c of scene.manifest.chunks) assert.equal(c.t_end - c.t_start, 0.5);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test('validator first pose: zero position and zero yaw required, pitch and roll from an unlevel jig allowed', () => {
  const pitched = [Math.sin(-Math.PI / 24), 0, 0, Math.cos(-Math.PI / 24)]; // 15 deg pitch down, no yaw
  const yawed = [0, Math.sin(Math.PI / 36), 0, Math.cos(Math.PI / 36)]; // 10 deg yaw
  const cases = [
    { quaternion: pitched, ok: true, pattern: /tilted 15\.0 deg/ },
    { quaternion: yawed, ok: false, pattern: /must face -Z .*yaw 10\.0 deg/ },
    { quaternion: [0, 0, 0, 1], position: [0.02, 0, 0], ok: false, pattern: /first position must be \[0,0,0\]/ },
    { quaternion: [Math.sin(-Math.PI / 4), 0, 0, Math.cos(-Math.PI / 4)], ok: false, pattern: /no horizontal heading/ },
  ];
  for (const c of cases) {
    const dir = tmpDir();
    const scene = makeScene({ name: path.basename(dir), points: 1500, duration: 3, person: '1:2', personPoints: 20, personFps: 5 });
    scene.trajectory[0] = { ...scene.trajectory[0], quaternion: c.quaternion, position: c.position || [0, 0, 0] };
    writeScene(dir, scene);
    const r = validateScene(dir);
    assert.equal(r.ok, c.ok, `${JSON.stringify(c)} -> ${JSON.stringify(r.errors)}`);
    const lines = [...r.errors, ...(r.warnings || [])];
    assert.ok(lines.some((line) => c.pattern.test(line)), `expected ${c.pattern} in ${JSON.stringify(lines)}`);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('generated two-source scene: second responder with its own source id, one trajectory sorted by t, validator clean', () => {
  const dir = tmpDir();
  const scene = makeScene({ name: path.basename(dir), points: 3000, duration: 8, person: '1:2', personPoints: 50, personFps: 5, sources: 2 });
  writeScene(dir, scene);
  const r = validateScene(dir);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(scene.manifest.sources.map((s) => s.id), [0, 1]);
  const bySource = new Map();
  for (const p of scene.trajectory) bySource.set(p.source, (bySource.get(p.source) || 0) + 1);
  assert.deepEqual([...bySource.keys()].sort(), [0, 1]);
  assert.ok(bySource.get(1) > 10 && bySource.get(1) < bySource.get(0), `source 1 starts later: ${bySource.get(1)} of ${bySource.get(0)}`);
  for (let i = 1; i < scene.trajectory.length; i++) assert.ok(scene.trajectory[i].t >= scene.trajectory[i - 1].t, 'sorted by t');
  assert.deepEqual(scene.trajectory[0], { t: 0, source: 0, position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
  const firstOfSecond = scene.trajectory.find((p) => p.source === 1);
  assert.deepEqual([firstOfSecond.position, firstOfSecond.quaternion], [[0, 0, 0], [0, 0, 0, 1]]); // starts at the jig too
  const ids = new Set();
  for (const c of scene.chunks) { const p = parseChunk(c.bytes.buffer.slice(c.bytes.byteOffset, c.bytes.byteOffset + c.bytes.byteLength), c.file); for (let i = 0; i < p.n; i++) ids.add(p.rgbs[4 * i + 3]); }
  assert.deepEqual([...ids].sort(), [0, 1]);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test('validator catches a corrupted chunk and a missing people.bin', () => {
  const dir = tmpDir();
  writeScene(dir, makeScene({ name: path.basename(dir), points: 1000, duration: 2, person: '0.5:1', personPoints: 20, personFps: 4 }));
  const first = path.join(dir, 'chunks', '0000.bin');
  fs.writeFileSync(first, fs.readFileSync(first).subarray(0, 100));
  fs.rmSync(path.join(dir, 'people.bin'));
  const r = validateScene(dir);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes('chunks/0000.bin')), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => e.includes('people.json and people.bin must both exist')));
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});
