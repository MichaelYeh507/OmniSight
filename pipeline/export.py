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
    """Write the whole scene folder and return the manifest dict."""
    raise NotImplementedError("Dev A: see module docstring")
