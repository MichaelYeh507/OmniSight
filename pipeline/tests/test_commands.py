import json
import struct

import numpy as np
import pytest

from common import omni_format
from pipeline import run
from pipeline.fuse import merge_points, voxel_keys
from pipeline.normalize import camera_poses
from pipeline.tests.test_export import reference_writer, sample_points


def test_cli_uses_shared_writer_and_processed_trajectory(make_recording, tmp_path, monkeypatch):
    monkeypatch.setattr(omni_format, 'write_chunk', reference_writer)
    take = make_recording(per_frame=False)
    out = tmp_path / 'scene'
    assert run.main([str(take), '--out', str(out), '--stride', '2']) == 0
    trajectory = json.loads((out / 'trajectory.json').read_text())
    assert [entry['t'] for entry in trajectory] == [0, .5]
    assert json.loads((out / 'manifest.json').read_text())['chunks'][0]['count'] == 24


def test_point_budget_fails_without_publishing(make_recording, tmp_path, monkeypatch):
    monkeypatch.setattr(omni_format, 'write_chunk', reference_writer)
    out = tmp_path / 'scene'
    assert run.main([str(make_recording()), '--out', str(out), '--max-points', '2']) == 1
    assert not out.exists()


def test_cli_explains_shared_dependency(make_recording, tmp_path, monkeypatch, capsys):
    def pending(*args, **kwargs):
        raise NotImplementedError('Dev C writer')
    monkeypatch.setattr(omni_format, 'write_chunk', pending)
    assert run.main([str(make_recording()), '--out', str(tmp_path / 'scene')]) == 1
    assert 'common.omni_format.write_chunk' in capsys.readouterr().err
    assert not (tmp_path / 'scene').exists()


def test_multi_source_cli_keeps_source_ids_and_time_order(make_recording, tmp_path, monkeypatch):
    monkeypatch.setattr(omni_format, 'write_chunk', reference_writer)
    first, second = make_recording('a'), make_recording('b')
    out = tmp_path / 'combined'
    assert run.main([str(first), str(second), '--out', str(out), '--stride', '1']) == 0
    manifest = json.loads((out / 'manifest.json').read_text())
    assert [s['id'] for s in manifest['sources']] == [0, 1]
    trajectory = json.loads((out / 'trajectory.json').read_text())
    assert len(trajectory) == 8
    assert [e['t'] for e in trajectory] == sorted(e['t'] for e in trajectory)


def test_merge_chooses_earliest_source_not_input_order():
    first = sample_points()
    second = {k: v.copy() for k, v in first.items()}
    first['t_seen'][:] = 1
    second['t_seen'][:] = .25
    second['rgbs'][:, 3] = 1
    merged = merge_points([first, second], .025)
    assert len(merged['positions']) == 3
    np.testing.assert_array_equal(merged['rgbs'][:, 3], 1)
    np.testing.assert_allclose(merged['t_seen'], .25)


def test_voxel_keys_negative_coordinates_and_overflow():
    keys = voxel_keys(np.array([[-.01, 0, 0], [0, 0, 0], [0, -.01, 0], [0, 0, -.01]]), .025)
    assert len(np.unique(keys)) == 4
    with pytest.raises(ValueError, match='21-bit'):
        voxel_keys(np.array([[1e10, 0, 0]]), .025)


def test_explicit_opencv_conversion():
    raw = np.diag([1., -1., -1., 1.])[None]
    np.testing.assert_allclose(camera_poses(raw, 'opencv'), np.eye(4)[None])


def test_two_frame_ply_and_extraction_work_without_common(make_recording, tmp_path):
    from pipeline.check_frames import main as check_frames
    from pipeline.extract import main as extract
    take = make_recording(per_frame=False)
    ply = tmp_path / 'stack.ply'
    assert check_frames([str(take), '--out', str(ply), '--frames', '0', '3']) == 0
    data = ply.read_bytes()
    header, body = data.split(b'end_header\n', 1)
    assert b'element vertex 96' in header  # Full 6 x 8 frames, no voxel dedupe.
    assert len(body) == 96 * 15
    assert struct.unpack_from('<fff', body)[2] == -2
    out = tmp_path / 'frames'
    assert extract([str(take), '--out', str(out), '--stride', '2']) == 0
    assert sorted(p.name for p in (out / 'rgb').glob('*.png')) == ['000000.png', '000002.png']
    metadata = json.loads((out / 'frames.json').read_text())
    assert [frame['t'] for frame in metadata] == [0, .5]
    np.testing.assert_allclose(metadata[0]['pose'], np.eye(4))
    assert (out / 'depth/000002.png').exists()


def test_diagnostic_rejects_missing_second_frame(make_recording, tmp_path):
    from pipeline.check_frames import main as check_frames
    out = tmp_path / 'stack.ply'
    assert check_frames([str(make_recording()), '--out', str(out), '--frames', '0', '600']) == 1
    assert not out.exists()


def test_first_source_must_be_zero(make_recording, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(omni_format, 'write_chunk', reference_writer)
    out = tmp_path / 'scene'
    assert run.main([str(make_recording()), '--out', str(out), '--source-id', '7']) == 1
    assert 'first source' in capsys.readouterr().err
    assert not out.exists()
