#!/usr/bin/env node
// Generate a box-room scene in the OmniSight scene format (docs/CONTRACT.md).
// Uses: test fixtures, the gitignored 800k-point `stress` scene for the point budget,
// the small committed `box` scene, and a stand-in until tools/make_fake_scene.py lands.
//
//   node scripts/make-scene.mjs --out public/scenes/box --points 20000 --duration 20 --person 5:12
//
// Options: --points N (static point cap, default 200000)   --duration S (reveal time, default 20)
//          --person a:b (seconds the person is visible, default 5:12)   --person-points N (2000)
//          --person-fps N (10)   --wall-z Z (-1.8)   --floor-y Y (-1.3)   --seed N   --name <scene>
//          --sources N (1): extra responders, each a later walkthrough from the same jig with its own source_id
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeChunk, encodePeople, writeScene } from './omni-format.mjs';

export const DEFAULTS = {
  points: 200000,
  duration: 20,
  person: '5:12',
  personPoints: 2000,
  personFps: 10,
  wallZ: -1.8,
  floorY: -1.3,
  seed: 1,
  name: 'box',
};

const ROOM_W = 4;
const ROOM_D = 3;
const ROOM_H = 2.5;
const CHUNK_S = 0.5;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d) => Number(v.toFixed(d));

// Sample points on rectangles. Each surface maps (u, v) in [0, 1]^2 to a point and has
// physical extents du, dv in meters. A faint 0.5 m grid makes alignment errors visible.
function sampleSurfaces(surfaces, spacing, rand, filter) {
  const pos = [];
  const nrm = [];
  const rgb = [];
  for (const s of surfaces) {
    const nu = Math.max(1, Math.round(s.du / spacing));
    const nv = Math.max(1, Math.round(s.dv / spacing));
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const u = (i + 0.5 + (rand() - 0.5) * 0.6) / nu;
        const v = (j + 0.5 + (rand() - 0.5) * 0.6) / nv;
        const p = s.at(u, v);
        if (filter && !filter(s, p)) continue;
        const onGrid = (u * s.du) % 0.5 < spacing || (v * s.dv) % 0.5 < spacing;
        const k = onGrid ? 0.7 : 1 - rand() * 0.08;
        pos.push(p[0], p[1], p[2]);
        nrm.push(s.normal[0], s.normal[1], s.normal[2]);
        rgb.push(s.color[0] * k, s.color[1] * k, s.color[2] * k);
      }
    }
  }
  return { pos, nrm, rgb, n: pos.length / 3 };
}

// Random point on the surface of a standing capsule (height 1.7 m, radius 0.25 m).
function capsulePoint(rand, cx, cz, floorY) {
  const r = 0.25;
  const y0 = floorY + r;
  const y1 = floorY + 1.7 - r;
  const cylArea = 2 * Math.PI * r * (y1 - y0);
  const capArea = 4 * Math.PI * r * r;
  const phi = rand() * 2 * Math.PI;
  if (rand() < cylArea / (cylArea + capArea)) {
    const y = y0 + rand() * (y1 - y0);
    return [cx + r * Math.cos(phi), y, cz + r * Math.sin(phi), y > y1 - 0.15];
  }
  const cosT = 2 * rand() - 1;
  const sinT = Math.sqrt(1 - cosT * cosT);
  const top = rand() < 0.5;
  const cy = top ? y1 : y0;
  const dy = Math.abs(cosT) * (top ? 1 : -1);
  return [cx + r * sinT * Math.cos(phi), cy + r * dy, cz + r * sinT * Math.sin(phi), top];
}

