import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOccupancy } from '../src/minimap.js';
import { Outlines, firstSeenInBox, OUTLINE_REVEAL } from '../src/outlines.js';
import { computeBounds } from '../src/scene-data.js';

// a 2 x 2 m patch of wall at x = 1 (first seen at 3 s) and a box of "furniture" points seen at 10 s
function fixture() {
  const pts = [];
  const ts = [];
  for (let i = 0; i < 400; i++) { pts.push(1, -1 + (i % 20) * 0.1, -2 + Math.floor(i / 20) * 0.1); ts.push(3); }
  for (let i = 0; i < 200; i++) { pts.push(-0.5 + (i % 10) * 0.05, -0.9 + Math.floor(i / 10) * 0.03, -1.5 + (i % 7) * 0.05); ts.push(10 + (i % 3)); }
  const positions = new Float32Array(pts);
  const tSeen = new Float32Array(ts);
  const count = tSeen.length;
  return { positions, tSeen, count, bounds: computeBounds(positions, count) };
}

test('buildOccupancy keeps wall and furniture cells with their earliest time and skips the floor band', () => {
  const data = fixture();
  const grid = buildOccupancy(data, -1.2, { maxCells: 60, pad: 0.2 });
  assert.ok(grid.nx > 0 && grid.nz > 0 && grid.cell >= 0.06);
  const seen = [...grid.first].filter((v) => Number.isFinite(v));
  assert.ok(seen.length > 0, 'some cells are occupied');
  assert.equal(Math.min(...seen), 3); // the wall was seen first
  const cellsAt10 = [...grid.first].filter((v) => v >= 10 && v <= 12).length;
  assert.ok(cellsAt10 > 0, 'the furniture patch has its own first-seen times');
  // points below floor + 0.25 (y < -0.95) never count: the wall patch's lowest row sits at y = -1
  const k = Math.floor((-2 - grid.minZ) / grid.cell) * grid.nx + Math.floor((1 - grid.minX) / grid.cell);
  assert.ok(grid.hits[k] < 20, `the wall column at the far corner only counts rows above the floor band: ${grid.hits[k]}`);
});

test('firstSeenInBox takes the 10th percentile of the points inside the box, infinity when empty', () => {
  const data = fixture();
  assert.equal(firstSeenInBox(data, { center: [-0.25, -0.6, -1.35], size: [0.6, 0.8, 0.5], yaw: 0 }), 10);
  assert.equal(firstSeenInBox(data, { center: [5, 5, 5], size: [0.5, 0.5, 0.5], yaw: 0 }), Infinity);
  assert.equal(firstSeenInBox(data, { center: [1, 0, -1], size: [0.2, 2.2, 2.2], yaw: 0 }), 3); // the wall patch
});

test('Outlines draw themselves in at their first-seen time, follow the x-ray reveal and carry age', () => {
  const data = fixture();
  const outlines = new Outlines([
    { label: 'crate', center: [-0.25, -0.6, -1.35], size: [0.6, 0.8, 0.5], yaw: 0 },
    { label: 'pinned', center: [0, 0, 0], size: [1, 1, 1], yaw: 0, t: 20 },
  ], { staticData: data, labels: false });
  assert.deepEqual(outlines.items.map((it) => it.t), [10, 20]);
  assert.deepEqual(outlines.update(5, 1).map((s) => s.visible), [false, false]);
  const mid = outlines.update(10 + OUTLINE_REVEAL / 2, 1);
  assert.ok(mid[0].visible && mid[0].alpha > 0 && mid[0].alpha < 1 && !mid[1].visible, JSON.stringify(mid));
  assert.ok(outlines.items[0].core.scale.x < 0.6 && outlines.items[0].core.scale.x > 0.42); // growing from 70 % to full size
  const full = outlines.update(12, 1);
  assert.ok(Math.abs(full[0].alpha - 1) < 1e-6 && Math.abs(outlines.items[0].core.scale.x - 0.6) < 1e-6);
  const stale = outlines.update(50, 1);
  assert.ok(Math.abs(stale[0].alpha - 0.55) < 1e-6 && stale[1].visible, JSON.stringify(stale)); // 40 s old: settled at 55 %
  assert.deepEqual(outlines.update(50, 0).map((s) => s.visible), [false, false]); // camera view hides the sketch
  outlines.setLook('blueprint');
  assert.equal(outlines.items[0].glow.visible, false);
  outlines.dispose();
});
