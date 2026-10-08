# Bulwark — greybox game (W13)

Browser base-defence slice. TypeScript + Vite + Three.js 0.186 (WebGL renderer behind `src/render/adapter.ts`). The simulation runs in a dedicated Web Worker at 10 ticks/s and sends a transferred snapshot buffer to the render thread each tick.

```
npm install
npm run dev     # http://127.0.0.1:8822/   (sandbox: /?sandbox=1, stress scene: /?stress=1, seed: /?seed=7, debug rich start: /?rich=1)
npm test        # tsc + vitest, about 2 minutes (includes two headless full-map runs)
npm run build   # static build in dist/
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
- `src/render/` — camera rig, ground-ray picking, per-object LOD with hysteresis, instanced entity drawing, procedural geometry, terrain view.
- `src/main.ts` — wiring, input, HUD, `window.__game` debug hook.

Scale: 1 tile = 2 m; map 1 is 128 × 128 tiles.

## Rules (M3)

- **Waves**: map 1's 20 fixed waves from `model/data/map1.ts` (wave 1 at 3:00, wave 20 at 51:00; north from the start, east from wave 7). The ticker shows the next wave's number, countdown, composition by alien icon and count, and entry points (with Long-range scanners, the wave after it too).
- **Time**: Space pauses (orders can still be given and queue); Shift+1/2/3 or the buttons set 1×, 2×, 3×. Speed changes ticks per second only, never what a tick does.
- **Call next wave early** (C or button): the next wave arrives on the next tick and every later wave moves forward by the same time. Bonus = seconds skipped × (1.5 mass + 5 energy).
- **Checkpoints**: the full state is stored just before each wave starts. "Rewind to wave start" restores the start of the current wave, or the previous one if the current wave began under 5 s ago; the lose screen offers the same.
- **Research**: research stations make 1 RP/s each (W12 labRate); a node needs `seconds` RP and drains its cost while it runs, by the construction drain rule. One node at a time; never refunded. Beam turret, heavy cannon and shield generator need their research (W12 `requires`); wall tiers 2/3 and gun, area and heavy tier 2 need research, then engineers upgrade each building (U). Nodes and costs: `src/sim/balance.ts`.
- **Win/lose**: the commander's death is the only loss; the map is won when all 20 waves have arrived and every alien is destroyed.
- **Saves**: Export save downloads a `.bulwark` file (full state, `SAVE_VERSION` 2, state format = `SNAPSHOT_VERSION` 4 since W24); Import save loads one and refuses any other version with a message. Checkpoints are not included in the file.
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

## Controls

Space: pause. Shift+1/2/3: speed. C: call next wave. Y: research panel. H: help.
Left click or drag: select. Right click with units selected: reclaim a wreck (engineers), help an unfinished site, otherwise move; Shift queues. Build: select the commander or an engineer, pick from the build bar (or its hotkey), click to place; belts: drag for a line, R rotates; Esc or right click cancels. U then click a wall: upgrade it. T: engineers drop a temporary turret. X: stop. Right drag or Q/E: rotate. Wheel: zoom towards the cursor. Middle drag, WASD/arrows or the screen edge: pan. Home: whole map. The debug panel spawns a test group of each alien kind at each entry.

## Debug hook

`window.__game` (read-only): `wave`, `speed`, `paused`, `checkpoints`, `research`, `endState`, `rejected` (commands the worker refused, with reasons), `notices`, `lastSave`, `tick`, `entityCounts`, `lastTickMs`, `medianTickMs` and `maxTickMs` (last 100 ticks), `drawCalls`, `lodLevelCounts` (`full`, `simple`, `icon`, `culled`), `fps`, `frameCpuMs`, `renderer`, `errors`, `selected`, `selectAt(x, y)`, `pool` (mass/energy/rare, income, spend, short), `parts`, `commanderHp`, `alienCounts`, `buildQueue`, `routes`, `stats`, `ghost`, `buildMode`, `outcome`. Test helpers: `cmd.build(kind, tx, ty, {dir, ids, queue})`, `cmd.move(ids, x, z)`, `cmd.reclaim(ids, wreckId)`, `cmd.assist`, `cmd.upgrade`, `cmd.dropTurret`, `cmd.stop`, `cmd.spawn(kind, entry, count)`, `cmd.research(node)`, `cmd.produce()`, `cmd.callWave()` (`ids` null = every commander and engineer; an unknown kind, node or entry name throws), `control.pause/speed/rewind/save/loadLastSave/loadBytes`, `camera.get/set/view`, `list(type)`, `screenOf(type, id)`, `worldToScreen(x, z)`.

W24 adds: `buildRun(from, to, depth, {ids, queue})`, `cancelRun(id)`, `gate(tx, ty, {ids, axis})`, `spawnAt(kind, x, z, count)`, `tune(target, kind, field, mult)`, `tuneReset(target?, kind?)`, `setUnlimited(on)`, `grantResearch(node | 'all')`, `startWave(index)`, `clearAliens()`, `clearWrecks()`, `resetStats()`, `resetSandbox(full?)` — each resolves with `{ ok: true, tick, detail? }` or `{ ok: false, reason }` — and `stats()` (per-kind counters plus the W13 totals, which moved from the old `stats` getter to `counters`), `runs`, `tuning`, `unlimited`, `originRoutes`, `commanderRespawn`, `urlScenario`. `scenario` now reports the running world's scenario (a loaded save brings its own).
