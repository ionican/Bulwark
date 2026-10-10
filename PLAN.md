# W24 — Mechanics sandbox, as the first slice of the real game

Branch `w24-sandbox` from `w23-assets` (`0192b27`), worktree `~/Projects/worktrees/bulwark-w24/`. Source of truth for design: vault `Projects/Base Defence Game — Wayfinder Map.md` ("Spec hand-off summary", Resolved entries W13, W21, W22, W23, and the 8 Oct feedback entries). Revised after Codex round 1 (see `PLAN-REVIEW-LOG.md`).

## Goal

Richard can open one page in a desktop browser and test four mechanics of the real game, with the real models:

1. **Building.** Engineers and the commander build walls, gates, turrets and extractors from orders. Dragging a wall lays a run of tiles that the selected builders build one tile at a time. Build power is 8 for the commander and 5 for an engineer. Resources drain over the build time.
2. **Economy.** Extractors, generators, salvage reclaim and the conveyor chain feed the shared pool. A toggle makes spending free.
3. **Aliens against walls.** Any alien kind can be spawned at a chosen point. Their flow-field routes go round or through walls, and are drawn. Gates open for the player's units and stay shut to aliens.
4. **Combat tuning.** Turrets fight spawned aliens. Live sliders change hit points, damage, range, fire rate, speed and build power per kind, and a readout shows kills and damage dealt per kind.

The sandbox is a mode of the real game (`game/`), not a separate prototype: the code it adds is the code the game keeps.

## Approach — three author runs, each reviewed before the next

`game/` (W13) becomes the real game: a deterministic Web Worker simulation at 10 ticks per second, commands stamped with the tick they apply to, typed-array tables, snapshots.

- **Run 1 (this plan, fully specified below): simulation and sandbox mechanics, greybox rendering.** Everything is testable headless, and the existing greybox renderer shows it, with the minimum renderer work needed to draw gates, sites and the new state.
- **Run 2: renderer port.** The W17/W21/W22/W23 models drawn from snapshots. Planned after run 1's contracts are settled (outline below).
- **Run 3: sandbox panel, real controls, browser check and performance benchmark.** Planned after run 2 (outline below).

Splitting is Codex's finding 21: run 1 alone changes footprints, orders, persistence, tuning, spawning and combat attribution, and the renderer should not be built against contracts that are still moving.

## Run 1 — simulation and sandbox mechanics

### Build power

Commander 8, engineer 5. `model/data/map1.ts` (W12) keeps 10; the game overrides it in `game/src/sim/balance.ts`, listed in `ADJUSTMENTS` with Richard's decision (2026-10-08) as the reason. Update the "commander builds at 10 BP" comments in `kinds.ts` and `map1.ts` stays untouched.

Balance check: re-run the headless scripted plans (`game/test/plans.ts`, `fullmap.test.ts`). Codex measured the balanced plan winning at tick 31,624 with 5,880 commander HP at build power 10 (round 1, read-only run). If the balanced plan no longer wins at 8, the author may change the scripted plan's build order and timing only, no balance number. If it still loses, stop and report; do not loosen any test. Report the new win tick and commander HP either way.

### Construction states (Codex 1)

A tile or building being built goes through three states, and the rule is the same for walls, gates and every other building:

| State | Occupancy for placement | Blocks player units | Blocks aliens / flow cost | Drawn as |
|---|---|---|---|---|
| **reserved** (queued in a run, no build power yet) | yes (nothing else can be placed) | no | no | ghost outline |
| **started** (first build power applied) | yes | yes | yes, at its current hit points | site, joins neighbours |
| **complete** | yes | yes (gate corridor: no) | yes | finished |

When a tile becomes started, any unit or alien standing on it is moved to the nearest free passable tile in the same tick, deterministically (search order: ring by ring, then by (ty, tx)). Tests cover each transition for both actors, including an entity standing on the tile when it starts. The existing W13 behaviour (a site blocks from placement) changes to this table; the existing tests that depend on it are updated, not deleted, and each update is listed in the report.

### Footprints (Codex 3)

Buildings get a rectangular footprint `fw × fh` with an anchor tile, replacing the single square `size` everywhere it is used: occupancy, placement, removal, attack distance (nearest footprint tile), picking, ghosts and snapshots. Every existing kind has `fw = fh = size`, so existing behaviour is unchanged; a test proves it for each kind. A gate's footprint is `3 × depth` along the run axis, recorded with its axis.

### Gates (Codex 2, 4, 5, 6)

- A new building kind `gate`, appended to `BUILDING_KINDS`. Bump the snapshot and save format versions.
- **Placement predicate: W23's `checkGateAxis` and `checkGate` exactly** (`look/src/w23/walls/grid.ts:240–290`): `GATE_WIDTH = 3` plain wall tiles in a row; the run 1 to 4 rows deep (`GATE_MAX_DEPTH`); the wall continues past both ends on every row; the ground just before and behind the block is clear. Port it into the simulation with its tests; both axes, depths 1–4, missing end, side join and too deep are each tested.
- **Conversion only on complete walls.** Every tile in the footprint must be a complete wall; reserved or started tiles refuse with a reason. On the order, the footprint's wall tiles are removed and a gate site is created in the same tick (atomic: both or neither). The gate starts at tier 1 regardless of the walls' tiers; higher tiers use the existing paid upgrade path. Removed walls give no refund. Gate cost and build time: the wall's per-tile cost and build time × footprint tiles × 1.5 (new number, listed in `balance.ts`). Gate hit points: wall tier-1 hit points × footprint tiles.
- **Passability.** Player units may pass only through the gate's centre column (the corridor, 1 tile wide, through every row); the two outer columns are solid for everyone. Aliens treat every footprint tile as a wall. Diagonal moves for aliens are not allowed past a gate's corner tiles (the flow field already refuses corner-cutting next to walls; a test proves it at a gate). Doors are cosmetic (run 2).
- **Flow cost.** The gate's breaking cost is charged once along a route, not per row: each footprint tile's cost is the gate's hit points ÷ depth. Documented in `flowfield.ts`.
- **`look/` keeps compiling.** `look/` imports the game's `BuildingKind`; add a `gate` entry to `look/src/models/procedural/buildings.ts` `BUILDING_MAKERS` (a plain box placeholder is enough). `look` typechecking is part of Verify.

### Wall runs (Codex 7, 8)

- New command `buildRun { ids, from: [tx, ty], to: [tx, ty], depth: 1..4, queue }`, walls only, always tier 1 (higher tiers through the paid upgrade path).
- **Geometry.** The run goes along the dominant axis from `from` (ties: x axis), `to` projected onto that axis. Depth rows are added on the side of the axis that `to` lies on (`to` on the axis: the positive side). Maximum 128 tiles along the run.
- **One run order, not one order per tile.** A run is a record in a world-side run table (fixed capacity, 32 runs) holding its tiles in build order. Each assigned builder holds one order "work on run R"; it takes the next unclaimed tile, builds it, and moves on, so 1 to 512 tiles cost one order slot per builder. If the run table is full, the command is refused before anything is created.
- **Build order.** Columns along the run from the end nearest the selected builders' centroid (tie: the `from` end), and within a column, the axis row (the row through `from`) first, then outward. Tiles that are blocked, rock, or already wall are skipped and counted in the result.
- **Resources** drain while each tile is built, not at the order. Reserved tiles cost nothing.
- **Cancel.** `stop` on the builders leaves the run's remaining reserved tiles; a new `cancelRun { run }` removes them.

### Sandbox scenario and identity (Codex 9, 10)

