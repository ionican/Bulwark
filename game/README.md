# Bulwark — greybox game (W13)

Browser base-defence slice. TypeScript + Vite + Three.js 0.186 (WebGL renderer behind `src/render/adapter.ts`). The simulation runs in a dedicated Web Worker at 10 ticks/s and sends a transferred snapshot buffer to the render thread each tick.

```
npm install
npm run dev     # http://127.0.0.1:8813/   (stress scene: /?stress=1, seed: /?seed=7)
npm test        # tsc + vitest (sim determinism, snapshot round-trip, picking maths, LOD)
npm run build   # static build in dist/
```

## Layout

- `src/sim/` — pure TypeScript, no DOM; runs in the worker and in Node tests.
  - `world.ts` — state and fixed-step update; `table.ts` / `schema.ts` — typed-array entity tables (buildings, aliens, units)
  - `snapshot.ts` — snapshot encoder/decoder (layout documented in the file); `commands.ts` — commands stamped with a tick
  - `terrain.ts` — map 1 terrain from code (fixed, not seeded by the game seed); `kinds.ts` — kinds, using numbers from `../model/data/map1.ts`
  - `worker.ts` — the fixed-tick loop and message handling; `scenarios.ts` — demo and stress start states
- `src/render/` — camera rig, ground-ray picking, per-object LOD with hysteresis, instanced entity drawing, procedural geometry, terrain view.
- `src/main.ts` — wiring, input, HUD, `window.__game` debug hook.

Scale: 1 tile = 2 m; map 1 is 128 × 128 tiles.

## Controls

Left click or drag: select. Right click: move the selected commander/engineers. Right drag or Q/E: rotate. Wheel: zoom towards the cursor. Middle drag, WASD/arrows or the screen edge: pan. Home: whole map.

## Debug hook

`window.__game` (read-only): `tick`, `entityCounts`, `lastTickMs`, `medianTickMs` (last 100 ticks), `drawCalls`, `lodLevelCounts` (`full`, `simple`, `icon`, `culled`), `fps`, `frameCpuMs`, `renderer`, `errors`, `selected`, `selectAt(x, y)`. Test helpers: `camera.get()`, `camera.set({x, z, distance, yaw})`, `camera.view('close' | 'mid' | 'far')`, `list(type)`, `screenOf(type, id)`.
