// Fits axis-aligned boxes to the furniture in a scene's static point cloud, as a starting point for
// <scene>/outlines.json (the "3D sketch" the viewer draws as hot-red wireframes, reference image 2).
// Walls are cells whose points span floor to ceiling; furniture is what is left inside the room band;
// connected furniture cells become one box each. Then a human names the boxes ("bed", "desk"...) and
// nudges sizes by eye: this is a helper, not a detector, and the viewer's legend says the outlines are
// hand-annotated.
//   node scripts/fit-outlines.mjs public/scenes/room012_video [--cell 0.05] [--band 0.12:1.4] [--min-area 0.12]
//        [--out <scene>/outlines.json] [--png <topdown.png>] [--keep <scene>/outlines.json]
//   --keep  reuse labels/sizes from an existing outlines.json for boxes whose centres are within 0.4 m
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { parseChunk } from '../src/format.js';

const args = process.argv.slice(2);
const scene = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!scene) throw new Error('usage: node scripts/fit-outlines.mjs <scene folder> [--cell m] [--band lo:hi] [--min-area m2] [--out file] [--png file]');
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const dir = resolve(scene);
const cell = Number(flag('cell', '0.05'));
const [bandLo, bandHi] = flag('band', '0.12:1.4').split(':').map(Number);
const minArea = Number(flag('min-area', '0.12'));
const out = flag('out', join(dir, 'outlines.json'));
const png = flag('png', null);
const keep = flag('keep', existsSync(join(dir, 'outlines.json')) ? join(dir, 'outlines.json') : null);

