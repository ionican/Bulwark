# W24 run 2a: author notes

Branch `w24-sandbox`, worktree `~/Projects/worktrees/bulwark-w24/`. Spec: `../PLAN.md` "Run 2a — ground,
lighting and static models". Base commit `d0ff07f`. `game/src/sim/`, `model/` and `look/` are unchanged
(`git diff d0ff07f -- game/src/sim model look` is empty); the fingerprint comparison against `60ebba6` is
identical.

## What is where

| Area | Files |
|---|---|
| Ported workshop code (copies, adaptations listed) | `src/render/workshop/` and its `README.md` |
| Renderer lifecycle: WebGLRenderer, W21 post stack, quality, resize, per-pass CPU timing | `src/render/adapter.ts` |
| Scene per mode (models, or `?greybox=1`) | `src/render/view.ts` |
| One ground: sampler, ray picking | `src/render/ground.ts`, `src/render/picking.ts` |
| Map mesh with masks, scenery, outcrops, paving texture | `src/render/groundView.ts`, `workshop/world/terrainMaterial.ts` |
| Every kind from snapshots, construction cut, plinths | `src/render/models.ts`, `w17Batches.ts`, `materials.ts` |
| Wall layout key | `src/render/wallLayout.ts` |
| Icons for every kind | `src/render/icons.ts` |
| Scene inspection, frame cost | `src/render/inspect.ts`, `src/render/cost.ts` |
| Tests (criteria 1–8) | `test/w24r2a-{imports,models,ground,walls,capacity}.test.ts`, fixtures `test/w24r2a-fixtures.ts` |
| Scripts | `scripts/fingerprint-compare.mjs`, `scripts/check-render.mjs` |

## Criteria and where each is checked

1. Snapshot-only: `w24r2a-imports` walks the value-import graph of `src/render/**`; the simulation modules it
   reaches are `kinds`, `balance`, `schema`, `table`, `terrain`, `rng` only. `world.ts`, `snapshot.ts`,
   `gate.ts`, `sandbox.ts` and the rest are not reached. The capacities come in from `main.ts`.
2. Scene inspection: `inspect.ts` walks the scene graph (visible meshes, instanced batches with count > 0,
   material names, world instance matrices) and attributes instances to entities by position.
   `w24r2a-models` asserts all 25 inventory kinds have model instances on every entity, icons at level 3,
   no greybox; a positive control shows the inspection finds greybox when W13's renderer draws.
3. One ground: `w24r2a-ground` — 2,000 points (one on each of the 450 rock/ground tile edges, the rest at
   random) against the mesh's own
   triangles from its index and position buffers, worst error < 1e-4; 200 screen picks against a three.js
   raycast of the mesh, < 0.01; engineer and commander feet, boot instances, alien and building bases.
4. Edges and foundations: ring 0 of the scenery is the map's edge vertices (same indices); every perimeter
   segment is a scenery triangle edge; the plinth of a 4 × 4 building on the steepest 4 × 4 ground on map 1
   (drop measured > 0.5 tiles) spans the highest to below the lowest ground under it.
5. Wall layout key: `w24r2a-walls` — HP-only and progress-only 0 rebuilds (damage and cut change on the
   instances); tile added, removed, tier, reserved → started, wall → gate, gate axis on the same 3 × 3
   footprint: 1 rebuild each.
6. Construction: two sites at 0.25 and 0.75 for a W17 building, a kit turret and a wall: one cut each,
   (cut − base) in ratio 3, complete buildings uncut; a reserved site is the outline only.
7. Turrets: the five kinds' parts, pivots, offsets, frames and triangle counts equal `look/src/kit`'s full
   kit (imported at run time); per level the submitted batches are exactly the kind's parts; the base sits
   on the footprint centre at the base height; turning to a new target moves only yaw-driven parts.
8. Capacity: the building table full of walls (4,096: 16 runs 64 × 4) in each state × tier × level, the
   submitted part instances equal W23's autotiler on an independent grid; 4,096 gun turrets; 4,096 belts,
   4,096 aliens, 256 units; icons; no overflow.
