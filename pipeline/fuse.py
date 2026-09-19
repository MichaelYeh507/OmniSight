"""Unproject, filter and voxel-dedupe depth frames into one static splat set. Owner: Dev A.

``unproject`` is imported by ``people/run.py`` for ghost points (docs/CONTRACT.md,
clarification 9). Do not change its signature without telling Dev C.

Per pixel of every ``stride``-th frame:

    keep pixel if  confidence == 2
              and  0.3 m < d < 4.5 m
              and  |d - d_neighbor| < 0.05 * d        (drops flying pixels at edges)
              and  pixel not in the dilated person mask

    p_cam   = [(u - cx) * d / fx, (v - cy) * d / fy, d]     (OpenCV convention)
    p_world = T_world_cam @ [p_cam, 1]
    normal  = cross product of neighbouring unprojected points, flipped toward the camera
    radius  = max(d / fx, voxel / 2)
    colour  = colour frame resized to depth resolution

Voxel dedupe: quantize ``p_world`` to the voxel grid and pack the three indices into
one int64 key. Keep a sorted array of seen keys. A point is new only if its key is
unseen. First observation wins and sets ``t_seen``.

Known limitation: re-observed surfaces do not refresh their age. Keep the hero
walkthrough linear so this never shows.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any


def unproject(depth_m: Any, K_depth: Any, T_world_cam: Any, keep_mask: Any = None) -> tuple[Any, Any]:
    """Unproject one depth frame into normalized world-space points.

    depth_m:     (H, W) float32 metres, 0 where invalid
    K_depth:     (3, 3) intrinsics at depth resolution
    T_world_cam: (4, 4) normalized camera-to-world pose of this frame
    keep_mask:   optional (H, W) bool; only True pixels are unprojected

    Returns ``(positions, pixel_index)``: positions (n, 3) float32 in the world frame
    and pixel_index (n,) int64 row-major indices into the (H, W) frame, so callers
    can look up colours or normals for the same pixels.
    """
    raise NotImplementedError("Dev A: see module docstring")


def fuse(
    rec: Any,
    poses: Any,
    voxel: float = 0.025,
    stride: int = 3,
    masks_dir: Path | None = None,
    source_id: int = 0,
) -> dict:
    """Fuse a recording into one static splat set.

    Returns a dict of arrays: ``positions`` (N, 3) float32, ``normals`` (N, 3) float32,
    ``radius`` (N,) float32, ``t_seen`` (N,) float32, ``rgbs`` (N, 4) uint8 with byte 4
    equal to ``source_id``.

    ``masks_dir`` holds ``NNNNNN.png`` person masks at depth resolution from
    ``people/run.py``; dilate each by a few pixels before excluding it.
    """
    raise NotImplementedError("Dev A: see module docstring")