- Scenario `sandbox`: map 1 terrain and deposits, the commander and the map 1 starting engineers, map 1 starting stock, no wave schedule (no wave arrives unless started). Selected with `?sandbox=1`.
- **The scenario is world state**: stored on `World`, in saves and in snapshots. Loading a sandbox save gives a sandbox; loading a map 1 save gives map 1, through either URL. Tested both ways.
- **No end state in the sandbox.** The sandbox never wins or loses. If the commander dies, a notice is shown, its wreck stays, and a new commander appears at the base 10 seconds later. The simulation keeps applying commands throughout.
- `resetSandbox`: returns to the sandbox start state (tuning and unlimited kept unless `full: true`).

### Sandbox commands

All refused by `validate.ts` with a reason unless the world's scenario is `sandbox`.

- **`spawnAt { kind, x, z, count }`** (Codex 11, 12): `count` 1–50. Placement searches a spiral of radius at most 6 tiles around the point, on passable unoccupied tiles, at least 0.8 tiles apart, in a fixed order. If the full count cannot be placed, or the alien table would exceed its capacity, the command is refused and nothing is spawned. The spawn point is added to a list of at most 8 recent spawn origins, and the snapshot carries a route trace from each, for the overlay. Saboteurs' pursuit of nearby engineers is unchanged; route tests use rushers and breakers.
- **`tune { target: 'building' | 'alien' | 'unit', kind, field, mult }`** (Codex 13): tuning is a **multiplier** per kind and field, 0.1× to 10×, applied on top of tier and research multipliers (effective = base × tier/research × tune). Supported fields:
  - buildings with a weapon: `hp`, `damage`, `range`, `interval`; other buildings: `hp`;
  - aliens: `hp`, `dps`, `speed`;
  - units (commander, engineer): `hp`, `speed`, `buildRate`.
  Unsupported field and kind combinations are refused with a reason. Changing a maximum hit-point multiplier keeps every affected entity's hit-point fraction. Shots already in flight keep the damage they were fired with. Changing a multiplier marks flow fields for recomputation where hit points feed costs. `tuneReset { target?, kind? }` returns multipliers to 1. The panel shows the effective value in display units (m/s, seconds, tiles).
- **`setUnlimited { on }`** (Codex 14): while on, construction, upgrades, research, engineer production, running costs (energy) and heavy-cannon ammunition (parts) spend nothing; income continues as normal.
- **`grantResearch { all: true } | { node }`**: completes research without cost.
- **`startWave { index }`**: sends map 1 wave `index` now, at its entry points; it does not start the wave schedule.
- **`clearAliens`**, **`clearWrecks`**, **`resetStats`**.

### Stats (Codex 15)

- Projectiles and instant hits carry the shooter's kind and the shooter's entity id at the moment of firing (a new projectile column).
- Counters are historical aggregates in world state, per kind, kept when the shooter is destroyed or its slot reused: per building kind and per unit kind (commander, engineer temporary turret) — shots, hit points removed, kills; per alien kind — spawned, killed, hit points removed from walls and gates, from other buildings, from units.
- **Hit points removed** counts only what the target actually lost (no overkill). Splash damage is credited to the shooter's kind. A kill is credited to the hit that removed the last hit point. Shield absorption is counted separately as "absorbed by shields". `clearAliens` and `clearWrecks` do not count as kills. `resetStats` zeroes all counters.
- The counters are in every snapshot (a small fixed array per kind; no throttling).

### Snapshot, save and determinism (Codex 16)

- Snapshot and save format versions bumped; saves include runs, tuning, unlimited, scenario, spawn origins, counters and projectile attribution.
- Determinism test: a sandbox script of 3,000 ticks (buildRun, gate, spawnAt, tune, unlimited, startWave) run twice, comparing a hash of the full snapshot every 100 ticks, and asserting each command produced its effect (not only that the end states match).
- Continuation test: save at tick 1,500 with a run half built, a gate built, tuning active and shots in flight; load; run to 3,000; the hashes match the uninterrupted run at every 100 ticks.

### Rendering in run 1 (minimum)

The greybox renderer draws: gates (footprint box with the corridor marked by a gap), reserved tiles as ghost outlines, started tiles as sites, spawn-origin routes in the overlay. No panel yet: `window.__game` gains `spawnAt`, `buildRun`, `cancelRun`, `tune`, `tuneReset`, `setUnlimited`, `grantResearch`, `startWave`, `clearAliens`, `clearWrecks`, `resetStats`, `resetSandbox` and `stats()`, each sending a command and resolving with the worker's acceptance or refusal reason. Dev server for this branch on port 8822 (8821 is taken on codepanda) with `allowedHosts` set; expose with `tailscale serve --bg --https 8822 http://127.0.0.1:8822`.

### Run 1 acceptance criteria (the tests must assert these)

