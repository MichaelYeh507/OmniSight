# Numbers for the pitch (Dev B, measured 2026-09-19)

Copy from here into the Devpost, the README and the voiceover. Everything below was measured on our own code and devices; the "not measured" list at the end is what we must not claim.

## Deployed viewer

- Commander view (judge's phone, iPad, laptop): <https://michaelyeh507.github.io/OmniSight/?mode=commander&scene=fake>
- AR view on the Samsung: <https://michaelyeh507.github.io/OmniSight/?mode=ar&scene=fake>
- Table QR (opens the commander view): `viewer/public/qr.png`, also served at <https://michaelyeh507.github.io/OmniSight/qr.png>. Regenerate for a hero scene with `npm run qr -- --scene <name>` from `viewer/`.
- Deployed by GitHub Actions on every push to `main` that touches `viewer/`; the whole viewer is one 620 KB JavaScript bundle (159 KB gzipped).

## Frame rate on the demo phone

Galaxy S21 Ultra (SM-G998U1), Chrome 147, Google Play Services for AR 1.54, WebXR framebuffer 1080 x 2400, framebuffer scale 1, x-ray mode, 10 s measurement after a 2 s warm-up:

| Static points drawn | Average fps | Slowest half-second |
| ---: | ---: | ---: |
| 200,000 | 30.0 | 29.8 |
| 400,000 | 30.0 | 29.7 |
| 774,018 (everything) | 30.0 | 29.8 |

Chrome AR runs at the camera's 30 fps, so the phone never became GPU-bound: the ceiling is above 774,000 points. What limits a scene is download size, about 30 MB for 774k points. Say "30 fps with three quarters of a million points" and nothing bigger.

## Scenes

| Scene | Static points | Chunks | Ghost frames | Duration | Size |
| --- | ---: | ---: | ---: | ---: | ---: |
| `fake` (Dev C's generated room, person 5-12 s) | 92,806 | 40 | 70 | 20 s | 6 MB |
| `stress` (generated, not deployed) | 774,018 | 120 | 71 | 60 s | 30.5 MB |

The caption "Replayed from a recorded walkthrough. Processed in N s." takes N from `manifest.processing_seconds`, so it is the pipeline's real wall-clock time for that scene; with two takes merged it reads "Two recorded walkthroughs replayed together."

## What the viewer does, in numbers

- Staleness: full colour for 5 s after a surface was first seen, fading to blue-grey by 30 s, then held. Every point carries its own timestamp; the shader does the fade, so playback only moves one clock value.
- Ghosts: shown while the latest person frame is under 0.75 s old, then held and faded over 15 s with "person · last seen N s ago". The label is always "person".
- Portal: a 0.6 m hole in the wall plane that follows the gaze, clamped to 3 m from straight ahead.
- Alignment: 1 cm and 0.5 degree nudges, saved per phone; every AR session starts from the jig.
- One draw call for the whole static map; no data uploads after load.

## Verified on the phone

Live camera feed, stable anchoring while moving, ghosts and the portal seen through the wall on the `fake` scene, Exit and re-entry, saved offsets surviving a reload, the four frame-rate rows above.

## Not measured, do not claim

- Real-room alignment accuracy (the 10 cm target) waits for Dev A's first recording.
- Thermal behaviour beyond a one-minute session, and the Galaxy A54.
- Battery life, LTE download time, more than one phone at once.
- Rendering is point-based. Say "Gaussian splatting" only if the Spark renderer ships.
