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
from pathlib import Path


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
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    raise NotImplementedError(f"Dev C: see module docstring ({args.take} -> {args.out})")


if __name__ == "__main__":
    raise SystemExit(main())
