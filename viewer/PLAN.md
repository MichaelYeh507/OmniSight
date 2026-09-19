# Viewer plan and status (Dev B)

Companion to `CLAUDE.md`, `docs/CONTRACT.md` and "Viewer design notes (Dev B)" in the master design doc. Update the status table when a step lands.

## Status

| Step | What | State |
| --- | --- | --- |
| B0 | Repo skeleton for all lanes, Vite scaffold, Pages workflow | done, `main` 840fb42 |
| B1 | `src/format.js` parser, Node encoder, `make-scene.mjs`, `validate-scene.mjs`, tests, committed `box` scene | done, `main` 43a4deb |
| B2 | scene loader, GPU reveal + staleness shader, replay clock, HUD, commander mode | done, `main` 001e2bf. Agent verified commander rendering/top-down/HUD in Chrome. Dev B confirmed box rendering and HUD in Samsung AR on 2026-09-19; human commander check remains pending |
| B3 | AR mode on the Samsung: WebXR session, `local` space, HUD as dom-overlay, fps budget | implemented, `main` 5ce7d44 (committed/pushed by Dev B). Dev B confirmed camera/box/HUD and stable anchoring on S21 Ultra. First 200k stress run: 30.01 avg / 29.83 min half-second fps, XR 1080 x 2400, fbscale 1, no errors/resets. Exit button restores Enter correctly. **Higher caps and final budget pending** |
| B4 | alignment nudges (x, y, z 1 cm, yaw 0.5 deg), alignment vs x-ray mode, localStorage + URL override | implemented, `main` 5ce7d44. 19 tests + build and Chrome smoke pass. Dev B confirmed X/Y/Z nudges, yaw and x-ray switching. Agent verified phone Save/reload persistence and temporary URL overrides without overwriting stored offsets. **Control checks passed; physical alignment was not attempted (B5)** |
| B5 | first real scene from A: validator, alignment within ~10 cm at the jig | |
| B6 | person ghosts with hold, 15 s fade, "person, last seen N s ago" label; staleness legend | implemented 2026-09-19: `src/ghosts.js` + pure `ghostStateAt` in `scene-data.js` (tested). Seen while the latest people frame is under 0.75 s old, then held and faded over 15 s; label sprite at the centroid; additive red-orange, depthTest off so it shows through walls. Headless smoke verifies seen / fading / hidden states and screenshots on C's `fake` scene. **Not yet seen on the Samsung in AR** |
| B7 | portal (gaze-following hole in the wall plane) and responder frustum + trail | |
| B8 | commander polish (top-down, scrubber, caption), iPad Safari check, Pages URL + QR | |
| B9 | bug duty on hero scenes, perf tuning with A, feature freeze at hour 16 | |
| stretch | `?renderer=spark` with @sparkjsdev/spark 2.x (peer three >= 0.180); Points stays the fallback | after Phase 3 only |

Gate G1 (with Dev C): **passed 2026-09-19** against `origin/feat/scene-format-and-test-data` (unmerged at the time). Our validator exits 0 on C's `scenes/fake` (92,806 static points, 40 chunks, 13,344 alignment points, 70 ghost frames 5.0-11.9 s, identity first pose, wall_z -1.8, floor_y -1.3); the scene renders in our viewer with no console errors; C's `read_chunk` and `read_people` accept our `box` scene. One contract bug found and fixed on our side: `encodePeople` rounded centroids to 4 decimals and C's reader checks them to 1e-5, so centroids are now written as exact means (`box` regenerated). `git merge-tree` shows both teammate branches merge into main with no conflicts. C's branch also carries the pipeline branch (`feat/recording-to-scene-pipeline`, 41 tests pass here, 1 fails on an mp4 edit-list frame count with OpenCV 5.0, 1 skipped); no real scene exists yet.

## File map

