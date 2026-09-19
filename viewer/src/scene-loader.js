// Fetches a scene folder and returns plain typed arrays (no three.js), so the loader
// is testable in Node and the renderer stays a thin layer on top.
import { parseChunk, parsePeople, concatPeople } from './format.js';
import { mergeChunks } from './scene-data.js';
import { sceneUrl, params } from './params.js';

async function fetchJson(file) {
  const r = await fetch(sceneUrl(file));
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status} (${r.url})`);
  return r.json();
}

async function fetchBuffer(file) {
  const r = await fetch(sceneUrl(file));
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status} (${r.url})`);
  return r.arrayBuffer();
}

const optional = (p) => p.catch(() => undefined);

/**
 * Load everything the viewer needs for `params.scene`.
 * onProgress(done, total, label) is called as files arrive.
 */
export async function loadScene(onProgress = () => {}) {
  let manifest;
  try {
    manifest = await fetchJson('manifest.json');
  } catch (e) {
    throw new Error(
      `Scene "${params.scene}" did not load (${e.message}). ` +
        `Check ?scene= or generate one: node scripts/make-scene.mjs --out public/scenes/${params.scene}`,
    );
  }
  if (manifest.version !== 1) throw new Error(`manifest.json: version ${manifest.version}, the viewer speaks version 1`);
  if (!Array.isArray(manifest.chunks) || !manifest.chunks.length) throw new Error('manifest.json: no chunks listed');

  const chunkMetas = [...manifest.chunks].sort((a, b) => a.t_start - b.t_start);
  const total = chunkMetas.length + 4;
  let done = 0;
  const tick = (label) => onProgress(++done, total, label);

  const [chunkBuffers, alignBuffer, trajectory, peopleIndex, peopleBuffer] = await Promise.all([
    Promise.all(chunkMetas.map((c) => fetchBuffer(c.file).then((b) => (tick(c.file), b)))),
    manifest.alignment_chunk ? optional(fetchBuffer(manifest.alignment_chunk)).then((b) => (tick('alignment'), b)) : (tick('alignment'), undefined),
    optional(fetchJson('trajectory.json')).then((t) => (tick('trajectory'), t)),
    optional(fetchJson('people.json')).then((p) => (tick('people.json'), p)),
    optional(fetchBuffer('people.bin')).then((p) => (tick('people.bin'), p)),
  ]);

  // --- static splats: merge every chunk into one set of arrays, in time order
  const chunks = chunkBuffers.map((b, i) => parseChunk(b, chunkMetas[i].file));
  chunks.forEach((c, i) => {
    if (c.n !== chunkMetas[i].count) console.warn(`[omni] ${chunkMetas[i].file}: header N=${c.n} but manifest count=${chunkMetas[i].count}`);
  });
  const staticData = mergeChunks(chunks, chunkMetas);

  // --- alignment cloud (the recorded outside of the wall)
  let alignment = null;
  if (alignBuffer) {
    const a = parseChunk(alignBuffer, manifest.alignment_chunk);
    alignment = { count: a.n, positions: a.positions, normals: a.normals, colors: a.rgbs, radius: a.radius, tSeen: a.tSeen };
  }

  // --- people
  let people = null;
  if (peopleIndex && peopleBuffer) {
    const { entries, totalPoints } = parsePeople(peopleIndex, peopleBuffer);
    people = { entries, ...concatPeople(entries), totalPoints };
  } else if (peopleIndex || peopleBuffer) {
    console.warn('[omni] people.json and people.bin must both exist; ghosts disabled');
  }

  const traj = Array.isArray(trajectory) ? [...trajectory].sort((a, b) => a.t - b.t) : [];

  return {
    manifest,
    duration: Number(manifest.duration) || (chunkMetas.at(-1)?.t_end ?? 0),
    wallZ: Number.isFinite(manifest.wall_z) ? manifest.wall_z : null,
    floorY: Number.isFinite(manifest.floor_y) ? manifest.floor_y : null,
    static: staticData,
    alignment,
    trajectory: traj,
    people,
    bytes: chunkBuffers.reduce((s, b) => s + b.byteLength, 0) + (alignBuffer?.byteLength || 0) + (peopleBuffer?.byteLength || 0),
  };
}
