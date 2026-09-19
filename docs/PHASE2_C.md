# Dev C Phase 2: real person ghosts

`people.run` now consumes one Stray Scanner recording and writes the person masks and
world-space ghost blocks that B loads from a scene folder. It uses A's pinned
`pipeline.loader`, `pipeline.normalize` and `pipeline.fuse.unproject` interfaces;
there is no duplicate geometry or camera conversion in this stage.

```bash
python -m people.run data/raw/006 \
  --out people_out/006/ghosts \
  --stride 3 \
  --rotation 90 \
  --model /path/to/yolo11n-seg.pt \
  --max-points 3000
```

The process decodes RGB, depth and confidence sequentially. For every selected frame it
writes `masks/NNNNNN.png` in depth coordinates, where 255 means person. It erodes the
mask by one pixel, keeps confidence 1 or 2, rejects invalid/range-outside depth, and
unprojects those pixels through A's normalized pose. Ghost colors are RGB from the
recording with alpha 255. Each frame is capped deterministically with evenly spaced
points, then `common.omni_format.write_people` writes `people.bin` and `people.json`.

`--rotation` rotates the model input clockwise and rotates the resulting mask back to
the sensor orientation. `--camera-convention opencv` applies A's explicit raw-pose
conversion before unprojection. `--stride` uses the original recording frame IDs, so
run it with the same stride A will use for the static map. Output is staged and renamed
only after all files are valid; existing output directories are refused.

For recording 006, the verified run produced 1,191 selected frames, 219 frames with
person pixels, 218 nonempty ghost blocks, 591,122 points and a 9.46 MB people file.
The output is currently in `people_out/006/ghosts` (gitignored). To attach it to A's
scene, copy `people.bin` and `people.json` into the processed scene directory only
after A has exported that scene:

```bash
cp people_out/006/ghosts/people.bin viewer/public/scenes/room_006_preview/
cp people_out/006/ghosts/people.json viewer/public/scenes/room_006_preview/
```

Then run B's scene validator and open the viewer. B owns hold/fade and `last seen` text;
C reports only observations. The v1 people index has no source ID, so multi-recording
ghost merging needs a coordinated contract update before combining two takes.

Run `python -m pytest -q` from the repository root. Phase 2 tests use injected segmenters
and generated recordings; the 006 result additionally verifies the actual pretrained
segmentation model and A's real geometry path.