```
viewer/
  vite.config.js         base /OmniSight/ (also in dev), dev on 127.0.0.1:5173, basic-ssl only in `--mode ssl`
  index.html             #pre card (status + error banner, outside the XR overlay) and #hud (dom-overlay root: caption, fps/points readout, staleness legend, controls)
  src/params.js          the only URL reader; sceneUrl(file) resolves under import.meta.env.BASE_URL
  src/debug.js           window.__omni, error banner, rolling fps
  src/format.js          parseChunk / parsePeople / concatPeople, pure ESM (Node tests import it)
  src/scene-data.js      mergeChunks, computeBounds, drawCountAt, poseIndexAt (pure, tested)
  src/scene-loader.js    fetches manifest, chunks, alignment.bin, trajectory.json, people.*; returns plain typed arrays
  src/points.js          PointCloud: THREE.Points + ShaderMaterial (aColor u8x4 normalized, aRadius, aTime; uClock, uIgnoreTime, uViewportH, uMaxPx, uSizeScale, uStaleStart 5, uStaleEnd 30, uRound, uBrightness)
  src/clock.js           ReplayClock: play/pause/restart/seek/speed, driven by the animation-loop timestamp, loops at duration
  src/hud.js             binds #hud controls to the clock, repaints at 8 Hz, beforexrselect guard, keyboard shortcuts
  src/modes/commander.js OrbitControls, dark background, floor grid, wall outline, dimmed alignment cloud, top-down toggle
  src/modes/ar.js        hand-written local-space session, support/permission failures, overlay, exit/re-entry, reset diagnostics
  src/benchmark.js       2 s warmup + 10 s XR-frame measurement, average and slowest half-second fps
  src/alignment.js       AR-only sceneRoot offsets, wall visibility, saved device offsets and URL precedence
  src/ghosts.js          Ghosts: one Points over the concatenated people arrays, setDrawRange per frame, additive red-orange, canvas-sprite label, hold + fade
  src/main.js            boot: params -> loadScene -> PointClouds under sceneRoot -> clock -> mode -> hud -> setAnimationLoop
  scripts/omni-format.mjs   Node encoder: encodeChunk, encodePeople, writeScene
  scripts/make-scene.mjs    box room generator (--points --duration --person a:b --wall-z --floor-y --seed --name)
  scripts/validate-scene.mjs handoff gate; FAIL/WARN lines, exit 0/1; --budget N --strict-budget
  test/format.test.js, test/scene-data.test.js   node --test
  test/ar.test.js        mocked XR lifecycle and frame timing (not hardware verification)
  test/alignment.test.js transform, nudge precision, persistence, URL precedence, storage failures
  scripts/browser-smoke.mjs  dependency-free headless Chrome/Edge check; `npm run smoke` with dev server running
  SAMSUNG.md            phone acceptance steps, budget URLs, results table and integration commands
  public/scenes/box/     committed 20k-point generated room (default scene)
  public/scenes/stress/  gitignored 774k-point room from `npm run stress`
  public/scenes/fake/    Dev C's Python-generated room (pending)
```

Planned files: `src/portal.js` and `src/responder.js` (B7).

## Technical decisions already made

- three pinned at 0.186.0; plain JavaScript; one merged BufferGeometry for all chunks, one draw call; `frustumCulled = false` on every big object; no attribute uploads after load. Playback changes only `uClock` and the draw range (`drawCountAt`: chunks are time-sorted, so the drawn set is a prefix).
- Point size: `gl_PointSize = aRadius * projectionMatrix[1][1] * uViewportH / -mv.z`, clamped to `[1, min(24, ALIASED_POINT_SIZE_RANGE)]`. `uViewportH` comes from `camera.viewport.w` on XR sub-cameras (three sets it) or the drawing-buffer height on flat screens.
- Hidden points (`aTime > uClock`) are parked at clip `(2,2,2,1)` with size 0. Never hide with fragment `discard`; round points are a `?round=1` toggle because `gl_PointCoord` discard costs early-Z on tile GPUs.
- Colors are sRGB bytes written straight to `gl_FragColor` (ShaderMaterial gets no color-space conversion). Staleness: age = `uClock - aTime`, full color under 5 s, `smoothstep` to a desaturated blue-gray by 30 s, hold.
- AR (B3): hand-written session start, not ARButton: `navigator.xr.isSessionSupported('immersive-ar')` -> from a tap `requestSession('immersive-ar', { requiredFeatures: ['local'], optionalFeatures: ['dom-overlay'], domOverlay: { root: hud } })` -> `renderer.xr.setFramebufferScaleFactor(params.fbscale)` -> `renderer.xr.setReferenceSpaceType('local')` -> `await renderer.xr.setSession(session)`. `local` space puts the origin where the phone is when the session starts, so start in the jig and hold still 2 s. `scene.background = null`, `alpha: true`, `antialias: false` in AR. Only `sceneRoot` moves for alignment; the camera is overwritten from the XR pose. Count `reset` events on the reference space in `__omni`.
- Dev loop: `npm run dev` on 127.0.0.1 (adb reverse targets IPv4 loopback), `npm run reverse`, Samsung opens `http://localhost:5173/OmniSight/?mode=ar&scene=box` (localhost is a secure context, no cert). Fallback `npm run dev:ssl` over the hotspot. Console via `chrome://inspect#devices` or `adb logcat -s chromium`.
- B3 budget runs add `&bench=1` to hold the entire scene at its end time. Tap **Measure 10 s** in AR; it warms up for 2 s, then reports average / minimum half-second fps and saves a serializable result in `__omni.benchmark`. Tracking loss, replay edits, changed settings, reference resets or session exit cancel the run. `budget` caps static points; the HUD includes any visible alignment points. Stress has 774,018 static points, so 800k and unlimited draw the same count. No Samsung performance claim until the table in `SAMSUNG.md` is filled.
- B4 starts in x-ray mode; **Align wall** reveals the complete, fresh `alignment.bin` and the sliders. **Show x-ray** hides only that cloud. Nudges transform `sceneRoot`, never the XR camera. Bounds are +/-2 m and +/-30 degrees. **Save offsets** writes `omnisight.alignment.v1` in this browser's localStorage (per origin/device); **Reset offsets** zeros and saves. Finite `ax/ay/az/ayaw` override saved axes, including explicit zero, and are clamped/rounded to the control steps. URL values are temporary until saved; an unchanged URL reapplies them on reload. Commander ignores both saved and URL AR offsets. Storage failures do not prevent AR.
- For comparable stress runs after testing nudges, use `&ax=0&ay=0&az=0&ayaw=0` to override arbitrary test offsets without overwriting the saved values. The phone currently stores x=0.04 m, y=-0.05 m, z=-1.74 m, yaw=0 degrees; these are control-test values, not a calibrated alignment.
- Portal (B7): oversized plane at `wall_z + 0.02` with a 0.6 m hole, `MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: DoubleSide })`, `renderOrder -1`; translate it so the hole sits where the gaze ray hits the wall plane in `sceneRoot` space. Ghosts, responder, ring and label are `transparent`, `depthTest: false`, ascending renderOrder so they show through the wall. `?portal=0` falls back to plain x-ray.
- Ghosts (B6): one `Points` over the concatenated people arrays, `setDrawRange(entry.start, entry.count)` of the latest entry with `t <= clock`; hold the last frame, fade over 15 s, label sprite at the centroid redrawn once per second.
- Visual direction from the user's reference images (see the memory note or ask): x-ray look on black, static map in translucent cyan-blue (fresh bright, stale dim), person ghosts in saturated red-orange with additive blending, portal ring cyan. Apply in B6 and B8, not before.

