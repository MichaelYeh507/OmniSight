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
