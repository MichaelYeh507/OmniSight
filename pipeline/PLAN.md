# Dev A implementation and phase handoffs

Authority: master design document, Dev A lane; `docs/CONTRACT.md`; skeleton signatures.
Scope: `pipeline/` only. B and C implement their own lanes concurrently.

- [x] Phase 1 implementation: validated Stray Scanner loader, sequential RGB decoding, depth intrinsics,
  normalized poses, shared unprojection, extracted frames and a two-frame PLY command.
- [x] Phase 2 implementation: confidence/range/edge filters, camera-facing normals, voxel dedupe,
  wall split, half-second chunks, trajectory, manifest, one-command processing.
- [x] Phase 3 implementation: dilated person masks, floor percentile, viewer point budget, multiple
  recordings from the same physical jig, source provenance.
- [x] Verification: analytic geometry and real encoded synthetic recording tests;
  independent binary parsing via a test-only reference writer while C's writer is a stub;
  actual shared-writer integration test activates once C implements it.
- [x] Handoff: document exact Python APIs and phase integration commands for B/C.

Decisions: normalized poses are three.js/ARKit camera-to-world. Unprojection converts
OpenCV depth coordinates once, internally. Yaw-only normalization preserves gravity;
the first pose has zero position and zero horizontal heading, but retains pitch/roll.
This follows the frozen world-frame definition; the proposed identity-pose clarification
is only true for a level initial camera. Missing requested masks fail rather than leak
people into the static scene. C must process every A-selected frame or match A's stride.
No automatic fallback writer in production: use C's pinned `write_chunk` directly.

Review: independent code review identified nonzero initial source IDs as incompatible
with the skeleton clarification. Added two failing regressions, then required source
0 at both CLI and exporter boundaries. Fusion still accepts any valid per-take ID.

Physical phase exit checks remain open: no iPhone recording, B validator/viewer
implementation or C writer/people implementation is present in this checkout.