export function makeScene(opts = {}) {
  const t0 = performance.now();
  const o = { ...DEFAULTS, ...opts };
  const rand = mulberry32(o.seed);
  const { wallZ, floorY, duration } = o;
  const sources = Math.max(1, Math.floor(o.sources || 1));
  const zBack = wallZ - ROOM_D;
  const yTop = floorY + ROOM_H;

  // --- static room: floor, ceiling, back, left, right (with a door), inside of the front wall
  const surfaces = [
    { du: ROOM_W, dv: ROOM_D, at: (u, v) => [-2 + u * ROOM_W, floorY, zBack + v * ROOM_D], normal: [0, 1, 0], color: [125, 115, 100] },
    { du: ROOM_W, dv: ROOM_D, at: (u, v) => [-2 + u * ROOM_W, yTop, zBack + v * ROOM_D], normal: [0, -1, 0], color: [205, 205, 200] },
    { du: ROOM_W, dv: ROOM_H, at: (u, v) => [-2 + u * ROOM_W, floorY + v * ROOM_H, zBack], normal: [0, 0, 1], color: [175, 155, 125] },
    { du: ROOM_D, dv: ROOM_H, at: (u, v) => [-2, floorY + v * ROOM_H, zBack + u * ROOM_D], normal: [1, 0, 0], color: [140, 165, 175] },
    { du: ROOM_D, dv: ROOM_H, at: (u, v) => [2, floorY + v * ROOM_H, zBack + u * ROOM_D], normal: [-1, 0, 0], color: [165, 140, 165], door: true },
    { du: ROOM_W, dv: ROOM_H, at: (u, v) => [-2 + u * ROOM_W, floorY + v * ROOM_H, wallZ - 0.01], normal: [0, 0, -1], color: [150, 150, 140] },
  ];
  const area = surfaces.reduce((s, f) => s + f.du * f.dv, 0);
  const spacing = Math.sqrt(area / o.points);
  const radius = round(spacing * 0.7, 5);
  // door opening in the right wall (x = 2): 0.9 m wide, 2.1 m tall, near the front
  const notDoor = (s, p) => !(s.door && p[2] > wallZ - 1.2 && p[2] < wallZ - 0.3 && p[1] < floorY + 2.1);
  const st = sampleSurfaces(surfaces, spacing, rand, notDoor);
  const n = st.n;

  // reveal sweep from the door side (front right) to the far side (back left)
  const tSeen = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = st.pos[3 * i];
    const z = st.pos[3 * i + 2];
    const progress = (0.5 * (2 - x)) / ROOM_W + (0.5 * (wallZ - z)) / ROOM_D;
    tSeen[i] = clamp(duration * (progress + (rand() - 0.5) * 0.06), 0, duration - 1e-3);
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => tSeen[a] - tSeen[b]);

  // bucket into 0.5 s chunks; empty windows are skipped
  const chunks = [];
  const manifestChunks = [];
  let i0 = 0;
  let k = 0;
  while (i0 < n) {
    const tStart = k * CHUNK_S;
    const tEnd = (k + 1) * CHUNK_S;
    let i1 = i0;
    while (i1 < n && tSeen[order[i1]] < tEnd) i1++;
    if (i1 > i0) {
      const m = i1 - i0;
      const P = new Float32Array(3 * m);
      const N = new Float32Array(3 * m);
      const R = new Float32Array(m).fill(radius);
      const T = new Float32Array(m);
      const C = new Uint8Array(4 * m);
      for (let j = 0; j < m; j++) {
        const idx = order[i0 + j];
        P[3 * j] = st.pos[3 * idx];
        P[3 * j + 1] = st.pos[3 * idx + 1];
        P[3 * j + 2] = st.pos[3 * idx + 2];
        N[3 * j] = st.nrm[3 * idx];
        N[3 * j + 1] = st.nrm[3 * idx + 1];
        N[3 * j + 2] = st.nrm[3 * idx + 2];
        T[j] = tSeen[idx];
        C[4 * j] = st.rgb[3 * idx];
        C[4 * j + 1] = st.rgb[3 * idx + 1];
        C[4 * j + 2] = st.rgb[3 * idx + 2];
        C[4 * j + 3] = sources > 1 && P[3 * j] > 0.5 && P[3 * j + 2] < wallZ - 1 ? 1 : 0; // source_id: the back-right corner is what responder 2 sees
      }
      const file = `chunks/${String(chunks.length).padStart(4, '0')}.bin`;
      chunks.push({ file, bytes: encodeChunk({ tStart, tEnd, positions: P, normals: N, radius: R, tSeen: T, rgbs: C }) });
      manifestChunks.push({ file, t_start: tStart, t_end: tEnd, count: m });
    }
    i0 = i1;
    k++;
  }

  // --- alignment.bin: the OUTSIDE face of the front wall with a door frame and a chair rail
  const alignSpacing = Math.max(spacing, 0.03);
  const outside = [
    { du: ROOM_W, dv: ROOM_H, at: (u, v) => [-2 + u * ROOM_W, floorY + v * ROOM_H, wallZ + 0.01], normal: [0, 0, 1], color: [185, 180, 170] },
  ];
  const al = sampleSurfaces(outside, alignSpacing, rand, null);
  const an = al.n;
  const aC = new Uint8Array(4 * an);
  for (let i = 0; i < an; i++) {
    const x = al.pos[3 * i];
    const y = al.pos[3 * i + 1];
    let c = [al.rgb[3 * i], al.rgb[3 * i + 1], al.rgb[3 * i + 2]];
    const inFrame = x > 0.57 && x < 1.53 && y < floorY + 2.13 && !(x > 0.63 && x < 1.47 && y < floorY + 2.07);
    const onRail = Math.abs(y - (floorY + 1.0)) < 0.02 && !(x > 0.57 && x < 1.53);
    if (inFrame) c = [95, 60, 40];
    else if (onRail) c = [110, 90, 70];
    aC[4 * i] = c[0];
    aC[4 * i + 1] = c[1];
    aC[4 * i + 2] = c[2];
    aC[4 * i + 3] = 0;
  }
  const alignment = encodeChunk({
    tStart: 0,
    tEnd: 0,
    positions: Float32Array.from(al.pos),
    normals: Float32Array.from(al.nrm),
    radius: new Float32Array(an).fill(round(alignSpacing * 0.7, 5)),
    tSeen: new Float32Array(an),
    rgbs: aC,
  });

  // --- person: a capsule walking across the room, visible only during [a, b]
  const [pa, pb] = String(o.person).split(':').map(Number);
  const frames = [];
  if (Number.isFinite(pa) && Number.isFinite(pb) && pb > pa && o.personPoints > 0 && o.personFps > 0) {
    const dt = 1 / o.personFps;
    for (let f = 0; ; f++) {
      const t = pa + f * dt;
      if (t > pb + 1e-9) break;
      const s = (t - pa) / (pb - pa);
      const cx = 1.5 - 3.0 * s;
      const cz = wallZ - 0.8 - 1.4 * s;
      const P = new Float32Array(3 * o.personPoints);
      const C = new Uint8Array(4 * o.personPoints);
      for (let i = 0; i < o.personPoints; i++) {
        const [x, y, z, head] = capsulePoint(rand, cx, cz, floorY);
        P[3 * i] = x;
        P[3 * i + 1] = y;
        P[3 * i + 2] = z;
        const col = head ? [222, 184, 150] : [235, 120, 55];
        const j = 1 - rand() * 0.1;
        C[4 * i] = col[0] * j;
        C[4 * i + 1] = col[1] * j;
        C[4 * i + 2] = col[2] * j;
        C[4 * i + 3] = 255;
      }
      frames.push({ t: round(t, 3), frame: Math.round(t * 30), positions: P, rgba: C });
    }
  }
  const people = frames.length ? encodePeople(frames) : null;

  // --- trajectory: hold at the jig, walk right along the outside of the wall, in through
  // the door, then across the room. 10 poses per second, first pose the identity.
  const hold = Math.min(2, duration / 4);
  const leg = (duration - hold) / 4;
  const way = [
    [0, 0, 0],
    [hold, 0, 0],
    [hold + leg, 2.6, wallZ + 0.3],
    [hold + 2 * leg, 2.6, wallZ - 0.75],
    [hold + 3 * leg, 1.4, wallZ - 0.75],
    [duration, -1.2, wallZ - 2.3],
  ];
  const trajectory = [];
  const walk = (way, source) => {
    for (let i = Math.ceil(way[0][0] * 10 - 1e-9); i / 10 <= duration + 1e-9; i++) {
    const t = i / 10;
    let seg = 0;
    while (seg < way.length - 2 && t > way[seg + 1][0]) seg++;
    const [ta, xa, za] = way[seg];
    const [tb, xb, zb] = way[seg + 1];
    const s = tb > ta ? clamp((t - ta) / (tb - ta), 0, 1) : 0;
    const x = xa + (xb - xa) * s;
    const z = za + (zb - za) * s;
    let q = [0, 0, 0, 1];
    const dx = xb - xa;
    const dz = zb - za;
    if (seg > 0 && (dx !== 0 || dz !== 0)) {
      // three.js camera looks along its own -Z: yaw so that -Z points along (dx, dz)
      const yaw = Math.atan2(-dx, -dz);
      q = [0, round(Math.sin(yaw / 2), 6), 0, round(Math.cos(yaw / 2), 6)];
    }
    trajectory.push({ t: round(t, 3), source, position: [round(x, 4), 0, round(z, 4)], quaternion: q });
    }
  };
  walk(way, 0);
  for (let k = 1; k < sources; k++) {
    // a later walkthrough from the same jig: same door, then deeper along the right side of the room
    const d = Math.min(1.5 * k, duration / 4);
    const leg2 = (duration - d - hold) / 4;
    walk([
      [d, 0, 0],
      [d + hold, 0, 0],
      [d + hold + leg2, 2.6, wallZ + 0.3],
      [d + hold + 2 * leg2, 2.6, wallZ - 0.75],
      [d + hold + 3 * leg2, 1.4, wallZ - 1.6],
      [duration, 0.6, wallZ - 3.2],
    ], k);
  }
  trajectory.sort((a, b) => a.t - b.t || a.source - b.source); // the contract wants one list sorted by t

  const lastChunkEnd = manifestChunks.length ? manifestChunks[manifestChunks.length - 1].t_end : 0;
  const manifest = {
    version: 1,
    scene: o.name,
    duration: round(Math.max(lastChunkEnd, trajectory[trajectory.length - 1].t, duration), 3),
    chunks: manifestChunks,
    alignment_chunk: 'alignment.bin',
    wall_z: wallZ,
    floor_y: floorY,
    sources: Array.from({ length: sources }, (_, id) => ({ id, label: id ? `Fake responder ${id + 1}` : 'Fake responder', device: 'viewer/scripts/make-scene.mjs' })),
    processing_seconds: round((performance.now() - t0) / 1000, 3),
  };
  const stats = { staticPoints: n, alignmentPoints: an, ghostFrames: frames.length, spacing: round(spacing, 4) };
  return { manifest, chunks, alignment, trajectory, people, stats };
}