1. **Build power:** a 100 build-power-second site takes 125 ticks (±1) with the commander alone, 200 with one engineer, 56 (±1) with the commander and two engineers.
2. **Construction states:** per the table above, for a wall tile and a gun turret: a reserved tile blocks placement but not movement; a started tile blocks a unit and an alien and enters flow cost; an entity standing on a tile when it starts is moved off it that tick.
3. **Footprints:** for every existing kind, occupancy, placement, removal and attack distance are unchanged by the footprint refactor (compared with the pre-refactor values).
4. **Wall run:** `buildRun` from (10,10) to (19,12), depth 2, with builders west of x = 10 → 20 tiles on rows y = 10 and 11, built column by column from x = 10, row 10 first in each column; blocked tiles skipped and counted; a 128-tile run at depth 4 is one order per builder; a run refused when the run table is full creates nothing; resources drain during building only.
5. **Gate:** placement accepted on a complete straight run of depth d for d = 1..4, on both axes, with the 3 × d footprint replaced atomically; refused (with W23's reasons) on a reserved or started tile, a corner, a T, a missing end, and depth 5. After building: a player unit's path crosses the gate's corridor; with no other way in, an alien flow field routes to the gate and aliens attack it; no alien enters a standing gate's tiles, including diagonally at its corners; when the gate is destroyed, aliens pass.
6. **spawnAt:** exactly `count` aliens on distinct passable tiles within 6 tiles, at least 0.8 tiles apart; refused atomically when they cannot fit or the table would overflow; the route trace from the spawn origin appears in the snapshot.
7. **Tune:** gun turret `damage` at 2× doubles the **raw damage per shot** from the next shot fired, while shots already in flight keep the old value; alien `hp` at 2× keeps each alien's hit-point fraction; multipliers outside 0.1–10 and unsupported fields are refused; `tuneReset` restores 1×.
8. **Unlimited:** with it on, a wall, a research node and heavy-cannon shots spend nothing (pool changes by income only, parts unchanged); turned off, the next build drains normally.
9. **Sandbox only:** every sandbox command is refused in `map1` with a reason; the scenario survives save and load in both directions.
10. **No end state:** in the sandbox, killing the commander does not stop the simulation; a command issued after its death is applied; a new commander appears 10 seconds (100 ticks) later.
11. **Stats:** in a scripted fight with two gun turrets, one area cannon and one temporary turret against a fixed alien group, the per-kind kills sum to the aliens killed, and the per-kind hit points removed sum to the hit points the aliens lost; a turret destroyed mid-fight keeps its kind's totals.
12. **Determinism and continuation:** as described above.
13. Existing 77 tests keep passing (updated where the construction-state change requires it, each update listed); the balanced plan result reported.

## Run 2 — renderer port (planned 2026-10-08 after run 1 closed at `60ebba6`; revised after Codex review, see `PLAN-REVIEW-LOG.md`)

Goal: the sandbox and map 1 draw with the W17–W23 models, lighting and textures instead of greybox shapes, driven only by simulation snapshots, at 55 fps or better at the game camera on codepanda. Gameplay, simulation and snapshot format do not change.

Split into two author runs (Codex run 2 review, finding 15): **2a** — ground, lighting and post-processing, and every model drawn in its static pose including walls, gates and construction; **2b** — animation from snapshots (units, aliens, turret aim, firing, effects) and the combined performance gate. 2b is planned in detail after 2a is verified.

Rule for every port: copy geometry, materials, rigs and pure animation only — never the workshop's simulation or demo controllers (`look/src/w23/units.ts` task logic, `look/src/stress/aliens.ts` movement, `look/src/stress/fireControl.ts`, `look/src/w23/world.ts` construction logic, `look/src/bench/construction.ts` clock, `look/src/render/camera.ts` OrbitControls). `look/` stays unchanged. CC0 textures actually used are copied into `game/public/assets/` with `CREDITS.md`.

### Run 2a — ground, lighting and static models

**Render adapter** (finding 7). `game/src/render/adapter.ts` grows an explicit lifecycle: it owns the `WebGLRenderer`, the post-processing composer (W21's `StressPost` stack: ambient occlusion, bloom, haze), quality (`medium` default with device pixel ratio capped at 1; `high` selectable), resize, and per-frame timing (CPU ms per pass, exposed through `__game`). The game's own camera rig, strategic zoom and input stay; the workshop camera is not ported. Lighting from `look/src/render/{lighting,fog}.ts` (sun shadows near the camera only, as W21).

**Ground** (findings 3, 4).
- Inside the 128 × 128 map the surface follows the game's terrain (`game/src/sim/terrain.ts` tiles and heights). **One sampler** returns the height of the actual mesh triangles (same diagonal split as the mesh), and picking, unit and alien feet, building bases and icons all use it. The simulation does not use height and is not touched.
- Shader masks derived from game data, not W17's analytic field: cliff from slope and rock tiles; paved ground under complete buildings' footprints; the dark/weathered variation from noise. W17's terrain material and textures do the shading.
- Rock tiles become terraced outcrops in the W17 style (cosmetic geometry on top of the sampled surface; their tops are not walkable and need no sampler agreement, as nothing walks on rock).
- Outside the map edge: W17-style canyon scenery — terraced canyon walls and haze — stitched to the map edge with no gap or crack (vertices on the edge shared or skirted).
- Foundations: every building gets a cosmetic plinth from its base down to the lowest sampled ground under its footprint, so a wide building on a slope never floats or sinks.
- Budget, measured in 2a at the game camera, medium, 1440 × 900: terrain and scenery ≤ 5 ms GPU per frame, post-processing ≤ 3.5 ms.

**Frozen model and icon inventory** (finding 10):

| Game kind | Model source | Strategic-zoom icon |
|---|---|---|
| wall, gate | W23 walls and gates (`look/src/w23/walls/*`, `batches.ts`, `parts.ts`, `lod.ts`) | W23 wall/gate icons |
| massExtractor, rareExtractor | W23 extractors | W23 extractor icons |
| gun, area, beam, heavy, tempTurret | W22 kit, **strategy B** (batched by part × material × detail level) — gun → **bastion**, area → **anvil**, beam → **lantern**, heavy → **rampart**, tempTurret → **lookout** | W22 kit icons |
| generator, lab, depot, shredder, smelter, assembler, shield, belt | W17 procedural buildings (`look/src/models/procedural/buildings.ts`) | new W23-style shape-coded icons, one distinct shape per kind |
| splitter, merger | W17 belt plus a distinct top marker each (splitter: one-in, three-out chevrons; merger: three-in, one-out), so they are never drawn identical to a belt | distinct icons |
| commander, engineer | W23 rigs, static pose in 2a | W23 unit icons |
| rusher, hunter, breaker, saboteur | W21 alien models, static pose in 2a | new shape-coded icons per kind |

No kind is greybox after 2a. Every icon is distinguishable by shape and outline, never colour alone.

**Walls and gates** (finding 5). The wall topology is rebuilt only when its **layout key** changes: per tile, wall/gate identity, tier, construction state class (reserved / started-or-complete, since started tiles join neighbours), gate axis and footprint. Hit-point and progress changes update per-instance attributes only. Two damage states from the hit-point fraction. Gate doors drawn closed in 2a.

**Construction** (finding 8). W23's per-instance construction cut with its custom depth material, driven by each site's snapshot `progress`; reserved = ghost outline; started = the cut rising with progress; complete = finished. Shape and outline, never colour alone.

**Turrets in 2a**: assembled from the kit through strategy B, static pose facing the snapshot's `target` alien by yaw only (no pitch, recoil or firing until 2b).

**Capacity** (finding 13): every batch sized from the matching simulation table capacity; tested with maximum runs in each state (reserved, started, complete) across all three tiers and every detail level, plus icons at strategic zoom, counting **submitted part instances** in the actual GPU batches.

`?greybox=1` keeps the W13 renderer for comparison until Richard signs off the look; removed in run 3.

#### Run 2a acceptance criteria

1. **Snapshot-only:** render code imports nothing from `game/src/sim` that mutates state (test over the import graph).
2. **Scene inspection, not self-report** (finding 14): a test helper walks the actual Three.js scene graph and, for a given snapshot, collects per kind the visible meshes or instanced batches with `count > 0`, their material names, and instance transforms. Assertions use that, not a renderer-maintained report. Every kind in the inventory has non-greybox geometry; greybox geometry appears for no kind.
3. **One ground:** for 2,000 points inside the map, including every rock/ground boundary, the sampler equals the mesh's triangle interpolation within 1e-4 tiles; a screen-ray pick at 200 screen points lands within 0.01 tiles of the sampled surface; foot and building-base heights equal the sampler.
4. **Edges and foundations:** no gap between map edge and scenery (edge vertex heights equal); a 4 × 4 building on the steepest buildable slope has its plinth reaching the lowest ground under its footprint.
5. **Wall layout key:** HP-only and progress-only snapshot changes → 0 topology rebuilds; each of tile added, tile removed, tier upgrade, reserved → started, wall → gate conversion, gate axis → exactly 1 rebuild.
6. **Construction:** two sites at progress 0.25 and 0.75 in one frame show different cut heights.
7. **Turrets:** for each of the five mapped kinds, the assembled part list equals the W22 kit's part list for that kind, the footprint transform places it on its tile centre, and yaw towards a target changes only yaw-pivot parts.
8. **Capacity:** the maximum-run fixture in each state and tier draws every part instance; overflow false; icons likewise.
9. **Browser and budget:** `?sandbox=1` and map 1 load with 0 console errors; ground and post costs measured and reported against the budgets above; a static benchmark scene (the 2b population, stationary) reported at the game camera (not yet gated).
10. **Screenshots** to `Resources/Bulwark Art Reference/w24-2a-*.png`: game camera over the base with a wall run partly built and a gate; close-up of each turret kind and the other buildings; aliens and units in static pose; full strategic zoom-out; map edge into scenery.
11. **Simulation unchanged:** the fingerprint comparison against `60ebba6` is part of Verify and passes.

#### Verify command — run 2a (frozen)

```bash
cd ~/Projects/worktrees/bulwark-w24/game && npm ci --no-audit --no-fund >/dev/null && \
npx vitest run test/w24r2a-*.test.ts && npm test && npm run build && \
(cd ../look && npm ci --no-audit --no-fund >/dev/null && npx tsc --noEmit) && \
node scripts/fingerprint-compare.mjs 60ebba6 && \
node scripts/check-render.mjs
```

`fingerprint-compare.mjs` exports the baseline commit with `git archive` into a temporary directory, runs `scripts/fingerprint.test.ts` there and here, and fails unless the hashes are identical. `check-render.mjs` builds, starts `vite preview` on strict port 8823 from this tree, drives agent-browser (session `w24-2a`) through criteria 9's checks and the scene-inspection helper on both scenarios, and always stops the server and closes the session. It fails on the current tree: no `test/w24r2a-*` files and neither script exists. The calling session re-runs it, reads the new tests against criteria 1–8, and looks at every screenshot before Richard does. The look needs Richard's sign-off; a green Verify is not a visual pass.

### Run 2b — animation, effects and performance (planned 2026-10-09 after W25c closed at `dc28343`)

Goal: everything the simulation does is visible as motion — builders beam at their sites, extractors run, gates open, turrets aim, recoil and fire, shots fly and land — driven only by snapshots, and the combined scene holds its frame rate. Gameplay, simulation and snapshot format do not change (fingerprint against `60ebba6` with `--strip-queue`, as W25c).

**Already done, out of scope:** unit and alien walking with planted feet and gait (`fe171f0`, `render/walk.ts`); discontinuity resets for teleport, rewind, load and new ids (W25c, `render/interp.ts` and `mobileStep.ts`). 2b reuses them; it does not change them except to read their reset signal.

**Port rule** as run 2: copy geometry, materials, rigs and pure animation from `look/` (`w23/beams.ts`, `w23/walls/gate.ts` door drive only, `w23/extractors.ts` animation section, `stress/turretPose.ts`, `stress/effects.ts` pools and meshes, W21 particles); never the workshop's fire control, ballistic solver, collision or demo clocks. `look/` stays unchanged.

**Animation input matrix** (finding 9). One table in `render/anim.ts`, the only place that decides what drives each animation. Every input comes from the snapshot, the interpolator, or the render clock below.

| Animation | Kinds | Driven by | Off when |
|---|---|---|---|
| Build beam, emitter to site | commander, engineer | `state == US_BUILDING`, `work − 1` = building id present in the snapshot | any other state, or the id is absent |
| Reclaim beam, wreck to emitter (reverse direction, distinct pulse shape) | commander, engineer | `state == US_RECLAIMING`, `work − 1` = wreck id | as above |
| Carry pod on the back, sized by load | engineer | `carry > 0` | `carry == 0` |
| Extractor running (W23 animation) | massExtractor, rareExtractor | `BF_COMPLETE` (income extractors never get `BF_ACTIVE`) | not complete |
| Generator running | generator | `BF_COMPLETE` (generators give income when complete and never get `BF_ACTIVE`) | not complete |
| Machine working | smelter, assembler, shredder | `BF_ACTIVE` and not `BF_STARVED`, with motion rate from the snapshot's `work` progress advancing between snapshots (`BF_ACTIVE` alone stays set with zero energy: Codex 2b-1) | `work` not advancing, or starved |
| Gate doors | gate | a player unit (interpolated position) within 2 tiles of the gate's tiles, on either side; W23 travel time | none in range — doors drive shut; aliens never open them |
| Turret yaw and pitch | gun, area, heavy, tempTurret, beam | `target − 1` = alien id present: aim at that alien's **interpolated** position, pitch from the game's flat projectile physics (flat trajectory to the target's height above the muzzle; no ballistic arc) | no target: hold the last aim, then ease back to rest over 2 s |
| Recoil + muzzle flash | gun, area, heavy, tempTurret | `BF_FIRING` in a snapshot whose tick is newer than the last one this turret flashed for | — |
| Beam turret's beam | beam | `BF_FIRING` and a present target: drawn every frame muzzle → target | flag clear |
| Shots | `P_BULLET`, `P_SHELL`, `P_HEAVY`, `P_ALIEN` | every **observed** snapshot projectile row, interpolated; drawn as W21 tracers/shells with the source muzzle as the first point when the shooter is still present | row gone: impact effect at its last position (W21 pooled particles, no collision) |

Shots, impacts and flashes are best-effort at every speed (finding 1; Codex 2b-2): a turret fires before projectiles move, so a close shot can be created and removed within one tick and never appear in any snapshot, and one snapshot covers several ticks above 1×. Every projectile row that appears in a snapshot is drawn; flashes are at most one per turret per snapshot. Stated in the code and the notes, not hidden.

**Effect clock** (finding 9; Codex 2b-3). A small clock of its own in `render/anim.ts`, not derived from the interpolator's snapshot pair (whose alpha spans 100 ms at every speed, so at 3× it jumps 66.7 ms of simulation time at one arrival — longer than a 60 ms flash). Each frame it advances by real frame time × the runner's speed, by 0 when paused, and is clamped to 100 ms per frame; a world reset (below) restarts it with a zero delta. Pause freezes every animation (doors, extractors, beam pulses, recoil decay, particles); 2×/3×/10× speed them up. Tested with batched snapshots (several ticks per snapshot) and repeated snapshots of the same tick. The strategic-zoom icons do not animate.

**Reset rules** (Codex 2b-4). The global reset signal is the worker's world epoch (`RunnerInfo.world`, which changes on load, rewind and world replacement) or the snapshot tick going backwards, passed to the effects directly — not inferred from the interpolator's per-row cuts, which a world with no mobiles never produces and a fresh alien spawn produces without a reset. On a global reset every effect state is dropped: recoil 0, doors snapped to the state the current snapshot implies, aim snapped to the current target, particles and in-flight tracers cleared, and each turret's last-flashed tick **seeded to the restored snapshot's tick**, so a restored `BF_FIRING` is not replayed as a new shot. On id reuse (a new id in a building, unit or projectile slot), that slot's state is dropped. On pause nothing resets.

**Effect capacities.** Every pool sized from the simulation's table capacities (projectiles, units, buildings) with an `overflowed` flag as in 2a; particles bounded by W21's caps.

**Warm-up frame instead of scene-only compile** (W25b finding; Codex 2b-7). `compileAsync(scene, camera)` covers scene materials only; the game renders through a composer with shadows, ambient occlusion, bloom and SMAA. So behind the loading state, with every kind's batch at count ≥ 1 and every effect material instantiated in view of a warm-up camera, the adapter renders one complete frame through the full composer (after `compileAsync`), then clears the warm-up instances before the first visible frame. `?warmup=0` disables it for comparison. Measured in two equivalent cold launches (fresh browser context each), with and without warm-up: loading time to first visible frame (reported separately) and the longest main-thread frame in the 10 s after the first visible frame.

**Combined performance gate** (findings 11, 12). A frozen benchmark in `check-render.mjs` (gated, unlike 2a's):
- Scene: the sandbox with fixed placements through the game's own commands — a walled base with 2 gates, 20 turrets across all five turret kinds, both extractors, every W17 building kind, 12 engineers, the commander, and a sustained alien stream (spawn groups re-issued so at least 150 aliens are alive throughout) attacking the walls. Free spending on, speed 1×. **Sustained activity** (Codex 2b-5): the fixture is **recreated from scratch for each pose and each retry** (load a fresh sandbox, re-issue every command); engineers get build queues long enough to outlast the measurement (a long wall run beyond the base, re-queued when it nears completion); temporary turrets (30 s life) are re-dropped by the script when they expire; one engineer is ordered back and forth through a gate so the doors keep moving.
- Camera: two frozen poses — the game camera over the base (fixed position, target and elevation, recorded in the script) and the full strategic zoom-out. 1440 × 900, quality medium, device pixel ratio 1.
- **Visibility minima** (Codex 2b-6), sampled every second through `__game.inspect` (entities actually drawn, not the snapshot population): game camera — at least 100 aliens, 15 turrets, 10 engineers, the commander and every building kind visible, and every turret and alien kind present; strategic zoom-out — the whole population drawn as icons or models. A sample below a minimum fails the pose as "workload not visible".
- Activity counters (`__game.activity`, counting **visible** entities only): builders beaming, turrets firing, aliens attacking and shots in flight each > 0 in every second; at least one door opening and one closing within each 20 s window. Otherwise the pose fails as "scene not active", not as a performance pass.
- Measurement: 20 s per pose after a 5 s warm-up; frame times from `requestAnimationFrame`. Pass: game camera average ≥ 55 fps and 1%-low ≥ 45; strategic zoom-out average ≥ 40. Reported with each result: the load average at start and end, the forced-complete frame cost, draw calls and visible counts per kind. The display caps at 60 Hz, so averages above 60 are not expected.
- If a pose fails while the 1-minute load average is above 8, the script waits for load below 8 (up to 5 min) and re-measures that pose once; both results are printed. A failure at load below 8 is a failure.

#### Run 2b acceptance criteria

1. **Snapshot-only:** the 2a import-graph test still passes and covers the new modules.
2. **Input matrix:** for each row, a fixture snapshot pair turns the animation on, and a pair turns it off, and **while on, the animated transforms change as the effect clock advances** (presence alone would pass on today's static models and greybox beams), asserted through the scene graph (`__game.inspect` or the test helper), not a renderer self-report. Includes: a builder whose `work` id is absent draws no beam; an alien next to a gate does not open it; an income extractor without `BF_ACTIVE` still animates when complete.
3. **Aim** (Codex 2b-8): with a target moving across a turret, the yaw-pivot parts point at the target's interpolated position within 1°, the pitch matches the flat-trajectory formula within 1°, and each moving pivot the kit defines (yaw, pitch, the pinion that turns with yaw) has its intended transform; static parts do not move.
4. **Flashes:** two consecutive snapshots with `BF_FIRING` and different ticks give two flashes; the same snapshot rendered over several frames gives one.
5. **Clock:** paused for 2 s, every effect transform is unchanged frame to frame; at 3× the door travel takes a third of the time.
6. **Resets:** a rewind mid-fire clears tracers and recoil and snaps doors and aim; a reused id starts from rest.
7. **Capacity:** every projectile row at the simulation's capacity is drawn with `overflowed` false.
8. **Warm-up:** across the two cold launches, the warm-up demonstrably ran (`__game.warmup` reports the frame rendered and its composer passes), the longest main-thread frame in the 10 s after the first visible frame is lower with warm-up than without, and under 250 ms with warm-up on a quiet machine (load below 8); loading time is reported for both.
9. **Performance gate** as above passes and prints its figures; `check-render.mjs` writes the 2b screenshots on every run (not only with `--shots`) and fails if any is missing; screenshots `Resources/Bulwark Art Reference/w24-2b-*.png`: engineers beaming at a wall run, a turret mid-recoil with flash, shots in flight, an open gate with an engineer in it, the strategic zoom-out of the benchmark scene.
10. **Simulation unchanged:** `fingerprint-compare.mjs 60ebba6 --strip-queue` identical.
11. **No regression:** `check-queue.mjs` passes; balanced plan still wins map 1.

#### Verify command — run 2b (frozen)

Run under bash (zsh aborts on an unmatched glob before vitest runs; the patterns are quoted so vitest does the matching):

```bash
bash -c 'cd ~/Projects/worktrees/bulwark-w24/game && npm ci --no-audit --no-fund >/dev/null && \
npx vitest run "test/w24r2b-" "test/w26-" && npm test && npm run build && \
(cd ../look && npm ci --no-audit --no-fund >/dev/null && npx tsc --noEmit) && \
node scripts/fingerprint-compare.mjs 60ebba6 --strip-queue && \
node scripts/check-render.mjs --no-build --shots "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Rick'"'"'s World/Resources/Bulwark Art Reference" && \
node scripts/check-queue.mjs --no-build'
```

Fails on the current tree: vitest finds no `w24r2b-` or `w26-` test files and exits 1, and `check-render.mjs` has no gated benchmark. That is an existence check only, so the calling session also proves discrimination (Codex 2b, Verify): the author commits the new behavioural tests before the change, and the calling session runs them against the pre-2b renderer, where they must fail. The calling session then re-runs the full Verify, reads the new tests against criteria 1–8, and looks at every screenshot. A green Verify is not a visual pass; the look of the effects needs Richard's sign-off. `m2`'s 5 s timeout under machine load (seen in W25c) is a known flake: if `npm test` fails only on it, re-run once and record both. W26 is part of this run (section below), so its tests are part of this Verify.

#### Run 2b decisions made here (Richard can overturn)

- Shots, impacts and flashes are best-effort: every projectile seen in a snapshot is drawn; flashes are at most one per turret per snapshot.
- Effects pause with the game; icons never animate.
- The gate is 55 fps average and 45 1%-low at the game camera with ~150 aliens; 40 at full zoom-out.

### W26 — idle units column (Richard, 2026-10-09: "commanders and engineers without a task should appear on the right hand side of the UI (same as SupCom)"); built in the same author run as 2b

- **Idle** = a commander or engineer with `state == US_IDLE` and 0 queued orders (snapshot queue section, per-unit order count). `US_WAITING` (waiting for resources), moving, building and reclaiming are not idle. Render-side only; no simulation or snapshot change.
- **Column** on the right edge, below the debug spawn panel: one button per unit type that has idle units, commander first, then engineers. Each button shows the type's W23 icon (the strategic-zoom shape) and the idle count; a type with none is hidden. Shape and number carry the meaning, never colour alone.
- **Click** selects the next idle unit of that type (cycling in id order across repeated clicks) and centres the camera on it without changing zoom or elevation. **Shift + click** selects every idle unit of that type. Clicks on the column never reach the map (no selection or build placement underneath).
- Updates from each snapshot; a unit becoming busy leaves the column on the next snapshot.

#### W26 acceptance criteria

1. Unit test over snapshot fixtures: idle set = exactly the US_IDLE units with 0 orders; a US_WAITING unit, a unit with 1 queued order, a moving and a building unit are excluded; aliens and buildings never appear.
2. Browser check (added to `check-queue.mjs`, real mouse through agent-browser): in the sandbox with the commander and two engineers idle, the column shows commander × 1 and engineer × 2; a click selects one engineer and the camera target moves to it; a second click selects the other; Shift + click selects both; give one engineer a build order and the count drops to 1 on the next snapshot; a click on the column changes no map state.
3. Screenshot `Resources/Bulwark Art Reference/w26-idle-column.png`.

The run 2b Verify covers W26: vitest's `test/w26-` filter, and `check-queue.mjs` carries criterion 2.

### W27 — pulsing wireframe placement preview (Richard, 2026-10-09)

Richard: "when placing a building we should see a wireframe pulsing version of it to get a sense of size etc." Built in the same author run as 2b and W26.

- Today `render/ghost.ts` shows the building's old simple model, see-through. Replace that with the **real model the renderer draws at full detail** (the same W17/W22/W23 geometry and assembly `render/models.ts` uses for that kind; turrets in their rest pose), drawn as a **wireframe**, at true scale, with the placement direction (`buildMode.dir`), standing on the sampled ground at the same base height and plinth rule as a placed building, so its size reads exactly as the built one will.
- The wireframe **pulses**: its opacity (and optionally line brightness) cycles smoothly, about 1 s per cycle, driven by real time (the preview is UI, so it keeps pulsing while the game is paused).
- Validity stays as today, by shape, never colour alone: solid footprint outline and a tick when placement is allowed; dashed outline and a cross when it is not. The wireframe itself may also change (for example a slower or stopped pulse when invalid) but never by colour alone.
- The wall/belt drag preview (`render/dragPreview.ts`, W25 item 7): each tile that will be built also shows the wireframe of the piece that will stand there, pulsing in step; skipped tiles keep the dashed outline and cross only. Preview geometry is pooled/instanced; nothing allocated per frame.
- Every building kind has a wireframe preview; none falls back to the old simple model.

#### W27 acceptance criteria

1. Scene-graph test: for every building kind, the preview's geometry is the full-detail model's geometry for that kind (same part/geometry identities or vertex counts as models.ts uses), rendered as wireframe, with world bounds equal to a placed complete building of that kind at the same tile and direction (within 0.01 tiles).
2. Pulse: the preview's opacity differs between two times 0.5 s apart, including while the game is paused.
3. Validity: an allowed tile shows the solid outline + tick; a blocked tile shows the dashed outline + cross.
4. Drag preview: a 10-tile wall drag across one blocked tile draws 9 wall wireframes and 1 cross; no per-frame allocation (pool sizes stable across 100 frames).
5. Browser (in `check-queue.mjs` or `check-render.mjs`, real mouse): pick a gun turret in build mode, hover a valid tile — the wireframe preview of the turret is in the scene at the hovered tile; screenshot `Resources/Bulwark Art Reference/w27-wireframe-preview.png` (and one mid wall drag).

Tests in `game/test/w27-*.test.ts`. The frozen Verify's vitest line gains the `"test/w27-"` filter alongside `"test/w24r2b-" "test/w26-"`; nothing else in Verify changes.

### W28 — construction hover readout replaces the "waiting for" labels (Richard, 2026-10-09)

- Remove the W25b text labels "waiting for <resource>" on sites and on their builders (render/waitView.ts / waiting.ts). Keep the hourglass marker on a starved site (a shape cue visible without hovering) and the resource readout's "▲SHORT · N sites waiting" line. Richard can drop those later.
- Hovering the mouse over a building site (reserved, started, or a complete building being upgraded) shows a small panel by the cursor:
  - the kind's name and "upgrading to tier N" when upgrading;
  - percent complete from the snapshot `progress` (whole percent; "reserved — not started" for a reserved site);
  - intake per resource the build costs (mass, energy, parts, rare — only those with a non-zero cost), per second of game time: cost_r × Δprogress ÷ Δgame-seconds between the last two snapshots of that building. Cost is the same per-kind (or upgrade) cost the simulation's `workOf` charges (sim/economy.ts stepConstruction: spend per tick = cost × progress done); read it from the pure data modules render code may import (kinds.ts / tuning), not from world.ts. A starved site shows 0/s for that update and the number when supply returns, so it oscillates as Richard describes — no smoothing that hides that;
  - the number of builders (snapshot `builders`).
- Render-side only: no simulation or snapshot change (fingerprint identical). Hover uses the existing building picking; the panel follows the cursor, hides when not over a site, never blocks clicks, updates once per snapshot, and never relies on colour (text and numbers). Paused: intake shows the last value or "paused", never a division by zero.

#### W28 acceptance criteria

1. Unit tests (`game/test/w28-*.test.ts`) over snapshot pairs: a site advancing 0.1 progress over 1 game second for a kind costing 200 mass / 600 energy shows 20 mass/s and 60 energy/s; a starved pair (no progress change) shows 0/s; a reserved site shows "reserved — not started"; an upgrade uses the upgrade cost; resources with zero cost are not listed; a paused pair (equal ticks) shows no division by zero.
2. The W25b label meshes/text are gone; the hourglass marker and the ▲SHORT readout remain. Change only the W25b assertions that test the removed labels, and list them.
3. Browser check with real mouse (in check-queue.mjs, which already drives a starved wall run): hover a started site — the panel shows a percent and a mass intake; with free spending off and mass run out it reads 0 mass/s on at least one update and a positive value on another while supply trickles in; moving off the site hides the panel. Screenshot `Resources/Bulwark Art Reference/w28-hover-readout.png`.
4. The frozen Verify's vitest line gains `"test/w28-"`; nothing else in Verify changes.

### Run 2 decisions made here (Richard can overturn)

- **Terrain:** the playable map keeps the game's own gently rolling ground (the simulation does not use height, and buildings can go anywhere); the red-canyon look comes from W17 textures, lighting, haze, terraced outcrops on rock tiles and canyon scenery beyond the map edge. Making map 1 itself a canyon would change the playable map and needs a design decision first.
- **Turret mapping** as in the inventory; changing it later is a one-line edit.

## Run 3 — sandbox panel, real controls, carried fixes and the rest of the benchmark (planned 2026-10-10 after run 2b closed at `bf63d02`; revised after Codex round 1, see `PLAN-REVIEW-LOG.md`)

Richard tests the four mechanics in the Goal from a panel instead of console calls. Everything the panel does goes through the existing sandbox commands and `window.__game` hooks. The simulation changes only for the two carried order bugs (C2, C3); `game/src/sim/worker.ts` also gains timing fields (no effect on world state).

### Richard's answers (2026-10-10)

- Panel on the **left, under the time controls**.
- **Construction frames and reserved-site outlines** hide behind buildings; **health bars stay drawn on top**.
- The construction hover readout shows **received of wanted** ("mass 0.5 / 20 per s").
- **Greybox (`?greybox=1`)**: removal (item G) waits for his sign-off. If he has not signed off when the author starts, G is out of scope.

### One active tool (Codex R1-4)

The map has exactly one active tool at a time: `select` (default), `build` (a building kind from the build bar), `wall` (wall drag), `upgrade`, `gate` or `spawn`. Choosing any tool (button or shortcut) ends the previous one. The gesture is decided at pointer-down from the active tool, as today.

- `gate` and `spawn`: a left click acts; Shift held keeps the tool after the action; releasing Shift after at least one Shift-held action returns to `select` (as build mode does); without Shift, one action returns to `select`.
- Escape and right click cancel the active tool and any drag in progress (no command sent).
- A world change (load, reset, scenario switch) returns to `select`; a tool that the new scenario does not allow (gate and spawn outside the sandbox) cannot be active.
- The panel shows which tool is active in words ("Tool: spawn rusher × 8 — click the map"), and its button carries the active marker.

### Input isolation and focus (Codex R1-5, R1-6)

- Pointer-down, click, wheel and context menu over the panel never reach the map.
- A map gesture that started on the canvas and is released over the panel (the canvas holds pointer capture) is cancelled: no command, no selection change; the drag preview disappears.
- Focus: Escape is handled first, before the editable-control filter, so it cancels the active tool even with focus in the count field or a slider. Inside a number field, letters and digits go to the field, not to shortcuts. `SELECT` elements are treated like inputs. Panel buttons do not keep focus after a click (blur on pointer-up), and Space handled as pause calls `preventDefault`, so Space never both pauses and presses a button.

### The panel (`game/src/ui/sandboxPanel.ts`, new)

- Shown only when the snapshot's scenario is `sandbox` (a loaded sandbox save shows it, a map 1 save hides it). In the sandbox the DEBUG spawn box (top right) is hidden; in map 1 nothing changes.
- Five tabs: **Build, Spawn, Tune, Economy, Stats**. The active tab is marked by a leading "▸", bold text and an outline, never colour alone. A collapse button ("–" / "+") shrinks the panel to its tab row.
- Every command the panel sends shows the worker's refusal reason as a toast (`.toast.bad`, dashed border).
- The panel redraws from snapshots at most 4 times a second and records the snapshot tick it last drew (`__game.sandboxPanel.tick`). Values come from the snapshot, so `resetSandbox` and loaded saves are reflected without the panel keeping its own copy.

**Build tab**
- Wall-run depth 1–4 (four buttons, the chosen one marked). The depth reaches both paths that hard-code 1 today: command submission (main.ts ~653) and `planDrag` (dragPlan.ts ~139); the drag-preview cache is keyed on depth, so changing depth while paused redraws the preview (Codex R1-11).
- **Gate tool**: a left click on a finished straight wall sends `gate` for the selected builders (all builders when none are selected) **without an axis**: the simulation's predicate chooses it (gate.ts ~82; Codex R1-10).
- **Runs**: the active wall runs (id, tiles done/total, builders), each with × → `cancelRun`.
- Buildings stay in the bottom build bar; this tab does not duplicate it.

**Spawn tab**
- One button per alien kind with its icon shape and name; count 1–50 (−/+ buttons and a number field, clamped).
- **Place** makes `spawn` the active tool; a left click on the ground sends `spawnAt` at that tile.
- **Start wave** 1–20 shown, sent as index 0–19 → `startWave`; **Clear aliens**, **Clear wrecks**.
- **Show routes** toggle, default off (Richard asked for no routes in 2a): when on, each route in `originRoutes` is drawn as a dashed ground line with the kind's icon at its origin.

**Tune tab** (display conventions, Codex R1-17)
- Target (Buildings / Aliens / Units) and kind. For each supported field (run 1 list) a slider from 0.1× to 10×: logarithmic position, value quantised to 0.1 between 0.1 and 2, 0.5 between 2 and 10.
- Next to the multiplier, the effective value **for tier 1, with research as currently granted**, labelled "tier 1" (and "per tile" for wall hit points, so gate depth does not apply). Units: hit points; damage per shot; range in tiles; fire interval in seconds; speed in tiles per second (stored tiles per tick × 10); build power.
- The command is sent on release or commit, not per pixel. **Reset kind** and **Reset all** → `tuneReset`.

**Economy tab**
- **Free spending** toggle with the words ON / OFF → `setUnlimited`.
- Mass, energy and rare: pool, income and spending per second, from the snapshot fields the resource readout uses. Parts: pool, made and used totals; no rate is shown (the snapshot has none).
- Count of each producing building kind (complete only).
- **Grant all research** → `grantResearch all`. **Reset sandbox** and **Full reset**, each needing a second click within 3 s ("click again to confirm") → `resetSandbox`.

**Stats tab** (Codex R1-7)
- Two tables from `statsReport(snapshot.stats)` — the same function behind `__game.stats()`: `.shooters` (per building and unit kind: shots, hit points removed, kills) and `.aliens` (per alien kind: spawned, killed, hit points removed from walls and gates, from other buildings, from units); "absorbed by shields" as its own row. **Reset stats** → `resetStats`.
- Numbers right-aligned with thousands separators; an all-zero row shows "–" for each zero and is dimmed (not by colour alone).

### Carried fixes

- **C1 — picking through a building** (Codex R1-12). A click whose ray reaches a building's pick volume before a unit's or alien's cylinder selects the building. Volumes depend on state:
  - reserved sites: no volume (they draw only outlines);
  - started sites: footprint × drawn height × progress;
  - complete buildings: footprint × drawn height (from model bounds, as pickVolumes does for units), base at the footprint's lowest terrain height;
  - gates: the two side columns only; the corridor column has no volume.
  Box selection is unchanged.
- **C2 — unshifted single build on the unit's own reserved site** (Codex R1-2). One predicate, `ownReservedSite(view, ids, kind, anchor, dir)` — true when a reserved (not started) site of exactly that kind, anchor and direction exists and every unit holding it is among `ids` — is used by the placement preview (shows it allowed), the real build-bar click (`placeBuild` sends the command instead of returning at `canPlaceOn`), validation, and application. Accepted: the queue becomes that one order on the same building id (not removed and re-reserved); other unstarted sites only those units held are removed, as W25 does. A site held by any other unit stays refused.
- **C3 — full run table, atomic replacement** (Codex R1-1). An unshifted `buildRun` with a full table is planned without mutation first: compute the runs and sites the replacement would release (held only by the issuing builders, not started), the sites the new run reuses (`plan.reuse` keeps them), and check **both** the run table and the building table after release. If either still has no room, refuse with the reason and change nothing (queues, paths, buildings, runs, counters identical). Otherwise apply in one step at apply time, revalidating first. The table never exceeds 32.
- **Determinism for C2 and C3** (Codex R1-3): the baseline fingerprint comparison with `60ebba6` stays as it is (must remain IDENTICAL: it does not exercise these paths). New tests in `w24r3-determinism.test.ts` run scripts that exercise C2, C3, shared ownership (a site held by two units, one issuing), an overlapping reuse, and a command made invalid between issue and apply; each script runs twice and once with save at its midpoint and load, comparing full snapshot hashes (queues and order ids included) and save bytes every 50 ticks.

### Overlays and readout (Richard's answers)

- **D1** (Codex R1-13). Construction frames and reserved-site outlines get their own materials (not the shared strategic-icon material), depth-tested with a polygon offset so they do not flicker against the ground. Health bars stay on top. The check creates a real upgrade frame (an upgrade order on a built turret) and a reserved outline, asserts both have non-zero drawn instances, and proves occlusion by pixels: two renders of the same frame, one with the occluding turret's materials hidden (the 2b hide hook), differ inside the overlay's screen rectangle where the turret covers it, and match outside it.
- **D2** (Codex R1-14, R1-15). The W28 readout shows "received / wanted per s" for each resource with a cost. Wanted is the rate at full supply: the site kind's cost × the summed effective build power of the units working on it ÷ its build time, with the full multiplier the simulation uses (kind build power × tier × research such as Field Engineering's 1.5× × the `buildRate` tune), taken from the same simulation function (`siteWork` / tuning.ts) rather than re-derived; working units are those whose `work` field decodes (`id + 1`) to the site. With none: "no builder". Received keeps W28's snapshot-pair average.
  - The received ≤ wanted check applies only across intervals where the builders and tuning did not change, with a tolerance of 1%.
  - Fixtures step real worlds with one and with two engineers (with and without Field Engineering) — not W28's synthetic progress edits.
  - Existing assertions on the old text to update, numeric checks kept: `test/w28-readout.test.ts` string expectations, and check-queue.mjs's starved and stopped-site checks (~568).

### Benchmark report (Codex 18 remainder; R1-8, R1-9)

- **Worker timing window.** `worker.ts` adds to each snapshot message the step time of the batch, the ticks it ran, and the snapshot encoding time. The main thread gains a window recorder, `__game.workerWindow.start()` / `.stop()`, that keeps every message between the two calls (unbounded within the window, independent of the rolling 100-sample buffer). The statistic: per-tick step time = batch step time ÷ ticks in the batch, its median and its maximum over the window; encoding time reported separately.
- check-render starts the recorder at the start of each measured window and stops it at the end. Per pose it reports: `window.devicePixelRatio`, the renderer's pixel ratio, the drawing-buffer size, and the worker statistics.
- **Gate**: at the game camera, median per-tick step time under 50 ms (half of the 100 ms tick). The window fails if it holds fewer than 5 messages per second of window with ticks run, or any value is missing or not finite. Max and encoding are reported only. The 2b frame-rate gates are unchanged.

### G — greybox removal (only if Richard signs off before the author starts)

Remove the `?greybox=1` switch, the greybox branch of the adapter and the W13 greybox renderer files nothing else imports. `__game.renderMode` (new, replacing the internal `renderMode`) reports `models`. If not signed off: untouched.

### Browser check — `game/scripts/check-panel.mjs` (new)

Builds (or `--no-build`) and serves this tree with `vite preview` on strict port 8825, agent-browser session `w3panel` at 1440 × 900, `?sandbox=1`. Real mouse clicks and drags (CDP) and real keys for every action; `__game` is read only to check results, never to cause them. Always stops its server and closes only its own session.

1. The panel is shown in the sandbox and absent at `/` (map 1); the DEBUG spawn box is hidden in the sandbox.
2. Each tab opens by a click; the active tab carries "▸"; collapse and expand work.
3. Economy: free spending turned ON by a click → `__game.unlimited` true.
4. **Fixture** (Codex R1-16): the script picks a clear, rock-free 11 × 9 tile rectangle on flat ground at least 12 tiles from the base and from every entry, and prints it. First the gun turret is placed in its centre by the build bar (a real click). Then depth 1 is chosen and the four sides are laid by **four Shift-held drags** (queued, so none replaces another) with two engineers standing outside the rectangle. Wait (speed 3) until every wall tile of the four sides is complete (`progress` 1, no gaps).
5. Gate: the gate tool armed by its button, a Shift-held click on the side facing the spawn point → a gate order; still armed (Shift held), Escape → tool back to `select` (button text back to idle, `__game` tool `select`). Wait until the gate is complete (`progress` 1).
6. Spawn: rusher chosen, count 8 typed, Place, a click 10 tiles outside the gate side → 8 aliens within 6 tiles of the clicked tile. Within 60 s at speed 3: `stats().aliens.rusher` hit points removed from walls and gates > 0 (contact), and the gun turret's kills > 0. Then pause; the Stats tab's gun turret row and rusher row equal `__game.stats()` at the panel's recorded tick.
7. Tune: gun turret damage slider dragged with the mouse to 2× → `__game.tuning` shows 2 (± one step); the label's effective damage doubles. Reset kind → 1.
8. Isolation: a click, a drag and a wheel over the panel change nothing (selection, queues, camera, `__game.rejected` and the command count unchanged); a wall drag started on the map and released over the panel creates nothing.
9. Focus: with the count field focused and spawn armed, Escape disarms; Space with a panel button just clicked pauses once and does not press the button.
10. C1: an engineer moved directly behind a complete turret from the camera; a click on the turret's centre selects the turret; a click on the engineer's visible part selects the engineer; an engineer beside a reserved site and beside a gate's corridor is selectable.
11. C2: an engineer with a reserved turret site; an unshifted build-bar click on exactly that site is accepted (same building id, queue length 1).
12. D1: the pixel-pair check above, for a reserved outline and an upgrade frame behind a turret.
13. Screenshots to the art-reference folder: `w24r3-panel-build.png`, `-spawn.png`, `-tune.png`, `-economy.png`, `-stats.png`, `w24r3-overlays-occluded.png`.

### Run 3 acceptance criteria (tests in `game/test/w24r3-*.test.ts`, written first and red before the change)

1. Panel visibility follows the snapshot scenario through real save and load transitions in both directions.
2. Controls send exactly the commands and arguments listed (fake command sink), including depth on drag submission and preview, no axis on gate, count clamped to 1–50, wave 1–20 → index 0–19, slider mapping and quantisation, commit on release, two-click reset confirmation, refusal toasts, routes toggle and collapse.
3. Tool state machine: every transition above (tool change, Shift release, Escape, right click, world change, scenario not allowing the tool).
4. Tune labels: effective values for every supported field of one kind per target, including a research multiplier and the speed conversion.
5. Stats tables equal `statsReport` for a scripted fight (run 1's stats fixture).
6. C1, C2, C3 through the real picking and simulation code, with negatives: C2 refused when another unit holds the site and when kind, anchor or direction differ; C3 refused when no slot would be freed or the building table would overflow, with world state byte-identical after refusal; reused site ids kept.
7. Determinism and save continuation for C2/C3 as specified.
8. D1: frames and outlines use their own depth-tested materials; health bars do not.
9. D2: received / wanted from real one- and two-engineer worlds, with Field Engineering and with a `buildRate` tune; "no builder" when none; the inequality only across stable intervals.
10. Benchmark: the judge fails a window with median ≥ 50 ms, too few messages, or missing or non-finite values, and passes 49 ms; the recorder keeps more than 100 messages in a window.
11. If G: `?greybox=1` loads the models view, `__game.renderMode` is `models`, and nothing imports the removed files.
12. All existing tests pass (updated where D2 changes text, each update listed).

### Verify command — run 3 (frozen)

```
bash -c 'cd ~/Projects/worktrees/bulwark-w24/game && npm ci --no-audit --no-fund >/dev/null && \
npx vitest run "test/w24r3-" && npm test && npm run build && \
(cd ../look && npm ci --no-audit --no-fund >/dev/null && npx tsc --noEmit) && \
node scripts/fingerprint-compare.mjs 60ebba6 --strip-queue && \
node scripts/check-render.mjs --no-build --shots "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Rick'"'"'s World/Resources/Bulwark Art Reference" && \
node scripts/check-queue.mjs --no-build && \
node scripts/check-panel.mjs --no-build --shots "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Rick'"'"'s World/Resources/Bulwark Art Reference"'
```

Red at `13f0fe2`: no `w24r3-` tests exist (Codex ran the filter: exit 1, "No test files found") and there is no `check-panel.mjs`. At the tests-first commit the new tests fail.

### After the Verify passes

`/simplify`, then a post-build `/adversarial-review`, re-running the Verify after the last edit. Then Richard's go to push; the pull request into `main` follows this run. The verified build is republished to the fixed public address: `npx vite build --base ./ --outDir /tmp/bulwark-site --emptyOutDir && node ~/report-publish/publish-site.mjs /tmp/bulwark-site --name bulwark`.

### Out of scope (run 3)

New simulation features; new snapshot fields beyond the worker timing fields; waves, research and win/lose changes; mobile and touch; Safari and Firefox; the look of the models.

## Key decisions and tradeoffs

- **Sandbox commands live in the real simulation**, refused outside the sandbox scenario: deterministic, replayable, and the same code later serves debugging.
- **Tuning is a multiplier**, not an absolute value: one bound (0.1–10×) for every field, composes with tiers and research, and needs no per-field units.
- **A wall run is one order per builder** over a run table, so drag length is not limited by the 64-order queue.
- **Gates convert finished walls only**, matching W23's placement rule and avoiding queued-site ownership problems; a gate in a gap is not supported.
- **Port the renderer into `game/`** (run 2), not import from `look/`: the game's renderer is snapshot-driven and must not depend on a prototype package. `look/` changes only to keep compiling.
- **Build power change is a game-side adjustment**; the W12 model stays the balance reference.

## Risks and open questions

- **Balance at build power 8** — handled above.
- **The construction-state change alters W13 behaviour** (sites no longer block while only reserved). Existing tests may need updating; each change is listed.
- **Defaults chosen here, not by Richard:** drags are straight lines only; gates convert finished walls only, with no refund; the sandbox starts with map 1 stock, not free spending; the commander respawns after 10 s in the sandbox; tuning by multiplier.

## Out of scope (run 1)

The renderer port and panel (runs 2 and 3); waves and win/lose changes beyond `startWave` and the sandbox's no-end rule; new alien kinds; research tree redesign for "enhance existing units" (recorded, not built); terrain upgrade; Safari and Firefox; hosting; pushing branches or merging to `main`.

## Verify command — run 1 (frozen, re-runnable)

```bash
cd ~/Projects/worktrees/bulwark-w24/game && npm ci --no-audit --no-fund >/dev/null && \
npx vitest run test/w24-buildpower.test.ts test/w24-states.test.ts test/w24-footprint.test.ts \
  test/w24-wallrun.test.ts test/w24-gates.test.ts test/w24-sandbox.test.ts test/w24-stats.test.ts \
  test/w24-determinism.test.ts && \
npm test && npm run build && \
cd ../look && npm ci --no-audit --no-fund >/dev/null && npx tsc --noEmit
```

It fails on the current tree (none of the eight test files exists; vitest exits 1 with "No test files found"). The calling session also reads each test file against its acceptance criterion (a test that does not assert its criterion does not count), runs one probe of its own per mechanic through `window.__game` in agent-browser on port 8822, and checks 0 console errors.

## Author split

Run 1: one author, the `author` subagent (Opus 5.5 · high) via `/implement`, in `~/Projects/worktrees/bulwark-w24/` on branch `w24-sandbox`. Runs 2 and 3: the same route, each with its own plan section and Verify, written after the previous run is verified. Visual results (run 2's models, run 3's panel) need Richard's sign-off.
