// Independent check of B's zero-copy layout, kept in A's tests (no viewer edits).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const bytes = readFileSync(process.argv[2]);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const header = new DataView(buffer);
assert.equal(new TextDecoder().decode(new Uint8Array(buffer, 0, 4)), 'OMNI');
assert.equal(header.getUint32(4, true), 1);
const n = header.getUint32(8, true);
assert.equal(buffer.byteLength, 24 + 36 * n);
const positions = new Float32Array(buffer, 24, 3 * n);
const normals = new Float32Array(buffer, 24 + 12 * n, 3 * n);
const radius = new Float32Array(buffer, 24 + 24 * n, n);
const times = new Float32Array(buffer, 24 + 28 * n, n);
const colors = new Uint8Array(buffer, 24 + 32 * n, 4 * n);
assert.equal(n, 1);
assert.equal(positions[0], 1);
assert.equal(positions[2], -2);
assert.equal(normals[2], 1);
assert(radius[0] > 0);
assert.equal(times[0], .5);
assert.deepEqual([...colors], [255, 0, 0, 0]);
console.log('OMNI v1 typed-array layout verified');
