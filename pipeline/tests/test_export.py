import json
import struct
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from common import omni_format
from pipeline.export import export_scene


def reference_writer(path, t_start, t_end, positions, normals, radius, t_seen, rgbs):
    """Independent TEST-ONLY contract writer until C's implementation is available."""
    n = len(positions)
    with open(path, 'wb') as stream:
        stream.write(struct.pack('<4sIIffI', b'OMNI', 1, n, t_start, t_end, 0))
        for array in (positions, normals, radius, t_seen):
            stream.write(np.asarray(array, dtype='<f4').tobytes())
        stream.write(np.asarray(rgbs, dtype=np.uint8).tobytes())
    return n


def sample_points():
    return dict(positions=np.array([[0, -1, -1], [1, -2, -2], [2, 0, -3]], np.float32),
                normals=np.tile([0., 0, 1], (3, 1)).astype(np.float32),
                radius=np.full(3, .02, np.float32), t_seen=np.array([0, .5, 1.1], np.float32),
                rgbs=np.array([[255, 0, 0, 0]] * 3, np.uint8))


def read_binary(path):
    data = path.read_bytes()
    magic, version, n, start, end, reserved = struct.unpack_from('<4sIIffI', data)
    assert (magic, version, reserved) == (b'OMNI', 1, 0)
    assert len(data) == 24 + n * 36
    position = np.frombuffer(data, '<f4', n * 3, 24).reshape(n, 3)
    time = np.frombuffer(data, '<f4', n, 24 + n * 28)
    rgb = np.frombuffer(data, np.uint8, n * 4, 24 + n * 32).reshape(n, 4)
    return n, start, end, position, time, rgb


def call_export(tmp_path, points=None):
    return export_scene(sample_points() if points is None else points, np.repeat(np.eye(4)[None], 3, axis=0),
                        np.array([0, .5, 1.1]), tmp_path / 'scene', -1.8, 'scene',
                        [{'id': 0, 'label': 'Responder 1', 'device': 'test'}], .2)


def test_wall_split_chunks_duration_and_trajectory(tmp_path, monkeypatch):
    monkeypatch.setattr(omni_format, 'write_chunk', reference_writer)
    manifest = call_export(tmp_path)
    scene = tmp_path / 'scene'
    assert json.loads((scene / 'manifest.json').read_text()) == manifest
    assert manifest['duration'] == 1.5
    assert manifest['floor_y'] == pytest.approx(-1.9)
    assert [chunk['t_start'] for chunk in manifest['chunks']] == [.5, 1.]
    for chunk in manifest['chunks']:
        n, start, end, positions, times, colors = read_binary(scene / chunk['file'])
        assert n == chunk['count'] == 1
        assert (start, end) == (chunk['t_start'], chunk['t_end'])
        assert np.all(positions[:, 2] <= -1.8)
        assert np.all((times >= start) & (times < end))
        np.testing.assert_array_equal(colors[:, 3], 0)
    assert read_binary(scene / 'alignment.bin')[0] == 1
    trajectory = json.loads((scene / 'trajectory.json').read_text())
    assert trajectory[0] == {'t': 0., 'source': 0, 'position': [0., 0., 0.], 'quaternion': [0., 0., 0., 1.]}
    assert len(trajectory) == 3
    assert not (scene / 'people.json').exists()  # C owns ghosts.


def test_does_not_overwrite_existing_scene_or_c_files(tmp_path, monkeypatch):
    monkeypatch.setattr(omni_format, 'write_chunk', reference_writer)
    call_export(tmp_path)
    ghost = tmp_path / 'scene/people.bin'
    ghost.write_bytes(b'owned by C')
    with pytest.raises(FileExistsError):
        call_export(tmp_path)
    assert ghost.read_bytes() == b'owned by C'


def test_shared_writer_failure_does_not_publish_partial_scene(tmp_path, monkeypatch):
    def unavailable(*args, **kwargs):
        raise NotImplementedError('Dev C writer pending')
    monkeypatch.setattr(omni_format, 'write_chunk', unavailable)
    with pytest.raises(NotImplementedError):
        call_export(tmp_path)
    assert not (tmp_path / 'scene').exists()


def test_empty_cloud_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(omni_format, 'write_chunk', reference_writer)
    with pytest.raises(ValueError, match='point|empty'):
        call_export(tmp_path, {key: value[:0] for key, value in sample_points().items()})


def test_actual_shared_writer_contract(tmp_path):
    # A's tests must never silently replace C's implementation for this integration check.
    try:
        call_export(tmp_path)
    except NotImplementedError:
        pytest.skip('Integration pending Dev C: common.omni_format.write_chunk is still a stub')
    assert read_binary(tmp_path / 'scene/alignment.bin')[0] == 1


def test_javascript_typed_array_consumer(tmp_path, monkeypatch):
    if shutil.which('node') is None:
        pytest.skip('Node is required for the JavaScript boundary check')
    monkeypatch.setattr(omni_format, 'write_chunk', reference_writer)
    call_export(tmp_path)
    subprocess.run(['node', str(Path(__file__).with_name('parse_chunk.mjs')),
                    str(tmp_path / 'scene/chunks/0001.bin')], check=True, capture_output=True, text=True)


def test_export_requires_first_source_zero(tmp_path, monkeypatch):
    monkeypatch.setattr(omni_format, 'write_chunk', reference_writer)
    points = sample_points()
    points['rgbs'][:, 3] = 7
    with pytest.raises(ValueError, match='first source'):
        export_scene(points, np.repeat(np.eye(4)[None], 3, axis=0), np.array([0, .5, 1.1]),
                     tmp_path / 'scene', -1.8, 'scene', [{'id': 7, 'label': 'Test', 'device': 'test'}], .1)
