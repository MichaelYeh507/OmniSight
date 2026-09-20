import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Responder, Responders, RESPONDER_COLORS } from '../src/responder.js';

const q0 = [0, 0, 0, 1];
// two walkthroughs merged into one list sorted by t, as A's multi-source export writes it
const merged = [
  { t: 0, source: 0, position: [0, 0, 0], quaternion: q0 },
  { t: 1, source: 1, position: [0, 0, 0], quaternion: q0 },
  { t: 2, source: 0, position: [2, 0, -2], quaternion: q0 },
  { t: 3, source: 1, position: [-2, 0, -2], quaternion: q0 },
  { t: 4, source: 0, position: [2, 0, -4], quaternion: q0 },
  { t: 5, source: 1, position: [-2, 0, -4], quaternion: q0 },
];
const sources = [{ id: 0, label: 'Responder 1', device: 'x' }, { id: 1, label: 'Responder 2', device: 'x' }];

test('Responders draws one frustum and trail per source, each following only its own poses', () => {
  const rs = new Responders(merged, sources);
  assert.equal(rs.items.length, 2);
  assert.deepEqual(rs.group.children.map((g) => g.name), ['responder', 'responder-1']);
  assert.deepEqual(rs.legend, [{ source: 0, label: 'Responder 1', color: RESPONDER_COLORS[0].frustum }, { source: 1, label: 'Responder 2', color: RESPONDER_COLORS[1].frustum }]);
  const at3 = rs.update(3);
  assert.deepEqual(at3.map((s) => s.source), [0, 1]);
  assert.deepEqual(at3[0].position, [2, 0, -3]); // source 0 halfway between its 2 s and 4 s poses, unaffected by source 1's pose at 3 s
  assert.deepEqual(at3[1].position, [-2, 0, -2]);
  assert.deepEqual(at3.map((s) => s.trailPoints), [2, 2]);
  assert.equal(rs.items[0].trail.geometry.drawRange.count, 2);
  assert.notEqual(rs.items[0].frustum.material.color.getHex(), rs.items[1].frustum.material.color.getHex());
  assert.deepEqual(rs.update(-1).map((s) => s.position), [[0, 0, 0], [0, 0, 0]]); // both hold at the jig before their first pose
  assert.deepEqual(rs.update(99).map((s) => s.trailPoints), [3, 3]);
});

test('a single-source trajectory keeps the old shape: one group named responder, no legend', () => {
  const rs = new Responders(merged.filter((p) => p.source === 0), sources);
  assert.equal(rs.items.length, 1);
  assert.equal(rs.group.children[0].name, 'responder');
  assert.deepEqual(rs.legend, []);
  assert.equal(rs.items[0].labelText, null);
  const state = rs.update(1);
  assert.deepEqual(state, [{ source: 0, index: 0, position: [1, 0, -1], trailPoints: 1 }]);
  // entries without a source field count as source 0
  const legacy = new Responders([{ t: 0, position: [0, 0, 0], quaternion: q0 }], []);
  assert.equal(legacy.items[0].source, 0);
  assert.equal(new Responder([]).update(5), null);
  assert.equal(new Responders([], []).update(5).length, 0);
});

test('trail wall clip: a plane keeps the path inside the room, null removes it', async () => {
  const { Responders } = await import('../src/responder.js');
  const { parseWall } = await import('../src/scene-data.js');
  const THREE = await import('three');
  const rs = new Responders([{ t: 0, source: 0, position: [0, 0, 0], quaternion: [0, 0, 0, 1] }, { t: 1, source: 0, position: [2, 0, 0], quaternion: [0, 0, 0, 1] }]);
  rs.setWallClip(parseWall('-x:0.46'), 0.1);
  const [plane] = rs.items[0].trail.material.clippingPlanes;
  assert.deepEqual(plane.normal.toArray().map((v) => v + 0), [1, 0, 0]); // + 0 folds the -0 of negating a zero component
  assert.ok(Math.abs(plane.constant - (-0.46 - 0.1)) < 1e-9); // dot(n, p) + c >= 0 keeps x >= 0.56: inside the room
  assert.ok(plane.distanceToPoint(new THREE.Vector3(2, 0, 0)) > 0 && plane.distanceToPoint(new THREE.Vector3(-0.6, 0, 0)) < 0);
  rs.setWallClip(null);
  assert.equal(rs.items[0].trail.material.clippingPlanes, null);
});
