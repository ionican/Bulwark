# Plan: W30 — belts show their direction of travel

Branch `w30-belt-direction` from `origin/main` at `c72d409` (build 163, W29 merged). Worktree `~/Projects/worktrees/bulwark-w30/`. Ticket: Wayfinder Map W30.

## Goal

Richard, after playing build 163: "the belts need an animation to show the direction of travel." Every built belt tile shows chevrons (arrow marks) on its surface that move forward along the belt's flow, so the player can tell which way each belt carries material at a glance, on straights, corners and joins.

Decided by Richard (2026-10-11, this session):

- **What moves:** chevrons on the belt surface, scrolling forward at belt speed. Direction is readable on a still frame because the chevrons point forward.
- **When it moves:** every belt runs all the time while the game runs; all belts stop when the game is paused. A blocked or empty belt is not drawn differently.

## Approach

1. **Chevron texture.** Replace the cleat stripes in `beltTexture()` (`game/src/render/workshop/models/materials.ts`) with forward-pointing chevrons over the dark belt rubber, keeping the existing colours. The texture's v axis is the flow axis; chevron tips point toward +v. Two chevrons per tile: one texture repeat = 1 tile of travel, so the pattern tiles across tile edges.
2. **Flow UVs on every belt surface.** `Builder.finish()` (`render/workshop/models/kit.ts:258`) overwrites UVs, so a supplied UV is lost (Codex R1, probed). Add a per-part UV mapper that runs after `finish()` and before merging, and use it on the belt-surface parts only: v = progress along the flow in tiles, u = across the belt (0..1).
   - straight piece main surface (`straightBelt`, model +x is the flow): v = x + 0.5.
   - join lanes (the side surfaces on open sides): v runs inward, 0 at the tile's outer edge (continuing the incoming belt's phase there) to the lane's inner end at the main surface. The lane/main boundary may change phase (see Key decisions).
   - corner (`cornerBelt`): replace the `arc()` slab for the belt surface with a subdivided strip of radial quads (≥ 20 segments) so that interpolated v follows the angle fraction p from the input edge (0) to the front edge (1), the same p `itemOnBelt` (`render/beltShapes.ts`) uses. The existing triangulation interpolates with up to 0.239 tile error (Codex R1, probed). Rails and caps keep `arc()`.
   - **merger:** straight UVs (it outputs forward; `outputDirs`, `sim/kinds.ts:252`).
   - **splitter:** it outputs only left and right, never forward, so forward chevrons would be wrong. It gets its own registered model (today `models.ts:124` maps splitter to `'belt'` and the splitter maker is never called — Codex R2, probed), whose surface uses a non-scrolling copy of the belt material with plain rubber (no chevrons); its marker (`beltMarker`, `render/models.ts:271`) shows direction. Its marker's forward output arrow is removed, because no items leave the front.
3. **Scrolling.** A belt phase owned by the renderer advances each frame by `min(frameSeconds × speed × BELT_TILES_PER_SECOND, 0.2)` tiles: 0 while paused, no jump on a reset or rewind (`ResetWatch` semantics from `render/anim.ts`). `main.ts` passes the **raw** frame time, the runner's speed and pause/reset state to the belt updater; it must not reuse `main.ts`'s 0.1 s-capped `dt` (`main.ts:1250`) or `EffectClock.dt` (Codex R2). The per-frame cap of 0.2 tile (less than half the 0.5-tile chevron period) prevents temporal aliasing: without it, 20 fps at 10× advances exactly two repeats a frame and the chevrons look still, and 30 fps at 10× can look reversed (Codex R2). So at high game speed or low frame rate the chevrons run slower than the items; the items show true belt speed. The belt texture's `offset.y` = −(phase mod 1). One shared material, one value per frame, whatever the belt count.
4. **Debug hook.** `__game.beltFlow()` returns, read from the scene graph, the `map.offset.y` of the material actually drawn on a straight belt mesh and on a corner mesh, the phase, and whether they share one texture. `__game.debugRender` gains two negative controls for the browser check: `beltFlowFrozen` (phase stops) and `beltFlowReversed`.

## Key decisions & tradeoffs

- **Shared texture offset, not per-instance state.** Follows from "all belts always run". Cost is O(1) per frame. Per-tile stopping (the rejected option) would need a per-instance attribute fed from the simulation.
- **Flow-space UVs rather than per-shape shader maths.** Keeps the standard material and its lighting; only geometry UVs change. The alternative (a custom shader computing flow from world position and a per-instance direction) is heavier and breaks corners.
- **Corner v uses angle fraction, not arc length.** The centre-line arc is π/4 ≈ 0.785 tile, so arc-length v would leave a seam at the corner's exit; angle fraction makes every tile one period long and matches item motion. Chevrons compress slightly on the inner edge and stretch on the outer edge of a corner, which is what a real curved belt looks like.
- **Join seam allowed.** The join lane is 0.19 tile long and meets the main surface at a rail gap. Its chevrons run inward and change phase where they meet the main belt's chevrons, as a real belt join does. A fade or transition mapping (Codex R1 #3) was rejected as more than needed; Richard judges it at sign-off.
- **Splitter shows still rubber and its marker.** Its items leave left and right, so neither a forward scroll nor a single flow direction fits one surface. The marker's forward arrow was wrong already and is corrected.
- **Under-construction belts.** If a started belt draws with the same `belt` material, its chevrons move too. Accepted unless Richard objects at sign-off; the author reports which it is.

