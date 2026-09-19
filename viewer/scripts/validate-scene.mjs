#!/usr/bin/env node
// Validate a scene folder against docs/CONTRACT.md. Run it before handing a scene to anyone:
//
//   node scripts/validate-scene.mjs public/scenes/<scene> [--budget 800000] [--strict-budget]
//
// Exit code 0 means the viewer will load it. Lines start with FAIL (blocks the handoff)
// or WARN (worth a look). --strict-budget turns an over-budget point count into a FAIL.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseChunk, parsePeople } from '../src/format.js';

const EPS = 1e-3;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function checkSplats(ch, file, { window, duration, wallZ, side, sourceIds }, fail, warn) {
  const n = ch.n;
  let nonFinite = 0;
  let badRadius = 0;
  let badNormal = 0;
  let badTime = 0;
  let wrongSide = 0;
  let badSource = 0;
  for (let i = 0; i < n; i++) {
    const x = ch.positions[3 * i];
    const y = ch.positions[3 * i + 1];
    const z = ch.positions[3 * i + 2];
    const nx = ch.normals[3 * i];
    const ny = ch.normals[3 * i + 1];
    const nz = ch.normals[3 * i + 2];
    const r = ch.radius[i];
    const t = ch.tSeen[i];
    if (![x, y, z, nx, ny, nz, r, t].every(Number.isFinite)) {
      nonFinite++;
      continue;
    }
    if (r <= 0) badRadius++;
    if (Math.abs(Math.hypot(nx, ny, nz) - 1) > 0.01) badNormal++;
    if (window) {
      if (t < window[0] - EPS || t > window[1] + EPS || t > duration + EPS) badTime++;
    }
    if (wallZ !== null) {
      if (side === 'chunk' && z > wallZ + EPS) wrongSide++;
      if (side === 'alignment' && z < wallZ - EPS) wrongSide++;
    }
    if (sourceIds && !sourceIds.has(ch.rgbs[4 * i + 3])) badSource++;
  }
  if (nonFinite) fail(`${file}: ${nonFinite} splats with NaN or Inf values`);
  if (badRadius) fail(`${file}: ${badRadius} splats with radius <= 0`);
  if (badNormal) (badNormal > n * 0.001 ? fail : warn)(`${file}: ${badNormal} of ${n} normals are not unit length`);
  if (badTime) fail(`${file}: ${badTime} t_seen values outside [${window[0]}, ${window[1]}] or beyond duration ${duration}`);
  if (wrongSide) {
    const rule = side === 'chunk' ? 'chunk points need z <= wall_z' : 'alignment points need z > wall_z';
    fail(`${file}: ${wrongSide} points on the wrong side of wall_z ${wallZ} (${rule})`);
  }
  if (badSource) fail(`${file}: ${badSource} splats whose source_id (rgbs byte 4) is not in manifest.sources`);
}

