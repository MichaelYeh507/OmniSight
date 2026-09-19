"""Person masks for A and ghost points for B. Owner: Dev C.

    python -m people.run data/raw/<take> --out people_out/<take> --stride 3 \
        --camera-convention opencv

Two jobs per selected frame:

Masks for A (``<out>/masks/NNNNNN.png``)
    1. Run a small pretrained segmentation model on each colour frame and keep the
       "person" class.
    2. If the video is rotated, rotate the frame upright before detection and rotate
       the mask back.
    3. Resize the mask to depth resolution (256 x 192) with nearest-neighbour and save
       it as an 8-bit PNG, 255 = person. A dilates these by a few pixels.
    Every selected frame gets a mask, including all-zero masks, so A never fails on a
    missing frame. Match A's fusion stride (or use stride 1) so every A-selected frame
    is covered.

Ghost points for B (``<out>/people.bin`` + ``<out>/people.json``)
    1. Erode the mask by one pixel, which removes flying pixels at the silhouette.
    2. Keep masked depth pixels with confidence 1 or 2.
    3. Unproject them with ``pipeline.fuse.unproject`` using A's normalized poses.
       Import it; do not reimplement it. Use the SAME ``--camera-convention`` as A.
    4. Append positions and colours (alpha 255) through
       ``common.omni_format.write_people``. Subsample per frame to keep ``people.bin``
       small (about 15 MB for a 60 s take).

Copy or symlink ``people.bin`` and ``people.json`` into the scene folder A writes.

Rules: the label is always "person". No identity, no threat level. The hold-and-fade
logic lives in the viewer; this stage only reports what was seen and when.
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m people.run",
        description="Write person masks for the pipeline and ghost points for the viewer.",
    )
    p.add_argument("take", type=Path, help="raw recording folder, e.g. data/raw/20260919_room_a_take3")
    p.add_argument("--out", type=Path, required=True, help="output folder, e.g. people_out/20260919_room_a_take3")
    p.add_argument("--stride", type=int, default=3, help="process every stride-th frame; match A's fusion stride (default 3)")
    p.add_argument("--model", default="yolo11n-seg.pt", help="ultralytics segmentation checkpoint")
    p.add_argument("--max-points", type=int, default=3000, dest="max_points", help="subsample cap per ghost frame")
    p.add_argument('--camera-convention', choices=['arkit', 'opencv'], default='arkit',
                   help='raw camera axes; MUST match the value A uses for this take')
    p.add_argument('--rotation', type=int, choices=[0, 90, 180, 270], default=0,
                   help='clockwise rotation to make the colour frame upright for detection')
    p.add_argument('--confidence', type=float, default=.25, help='segmentation confidence threshold')
    p.add_argument('--device', default='cpu', help='cpu, mps, or a CUDA device supported by your install')
    return p


def run(take, out, *, stride, model, max_points, camera_convention, rotation,
        confidence, device, segmenter=None) -> dict:
    """Write masks and ghost files for one recording. Returns a summary dict.

    ``segmenter`` is an upright-BGR -> bool-mask callable; the default builds a
    :class:`people.masks.PersonSegmenter`. Injecting one keeps the wiring testable
    without a model download.
    """
    from pipeline import loader, normalize
    from pipeline.fuse import unproject
    from common.omni_format import write_people

    if stride < 1:
        raise ValueError('stride must be a positive integer')
    if max_points < 1:
        raise ValueError('max-points must be a positive integer')
    out = Path(out)
    if out.exists():
        raise FileExistsError(f'{out} exists; choose a new output folder')

    rec = loader.load(take)
    poses = normalize.normalize_poses(normalize.camera_poses(rec.poses, camera_convention))
    if segmenter is None:
        from people.masks import PersonSegmenter
        segmenter = PersonSegmenter(model, confidence, device)

    turns = rotation // 90
    ghost_frames: list[dict] = []
    summary = dict(take=str(take), frames=0, frames_with_person=0, ghost_points=0,
                   stride=stride, camera_convention=camera_convention, rotation_clockwise=rotation,
                   label='person')

    out.parent.mkdir(parents=True, exist_ok=True)
    # Stage beside the destination so a mid-run failure never publishes partial masks
    # or a people index that points past the bytes we actually wrote.
    with tempfile.TemporaryDirectory(prefix='.people_', dir=out.parent) as temp:
        stage = Path(temp) / 'output'
        (stage / 'masks').mkdir(parents=True)
        for index, rgb, depth, confidence_frame in loader.iter_frames(rec, stride):
            summary['frames'] += 1
            # iter_frames yields RGB at depth resolution; the segmenter follows the
            # cv2/masks.py convention and expects BGR.
            bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            upright = np.ascontiguousarray(np.rot90(bgr, -turns))
            mask_up = np.asarray(segmenter(upright))
            if mask_up.shape != upright.shape[:2] or mask_up.dtype != np.bool_:
                raise ValueError('segmenter must return a bool mask matching the upright image')
            mask = np.ascontiguousarray(np.rot90(mask_up, turns))  # back to sensor/depth axes
            if mask.shape != depth.shape:
                raise ValueError('restored mask does not match depth dimensions')

            # Mask for A: every selected frame, 255 = person (all-zero when none).
            if not cv2.imwrite(str(stage / 'masks' / f'{index:06}.png'), mask.astype(np.uint8) * 255):
                raise OSError(f'cannot write mask {index:06}.png')
            if not mask.any():
                continue
            summary['frames_with_person'] += 1

            # Ghost points: erode one pixel to shed silhouette flying pixels, keep
            # confidence 1 or 2 depth, and lift with A's exact unprojection + poses.
            eroded = cv2.erode(mask.astype(np.uint8), np.ones((3, 3), np.uint8))
            keep = (eroded != 0) & (confidence_frame >= 1) & np.isfinite(depth) & (depth > .3) & (depth < 5.)
            if not keep.any():
                continue
            positions, pixels = unproject(depth, rec.intrinsics[index], poses[index], keep)
            if not len(positions):
                continue
            if len(positions) > max_points:  # even stride keeps the silhouette representative
                step = len(positions) // max_points
                positions, pixels = positions[::step][:max_points], pixels[::step][:max_points]
            rgba = np.empty((len(positions), 4), np.uint8)
            rgba[:, :3] = rgb.reshape(-1, 3)[pixels]
            rgba[:, 3] = 255
            ghost_frames.append(dict(t=float(rec.timestamps[index]), frame=int(index),
                                     positions=positions.astype(np.float32), rgba=rgba))
            summary['ghost_points'] += len(positions)

        write_people(stage, ghost_frames)
        if out.exists():
            raise FileExistsError(f'{out} appeared during the run')
        stage.rename(out)

    summary['bytes'] = (out / 'people.bin').stat().st_size
    return summary


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        summary = run(args.take, args.out, stride=args.stride, model=args.model,
                      max_points=args.max_points, camera_convention=args.camera_convention,
                      rotation=args.rotation, confidence=args.confidence, device=args.device)
    except ImportError as exc:
        print(f'people.run: install requirements-people.txt first ({exc})', file=sys.stderr)
        return 1
    except (ValueError, OSError, RuntimeError) as exc:
        print(f'people.run: {exc}', file=sys.stderr)
        return 1
    print(f"wrote {args.out}: {summary['frames']} masks "
          f"({summary['frames_with_person']} with a person), "
          f"{summary['ghost_points']:,} ghost points, {summary['bytes'] / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
