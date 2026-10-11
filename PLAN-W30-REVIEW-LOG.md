# W30 plan review log (append-only)

Started 2026-10-11 by /spec. MAX_ROUNDS = 2 (rendering-only change, no schema, sim or concurrency risk).

## Round 1 — Codex (GPT-6.1 Sol · xhigh, thread 01a12baf-5280-7940-ab2b-64aaaeb3c735)

The plan needs revision. I found eight concrete issues:

1. **Model-maker UVs can be discarded.** `Builder.add()` transforms the geometry, then `finish()` unconditionally replaces its UVs. A read-only probe confirmed supplied UVs disappear. [kit.ts:258](/Users/codepanda/Projects/worktrees/bulwark-w30/game/src/render/workshop/models/kit.ts:258)  
   **Fix:** Add a per-part UV mapper applied after `finish()`, before merging.

2. **The existing corner triangulation cannot accurately interpolate angular progress.** Assigning polar UVs to the current `arc()` vertices produced a maximum centre-line error of **0.239 tiles**, against the proposed 0.02 tolerance. These are long triangles across the annular surface. [buildings.ts:410](/Users/codepanda/Projects/worktrees/bulwark-w30/game/src/render/workshop/models/procedural/buildings.ts:410)  
   **Fix:** Build subdivided radial quad strips and test barycentrically interpolated UVs; a 20-segment alternative measured below 0.018 error.

3. **Join seams remain unresolved.** A join lane travels only 0.19 tiles before reaching the main surface. Its inward-flow phase is constant across that boundary, whereas the main surface’s `v = x + 0.5` varies across it. Matching tile endpoints cannot remove this internal discontinuity. [buildings.ts:396](/Users/codepanda/Projects/worktrees/bulwark-w30/game/src/render/workshop/models/procedural/buildings.ts:396)  
   **Fix:** Fade chevrons through the junction or define a transition mapping, and test every incoming boundary at several texture offsets.

4. **Splitter chevrons would indicate an output that does not exist.** The proposed straight surface points forward, but `outputDirs()` sends splitter items only left and right. Its existing marker also includes a forward arrow. [kinds.ts:251](/Users/codepanda/Projects/worktrees/bulwark-w30/game/src/sim/kinds.ts:251), [models.ts:284](/Users/codepanda/Projects/worktrees/bulwark-w30/game/src/render/models.ts:284)  
   **Fix:** Give splitters side-output flow markings, correct the marker and include splitters/mergers in the tests.

5. **`EffectClock.dt` cannot maintain belt speed at higher speeds or lower frame rates.** It clamps *after* multiplication by speed. Executed probes accumulated only 6 seconds at 60 fps/10× and 2 seconds at 20 fps/3× during one real second. [anim.ts:180](/Users/codepanda/Projects/worktrees/bulwark-w30/game/src/render/anim.ts:180)  
   **Fix:** Expose a separate belt advance without the post-speed clamp, retaining pause and reset handling.

6. **The scrolling assertion does not discriminate.** Belt speed is **4 tiles/s**: after one second, forward, reverse and stationary offsets all equal zero modulo one; the 2× assertion aliases identically. [PLAN-W30.md:62](/Users/codepanda/Projects/worktrees/bulwark-w30/PLAN-W30.md:62)  
   **Fix:** Assert intermediate, non-integral displacements and require stationary and reversed implementations to fail those same assertions.

7. **The browser check proves debug-state movement without proving rendered movement.** A changing offset returned by `beltFlow()` could pass even if the displayed material uses another texture; reversing that debug state would still satisfy the negative-control requirement. [PLAN-W30.md:64](/Users/codepanda/Projects/worktrees/bulwark-w30/PLAN-W30.md:64)  
   **Fix:** Read the actual drawn material’s map and add a rendered-motion check that fails when that map is frozen or detached.

8. **The canvas-pixel test lacks a runnable environment.** Vitest uses Node, where the executed probe found `OffscreenCanvas` undefined; the texture factory requires it. [vite.config.ts:36](/Users/codepanda/Projects/worktrees/bulwark-w30/game/vite.config.ts:36), [materials.ts:65](/Users/codepanda/Projects/worktrees/bulwark-w30/game/src/render/workshop/models/materials.ts:65)  
   **Fix:** Move real canvas-pixel assertions into the browser checker.

