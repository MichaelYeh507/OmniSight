# Dev A: recording pipeline

This directory implements Dev A's lane from the master design document. Dev B owns
the viewer; Dev C owns `common/`, `people/`, `tools/`, and the frozen contract.
The skeleton's public function signatures are preserved.

Run commands from the repository root with Python 3.10+:

```bash
python -m pip install -r requirements.txt
python -m pytest pipeline/tests -q
```

The pipeline itself needs NumPy, SciPy and OpenCV. Open3D from the root requirements
is useful for inspecting PLYs but isn't imported by the processing path.

## Phase 1: prove geometry and hand frames to C

1. Transfer a real recording to `data/raw/<take>/` (already gitignored).
2. Stack the initial frame and one approximately 20 seconds later:

```bash
python -m pipeline.check_frames data/raw/<take> --out /tmp/two_frames.ply
# Or choose explicit frame indices:
python -m pipeline.check_frames data/raw/<take> --out /tmp/two_frames_600.ply --frames 0 600
```

The PLY contains both point clouds without voxel deduplication, so alignment errors
remain visible. Open it in Open3D, CloudCompare or MeshLab and verify walls coincide.
Default camera axes are ARKit: -Z forward, +Y up, camera-to-world poses. The upstream
format specification does not pin pose axes, and its old integration example uses an
older file layout. **Validate the convention on a real recording before handing off.**
If it uses OpenCV camera axes, run with `--camera-convention opencv`; use the same
option for every A/C stage. This rotates camera axes, not world gravity, and does not
invert poses. Neither a synthetic test nor an exported PLY proves real-world alignment.

```bash
python -m pipeline.extract data/raw/<take> --out people_out/<take>/frames
```

Extraction writes depth-resolution RGB PNGs, original-scale uint16 millimeter depth,
confidence PNGs, and `frames.json` entries containing `frame`, relative `t`, scaled
`intrinsics`, and normalized camera-to-world `pose`. Frame filenames retain original
indices, including when `--stride` skips frames. RGB stays in sensor orientation to
match depth; C can rotate for detection and rotate masks back. For full-resolution
segmentation C can decode the original video; the shared loader yields resized RGB.
These outputs are not substitutes for raw Stray Scanner recordings.

C can also import the pipeline directly:

```python
from pipeline.loader import load, iter_frames
from pipeline.normalize import camera_poses, normalize_poses
from pipeline.fuse import unproject

rec = load("data/raw/<take>")
poses = normalize_poses(camera_poses(rec.poses, "arkit"))
for frame, rgb, depth_m, confidence in iter_frames(rec, stride=1):
    # C supplies its eroded person mask at the same depth resolution.
    keep = person_masks[frame] & (confidence >= 1)
    positions, pixel_index = unproject(depth_m, rec.intrinsics[frame], poses[frame], keep)
    colors = rgb.reshape(-1, 3)[pixel_index]
    t = float(rec.timestamps[frame])
```

`unproject(depth_m, K_depth, T_world_cam, keep_mask=None)` returns float32 `(N, 3)`
world positions and int64 `(N,)` row-major pixel indices. It removes nonfinite and
nonpositive depth and performs the OpenCV-depth-to-three.js camera conversion once.
Do not flip Y/Z again in C. Depth is **meters** here, not PNG millimeters.

`load` returns recording-relative timestamps starting at zero. It prefers per-frame
intrinsics; legacy files without those columns use `camera_matrix.csv`. X and Y
intrinsics are scaled using actual video and depth dimensions. `iter_frames` decodes
sequentially and validates all frame counts, including skipped frames. Consumers must
exhaust the iterator to validate the video tail; all A commands do so.

The loader uses OpenCV's FFmpeg backend and ignores MP4 playback edit lists. Some
Stray Scanner files mark the first captured RGB frame as preceding playback time
zero; ordinary playback skips it even though its depth and pose are present. We
decode all encoded samples to preserve frame correspondence and still reject actual
count mismatches. Raw files are not modified.

## Phase 2: scene handoff to B

Requires C's existing `common.omni_format.write_chunk` implementation. A imports that
writer directly with the pinned signature; there is no production fallback writer.
If C hasn't implemented it, processing exits with an explicit dependency message and
does not publish a partial scene.

```bash
python -m pipeline.run data/raw/<take> \
  --out viewer/public/scenes/room_a_take1 \
  --voxel 0.025 --wall-z -1.8 --stride 3
```