9. Browser: `check-render.mjs` (results below).
10. Screenshots: below.
11. `fingerprint-compare.mjs 60ebba6`: identical (sandbox 68, stress 14, map 1 30 hashes). Mutation check:
    commander build power 8 → 9 made it report "DIFFERS in 91 entries" (then reverted).

## Budgets (game camera x 64, z 62, distance 50, yaw 0; medium; 1440 × 900, pixel ratio 1; codepanda M1 Max, ANGLE Metal, headless Chrome)

Measured by `__game.renderCost()`: forced-completion timing (each render followed by a 1-pixel readPixels),
configurations interleaved over 7 rounds, medians; the sandbox fixture of `check-render.mjs` in view.

| Run | Terrain + scenery (≤ 5 ms) | Ground alone, no post | Post (≤ 3.5 ms) | Full frame |
|---|---|---|---|---|
| check-render, shots run 1 | 2.68 ms | 2.41 ms | 2.00 ms | 7.04 ms |
| check-render, shots run 2 | 2.69 ms | 2.42 ms | 2.09 ms | 6.98 ms |
| final Verify (check-render) | 2.67 ms | 2.41 ms | 2.22 ms | 7.09 ms |

Both within budget. The post split by pass (frame minus the frame without it) is within the noise except
ambient occlusion: N8AO 0.98–1.23 ms, bloom + tone map 0.00–0.21 ms, SMAA −0.16–0.12 ms, remainder (half-float
scene target and copies) 0.67–1.15 ms. An earlier version of the measurement ran each configuration once in
sequence; its figures drifted with the GPU clock (terrain 4.04–4.81 ms, post 3.38–4.37 ms, full 8.4–9.2 ms
across three runs, post over budget in two) and the per-pass parts did not add up, so it was replaced by the
interleaved medians above. Those earlier figures are an upper bound, not the measurement.

## Static benchmark (not gated)

Stand-in for the 2b population, which is not defined yet: the W13 stress scene (`/?stress=1`: 300 buildings,
500 aliens, 3 units), paused, medium, 1440 × 900.

| Camera | fps (display-capped) | Forced-complete frame | Uncapped equivalent | Draw calls |
|---|---|---|---|---|
| Game camera | 60–61 | 7.14–7.22 ms | 139–140 fps | 375 |
| Full zoom-out (distance 200) | 61 | 8.73–8.78 ms | 114–115 fps | 177 |

## Screenshots

`Rick's World/Resources/Bulwark Art Reference/` (by `check-render.mjs --shots`; UI hidden): `w24-2a-base-wall-run-gate`,
`-game-camera`, `-turrets-gun-area-beam`, `-turrets-heavy-shield`, `-turret-lookout-temporary`, `-gate-and-units`,
`-economy-generator-lab-extractor`, `-chain-depot-shredder-smelter-assembler`, `-belt-splitter-merger`,
`-aliens-static`, `-strategic-zoom`, `-map-edge-north`, `-map-edge-east` (13 PNGs, 1440 × 900).

## Decisions (the plan left these open)

- **Kit turrets go through W23's part batches**, not W22's `strategies.ts` class. W23's `PartBatches` is the
  same structure (one batch per part × material × level, shared by every kind using the part) with W23's
  per-instance glow, damage and construction cut, which the kit's own batches lack. `strategies.ts` is not
  ported.
- **Footprint scale of the kit turrets**: modelled for 2 × 2; heavy cannon (3 × 3) drawn at 1.35 ×,
  temporary turret (1 × 1) at 0.6 ×, about the footprint centre.
- **Building base** = the highest ground under the footprint (grid vertices: the surface is linear per
  triangle); plinth from there to 0.08 below the lowest. Flat footprints get no plinth.
- **Triangulation** kept W13's diagonal, so the greybox view's mesh and the model view's mesh are the same
  surface and one sampler serves both.
