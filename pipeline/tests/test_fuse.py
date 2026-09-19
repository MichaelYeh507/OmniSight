import cv2
import numpy as np
import pytest

from pipeline.loader import load
from pipeline.normalize import normalize_poses
from pipeline.fuse import fuse, unproject


def test_repeated_plane_is_deduped_and_first_observation_wins(make_recording):
    rec = load(make_recording(per_frame=False))
    points = fuse(rec, normalize_poses(rec.poses), stride=1, source_id=7)
    assert len(points['positions']) == 24  # Interior 4 x 6 pixels, no fabricated normals at border.
    np.testing.assert_allclose(points['positions'][:, 2], -2)
    np.testing.assert_allclose(points['normals'], np.tile([0, 0, 1], (24, 1)))
    np.testing.assert_allclose(points['radius'], .25)
    np.testing.assert_array_equal(points['t_seen'], 0)
    np.testing.assert_array_equal(points['rgbs'][:, 3], 7)
    assert points['rgbs'][0, 0] > 180


def test_masks_dilate_and_exclude_people(make_recording, tmp_path):
    rec = load(make_recording(per_frame=False))
    masks = tmp_path / 'masks'
    masks.mkdir()
    for i in range(rec.n_frames):
        mask = np.zeros((6, 8), np.uint8)
        mask[3, 4] = 255
        cv2.imwrite(str(masks / f'{i:06}.png'), mask)
    points = fuse(rec, normalize_poses(rec.poses), stride=1, masks_dir=masks)
    assert 0 < len(points['positions']) < 24
    center, _ = unproject(np.full((6, 8), 2.), rec.intrinsics[0], np.eye(4))
    assert not np.any(np.all(np.isclose(points['positions'], center[3 * 8 + 4]), axis=1))


def test_missing_mask_is_actionable_instead_of_person_smear(make_recording, tmp_path):
    rec = load(make_recording())
    masks = tmp_path / 'masks'
    masks.mkdir()
    with pytest.raises(ValueError, match='mask.*000000|000000.*mask'):
        fuse(rec, normalize_poses(rec.poses), masks_dir=masks)


def test_confidence_range_and_depth_edges_are_removed(make_recording):
    root = make_recording(count=1)
    depth = np.full((6, 8), 2000, np.uint16)
    depth[2, 2] = 4000
    depth[3, 4] = 5000
    depth[1, 5] = 200
    confidence = np.full((6, 8), 2, np.uint8)
    confidence[4, 6] = 1
    cv2.imwrite(str(root / 'depth/000000.png'), depth)
    cv2.imwrite(str(root / 'confidence/000000.png'), confidence)
    rec = load(root)
    points = fuse(rec, normalize_poses(rec.poses), stride=1)
    assert 0 < len(points['positions']) < 24
    np.testing.assert_allclose(points['positions'][:, 2], -2)
    assert np.all(np.isfinite(points['normals']))


@pytest.mark.parametrize('kwargs', [{'voxel': 0}, {'voxel': float('nan')}, {'source_id': 256}, {'source_id': -1}, {'stride': 0}])
def test_invalid_fusion_options(make_recording, kwargs):
    rec = load(make_recording())
    with pytest.raises(ValueError):
        fuse(rec, normalize_poses(rec.poses), **kwargs)


def test_empty_valid_frame_has_well_shaped_arrays(make_recording):
    root = make_recording(count=1)
    cv2.imwrite(str(root / 'confidence/000000.png'), np.zeros((6, 8), np.uint8))
    rec = load(root)
    points = fuse(rec, normalize_poses(rec.poses))
    assert points['positions'].shape == (0, 3)
    assert points['rgbs'].shape == (0, 4)


def test_two_camera_positions_reconstruct_same_plane(make_recording):
    rec = load(make_recording(count=2, per_frame=False))
    poses = normalize_poses(rec.poses)
    poses[1, 2, 3] = -.5
    cv2.imwrite(str(rec.depth_dir / '000001.png'), np.full((6, 8), 1500, np.uint16))
    points = fuse(rec, poses, stride=1)
    np.testing.assert_allclose(points['positions'][:, 2], -2)
    assert np.any(points['t_seen'] > 0)
