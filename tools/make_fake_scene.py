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
    raise NotImplementedError(f"Dev C: see module docstring (writing {args.out})")


if __name__ == "__main__":
    raise SystemExit(main())
