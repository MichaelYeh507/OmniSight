// OmniSight scene format, JavaScript side. Pure ESM with no browser or three.js
// dependency, so the Node scripts and tests import the same code the viewer runs.
// Layout: docs/CONTRACT.md. A chunk is a 24-byte header plus 36 bytes per splat with
// every array 4-byte aligned; people.bin is 16 bytes per point in per-frame blocks.

export const MAGIC = 'OMNI';
export const VERSION = 1;
export const HEADER_SIZE = 24;
export const BYTES_PER_SPLAT = 36;
export const BYTES_PER_GHOST_POINT = 16;

export const chunkSize = (n) => HEADER_SIZE + BYTES_PER_SPLAT * n;

function asArrayBuffer(data, name) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    // Node Buffers can sit inside a shared slab at an unaligned offset: copy them out.
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  throw new TypeError(`${name}: expected an ArrayBuffer or a typed array`);
}

/** Parse one chunk file (chunks/NNNN.bin or alignment.bin) into zero-copy typed-array views. */
export function parseChunk(data, name = 'chunk') {
  const buffer = asArrayBuffer(data, name);
  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error(`${name}: ${buffer.byteLength} bytes, shorter than the ${HEADER_SIZE}-byte header`);
  }
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== MAGIC) throw new Error(`${name}: bad magic "${magic}", expected "${MAGIC}"`);
  const version = dv.getUint32(4, true);
  if (version !== VERSION) throw new Error(`${name}: version ${version}, expected ${VERSION}`);
  const n = dv.getUint32(8, true);
  const tStart = dv.getFloat32(12, true);
  const tEnd = dv.getFloat32(16, true);
  const expected = chunkSize(n);
  if (buffer.byteLength !== expected) {
    throw new Error(`${name}: ${buffer.byteLength} bytes but the header says N=${n}, which needs ${expected}`);
  }
  let o = HEADER_SIZE;
  const positions = new Float32Array(buffer, o, 3 * n);
  o += 12 * n;
  const normals = new Float32Array(buffer, o, 3 * n);
  o += 12 * n;
  const radius = new Float32Array(buffer, o, n);
  o += 4 * n;
  const tSeen = new Float32Array(buffer, o, n);
  o += 4 * n;
  const rgbs = new Uint8Array(buffer, o, 4 * n);
  return { n, version, tStart, tEnd, positions, normals, radius, tSeen, rgbs, byteLength: buffer.byteLength };
}

/**
 * Parse people.json (index) + people.bin. Validates that blocks are contiguous 16n-byte
 * runs sorted by t. Each returned entry keeps the index fields and adds `positions`,
 * `rgba` (views) and `start`, the entry's first point index in the concatenated arrays.
 */
export function parsePeople(index, data, name = 'people.bin') {
  const buffer = asArrayBuffer(data, name);
  if (!Array.isArray(index)) throw new Error('people.json: expected an array');
  const entries = [];
  let offset = 0;
  let start = 0;
  let lastT = -Infinity;
  index.forEach((e, i) => {
    const where = `people.json[${i}]`;
    if (!e || typeof e.t !== 'number' || !Number.isFinite(e.t)) throw new Error(`${where}: missing numeric t`);
    if (!Number.isInteger(e.count) || e.count < 0) throw new Error(`${where}: count must be a non-negative integer`);
    if (!Number.isInteger(e.offset) || e.offset !== offset) {
      throw new Error(`${where}: offset ${e.offset}, expected ${offset} (blocks are contiguous, 16 bytes per point)`);
    }
    if (!Array.isArray(e.centroid) || e.centroid.length !== 3 || !e.centroid.every(Number.isFinite)) {
      throw new Error(`${where}: centroid must be [x, y, z]`);
    }
    if (e.t < lastT) throw new Error(`${where}: t ${e.t} is earlier than the previous entry (${lastT}); sort people.json by t`);
    lastT = e.t;
    const end = offset + BYTES_PER_GHOST_POINT * e.count;
    if (end > buffer.byteLength) throw new Error(`${where}: block ends at byte ${end} but ${name} is ${buffer.byteLength} bytes`);
    const positions = new Float32Array(buffer, offset, 3 * e.count);
    const rgba = new Uint8Array(buffer, offset + 12 * e.count, 4 * e.count);
    entries.push({ ...e, positions, rgba, start });
    offset = end;
    start += e.count;
  });
  if (offset !== buffer.byteLength) throw new Error(`${name}: ${buffer.byteLength} bytes but people.json accounts for ${offset}`);
  return { entries, totalPoints: start };
}

/** Pack all ghost frames into two GPU-ready arrays; entry.start indexes into them. */
export function concatPeople(entries) {
  const total = entries.reduce((s, e) => s + e.count, 0);
  const positions = new Float32Array(3 * total);
  const rgba = new Uint8Array(4 * total);
  for (const e of entries) {
    positions.set(e.positions, 3 * e.start);
    rgba.set(e.rgba, 4 * e.start);
  }
  return { positions, rgba, total };
}