## Risks & open questions

- `beltTextureRef()` is exported; any other user of the texture (icons, previews) would scroll as well. The author lists every user and keeps the scroll on the game's belts only (clone the texture if needed). Prior art: the W17 look prototype already scrolls this texture (`look/src/main.ts:246`, `offset.y = −simT × 0.25`); the game never ported it. `look/` uses its own copy of `materials.ts`, so `look/` keeps compiling (`tsc` in the Verify) but is not otherwise changed.
- Instanced belt models may be merged into a batch with other `belt`-material parts (`w17Batches.ts`); the flow UVs must survive the merge.
- Strategic zoom: belts become icons (`models.ts` icon path, already turned by `BELT_YAW`); no animation there. Not changed by this ticket.
- Texture minification at mid zoom may blur chevrons into grey; mipmaps are on by default. Visual sign-off by Richard decides whether it reads.

## Out of scope

- Belts stopping when blocked or empty (Richard chose "always run").
- Changing belt icons at strategic zoom, the drag preview or reserved-site outlines.
- Any simulation change. `game/src/sim/` is not touched; the W12/W29 fingerprint and determinism tests must stay byte-identical.

## Verify command (frozen, re-runnable)

```
bash -c 'cd ~/Projects/worktrees/bulwark-w30/game && npm ci --no-audit --no-fund >/dev/null && \
npx vitest run "test/w30-" && npm test && npm run build && \
(cd ../look && npm ci --no-audit --no-fund >/dev/null && npx tsc --noEmit) && \
test -z "$(git diff --name-only c72d409 -- src/sim)" && \
node scripts/check-render.mjs --no-build && \
node scripts/check-belts.mjs --no-build && \
node scripts/check-belt-flow.mjs --no-build --shots "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Rick'"'"'s World/Resources/Bulwark Art Reference"'
```

`test/w30-*.test.ts` (written first, red before the change), in Node:

1. For each of `belt`, `beltCornerR`, `beltCornerL`, `beltJoinR`, `beltJoinL`, `beltJoinLR` and the merger: the built belt-surface mesh carries flow UVs (not the `finish()` defaults); v increases along the flow (straight: with +x; join lanes: toward the main belt; corners: from the input edge to the front edge).
2. Corners: at sample points across the surface (several radii, ≥ 30 angles), v interpolated barycentrically from the triangle that contains the point equals `itemOnBelt`'s p for that angle within 0.02.
3. Seams: v at the front edge of every shape ≡ v at the back edge of a straight (mod 1, within 0.01); a join lane's v at its outer edge ≡ the front-edge v of a straight feeding it.
4. Splitter: on an actual rendered splitter instance (through the renderer's model selection, not the maker alone), the surface material is not the scrolling one; its marker has no forward output arrow.
5. Belt phase: frames of 0.1 s at speed 1 advance 0.4 each (non-integral, so a stationary or reversed phase fails); a single 200 ms raw frame at speed 1 through `main.ts`'s frame path advances 0.2 (the cap; it would be 0.4 with the 0.1 s `dt`); at 20 fps and 30 fps at 10×, every frame advances more than 0 and at most 0.2; 0 while paused; no jump on a reset or rewind.

`scripts/check-belt-flow.mjs` (agent-browser, own session `w30flow`, strict port 8842, closes only its own session), in the sandbox:

- lays an L-shaped belt and a line joining it from the side with real mouse drags (as `check-belts.mjs` does);
- `__game.beltFlow()`: the drawn straight and corner meshes share the scrolling texture; its offset moves in the −v sense by the expected amount between two samples while running, and does not move while paused;
- rendered motion: the canvas pixels over a straight belt tile and over the corner tile differ between two running samples and are identical between two paused samples; repeated at game speed 10× so aliasing would be caught;
- chevron orientation, from the texture's canvas in the page: along the centre column each chevron's tip is at higher v than its arms;
- negative controls: with `beltFlowFrozen` the running-motion assertions fail; with `beltFlowReversed` the direction assertion fails (the script asserts that it catches both);
- 0 console errors; close-ups `w30-belt-straight.png`, `w30-belt-corner.png`, `w30-belt-join.png`, `w30-splitter.png` for Richard.

Red on the current tree: `npx vitest run "test/w30-"` finds no files (exit 1) and `scripts/check-belt-flow.mjs` does not exist. After the tests-first commit the author reports one failing assertion per test, not a missing import alone.

Look-and-feel needs Richard's sign-off on the screenshots and in the game; the Verify proves function only.

## Author split

All to `/implement` (the `author` subagent, Opus 5.5 · high). Bulwark is not IMS, so `/sveltify` does not apply; the visual judgement is small and bounded by the screenshots above.
