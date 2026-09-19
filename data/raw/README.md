# data/raw

Raw Stray Scanner recordings live here and are **gitignored**. Share them through the team Drive folder.

Naming: `data/raw/<date>_<room>_take<N>/`, for example `data/raw/20260919_room_a_take3/`.

Each take is the folder Stray Scanner exports: `rgb.mp4`, `depth/`, `confidence/`, `odometry.csv`, `camera_matrix.csv`, `imu.csv`.

Process a take straight away: `python -m pipeline.run data/raw/<take> --out viewer/public/scenes/<scene> --voxel 0.025 --wall-z -1.8 --stride 3`
