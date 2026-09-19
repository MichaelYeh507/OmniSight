"""OmniSight scene format: chunk files and people files. Owner: Dev C (first hour).

Chunk files (``chunks/NNNN.bin`` and ``alignment.bin``) are little-endian:

    char[4]  "OMNI"
    uint32   version = 1
    uint32   N                 number of splats
    float32  t_start
    float32  t_end
    uint32   reserved          header is 24 bytes
    float32  positions[3N]     world frame, meters
    float32  normals[3N]       unit length, world frame
    float32  radius[N]         meters
    float32  t_seen[N]         seconds from recording start
    uint8    rgbs[4N]          r, g, b, source_id

Total size is ``24 + 36 * N`` bytes. Every array starts on a 4-byte boundary, so
JavaScript wraps each one in a typed array without copying. A chunk file is
byte-identical to a future WebSocket message.

``people.bin`` is a concatenation of per-frame blocks. Each block is
``float32 positions[3n]`` followed by ``uint8 rgba[4n]``, so every block is ``16n``
bytes. ``people.json`` indexes the blocks:
``[{"t": 12.4, "frame": 372, "offset": 0, "count": 2210, "centroid": [x, y, z]}]``
with ``offset`` in bytes.

See ``docs/CONTRACT.md``. Any change here is announced to all three devs first.
"""
from __future__ import annotations

import struct
import json
import os
import tempfile
from pathlib import Path
from typing import Iterable

import numpy as np

MAGIC = b"OMNI"
VERSION = 1
HEADER_SIZE = 24
HEADER_STRUCT = struct.Struct("<4sIIffI")  # magic, version, N, t_start, t_end, reserved
BYTES_PER_SPLAT = 36
BYTES_PER_GHOST_POINT = 16


def chunk_size(n: int) -> int:
    """Byte size of a chunk file holding ``n`` splats."""
    if not isinstance(n, (int, np.integer)) or not 0 <= n <= 0xffffffff:
        raise ValueError('splat count must be a uint32')
    return HEADER_SIZE + BYTES_PER_SPLAT * n


def _array(value, shape, name, dtype='<f4'):
    array = np.asarray(value)
    if array.shape != shape or not np.isfinite(array).all():
        raise ValueError(f'{name} must be finite with shape {shape}')
    if dtype == 'u1' and (np.any(array < 0) or np.any(array > 255) or np.any(array != np.floor(array))):
        raise ValueError(f'{name} must contain byte values')
    with np.errstate(over='ignore'):
        array = np.ascontiguousarray(array, dtype=dtype)
    if not np.isfinite(array).all():
        raise ValueError(f'{name} exceeds float32 range')
    return array


def _atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(prefix=f'.{path.name}_', dir=path.parent)
    try:
        with os.fdopen(handle, 'wb') as stream:
            stream.write(data)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def _chunk_arrays(positions, normals, radius, t_seen, rgbs, start, end):
    if not np.isfinite([start, end]).all() or not 0 <= start <= end or end > np.finfo(np.float32).max:
        raise ValueError('chunk times must be finite, nonnegative and ordered')
    n = len(positions)
    chunk_size(n)
    arrays = dict(positions=_array(positions, (n, 3), 'positions'),
                  normals=_array(normals, (n, 3), 'normals'),
                  radius=_array(radius, (n,), 'radius'), t_seen=_array(t_seen, (n,), 't_seen'),
                  rgbs=_array(rgbs, (n, 4), 'rgbs', 'u1'))
    if not np.allclose(np.linalg.norm(arrays['normals'], axis=1), 1, atol=1e-4):
        raise ValueError('normals must be unit length')
    if np.any(arrays['radius'] <= 0):
        raise ValueError('radius must be positive')
    if np.any(arrays['t_seen'] < np.float32(start)) or np.any(arrays['t_seen'] > np.float32(end)):
        raise ValueError('t_seen must lie within the chunk interval')
    return arrays


def write_chunk(
    path: str | Path,
    t_start: float,
    t_end: float,
    positions: np.ndarray,
    normals: np.ndarray,
    radius: np.ndarray,
    t_seen: np.ndarray,
    rgbs: np.ndarray,
) -> int:
    """Write one chunk file and return the number of splats written.

    positions: (N, 3) float32, world frame, meters
    normals:   (N, 3) float32, unit length
    radius:    (N,)   float32, meters
    t_seen:    (N,)   float32, seconds from recording start
    rgbs:      (N, 4) uint8, r, g, b, source_id

    Cast to the exact dtypes before writing. N may be 0 (header only).
    """
    arrays = _chunk_arrays(positions, normals, radius, t_seen, rgbs, t_start, t_end)
    n = len(arrays['positions'])
    data = HEADER_STRUCT.pack(MAGIC, VERSION, n, t_start, t_end, 0)
    data += b''.join(array.tobytes() for array in arrays.values())
    _atomic_write(path, data)
    return n