function parseArgs(argv) {
  const map = {
    '--out': 'out',
    '--points': 'points',
    '--duration': 'duration',
    '--person': 'person',
    '--person-points': 'personPoints',
    '--person-fps': 'personFps',
    '--wall-z': 'wallZ',
    '--floor-y': 'floorY',
    '--seed': 'seed',
    '--sources': 'sources',
    '--name': 'name',
  };
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const key = map[argv[i]];
    if (!key) throw new Error(`unknown option ${argv[i]}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`${argv[i - 1]} needs a value`);
    o[key] = key === 'out' || key === 'person' || key === 'name' ? v : Number(v);
  }
  if (!o.out) throw new Error('usage: node scripts/make-scene.mjs --out <dir> [--points N] [--duration S] [--person a:b] ...');
  if (!o.name) o.name = path.basename(path.resolve(o.out));
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const scene = makeScene(o);
  writeScene(o.out, scene);
  const bytes =
    scene.chunks.reduce((s, c) => s + c.bytes.byteLength, 0) + scene.alignment.byteLength + (scene.people ? scene.people.bin.byteLength : 0);
  console.log(
    `wrote ${o.out}: ${scene.stats.staticPoints} static points in ${scene.chunks.length} chunks, ` +
      `${scene.stats.alignmentPoints} alignment points, ${scene.stats.ghostFrames} ghost frames, ` +
      `${(bytes / 1e6).toFixed(2)} MB, duration ${scene.manifest.duration} s`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
