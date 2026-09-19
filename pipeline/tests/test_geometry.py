import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from pipeline.normalize import normalize_poses, world_from_frame0
from pipeline.fuse import unproject


def test_unproject_uses_negative_z_and_returns_color_indices():
    depth = np.full((3, 3), 2., np.float32)
    depth[2, 2] = 0
    k = np.array([[2., 0, 1], [0, 2., 1], [0, 0, 1]])
    keep = np.zeros((3, 3), bool)
    keep[0, 0] = keep[1, 1] = keep[2, 2] = True
    points, indices = unproject(depth, k, np.eye(4), keep)
    np.testing.assert_allclose(points, [[-1, 1, -2], [0, 0, -2]])
    np.testing.assert_array_equal(indices, [0, 4])
    assert points.dtype == np.float32 and indices.dtype == np.int64


def test_pose_is_applied_once_and_invalid_depth_is_excluded():
    pose = np.eye(4)
    pose[:3, 3] = [3, 2, 1]
    points, indices = unproject(np.array([[2, np.nan, np.inf, -1]]), np.eye(3), pose)
    np.testing.assert_allclose(points, [[3, 2, -1]])
    np.testing.assert_array_equal(indices, [0])


def test_normalization_makes_first_pose_identity():
    poses = np.repeat(np.eye(4)[None], 2, axis=0)
    poses[:, :3, :3] = Rotation.from_euler('yx', [60, 15], degrees=True).as_matrix()
    poses[0, :3, 3] = [3, 2, 4]
    poses[1, :3, 3] = [3, 3, 4]
    normalized = normalize_poses(poses)
    np.testing.assert_allclose(normalized[0, :3, 3], 0, atol=1e-12)
    np.testing.assert_allclose(normalized[1], world_from_frame0(poses[0]) @ poses[1], atol=1e-12)
    np.testing.assert_allclose(normalized[0], np.eye(4), atol=1e-12)
    np.testing.assert_allclose(world_from_frame0(poses[0]) @ poses, normalized)


def test_level_initial_pose_becomes_identity():
    poses = np.eye(4)[None]
    poses[0, :3, :3] = Rotation.from_euler('y', 65, degrees=True).as_matrix()
    poses[0, :3, 3] = [4, 2, 3]
    np.testing.assert_allclose(normalize_poses(poses), np.eye(4)[None], atol=1e-12)


def test_vertical_start_is_a_valid_camera_basis():
    poses = np.eye(4)[None]
    poses[0, :3, :3] = Rotation.from_euler('x', 90, degrees=True).as_matrix()
    np.testing.assert_allclose(normalize_poses(poses), np.eye(4)[None], atol=1e-12)


def test_bad_intrinsics_fail_before_division():
    with pytest.raises(ValueError, match='intrinsics'):
        unproject(np.ones((2, 2)), np.zeros((3, 3)), np.eye(4))
