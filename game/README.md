# Bulwark — the game (W13 greybox slice; W24 sandbox and models)

Browser base-defence slice. TypeScript + Vite + Three.js 0.186 (WebGL renderer behind `src/render/adapter.ts`; W21's post stack from `postprocessing` and `n8ao`). Drawn with the W17–W23 models since W24 run 2a; `?greybox=1` shows W13's greybox renderer. The simulation runs in a dedicated Web Worker at 10 ticks/s and sends a transferred snapshot buffer to the render thread each tick.

```
npm install
npm run dev     # http://127.0.0.1:8822/   (sandbox: /?sandbox=1, stress scene: /?stress=1, seed: /?seed=7, debug rich start: /?rich=1,
                #  W13 greybox view: /?greybox=1, high quality: /?quality=high)
npm test        # tsc + vitest, about 2 minutes (includes two headless full-map runs)
npm run build   # static build in dist/
node scripts/fingerprint-compare.mjs <commit> [--strip-queue]   # simulation unchanged against a commit (snapshot and save hashes;
                #  --strip-queue: W25's snapshot queue section left out, to compare with a tree from before it)
node scripts/check-render.mjs [--shots <dir>]   # browser check of the model view on port 8823 (agent-browser, session w24-2a)
node scripts/check-queue.mjs [--shots <dir>]    # W25 build queue and drag preview, real input, port 8824 (agent-browser, session w25)
```

## Layout

- `src/sim/` — pure TypeScript, no DOM; runs in the worker and in Node tests.
  - `world.ts` — state and fixed-step update; `table.ts` / `schema.ts` — typed-array entity tables (buildings, aliens, units)
  - `snapshot.ts` — snapshot encoder/decoder (layout documented in the file); `commands.ts` — commands stamped with a tick
  - `terrain.ts` — map 1 terrain from code (fixed, not seeded by the game seed); `kinds.ts` — kinds, using numbers from `../model/data/map1.ts`
  - `worker.ts` — the fixed-tick loop and message handling; `scenarios.ts` — map 1 start and stress start states
  - `economy.ts` — income, energy upkeep, construction drain (worst supply ratio per build); `units.ts` — orders, A* (`pathfind.ts`), reclaim
  - `conveyor.ts` — belts, splitter, merger, machines, depot; `combat.ts` — turrets, projectiles, armour, shields
  - `aliens.ts` — movement on flow fields (`flowfield.ts`, one per target category) and attacks
- `src/render/` — camera rig, ground-ray picking, per-object LOD with hysteresis, instanced entity drawing, procedural geometry, terrain view. W24 run 2a (models, see below): `adapter.ts` (renderer, post, quality, timing), `view.ts` (scene per mode), `ground.ts` and `groundView.ts` (the one ground, scenery, outcrops, paving), `models.ts` (every kind from snapshots), `wallLayout.ts`, `w17Batches.ts`, `icons.ts`, `materials.ts`, `inspect.ts` (scene inspection), `cost.ts` (frame cost), and `workshop/` (the ported look/ sources; its README lists them).
- `src/main.ts` — wiring, input, HUD, `window.__game` debug hook.

Scale: 1 tile = 2 m; map 1 is 128 × 128 tiles.

## Rules (M3)

- **Waves**: map 1's 20 fixed waves from `model/data/map1.ts` (wave 1 at 3:00, wave 20 at 51:00; north from the start, east from wave 7). The ticker shows the next wave's number, countdown, composition by alien icon and count, and entry points (with Long-range scanners, the wave after it too).
- **Time**: Space pauses (orders can still be given and queue); Shift+1/2/3 or the buttons set 1×, 2×, 3×. Speed changes ticks per second only, never what a tick does.
- **Call next wave early** (C or button): the next wave arrives on the next tick and every later wave moves forward by the same time. Bonus = seconds skipped × (1.5 mass + 5 energy).
- **Checkpoints**: the full state is stored just before each wave starts. "Rewind to wave start" restores the start of the current wave, or the previous one if the current wave began under 5 s ago; the lose screen offers the same.
- **Research**: research stations make 1 RP/s each (W12 labRate); a node needs `seconds` RP and drains its cost while it runs, by the construction drain rule. One node at a time; never refunded. Beam turret, heavy cannon and shield generator need their research (W12 `requires`); wall tiers 2/3 and gun, area and heavy tier 2 need research, then engineers upgrade each building (U). Nodes and costs: `src/sim/balance.ts`.
- **Win/lose**: the commander's death is the only loss; the map is won when all 20 waves have arrived and every alien is destroyed.
- **Saves**: Export save downloads a `.bulwark` file (full state, `SAVE_VERSION` 2, state format = `SNAPSHOT_VERSION` 5 since W25; W24's state format 4 still loads, the save content is the same); Import save loads one and refuses any other version with a message. Checkpoints are not included in the file.
- **Engineers**: the commander produces them (Produce engineer button; W12 cost 60 mass, 200 energy, 80 BP·s).

## Balance

W12 numbers are used unchanged wherever W12 has them. Numbers the game adds, and every change to a W12 number, live in `src/sim/balance.ts`. Changes to W12 numbers:

| What | W12 | Game | Why |
|---|---|---|---|
| Commander build power | 10 BP | 8 BP | Richard's decision (2026-10-08, W24): commander 8, engineer 5. |
| Rare extractor output | 0.1 per second | 0.25 per second | With 0.1/s the scripted balanced plan collected about 300 rare in 48 minutes: the two north points sit 30 tiles beyond the north line and saboteurs keep killing them, as W12 also saw. Research took all of it, so no beam turret stood before minute 32, and the hunter waves (14, 16, 17, 19, 20) killed the commander every run. |

New numbers (W12 had no equivalent): call-early bonus; research nodes Deep drills, Long-range scanners, Field engineering, Heavy cannon tier 2; belt pieces; engineer carry capacity 20; commander gun range 8 tiles; shield radius 8 tiles; projectile speeds.

Headless check (`test/fullmap.test.ts`, `test/plans.ts`): W12's balanced plan, placed on tiles, wins map 1 (W24, commander 8 BP, seed 1: tick 31,468 = 52:26, commander 6,000/6,000 hp; the two core guns moved from minute 3 to minute 2 for W24); the same economy with no defences loses at 13:22 (wave 5). Before W24 (10 BP): 52:42, 5,880 hp.

## W24 run 1: mechanics sandbox (simulation)

- **Construction states**: a site is *reserved* until build power first reaches it (holds its tiles, blocks nobody, no flow cost; aliens can still make it their goal), then *started* (blocks units and aliens, flow cost at its hit points), then *complete*. Units and aliens on its tiles when it starts are moved to the nearest free passable tile that tick. Drawn as a dotted outline, a scaffold frame, a model.
- **Footprints**: `fw × fh` per building (schema columns) replace the square `size`.
- **Wall runs** (`runs.ts`): `buildRun` lays a straight run 1–4 deep, up to 128 tiles along; one order per builder; 32-run table; `cancelRun`.
- **Gates** (`gate.ts`): converted from finished walls with W23's predicate; 3 × depth; corridor in the centre column for units; aliens break through (flow cost hp ÷ depth per tile).
- **Sandbox** (`/?sandbox=1`, `sandbox.ts`): no waves, no end state (the commander respawns after 10 s), and commands `spawnAt`, `tune`/`tuneReset` (`tuning.ts`), `setUnlimited`, `grantResearch`, `startWave`, `clearAliens`, `clearWrecks`, `resetStats`, `resetSandbox`, refused outside the sandbox. The scenario is stored in the world, saves and snapshots.
- **Stats** (`stats.ts`): per-kind counters, in every snapshot.

## W25: build queue (Supreme Commander style)

- **Per-unit queues** (`src/sim/queue.ts`): an order goes onto the queue of every unit selected when it was given; units that share an item build it together, each when it reaches that item in its own queue; a unit never works on an item it has not queued (except by an assist order).
- **Shift appends, no Shift replaces**, for every order kind (build, wall run, gate, upgrade, move, assist, reclaim). When orders are replaced or removed, a reserved site no unit holds any more is removed (it cost nothing: no refund); a started site stays part-built; a wall run with no run order left loses its reserved tiles and its run-table slot. Exceptions: a gate site stays (its walls were converted when it was ordered); `stop`, a unit's death and an unreachable site leave sites as in W24.
- **Commands** `dequeue { id, index, expect? }` (`expect` names the item as the snapshot showed it, so a queue that moved on before the command's tick still loses the right item) and `clearQueue { ids }`; refusals come back through the final-result path.
- **Snapshot** version 5: a queue section per unit (order kind, target id, run id, position; `queueOf`). Nothing on the render thread changes queues.
- **Drawn** for the selected units only (`render/queueView.ts`): a line from the unit through each target in order, an arrowhead per target, a numbered label per target (one label listing the positions where selected units share an item); units are told apart by dash pattern (long, short, dash-dot), never colour. The **queue panel** (bottom left) lists each selected unit's queue with a remove control per item and Clear per unit, and names each unit's line style.
- **Build tool**: stays open while Shift is held; releasing Shift after a Shift placement closes it (belts stay open, as before); Esc always closes it.
- **Drag preview** (`dragPlan.ts`, `render/dragPreview.ts`): while a wall run or belt line is dragged, the planned tiles are drawn every frame from the simulation's own run planner (`runs.ts planRunOn`) on the latest snapshot: a solid outline on tiles that will be built, a dashed outline and a cross on tiles that will be skipped, and a label at the cursor (tiles, skipped, cost). Esc during the drag queues nothing.

## Controls

Space: pause. Shift+1/2/3: speed. C: call next wave. Y: research panel. H: help.
Left click: select; Shift + left drag: box select. Right click with units selected: reclaim a wreck (engineers), help an unfinished site, otherwise move; Shift queues. Build: select the commander or an engineer, pick from the build bar (or its hotkey), click to place; walls: drag for a run (`buildRun`), belts: drag for a line, R rotates; Esc or right click cancels. U then click a wall: upgrade it. T: engineers drop a temporary turret. X: stop. Camera (W24 run 2a, the workshop's orbit feel, with damping): left drag orbits (turn and tilt, 10°–89° above the horizon); right drag, WASD/arrows or the screen edge: pan on the ground; wheel: zoom towards the cursor; middle drag: dolly; Q/E: turn. A press that moves 5 px or less is a click and never moves the camera. Home: whole map. The debug panel spawns a test group of each alien kind at each entry.

## Debug hook

`window.__game` (read-only): `wave`, `speed`, `paused`, `checkpoints`, `research`, `endState`, `rejected` (commands the worker refused, with reasons), `notices`, `lastSave`, `tick`, `entityCounts`, `lastTickMs`, `medianTickMs` and `maxTickMs` (last 100 ticks), `drawCalls`, `lodLevelCounts` (`full`, `simple`, `icon`, `culled`), `fps`, `frameCpuMs`, `renderer`, `errors`, `selected`, `selectAt(x, y)`, `pool` (mass/energy/rare, income, spend, short), `parts`, `commanderHp`, `alienCounts`, `buildQueue`, `routes`, `stats`, `ghost`, `buildMode`, `outcome`. Test helpers: `cmd.build(kind, tx, ty, {dir, ids, queue})`, `cmd.move(ids, x, z)`, `cmd.reclaim(ids, wreckId)`, `cmd.assist`, `cmd.upgrade`, `cmd.dropTurret`, `cmd.stop`, `cmd.spawn(kind, entry, count)`, `cmd.research(node)`, `cmd.produce()`, `cmd.callWave()` (`ids` null = every commander and engineer; an unknown kind, node or entry name throws), `control.pause/speed/rewind/save/loadLastSave/loadBytes`, `camera.get/set/view`, `list(type)`, `screenOf(type, id)`, `worldToScreen(x, z)`.

W24 adds: `buildRun(from, to, depth, {ids, queue})`, `cancelRun(id)`, `gate(tx, ty, {ids, axis})`, `spawnAt(kind, x, z, count)`, `tune(target, kind, field, mult)`, `tuneReset(target?, kind?)`, `setUnlimited(on)`, `grantResearch(node | 'all')`, `startWave(index)`, `clearAliens()`, `clearWrecks()`, `resetStats()`, `resetSandbox(full?)` — each resolves with its final result, `{ ok: true, tick, detail? }` once applied at its tick or `{ ok: false, reason }` if refused when sent or at its tick — and `stats()` (per-kind counters plus the W13 totals, which moved from the old `stats` getter to `counters`), `runs`, `tuning`, `unlimited`, `originRoutes`, `commanderRespawn`, `urlScenario`. `scenario` now reports the running world's scenario (a loaded save brings its own).

## W24 run 2a: models from snapshots

The default view draws every kind with the workshop's models, in a static pose, from snapshots only
(render code imports only the simulation's pure data modules; `test/w24r2a-imports.test.ts`):

| Kind | Model | Strategic-zoom icon |
|---|---|---|
| wall, gate | W23 walls and gates (autotiled; doors closed) | W23 wall / gate |
| mass, rare extractor | W23 extractors (idle pose); bare deposits W23's | W23 extractor / dashed deposit |
| gun, area, beam, heavy, temporary turret | W22 kit kinds bastion, anvil, lantern, rampart, lookout (heavy × 1.35, temporary × 0.6 for their footprints), yaw towards the target | W22 kit icons |
| generator, research station, depot, shredder, smelter, assembler, shield, belt | W17 procedural models | new shape-coded icons |
| splitter, merger | W17 belt plus an arrow marker: one in, three out / three in, one out | new icons |
| commander, engineer | W23 rigs at rest, feet on the ground | W23 commander / engineer |
| rusher, hunter, breaker, saboteur | W17/W21 alien models, 1.5 × | new shape-coded icons |

- **Ground**: one sampler, `ground.ts groundHeight`, equal to the mesh triangles (diagonal from (x+1, z) to (x, z+1)); picking, feet, building bases and icons use it. W17's terrain material shades it: cliff from slope and rock tiles, paving under complete buildings (a per-tile texture), weathering from noise. Terraced outcrops on rock tiles; canyon scenery beyond the edge on the map's own edge vertices.
- **Construction**: reserved = dotted outline; started = the model cut at base + height × progress (W23's cut and depth material; W17's materials patched the same way); complete = the model. Two damage states below 2/3 and 1/3 of the hit points.
- **Foundations**: a building stands at the highest ground under its footprint on a plinth down to the lowest.
- **Wall topology** is rebuilt only when the layout key changes (tile, tier, reserved or not, gate, gate axis and footprint).
- **Lighting and post**: W17's sun (one shadow map fitted near the camera), HDRI light, haze and sky; W21's post stack (N8AO, bloom, ACES, SMAA). Quality medium by default (pixel ratio ≤ 1); `?quality=high` or `__game.setQuality('high')`.
- **Walking** (brought forward from 2b, `walk.ts`): the commander and engineers walk with W23's gait and planted feet, aliens with W21's gait phase, both advanced by the distance moved between frames; a new id, a jump over 2 tiles or the tick going backwards resets; paused, nothing advances.
- **Overlays** (health bars, beams and work lines, shots, shields, selection, entry labels) are still W13's (effects are run 2b). Alien routes are not drawn (Richard, 8 Oct); the simulation still computes them.

W25 adds: `queues` (every unit's queue from the snapshot), `queuePanel`, `inspectQueue()` (lines, labels and arrowheads read from the scene), `dragPreview` (the plan and what the scene draws for it, during a drag), `reservedOutlines()`, `shiftHeld`, `shiftPlaced`, `dequeue(id, index, expect?)`, `clearQueue(ids)`.

`window.__game` adds: `renderMode`, `quality`, `setQuality(q)`, `viewport`, `timing` (CPU ms of the last frame's update and of each render pass), `wallRebuilds`, `overflowed`, `inspect()` (per kind: model and icon instances found in the scene graph on that kind's entities, greybox instances, mesh and material names), `renderCost(frames)` (forced-completion frame cost with the ground, post and each post pass switched off), `place(kind, tx, ty, dir)` (debug: the simulation's `place` command, a complete building at once). `lodLevelCounts` has `middle` in the model view.

Notes, measurements and screenshots: `W24-RUN2A-NOTES.md`.
