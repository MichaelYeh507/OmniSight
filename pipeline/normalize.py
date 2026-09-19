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


def world_from_frame0(pose0: Any) -> Any:
    """Return the 4x4 yaw-plus-translation transform mapping the raw world frame to
    the normalized world frame, computed from frame 0's raw camera-to-world pose."""
    raise NotImplementedError("Dev A: see module docstring")


def normalize_poses(poses: Any) -> Any:
    """Apply ``world_from_frame0`` to every pose. Input and output are (F, 4, 4)
    camera-to-world. The first output pose must be the identity."""
    raise NotImplementedError("Dev A: see module docstring")
