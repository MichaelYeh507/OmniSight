"""Phase 1: person masks from A's extracted frames, in original depth coordinates.

    python -m people.masks people_out/001/frames --out people_out/001/detections

Every selected frame gets a mask, including all-zero masks for no detections.
Use extracted stride 1 or match A's fusion stride. Ghost lifting is Phase 2.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
import tempfile
from typing import Callable

import cv2
import numpy as np


def mask_from_result(result, shape: tuple[int, int], person_id: int) -> np.ndarray:
    """Union person instances from an Ultralytics result with retina_masks=True.

    Refuse padded mask coordinates instead of stretching them onto depth pixels.
    """
    if result.boxes is None:
        raise ValueError('segmentation result must contain detection boxes')
    classes = np.asarray(result.boxes.cls.cpu().numpy())
    if not len(classes):
        return np.zeros(shape, bool)
    if result.masks is None:
        raise ValueError('detections have no segmentation masks; use a -seg model')
    masks = np.asarray(result.masks.data.cpu().numpy())
    if masks.shape != (len(classes), *shape):
        raise ValueError('segmentation masks do not match image dimensions; require retina_masks=True')
    if not np.isfinite(masks).all():
        raise ValueError('segmentation masks contain nonfinite values')
    return np.any(masks[classes == person_id] > .5, axis=0)


class PersonSegmenter:
    """Lazy model dependency: common/ and fake scenes do not require PyTorch."""
    def __init__(self, model: str, confidence: float = .25, device: str = 'cpu'):
        if not np.isfinite(confidence) or not 0 < confidence <= 1:
            raise ValueError('confidence must be in (0, 1]')
        from ultralytics import YOLO
        self.model = YOLO(model)
        if self.model.task != 'segment':
            raise ValueError('use a segmentation checkpoint such as yolo11n-seg.pt')
        names = self.model.names
        items = names.items() if isinstance(names, dict) else enumerate(names)
        ids = [int(index) for index, name in items if name == 'person']
        if len(ids) != 1:
            raise ValueError('model must contain exactly one class named person')
        self.person_id = ids[0]
        self.confidence, self.device = confidence, device

    def __call__(self, bgr: np.ndarray) -> np.ndarray:
        results = self.model.predict(source=bgr, classes=[self.person_id], conf=self.confidence,
                                     device=self.device, retina_masks=True, verbose=False, save=False)
        if len(results) != 1:
            raise ValueError('expected one segmentation result per input frame')
        return mask_from_result(results[0], bgr.shape[:2], self.person_id)


def generate_masks(frames_dir: str | Path, out_dir: str | Path,
                   segmenter: Callable[[np.ndarray], np.ndarray], rotation: int = 0,
                   stride: int = 1) -> dict:
    """Run an upright-BGR -> bool-mask segmenter and save masks back in sensor axes.

    Rotation is clockwise degrees applied BEFORE inference. Output is always in
    original sensor orientation and resized to its matching depth PNG dimensions.
    Stride selects original numeric frame IDs, not positions in the extracted list.
    """
    root, out = Path(frames_dir), Path(out_dir)
    if out.exists():
        raise FileExistsError(f'{out} exists; choose a new mask output folder')
    if rotation not in (0, 90, 180, 270) or not isinstance(stride, int) or stride < 1:
        raise ValueError('rotation must be 0/90/180/270 and stride a positive integer')
    images = sorted((root / 'rgb').glob('*.png'))
    if not images:
        raise ValueError(f'no extracted RGB PNGs in {root / "rgb"}; run pipeline.extract first')
    if any(not re.fullmatch(r'\d{6}\.png', path.name) for path in images):
        raise ValueError('RGB filenames must preserve six-digit recording frame IDs')
    images = [path for path in images if int(path.stem) % stride == 0]
    if not images:
        raise ValueError('no extracted frames match the requested stride')
    for path in images:
        if not (root / 'depth' / path.name).is_file():
            raise ValueError(f'missing matching depth for {path.name}')
    out.parent.mkdir(parents=True, exist_ok=True)
    summary = dict(frames=len(images), frames_with_person=0, rotation_clockwise=rotation,
                   stride=stride, label='person', frame_ids=[])
    with tempfile.TemporaryDirectory(prefix='.masks_', dir=out.parent) as temp:
        stage = Path(temp) / 'output'
        (stage / 'masks').mkdir(parents=True)
        for path in images:
            image = cv2.imread(str(path), cv2.IMREAD_COLOR)
            depth = cv2.imread(str(root / 'depth' / path.name), cv2.IMREAD_UNCHANGED)
            if image is None or depth is None or depth.ndim != 2 or depth.dtype != np.uint16:
                raise ValueError(f'{path.name} requires a readable RGB image and uint16 depth')
            upright = np.ascontiguousarray(np.rot90(image, -(rotation // 90)))
            mask = np.asarray(segmenter(upright))
            if mask.shape != upright.shape[:2] or mask.dtype != np.bool_:
                raise ValueError('segmenter must return a bool mask matching the upright image')
            restored = np.ascontiguousarray(np.rot90(mask, rotation // 90), dtype=np.uint8)
            resized = cv2.resize(restored, (depth.shape[1], depth.shape[0]), interpolation=cv2.INTER_NEAREST) * 255
            if not cv2.imwrite(str(stage / 'masks' / path.name), resized):
                raise OSError(f'cannot write mask {path.name}')
            summary['frames_with_person'] += int(resized.any())
            summary['frame_ids'].append(int(path.stem))
        (stage / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        if out.exists():
            raise FileExistsError(f'{out} appeared during mask generation')
        stage.rename(out)
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('frames', type=Path, help='pipeline.extract output containing rgb/ and depth/')
    parser.add_argument('--out', type=Path, required=True, help='new output folder; masks are written under masks/')
    parser.add_argument('--model', default='people_out/models/yolo11n-seg.pt', help='segmentation checkpoint; downloaded on first use')
    parser.add_argument('--rotation', type=int, choices=[0, 90, 180, 270], default=0, help='clockwise rotation to make the image upright for inference')
    parser.add_argument('--stride', type=int, default=1, help='original-frame stride; default covers every extracted frame')
    parser.add_argument('--confidence', type=float, default=.25)
    parser.add_argument('--device', default='cpu', help='cpu, mps, or CUDA device supported by your installation')
    args = parser.parse_args(argv)
    try:
        if args.out.exists():
            raise FileExistsError(f'{args.out} exists; choose a new mask output folder')
        if not (args.frames / 'rgb').is_dir():
            raise ValueError('input needs an rgb/ directory from pipeline.extract')
        Path(args.model).parent.mkdir(parents=True, exist_ok=True)
        segmenter = PersonSegmenter(args.model, args.confidence, args.device)
        summary = generate_masks(args.frames, args.out, segmenter, args.rotation, args.stride)
        print(f'wrote {summary["frames"]} masks to {args.out / "masks"}; person detected in {summary["frames_with_person"]} frames')
        return 0
    except ImportError as exc:
        print(f'people.masks: install requirements-people.txt first ({exc})', file=sys.stderr)
        return 1
    except (ValueError, OSError, RuntimeError) as exc:
        print(f'people.masks: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
