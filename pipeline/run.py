"""One command turns a raw Stray Scanner recording into a scene folder. Owner: Dev A.

    python -m pipeline.run data/raw/<take> --out viewer/public/scenes/<scene> \
        --voxel 0.025 --wall-z -1.8 --stride 3 --masks people_out/<take>/masks

Steps: load -> normalize -> fuse -> export. See "Pipeline design notes" in the
master design doc. Sanity checks before handing a scene to B:

- Walls are flat and meet at right angles in a point cloud viewer.
- The first trajectory position and horizontal heading are zero (identity rotation
  only for a level initial camera; preserve pitch/roll to keep gravity aligned).
- Total points are within B's budget.
- No person-shaped smear where the teammate stood.
- ``node viewer/scripts/validate-scene.mjs <out>`` exits 0.
"""
from __future__ import annotations

import argparse
import time
import sys
import math
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m pipeline.run",
        description="Turn a raw Stray Scanner recording into an OmniSight scene folder.",
    )
    p.add_argument("take", type=Path, nargs='+', help="one or more recordings from the same physical jig")
    p.add_argument("--out", type=Path, required=True, help="scene folder to write, e.g. viewer/public/scenes/room_a_take3")
    p.add_argument("--voxel", type=float, default=0.025, help="voxel size in meters for dedupe (default 0.025)")
    p.add_argument("--wall-z", type=float, default=-1.8, dest="wall_z", help="wall plane; points with z > wall_z go to alignment.bin")
    p.add_argument("--stride", type=int, default=3, help="use every stride-th frame (default 3)")
    p.add_argument("--masks", type=Path, nargs='+', default=None, help="one mask folder per take, in take order; every selected frame must exist")
    p.add_argument("--source-id", type=int, default=0, dest="source_id", help="first source ID; must be 0 under the v1 scene contract")
    p.add_argument("--label", action='append', help="source label; repeat once per take, or omit for Responder N")
    p.add_argument('--camera-convention', choices=['arkit', 'opencv'], default='arkit', help='raw camera axes; verify with pipeline.check_frames before the first real export')
    p.add_argument('--max-points', type=int, default=800_000, help='viewer point budget including alignment; fail if exceeded (increase --voxel)')
    p.add_argument('--register', action='store_true', help='correct selected poses with depth ICP before fusion (slower, opt-in)')
    p.add_argument('--register-points', type=int, default=2000, dest='register_points', help='camera points sampled per frame for ICP')
    p.add_argument('--register-max-distance', type=float, default=0.25, dest='register_max_distance', help='ICP correspondence gate in meters')
    return p


def main(argv: list[str] | None = None) -> int:
    from pipeline import export, fuse, loader, normalize

    args = build_parser().parse_args(argv)
    t0 = time.perf_counter()

    try:
        if args.stride < 1 or args.max_points < 1 or args.register_points < 80 or not math.isfinite(args.voxel) or args.voxel <= 0 or not math.isfinite(args.wall_z) or not math.isfinite(args.register_max_distance) or args.register_max_distance <= 0:
            raise ValueError('stride, max-points and voxel must be positive; voxel and wall-z must be finite')
        if args.out.exists():
            raise FileExistsError(f'{args.out} exists; use a new scene folder')
        if not 0 <= args.source_id <= 256 - len(args.take):
            raise ValueError('source IDs must fit in 0..255')
        if args.source_id != 0:
            raise ValueError('the first source must have ID 0 per the scene contract')
        for name, values in [('masks', args.masks), ('label', args.label)]:
            if values is not None and len(values) != len(args.take):
                raise ValueError(f'provide one {name} per take, in take order')
        batches, all_poses, all_times, sources = [], {}, {}, []
        if args.masks is None:
            print('No person masks supplied: static map may contain people. Apply C’s masks before the Phase 3 handoff.', file=sys.stderr)
        for i, take in enumerate(args.take):
            source = args.source_id + i
            rec = loader.load(take)
            poses = normalize.normalize_poses(normalize.camera_poses(rec.poses, args.camera_convention))
            if args.register:
                from pipeline.register import register_recording
                poses, failures = register_recording(
                    rec, poses, stride=args.stride,
                    masks_dir=args.masks[i] if args.masks else None,
                    max_points=args.register_points,
                    max_correspondence=args.register_max_distance)
                if failures:
                    print(f'registration: {take}: kept odometry for {len(failures)} frame(s): {failures[:8]}', file=sys.stderr)
            batches.append(fuse.fuse(rec, poses, voxel=args.voxel, stride=args.stride,
                                    masks_dir=args.masks[i] if args.masks else None, source_id=source))
            all_poses[source], all_times[source] = poses[::args.stride], rec.timestamps[::args.stride]
            sources.append({'id': source, 'label': args.label[i] if args.label else f'Responder {i + 1}',
                            'device': 'iPhone 14 Pro, Stray Scanner'})
        points = fuse.merge_points(batches, args.voxel) if len(batches) > 1 else batches[0]
        count = len(points['positions'])
        if count > args.max_points:
            raise ValueError(f'{count:,} points exceed viewer budget {args.max_points:,}; increase --voxel and rerun')
        export.export_scene(points, all_poses, all_times, args.out, wall_z=args.wall_z,
                            scene_name=args.out.name, sources=sources, processing_seconds=time.perf_counter() - t0)
    except NotImplementedError:
        print('Dev C dependency pending: common.omni_format.write_chunk must be implemented before scene export. Phase 1 check_frames and extract commands work independently.', file=sys.stderr)
        return 1
    except (ValueError, OSError) as exc:
        print(f'pipeline: {exc}', file=sys.stderr)
        return 1
    print(f"wrote {args.out}: {count:,} points, {len(sources)} source(s), {time.perf_counter() - t0:.1f} s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
