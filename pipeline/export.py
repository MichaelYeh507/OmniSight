"""Write a scene folder. Owner: Dev A.

- Split on ``wall_z``: points with z greater than ``wall_z`` are on the viewer's side
  and go to ``alignment.bin``. The rest go to chunks.
- Bucket chunk points by ``t_seen`` into 0.5 s windows and write ``chunks/NNNN.bin``
  with ``common.omni_format.write_chunk``. Empty windows may be omitted.
- ``floor_y`` is the 5th percentile of all point heights.
- Write ``trajectory.json`` from the normalized poses (one entry per processed frame,
  ``{"t", "source", "position", "quaternion"}`` with quaternion ``[x, y, z, w]``).
- Write ``manifest.json`` with version, scene, duration, chunks, alignment_chunk,
  wall_z, floor_y, sources and processing_seconds (see docs/CONTRACT.md).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import json
import re
import tempfile
import time
import numpy as np
from scipy.spatial.transform import Rotation
from common import omni_format
from pipeline.normalize import validate_poses

CHUNK_SECONDS = 0.5


def export_scene(
    points: dict,
    poses: Any,
    timestamps: Any,
    out_dir: str | Path,
    wall_z: float,
    scene_name: str,
    sources: list[dict],
    processing_seconds: float,
) -> dict:
    """Write a new scene folder and return its manifest; never overwrite a take.

    Single-source poses/timestamps are arrays. For multiple sources, pass two dicts
    keyed by source ID with an array per recording. All times are recording-relative.
    C's people files are copied in after this succeeds. The shared writer is required.
    """
    started = time.perf_counter()
    out = Path(out_dir)
    if out.exists():
        raise FileExistsError(f'{out} already exists; choose a new scene folder to preserve existing A/B/C outputs')
    if not re.fullmatch(r'[a-z0-9_]+', scene_name) or out.name != scene_name:
        raise ValueError('scene name must equal output folder name and match [a-z0-9_]+')
    if not np.isfinite(wall_z) or not np.isfinite(processing_seconds) or processing_seconds < 0:
        raise ValueError('wall_z and processing_seconds must be finite; processing time cannot be negative')
    ids = [source['id'] for source in sources]
    if not ids or len(set(ids)) != len(ids) or any(not isinstance(i, int) or not 0 <= i <= 255 for i in ids):
        raise ValueError('sources need unique integer IDs in 0..255')
    if ids[0] != 0:
        raise ValueError('the first source must have ID 0 per the scene contract')
    for source in sources:
        if not isinstance(source.get('label'), str) or not isinstance(source.get('device'), str):
            raise ValueError('each source needs a label and device string')
    arrays = _validate_points(points, ids)
    trajectory = _trajectory(poses, timestamps, ids)
    if arrays['t_seen'].max() > max(entry['t'] for entry in trajectory) + 1e-5:
        raise ValueError('point timestamp exceeds trajectory duration')
    inside = arrays['positions'][:, 2] <= wall_z
    buckets = np.floor(arrays['t_seen'].astype(np.float64) / CHUNK_SECONDS).astype(np.int64)
    duration = max(entry['t'] for entry in trajectory)
    manifest = dict(version=1, scene=scene_name, duration=duration, chunks=[],
                    alignment_chunk='alignment.bin', wall_z=float(wall_z),
                    floor_y=float(np.percentile(arrays['positions'][:, 1], 5)),
                    sources=sources, processing_seconds=float(processing_seconds))
    out.parent.mkdir(parents=True, exist_ok=True)
    # Stage beside destination so a missing C writer or disk failure cannot publish
    # a manifest pointing to partial files. The final rename stays on one filesystem.
    with tempfile.TemporaryDirectory(prefix=f'.{scene_name}_', dir=out.parent) as temp:
        stage = Path(temp) / scene_name
        (stage / 'chunks').mkdir(parents=True)
        for bucket in np.unique(buckets[inside]):
            selected = inside & (buckets == bucket)
            start, end = float(bucket * CHUNK_SECONDS), float((bucket + 1) * CHUNK_SECONDS)
            file = f'chunks/{int(bucket):04}.bin'
            count = omni_format.write_chunk(stage / file, start, end, **{key: value[selected] for key, value in arrays.items()})
            if count != int(selected.sum()):
                raise ValueError('common writer returned an incorrect chunk count')
            manifest['chunks'].append(dict(file=file, t_start=start, t_end=end, count=int(count)))
            manifest['duration'] = max(manifest['duration'], end)
        alignment_end = max(CHUNK_SECONDS, float(arrays['t_seen'][~inside].max()) + CHUNK_SECONDS) if np.any(~inside) else CHUNK_SECONDS
        omni_format.write_chunk(stage / 'alignment.bin', 0., alignment_end, **{key: value[~inside] for key, value in arrays.items()})
        (stage / 'trajectory.json').write_text(json.dumps(trajectory, allow_nan=False) + '\n')
        manifest['processing_seconds'] += time.perf_counter() - started
        (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2, allow_nan=False) + '\n')
        if out.exists():
            raise FileExistsError(f'{out} appeared during export; refusing to replace it')
        stage.rename(out)
    return manifest


def _validate_points(points: dict, ids: list[int]) -> dict:
    n = len(points['positions'])
    if not n:
        raise ValueError('no static points survived filtering; check depth, confidence, masks and camera convention')
    shapes = {'positions': (n, 3), 'normals': (n, 3), 'radius': (n,), 't_seen': (n,), 'rgbs': (n, 4)}
    arrays = {}
    for key, shape in shapes.items():
        value = np.asarray(points[key])
        if value.shape != shape or not np.isfinite(value).all():
            raise ValueError(f'{key} must be finite with shape {shape}')
        if key == 'rgbs' and (np.any(value < 0) or np.any(value > 255) or np.any(value != np.floor(value))):
            raise ValueError('rgbs must contain byte values')
        arrays[key] = value.astype(np.uint8 if key == 'rgbs' else np.float32)
    if not np.allclose(np.linalg.norm(arrays['normals'], axis=1), 1, atol=1e-4):
        raise ValueError('normals must be unit vectors')
    if np.any(arrays['radius'] <= 0) or np.any(arrays['t_seen'] < 0):
        raise ValueError('radius must be positive and t_seen nonnegative')
    if not np.isin(arrays['rgbs'][:, 3], ids).all():
        raise ValueError('point source_id is missing from manifest sources')
    return arrays


def _trajectory(poses: Any, timestamps: Any, ids: list[int]) -> list[dict]:
    if not isinstance(poses, dict):
        if len(ids) != 1:
            raise ValueError('multiple sources require poses/timestamps dictionaries keyed by source ID')
        poses, timestamps = {ids[0]: poses}, {ids[0]: timestamps}
    if not isinstance(timestamps, dict) or set(poses) != set(ids) or set(timestamps) != set(ids):
        raise ValueError('pose and timestamp sources must match manifest sources')
    entries = []
    for source in ids:
        source_poses = validate_poses(poses[source])
        times = np.asarray(timestamps[source], dtype=np.float64)
        if times.shape != (len(source_poses),) or not np.isfinite(times).all() or np.any(times < 0) or np.any(np.diff(times) <= 0):
            raise ValueError('timestamps must match poses and strictly increase from recording start')
        if not np.isclose(times[0], 0) or not np.allclose(source_poses[0, :3, 3], 0, atol=1e-6):
            raise ValueError('each source must start at time zero and the normalized origin')
        for t, pose, quaternion in zip(times, source_poses, Rotation.from_matrix(source_poses[:, :3, :3]).as_quat()):
            entries.append(dict(t=float(t), source=source, position=pose[:3, 3].tolist(), quaternion=quaternion.tolist()))
    return sorted(entries, key=lambda entry: (entry['t'], entry['source']))
