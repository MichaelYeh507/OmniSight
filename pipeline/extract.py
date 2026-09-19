"""Extract aligned depth-resolution RGB frames and geometry metadata for Dev C."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import tempfile
import cv2
import numpy as np

from pipeline import loader, normalize


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('take', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--stride', type=int, default=1, help='default 1 supplies every frame for both A and C strides')
    parser.add_argument('--camera-convention', choices=['arkit', 'opencv'], default='arkit')
    args = parser.parse_args(argv)
    try:
        if args.out.exists():
            raise FileExistsError(f'{args.out} exists; choose a new extraction folder')
        if args.stride < 1:
            raise ValueError('stride must be positive')
        rec = loader.load(args.take)
        poses = normalize.normalize_poses(normalize.camera_poses(rec.poses, args.camera_convention))
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.extract_', dir=args.out.parent) as temp:
            stage = Path(temp) / 'frames'
            for directory in ('rgb', 'depth', 'confidence'):
                (stage / directory).mkdir(parents=True)
            metadata = []
            for index, rgb, depth, confidence in loader.iter_frames(rec, args.stride):
                arrays = {'rgb': cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR),
                          'depth': np.rint(depth * 1000).astype(np.uint16), 'confidence': confidence}
                for directory, array in arrays.items():
                    if not cv2.imwrite(str(stage / directory / f'{index:06}.png'), array):
                        raise OSError(f'failed to write {directory} frame {index}')
                metadata.append({'frame': index, 't': float(rec.timestamps[index]),
                                 'intrinsics': rec.intrinsics[index].tolist(), 'pose': poses[index].tolist()})
            (stage / 'frames.json').write_text(json.dumps(metadata, allow_nan=False) + '\n')
            if args.out.exists():
                raise FileExistsError(f'{args.out} appeared during extraction')
            stage.rename(args.out)
        print(f'wrote {len(metadata)} aligned frames to {args.out}')
        return 0
    except (ValueError, OSError) as exc:
        print(f'extract: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
