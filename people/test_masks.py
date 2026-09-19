from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from people.masks import generate_masks, mask_from_result


class Tensor:
    def __init__(self, array):
        self.array = np.asarray(array)
    def cpu(self):
        return self
    def numpy(self):
        return self.array


def test_keep_only_person_masks_and_union_instances():
    masks = np.zeros((3, 4, 6), np.float32)
    masks[0, 0, 0] = 1
    masks[1, 2, 3] = 1  # non-person object must not erase static geometry
    masks[2, 3, 5] = 1
    result = SimpleNamespace(boxes=SimpleNamespace(cls=Tensor([0, 2, 0])), masks=SimpleNamespace(data=Tensor(masks)))
    mask = mask_from_result(result, (4, 6), person_id=0)
    assert mask.dtype == np.bool_
    assert mask.sum() == 2 and mask[0, 0] and mask[3, 5]


def test_no_detection_is_an_explicit_empty_mask():
    result = SimpleNamespace(boxes=SimpleNamespace(cls=Tensor([])), masks=None)
    assert not mask_from_result(result, (4, 6), person_id=0).any()


def test_detection_without_segmentation_fails():
    result = SimpleNamespace(boxes=SimpleNamespace(cls=Tensor([0])), masks=None)
    with pytest.raises(ValueError, match='segmentation'):
        mask_from_result(result, (4, 6), person_id=0)


def test_padded_masks_cannot_silently_shift_pixels():
    result = SimpleNamespace(boxes=SimpleNamespace(cls=Tensor([0])), masks=SimpleNamespace(data=Tensor(np.ones((1, 8, 8)))))
    with pytest.raises(ValueError, match='retina_masks'):
        mask_from_result(result, (4, 6), person_id=0)


def extracted_frames(tmp_path):
    root = tmp_path / 'frames'
    (root / 'rgb').mkdir(parents=True)
    (root / 'depth').mkdir()
    for i in (0, 3, 6):
        image = np.zeros((8, 12, 3), np.uint8)
        if i != 3:
            image[2:6, 2:6, 2] = 255
        cv2.imwrite(str(root / 'rgb' / f'{i:06}.png'), image)
        cv2.imwrite(str(root / 'depth' / f'{i:06}.png'), np.full((4, 6), 2000, np.uint16))
    return root


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_masks_rotate_back_resize_and_preserve_frame_ids(tmp_path, rotation):
    root = extracted_frames(tmp_path)
    out = tmp_path / 'people'
    # Analytic pixel segmenter verifies image transforms independently of ML weights.
    summary = generate_masks(root, out, lambda bgr: bgr[:, :, 2] > 100, rotation=rotation)
    assert summary['frames'] == 3 and summary['frames_with_person'] == 2
    assert sorted(path.name for path in (out / 'masks').glob('*.png')) == ['000000.png', '000003.png', '000006.png']
    mask = cv2.imread(str(out / 'masks/000000.png'), cv2.IMREAD_UNCHANGED)
    expected = np.zeros((4, 6), np.uint8)
    expected[1:3, 1:3] = 255
    np.testing.assert_array_equal(mask, expected)
    assert not cv2.imread(str(out / 'masks/000003.png'), cv2.IMREAD_UNCHANGED).any()
    with pytest.raises(FileExistsError):
        generate_masks(root, out, lambda bgr: bgr[:, :, 2] > 100)


def test_failed_inference_does_not_publish_partial_masks(tmp_path):
    root = extracted_frames(tmp_path)
    out = tmp_path / 'people'
    def fail(image):
        raise RuntimeError('inference failed')
    with pytest.raises(RuntimeError):
        generate_masks(root, out, fail)
    assert not out.exists()


def test_missing_matching_depth_fails_before_inference(tmp_path):
    root = extracted_frames(tmp_path)
    (root / 'depth/000003.png').unlink()
    with pytest.raises(ValueError, match='depth'):
        generate_masks(root, tmp_path / 'people', lambda bgr: np.zeros(bgr.shape[:2], bool))
