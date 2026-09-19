"""Phase 1: stack two distant depth frames into a colored PLY without fusion."""
from __future__ import annotations

import argparse
from pathlib import Path
import sys
import numpy as np

from pipeline import loader, normalize
from pipeline.fuse import unproject


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('take', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--frames', type=int, nargs=2, help='two frame indices; default frame 0 and closest frame to 20 seconds')
    parser.add_argument('--camera-convention', choices=['arkit', 'opencv'], default='arkit')
    args = parser.parse_args(argv)
    try:
        if args.out.exists():
            raise FileExistsError(f'{args.out} exists; choose a new diagnostic output')
        rec = loader.load(args.take)
        selected = args.frames or [0, int(np.argmin(np.abs(rec.timestamps - 20)))]
        if len(set(selected)) != 2 or min(selected) < 0 or max(selected) >= rec.n_frames:
            raise ValueError(f'choose two distinct frame indices in 0..{rec.n_frames - 1}')
        poses = normalize.normalize_poses(normalize.camera_poses(rec.poses, args.camera_convention))
        vertices = []
        for index, rgb, depth, confidence in loader.iter_frames(rec):
            if index not in selected:
                continue
            keep = (confidence == 2) & (depth > .3) & (depth < 4.5)
            positions, pixels = unproject(depth, rec.intrinsics[index], poses[index], keep)
            if not len(positions):
                raise ValueError(f'frame {index} has no valid high-confidence points')
            vertices.append((positions, rgb.reshape(-1, 3)[pixels]))
        positions = np.concatenate([p for p, _ in vertices])
        colors = np.concatenate([c for _, c in vertices])
        write_ply(args.out, positions, colors)
        print(f'wrote {args.out}: frames {selected}, times {rec.timestamps[selected].tolist()}, {len(positions):,} points; inspect whether walls coincide')
        return 0
    except (ValueError, OSError) as exc:
        print(f'check_frames: {exc}', file=sys.stderr)
        return 1


def write_ply(path: Path, positions: np.ndarray, colors: np.ndarray) -> None:
    """Write binary little-endian PLY readable by Open3D, CloudCompare and MeshLab."""
    vertices = np.empty(len(positions), dtype=[('x', '<f4'), ('y', '<f4'), ('z', '<f4'), ('red', 'u1'), ('green', 'u1'), ('blue', 'u1')])
    for i, field in enumerate(('x', 'y', 'z')):
        vertices[field] = positions[:, i]
    for i, field in enumerate(('red', 'green', 'blue')):
        vertices[field] = colors[:, i]
    header = f'ply\nformat binary_little_endian 1.0\nelement vertex {len(vertices)}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n'
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream:
        stream.write(header.encode('ascii'))
        stream.write(vertices.tobytes())


if __name__ == '__main__':
    raise SystemExit(main())