- **Static pose**: W17 models' parts are baked once (pivots, no motion) into one geometry per material;
  rigs are placed at rest every frame (feet planted on the sampled ground); extractors in their idle pose;
  doors closed; turret yaw towards the target, kept when there is none, north for a new turret.
- **Damage states** on complete buildings: below 2/3 of the hit points scuffed, below 1/3 heavily damaged.
- **Shadows**: the playable ground does not cast (gently rolling); outcrops cast on medium and high.
- **Paving** is a per-tile texture under complete buildings (any kind), updated when the set changes.
- **Scenery**: north-east (where the waves come from) the plateau ends in a cliff over a canyon floor whose far
  side climbs in terraces; south-west terraces climb from the edge; each entry has a ramp down to the floor.
- **Detail levels**: W23's thresholds per asset (walls, gates, extractors, turrets 24 / 85 / 160 tiles;
  engineers 14 / 45 / 95; commander 40 / 120 / 220); W17 buildings, aliens and wrecks: model, or icon beyond
  160 tiles. Engineers and the commander get their icon over them from simple detail.
- **Icons**: one atlas: W23's icons, the five kit icons, and new shape-coded ones (`icons.ts` header lists
  the shapes); constant pixel size; turned to screen-up, the turret's aim or the belt's direction.

## Deviations and things to check

- Render code takes the simulation's capacities from the caller: `Interpolator(capacity)` and
  `EntityRenderer(scene, terrain, capacity, maxSpawnOrigins, { models })`. Existing tests changed:
  `test/interp.test.ts` and `test/w24-review.test.ts` pass `CAPACITY` (and `MAX_SPAWN_ORIGINS`). No other
  existing test changed; `test/picking.test.ts` passes unchanged against the new ground.
- `__game.place(kind, tx, ty, dir)` added (debug): it sends the simulation's existing `place` command. The
  browser check uses it to put every building kind down complete.
- `vite.config.ts`: `resolve.dedupe: ['three']`, so the criterion 7 test's run-time import of `look/src/kit`
  uses the game's three. That test needs `look/src` present, not `look/node_modules`.
- The W13 overlays stay in the model view: health bars, beam and work lines, shots, the shield dome, routes,
  selection markers, entry chevrons and labels, the upgrade scaffold frame and the placement ghost (W13's
  simple shapes). They are not inventory kinds; animation and effects are run 2b, the panel run 3.

## Known gaps

- No kind of the inventory is drawn as a placeholder. Wrecks (not in the inventory) use W21's debris.
- The terrain weathering patches (rock_face texture where the noise mask is high) read blotchy from far out;
  the sand photo's tiling shows at the full zoom-out.
- The scenery's north-east/south-west blend shows at the north-west and south-east corners.
- The look needs Richard's sign-off; a green Verify is not a visual pass.

## Richard's feedback round (8 Oct, after the first screenshots)

