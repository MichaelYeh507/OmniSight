import cv2
import numpy as np
import pytest
import shutil
import subprocess

from pipeline.loader import load, iter_frames


def test_load_per_frame_intrinsics_and_recording_time(make_recording):
    rec = load(make_recording())
    assert rec.n_frames == 4
    np.testing.assert_allclose(rec.timestamps, [0, .25, .5, .75])
    np.testing.assert_allclose(rec.intrinsics[0], [[8, 0, 4], [0, 6, 3], [0, 0, 1]])
    assert rec.intrinsics[1, 0, 0] == pytest.approx(8.25)
    np.testing.assert_allclose(rec.poses[0, :3, 3], [4, 2, 3])


def test_legacy_intrinsics_and_sequential_stride(make_recording):
    rec = load(make_recording(per_frame=False))
    frames = list(iter_frames(rec, stride=2))
    assert [f[0] for f in frames] == [0, 2]
    _, rgb, depth, confidence = frames[0]
    assert rgb.shape == (6, 8, 3) and rgb[0, 0, 0] > 180 and rgb[0, 0, 2] < 30
    np.testing.assert_allclose(depth, 2)
    assert depth.dtype == np.float32
    np.testing.assert_array_equal(confidence, 2)


def test_missing_depth_frame_is_not_silently_shifted(make_recording):
    root = make_recording()
    (root / 'depth/000001.png').unlink()
    with pytest.raises(ValueError, match='depth'):
        load(root)


@pytest.mark.parametrize('video_count', [3, 5])
def test_video_count_mismatch_detected_even_on_skipped_frames(make_recording, video_count):
    with pytest.raises(ValueError, match='video|RGB'):
        list(iter_frames(load(make_recording(video_count=video_count)), stride=3))


def test_invalid_confidence_rejected(make_recording):
    root = make_recording()
    cv2.imwrite(str(root / 'confidence/000001.png'), np.full((6, 8), 255, np.uint8))
    with pytest.raises(ValueError, match='confidence'):
        list(iter_frames(load(root)))


def test_duplicate_timestamps_rejected(make_recording):
    root = make_recording()
    path = root / 'odometry.csv'
    path.write_text(path.read_text().replace('100.25', '100.0'))
    with pytest.raises(ValueError, match='timestamp'):
        load(root)


def test_stride_must_be_positive(make_recording):
    with pytest.raises(ValueError, match='stride'):
        list(iter_frames(load(make_recording()), stride=0))


def test_mp4_edit_list_does_not_discard_first_capture_frame(make_recording):
    if shutil.which('ffmpeg') is None:
        pytest.skip('ffmpeg is needed to generate an MP4 with a negative-time capture frame')
    root = make_recording(per_frame=False)
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                    'color=c=red:s=32x24:r=4:d=1', '-vf', 'setpts=PTS-0.25/TB',
                    '-fps_mode', 'passthrough', '-c:v', 'libx264', '-bf', '0',
                    '-avoid_negative_ts', 'disabled', '-y', str(root / 'rgb.mp4')], check=True)
    frames = list(iter_frames(load(root)))
    assert [frame[0] for frame in frames] == [0, 1, 2, 3]
