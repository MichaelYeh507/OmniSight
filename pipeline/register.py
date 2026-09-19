"""Offline depth registration for recordings whose odometry drifts.

The normal pipeline trusts the recorded camera poses.  ``icp_align`` provides a
small, dependency-light point-to-point ICP primitive that can correct the rigid
error between consecutive depth frames before fusion.  It is intentionally
opt-in: registration can fail on frames with too little overlap, in which case
callers should keep the odometry pose and record the failure.
"""
from __future__ import annotations

from typing import Any

import numpy as np
import cv2
from scipy.spatial import cKDTree

from pipeline.fuse import unproject
from pipeline.loader import iter_frames


def _validate_points(points: Any, name: str) -> np.ndarray:
    array = np.asarray(points, dtype=np.float64)
    if array.ndim != 2 or array.shape[1] != 3 or len(array) == 0:
        raise ValueError(f'{name} must be a nonempty (N, 3) array')
    if not np.isfinite(array).all():
        raise ValueError(f'{name} must contain finite values')
    return array


def estimate_rigid_transform(source: Any, target: Any) -> np.ndarray:
    """Return the least-squares rigid transform mapping source points to target."""
    src = _validate_points(source, 'source')
    dst = _validate_points(target, 'target')
    if src.shape != dst.shape or len(src) < 3:
        raise ValueError('source and target need matching shapes with at least 3 points')
    src_center = src.mean(axis=0)
    dst_center = dst.mean(axis=0)
    covariance = (src - src_center).T @ (dst - dst_center)
    u, _, vh = np.linalg.svd(covariance)
    rotation = vh.T @ u.T
    if np.linalg.det(rotation) < 0:
        vh[-1] *= -1
        rotation = vh.T @ u.T
    transform = np.eye(4, dtype=np.float64)
    transform[:3, :3] = rotation
    transform[:3, 3] = dst_center - rotation @ src_center
    return transform


def _apply(points: np.ndarray, transform: np.ndarray) -> np.ndarray:
    return points @ transform[:3, :3].T + transform[:3, 3]


def icp_align(
    source: Any,
    target: Any,
    *,
    max_iterations: int = 20,
    max_correspondence: float = 0.25,
    min_pairs: int = 30,
    trim_fraction: float = 0.9,
) -> tuple[np.ndarray, float, int]:
    """Align source to target with trimmed point-to-point ICP.

    Returns ``(transform, rmse, correspondence_count)``.  The transform maps
    source coordinates into target coordinates.  A correspondence gate and a
    trimmed tail make isolated depth flying pixels less likely to move a map.
    """
    src = _validate_points(source, 'source')
    dst = _validate_points(target, 'target')
    if not isinstance(max_iterations, (int, np.integer)) or max_iterations < 1:
        raise ValueError('max_iterations must be positive')
    if not np.isfinite(max_correspondence) or max_correspondence <= 0:
        raise ValueError('max_correspondence must be positive and finite')
    if not isinstance(min_pairs, (int, np.integer)) or min_pairs < 3:
        raise ValueError('min_pairs must be at least 3')
    if not 0 < trim_fraction <= 1:
        raise ValueError('trim_fraction must be in (0, 1]')
    tree = cKDTree(dst)
    transform = np.eye(4, dtype=np.float64)
    previous_error = np.inf
    pairs = 0
    for _ in range(max_iterations):
        moved = _apply(src, transform)
        distances, indices = tree.query(moved, k=1)
        keep = distances <= max_correspondence
        if int(keep.sum()) < min_pairs:
            raise ValueError(f'insufficient correspondences ({int(keep.sum())} < {min_pairs})')
        candidates = np.flatnonzero(keep)
        if trim_fraction < 1:
            keep_count = max(min_pairs, int(len(candidates) * trim_fraction))
            order = np.argsort(distances[candidates])[:keep_count]
            candidates = candidates[order]
        delta = estimate_rigid_transform(moved[candidates], dst[indices[candidates]])
        transform = delta @ transform
        moved = _apply(src, transform)
        distances, indices = tree.query(moved, k=1)
        inliers = distances <= max_correspondence
        pairs = int(inliers.sum())
        if pairs < min_pairs:
            raise ValueError(f'insufficient correspondences ({pairs} < {min_pairs})')
        error = float(np.sqrt(np.mean(distances[inliers] ** 2)))
        if abs(previous_error - error) < 1e-6:
            break
        previous_error = error
    return transform, error, pairs


