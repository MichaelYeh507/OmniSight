import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Portal, PORTAL_REACH } from '../src/portal.js';

test('portal follows the gaze onto the wall, clamps grazing hits to its reach and holds on a miss', () => {
  const portal = new Portal({ wallZ: -1.8 });
  const sceneRoot = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 50);
  camera.position.set(0.2, 0.1, 0);
  camera.updateMatrixWorld();
  assert.equal(portal.update(camera, sceneRoot).enabled, false); // off until AR x-ray mode enables it
  portal.setEnabled(true);
  const ahead = portal.update(camera, sceneRoot);
  assert.deepEqual(ahead, { enabled: true, hit: [0.2, 0.1, -1.8], miss: false, clamped: false });
  assert.ok(Math.abs(portal.occluder.position.z - (-1.78)) < 1e-9);
  camera.lookAt(0.2, -200, -1.8); // phone tilted almost parallel to the wall: the raw hit is 200 m below
  camera.updateMatrixWorld();
  const grazing = portal.update(camera, sceneRoot);
  assert.equal(grazing.clamped, true);
  assert.ok(Math.abs(grazing.hit[1] - (0.1 - PORTAL_REACH)) < 1e-6 && Math.abs(grazing.hit[0] - 0.2) < 1e-6);
  assert.ok(Math.abs(portal.occluder.position.y - grazing.hit[1]) < 1e-6); // occluder stays over the wall
  camera.lookAt(0.2, 0.1, 5); // looking away from the wall: keep the last placement
  camera.updateMatrixWorld();
  const miss = portal.update(camera, sceneRoot);
  assert.equal(miss.miss, true);
  assert.deepEqual(miss.hit, grazing.hit);
  sceneRoot.position.x = 1; // alignment nudges move the wall with sceneRoot; the hit is reported in sceneRoot space
  camera.lookAt(0.2, 0.1, -1.8);
  camera.updateMatrixWorld();
  assert.ok(Math.abs(portal.update(camera, sceneRoot).hit[0] - (0.2 - 1)) < 1e-9);
});
