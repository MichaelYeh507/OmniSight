# Dev B: Samsung acceptance and integration

State on 2026-09-19: B0–B2 are merged on main. Rendering in a browser **has not been confirmed by me (Dev B)** in the available session record. The agent opened headless Chrome, inspected the rendered box screenshot, and verified top-down, HUD, AR-unavailable handling and stress draw caps. That is not a physical AR test.

## B3: phone check

Dev B has a Galaxy S21 Ultra and a Galaxy A54, currently charging. Both the S21 Ultra 5G and A54 5G appear on [Google's ARCore-supported device list](https://developers.google.com/ar/devices). Start with the S21 Ultra, then repeat on the A54 as the second-device check; choose the demo phone and production point cap from measured results, not the device names. Keep separate FPS rows and alignment offsets for each phone.

From PowerShell:

```powershell
Set-Location C:\steelhacks\OmniSight\viewer
npm run dev
```

Leave that terminal open. If port 5173 is already serving OmniSight, use that server. In another terminal:

```powershell
Set-Location C:\steelhacks\OmniSight\viewer
adb devices -l
npm run reverse
```

If ADB is not on PATH, use `& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" reverse tcp:5173 tcp:5173`. The Samsung must appear as `device`, not `unauthorized`. Unlock it and accept USB debugging/RSA and camera/AR permission prompts. Use Chrome with Google Play Services for AR installed.

Connect one phone at a time for `npm run reverse`. If both are connected, select the serial printed by `adb devices -l`: `adb -s SERIAL reverse tcp:5173 tcp:5173` (replace `SERIAL`). Each phone needs its own reverse mapping and USB authorization.

1. On the Samsung open <http://localhost:5173/OmniSight/?mode=ar&scene=box>.
2. Put the camera at the recording jig's origin and height, facing the same direction, with a textured view. Tap **Enter AR** and hold still for 2 seconds after the camera opens.
3. Confirm real camera feed behind the points; the HUD and replay caption remain visible; fps and points update. The generated box is synthetic: check stability, not whether it matches your real room.
4. Move the phone sideways about 20 cm and rotate a little. The box must stay fixed in the room, not follow the screen. Pause/Play and scrub must respond without dismissing AR.
5. Tap **Exit AR**. The Enter card must return. Put the phone back in the jig and enter again. Also test Android Back then re-entry.
6. If permission was denied, allow it in Chrome site settings and retry. A failure should leave a readable error and an enabled Enter button. If tracking resets, the HUD instructs you to exit and start from the jig.

The session requests `local` and an optional DOM overlay, sets framebuffer scale and `local` **before** attaching the session, and uses an alpha renderer without antialiasing or scene background. If the browser cannot provide the overlay, the app ends the session with an actionable error. API references: [three.js WebXRManager](https://threejs.org/docs/pages/WebXRManager.html), [W3C DOM overlays](https://www.w3.org/TR/webxr-dom-overlays-1/).

## B3: point budget for Dev A

Generate/validate once:

```powershell
npm run stress
node scripts/validate-scene.mjs public/scenes/stress
```

Open each URL on the Samsung. Enter from the jig, keep the same view and phone orientation, use x-ray mode (alignment hidden), and tap **Measure 10 s**. This freezes the complete scene, warms up for 2 s, then measures 10 s. Record the reported average and minimum half-second fps, actual points and XR dimensions. Repeat near the largest cap that sustains 30 fps; a heat-throttled run matters. A screen recording adds load, so note whether it was on.

- <http://localhost:5173/OmniSight/?mode=ar&scene=stress&budget=200000&bench=1>
- <http://localhost:5173/OmniSight/?mode=ar&scene=stress&budget=400000&bench=1>
- <http://localhost:5173/OmniSight/?mode=ar&scene=stress&budget=800000&bench=1>
- <http://localhost:5173/OmniSight/?mode=ar&scene=stress&budget=0&bench=1>

All default to `fbscale=1`, `psize=1`, square points. If testing `&fbscale=0.75`, report it as a separate run. The cap affects drawing, not download or GPU allocation. This generator has **774,018** static points: 800k and unlimited are deliberately the same count, not evidence that 800,000 points were rendered.

| Samsung model / Chrome | Cap | Actual points | XR width × height | fbscale | Avg fps | Min 0.5 s fps | Notes |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- |
| pending | 200,000 | 200,000 expected | pending | 1 | pending | pending | |
| pending | 400,000 | 400,000 expected | pending | 1 | pending | pending | |
| pending | 800,000 | 774,018 expected | pending | 1 | pending | pending | |
| pending | 0 (all) | 774,018 expected | pending | 1 | pending | pending | |

On desktop Chrome open `chrome://inspect/#devices`, inspect the Samsung tab, then copy `JSON.stringify(__omni.benchmark)`. Other diagnostics: `__omni.xrPresenting`, `__omni.tracking`, `__omni.resets`, `__omni.xrFramebuffer`, `__omni.errors`. Send Dev A the largest tested count maintaining at least 30 fps, with dimensions/scale and thermal notes. No measured budget is available yet.

## B3 integration handoff

Commands are for Dev B; the agent never runs commit, merge or push. Run from the repo root when accepting this checkpoint. If B4 is also in your worktree, use the combined handoff added below rather than claiming this stages only B3.

```powershell
git switch -c dev-b/b3-ar
if ($LASTEXITCODE) { throw 'Branch creation failed' }
git add -- viewer
if ($LASTEXITCODE) { throw 'Staging failed' }
git commit -m "viewer: add Samsung AR session and point-budget measurement"
if ($LASTEXITCODE) { throw 'Commit failed' }
git fetch origin
if ($LASTEXITCODE) { throw 'Fetch failed' }
git merge origin/main
if ($LASTEXITCODE) { throw 'Resolve integration conflicts, then rerun checks' }
Push-Location viewer
npm test
if ($LASTEXITCODE) { throw 'Tests failed' }
npm run build
if ($LASTEXITCODE) { throw 'Build failed' }
npm run smoke
if ($LASTEXITCODE) { throw 'Browser checks failed' }
Pop-Location
git switch main
if ($LASTEXITCODE) { throw 'Switch to main failed' }
git merge --ff-only dev-b/b3-ar
if ($LASTEXITCODE) { throw 'Main advanced; integrate again on the branch and rerun checks' }
git push origin main
```

`npm run smoke` needs the viewer dev server and the generated stress scene. For checks to continue safely, stop on any failed command. Only the user can complete the phone checks above.

## B4: alignment check

1. Enter AR from the jig on the box URL above. It starts in **X-ray mode**. Tap **Align wall**: the recorded outside wall appears and four sliders open. The synthetic box will not match an arbitrary real wall.
2. Tap X `+` once: its readout changes by **0.01 m**. Check Y/Z the same way and yaw by **0.5°**. The recorded map moves; the camera feed stays pose-driven. Slider ranges are +/-2 m and yaw +/-30°; use the jig for large position errors.
3. Tap **Show x-ray**: only the outside alignment cloud disappears. Reopen **Align wall**, set recognizable offsets, then **Save offsets**.
4. Exit AR, reload, return to the jig and enter again. The saved offsets must load. They are stored in this browser on this origin: localhost and GitHub Pages have separate settings. Every session still starts from the jig; these are constant corrections, not a saved world anchor.
5. Try <http://localhost:5173/OmniSight/?mode=ar&scene=box&ax=0.10&ay=-0.02&az=0.03&ayaw=1.5>. The four values override saved axes. Only **Save offsets** persists these values. **Reset offsets** saves zero; the same override URL will apply its values again after reload, so remove the four parameters when testing saved/reset state.
6. With a real validator-clean scene (B5), align the outside cloud to wall/door-frame features, save, switch to x-ray, then move sideways and verify registration within roughly 10 cm. This real-scene accuracy is not yet verified by the synthetic box or automated tests.

The benchmark expects **X-ray mode**, so close alignment before testing point budgets. For phone feedback report: model/Chrome version, camera feed yes/no, HUD usable yes/no, stable box yes/no, exit/re-entry yes/no, persistence yes/no, and each budget's FPS/framebuffer results. Copy any `__omni.errors` and `__omni.resets` if something fails.

## B4 / combined B3+B4 integration handoff

B3 and B4 were completed in the same uncommitted worktree, including shared changes to main.js and the HUD. Use this combined branch if you have not already committed B3. If B3 was separately accepted, use branch `dev-b/b4-alignment` and a B4-only commit message for the remaining diff. Do not run both handoffs on the same complete diff.

From PowerShell at the repo root, with the viewer dev server still running:

```powershell
Set-Location C:\steelhacks\OmniSight
git switch -c dev-b/b3-b4-ar-alignment
if ($LASTEXITCODE) { throw 'Branch creation failed' }
git add -- viewer
if ($LASTEXITCODE) { throw 'Staging failed' }
git commit -m "viewer: add Samsung AR, point budgets and alignment nudges"
if ($LASTEXITCODE) { throw 'Commit failed' }
git fetch origin
if ($LASTEXITCODE) { throw 'Fetch failed' }
git merge origin/main
if ($LASTEXITCODE) { throw 'Resolve integration conflicts, then rerun checks' }
Push-Location viewer
npm test
if ($LASTEXITCODE) { throw 'Tests failed' }
npm run build
if ($LASTEXITCODE) { throw 'Build failed' }
node scripts/validate-scene.mjs public/scenes/box
if ($LASTEXITCODE) { throw 'Scene validation failed' }
npm run smoke
if ($LASTEXITCODE) { throw 'Browser checks failed' }
Pop-Location
git switch main
if ($LASTEXITCODE) { throw 'Switch to main failed' }
git merge --ff-only dev-b/b3-b4-ar-alignment
if ($LASTEXITCODE) { throw 'Main advanced; integrate again on the branch and rerun checks' }
git push origin main
```

If origin/main adds a new scene from A/C, run `node scripts/validate-scene.mjs public/scenes/<scene>` inside `viewer/` before accepting that scene. The Git integration test and push are for Dev B to run; neither was performed by the agent.
