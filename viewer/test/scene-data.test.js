import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChunk } from '../src/format.js';
import { mergeChunks, drawCountAt, poseIndexAt, computeBounds } from '../src/scene-data.js';
import { makeScene } from '../scripts/make-scene.mjs';

test('mergeChunks concatenates in order and drawCountAt returns a growing prefix', () => {
  const scene = makeScene({ name: 'test_scene', points: 4000, duration: 6, person: '1:2', personPoints: 10, personFps: 2 });
  const metas = scene.manifest.chunks;
  const chunks = scene.chunks.map((c) => parseChunk(c.bytes.buffer, c.file));
  const s = mergeChunks(chunks, metas);

  assert.equal(s.count, chunks.reduce((a, c) => a + c.n, 0));
  assert.equal(s.chunkEnd[s.chunkEnd.length - 1], s.count);
  // the second chunk's first splat sits right after the first chunk in the merged arrays
  assert.equal(s.positions[3 * chunks[0].n], chunks[1].positions[0]);
  assert.equal(s.colors[4 * chunks[0].n], chunks[1].rgbs[0]);
  // every splat's t_seen is inside its chunk window
  let k = 0;
  chunks.forEach((c, i) => {
    for (let j = 0; j < c.n; j++, k++) {
      assert.ok(s.tSeen[k] >= metas[i].t_start - 1e-3 && s.tSeen[k] <= metas[i].t_end + 1e-3);
    }
  });

  assert.equal(drawCountAt(s, -1), 0);
  assert.equal(drawCountAt(s, 0), s.chunkEnd[0]);
  assert.equal(drawCountAt(s, 0.49), s.chunkEnd[0]);
  assert.equal(drawCountAt(s, 0.5), s.chunkEnd[1]);
  assert.equal(drawCountAt(s, 1e9), s.count);
  let prev = 0;
  for (let t = 0; t <= 6; t += 0.1) {
    const n = drawCountAt(s, t);
    assert.ok(n >= prev);
    prev = n;
  }

  const b = computeBounds(s.positions, s.count);
  assert.ok(b.min[2] < -1.8 && b.max[2] <= -1.8 + 1e-3, `z range ${b.min[2]}..${b.max[2]}`);
  assert.ok(b.max[1] - b.min[1] > 2.4 && b.max[1] - b.min[1] < 2.6);
});

test('poseIndexAt finds the latest pose at or before t', () => {
  const tr = [{ t: 0 }, { t: 0.1 }, { t: 0.2 }, { t: 5 }];
  assert.equal(poseIndexAt(tr, -1), -1);
  assert.equal(poseIndexAt(tr, 0), 0);
  assert.equal(poseIndexAt(tr, 0.15), 1);
  assert.equal(poseIndexAt(tr, 0.2), 2);
  assert.equal(poseIndexAt(tr, 4.99), 2);
  assert.equal(poseIndexAt(tr, 99), 3);
  assert.equal(poseIndexAt([], 1), -1);
});
