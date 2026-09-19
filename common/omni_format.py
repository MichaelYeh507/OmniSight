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
    return HEADER_SIZE + BYTES_PER_SPLAT * n


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
    raise NotImplementedError("Dev C: implement per docs/CONTRACT.md")


def read_chunk(path: str | Path) -> dict:
    """Read one chunk file.

    Returns a dict with keys ``version``, ``n``, ``t_start``, ``t_end`` and the arrays
    ``positions`` (N, 3) float32, ``normals`` (N, 3) float32, ``radius`` (N,) float32,
    ``t_seen`` (N,) float32, ``rgbs`` (N, 4) uint8. Raises ``ValueError`` on a bad
    magic, version or file size.
    """
    raise NotImplementedError("Dev C: implement per docs/CONTRACT.md")


def write_people(out_dir: str | Path, frames: Iterable[dict]) -> list[dict]:
    """Write ``people.bin`` and ``people.json`` into ``out_dir`` and return the index.

    ``frames`` is an iterable of dicts, in ascending time order, each with
    ``t`` (float, seconds), ``frame`` (int), ``positions`` (n, 3) float32 in the
    normalized world frame and ``rgba`` (n, 4) uint8 (alpha 255).

    The returned index is plain JSON-serialisable data, one entry per frame:
    ``{"t", "frame", "offset", "count", "centroid"}`` where ``offset`` is the running
    sum of ``16 * count`` over earlier frames and ``centroid`` is the mean position.
    """
    raise NotImplementedError("Dev C: implement per docs/CONTRACT.md")


def read_people(scene_dir: str | Path) -> list[dict]:
    """Read ``people.json`` and ``people.bin`` from ``scene_dir``.

    Returns the index entries with two extra keys per entry: ``positions`` (n, 3)
    float32 and ``rgba`` (n, 4) uint8.
    """
    raise NotImplementedError("Dev C: implement per docs/CONTRACT.md")
