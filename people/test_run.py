import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from people.run import process_recording


class Segmenter:
    def __call__(self, bgr):
        mask = np.zeros(bgr.shape[:2], bool)
        mask[1:-1, 1:-1] = True
        return mask


def test_process_writes_masks_and_world_ghosts(make_recording, tmp_path):
    out = tmp_path / 'people'
    summary = process_recording(make_recording(count=2), out, Segmenter(), stride=1, max_points=7)
    assert summary['frames_processed'] == 2
    assert summary['frames_with_person'] == 2
    assert summary['ghost_points'] == 14
    assert sorted(path.name for path in (out / 'masks').glob('*.png')) == ['000000.png', '000001.png']
    index = json.loads((out / 'people.json').read_text())
    assert [entry['frame'] for entry in index] == [0, 1]
    assert [entry['count'] for entry in index] == [7, 7]
    assert [entry['offset'] for entry in index] == [0, 7 * 16]
    assert (out / 'people.bin').stat().st_size == 14 * 16
    assert all(np.asarray(entry['centroid'])[2] < 0 for entry in index)
    assert np.count_nonzero(cv2.imread(str(out / 'masks/000000.png'), cv2.IMREAD_UNCHANGED)) > 0


def test_erosion_removes_silhouette_edge(make_recording, tmp_path):
    class OnePixel:
        def __call__(self, bgr):
            mask = np.zeros(bgr.shape[:2], bool)
            mask[2, 2] = True
            return mask
    summary = process_recording(make_recording(count=1), tmp_path / 'people', OnePixel(), stride=1, max_points=100)
    assert summary['ghost_points'] == 0
    assert json.loads((tmp_path / 'people/people.json').read_text()) == []


def test_confidence_one_is_kept_and_zero_is_dropped(make_recording, tmp_path):
    root = make_recording(count=1)
    confidence = np.full((6, 8), 1, np.uint8)
    confidence[2:4, 2:4] = 0
    cv2.imwrite(str(root / 'confidence/000000.png'), confidence)
    summary = process_recording(root, tmp_path / 'people', Segmenter(), stride=1, max_points=100)
    assert summary['ghost_points'] == 4


def test_max_points_is_deterministic_and_positive(make_recording, tmp_path):
    root = make_recording(count=1)
    a = tmp_path / 'a'
    b = tmp_path / 'b'
    process_recording(root, a, Segmenter(), stride=1, max_points=5)
    process_recording(root, b, Segmenter(), stride=1, max_points=5)
    assert (a / 'people.bin').read_bytes() == (b / 'people.bin').read_bytes()
    with pytest.raises(ValueError, match='max_points'):
        process_recording(root, tmp_path / 'bad', Segmenter(), stride=1, max_points=0)


def test_missing_mask_like_segmenter_failure_does_not_publish(make_recording, tmp_path):
    out = tmp_path / 'people'
    out.mkdir()
    sentinel = out / 'sentinel'
    sentinel.write_bytes(b'keep')
    with pytest.raises(FileExistsError):
        process_recording(make_recording(count=1), out, Segmenter(), stride=1, max_points=5)


def test_no_person_frames_still_write_complete_masks_and_empty_people(make_recording, tmp_path):
    class Empty:
        def __call__(self, bgr): return np.zeros(bgr.shape[:2], bool)
    out = tmp_path / 'people'
    summary = process_recording(make_recording(count=2), out, Empty(), stride=1, max_points=5)
    assert summary['frames_processed'] == 2 and summary['frames_with_person'] == 0
    assert (out / 'people.bin').read_bytes() == b''
    assert json.loads((out / 'people.json').read_text()) == []
