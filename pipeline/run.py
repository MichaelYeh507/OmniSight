"""One command turns a raw Stray Scanner recording into a scene folder. Owner: Dev A.

    python -m pipeline.run data/raw/<take> --out viewer/public/scenes/<scene> \
        --voxel 0.025 --wall-z -1.8 --stride 3 --masks people_out/<take>/masks

Steps: load -> normalize -> fuse -> export. See "Pipeline design notes" in the
master design doc. Sanity checks before handing a scene to B:

- Walls are flat and meet at right angles in a point cloud viewer.
- The first trajectory pose is the identity.
- Total points are within B's budget.
- No person-shaped smear where the teammate stood.
- ``node viewer/scripts/validate-scene.mjs <out>`` exits 0.
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m pipeline.run",
        description="Turn a raw Stray Scanner recording into an OmniSight scene folder.",
    )
    p.add_argument("take", type=Path, help="raw recording folder, e.g. data/raw/20260919_room_a_take3")
    p.add_argument("--out", type=Path, required=True, help="scene folder to write, e.g. viewer/public/scenes/room_a_take3")
    p.add_argument("--voxel", type=float, default=0.025, help="voxel size in meters for dedupe (default 0.025)")
    p.add_argument("--wall-z", type=float, default=-1.8, dest="wall_z", help="wall plane; points with z > wall_z go to alignment.bin")
    p.add_argument("--stride", type=int, default=3, help="use every stride-th frame (default 3)")
    p.add_argument("--masks", type=Path, default=None, help="folder of person masks from people/run.py (masks/NNNNNN.png)")
    p.add_argument("--source-id", type=int, default=0, dest="source_id", help="source id written into rgbs byte 4 (default 0)")
    p.add_argument("--label", default="Responder 1", help="source label for the manifest")
    return p


def main(argv: list[str] | None = None) -> int:
    from pipeline import export, fuse, loader, normalize

    args = build_parser().parse_args(argv)
    t0 = time.perf_counter()

    rec = loader.load(args.take)
    poses = normalize.normalize_poses(rec.poses)
    points = fuse.fuse(rec, poses, voxel=args.voxel, stride=args.stride, masks_dir=args.masks, source_id=args.source_id)
    export.export_scene(
        points,
        poses,
        rec.timestamps,
        args.out,
        wall_z=args.wall_z,
        scene_name=args.out.name,
        sources=[{"id": args.source_id, "label": args.label, "device": "iPhone 14 Pro, Stray Scanner"}],
        processing_seconds=time.perf_counter() - t0,
    )
    print(f"wrote {args.out} in {time.perf_counter() - t0:.1f} s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
