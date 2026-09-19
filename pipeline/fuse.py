"""Unproject, filter and voxel-dedupe depth frames into one static splat set. Owner: Dev A.

``unproject`` is imported by ``people/run.py`` for ghost points (docs/CONTRACT.md,
clarification 9). Do not change its signature without telling Dev C.

Per pixel of every ``stride``-th frame:

    keep pixel if  confidence == 2
              and  0.3 m < d < 4.5 m
              and  |d - d_neighbor| < 0.05 * d        (drops flying pixels at edges)
              and  pixel not in the dilated person mask

    p_cam   = [(u - cx) * d / fx, (v - cy) * d / fy, d]     (OpenCV convention)
    p_world = T_world_cam @ [p_cam.x, -p_cam.y, -p_cam.z, 1]
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

import numpy as np
import cv2
from pipeline.loader import iter_frames
from pipeline.normalize import validate_poses


def unproject(depth_m: Any, K_depth: Any, T_world_cam: Any, keep_mask: Any = None) -> tuple[Any, Any]:
    """Unproject one depth frame into normalized world-space points.

    depth_m:     (H, W) float32 metres, 0 where invalid
    K_depth:     (3, 3) intrinsics at depth resolution
    T_world_cam: (4, 4) normalized three.js/ARKit camera-to-world pose of this frame
    keep_mask:   optional (H, W) bool; only True pixels are unprojected

    Returns ``(positions, pixel_index)``: positions (n, 3) float32 in the world frame
    and pixel_index (n,) int64 row-major indices into the (H, W) frame, so callers
    can look up colours or normals for the same pixels.
    """
    depth = np.asarray(depth_m, dtype=np.float64)
    k = np.asarray(K_depth, dtype=np.float64)
    pose = validate_poses(np.asarray(T_world_cam)[None])[0]
    if depth.ndim != 2:
        raise ValueError('depth must be (H, W)')
    if k.shape != (3, 3) or not np.isfinite(k).all() or k[0, 0] <= 0 or k[1, 1] <= 0 or not np.allclose(k[2], [0, 0, 1]) or k[0, 1] != 0 or k[1, 0] != 0:
        raise ValueError('intrinsics must be a finite zero-skew pinhole matrix with positive focal lengths')
    keep = np.isfinite(depth) & (depth > 0)
    if keep_mask is not None:
        mask = np.asarray(keep_mask, dtype=bool)
        if mask.shape != depth.shape:
            raise ValueError('keep_mask must match depth dimensions')
        keep &= mask
    indices = np.flatnonzero(keep).astype(np.int64)
    v, u = np.unravel_index(indices, depth.shape)
    d = depth.ravel()[indices]
    # OpenCV depth (+Z forward, +Y down) -> three.js camera axes, exactly once.
    camera = np.column_stack(((u - k[0, 2]) * d / k[0, 0], -(v - k[1, 2]) * d / k[1, 1], -d))
    positions = camera @ pose[:3, :3].T + pose[:3, 3]
    return positions.astype(np.float32), indices


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
    if not np.isfinite(voxel) or voxel <= 0:
        raise ValueError('voxel must be finite and positive')
    if not isinstance(stride, (int, np.integer)) or stride < 1:
        raise ValueError('stride must be a positive integer')
    if not isinstance(source_id, (int, np.integer)) or not 0 <= source_id <= 255:
        raise ValueError('source_id must be an integer in 0..255')
    poses = validate_poses(poses)
    if len(poses) != rec.n_frames:
        raise ValueError('pose count must match recording')
    # Keep the global voxel index as a hash set. Re-sorting the full history on
    # every frame makes long recordings quadratic and stalls real 60 s takes.
    seen: set[int] = set()
    batches = []
    for index, rgb, depth, confidence in iter_frames(rec, stride):
        keep = (confidence == 2) & np.isfinite(depth) & (depth > .3) & (depth < 4.5)
        # Normals require all four neighbors; omit the one-pixel border.
        interior = np.zeros(depth.shape, bool)
        center = depth[1:-1, 1:-1]
        valid = np.ones(center.shape, bool)
        for neighbor in (depth[:-2, 1:-1], depth[2:, 1:-1], depth[1:-1, :-2], depth[1:-1, 2:]):
            valid &= np.isfinite(neighbor) & (neighbor > 0) & (np.abs(center - neighbor) < .05 * center)
        interior[1:-1, 1:-1] = valid
        keep &= interior
        if masks_dir is not None:
            path = Path(masks_dir) / f'{index:06}.png'
            if not path.is_file():
                raise ValueError(f'missing person mask {path}; C must supply every selected frame, including empty masks')
            mask = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
            if mask is None or mask.shape != depth.shape or mask.dtype != np.uint8:
                raise ValueError(f'person mask {path} must be an 8-bit grayscale PNG matching depth')
            dilated = cv2.dilate((mask != 0).astype(np.uint8), np.ones((5, 5), np.uint8))
            keep &= dilated == 0
        positions, pixels = unproject(depth, rec.intrinsics[index], poses[index], keep)
        if not len(positions):
            continue
        # Compute world-space finite differences on the same unprojection C uses.
        all_points, all_pixels = unproject(depth, rec.intrinsics[index], poses[index])
        grid = np.zeros((*depth.shape, 3), np.float32)
        grid.reshape(-1, 3)[all_pixels] = all_points
        normals_grid = np.zeros_like(grid)
        normals_grid[1:-1, 1:-1] = np.cross(grid[1:-1, 2:] - grid[1:-1, :-2], grid[2:, 1:-1] - grid[:-2, 1:-1])
        normals = normals_grid.reshape(-1, 3)[pixels]
        lengths = np.linalg.norm(normals, axis=1)
        usable = np.isfinite(lengths) & (lengths > 1e-10)
        positions, pixels, normals, lengths = positions[usable], pixels[usable], normals[usable], lengths[usable]
        normals /= lengths[:, None]
        toward_camera = poses[index, :3, 3] - positions
        normals[np.einsum('ij,ij->i', normals, toward_camera) < 0] *= -1
        keys = voxel_keys(positions, voxel)
        unique_keys, first = np.unique(keys, return_index=True)
        unseen = np.fromiter((int(key) not in seen for key in unique_keys), dtype=bool, count=len(unique_keys))
        selected = first[unseen]
        seen.update(int(key) for key in unique_keys[unseen])
        if not len(selected):
            continue
        pixels = pixels[selected]
        colors = np.empty((len(selected), 4), np.uint8)
        colors[:, :3] = rgb.reshape(-1, 3)[pixels]
        colors[:, 3] = source_id
        batches.append(dict(positions=positions[selected], normals=normals[selected],
                            radius=np.maximum(depth.ravel()[pixels] / rec.intrinsics[index, 0, 0], voxel / 2).astype(np.float32),
                            t_seen=np.full(len(selected), rec.timestamps[index], np.float32), rgbs=colors))
    return concatenate_points(batches)


def voxel_keys(positions: Any, voxel: float) -> np.ndarray:
    """Collision-free packed 21-bit signed XYZ indices (fail on overflow)."""
    if not np.isfinite(voxel) or voxel <= 0:
        raise ValueError('voxel must be finite and positive')
    cells = np.floor(np.asarray(positions, dtype=np.float64) / voxel)
    limit = 1 << 20
    if not np.isfinite(cells).all() or np.any(cells < -limit) or np.any(cells >= limit):
        raise ValueError('voxel coordinate exceeds signed 21-bit range; increase voxel size')
    cells = cells.astype(np.int64) + limit
    return (cells[:, 0] << 42) | (cells[:, 1] << 21) | cells[:, 2]


def concatenate_points(batches: list[dict]) -> dict:
    shapes = {'positions': (0, 3), 'normals': (0, 3), 'radius': (0,), 't_seen': (0,), 'rgbs': (0, 4)}
    return {key: np.concatenate([batch[key] for batch in batches]) if batches else
            np.empty(shape, np.uint8 if key == 'rgbs' else np.float32)
            for key, shape in shapes.items()}


def merge_points(batches: list[dict], voxel: float) -> dict:
    """Merge takes on a shared replay clock; earliest observation wins, source order breaks ties."""
    points = concatenate_points(batches)
    order = np.argsort(points['t_seen'], kind='stable')
    keys = voxel_keys(points['positions'][order], voxel)
    _, first = np.unique(keys, return_index=True)
    selected = order[np.sort(first)]
    return {key: value[selected] for key, value in points.items()}
