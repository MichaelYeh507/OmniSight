import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Portal, PORTAL_REACH, PORTAL_RADIUS } from '../src/portal.js';
import { parseWall } from '../src/scene-data.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('portal follows the gaze onto the wall, clamps grazing hits to its reach and holds on a miss', () => {
  const portal = new Portal({ wallZ: -1.8 });
  const sceneRoot = new THREE.Group();
  sceneRoot.add(portal.group);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 50);
  camera.position.set(0.2, 0.1, 0);
  camera.updateMatrixWorld();
  assert.equal(portal.update(camera, sceneRoot).enabled, false); // off until AR x-ray mode enables it
  portal.setEnabled(true);
  const ahead = portal.update(camera, sceneRoot);
  assert.deepEqual({ ...ahead, hit: ahead.hit.map((v) => Number(v.toFixed(9))) }, { enabled: true, hit: [0.2, 0.1, -1.8], miss: false, clamped: false, outside: true, open: 1 });
  assert.ok(near(portal.group.position.z, -1.8) && near(portal.occluder.position.z, 0.02)); // the wall is z = 0 in the portal's frame, the occluder a hair outside
  const hole = portal.occluder.material.uniforms.uHole.value;
  assert.ok(near(hole.x, 0.2) && near(hole.y, 0.1));
  camera.lookAt(0.2, -200, -1.8); // phone tilted almost parallel to the wall: the raw hit is 200 m below
  camera.updateMatrixWorld();
  const grazing = portal.update(camera, sceneRoot);
  assert.equal(grazing.clamped, true);
  assert.ok(near(grazing.hit[1], 0.1 - PORTAL_REACH) && near(grazing.hit[0], 0.2));
  assert.ok(near(hole.y, grazing.hit[1])); // the hole stays over the wall; the occluder itself never moves
  camera.lookAt(0.2, 0.1, 5); // looking away from the wall: keep the last placement
  camera.updateMatrixWorld();
  const miss = portal.update(camera, sceneRoot);
  assert.equal(miss.miss, true);
  assert.deepEqual(miss.hit, grazing.hit);
  sceneRoot.position.x = 1; // alignment nudges move the wall with sceneRoot; the hit is reported in sceneRoot space
  camera.lookAt(0.2, 0.1, -1.8);
  camera.updateMatrixWorld();
  assert.ok(near(portal.update(camera, sceneRoot).hit[0], 0.2 - 1));
});

test('portal on another plane: room012\'s door wall x = -0.69 seen from the corridor, and from inside the room', () => {
  const portal = new Portal({ plane: parseWall('-x:-0.69'), wallZ: -1.8 });
  const sceneRoot = new THREE.Group();
  sceneRoot.add(portal.group);
  portal.setEnabled(true);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 50);
  camera.position.set(-2.6, 0, -1.4); // the corridor viewpoint of the demo render
  camera.lookAt(1.2, -0.5, -1.4);
  camera.updateMatrixWorld();
  const corridor = portal.update(camera, sceneRoot);
  const s = (-0.69 + 2.6) / 3.8; // where the gaze crosses x = -0.69
  assert.ok(near(corridor.hit[0], -0.69) && near(corridor.hit[1], -0.5 * s) && near(corridor.hit[2], -1.4), JSON.stringify(corridor));
  assert.equal(corridor.outside, true);
  assert.equal(corridor.miss, false);
  // the occluder faces the corridor: its world normal is -X and it sits 2 cm outside the wall
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(portal.group.quaternion);
  assert.ok(near(normal.x, -1) && near(normal.y, 0) && near(normal.z, 0));
  const occluderWorld = portal.occluder.getWorldPosition(new THREE.Vector3());
  assert.ok(near(occluderWorld.x, -0.69 - 0.02));
  camera.position.set(1, 0, -1.4); // inside the room looking at the door wall
  camera.lookAt(-3, 0, -1.4);
  camera.updateMatrixWorld();
  const inside = portal.update(camera, sceneRoot);
  assert.equal(inside.outside, false);
  assert.ok(near(inside.hit[0], -0.69) && near(inside.hit[2], -1.4));
});

test('portal iris: open 0 is a solid occluder with no ring, open 1 the full window', () => {
  const portal = new Portal({ wallZ: -1.8 });
  portal.setEnabled(true);
  portal.setOpen(0);
  assert.equal(portal.group.visible, false);
  assert.equal(portal.occluder.material.uniforms.uRadius.value, 0);
  portal.setOpen(0.5);
  assert.equal(portal.group.visible, true);
  assert.ok(near(portal.occluder.material.uniforms.uRadius.value, PORTAL_RADIUS / 2));
  assert.ok(near(portal.ring.scale.x, 0.5) && near(portal.ring.material.opacity, 0.425));
  portal.setOpen(1);
  assert.ok(near(portal.occluder.material.uniforms.uRadius.value, PORTAL_RADIUS) && near(portal.ring.scale.x, 1));
  portal.setEnabled(false);
  assert.equal(portal.group.visible, false);
});

test('parseWall: axis shorthand with the outside sign, a general plane, the contract fallback and bad specs', () => {
  assert.deepEqual(parseWall(null, -1.8), { normal: [0, 0, 1], d: -1.8, spec: 'z:-1.8' });
  assert.deepEqual(parseWall('', -1.8), { normal: [0, 0, 1], d: -1.8, spec: 'z:-1.8' });
  assert.equal(parseWall(null, null), null);
  assert.deepEqual(parseWall('z:-1.8'), { normal: [0, 0, 1], d: -1.8, spec: 'z:-1.8' });
  assert.deepEqual(parseWall('-x:-0.69'), { normal: [-1, 0, 0], d: 0.69, spec: '-x:-0.69' });
  assert.deepEqual(parseWall('+y:2.4'), { normal: [0, 1, 0], d: 2.4, spec: '+y:2.4' });
  const general = parseWall('0,0,2,-3.6');
  assert.deepEqual(general.normal, [0, 0, 1]);
  assert.ok(near(general.d, -1.8));
  assert.equal(parseWall('q:1'), null);
  assert.equal(parseWall('1,2,3'), null);
  assert.equal(parseWall('0,0,0,1'), null);
});