def register_pose_sequence(
    camera_points: list[Any],
    odometry_poses: Any,
    *,
    max_iterations: int = 15,
    max_correspondence: float = 0.25,
    min_pairs: int = 30,
    trim_fraction: float = 0.9,
    target_window: int = 8,
) -> tuple[np.ndarray, list[int]]:
    """Correct a sequence of camera poses using consecutive depth clouds.

    ``camera_points[i]`` must be expressed in the camera frame of
    ``odometry_poses[i]``.  The first pose is retained and each later pose is
    corrected by ICP against the preceding corrected cloud.  Frames with too
    little overlap keep their odometry pose and are returned in ``failures``;
    callers can choose whether to reject or report those frames.
    """
    poses = np.asarray(odometry_poses, dtype=np.float64)
    if poses.ndim != 3 or poses.shape[1:] != (4, 4) or len(poses) != len(camera_points):
        raise ValueError('pose and camera point counts must match')
    if len(poses) == 0:
        raise ValueError('pose sequence must be nonempty')
    if not isinstance(target_window, (int, np.integer)) or target_window < 1:
        raise ValueError('target_window must be positive')
    corrected = poses.copy()
    failures: list[int] = []
    world_history = [_apply(_validate_points(camera_points[0], 'camera_points[0]'), corrected[0])]
    for index in range(1, len(poses)):
        source = _validate_points(camera_points[index], f'camera_points[{index}]')
        predicted = _apply(source, poses[index])
        target_start = max(0, len(world_history) - target_window)
        target = np.concatenate(world_history[target_start:], axis=0)
        try:
            delta, _, _ = icp_align(predicted, target,
                                    max_iterations=max_iterations,
                                    max_correspondence=max_correspondence,
                                    min_pairs=min_pairs,
                                    trim_fraction=trim_fraction)
        except ValueError:
            failures.append(index)
            corrected[index] = poses[index]
        else:
            corrected[index] = delta @ poses[index]
        world_history.append(_apply(source, corrected[index]))
    return corrected, failures


def register_recording(
    rec: Any,
    poses: Any,
    *,
    stride: int = 3,
    masks_dir: Any = None,
    max_points: int = 2000,
    max_iterations: int = 12,
    max_correspondence: float = 0.25,
    min_pairs: int = 80,
) -> tuple[np.ndarray, list[int]]:
    """Register selected recording frames and return a full pose array.

    Depth points are sampled in camera coordinates, so registration does not
    depend on the current world basis.  The returned full array has corrected
    poses at the selected stride; unselected poses remain unchanged because A's
    fuser only consumes selected frames.
    """
    if not isinstance(stride, (int, np.integer)) or stride < 1:
        raise ValueError('stride must be positive')
    if not isinstance(max_points, (int, np.integer)) or max_points < min_pairs:
        raise ValueError('max_points must be at least min_pairs')
    pose_array = np.asarray(poses, dtype=np.float64)
    if pose_array.ndim != 3 or pose_array.shape[1:] != (4, 4) or len(pose_array) != rec.n_frames:
        raise ValueError('poses must match the recording frame count')
    camera_clouds, indices = [], []
    for index, _, depth, confidence in iter_frames(rec, stride):
        keep = (confidence == 2) & np.isfinite(depth) & (depth > .3) & (depth < 4.5)
        if masks_dir is not None:
            path = __import__('pathlib').Path(masks_dir) / f'{index:06}.png'
            mask = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
            if mask is None or mask.shape != depth.shape or mask.dtype != np.uint8:
                raise ValueError(f'person mask {path} must be an 8-bit grayscale PNG matching depth')
            keep &= cv2.dilate((mask != 0).astype(np.uint8), np.ones((5, 5), np.uint8)) == 0
        cloud, _ = unproject(depth, rec.intrinsics[index], np.eye(4), keep)
        if len(cloud) < min_pairs:
            camera_clouds.append(cloud.astype(np.float64))
        else:
            step = max(1, len(cloud) // max_points)
            camera_clouds.append(cloud[::step][:max_points].astype(np.float64))
        indices.append(index)
    registered, failures = register_pose_sequence(
        camera_clouds, pose_array[indices], max_iterations=max_iterations,
        max_correspondence=max_correspondence, min_pairs=min_pairs)
    result = pose_array.copy()
    result[indices] = registered
    return result, failures
