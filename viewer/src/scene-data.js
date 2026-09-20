// Pure helpers over parsed scene data (no fetch, no three.js) so Node tests cover them.

/** Merge parsed chunks (time sorted) into one static splat set plus per-chunk indices. */
export function mergeChunks(chunks, metas) {
  const count = chunks.reduce((s, c) => s + c.n, 0);
  const positions = new Float32Array(3 * count);
  const normals = new Float32Array(3 * count);
  const colors = new Uint8Array(4 * count);
  const radius = new Float32Array(count);
  const tSeen = new Float32Array(count);
  const chunkStart = new Float32Array(chunks.length); // t_start per chunk
  const chunkEnd = new Uint32Array(chunks.length); // cumulative splat count after each chunk
  let o = 0;
  chunks.forEach((c, i) => {
    positions.set(c.positions, 3 * o);
    normals.set(c.normals, 3 * o);
    colors.set(c.rgbs, 4 * o);
    radius.set(c.radius, o);
    tSeen.set(c.tSeen, o);
    o += c.n;
    chunkStart[i] = metas ? metas[i].t_start : c.tStart;
    chunkEnd[i] = o;
  });
  return { count, positions, normals, colors, radius, tSeen, chunkStart, chunkEnd, bounds: computeBounds(positions, count) };
}

export function computeBounds(positions, count = positions.length / 3) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < 3; d++) {
      const v = positions[3 * i + d];
      if (v < min[d]) min[d] = v;
      if (v > max[d]) max[d] = v;
    }
  }
  return { min, max };
}

