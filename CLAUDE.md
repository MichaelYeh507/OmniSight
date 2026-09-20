# OmniSight: notes for coding agents

Hackathon project (SteelHacks, 2026-09-19, three developers, about 20 build hours). An iPhone 14 Pro records a room with LiDAR (Stray Scanner), a Python pipeline turns it into a timestamped 3D map, and a web viewer replays that map in AR on a Samsung phone and as a commander view on an iPad or laptop. Three locked features that are never cut: through-wall alignment, person ghosts, staleness (every surface and person carries an age).

Read in this order:

1. `OmniSight Master Design Doc and Build Plan.md`: the whole plan. Skim "Locked scope", "The data contract", "Lanes", your lane's design notes and "Gotchas that will actually bite".
2. `docs/CONTRACT.md`: the frozen file format plus clarifications. Any change is announced to all three devs before it merges.
3. `viewer/PLAN.md`: the viewer build order, integration gates, technical decisions and current status (Dev B lane).

## Lanes and ownership

| Path | Owner | Notes |
| --- | --- | --- |
| `pipeline/` | Dev A | Stray Scanner recording -> scene folder. Owns the iPhone and `data/raw/` |
| `common/`, `tools/`, `people/`, `docs/` | Dev C | Format library, fake scene, person masks and ghosts, then producer |
| `viewer/` | Dev B | Vite + three.js + WebXR viewer. Owns the Samsung and iPad |
| `viewer/public/scenes/` | shared | Processed scenes, small, committed. `stress/` is gitignored |

Stay inside your lane's directory unless the owner has agreed. Stubs in other lanes carry signatures and CLI flags from the design doc; do not rename them.

## Rules for agents working with the user

- **Never run `git commit`, `git merge` or `git push`.** The user runs git. After finishing a step, hand back a copy-pasteable command block: create a short-lived branch, commit, `git fetch origin` + `git merge origin/main` as the integration test, re-run the checks, merge to `main`, push.
- Every step ends with a check that can be run: `npm test`, `npm run build`, the validator, or a URL to open. Say plainly what was and was not verified.
- Run the validator before accepting any scene folder from A or C: `node viewer/scripts/validate-scene.mjs viewer/public/scenes/<scene>`. Exit 0 means the viewer will load it.
- Honesty rule from the design doc: the renderer is "point-based rendering" unless the Spark path ships. Captions on replays say "Replayed from a recorded walkthrough."
- No language model anywhere in the core build (keeps the No Wrapper track open).

## Environment

Windows 11, PowerShell. Node 26 / npm 11, Python 3.10, adb at `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`. Repo `github.com/MichaelYeh507/OmniSight`, public, GitHub Pages deploys `viewer/` from `main` via `.github/workflows/deploy-pages.yml` to `https://michaelyeh507.github.io/OmniSight/` (Pages source must be set to "GitHub Actions" once in repo settings).

## Commands

