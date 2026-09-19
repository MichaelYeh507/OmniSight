# OmniSight

See what the first person inside has seen, in place, through the wall. An iPhone 14 Pro records a walkthrough with LiDAR (Stray Scanner). A Python pipeline turns it into a timestamped 3D map. A web viewer replays that map in AR on a Samsung phone and as a commander view on an iPad or laptop.

Three locked features: **through-wall alignment**, **person ghosts**, **staleness**. Record-and-replay, no server, no language model in the core.

- Full plan: [OmniSight Master Design Doc and Build Plan](./OmniSight%20Master%20Design%20Doc%20and%20Build%20Plan.md)
- Data contract (frozen at Phase 0): [docs/CONTRACT.md](docs/CONTRACT.md)

## Layout

| Path | Owner | What |
| --- | --- | --- |
| `docs/CONTRACT.md` | C | The data contract plus the clarifications ticked at kickoff |
| `common/omni_format.py` | C | Chunk writer/reader, people writer, round-trip test |
| `tools/make_fake_scene.py` | C | Fake room in the real format, unblocks the viewer in hour 1 |
| `pipeline/` | A | load -> normalize -> fuse -> export, one CLI command |
| `people/` | C | Person masks for A, ghost points for B |
| `viewer/` | B | Vite + three.js + WebXR, AR mode and commander mode |
| `viewer/public/scenes/` | all | Processed scenes, small, committed (the deployed site needs them) |
| `data/raw/` | A | Raw recordings, gitignored, shared via Drive |

Stubs in every lane carry the function signatures and CLI flags from the design doc. Fill in the bodies; do not rename them without telling the other two.

## Quickstart

Everyone: Python 3.10+ and Node 20+. Then your lane:

```bash
# Dev A (pipeline) and Dev C (common, tools)
pip install -r requirements.txt

# Dev C (people) - pulls PyTorch, about 2 GB, do it while the Wi-Fi is good
pip install -r requirements-people.txt

# Dev C, first hour: format library test and the fake scene
pytest common
python -m tools.make_fake_scene --out viewer/public/scenes/fake

# Dev A: one command from a raw take to a scene folder
python -m pipeline.run data/raw/<take> --out viewer/public/scenes/<scene> --voxel 0.025 --wall-z -1.8 --stride 3 --masks people_out/<take>/masks

# Dev C: masks for A, ghosts for B
python -m people.run data/raw/<take> --out people_out/<take> --stride 2

# Dev B: viewer
cd viewer && npm install && npm run dev     # http://127.0.0.1:5173/OmniSight/?mode=commander&scene=fake
npm run reverse                             # adb reverse tcp:5173 tcp:5173, then on the Samsung:
                                            # http://localhost:5173/OmniSight/?mode=ar&scene=fake
```

Viewer URL parameters: `mode=ar|commander`, `scene=<folder name>`, `t=<seconds>`, `speed=<factor>`, `budget=<max points>`, `ax/ay/az/ayaw` (alignment override).

## Handoff rule

Before handing anyone a scene folder, run the validator. It checks the byte layout, counts, time ranges, the wall split and the people index, and prints the point total against the viewer's budget:

```bash
node viewer/scripts/validate-scene.mjs viewer/public/scenes/<scene>
```

Exit code 0 means the viewer will load it.

## Deploy

`.github/workflows/deploy-pages.yml` builds `viewer/` and publishes it to GitHub Pages on every push to `main` that touches `viewer/`. One-time setup: repo Settings > Pages > Source: **GitHub Actions**. The site is `https://michaelyeh507.github.io/OmniSight/`.

## Git rules

- Short-lived branches, merge to `main` often. Stay inside your own directory unless you have told the owner.
- Commit early and often. The history is our proof the work happened this weekend.
- Never commit raw recordings. `data/raw/` is gitignored.
- Do commit processed scenes under `viewer/public/scenes/`.
- Any change to the data contract is announced to both teammates before it is merged.