/** Number of static splats whose chunk has started by time t (a prefix, since chunks are time sorted). */
export function drawCountAt(staticData, t) {
  const { chunkStart, chunkEnd } = staticData;
  let lo = 0;
  let hi = chunkStart.length; // binary search: first index with chunkStart > t
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (chunkStart[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? 0 : chunkEnd[lo - 1];
}

/** Index of the latest trajectory pose with pose.t <= t, or -1. */
export function poseIndexAt(trajectory, t) {
  let lo = 0;
  let hi = trajectory.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trajectory[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

// --- ghosts -------------------------------------------------------------------
// A person is "seen" while the latest ghost frame is recent; after that the viewer
// holds the last frame and fades it out. Both stages live here so they are testable.
export const GHOST_SEEN_GAP = 0.75; // s: a frame older than this means the person is no longer observed
export const GHOST_FADE = 15; // s: fade duration once no longer observed

/** Index of the latest people entry with entry.t <= t, or -1 (entries sorted by t). */
export function ghostIndexAt(entries, t) {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Ghost state at replay time t: null before the first sighting, otherwise
 * { index, entry, age, seen, alpha, lastSeen } where alpha is 1 while seen,
 * fades to 0 over GHOST_FADE seconds afterwards, and lastSeen is whole seconds.
 */
export function ghostStateAt(entries, t) {
  const index = ghostIndexAt(entries, t);
  if (index < 0) return null;
  const entry = entries[index];
  const age = t - entry.t;
  const seen = age <= GHOST_SEEN_GAP;
  const alpha = seen ? 1 : Math.max(0, 1 - (age - GHOST_SEEN_GAP) / GHOST_FADE);
  return { index, entry, age, seen, alpha, lastSeen: Math.floor(age) };
}

// --- responder pose ---------------------------------------------------------------
/**
 * Interpolated responder pose at time t: { index, position [x,y,z], quaternion [x,y,z,w] }.
 * Linear position, normalized-lerp quaternion (poses are 0.1 s apart, so nlerp is fine).
 * Before the first pose the first pose is returned; after the last, the last.
 */
/** Group a merged trajectory by source id (docs/CONTRACT.md `source`), time order kept inside each group, lowest id first. */
export function splitTrajectory(trajectory) {
  const groups = new Map();
  for (const p of trajectory || []) {
    const id = Number.isInteger(p.source) ? p.source : 0;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(p);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([source, entries]) => ({ source, entries }));
}

export function poseAt(trajectory, t) {
  if (!trajectory || !trajectory.length) return null;
  const i = poseIndexAt(trajectory, t);
  if (i < 0) return { index: 0, position: [...trajectory[0].position], quaternion: [...trajectory[0].quaternion] };
  const a = trajectory[i];
  const b = trajectory[i + 1];
  if (!b || b.t <= a.t) return { index: i, position: [...a.position], quaternion: [...a.quaternion] };
  const s = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
  const position = a.position.map((v, k) => v + (b.position[k] - v) * s);
  const dot = a.quaternion.reduce((acc, v, k) => acc + v * b.quaternion[k], 0);
  const sign = dot < 0 ? -1 : 1; // shortest arc
  const q = a.quaternion.map((v, k) => v * (1 - s) + sign * b.quaternion[k] * s);
  const len = Math.hypot(...q) || 1;
  return { index: i, position, quaternion: q.map((v) => v / len) };
}

// --- portal -----------------------------------------------------------------------
/** Where the ray origin + s*dir (s > 0) crosses the plane z = wallZ, or null if it does not. */
/**
 * Keep a wall hit within `reach` metres (in the wall plane) of the point straight in front of the viewer.
 * A grazing gaze puts the hit tens of metres away; the portal occluder must stay over the visible wall.
 */
export function clampWallHit(hit, origin, reach) {
  const dx = hit[0] - origin[0];
  const dy = hit[1] - origin[1];
  const d = Math.hypot(dx, dy);
  if (d <= reach) return { hit, clamped: false };
  const k = reach / d;
  return { hit: [origin[0] + dx * k, origin[1] + dy * k, hit[2]], clamped: true };
}

export function intersectWallPlane(origin, dir, wallZ) {
  if (Math.abs(dir[2]) < 1e-6) return null;
  const s = (wallZ - origin[2]) / dir[2];
  if (s <= 0) return null;
  return [origin[0] + dir[0] * s, origin[1] + dir[1] * s, wallZ];
}

// --- wall plane (any orientation) -------------------------------------------------
// The contract's wall is z = wall_z with the jig outside at z > wall_z. A take that was not
// recorded from a jig (room012: the door wall is x = -0.69, the corridor at x < -0.69) needs the
// portal on another plane, so the wall is a plane { normal, d } with n·p = d on the wall and n
// pointing to the OUTSIDE, the side the viewer stands on when looking through it.
export const WALL_CLIP_DEPTH = 0.14; // metres: x-ray hides the wall's own points this far past the plane, so the portal looks into the room, not at plaster

/**
 * Parse `?wall=`: "z:-1.8" (outside +Z, the jig default), "-x:-0.69" (outside -X), "y:2.4", or "nx,ny,nz,d".
 * Without a spec, the contract wall z = fallbackZ; null when neither is usable.
 */
export function parseWall(spec, fallbackZ = null) {
  const s = spec == null ? '' : String(spec).trim();
  if (!s) return Number.isFinite(fallbackZ) ? { normal: [0, 0, 1], d: fallbackZ, spec: `z:${fallbackZ}` } : null;
  const axis = s.match(/^([+-]?)([xyz]):(-?\d*\.?\d+)$/i);
  if (axis) {
    const sign = axis[1] === '-' ? -1 : 1;
    const normal = [0, 0, 0];
    normal['xyz'.indexOf(axis[2].toLowerCase())] = sign;
    return { normal, d: sign * Number(axis[3]), spec: s };
  }
  const parts = s.split(',').map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    const len = Math.hypot(parts[0], parts[1], parts[2]);
    if (len < 1e-9) return null;
    return { normal: [parts[0] / len, parts[1] / len, parts[2] / len], d: parts[3] / len, spec: s };
  }
  return null;
}

/** Signed distance of p from the wall plane: positive outside (the viewer's side), negative in the room. */
export function planeDistance(plane, p) {
  const [nx, ny, nz] = plane.normal;
  return nx * p[0] + ny * p[1] + nz * p[2] - plane.d;
}

/** Where origin + s*dir (s > 0) meets the plane, or null if the ray runs parallel or away from it. */
export function intersectPlane(origin, dir, plane) {
  const [nx, ny, nz] = plane.normal;
  const denom = nx * dir[0] + ny * dir[1] + nz * dir[2];
  if (Math.abs(denom) < 1e-6) return null;
  const s = -planeDistance(plane, origin) / denom;
  if (s <= 0) return null;
  return [origin[0] + dir[0] * s, origin[1] + dir[1] * s, origin[2] + dir[2] * s];
}

// --- scripted camera path (video renders) -------------------------------------------
/**
 * Parse `?campath=`: keyframes "t:px,py,pz@ax,ay,az" separated by ";" (position and look-at target in the
 * recording frame, metres). Sorted by t. null when empty or malformed.
 */
export function parseCamPath(spec) {
  if (!spec) return null;
  const keys = [];
  for (const part of String(spec).split(';')) {
    const m = part.trim().match(/^(-?[\d.]+):(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)@(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$/);
    if (!m) return null;
    const v = m.slice(1).map(Number);
    if (!v.every(Number.isFinite)) return null;
    keys.push({ t: v[0], pos: [v[1], v[2], v[3]], at: [v[4], v[5], v[6]] });
  }
  return keys.length ? keys.sort((a, b) => a.t - b.t) : null;
}

const ease = (x) => x * x * (3 - 2 * x); // smoothstep: the camera settles at every keyframe

/** Camera position and look-at at time t: held before the first key and after the last, eased in between. */
export function camPathAt(keys, t) {
  if (!keys || !keys.length) return null;
  if (t <= keys[0].t) return { pos: [...keys[0].pos], at: [...keys[0].at] };
  const last = keys[keys.length - 1];
  if (t >= last.t) return { pos: [...last.pos], at: [...last.at] };
  let i = 0;
  while (keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const s = ease((t - a.t) / (b.t - a.t));
  return { pos: a.pos.map((v, k) => v + (b.pos[k] - v) * s), at: a.at.map((v, k) => v + (b.at[k] - v) * s) };
}
