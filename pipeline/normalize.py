"""Normalize poses so frame 0 is the origin and its horizontal forward is -Z. Owner: Dev A.

The AR session may start before record is pressed, so frame 0 may not sit at the
origin.

1. Take frame 0's position as the new origin.
2. Project frame 0's forward vector onto the horizontal plane and rotate about Y so
   it points along -Z.
3. Apply that one yaw-plus-translation transform to every pose. Never tilt the
   frame, so gravity stays along Y.

Output convention (docs/CONTRACT.md, clarification 4): ``trajectory.json`` quaternions
rotate the three.js camera frame (the camera looks along its own -Z, +Y up) into the
world. If the raw poses use the OpenCV convention (+Z forward, +Y down), post-multiply
each pose by a 180-degree rotation about X before writing them out. The viewer does
no conversions.
"""
from __future__ import annotations

from typing import Any

import numpy as np


def validate_poses(poses: Any) -> np.ndarray:
    """Validate rigid camera-to-world transforms without silently repairing them."""
    array = np.asarray(poses, dtype=np.float64)
    if array.ndim != 3 or array.shape[1:] != (4, 4) or len(array) == 0:
        raise ValueError('poses must be a nonempty (F, 4, 4) array')
    if not np.isfinite(array).all() or not np.allclose(array[:, 3], [0, 0, 0, 1]):
        raise ValueError('poses must be finite homogeneous transforms')
    rotation = array[:, :3, :3]
    if not np.allclose(rotation.transpose(0, 2, 1) @ rotation, np.eye(3), atol=1e-5) or not np.allclose(np.linalg.det(rotation), 1, atol=1e-5):
        raise ValueError('poses must contain proper rotation matrices')
    return array


def camera_poses(poses: Any, convention: str = 'arkit') -> np.ndarray:
    """Convert raw camera axes to three.js/ARKit axes before normalization.

    Both conventions take camera-to-world transforms. OpenCV is +Z forward,
    +Y down; ARKit/three.js is -Z forward, +Y up. Never invert these poses.
    """
    array = validate_poses(poses)
    if convention == 'arkit':
        return array.copy()
    if convention == 'opencv':
        return array @ np.diag([1., -1., -1., 1.])
    raise ValueError('camera convention must be arkit or opencv')


def world_from_frame0(pose0: Any) -> Any:
    """Return the 4x4 yaw-plus-translation transform mapping the raw world frame to
    the normalized world frame, computed from frame 0's raw camera-to-world pose."""
    pose = validate_poses(np.asarray(pose0)[None])[0]
    forward = -pose[:3, 2]
    if np.hypot(forward[0], forward[2]) < 1e-6:
        raise ValueError('frame 0 needs a horizontal forward direction; start from a level jig')
    yaw = np.arctan2(forward[0], -forward[2])
    c, s = np.cos(yaw), np.sin(yaw)
    transform = np.eye(4)
    transform[:3, :3] = [[c, 0, s], [0, 1, 0], [-s, 0, c]]
    transform[:3, 3] = -transform[:3, :3] @ pose[:3, 3]
    return transform


def normalize_poses(poses: Any) -> Any:
    """Apply ``world_from_frame0`` to every pose. Input and output are (F, 4, 4)
    camera-to-world, in three.js/ARKit camera axes. The first position is zero;
    pitch and roll are retained to preserve gravity. For a level jig the first
    pose is the identity. Use ``camera_poses`` first for OpenCV raw poses.
    """
    array = validate_poses(poses)
    return world_from_frame0(array[0]) @ array
