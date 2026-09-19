import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from pipeline.register import estimate_rigid_transform, icp_align, register_pose_sequence


def test_estimate_rigid_transform_recovers_rotation_and_translation():
    rng = np.random.default_rng(4)
    source = rng.normal(size=(80, 3))
    rotation = Rotation.from_euler('zyx', [12, -7, 4], degrees=True).as_matrix()
    translation = np.array([0.35, -0.12, 0.2])
    target = source @ rotation.T + translation

    transform = estimate_rigid_transform(source, target)
    recovered = source @ transform[:3, :3].T + transform[:3, 3]

    np.testing.assert_allclose(recovered, target, atol=1e-6)
    np.testing.assert_allclose(transform[3], [0, 0, 0, 1])


def test_icp_align_rejects_insufficient_correspondences():
    source = np.zeros((3, 3), dtype=np.float64)
    target = np.ones((3, 3), dtype=np.float64)
    with pytest.raises(ValueError, match='correspondences'):
        icp_align(source, target, max_iterations=2, min_pairs=10)


def test_icp_align_recovers_small_pose_error():
    rng = np.random.default_rng(8)
    target = rng.uniform(-1, 1, size=(500, 3))
    rotation = Rotation.from_euler('y', 3, degrees=True).as_matrix()
    translation = np.array([0.06, -0.02, 0.04])
    source = target @ rotation.T + translation

    correction, error, pairs = icp_align(source, target, max_iterations=30,
                                          max_correspondence=0.3, min_pairs=50)
    aligned = source @ correction[:3, :3].T + correction[:3, 3]

    assert pairs >= 50
    assert error < 0.01
    np.testing.assert_allclose(aligned, target, atol=0.02)


def test_register_pose_sequence_corrects_drifting_odometry():
    rng = np.random.default_rng(12)
    world = rng.uniform([-1, -1, -3], [1, 1, -1], size=(800, 3))
    true_poses = []
    raw_poses = []
    clouds = []
    for i in range(4):
        true = np.eye(4)
        true[:3, 3] = [i * 0.08, 0, 0]
        true_poses.append(true)
        raw = true.copy()
        raw[:3, 3] += [i * 0.03, 0, 0]  # accumulating odometry drift
        raw_poses.append(raw)
        clouds.append(world @ true[:3, :3] + (-true[:3, 3]))

    corrected, failures = register_pose_sequence(clouds, np.asarray(raw_poses),
                                                   max_correspondence=0.3, min_pairs=100)
    assert failures == []
    np.testing.assert_allclose(corrected[-1, :3, 3], true_poses[-1][:3, 3], atol=0.03)