def read_chunk(path: str | Path) -> dict:
    """Read one chunk file.

    Returns a dict with keys ``version``, ``n``, ``t_start``, ``t_end`` and the arrays
    ``positions`` (N, 3) float32, ``normals`` (N, 3) float32, ``radius`` (N,) float32,
    ``t_seen`` (N,) float32, ``rgbs`` (N, 4) uint8. Raises ``ValueError`` on a bad
    magic, version or file size.
    """
    data = Path(path).read_bytes()
    if len(data) < HEADER_SIZE:
        raise ValueError('truncated OMNI header')
    magic, version, n, start, end, reserved = HEADER_STRUCT.unpack_from(data)
    if magic != MAGIC or version != VERSION or reserved != 0:
        raise ValueError('unsupported OMNI magic, version or reserved field')
    if len(data) != chunk_size(n):
        raise ValueError('OMNI file size does not match splat count')
    arrays = {}
    offset = HEADER_SIZE
    for name, shape, dtype in [('positions', (n, 3), '<f4'), ('normals', (n, 3), '<f4'),
                               ('radius', (n,), '<f4'), ('t_seen', (n,), '<f4'), ('rgbs', (n, 4), 'u1')]:
        count = int(np.prod(shape))
        arrays[name] = np.frombuffer(data, dtype=dtype, count=count, offset=offset).reshape(shape).copy()
        offset += arrays[name].nbytes
    arrays = _chunk_arrays(**arrays, start=start, end=end)
    return dict(version=version, n=n, t_start=start, t_end=end, **arrays)


def write_people(out_dir: str | Path, frames: Iterable[dict]) -> list[dict]:
    """Write ``people.bin`` and ``people.json`` into ``out_dir`` and return the index.

    ``frames`` is an iterable of dicts, in ascending time order, each with
    ``t`` (float, seconds), ``frame`` (int), ``positions`` (n, 3) float32 in the
    normalized world frame and ``rgba`` (n, 4) uint8 (alpha 255).

    The returned index is plain JSON-serialisable data, one entry per frame:
    ``{"t", "frame", "offset", "count", "centroid"}`` where ``offset`` is the running
    sum of ``16 * count`` over earlier frames and ``centroid`` is the mean position.
    """
    index, blocks, offset, previous = [], [], 0, -1.
    for frame in frames:
        t, number = frame['t'], frame['frame']
        if not np.isfinite(t) or t < 0 or t < previous:
            raise ValueError('ghost timestamps must be finite, nonnegative and sorted')
        if not isinstance(number, (int, np.integer)) or number < 0:
            raise ValueError('ghost frame must be a nonnegative integer')
        previous = t
        n = len(frame['positions'])
        positions = _array(frame['positions'], (n, 3), 'positions')
        rgba = _array(frame['rgba'], (n, 4), 'rgba', 'u1')
        if not n:
            continue
        index.append(dict(t=float(t), frame=int(number), offset=offset, count=n,
                          centroid=positions.astype(np.float64).mean(axis=0).tolist()))
        blocks.extend((positions.tobytes(), rgba.tobytes()))
        offset += BYTES_PER_GHOST_POINT * n
    # Validate the whole iterable before replacing either file.
    out = Path(out_dir)
    _atomic_write(out / 'people.bin', b''.join(blocks))
    _atomic_write(out / 'people.json', (json.dumps(index, allow_nan=False) + '\n').encode())
    return index


def read_people(scene_dir: str | Path) -> list[dict]:
    """Read ``people.json`` and ``people.bin`` from ``scene_dir``.

    Returns the index entries with two extra keys per entry: ``positions`` (n, 3)
    float32 and ``rgba`` (n, 4) uint8.
    """
    root = Path(scene_dir)
    index = json.loads((root / 'people.json').read_text())
    data = (root / 'people.bin').read_bytes()
    if not isinstance(index, list):
        raise ValueError('people index must be a list')
    result, offset, previous = [], 0, -1.
    for entry in index:
        if not isinstance(entry, dict) or not {'t', 'frame', 'offset', 'count', 'centroid'} <= entry.keys():
            raise ValueError('malformed people index entry')
        n, start, t, frame = entry['count'], entry['offset'], entry['t'], entry['frame']
        if not isinstance(n, int) or n <= 0 or not isinstance(start, int) or start != offset or not isinstance(frame, int) or frame < 0:
            raise ValueError('invalid people count, offset or frame')
        if not isinstance(t, (int, float)) or not np.isfinite(t) or t < 0 or t < previous:
            raise ValueError('ghost timestamps must be finite, nonnegative and sorted')
        end = start + BYTES_PER_GHOST_POINT * n
        if end > len(data):
            raise ValueError('truncated people block')
        positions = np.frombuffer(data, '<f4', 3 * n, start).reshape(n, 3).copy()
        rgba = np.frombuffer(data, 'u1', 4 * n, start + 12 * n).reshape(n, 4).copy()
        centroid = np.asarray(entry['centroid'], dtype=float)
        if not np.isfinite(positions).all() or centroid.shape != (3,) or not np.allclose(centroid, positions.astype(np.float64).mean(axis=0), atol=1e-5):
            raise ValueError('invalid ghost positions or centroid')
        result.append(dict(entry, positions=positions, rgba=rgba))
        offset, previous = end, t
    if offset != len(data):
        raise ValueError('unindexed bytes in people.bin')
    return result
