# Demo cuts

Rendered from the viewer with `npm run render` (phone-screen HUD over real or synthetic footage) and cut with `node scripts/assemble-demo.mjs`. Web-sized copies; the full-quality masters stay in `viewer/node_modules/.cache/omni-render/` on Dev B's laptop.

| File | What |
| --- | --- |
| `demo-v3.mp4` | The current demo cut, 128 s: title, first-POV walk-in, split screen with the real second-POV clip, the view wheel, the team map, end card |
| `first-pov-walkin.mp4` | First POV: the teammate's own walk from the corridor into the room, camera view until the door, then x-ray (over the take's real footage) |
| `second-pov-still.mp4` | Second POV, still camera in the corridor over the real clip: the room paints in through the wall as the first teammate scans it |
| `second-pov-moving-hologram.mp4` | Second POV on a scripted camera move, hologram over black: the x-ray spot follows the gaze |
| `second-pov-moving-feed.mp4` | Same move over a blurred synthetic feed (recorded colours), so both layers stay registered |
| `second-pov-wheel.mp4` | The radial view selector: Camera, X-ray, Natural |
| `split-screen.mp4` | First POV (left) and second POV (right) on the same clock |
| `minimap-showcase.mp4` | The team map on its own: scanned footprint by age, the wall, teammates with heading, the person |

Every frame says "Replayed from a recorded walkthrough · point-based rendering". Nothing here is live sensing. Outlines are hand-annotated.
