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

Scale intrinsics to depth resolution using ``depth_width / colour_width`` for X and
``depth_height / colour_height`` for Y. Assert matching frame, depth, confidence and
pose counts. Dimensions are read from the recording rather than hardcoded.

The pose convention (camera-to-world vs world-to-camera, OpenCV vs ARKit axes) is
NOT documented. The two-frame ``.ply`` test in the design doc decides it: a wrong
convention gives an exploded cloud.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import csv
import os
import threading
import cv2
import numpy as np
from scipy.spatial.transform import Rotation

DEPTH_WIDTH = 256
DEPTH_HEIGHT = 192
_VIDEO_OPEN_LOCK = threading.Lock()


@dataclass
class Recording:
    take_dir: Path
    n_frames: int
    timestamps: Any  # (F,) float64 seconds relative to first recording frame
    poses: Any  # (F, 4, 4) float64 camera-to-world, raw from odometry.csv
    intrinsics: Any  # (F, 3, 3) float64, already scaled to depth resolution
    rgb_path: Path
    depth_dir: Path
    confidence_dir: Path


def load(take_dir: str | Path) -> Recording:
    """Read odometry, intrinsics and file lists. Does not decode video yet."""
    root = Path(take_dir)
    with (root / 'odometry.csv').open(newline='', encoding='utf-8-sig') as stream:
        reader = csv.DictReader(stream, skipinitialspace=True)
        if reader.fieldnames:
            reader.fieldnames = [name.strip() for name in reader.fieldnames]
        rows = list(reader)
    if not rows:
        raise ValueError('odometry.csv contains no frames')
    required = ['timestamp', 'frame', 'x', 'y', 'z', 'qx', 'qy', 'qz', 'qw']
    try:
        data = np.array([[float(row[key]) for key in required] for row in rows])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError('odometry.csv requires numeric timestamp, frame, x/y/z, qx/qy/qz/qw columns') from exc
    if not np.isfinite(data).all():
        raise ValueError('odometry.csv contains nonfinite values')
    n = len(data)
    if not np.array_equal(data[:, 1], np.arange(n)):
        raise ValueError('odometry frame numbers must be contiguous from zero, in video order')
    timestamps = data[:, 0] - data[0, 0]
    if np.any(np.diff(timestamps) <= 0):
        raise ValueError('odometry timestamps must strictly increase')
    for directory in ('depth', 'confidence'):
        expected = {f'{i:06}.png' for i in range(n)}
        actual = {path.name for path in (root / directory).glob('*.png')}
        if actual != expected:
            raise ValueError(f'{directory} files must match all {n} odometry frames; missing={sorted(expected - actual)[:5]}, extra={sorted(actual - expected)[:5]}')
    first_depth = cv2.imread(str(root / 'depth/000000.png'), cv2.IMREAD_UNCHANGED)
    if first_depth is None or first_depth.ndim != 2 or first_depth.dtype != np.uint16:
        raise ValueError('depth/000000.png must be a 16-bit grayscale PNG')
    height, width = first_depth.shape
    cap = _open_video(root / 'rgb.mp4')
    try:
        color_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        color_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    finally:
        cap.release()
    if color_width <= 0 or color_height <= 0:
        raise ValueError('cannot determine RGB video dimensions')
    intrinsic_fields = ('fx', 'fy', 'cx', 'cy')
    present = [key in rows[0] for key in intrinsic_fields]
    if any(present) and not all(present):
        raise ValueError('per-frame intrinsics require all fx, fy, cx, cy columns')
    if all(present):
        try:
            values = np.array([[float(row[key]) for key in intrinsic_fields] for row in rows])
        except (TypeError, ValueError) as exc:
            raise ValueError('per-frame intrinsics must be numeric') from exc
        intrinsics = np.repeat(np.eye(3)[None], n, axis=0)
        intrinsics[:, 0, 0], intrinsics[:, 1, 1] = values[:, 0], values[:, 1]
        intrinsics[:, 0, 2], intrinsics[:, 1, 2] = values[:, 2], values[:, 3]
    else:
        matrix = np.loadtxt(root / 'camera_matrix.csv', delimiter=',')
        if matrix.shape != (3, 3):
            raise ValueError('camera_matrix.csv must be 3 x 3')
        intrinsics = np.repeat(matrix[None], n, axis=0)
    if not np.isfinite(intrinsics).all() or np.any(intrinsics[:, (0, 1), (0, 1)] <= 0):
        raise ValueError('intrinsics need finite values and positive focal lengths')
    if not np.allclose(intrinsics[:, 2], [0, 0, 1]) or not np.allclose(intrinsics[:, 0, 1], 0) or not np.allclose(intrinsics[:, 1, 0], 0):
        raise ValueError('intrinsics must be a zero-skew pinhole matrix')
    intrinsics[:, 0, :] *= width / color_width
    intrinsics[:, 1, :] *= height / color_height
    quaternions = data[:, 5:9]
    if np.any(np.linalg.norm(quaternions, axis=1) < 1e-8):
        raise ValueError('odometry contains a zero quaternion')
    poses = np.repeat(np.eye(4)[None], n, axis=0)
    poses[:, :3, :3] = Rotation.from_quat(quaternions).as_matrix()
    poses[:, :3, 3] = data[:, 2:5]
    return Recording(root, n, timestamps, poses, intrinsics, root / 'rgb.mp4', root / 'depth', root / 'confidence')


