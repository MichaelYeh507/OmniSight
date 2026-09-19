"""Round-trip test for common/omni_format.py. Owner: Dev C.

Run with ``pytest common``. These are required integration checks for A and B.
"""
import json

import numpy as np
import pytest

from common import omni_format as of


def _random_splats(n, rng):
    positions = rng.uniform(-3, 3, size=(n, 3)).astype(np.float32)
    normals = rng.normal(size=(n, 3)).astype(np.float32)
    normals /= np.linalg.norm(normals, axis=1, keepdims=True)
    radius = rng.uniform(0.005, 0.05, size=n).astype(np.float32)
    t_seen = np.sort(rng.uniform(0.0, 0.5, size=n)).astype(np.float32)
    rgbs = rng.integers(0, 256, size=(n, 4), dtype=np.uint8)
    rgbs[:, 3] = 0  # source_id
    return positions, normals, radius, t_seen, rgbs


def test_chunk_round_trip(tmp_path):
    rng = np.random.default_rng(0)
    n = 1234
    positions, normals, radius, t_seen, rgbs = _random_splats(n, rng)
    path = tmp_path / "0000.bin"

    assert of.write_chunk(path, 0.0, 0.5, positions, normals, radius, t_seen, rgbs) == n
    assert path.stat().st_size == of.chunk_size(n) == 24 + 36 * n
    with open(path, "rb") as f:
        assert f.read(4) == of.MAGIC

    c = of.read_chunk(path)
    assert c["version"] == of.VERSION
    assert c["n"] == n
    assert c["t_start"] == pytest.approx(0.0)
    assert c["t_end"] == pytest.approx(0.5)
    np.testing.assert_array_equal(c["positions"], positions)
    np.testing.assert_array_equal(c["normals"], normals)
    np.testing.assert_array_equal(c["radius"], radius)
    np.testing.assert_array_equal(c["t_seen"], t_seen)
    np.testing.assert_array_equal(c["rgbs"], rgbs)
    assert c["positions"].dtype == np.float32
    assert c["rgbs"].dtype == np.uint8


def test_empty_chunk(tmp_path):
    path = tmp_path / "empty.bin"
    z3 = np.zeros((0, 3), np.float32)
    z1 = np.zeros(0, np.float32)
    of.write_chunk(path, 1.0, 1.5, z3, z3, z1, z1, np.zeros((0, 4), np.uint8))
    assert path.stat().st_size == of.HEADER_SIZE
    assert of.read_chunk(path)["n"] == 0


def test_bad_magic_rejected(tmp_path):
    path = tmp_path / "bad.bin"
    path.write_bytes(b"NOPE" + bytes(20))
    with pytest.raises(ValueError):
        of.read_chunk(path)


def test_people_round_trip(tmp_path):
    rng = np.random.default_rng(1)
    frames = []
    for i, t in enumerate([12.4, 12.5, 12.6]):
        n = 100 + i
        frames.append(
            {
                "t": t,
                "frame": 372 + i,
                "positions": rng.uniform(-2, 2, size=(n, 3)).astype(np.float32),
                "rgba": rng.integers(0, 256, size=(n, 4), dtype=np.uint8),
            }
        )

    index = of.write_people(tmp_path, frames)

    with open(tmp_path / "people.json") as f:
        assert json.load(f) == index
    assert [e["t"] for e in index] == [12.4, 12.5, 12.6]
    expected_offset = 0
    for e, fr in zip(index, frames):
        n = len(fr["positions"])
        assert e["count"] == n
        assert e["offset"] == expected_offset
        np.testing.assert_allclose(e["centroid"], fr["positions"].mean(axis=0), atol=1e-5)
        expected_offset += of.BYTES_PER_GHOST_POINT * n
    assert (tmp_path / "people.bin").stat().st_size == expected_offset

    back = of.read_people(tmp_path)
    assert len(back) == len(frames)
    for b, fr in zip(back, frames):
        np.testing.assert_array_equal(b["positions"], fr["positions"])
        np.testing.assert_array_equal(b["rgba"], fr["rgba"])


@pytest.mark.parametrize('data', [b'', b'OMNI', of.HEADER_STRUCT.pack(b'OMNI', 2, 0, 0, .5, 0),
                                   of.HEADER_STRUCT.pack(b'OMNI', 1, 1, 0, .5, 0),
                                   of.HEADER_STRUCT.pack(b'OMNI', 1, 0, 0, .5, 0) + b'extra'])
def test_malformed_chunks_rejected(tmp_path, data):
    path = tmp_path / 'bad.bin'
    path.write_bytes(data)
    with pytest.raises(ValueError):
        of.read_chunk(path)


@pytest.mark.parametrize('field', ['positions', 'normals', 'radius', 't_seen', 'rgbs'])
def test_invalid_arrays_fail_without_creating_file(tmp_path, field):
    arrays = dict(zip(['positions', 'normals', 'radius', 't_seen', 'rgbs'], _random_splats(3, np.random.default_rng(1))))
    arrays[field] = arrays[field][:2]
    path = tmp_path / 'bad.bin'
    with pytest.raises(ValueError):
        of.write_chunk(path, 0, .5, **arrays)
    assert not path.exists()


def test_people_empty_and_zero_point_frames(tmp_path):
    index = of.write_people(tmp_path, [{'t': 1., 'frame': 3, 'positions': np.empty((0, 3)), 'rgba': np.empty((0, 4), np.uint8)}])
    assert index == []
    assert of.read_people(tmp_path) == []
    assert (tmp_path / 'people.bin').read_bytes() == b''


def test_people_offsets_and_truncation_rejected(tmp_path):
    frame = {'t': 1., 'frame': 3, 'positions': np.array([[1., 2., 3.]]), 'rgba': np.array([[1, 2, 3, 255]], np.uint8)}
    of.write_people(tmp_path, [frame])
    blob = tmp_path / 'people.bin'
    blob.write_bytes(blob.read_bytes()[:-1])
    with pytest.raises(ValueError):
        of.read_people(tmp_path)


def test_unsorted_ghosts_do_not_overwrite_existing_files(tmp_path):
    frame = {'t': 1., 'frame': 3, 'positions': np.array([[1., 2., 3.]]), 'rgba': np.array([[1, 2, 3, 255]], np.uint8)}
    of.write_people(tmp_path, [frame])
    before = (tmp_path / 'people.bin').read_bytes()
    with pytest.raises(ValueError):
        of.write_people(tmp_path, [dict(frame, t=2), frame])
    assert (tmp_path / 'people.bin').read_bytes() == before
