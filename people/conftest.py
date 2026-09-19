import csv

import cv2
import numpy as np
import pytest


@pytest.fixture
def make_recording(tmp_path):
    def make(name='take', count=2):
        root = tmp_path / name
        root.mkdir()
        (root / 'depth').mkdir()
        (root / 'confidence').mkdir()
        writer = cv2.VideoWriter(str(root / 'rgb.mp4'), cv2.VideoWriter_fourcc(*'mp4v'), 4, (32, 24))
        assert writer.isOpened()
        for _ in range(count):
            writer.write(np.full((24, 32, 3), [10, 30, 200], np.uint8))
        writer.release()
        with (root / 'odometry.csv').open('w', newline='') as stream:
            output = csv.writer(stream)
            output.writerow(['timestamp', 'frame', 'x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'fx', 'fy', 'cx', 'cy'])
            for i in range(count):
                output.writerow([100 + i * .25, i, 4, 2, 3, 0, 0, 0, 1, 32, 24, 16, 12])
                cv2.imwrite(str(root / 'depth' / f'{i:06}.png'), np.full((6, 8), 2000, np.uint16))
                cv2.imwrite(str(root / 'confidence' / f'{i:06}.png'), np.full((6, 8), 2, np.uint8))
        np.savetxt(root / 'camera_matrix.csv', [[32, 0, 16], [0, 24, 12], [0, 0, 1]], delimiter=',')
        return root
    return make
