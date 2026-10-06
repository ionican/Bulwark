# Bulwark — greybox game (W13)

Browser base-defence slice. TypeScript + Vite + Three.js 0.186 (WebGL renderer behind `src/render/adapter.ts`). The simulation runs in a dedicated Web Worker at 10 ticks/s and sends a transferred snapshot buffer to the render thread each tick.

```
npm install
npm run dev     # http://127.0.0.1:8813/   (stress scene: /?stress=1, seed: /?seed=7, debug rich start: /?rich=1)
npm test        # tsc + vitest (determinism, snapshot round-trip, picking, LOD, M2 systems, headless map 1 scenario)
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

## Controls

Left click or drag: select. Right click with units selected: reclaim a wreck (engineers), help an unfinished site, otherwise move; Shift queues. Build: select the commander or an engineer, pick from the build bar (or its hotkey), click to place; belts: drag for a line, R rotates; Esc or right click cancels. U then click a wall: upgrade it. T: engineers drop a temporary turret. X: stop. Right drag or Q/E: rotate. Wheel: zoom towards the cursor. Middle drag, WASD/arrows or the screen edge: pan. Home: whole map. The debug panel spawns a test group of each alien kind at each entry.

## Debug hook

`window.__game` (read-only): `tick`, `entityCounts`, `lastTickMs`, `medianTickMs` and `maxTickMs` (last 100 ticks), `drawCalls`, `lodLevelCounts` (`full`, `simple`, `icon`, `culled`), `fps`, `frameCpuMs`, `renderer`, `errors`, `selected`, `selectAt(x, y)`, `pool` (mass/energy/rare, income, spend, short), `parts`, `commanderHp`, `alienCounts`, `buildQueue`, `routes`, `stats`, `ghost`, `buildMode`, `outcome`. Test helpers: `cmd.build(kind, tx, ty, {dir, ids, queue})`, `cmd.move(ids, x, z)`, `cmd.reclaim(ids, wreckId)`, `cmd.assist`, `cmd.upgrade`, `cmd.dropTurret`, `cmd.stop`, `cmd.spawn(kind, entry, count)` (`ids` null = every commander and engineer), `camera.get/set/view`, `list(type)`, `screenOf(type, id)`, `worldToScreen(x, z)`.
