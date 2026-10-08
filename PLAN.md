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

### Run 2b — animation, effects and performance (outline; planned after 2a)

From snapshots only, with a per-kind animation input matrix and a simulation-time clock (finding 9): unit walk with planted feet, build beam to a building site or reclaim beam to a wreck (by unit state), carry; alien gait with render-side heading, phase and seed; extractors animated while complete (income extractors never get `BF_ACTIVE`); gate doors opening for player units within 2 tiles. Reset rules for teleports, rewind and load (snapshot tick going backwards), id reuse, pause and speed changes. Turrets aim directly at the target's interpolated position with the game's flat projectile physics — not W20's ballistic solver (finding 2); recoil and muzzle flash best-effort, once per newly observed firing tick from the firing flag (finding 1); shots drawn from the muzzle to their snapshot positions with W21 effect pooling but no workshop collision. Combined performance gate with a frozen camera pose and placements, per-kind visible and detail-level minima, activity counters (engineers building, turrets firing, aliens attacking) checked throughout the measurement, game camera average ≥ 55 fps and 1%-low ≥ 45, strategic zoom-out average ≥ 40 (finding 11, 12).

### Run 2 decisions made here (Richard can overturn)

- **Terrain:** the playable map keeps the game's own gently rolling ground (the simulation does not use height, and buildings can go anywhere); the red-canyon look comes from W17 textures, lighting, haze, terraced outcrops on rock tiles and canyon scenery beyond the map edge. Making map 1 itself a canyon would change the playable map and needs a design decision first.
- **Turret mapping** as in the inventory; changing it later is a one-line edit.

## Run 3 — panel, controls and benchmark (outline; planned after run 2)

The five-tab panel (Build, Spawn, Tune, Economy, Stats), with real mouse drags and real clicks exercised in agent-browser (Codex 20); a check script that starts its own strict-port server from the tested tree, uses a funded enclosure or rock-bounded corridor with an explicitly placed turret (Codex 19), and cleans up; an automated benchmark at a fixed camera with a sustained population, reporting device pixel ratio, visible counts, average and 1%-low frame rate and worker timings (Codex 18). Colour-blind safe throughout.

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
