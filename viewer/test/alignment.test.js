import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Group, Vector3 } from 'three';
import { Alignment, ALIGNMENT_KEY, resolveAlignment } from '../src/alignment.js';

const memoryStorage = (initial = '{}') => {
  const entries = new Map([[ALIGNMENT_KEY, initial]]);
  return { getItem: (key) => entries.get(key), setItem: (key, value) => entries.set(key, value) };
};

test('alignment uses saved finite numbers, then per-axis URL overrides including zero, with bounded steps', () => {
  assert.deepEqual(resolveAlignment({ x: 0.12, y: 0.03, z: -0.2, yaw: 5 }, { x: 0, y: NaN, yaw: 1.5 }),
    { x: 0, y: 0.03, z: -0.2, yaw: 1.5 });
  assert.deepEqual(resolveAlignment({ x: '0.4', y: Infinity, z: -100, yaw: 100 }),
    { x: 0, y: 0, z: -2, yaw: 30 });
  assert.deepEqual(resolveAlignment(null, { x: 0.016, yaw: 0.74 }), { x: 0.02, y: 0, z: 0, yaw: 0.5 });
});

test('nudges transform only the shared scene root, leaving its children in recording coordinates', () => {
  const sceneRoot = new Group();
  const points = new Group();
  points.position.set(0, 0, -2);
  sceneRoot.add(points);
  const alignmentCloud = { visible: true };
  const a = new Alignment({ sceneRoot, alignmentCloud, storage: memoryStorage() });
  assert.equal(alignmentCloud.visible, false);
  for (let i = 0; i < 10; i++) a.nudge('x', 1);
  a.nudge('y', -1);
  a.nudge('z', 1);
  a.nudge('yaw', 1);
  assert.deepEqual(a.values, { x: 0.1, y: -0.01, z: 0.01, yaw: 0.5 });
  assert.deepEqual(sceneRoot.position.toArray(), [0.1, -0.01, 0.01]);
  assert.equal(sceneRoot.rotation.y, 0.5 * Math.PI / 180);
  assert.deepEqual(points.position.toArray(), [0, 0, -2]);
  assert.ok(points.getWorldPosition(new Vector3()).x < 0.1); // positive yaw rotates -Z toward -X
  a.setAligning(true);
  assert.equal(alignmentCloud.visible, true);
  a.setAligning(false);
  assert.equal(alignmentCloud.visible, false);
  assert.equal(points.visible, true); // x-ray hides only the outside-wall cloud
});

test('save/reload and reset work per browser; URL overrides are temporary until saved', () => {
  const storage = memoryStorage(JSON.stringify({ x: 0.1, y: 0.2, z: 0.3, yaw: 1 }));
  const a = new Alignment({ sceneRoot: new Group(), storage, overrides: { x: 0 } });
  assert.equal(a.values.x, 0);
  assert.equal(JSON.parse(storage.getItem(ALIGNMENT_KEY)).x, 0.1);
  a.nudge('yaw', -1);
  assert.equal(a.save(), true);
  const b = new Alignment({ sceneRoot: new Group(), storage });
  assert.deepEqual(b.values, { x: 0, y: 0.2, z: 0.3, yaw: 0.5 });
  assert.equal(b.reset(), true);
  assert.deepEqual(JSON.parse(storage.getItem(ALIGNMENT_KEY)), { x: 0, y: 0, z: 0, yaw: 0 });
});

test('corrupt or unavailable storage cannot prevent alignment or AR', () => {
  for (const storage of [memoryStorage('not JSON'), { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }, undefined]) {
    const a = new Alignment({ sceneRoot: new Group(), storage, overrides: { z: -0.2 } });
    assert.equal(a.values.z, -0.2);
    a.nudge('x', 1);
    assert.equal(a.values.x, 0.01);
    a.setAligning(true); // optional alignment.bin may be absent
    assert.equal(a.aligning, true);
    assert.doesNotThrow(() => a.save());
  }
});