```bash
# viewer (run from viewer/)
npm install
npm run dev            # http://127.0.0.1:5173/OmniSight/?mode=commander&scene=box
npm test               # node --test: format round trips, validator self-test, merge helpers
npm run build          # vite build -> dist/
npm run stress         # writes the gitignored 800k-point stress scene
npm run reverse        # adb reverse tcp:5173 tcp:5173, then on the Samsung: http://localhost:5173/OmniSight/?mode=ar&scene=box
npm run phone          # reads window.__omni from the Samsung over USB (-- --watch 5 --for 10 logs a heat soak)
npm run load -- <scene> [--t s] [--params "k=v&..."] [--eval "<js>"]   # headless load of one scene: report + screenshot (B5 acceptance)
npm run render -- <scene> [--params "cam=fixed&campos=x,y,z&camat=x,y,z&wall=-x:-0.69"] [--fov 43.6] [--xray-at 7] [--bg clip.mp4 --bg-stretch 1.00411] [--stills 5,7.2,9] [--out f.mp4]   # phone-screen mp4 (AR HUD, footage behind the page, scripted camera -> x-ray switch) via ffmpeg; --capture for the caption-only look
npm run composite -- --render 3d.mp4 --outside wall.mp4 --cross <s> [--fade 4 --floor 0.18 --stretch 1.00411]   # wall footage fading to the 3D render
npm run qr             # public/qr.png for the deployed commander view (-- --scene <name>)
node scripts/make-scene.mjs --out public/scenes/<name> --points 20000 --duration 20 --person 5:12 [--sources 2]
node scripts/validate-scene.mjs public/scenes/<name>
node scripts/resplit-scene.mjs --in public/scenes/<a> --out public/scenes/<b> --wall-z <z>   # re-bucket a scene at another wall plane
node scripts/fit-outlines.mjs public/scenes/<name> --png topdown.png   # candidate object boxes -> <scene>/outlines.json, then name them by hand
# never write into viewer/public (pipeline output, scene copies) or edit src/ while npm run render is capturing: the dev server reloads the page

# python lanes (run from the repo root)
pip install -r requirements.txt          # A, and C for common/tools
pip install -r requirements-people.txt   # C
pytest common
python -m tools.make_fake_scene --out viewer/public/scenes/fake
python -m pipeline.run data/raw/<take> --out data/scenes/<scene> --voxel 0.025 --wall-z -1.8 --stride 3 --camera-convention opencv   # Stray Scanner poses are OpenCV axes; write outside viewer/public (the dev server's watcher blocks the final rename), then copy the folder in
python -m people.run data/raw/<take> --out people_out/<take> --stride 2 --camera-convention opencv   # same convention as the export; people_out/ must exist; masked export then uses --stride 4
```

Viewer URL parameters: `mode=ar|commander`, `scene=<folder>`, `t=<s>`, `speed=<x>`, `budget=<max points>`, `psize=<size multiplier>`, `round=1`, `portal=0`, `portaldebug=1` (portal in commander mode, verification only), `bench=1`, `look=xray|color|blueprint`, `cutaway=0|1` (commander doll-house clip, default on), `fbscale=<xr framebuffer scale>`, `ax/ay/az/ayaw` (alignment override), `capture=1` (only the caption stays; key `h`), `cam=follow` (first person on the recorded path) or `cam=fixed&campos=x,y,z&camat=x,y,z` (still camera; both hide helpers and cutaway), `fov=<deg>`, `cutx=<x>` (hide points with x below) and `cuty`/`cutz` (override the doll-house clips), `wall=<[-]x|y|z:value | nx,ny,nz,d>` (the portal's wall plane, normal pointing to the outside; default `z:wall_z`; room012's door wall from the corridor is `-x:-0.69`), `xray=0` (start in the camera view, nothing revealed; HUD X-ray button or key `x` toggles, the portal irises open), `ui=ar` (commander only: phone-screen preview, AR HUD over a transparent page, for renders), `outlines=0` / `outlinelabels=0` (hide the hand-annotated red object outlines from `<scene>/outlines.json`, or just their tags), `map=0` (hide the team map), `portal=soft|ring|0` (soft feathered gaze spot is the default; `ring` is the old hard hole with the cyan rim), `portalr=<m>`, `campath=t:x,y,z@ax,ay,az;...` (scripted camera for renders), `feed=1` (synthetic camera-feed layer for renders), `view=camera|xray|natural` (the radial selector's state; key `m` opens the wheel, 1/2/3 pick), `mapsize=<px>` (minimap-only showcase render), `hud=0`, `renderer=spark` (Dev C's optional splat path, never the default). `npm run smoke` (dev server running) drives headless Chrome through commander, ghosts, responder, portal, AR fallback and alignment checks and writes screenshots under `viewer/node_modules/.cache/omni-smoke-*`. `window.__omni` exposes clock, fps, drawn points, manifest and errors for debugging (Chrome `chrome://inspect#devices` for the Samsung).