def _open_video(path: Path):
    # Stray Scanner can put its first captured sample before playback time zero.
    # Honoring the MP4 edit list discards it and shifts RGB against depth/odometry.
    # OpenCV reads FFmpeg options at capture creation; restore the environment
    # immediately afterward so other video consumers retain their own settings.
    with _VIDEO_OPEN_LOCK:
        key = 'OPENCV_FFMPEG_CAPTURE_OPTIONS'
        previous = os.environ.get(key)
        options = [option for option in (previous or '').split('|')
                   if option and option.split(';', 1)[0] != 'ignore_editlist']
        os.environ[key] = '|'.join(options + ['ignore_editlist;1'])
        try:
            cap = cv2.VideoCapture(str(path), cv2.CAP_FFMPEG)
        finally:
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous
    # RGB must stay in sensor orientation to line up with depth and intrinsics.
    cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 0)
    if not cap.isOpened():
        cap.release()
        raise ValueError(f'cannot open RGB video {path}; check file and OpenCV FFmpeg/HEVC decoder support')
    return cap


def iter_frames(rec: Recording, stride: int = 1) -> Iterator[tuple[int, Any, Any, Any]]:
    """Yield ``(index, colour, depth_m, confidence)`` for every ``stride``-th frame.

    colour:     (H, W, 3) uint8 RGB, the video frame resized to depth resolution
    depth_m:    (H, W) float32 metres, 0 where invalid
    confidence: (H, W) uint8 in {0, 1, 2}; typically H=192, W=256

    Decode the video sequentially with OpenCV and skip frames by counting, never by
    seeking.
    """
    if not isinstance(stride, (int, np.integer)) or stride < 1:
        raise ValueError('stride must be a positive integer')
    cap = _open_video(rec.rgb_path)
    count = 0
    shape = None
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            index = count
            count += 1
            if count > rec.n_frames:
                raise ValueError(f'RGB video has more than {rec.n_frames} odometry frames')
            depth = cv2.imread(str(rec.depth_dir / f'{index:06}.png'), cv2.IMREAD_UNCHANGED)
            confidence = cv2.imread(str(rec.confidence_dir / f'{index:06}.png'), cv2.IMREAD_UNCHANGED)
            if depth is None or depth.ndim != 2 or depth.dtype != np.uint16:
                raise ValueError(f'depth frame {index} must be a 16-bit grayscale PNG')
            if shape is None:
                shape = depth.shape
            if depth.shape != shape:
                raise ValueError(f'depth frame {index} changed dimensions')
            if confidence is None or confidence.shape != shape or confidence.dtype != np.uint8 or np.any(confidence > 2):
                raise ValueError(f'confidence frame {index} must match depth and contain only 0, 1, 2')
            if index % stride == 0:
                rgb = cv2.cvtColor(cv2.resize(bgr, (shape[1], shape[0]), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
                yield index, rgb, depth.astype(np.float32) / 1000., confidence
        if count != rec.n_frames:
            raise ValueError(f'RGB video decoded {count} frames; expected {rec.n_frames}')
    finally:
        cap.release()
