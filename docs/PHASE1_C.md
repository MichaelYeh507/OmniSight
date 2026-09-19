# Shared format, fake scene and person masks: Phase 1

Branch: `feat/scene-format-and-test-data`, based on the committed recording pipeline.
Spec: master design document Phase 1 and `docs/CONTRACT.md`. Preserve all existing
shared signatures and byte layouts. Do not change B's viewer or A's pipeline.

Implementation checklist:
- [x] Implement validated OMNI chunk and ghost block readers/writers; turn existing
  round-trip tests into required passes and test truncated/malformed data.
- [x] Generate a deterministic room, outside alignment surface, timed capsule ghost,
  trajectory and manifest. Enforce the point cap and reject existing scene output.
- [x] Segment person masks on A's extracted RGB frames, rotate for inference and
  rotate back, save zero masks for frames without detections, preserve frame IDs.
- [x] Verify A's real shared-writer integration, JavaScript typed arrays and all
  tests. Run actual pretrained inference on sample frames when dependencies permit.

Phase 2 real ghost lifting (`people.run`) and hosting are outside this change.

## What is ready

`common.omni_format` implements the pinned `write_chunk`, `read_chunk`, `write_people`
and `read_people` signatures. It validates dimensions, finite values, times, normals,
byte ranges, file lengths, people offsets and centroids. Invalid input fails before
output is written. Chunk writes use a temporary file and replacement. People data is
fully validated before either file is replaced; the pair is not a transactional
update, so callers should publish a completed scene directory (as the fake generator
does), rather than serve it while writing. Binary arrays are explicitly little-endian.

A's exporter now uses the real shared writer. Its integration test is no longer
skipped, and the previous C xfail markers have been removed.

`viewer/public/scenes/fake/` contains a generated synthetic fixture for B: a 4 x 3 x
2.5 m room with a doorway, the outside alignment wall, and a responder trajectory.
The room fills in over 20 seconds; a capsule person walks between seconds 5 and 12,
then disappears from the observations so B can test hold/fade. Every source is clearly
marked `Fake responder` / `make_fake_scene.py`. These files are not a captured room.

`people.masks` implements Phase 1 person masks from A's extracted frames. It leaves
`people.run` for Phase 2's combined raw-recording and real-ghost pipeline. No viewer
JavaScript or pipeline implementation was changed on this branch.

## Run and test

From the repository root:

```bash
python -m pip install -r requirements.txt
python -m pytest -q
```

The bundled fake scene is already available. To generate another copy, choose a new
scene name; existing output folders are never overwritten:

```bash
python -m tools.make_fake_scene --out viewer/public/scenes/fake_check
```

Options: `--points 200000` caps room plus alignment points; `--seed 0` makes binary
geometry repeatable; `--duration 20`, `--person 5:12`, `--wall-z -1.8` and
`--floor-y -1.3` control replay and geometry. Manifest processing time varies each run.
Ghost frames use integer 10 Hz ticks. A custom person interval shorter than a tick
may contain no ghost frames. The fourth static color byte is source ID; the fourth
ghost color byte is alpha 255.

B can use `scene=fake` with the viewer. The current viewer skeleton reads the
manifest but does not yet render the point clouds or ghosts; B's renderer and device
checks are still required. Its advertised `viewer/scripts/validate-scene.mjs` is also
absent, so independent JavaScript typed-array checks were used during this work.

## Generate person masks for A

```bash
python -m pip install -r requirements-people.txt

# All frames, so A and C can choose compatible strides later.
python -m pipeline.extract data/raw/001 --out people_out/001/frames

python -m people.masks people_out/001/frames \
  --out people_out/001/detections

python -m pipeline.run data/raw/001 \
  --out viewer/public/scenes/room_001_masked \
  --stride 3 --masks people_out/001/detections/masks
```

The first mask run downloads `yolo11n-seg.pt` into the gitignored
`people_out/models/` directory. Supply `--model /path/to/yolo11n-seg.pt` for an existing
checkpoint. Inference runs locally; the default device is CPU, with `--device mps`
available if your PyTorch installation supports it. Only the model's `person` class
is used. The dependency is imported lazily so the shared library and fake generator
do not require PyTorch.

Inspect an extracted RGB PNG. If the person is sideways/upside down, pass
`--rotation 90`, `180`, or `270` to rotate **clockwise** before inference. The saved
mask is rotated back to the original sensor coordinates and resized with nearest
neighbor to match the depth image. This option does not rotate A's geometry.

Each selected frame gets `masks/NNNNNN.png`, with 255 for person and 0 elsewhere,
including all-zero files when there are no detections. `summary.json` records frame
IDs and the number with detected person pixels. The mask command does not dilate;
A owns dilation. `--stride` uses original recording frame IDs, not list positions.
Do not extract only every 120th frame and then ask A to fuse every third frame.

Prediction uses full-resolution masks in input-image coordinates (`retina_masks=True`),
as specified in the [Ultralytics prediction documentation](https://docs.ultralytics.com/modes/predict/).
It fails visibly if a model produces padded masks, missing segmentation, or an
unsupported label set instead of generating misaligned exclusions.

## Verification record

- Full suite after implementation/review: 78 passed; no expected failures or skipped
  shared-writer tests.
- Generated fixture: 106,150 static points, 40 chunks, 70 ghost frames (2,240,000
  bytes). Independently checked OMNI offsets, wall split, replay ranges and ghost
  offsets with JavaScript typed arrays, matching B's consumption model.
- Real pretrained model on the packaged Ultralytics sample: 118,729 person pixels.
- Actual `data/raw/001` smoke check: extracted every 120th frame (12 frames), inferred
  12 masks, detected person pixels in 2 frames. These sampled masks are for the smoke
  check only, not the full-stride production handoff.
- A consumed those masks with stride 120 and the real shared writer, exporting
  112,861 static points to `/private/tmp/omnisight_phase1_recording` in about 8 seconds.
- Review fixes: front-wall float32 positions sit just inside the double-precision
  JSON wall plane; fractional person intervals derive both time and ID from integer
  ticks to prevent duplicated ghost frame IDs.

Test dependencies/model weights were installed in temporary locations, not your base
Python environment. Reuse your own environment with the install commands above.
Raw frames, generated masks, model weights and the captured-scene smoke output stay
out of Git. Only the clearly labeled synthetic fixture belongs in the shared viewer.

Physical phase exits still need the teammates: B must render the fixture and test AR
on the Samsung; C/A must visually inspect masks and real geometry alignment. The
numeric inference check establishes a working model path, not detection accuracy.
