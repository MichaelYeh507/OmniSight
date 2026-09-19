"""Person masks for A and ghost points for B. Owner: Dev C.

    python -m people.run data/raw/<take> --out people_out/<take> --stride 2

Two jobs per frame:

Masks for A (``<out>/masks/NNNNNN.png``)
    1. Run a small pretrained segmentation model on each colour frame and keep the
       "person" class.
    2. If the video is rotated, rotate the frame upright before detection and rotate
       the mask back.
    3. Resize the mask to depth resolution (256 x 192) with nearest-neighbour and save
       it as an 8-bit PNG, 255 = person. A dilates these by a few pixels.

Ghost points for B (``<out>/people.bin`` + ``<out>/people.json``)
    1. Erode the mask by one pixel, which removes flying pixels at the silhouette.
    2. Keep masked depth pixels with confidence 1 or 2.
    3. Unproject them with ``pipeline.fuse.unproject`` using A's normalized poses.
       Import it; do not reimplement it.
    4. Append positions and colours (alpha 255) through
       ``common.omni_format.write_people``. Subsample to keep ``people.bin`` under about
       15 MB for a 60 s take.

Copy or symlink ``people.bin`` and ``people.json`` into the scene folder A writes.

Rules: the label is always "person". No identity, no threat level. The hold-and-fade
logic lives in the viewer; this stage only reports what was seen and when.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from common.omni_format import write_people
from pipeline import loader, normalize
from pipeline.fuse import unproject


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m people.run",
        description="Write person masks for the pipeline and ghost points for the viewer.",
    )
    p.add_argument("take", type=Path, help="raw recording folder, e.g. data/raw/20260919_room_a_take3")
    p.add_argument("--out", type=Path, required=True, help="output folder, e.g. people_out/20260919_room_a_take3")
    p.add_argument("--stride", type=int, default=2, help="process every stride-th frame (default 2)")
    p.add_argument("--model", default="yolo11n-seg.pt", help="ultralytics segmentation checkpoint")
    p.add_argument("--max-points", type=int, default=3000, dest="max_points", help="subsample cap per ghost frame")
    p.add_argument("--rotation", type=int, choices=[0, 90, 180, 270], default=0,
                   help="clockwise rotation before segmentation; masks are rotated back")
    p.add_argument("--confidence", type=float, default=.25)
    p.add_argument("--device", default="cpu")
    p.add_argument("--camera-convention", choices=["arkit", "opencv"], default="arkit")
    return p


def _rotate_segmenter(segmenter: Callable[[np.ndarray], np.ndarray], rotation: int):
    if rotation == 0:
        return segmenter
    quarter_turns = rotation // 90

    def infer(bgr):
        upright = np.ascontiguousarray(np.rot90(bgr, -quarter_turns))
        mask = np.asarray(segmenter(upright))
        if mask.shape != upright.shape[:2] or mask.dtype != np.bool_:
            raise ValueError('segmenter must return a bool mask matching the rotated image')
        return np.ascontiguousarray(np.rot90(mask, quarter_turns))
    return infer


def process_recording(take: str | Path, out_dir: str | Path,
                      segmenter: Callable[[np.ndarray], np.ndarray], *,
                      stride: int = 2, max_points: int = 3000,
                      camera_convention: str = 'arkit') -> dict:
    """Create depth-aligned masks and world-space ghost blocks from one recording.

    ``segmenter`` receives BGR images already resized to depth resolution and returns
    a bool person mask. This injection keeps tests/model choice separate from the
    file and geometry path. Output is staged and published only after both people
    files, masks and summary are complete.
    """
    if not isinstance(stride, (int, np.integer)) or stride < 1:
        raise ValueError('stride must be a positive integer')
    if not isinstance(max_points, (int, np.integer)) or max_points < 1:
        raise ValueError('max_points must be a positive integer')
    out = Path(out_dir)
    if out.exists():
        raise FileExistsError(f'{out} exists; choose a new people output folder')
    rec = loader.load(take)
    poses = normalize.normalize_poses(normalize.camera_poses(rec.poses, camera_convention))
    frames = []
    summary = {'frames_processed': 0, 'frames_with_person': 0, 'ghost_frames': 0,
               'ghost_points': 0, 'stride': int(stride), 'max_points': int(max_points),
               'label': 'person', 'camera_convention': camera_convention}
    with tempfile.TemporaryDirectory(prefix='.people_', dir=out.parent) as temp:
        stage = Path(temp) / out.name
        (stage / 'masks').mkdir(parents=True)
        for index, rgb, depth, confidence in loader.iter_frames(rec, stride):
            bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            mask = np.asarray(segmenter(bgr))
            if mask.shape != depth.shape or mask.dtype != np.bool_:
                raise ValueError(f'segmenter mask for frame {index} must be bool {depth.shape}, got {mask.shape} {mask.dtype}')
            mask_png = (mask.astype(np.uint8) * 255)
            if not cv2.imwrite(str(stage / 'masks' / f'{index:06}.png'), mask_png):
                raise OSError(f'failed to write mask for frame {index}')
            summary['frames_processed'] += 1
            if not mask.any():
                continue
            summary['frames_with_person'] += 1
            eroded = cv2.erode(mask.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=1).astype(bool)
            keep = eroded & (confidence >= 1) & np.isfinite(depth) & (depth > .3) & (depth < 4.5)
            positions, pixels = unproject(depth, rec.intrinsics[index], poses[index], keep)
            if not len(positions):
                continue
            if len(positions) > max_points:
                selected = np.linspace(0, len(positions) - 1, max_points, dtype=np.int64)
                positions, pixels = positions[selected], pixels[selected]
            rgba = np.empty((len(positions), 4), np.uint8)
            rgba[:, :3] = rgb.reshape(-1, 3)[pixels]
            rgba[:, 3] = 255
            frames.append({'t': float(rec.timestamps[index]), 'frame': int(index),
                           'positions': positions, 'rgba': rgba})
        index = write_people(stage, frames)
        summary['ghost_frames'] = len(index)
        summary['ghost_points'] = sum(entry['count'] for entry in index)
        (stage / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        if out.exists():
            raise FileExistsError(f'{out} appeared during ghost generation')
        stage.rename(out)
    return summary


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        from people.masks import PersonSegmenter
        segmenter = PersonSegmenter(args.model, args.confidence, args.device)
        summary = process_recording(args.take, args.out, _rotate_segmenter(segmenter, args.rotation),
                                    stride=args.stride, max_points=args.max_points,
                                    camera_convention=args.camera_convention)
        print(f"wrote {summary['frames_processed']} masks and {summary['ghost_points']} ghost points to {args.out}")
        return 0
    except ImportError as exc:
        print(f'people.run: install requirements-people.txt first ({exc})', file=sys.stderr)
        return 1
    except (ValueError, OSError, RuntimeError) as exc:
        print(f'people.run: {exc}', file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
