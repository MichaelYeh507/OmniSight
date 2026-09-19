import json
import numpy as np
import pytest

from common.omni_format import read_chunk, read_people
from tools.make_fake_scene import main


def test_complete_fake_scene_fits_budget_and_contract(tmp_path):
    out = tmp_path / 'fake'
    assert main(['--out', str(out), '--points', '1200']) == 0
    manifest = json.loads((out / 'manifest.json').read_text())
    assert manifest['scene'] == 'fake' and manifest['duration'] == 20
    alignment = read_chunk(out / manifest['alignment_chunk'])
    assert alignment['n'] > 0
    assert np.all(alignment['positions'][:, 2] > manifest['wall_z'])
    chunks = [read_chunk(out / chunk['file']) for chunk in manifest['chunks']]
    assert alignment['n'] + sum(chunk['n'] for chunk in chunks) <= 1200
    starts = [chunk['t_start'] for chunk in chunks]
    assert starts == sorted(starts)
    assert len(chunks) > 1
    for entry, chunk in zip(manifest['chunks'], chunks):
        assert entry['count'] == chunk['n']
        # JS compares float32 geometry with JSON doubles. Avoid NumPy's scalar
        # coercion, which would hide a front-wall point rounded to the wrong side.
        assert np.all(chunk['positions'][:, 2].astype(np.float64) <= manifest['wall_z'])
        assert np.all(chunk['t_seen'] >= chunk['t_start'])
        assert np.all(chunk['t_seen'] < chunk['t_end'])
        np.testing.assert_array_equal(chunk['rgbs'][:, 3], 0)
    ghosts = read_people(out)
    assert len(ghosts) == 70
    assert all(5 <= ghost['t'] < 12 for ghost in ghosts)
    assert ghosts[0]['centroid'][0] < ghosts[-1]['centroid'][0]
    assert ghosts[0]['positions'][:, 1].min() >= manifest['floor_y'] - 1e-5
    assert ghosts[0]['positions'][:, 1].max() <= manifest['floor_y'] + 1.7 + 1e-5
    assert (out / 'people.bin').stat().st_size < 15_000_000
    assert np.all(ghosts[0]['rgba'][:, 3] == 255)
    trajectory = json.loads((out / 'trajectory.json').read_text())
    assert trajectory[0]['position'] == [0, 0, 0]
    assert trajectory[0]['quaternion'] == [0, 0, 0, 1]
    assert trajectory[-1]['t'] == 20


def test_fake_scene_deterministic_and_no_overwrite(tmp_path):
    a, b = tmp_path / 'a', tmp_path / 'b'
    for out in (a, b):
        assert main(['--out', str(out), '--points', '100', '--seed', '7']) == 0
    for file in a.rglob('*.bin'):
        assert file.read_bytes() == (b / file.relative_to(a)).read_bytes()
    assert main(['--out', str(a)]) == 1


@pytest.mark.parametrize('option', [['--points', '0'], ['--duration', 'nan'], ['--person', '12:5'], ['--person', '0:21'], ['--wall-z', 'inf']])
def test_invalid_fake_scene_does_not_create_output(tmp_path, option):
    out = tmp_path / 'fake'
    assert main(['--out', str(out), *option]) == 1
    assert not out.exists()


def test_fractional_person_window_has_unique_frames(tmp_path):
    out = tmp_path / 'fractional'
    assert main(['--out', str(out), '--points', '100', '--person', '5.05:5.65']) == 0
    ghosts = read_people(out)
    assert [ghost['frame'] for ghost in ghosts] == [51, 52, 53, 54, 55, 56]
    assert [ghost['t'] for ghost in ghosts] == [5.1, 5.2, 5.3, 5.4, 5.5, 5.6]