## Integration gates and what B needs from A and C

| Hour | B needs | From | B hands back |
| --- | --- | --- | --- |
| ~1:30 | `common/omni_format.py`, `scenes/fake` per CONTRACT clarification 6 | C | validator, `box` scene for C's reader check, URL scheme |
| 3:00 | nothing | | point-budget table: device, XR framebuffer size, fbscale, fps at `?scene=stress&budget=200000|400000|800000` vs `budget=0` |
| ~6:00 | first validator-clean real scene | A | fps at A's count, alignment slider values |
| 8:00 | real `people.json`/`people.bin`; Pages source flipped to GitHub Actions | C | insurance clip of the through-wall view |
| 13:00 | masked scene with `floor_y`; QA slider values per device | A, C | deployed URL and QR text, `__omni` numbers for the pitch |
| 16:00 | three hero scenes (`hero_small` if the download is slow on LTE) | A | freeze; only hero-exposed fixes after |

Cut order if behind (from the design doc): Spark, second responder, timeline scrubber, portal (plain x-ray stays), commander polish. Never alignment, ghosts or staleness.

## Physical checklist (only the user can do these)

Detailed B3/B4 acceptance, full budget URLs, results table and copy-paste git handoffs: `SAMSUNG.md`. Dev B committed and pushed implementation 5ce7d44. The agent never ran commit, merge or push; all agent file changes stay inside `viewer/`. After USB debugging was enabled, ADB authorized the S21 Ultra and `npm run reverse` succeeded. Chrome opened the box URL in a secure context, reported immersive AR support and showed an enabled Enter AR button with no viewer errors.

Devices: Galaxy S21 Ultra (SM-G998U1, Chrome 147.0.7727.137, Google Play Services for AR 1.54.260890093) and Galaxy A54 (not yet tested). Dev B confirmed the live camera feed, point-cloud box, HUD and stable anchoring while moving on the S21 Ultra, followed by nudge/yaw/x-ray controls and saving offsets. Dev B explicitly tested control behavior only, without lining the synthetic box up to the real room. Once the phone was awake, the agent reloaded the box page and verified that the saved offsets restored exactly with no viewer errors. The 200k stress URL then loaded 200,000 points at t=60 with zero alignment overrides and preserved the saved values. No timed FPS result is available yet. Keep separate measured budgets and saved alignment values for each phone. Remaining: explicit Exit AR/re-entry check, stress budget, A54, human commander check and real-scene registration (B5).

- Samsung: update "Google Play Services for AR"; run https://immersive-web.github.io/webxr-samples/immersive-ar-session.html in Chrome; enable Developer options + USB debugging; accept the RSA prompt; install the Samsung USB driver if `adb devices` is empty; disable One UI Auto Blocker if USB commands are refused.
- Confirm the Quick-panel screen recorder captures an AR session with camera feed and HUD before hour 8 (`scrcpy --record` is the fallback).
- Windows Defender prompt on `--host 0.0.0.0`: allow on Private and Public. The adb-reverse loopback path avoids the firewall entirely.
