# OmniSight data contract

Frozen at the end of Phase 0. This is a verbatim copy of "The data contract" from the master design doc, plus the clarifications below. Nobody changes it without telling the other two, because it is what lets three people build in parallel.

This section is frozen at the end of Phase 0. Nobody changes it without telling the other two, because it is what lets three people build in parallel.

### World frame

Right-handed, Y up, meters. The origin is the camera position at the first recorded frame. The -Z axis is that frame's forward direction flattened to horizontal. This matches WebXR's `local` reference space and three.js, so the viewer does no conversions.

### Scene folder

One folder per processed recording, at `viewer/public/scenes/<scene_name>/`.

| File | Written by | Contents |
| --- | --- | --- |
| `manifest.json` | A | Duration, chunk list, `floor_y`, `wall_z`, sources, processing time in seconds |
| `chunks/0000.bin` ... | A | Static splats first seen in each 0.5 s window |
| `alignment.bin` | A | Splats on the viewer's side of the wall, shown only while aligning |
| `trajectory.json` | A | Responder camera pose over time |
| `people.json` | C | Index of ghost frames: time, byte offset, count, centroid |
| `people.bin` | C | Ghost points for every frame that contains a person |
| `labels.json` | optional | Hazard pins, only on the Nemotron path |

### Chunk binary layout

Little-endian. `alignment.bin` uses the same layout. A chunk file is byte-identical to a future WebSocket message, so going live later is a transport swap.

```
char[4]  "OMNI"
uint32   version = 1
uint32   N                     number of splats
float32  t_start
float32  t_end
uint32   reserved              header is 24 bytes
float32  positions[3N]         world frame, meters
float32  normals[3N]           unit length, world frame
float32  radius[N]             meters
float32  t_seen[N]             seconds from recording start
uint8    rgbs[4N]              r, g, b, source_id
```

Every array starts on a 4-byte boundary, so JavaScript can wrap each one in a typed array without copying.

### people.bin layout

Per-frame blocks are concatenated. Each block is `float32 positions[3n]` followed by `uint8 rgba[4n]`, so every block is 16n bytes and offsets stay 4-byte aligned.

### JSON shapes

```json
// manifest.json
{
  "version": 1,
  "scene": "room_a_take3",
  "duration": 58.2,
  "chunks": [{"file": "chunks/0000.bin", "t_start": 0.0, "t_end": 0.5, "count": 18234}],
  "alignment_chunk": "alignment.bin",
  "wall_z": -1.8,
  "floor_y": -1.32,
  "sources": [{"id": 0, "label": "Responder 1", "device": "iPhone 14 Pro, Stray Scanner"}],
  "processing_seconds": 41.3
}

// trajectory.json: one entry per processed frame
[{"t": 0.0, "source": 0, "position": [0, 0, 0], "quaternion": [0, 0, 0, 1]}]

// people.json: one entry per frame that contains a person
[{"t": 12.4, "frame": 372, "offset": 0, "count": 2210, "centroid": [1.2, -0.4, -3.1]}]
```

Quaternions are `[x, y, z, w]`, the order three.js uses. `offset` is in bytes.

## Clarifications

Proposed at skeleton time by Dev B. Tick each one at kickoff, or edit it and tell the other two.

- [ ] 1. `people.bin` positions are in the normalized world frame, the same frame as chunks. Its 4th byte is alpha (write 255); the viewer multiplies by it.
- [ ] 2. `people.json` is sorted ascending by `t`, one entry per frame that contains a person. `offset` values are contiguous with no padding. `t` is on the same time base as `t_seen`.
- [ ] 3. `manifest.chunks[i].count` equals the chunk header `N` (the header is authoritative). Chunks are sorted by `t_start`. Empty 0.5 s windows may be omitted; the viewer never assumes contiguity.
- [ ] 4. `trajectory.json` quaternions rotate the three.js camera frame (the camera looks along its own -Z, +Y up) into the world. A converts from the OpenCV or ARKit convention before writing; otherwise the responder frustum points backward. Entries are sorted by `t` and the first pose is the identity.
- [ ] 5. The viewer ignores `t_seen` in `alignment.bin`, shows it whole in alignment mode, hides it in x-ray mode and dims it in commander mode.
- [ ] 6. The fake scene includes `alignment.bin` (outside face of the front wall, `z > wall_z`), a box room behind a `wall_z` of about -1.8, `wall_z` and `floor_y` in the manifest, and a person present only for a sub-window (5 s to 12 s of 20 s) so hold-and-fade is testable. `--points` caps its size.
- [ ] 7. `wall_z` assumes the jig faces the wall squarely, so the wall is the plane `z = wall_z` in the recording frame. The yaw nudge in the viewer corrects small residuals only.
- [ ] 8. `rgbs` byte 4 is `source_id` and matches `manifest.sources[].id`; the first source is 0. `duration` is the larger of the last chunk `t_end` and the last trajectory `t`. The scene folder name equals `manifest.scene` and matches `[a-z0-9_]+`.
- [ ] 9. `pipeline.fuse.unproject(depth_m, K_depth, T_world_cam, keep_mask)` is the one function C imports for ghost points. Its signature is pinned in the skeleton; changing it is a contract change.
- [ ] 10. Colours are sRGB bytes. The viewer writes them to the screen without conversion.
