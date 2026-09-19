"""Fake scene generator in the real format. Owner: Dev C, first hour.

    python -m tools.make_fake_scene --out viewer/public/scenes/fake

Writes a complete scene folder so Dev B can build the viewer before any real data
exists. Validate it with ``node viewer/scripts/validate-scene.mjs viewer/public/scenes/fake``.

World frame: right-handed, Y up, metres, origin at the jig where the viewer stands,
looking along -Z (docs/CONTRACT.md).

Contents (docs/CONTRACT.md, clarification 6):

- ``wall_z`` (default -1.8): the wall plane between the viewer and the room.
- Box room 4 (x) by 3 (z) by 2.5 (y) metres directly behind the wall:
  x in [-2, 2], z in [wall_z - 3, wall_z], y in [floor_y, floor_y + 2.5], floor_y about
  -1.3. Sample points on the floor, ceiling, back wall, both side walls and the inside
  face of the front wall, at about one point per 2.5 cm; radius 0.0125; normals point
  into the room; a muted colour per surface with a faint 0.5 m grid so alignment
  errors are visible.
- Reveal: ``t_seen`` sweeps from 0 to ``--duration`` (20 s) across the room from the
  door side to the far side, so the map fills in as the replay runs. Bucket into
  0.5 s chunks ``chunks/0000.bin`` ... with ``common.omni_format.write_chunk``.
- ``alignment.bin``: the OUTSIDE face of the front wall (z slightly greater than
  ``wall_z``) plus a door-frame outline, so Dev B can test alignment mode.
- ``people.json`` + ``people.bin`` (``common.omni_format.write_people``): a capsule
  "person" 1.7 m tall, 0.25 m radius, about 2000 points per frame, 10 frames per
  second, walking in a straight line across the room, present ONLY during
  ``--person a:b`` (default 5:12), so the viewer's hold-and-fade can be tested after b.
- ``trajectory.json``: a straight-line walk from the origin through the door and along
  the room, 10 poses per second, first pose the identity, quaternions ``[x, y, z, w]``
  in the three.js camera convention (the camera looks along its own -Z).
- ``manifest.json``: version 1, scene "fake", duration, chunks list, alignment_chunk,
  wall_z, floor_y, sources ``[{"id": 0, "label": "Fake responder", "device":
  "make_fake_scene.py"}]``, processing_seconds.

``--points`` caps the total static point count (default 200000) by subsampling.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import json
import re
import sys
import tempfile
import time
import numpy as np
from common.omni_format import write_chunk, write_people


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m tools.make_fake_scene",
        description="Write a fake box room, person and trajectory in the OmniSight scene format.",
    )
    p.add_argument("--out", type=Path, default=Path("viewer/public/scenes/fake"), help="scene folder to write")
    p.add_argument("--points", type=int, default=200_000, help="cap on static points (default 200000)")
    p.add_argument("--duration", type=float, default=20.0, help="reveal duration in seconds (default 20)")
    p.add_argument("--person", default="5:12", help="a:b seconds during which the person is visible (default 5:12)")
    p.add_argument("--wall-z", type=float, default=-1.8, dest="wall_z", help="wall plane z (default -1.8)")
    p.add_argument("--floor-y", type=float, default=-1.3, dest="floor_y", help="floor height (default -1.3)")
    p.add_argument("--seed", type=int, default=0)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    started = time.perf_counter()
    try:
        if args.out.exists():
            raise FileExistsError(f'{args.out} exists; use a new scene name')
        if not re.fullmatch('[a-z0-9_]+', args.out.name):
            raise ValueError('scene folder must match [a-z0-9_]+')
        if args.points < 2 or not np.isfinite([args.duration, args.wall_z, args.floor_y]).all() or args.duration <= 0:
            raise ValueError('points must be at least 2; duration positive; all geometry parameters finite')
        start, end = map(float, args.person.split(':'))
        if not np.isfinite([start, end]).all() or not 0 <= start < end <= args.duration:
            raise ValueError('person interval must satisfy 0 <= start < end <= duration')
        rng = np.random.default_rng(args.seed)
        room, alignment = room_points(args.wall_z, args.floor_y)
        # Preserve both sides even for a tiny test budget. Sample without replacement.
        total = len(room['positions']) + len(alignment['positions'])
        if total > args.points:
            outside_budget = max(1, min(len(alignment['positions']), int(args.points * len(alignment['positions']) / total)))
            for cloud, budget in ((alignment, outside_budget), (room, args.points - outside_budget)):
                indices = np.sort(rng.choice(len(cloud['positions']), budget, replace=False))
                for key in cloud:
                    cloud[key] = cloud[key][indices]
        progress = np.clip((args.wall_z - room['positions'][:, 2]) / 3., 0, 1)
        last_time = np.nextafter(np.float32(args.duration), np.float32(0))
        room['t_seen'] = np.minimum(progress * args.duration, last_time).astype(np.float32)
        alignment['t_seen'] = np.zeros(len(alignment['positions']), np.float32)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.fake_', dir=args.out.parent) as temp:
            stage = Path(temp) / args.out.name
            (stage / 'chunks').mkdir(parents=True)
            chunks = []
            buckets = np.floor(room['t_seen'].astype(np.float64) / .5).astype(int)
            for bucket in np.unique(buckets):
                keep = buckets == bucket
                file = f'chunks/{bucket:04}.bin'
                t_start, t_end = float(bucket * .5), float((bucket + 1) * .5)
                count = write_chunk(stage / file, t_start, t_end, **{key: value[keep] for key, value in room.items()})
                chunks.append(dict(file=file, t_start=t_start, t_end=t_end, count=count))
            write_chunk(stage / 'alignment.bin', 0, .5, **alignment)
            write_people(stage, ghost_frames(start, end, args.wall_z, args.floor_y, rng))
            times = np.unique(np.append(np.arange(0, args.duration, .1), args.duration))
            trajectory = [dict(t=float(t), source=0, position=[0., 0., float((args.wall_z - 2) * t / args.duration)],
                               quaternion=[0., 0., 0., 1.]) for t in times]
            (stage / 'trajectory.json').write_text(json.dumps(trajectory, allow_nan=False) + '\n')
            manifest = dict(version=1, scene=args.out.name, duration=max(args.duration, chunks[-1]['t_end']),
                            chunks=chunks, alignment_chunk='alignment.bin', wall_z=args.wall_z, floor_y=args.floor_y,
                            sources=[{'id': 0, 'label': 'Fake responder', 'device': 'make_fake_scene.py'}],
                            processing_seconds=time.perf_counter() - started)
            (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2, allow_nan=False) + '\n')
            if args.out.exists():
                raise FileExistsError(f'{args.out} appeared during generation')
            stage.rename(args.out)
        print(f'wrote synthetic scene {args.out}: {len(room["positions"]) + len(alignment["positions"]):,} static points')
        return 0
    except (ValueError, OSError) as exc:
        print(f'make_fake_scene: {exc}', file=sys.stderr)
        return 1


def room_points(wall_z, floor_y):
    """Six sampled inward-facing surfaces and an outside wall with a door outline."""
    x = np.linspace(-2, 2, 161)
    y = np.linspace(floor_y, floor_y + 2.5, 101)
    z = np.linspace(wall_z - 3, wall_z, 121)
    points, normals, colors = [], [], []
    specs = [(0, -2, y, z, [1, 0, 0], [112, 131, 151]),
             (0, 2, y, z, [-1, 0, 0], [133, 151, 120]),
             (1, floor_y, x, z, [0, 1, 0], [142, 134, 120]),
             (1, floor_y + 2.5, x, z, [0, -1, 0], [161, 164, 170]),
             (2, wall_z - 3, x, y, [0, 0, 1], [143, 124, 152]),
             (2, wall_z, x, y, [0, 0, -1], [117, 143, 147])]
    for axis, fixed, a, b, normal, color in specs:
        aa, bb = np.meshgrid(a, b, indexing='ij')
        p = np.empty((aa.size, 3), np.float32)
        others = [i for i in range(3) if i != axis]
        p[:, axis], p[:, others[0]], p[:, others[1]] = fixed, aa.ravel(), bb.ravel()
        if axis == 2 and fixed == wall_z:
            doorway = (np.abs(p[:, 0]) < .5) & (p[:, 1] < floor_y + 2.)
            p = p[~doorway]
        grid = np.any(np.abs(p[:, others] * 2 - np.rint(p[:, others] * 2)) < .03, axis=1)
        rgb = np.tile(color, (len(p), 1)).astype(np.uint8)
        rgb[grid] = np.minimum(rgb[grid].astype(int) + 22, 255)
        points.append(p)
        normals.append(np.tile(normal, (len(p), 1)))
        colors.append(rgb)
    room = _cloud(np.concatenate(points), np.concatenate(normals), np.concatenate(colors))
    # Geometry is float32, JSON wall_z is a double in JS. Keep boundary points
    # just inside even when -1.8 rounds upward to -1.799999952 in the binary file.
    inside_z = np.nextafter(np.float32(wall_z), np.float32(-np.inf))
    room['positions'][:, 2] = np.minimum(room['positions'][:, 2], inside_z)
    outside = points[-1].copy()
    outside[:, 2] = wall_z + .03
    # Add a bright outline at the two jambs and lintel.
    door_y = np.linspace(floor_y, floor_y + 2, 81)
    door_x = np.linspace(-.5, .5, 41)
    outline = np.concatenate([np.column_stack((np.full(81, side), door_y, np.full(81, wall_z + .03))) for side in (-.5, .5)] +
                             [np.column_stack((door_x, np.full(41, floor_y + 2), np.full(41, wall_z + .03)))])
    outside = np.concatenate((outside, outline))
    rgb = np.tile([145, 153, 165], (len(outside), 1))
    rgb[-len(outline):] = [205, 191, 139]
    alignment = _cloud(outside, np.tile([0, 0, 1], (len(outside), 1)), rgb)
    return room, alignment


def _cloud(positions, normals, colors):
    n = len(positions)
    rgbs = np.zeros((n, 4), np.uint8)
    rgbs[:, :3] = colors
    return dict(positions=np.asarray(positions, np.float32), normals=np.asarray(normals, np.float32),
                radius=np.full(n, .0125, np.float32), t_seen=np.zeros(n, np.float32), rgbs=rgbs)


def ghost_frames(start, end, wall_z, floor_y, rng):
    """A 1.7 m capsule walking across the room, sampled at 10 Hz only while visible."""
    angles = rng.uniform(0, 2 * np.pi, 2000)
    base = np.empty((2000, 3), np.float32)
    base[:1200, 0] = .25 * np.cos(angles[:1200])
    base[:1200, 2] = .25 * np.sin(angles[:1200])
    base[:1200, 1] = rng.uniform(.25, 1.45, 1200)
    height = rng.uniform(0, 1, 800)
    radial = .25 * np.sqrt(1 - height ** 2)
    base[1200:, 0] = radial * np.cos(angles[1200:])
    base[1200:, 2] = radial * np.sin(angles[1200:])
    base[1200:1600, 1] = .25 - .25 * height[:400]
    base[1600:, 1] = 1.45 + .25 * height[400:]
    rgba = np.tile(np.array([255, 180, 50, 255], np.uint8), (2000, 1))
    for frame in range(int(np.ceil(start * 10)), int(np.ceil(end * 10))):
        t = frame / 10
        if not start <= t < end:
            continue
        translation = [-1.3 + 2.6 * (t - start) / (end - start), floor_y, wall_z - 1.5]
        yield dict(t=t, frame=frame, positions=(base + translation).astype(np.float32), rgba=rgba)


if __name__ == "__main__":
    raise SystemExit(main())