Output names must match `[a-z0-9_]+`. Use a **new output folder** for each export;
existing scenes are refused so a rerun cannot invalidate or overwrite C's ghosts.
Output is staged and renamed only after successful export. A writes:

- `manifest.json`: version 1, source metadata, wall plane, fifth-percentile floor,
  duration, chunks and actual processing time.
- `chunks/NNNN.bin`: new static splats in nonempty half-second windows, sorted by time.
- `alignment.bin`: only points with `z > wall_z`, including a header-only file if empty.
- `trajectory.json`: one pose per processed frame, ascending time, source ID,
  `[x, y, z, w]` rotation in three.js camera convention.

Normals face the observing camera. Radius is `max(depth / fx, voxel / 2)`. The fourth
color byte is **source ID, not alpha**. First observation wins in each voxel; repeated
observations do not refresh surface age. Duration is the maximum chunk end or
processed trajectory time, following the proposed contract clarification.

After C adds the matching `people.json` and `people.bin`, run B's validator when it
lands in the repo:

```bash
node viewer/scripts/validate-scene.mjs viewer/public/scenes/room_a_take1
```

The validator script is absent in the current skeleton. A's tests independently
parse binary layout with Python and JavaScript typed arrays, but they cannot prove
B's unfinished viewer loads the scene or hits its device frame-rate target.

**Coordinate clarification for kickoff:** yaw-only normalization gives frame 0 a zero
position and zero horizontal heading, retaining pitch/roll so Y remains gravity-up.
The proposed “first pose is identity” statement is true only with a level camera at
the jig. We follow the frozen world-frame definition and do not modify the contract.

## Phase 3: masks, budget and multiple recordings

```bash
python -m pipeline.run data/raw/<take> \
  --out viewer/public/scenes/room_a_masked \
  --stride 3 --masks people_out/<take>/masks --max-points 800000
```

C's masks must be uint8 grayscale PNGs at depth resolution, named by original frame
index (`000000.png`). Any nonzero pixel is a person; A dilates by two pixels using a
5 x 5 kernel before excluding it. **Every A-selected frame needs a mask**, including
all-zero masks when no person was detected. A fails on missing masks to prevent
silent static person smears. The plan's example C stride 2 and A stride 3 do not cover
the same frames: run C with stride 1, match both strides, or use an A stride divisible
by C's stride. Sparse ghost detections are separate from mask coverage.

The point budget includes both interior and alignment points. Exceeding it fails
before export with a point count; increase `--voxel` until B's measured budget is met.
The default is 800,000 points. No data is silently truncated to satisfy the budget.

Multiple recordings must begin at the **same physical jig**. Each is normalized to
its own initial pose and replayed from relative time zero; this is simultaneous replay,
not synchronized wall-clock capture or automatic scan registration.

```bash
python -m pipeline.run data/raw/take_a data/raw/take_b \
  --out viewer/public/scenes/two_responders \
  --masks people_out/take_a/masks people_out/take_b/masks \
  --label "Responder 1" --label "Responder 2"
```

Scene source IDs start at 0 and increment in input order. The skeleton's `--source-id`
flag remains available but must be 0 for a complete v1 scene. The `fuse` API still
accepts any byte source ID for individual takes. Cross-recording
voxel deduplication keeps the earliest observation; input order breaks equal-time
ties. Both trajectories survive even when their static geometry overlaps. C owns
the combined ghost index: v1 `people.json` has no source ID, so do not concatenate or
overwrite per-take ghost files without C coordinating their offsets and timestamps.

## Verification and physical exit checks

```bash
python -m pytest -q
```

Tests generate small actual MP4/PNG/CSV recordings in temporary directories; they do
not commit recordings or represent captured scenes. Export unit tests use a labeled
test-only reference writer while C's writer remains a stub. A separate test calls
the real shared writer and skips with an explicit reason until it is implemented.
Existing C tests retain their skeleton xfail markers.

Before claiming each phase's integration check has passed:

- Phase 1: inspect the two-frame PLY from a real take; confirm C gets matching RGB,
  depth, frame indices, relative timestamps, intrinsics and normalized positions.
- Phase 2: process the real take using C's writer, run B's validator, open in B's
  viewer and measure alignment on the Samsung at the jig (target about 10 cm).
- Phase 3: check no static person smear, ghosts coincide with the room, staleness
  follows replay time, and B reports at least 30 fps at the chosen point budget.

Source format checked against the [Stray Scanner specification](https://github.com/StrayRobots/scanner/blob/main/docs/format.md).
Optional lens-distortion tables are not applied in this MVP, as in the skeleton.
