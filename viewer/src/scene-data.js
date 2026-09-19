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