1. **Camera.** The workshop camera's feel (`look/src/render/camera.ts`: OrbitControls, damping 0.08, at
   most 80° from vertical, ground-plane panning). `render/cameraRig.ts` `Orbit` applies OrbitControls'
   rotate, pan and dolly equations with the same damping to the game's `Rig`, which now carries the
   user's `pitch` (10°–89° above the horizon); distance limits kept at the game's 10–200 tiles (the
   map is 128 across; the workshop's 3–400 would let the camera inside a turret or past the haze).
   `pitchFor` is only the tilt of a preset view and of a rig without a pitch. `src/input.ts` decides
   per press: left-drag orbits, right-drag pans, middle-drag dollies, Shift + left-drag box-selects, in
   a build or upgrade mode left-drag lays the wall run (`buildRun`) or belt line; a press that moves
   5 px or less is a click (select, place, order or cancel as before) and sends nothing to the orbit.
   OrbitControls itself is not attached: its own pointer handlers would rotate on a click's jitter
   and take the left button from box selection and building. Wheel zoom to the cursor, WASD, edge
   pan, Q/E and Home kept. Tests: `w24r2a-camera.test.ts`; `check-render.mjs` repeats the click, box,
   build-drag, orbit and pan with real mouse input (Shift by pointer events).
2. **No routes.** `entities.ts` draws no route markers in either view; the simulation still computes
   routes and the snapshot still carries them. Test: no route geometry in any scene.
3. **Undulation.** `sim/terrain.ts rollingHeight`: value noise at 37, 17 and 7 tiles (heights now
   0.74–4.79 tiles, was 0.41–3.93), flattened to 30 % within 10 tiles of the base and to 40 % within
   2.5 tiles of each deposit centre. Integer hashing and polynomial smoothing as before. Nothing in
   the simulation reads heights (only `save.ts` stores them, and only for non-map-1 terrain); tiles and
   the rock RNG are unchanged. `fingerprint-compare.mjs 60ebba6` stays IDENTICAL in strict mode, so no
   heights-excluded mode was needed. Scenery: `rollingHeight` carries the ground on past the edge;
   the canyon country starts 3–33 tiles out on a noise outline, distances measured from the map
   rectangle (round corners; ring normals turn gradually at the corners); north-east cliffs over a
   floor with terraced mesas, south-west terraced hills; only the hills are terraced. Entry ramps kept.
4. **Aliens.** `materials.ts` `alien` set: hull `#8f8a84`, metalness 0.4, roughness 0.55; trim
   `#c2c3c8`; both with a warm rim light. The hunter's dart still reads dark from some angles.
5. **Texture.** No weathering mask, no rubble patches on the flats, sand photo detail fades between 60
   and 170 tiles from the camera.
6. **Walking** (from run 2b). `render/walk.ts`: per slot the last drawn position, a heading turning
   towards the movement (smoothed), and for aliens W21's gait phase advanced by distance × the kind's
   rate (rusher 5.5 rad per tile, as W21; hunter 2.5, breaker 3.9, saboteur 3.0 for the hover bob,
   wheels and drill). The W23 rigs walk: `update(dt, x, z, heading)` with the interpolated position,
   so the gait advances by distance and planted feet stay on their touchdown points on the sampler;
   idle when standing. Reset (rig placed afresh, phase back to the seed's): a new id in the slot, a jump
   over 2 tiles, the snapshot tick going backwards, or a unit not drawn last frame. Paused: dt 0 and no
   movement, so nothing advances or settles. Aliens are now drawn part by part (one batch per distinct
   part geometry; a rusher's four legs share one), each part at its pivot with its motion. Tests:
   `w24r2a-walk.test.ts`. Build beams, carry poses and turret aim stay in 2b.

### Measurements in this round

The machine was under heavy load from another session (load average 9–49 during the runs), and the
forced-completion figures moved with it. An A/B with both builds served side by side and measured
alternately in one browser session (the pre-feedback commit `d04cd2c` against this tree, paused sandbox,
game camera): terrain + scenery 5.66, 3.19 ms (old) against 4.52, 5.09 ms (new); ground alone 4.82, 2.55
(old) against 3.48, 4.77 (new). The rise from the 2.6 ms of the first round is the machine, not this
change. `check-render` now measures the budget on a paused frame, three times, and reports the median.

| Run | Terrain + scenery (≤ 5 ms) | Post (≤ 3.5 ms) | Full frame |
|---|---|---|---|
| check-render with shots (three runs: 5.05, 5.00, 3.07 / 2.18, 2.03, 2.35 ms) | 5.00 ms | 2.18 ms | 10.15 ms |

Walking benchmark (sandbox, 40 engineers and 300 aliens walking, game camera, medium): scene update
0.60–0.90 ms CPU per frame (median, rigs and gait included), frame CPU 2.0–3.0 ms, 61 fps display-capped,
7.86–9.83 ms per frame forced-complete, 216 draw calls.

Screenshots (replacing the `w24-2a-*` set): `Resources/Bulwark Art Reference/w24-2a2-game-camera.png`,
`-game-camera-tilted-low.png`, `-map-edge.png`, `-aliens-close.png`, `-strategic-zoom.png`.