export function validateScene(dir, { budget = 800000, strictBudget = false } = {}) {
  const errors = [];
  const warnings = [];
  const fail = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);
  const stats = { staticPoints: 0, alignmentPoints: 0, peopleFrames: 0, peoplePoints: 0, chunkFiles: 0, bytes: 0, duration: null };
  const result = () => ({ ok: errors.length === 0, errors, warnings, stats });

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    fail(`${dir}: not a directory`);
    return result();
  }
  const readJson = (file) => {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      fail(`${file}: not valid JSON (${e.message})`);
      return null;
    }
  };
  const readBin = (file) => {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return undefined;
    const b = fs.readFileSync(p);
    stats.bytes += b.byteLength;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };

  // --- manifest.json
  const m = readJson('manifest.json');
  if (m === undefined) fail('manifest.json: missing');
  if (!m) return result();
  if (m.version !== 1) fail(`manifest.json: version ${m.version}, expected 1`);
  if (typeof m.scene !== 'string' || !/^[a-z0-9_]+$/.test(m.scene)) fail('manifest.json: scene must be a string matching [a-z0-9_]+');
  else if (m.scene !== path.basename(path.resolve(dir))) warn(`manifest.json: scene "${m.scene}" differs from the folder name "${path.basename(path.resolve(dir))}"`);
  if (!isNum(m.duration) || m.duration <= 0) fail('manifest.json: duration must be a positive number of seconds');
  if (!isNum(m.wall_z)) fail('manifest.json: wall_z is missing or not a number');
  if (!isNum(m.floor_y)) fail('manifest.json: floor_y is missing or not a number');
  if (!Array.isArray(m.sources) || !m.sources.length || !m.sources.every((s) => s && Number.isInteger(s.id) && typeof s.label === 'string')) {
    fail('manifest.json: sources must be a non-empty array of {id, label, device}');
  }
  if (!isNum(m.processing_seconds)) warn('manifest.json: processing_seconds is missing (the honesty caption needs it)');
  if (!Array.isArray(m.chunks) || !m.chunks.length) fail('manifest.json: chunks must be a non-empty array');
  const duration = isNum(m.duration) ? m.duration : Infinity;
  const wallZ = isNum(m.wall_z) ? m.wall_z : null;
  const sourceIds = Array.isArray(m.sources) ? new Set(m.sources.map((s) => s && s.id)) : null;
  stats.duration = isNum(m.duration) ? m.duration : null;

  // --- chunks
  let prevEnd = -Infinity;
  for (const [i, c] of (Array.isArray(m.chunks) ? m.chunks : []).entries()) {
    const label = `manifest.chunks[${i}]`;
    if (!c || typeof c.file !== 'string' || !isNum(c.t_start) || !isNum(c.t_end) || !Number.isInteger(c.count)) {
      fail(`${label}: needs {file, t_start, t_end, count}`);
      continue;
    }
    if (c.t_end < c.t_start) fail(`${label}: t_end ${c.t_end} is before t_start ${c.t_start}`);
    if (c.t_start < prevEnd - EPS) fail(`${label}: t_start ${c.t_start} overlaps the previous chunk, which ended at ${prevEnd}; sort chunks by t_start`);
    prevEnd = c.t_end;
    const buf = readBin(c.file);
    if (buf === undefined) {
      fail(`${c.file}: listed in the manifest but missing`);
      continue;
    }
    let ch;
    try {
      ch = parseChunk(buf, c.file);
    } catch (e) {
      fail(e.message);
      continue;
    }
    stats.chunkFiles++;
    stats.staticPoints += ch.n;
    if (ch.n !== c.count) fail(`${c.file}: header N=${ch.n} but the manifest says count=${c.count}`);
    if (Math.abs(ch.tStart - c.t_start) > EPS || Math.abs(ch.tEnd - c.t_end) > EPS) {
      fail(`${c.file}: header window [${ch.tStart}, ${ch.tEnd}] differs from the manifest [${c.t_start}, ${c.t_end}]`);
    }
    checkSplats(ch, c.file, { window: [c.t_start, c.t_end], duration, wallZ, side: 'chunk', sourceIds }, fail, warn);
  }

  // --- alignment.bin
  if (typeof m.alignment_chunk === 'string') {
    const buf = readBin(m.alignment_chunk);
    if (buf === undefined) fail(`${m.alignment_chunk}: listed as alignment_chunk but missing`);
    else {
      try {
        const ch = parseChunk(buf, m.alignment_chunk);
        stats.alignmentPoints = ch.n;
        if (ch.n === 0) warn(`${m.alignment_chunk}: empty; alignment mode will have nothing to show`);
        checkSplats(ch, m.alignment_chunk, { window: null, duration: Infinity, wallZ, side: 'alignment', sourceIds }, fail, warn);
      } catch (e) {
        fail(e.message);
      }
    }
  } else warn('manifest.json: alignment_chunk missing; alignment mode will have nothing to show');

  // --- trajectory.json
  const tr = readJson('trajectory.json');
  if (tr === undefined) fail('trajectory.json: missing');
  else if (tr) {
    if (!Array.isArray(tr) || !tr.length) fail('trajectory.json: must be a non-empty array');
    else {
      let lastT = -Infinity;
      let bad = 0;
      tr.forEach((p, i) => {
        const okShape =
          p && isNum(p.t) && Number.isInteger(p.source) && Array.isArray(p.position) && p.position.length === 3 && p.position.every(isNum) &&
          Array.isArray(p.quaternion) && p.quaternion.length === 4 && p.quaternion.every(isNum);
        if (!okShape) {
          bad++;
          return;
        }
        if (p.t < lastT) fail(`trajectory.json[${i}]: t ${p.t} is earlier than the previous entry; sort by t`);
        lastT = p.t;
        if (Math.abs(Math.hypot(...p.quaternion) - 1) > EPS) fail(`trajectory.json[${i}]: quaternion is not unit length`);
        if (sourceIds && !sourceIds.has(p.source)) fail(`trajectory.json[${i}]: source ${p.source} is not in manifest.sources`);
      });
      if (bad) fail(`trajectory.json: ${bad} entries are not {t, source, position[3], quaternion[4]}`);
      const first = tr[0];
      if (first && Array.isArray(first.position) && Array.isArray(first.quaternion)) {
        const [x, y, z] = first.position;
        const [qx, qy, qz, qw] = first.quaternion;
        if (Math.hypot(x, y, z) > EPS || Math.hypot(qx, qy, qz, qw - 1) > EPS) {
          fail(`trajectory.json[0]: first pose must be the identity (position [0,0,0], quaternion [0,0,0,1]); got ${JSON.stringify(first.position)} ${JSON.stringify(first.quaternion)}`);
        }
      }
      if (lastT > duration + EPS) fail(`trajectory.json: last t ${lastT} is beyond duration ${duration}`);
    }
  }

  // --- people.json + people.bin (optional pair)
  const pj = readJson('people.json');
  const pb = readBin('people.bin');
  if (pj === undefined && pb === undefined) warn('people.json / people.bin: absent, so no ghosts. Fine for a scene with nobody in it.');
  else if (pj === undefined || pb === undefined) fail('people.json and people.bin must both exist');
  else if (pj) {
    try {
      const { entries, totalPoints } = parsePeople(pj, pb);
      stats.peopleFrames = entries.length;
      stats.peoplePoints = totalPoints;
      let badCentroid = 0;
      let lateT = 0;
      for (const e of entries) {
        if (e.t > duration + EPS) lateT++;
        if (e.count > 0) {
          const c = [0, 0, 0];
          for (let i = 0; i < e.count; i++) {
            c[0] += e.positions[3 * i];
            c[1] += e.positions[3 * i + 1];
            c[2] += e.positions[3 * i + 2];
          }
          if (Math.hypot(c[0] / e.count - e.centroid[0], c[1] / e.count - e.centroid[1], c[2] / e.count - e.centroid[2]) > 0.01) badCentroid++;
        }
      }
      if (badCentroid) fail(`people.json: ${badCentroid} centroids differ from the mean of their points by more than 1 cm`);
      if (lateT) fail(`people.json: ${lateT} entries have t beyond duration ${duration}`);
      if (!entries.length) warn('people.json: empty index');
    } catch (e) {
      fail(e.message);
    }
  }

  // --- budget
  if (stats.staticPoints > budget) {
    (strictBudget ? fail : warn)(`static points ${stats.staticPoints} exceed the viewer budget of ${budget}`);
  }
  return result();
}

function main() {
  const argv = process.argv.slice(2);
  let dir = null;
  let budget = 800000;
  let strictBudget = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--budget') budget = Number(argv[++i]);
    else if (argv[i] === '--strict-budget') strictBudget = true;
    else if (argv[i].startsWith('--')) throw new Error(`unknown option ${argv[i]}`);
    else dir = argv[i];
  }
  if (!dir) throw new Error('usage: node scripts/validate-scene.mjs <scene dir> [--budget N] [--strict-budget]');
  const r = validateScene(dir, { budget, strictBudget });
  for (const e of r.errors) console.log(`FAIL ${e}`);
  for (const w of r.warnings) console.log(`WARN ${w}`);
  const s = r.stats;
  console.log(
    `${path.basename(path.resolve(dir))}: ${s.staticPoints} static points in ${s.chunkFiles} chunks, ` +
      `${s.alignmentPoints} alignment points, ${s.peopleFrames} ghost frames / ${s.peoplePoints} points, ` +
      `${(s.bytes / 1e6).toFixed(2)} MB, duration ${s.duration} s`,
  );
  console.log(r.ok ? `OK (${r.warnings.length} warnings)` : `FAILED (${r.errors.length} errors, ${r.warnings.length} warnings)`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
