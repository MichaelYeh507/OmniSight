"""Load one Stray Scanner recording. Owner: Dev A.

Verified against ``docs/format.md`` in github.com/StrayRobots/scanner on 2026-09-19:

- ``rgb.mp4``               HEVC colour video. Decode it SEQUENTIALLY and count frames;
                            seeking desyncs frames and poses.
- ``depth/NNNNNN.png``      16-bit grayscale PNG, 256 x 192, depth in millimetres, one
                            per colour frame.
- ``confidence/NNNNNN.png`` grayscale 256 x 192, values 0 (low), 1 (medium), 2 (high).
- ``odometry.csv``          columns: timestamp, frame, x, y, z, qx, qy, qz, qw, fx, fy,
                            cx, cy, distortion_center_x, distortion_center_y. Positions
                            in metres from session start, quaternion [x, y, z, w].
                            fx, fy, cx, cy are PER-FRAME intrinsics in pixels of the
                            COLOUR resolution; prefer them over camera_matrix.csv.
- ``camera_matrix.csv``     3 x 3 intrinsics of the FINAL frame only, kept for
                            backwards compatibility.
- ``imu.csv``               timestamp, a_x, a_y, a_z (m/s^2), alpha_x, alpha_y,
                            alpha_z (rad/s). Unused.
- ``distortion/``           optional per-frame float32 radial correction tables. Unused.

Scale intrinsics to depth resolution: multiply fx, fy, cx, cy by
``depth_width / colour_width``. Assert that frame, depth, confidence and pose counts
match.

The pose convention (camera-to-world vs world-to-camera, OpenCV vs ARKit axes) is
NOT documented. The two-frame ``.ply`` test in the design doc decides it: a wrong
convention gives an exploded cloud.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

DEPTH_WIDTH = 256
DEPTH_HEIGHT = 192


@dataclass
class Recording:
    take_dir: Path
    n_frames: int
    timestamps: Any  # (F,) float64 seconds, from odometry.csv
    poses: Any  # (F, 4, 4) float64 camera-to-world, raw from odometry.csv
    intrinsics: Any  # (F, 3, 3) float64, already scaled to depth resolution
    rgb_path: Path
    depth_dir: Path
    confidence_dir: Path


def load(take_dir: str | Path) -> Recording:
    """Read odometry, intrinsics and file lists. Does not decode video yet."""
    raise NotImplementedError("Dev A: see module docstring")


def iter_frames(rec: Recording, stride: int = 1) -> Iterator[tuple[int, Any, Any, Any]]:
    """Yield ``(index, colour, depth_m, confidence)`` for every ``stride``-th frame.

    colour:     (192, 256, 3) uint8 RGB, the video frame resized to depth resolution
    depth_m:    (192, 256) float32 metres, 0 where invalid
    confidence: (192, 256) uint8 in {0, 1, 2}

    Decode the video sequentially with OpenCV and skip frames by counting, never by
    seeking.
    """
    raise NotImplementedError("Dev A: see module docstring")
