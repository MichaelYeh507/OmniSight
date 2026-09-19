# Viewer plan and status (Dev B)

Companion to `CLAUDE.md`, `docs/CONTRACT.md` and "Viewer design notes (Dev B)" in the master design doc. Update the status table when a step lands.

## Status

| Step | What | State |
| --- | --- | --- |
| B0 | Repo skeleton for all lanes, Vite scaffold, Pages workflow | done, `main` 840fb42 |
| B1 | `src/format.js` parser, Node encoder, `make-scene.mjs`, `validate-scene.mjs`, tests, committed `box` scene | done, `main` 43a4deb |
| B2 | scene loader, GPU reveal + staleness shader, replay clock, HUD, commander mode | done, `main` 001e2bf. Browser rendering verified by agent in headless Chrome (box screenshot inspected, top-down + HUD, no console errors), 2026-09-19. **Not yet confirmed by the user** |
| B3 | AR mode on the Samsung: WebXR session, `local` space, HUD as dom-overlay, fps budget | implemented, uncommitted. 13 tests, build, box/stress validators and Chrome smoke pass. **Samsung camera/HUD/tracking, re-entry and point-budget measurements pending**; ADB saw no device |
| B4 | alignment nudges (x, y, z 1 cm, yaw 0.5 deg), alignment vs x-ray mode, localStorage + URL override | implemented, uncommitted. Final 19 tests + production build pass; Chrome smoke covers nudges, saved offsets, URL overrides, reset and unchanged commander. Phone-sized controls screenshot inspected. **Physical Samsung/jig alignment pending** |
| B5 | first real scene from A: validator, alignment within ~10 cm at the jig | |
| B6 | person ghosts with hold, 15 s fade, "person, last seen N s ago" label; staleness legend | |
| B7 | portal (gaze-following hole in the wall plane) and responder frustum + trail | |
| B8 | commander polish (top-down, scrubber, caption), iPad Safari check, Pages URL + QR | |
| B9 | bug duty on hero scenes, perf tuning with A, feature freeze at hour 16 | |
| stretch | `?renderer=spark` with @sparkjsdev/spark 2.x (peer three >= 0.180); Points stays the fallback | after Phase 3 only |

Gate G1 (with Dev C): JS parses C's `scenes/fake`; C's Python `read_chunk` reads `viewer/public/scenes/box/chunks/0000.bin`; the validator exits 0 on `scenes/fake`. Not yet run because C's `common/omni_format.py` and fake scene had not landed.

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

Planned files: `src/ghosts.js` (B6), `src/portal.js` and `src/responder.js` (B7).

## Technical decisions already made

- three pinned at 0.186.0; plain JavaScript; one merged BufferGeometry for all chunks, one draw call; `frustumCulled = false` on every big object; no attribute uploads after load. Playback changes only `uClock` and the draw range (`drawCountAt`: chunks are time-sorted, so the drawn set is a prefix).
- Point size: `gl_PointSize = aRadius * projectionMatrix[1][1] * uViewportH / -mv.z`, clamped to `[1, min(24, ALIASED_POINT_SIZE_RANGE)]`. `uViewportH` comes from `camera.viewport.w` on XR sub-cameras (three sets it) or the drawing-buffer height on flat screens.
- Hidden points (`aTime > uClock`) are parked at clip `(2,2,2,1)` with size 0. Never hide with fragment `discard`; round points are a `?round=1` toggle because `gl_PointCoord` discard costs early-Z on tile GPUs.
- Colors are sRGB bytes written straight to `gl_FragColor` (ShaderMaterial gets no color-space conversion). Staleness: age = `uClock - aTime`, full color under 5 s, `smoothstep` to a desaturated blue-gray by 30 s, hold.
- AR (B3): hand-written session start, not ARButton: `navigator.xr.isSessionSupported('immersive-ar')` -> from a tap `requestSession('immersive-ar', { requiredFeatures: ['local'], optionalFeatures: ['dom-overlay'], domOverlay: { root: hud } })` -> `renderer.xr.setFramebufferScaleFactor(params.fbscale)` -> `renderer.xr.setReferenceSpaceType('local')` -> `await renderer.xr.setSession(session)`. `local` space puts the origin where the phone is when the session starts, so start in the jig and hold still 2 s. `scene.background = null`, `alpha: true`, `antialias: false` in AR. Only `sceneRoot` moves for alignment; the camera is overwritten from the XR pose. Count `reset` events on the reference space in `__omni`.
- Dev loop: `npm run dev` on 127.0.0.1 (adb reverse targets IPv4 loopback), `npm run reverse`, Samsung opens `http://localhost:5173/OmniSight/?mode=ar&scene=box` (localhost is a secure context, no cert). Fallback `npm run dev:ssl` over the hotspot. Console via `chrome://inspect#devices` or `adb logcat -s chromium`.
- B3 budget runs add `&bench=1` to hold the entire scene at its end time. Tap **Measure 10 s** in AR; it warms up for 2 s, then reports average / minimum half-second fps and saves a serializable result in `__omni.benchmark`. Tracking loss, replay edits, changed settings, reference resets or session exit cancel the run. `budget` caps static points; the HUD includes any visible alignment points. Stress has 774,018 static points, so 800k and unlimited draw the same count. No Samsung performance claim until the table in `SAMSUNG.md` is filled.
- B4 starts in x-ray mode; **Align wall** reveals the complete, fresh `alignment.bin` and the sliders. **Show x-ray** hides only that cloud. Nudges transform `sceneRoot`, never the XR camera. Bounds are +/-2 m and +/-30 degrees. **Save offsets** writes `omnisight.alignment.v1` in this browser's localStorage (per origin/device); **Reset offsets** zeros and saves. Finite `ax/ay/az/ayaw` override saved axes, including explicit zero, and are clamped/rounded to the control steps. URL values are temporary until saved; an unchanged URL reapplies them on reload. Commander ignores both saved and URL AR offsets. Storage failures do not prevent AR.
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

Detailed B3/B4 acceptance, full budget URLs, results table and copy-paste git handoffs: `SAMSUNG.md`. The dev server on port 5173 was already running and served OmniSight successfully. `npm run reverse` was attempted; it failed with `no devices/emulators found`. No commit, merge or push was run. All changes are inside `viewer/`.

Dev B reports two phones, Galaxy S21 Ultra and Galaxy A54, currently charging. Test the S21 Ultra first, then the A54; keep separate measured budgets and saved alignment values. Both models are listed for ARCore support. Phone verification and the user's own commander confirmation remain pending.

- Samsung: update "Google Play Services for AR"; run https://immersive-web.github.io/webxr-samples/immersive-ar-session.html in Chrome; enable Developer options + USB debugging; accept the RSA prompt; install the Samsung USB driver if `adb devices` is empty; disable One UI Auto Blocker if USB commands are refused.
- Confirm the Quick-panel screen recorder captures an AR session with camera feed and HUD before hour 8 (`scrcpy --record` is the fallback).
- Windows Defender prompt on `--host 0.0.0.0`: allow on Private and Public. The adb-reverse loopback path avoids the firewall entirely.
