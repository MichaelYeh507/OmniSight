import csv

import cv2
import numpy as np
import pytest


@pytest.fixture
def make_recording(tmp_path):
    """Write actual RGB video/16-bit depth/CSV, so loader tests exercise decoding."""
    def make(name='take', count=4, per_frame=True, video_count=None):
        root = tmp_path / name
        root.mkdir()
        (root / 'depth').mkdir()
        (root / 'confidence').mkdir()
        writer = cv2.VideoWriter(str(root / 'rgb.mp4'), cv2.VideoWriter_fourcc(*'mp4v'), 4, (32, 24))
        assert writer.isOpened(), 'Test platform needs MP4 encoding support'
        for i in range(count if video_count is None else video_count):
            rgb = np.zeros((24, 32, 3), np.uint8)
            rgb[:] = [10, 30, 200]  # OpenCV BGR; loaded RGB must be red-dominant.
            writer.write(rgb)
        writer.release()
        fields = ['timestamp', 'frame', 'x', 'y', 'z', 'qx', 'qy', 'qz', 'qw']
        if per_frame:
            fields += ['fx', 'fy', 'cx', 'cy']
        with (root / 'odometry.csv').open('w', newline='') as stream:
            output = csv.writer(stream)
            output.writerow(fields)
            for i in range(count):
                row = [100 + i * .25, i, 4, 2, 3, 0, 0, 0, 1]
                if per_frame:
                    row += [32 + i, 24, 16, 12]
                output.writerow(row)
                cv2.imwrite(str(root / 'depth' / f'{i:06}.png'), np.full((6, 8), 2000, np.uint16))
                cv2.imwrite(str(root / 'confidence' / f'{i:06}.png'), np.full((6, 8), 2, np.uint8))
        np.savetxt(root / 'camera_matrix.csv', [[32, 0, 16], [0, 24, 12], [0, 0, 1]], delimiter=',')
        return root
    return make