The Verify shell syntax passes `bash -n`. On the untouched tree it would stop at the missing W30 tests; the flow checker is also absent. That establishes scaffolding failure, not feature discrimination.

The shared-texture approach itself is sound: baking preserves UV attributes, cut materials retain the same map, icons use a separate atlas and previews draw lines. Extra texture clones or batching changes are unnecessary.

No files modified. Findings were checked with read-only Node probes using installed Three.js 0.186.1; the full install/build/browser Verify was not run.

VERDICT: REVISE
### Claude's response

Accepted: 1 (UV mapper after `Builder.finish()`), 2 (subdivided corner strips, barycentric test), 4 (splitter outputs only left and right: splitter and merger surfaces get their own flow, splitter marker's forward arrow removed), 5 (separate belt phase, no post-speed clamp), 6 (non-integral displacements, stationary/reversed must fail), 7 (browser check reads the drawn mesh's material and proves rendered pixel motion, with a frozen-map negative control), 8 (canvas-pixel assertion moves to the browser check).

Partly rejected: 3. A fade or transition mapping through the join is more than this needs. The join lane is 0.19 tile long and meets the main surface at a rail gap, where a real belt join also shows a phase change. Kept: lane v runs inward and continues the incoming belt's phase at the tile edge (seam-tested there); the lane/main boundary is allowed to change phase, and Richard judges it at sign-off.

## Round 2 — Codex (resume of the same thread)

The UV, corner, canvas and non-integral scrolling-test changes address their original mechanisms. The scene-map and pixel checks also improve finding 7. I accept the permitted internal join phase change; requiring a fade would exceed that revised requirement.

Three issues remain:

1. **The splitter material needs a distinct renderer model.** Splitters still map to `'belt'`, and the constructor only invokes makers named by that mapping. An executed render probe recorded **zero splitter-maker calls** and drew `w17/belt/belt-cut`. Changing `BUILDING_MAKERS.splitter` alone would therefore have no effect. [models.ts:124](/Users/codepanda/Projects/worktrees/bulwark-w30/game/src/render/models.ts:124), [models.ts:465](/Users/codepanda/Projects/worktrees/bulwark-w30/game/src/render/models.ts:465)  
   **Fix:** Register and select a separate splitter model, and assert material separation on an actual rendered splitter instance.

2. **The new clock needs raw frame time from the application.** `main.ts` already caps the supplied `dt` at 0.1 seconds; the renderer currently receives that value and the clamped effect clock. Reusing either would defeat the proposed 0.25-second cap. A 200 ms frame would advance 0.4 tiles instead of the required 0.8, while isolated phase tests could pass. [main.ts:1250](/Users/codepanda/Projects/worktrees/bulwark-w30/game/src/main.ts:1250)  
   **Fix:** Explicitly pass raw frame time, runner speed and pause/reset state to the belt updater, and add an integration assertion for a 200 ms frame.

3. **The corrected high-speed clock exposes temporal aliasing.** At the plan’s **20 fps/10×** test rate, scrolling advances exactly **two texture repeats per frame**: the rendered pattern remains stationary although the phase correctly advances 40. With identical chevrons, 30 fps/10× can appear reversed. [PLAN-W30.md:66](/Users/codepanda/Projects/worktrees/bulwark-w30/PLAN-W30.md:66)  
   **Fix:** Define a bounded visual scroll rate, document its exception to physical belt speed, and test rendered motion at 20/30 fps and 10×.

Verify now contains a genuinely discriminating 0.4-phase assertion, but its high-speed counter assertion does not prove visible motion. The shell syntax passes. Read-only probes were executed; no files were modified, and the full install/build/browser Verify was not run.

VERDICT: REVISE
### Claude's response

All three accepted. Splitter gets its own registered model and the test checks a rendered splitter instance. `main.ts` passes raw frame time to the belt updater, with a 200 ms integration assertion. Per-frame scroll capped at 0.2 tile (under half the 0.5-tile chevron period) to stop aliasing; this replaces R1 #5's "no loss to a clamp" test, because decorative chevrons running slower than items at high speed is preferable to chevrons that look still or reversed. Items still show true belt speed.

MAX_ROUNDS (2) reached with no point in dispute; plan locked 2026-10-11 by Claude (Opus 5.5 · medium session). Codex consented to round-1 changes and raised only new, accepted issues in round 2; it did not issue APPROVED on the final text.
