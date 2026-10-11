// Starting states. 'map1' is the real map 1 start (commander, the W12 starting engineers, empty
// base, W12 start stock). 'stress' is the debug scene behind /?stress=1: 300 buildings, 500 aliens
// on their flow fields with combat running; buildings and units cannot fall below 1 hp and killed aliens
// respawn at an entry, so the counts hold while it is measured. 'sandbox' (W24, /?sandbox=1) is
// map 1's start with no wave schedule, no end state and the sandbox commands (sandbox.ts).
// The scenario is stored on the world (World.scenario), so saves and snapshots carry it.
// W29: map 1 and the sandbox deliver by belt (World.belts) and have the core beside the
// commander's start (balance.ts CORE_OFFSET); 'stress' and 'empty' keep the instant economy.

import { ALIEN_KINDS, B, BUILDING_KINDS } from './kinds.ts';
import { CORE_OFFSET } from './balance.ts';
import { TILE_ROCK, tileAt, type Terrain } from './terrain.ts';
import type { Tuning } from './tuning.ts';
import { World, type ScenarioName } from './world.ts';

export type { ScenarioName };

export const STRESS_ALIENS = 500;
export const STRESS_BUILDINGS = 300;

/**
 * A world at a scenario's start. `opts` (the sandbox reset): the terrain to use, and the tuning
 * and unlimited spending to carry over, set before any unit is created.
 */
export function createWorld(seed: number, scenario: ScenarioName, opts: { terrain?: Terrain; tuning?: Tuning; unlimited?: boolean } = {}): World {
  const belts = scenario === 'map1' || scenario === 'sandbox';
  const w = new World(seed, opts.terrain, { waves: scenario !== 'sandbox', belts });
  w.scenario = scenario;
  if (opts.tuning) {
    w.tuning.building.set(opts.tuning.building);
    w.tuning.alien.set(opts.tuning.alien);
    w.tuning.unit.set(opts.tuning.unit);
  }
  if (opts.unlimited) w.unlimited = true;
  if (belts) {
    w.spawnStartUnits();
    const { base } = w.terrain;
    if (w.placeBuilding(B.core, Math.floor(base.x) + CORE_OFFSET[0], Math.floor(base.z) + CORE_OFFSET[1], true) < 0) throw new Error('the core does not fit beside the base');
  }
  else if (scenario === 'stress') setupStress(w);
  w.computeRoutes();
  return w;
}

function setupStress(w: World) {
  w.debug.indestructible = true;
  w.debug.respawnAliens = true;
  w.pool.set([1e9, 1e9, 1e9]);
  w.parts = 1e6;
  w.spawnStartUnits();
  const t = w.terrain;
  let placed = 0;
  for (const d of t.deposits) {
    if (w.placeBuilding(d.kind === 'mass' ? B.massExtractor : B.rareExtractor, d.tx, d.ty, true) >= 0) placed++;
  }
  // Mixed kinds, excluding the extractors (they need deposits), the temporary turret and the gate
  // (made from walls). Walls get extra weight.
  // W29: and the core (only belts worlds have one).
  const pool = BUILDING_KINDS.map((_, i) => i).filter((k) => k !== B.massExtractor && k !== B.rareExtractor && k !== B.tempTurret && k !== B.gate && k !== B.core);
  pool.push(B.wall, B.wall, B.wall);
  let attempts = 0;
  while (placed < STRESS_BUILDINGS && attempts++ < 20000) {
    const kind = pool[w.rng.int(pool.length)]!;
    const tx = 4 + w.rng.int(t.w - 8);
    const ty = 4 + w.rng.int(t.h - 8);
    if (w.placeBuilding(kind, tx, ty, true, w.rng.int(4)) >= 0) placed++;
  }
  let aliens = 0;
  attempts = 0;
  while (aliens < STRESS_ALIENS && attempts++ < 20000) {
    const x = w.rng.range(2, t.w - 2);
    const z = w.rng.range(2, t.h - 2);
    if (tileAt(t, Math.floor(x), Math.floor(z)) === TILE_ROCK || w.occupancy[Math.floor(z) * t.w + Math.floor(x)] !== 0) continue;
    w.spawnAlien(aliens % ALIEN_KINDS.length, x, z);
    aliens++;
  }
}