const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const chunks = manifest.chunks.map((c) => parseChunk(readFileSync(join(dir, c.file)), c.file));
const n = chunks.reduce((s, c) => s + c.n, 0);
const P = new Float32Array(3 * n);
const T = new Float32Array(n);
let o = 0;
for (const c of chunks) { P.set(c.positions, 3 * o); T.set(c.tSeen, o); o += c.n; }
let floor = Number.isFinite(manifest.floor_y) ? manifest.floor_y : null;
if (floor === null) { // 2nd percentile of y
  const ys = Array.from({ length: n }, (_, i) => P[3 * i + 1]).sort((a, b) => a - b);
  floor = ys[Math.floor(0.02 * n)];
}
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (let i = 0; i < n; i++) {
  const x = P[3 * i], z = P[3 * i + 2];
  if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
}
// the ceiling height above the floor, from the 98th percentile of y: rooms differ (2.4 m dorm, lower corridors)
const ceiling = (() => { const ys = new Float32Array(n); for (let i = 0; i < n; i++) ys[i] = P[3 * i + 1] - floor; ys.sort(); return ys[Math.floor(0.98 * n)]; })();
const ceilingCut = Math.max(1.9, ceiling - 0.3); // points above this are ceiling fixtures, not objects
const nx = Math.ceil((maxX - minX) / cell) + 1;
const nz = Math.ceil((maxZ - minZ) / cell) + 1;
const idx = (x, z) => Math.floor((z - minZ) / cell) * nx + Math.floor((x - minX) / cell);
const yMin = new Float32Array(nx * nz).fill(Infinity);
const yMax = new Float32Array(nx * nz).fill(-Infinity);
const band = new Uint16Array(nx * nz); // points inside the furniture band per cell
const bandMaxY = new Float32Array(nx * nz).fill(-Infinity);
const firstT = new Float32Array(nx * nz).fill(Infinity);
for (let i = 0; i < n; i++) {
  const y = P[3 * i + 1] - floor;
  if (y < 0.08 || y > ceilingCut) continue; // floor and ceiling do not describe objects
  const k = idx(P[3 * i], P[3 * i + 2]);
  if (y < yMin[k]) yMin[k] = y;
  if (y > yMax[k]) yMax[k] = y;
  if (y >= bandLo && y <= bandHi) {
    band[k] += 1;
    if (y > bandMaxY[k]) bandMaxY[k] = y;
    if (T[i] < firstT[k]) firstT[k] = T[i];
  }
}
const wall = new Uint8Array(nx * nz);
const furniture = new Uint8Array(nx * nz);
for (let k = 0; k < nx * nz; k++) {
  if (yMax[k] - yMin[k] > 1.5 || yMax[k] > ceilingCut - 0.35) wall[k] = 1; // floor-to-ceiling: a wall, door or wardrobe
  else if (band[k] >= 3) furniture[k] = 1;
}
// drop lonely cells (noise) : fewer than 3 furniture neighbours
const cleaned = new Uint8Array(nx * nz);
for (let z = 1; z < nz - 1; z++) for (let x = 1; x < nx - 1; x++) {
  const k = z * nx + x;
  if (!furniture[k]) continue;
  let nb = 0;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if ((dx || dz) && furniture[k + dz * nx + dx]) nb++;
  if (nb >= 3) cleaned[k] = 1;
}
// connected components, 8-connected
const comp = new Int32Array(nx * nz).fill(-1);
const comps = [];
for (let k = 0; k < nx * nz; k++) {
  if (!cleaned[k] || comp[k] >= 0) continue;
  const id = comps.length;
  const cells = [];
  const stack = [k];
  comp[k] = id;
  while (stack.length) {
    const c = stack.pop();
    cells.push(c);
    const cx = c % nx, cz = (c - cx) / nx;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= nx || z >= nz) continue;
      const m = z * nx + x;
      if (cleaned[m] && comp[m] < 0) { comp[m] = id; stack.push(m); }
    }
  }
  comps.push(cells);
}
const boxes = [];
for (const cells of comps) {
  const area = cells.length * cell * cell;
  if (area < minArea) continue;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
  const ts = [];
  for (const c of cells) {
    const cx = c % nx, cz = (c - cx) / nx;
    x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); z0 = Math.min(z0, cz); z1 = Math.max(z1, cz);
    top = Math.max(top, bandMaxY[c]);
    ts.push(firstT[c]);
  }
  ts.sort((a, b) => a - b);
  const sx = (x1 - x0 + 1) * cell, sz = (z1 - z0 + 1) * cell;
  if (Math.min(sx, sz) < 0.22) continue; // thin strips are wall trim, not objects
  boxes.push({
    label: 'object', center: [minX + (x0 + x1 + 1) / 2 * cell, floor + top / 2 + 0.01, minZ + (z0 + z1 + 1) / 2 * cell],
    size: [sx, top, sz], yaw: 0, t: Number(ts[Math.floor(ts.length * 0.1)].toFixed(2)), area: Number(area.toFixed(2)), cells: cells.length,
  });
}
boxes.sort((a, b) => b.area - a.area);
if (keep) { // carry hand-made labels and sizes over from the previous file
  const prev = JSON.parse(readFileSync(keep, 'utf8'));
  for (const b of boxes) {
    const near = prev.find((p) => Math.hypot(p.center[0] - b.center[0], p.center[2] - b.center[2]) < 0.4 && p.label !== 'object');
    if (near) { b.label = near.label; if (near.keepSize) { b.size = near.size; b.center = near.center; b.keepSize = true; } }
  }
}
boxes.forEach((b, i) => { if (b.label === 'object') b.label = `object ${i + 1}`; });
writeFileSync(out, JSON.stringify(boxes, null, 1));
console.log(`${manifest.scene}: ${n.toLocaleString()} points, floor ${floor.toFixed(2)}, ceiling +${ceiling.toFixed(2)} m, grid ${nx}x${nz} @ ${cell} m, ${comps.length} components, ${boxes.length} boxes -> ${out}`);
console.log('idx  label          centre (x, y, z)            size (w, h, d)        first t   area');
boxes.forEach((b, i) => console.log(`${String(i).padStart(3)}  ${b.label.padEnd(14)} ${b.center.map((v) => v.toFixed(2).padStart(6)).join(', ')}   ${b.size.map((v) => v.toFixed(2).padStart(5)).join(' x ')}   ${String(b.t).padStart(6)} s   ${b.area}`));
if (png) { // top-down picture: grey walls, coloured components, red boxes, 1 m grid; index i is drawn as i+1 ticks on the box's top edge
  const scale = Math.max(1, Math.floor(900 / Math.max(nx, nz)));
  const W = nx * scale, H = nz * scale;
  const img = Buffer.alloc(W * H * 3, 8);
  const px = (x, z, r, g, b) => { if (x < 0 || z < 0 || x >= W || z >= H) return; const p = 3 * ((H - 1 - z) * W + x); img[p] = r; img[p + 1] = g; img[p + 2] = b; };
  const fill = (cx, cz, r, g, b) => { for (let dz = 0; dz < scale; dz++) for (let dx = 0; dx < scale; dx++) px(cx * scale + dx, cz * scale + dz, r, g, b); };
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const k = z * nx + x;
    if (wall[k]) fill(x, z, 120, 130, 140);
    else if (cleaned[k]) { const h = (comp[k] * 0.618) % 1; const [r, g, b] = hsl(h); fill(x, z, r, g, b); }
    else if (band[k]) fill(x, z, 30, 50, 60);
  }
  for (let gx = Math.ceil(minX); gx <= maxX; gx++) { const x = Math.round((gx - minX) / cell * scale); for (let z = 0; z < H; z++) px(x, z, 60, 60, 60); }
  for (let gz = Math.ceil(minZ); gz <= maxZ; gz++) { const z = Math.round((gz - minZ) / cell * scale); for (let x = 0; x < W; x++) px(x, z, 60, 60, 60); }
  const ox = Math.round((0 - minX) / cell * scale), oz = Math.round((0 - minZ) / cell * scale); // the jig
  for (let d = -6; d <= 6; d++) { px(ox + d, oz, 255, 255, 255); px(ox, oz + d, 255, 255, 255); }
  boxes.forEach((b, i) => {
    const x0 = Math.round((b.center[0] - b.size[0] / 2 - minX) / cell * scale), x1 = Math.round((b.center[0] + b.size[0] / 2 - minX) / cell * scale);
    const z0 = Math.round((b.center[2] - b.size[2] / 2 - minZ) / cell * scale), z1 = Math.round((b.center[2] + b.size[2] / 2 - minZ) / cell * scale);
    for (let x = x0; x <= x1; x++) { px(x, z0, 255, 40, 80); px(x, z1, 255, 40, 80); }
    for (let z = z0; z <= z1; z++) { px(x0, z, 255, 40, 80); px(x1, z, 255, 40, 80); }
    for (let k = 0; k <= i; k++) for (let d = 0; d < 4; d++) px(x0 + 3 + 4 * k, z1 - 2 - d, 255, 255, 255); // index ticks
  });
  const ppm = Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), img]);
  const tmp = png.replace(/\.png$/i, '.ppm');
  writeFileSync(tmp, ppm);
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, png], { windowsHide: true });
  console.log(r.status === 0 ? `top-down picture: ${png} (${W}x${H}, ${scale} px per ${cell} m cell, +z is down, +x right, white cross = jig)` : `ffmpeg failed; PPM left at ${tmp}`);
}
function hsl(h) { // saturated colour wheel -> rgb bytes
  const f = (k) => { const t = (h * 6 + k) % 6; return Math.round(255 * (0.35 + 0.65 * Math.max(0, Math.min(1, Math.min(t, 4 - t))))); };
  return [f(3), f(1), f(5)];
}
