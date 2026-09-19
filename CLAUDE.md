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
node scripts/make-scene.mjs --out public/scenes/<name> --points 20000 --duration 20 --person 5:12
node scripts/validate-scene.mjs public/scenes/<name>

# python lanes (run from the repo root)
pip install -r requirements.txt          # A, and C for common/tools
pip install -r requirements-people.txt   # C
pytest common
python -m tools.make_fake_scene --out viewer/public/scenes/fake
python -m pipeline.run data/raw/<take> --out viewer/public/scenes/<scene> --voxel 0.025 --wall-z -1.8 --stride 3
python -m people.run data/raw/<take> --out people_out/<take> --stride 2
```

Viewer URL parameters: `mode=ar|commander`, `scene=<folder>`, `t=<s>`, `speed=<x>`, `budget=<max points>`, `psize=<size multiplier>`, `round=1`, `portal=0`, `portaldebug=1` (portal in commander mode, verification only), `bench=1`, `fbscale=<xr framebuffer scale>`, `ax/ay/az/ayaw` (alignment override). `npm run smoke` (dev server running) drives headless Chrome through commander, ghosts, responder, portal, AR fallback and alignment checks and writes screenshots under `viewer/node_modules/.cache/omni-smoke-*`. `window.__omni` exposes clock, fps, drawn points, manifest and errors for debugging (Chrome `chrome://inspect#devices` for the Samsung).
