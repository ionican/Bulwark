// Starting states. 'map1' is the real map 1 start (commander, the W12 starting engineers, empty
// base, W12 start stock). 'stress' is the debug scene behind /?stress=1: 300 buildings, 500 aliens
// on their flow fields with combat running; buildings and units cannot fall below 1 hp and killed aliens
// respawn at an entry, so the counts hold while it is measured.

import { ALIEN_KINDS, B, BUILDING_KINDS, START_ENGINEERS, U } from './kinds.ts';
import { TILE_ROCK, tileAt } from './terrain.ts';
import { World } from './world.ts';

export type ScenarioName = 'map1' | 'stress' | 'empty';

export const STRESS_ALIENS = 500;
export const STRESS_BUILDINGS = 300;

export function createWorld(seed: number, scenario: ScenarioName): World {
  const w = new World(seed);
  if (scenario === 'map1') setupMap1(w);
  else if (scenario === 'stress') setupStress(w);
  w.computeRoutes();
  return w;
}

function startUnits(w: World) {
  const { base } = w.terrain;
  w.spawnUnit(U.commander, base.x + 0.5, base.z + 0.5);
  for (let i = 0; i < START_ENGINEERS; i++) w.spawnUnit(U.engineer, base.x - 2.5 + i * 5 / Math.max(1, START_ENGINEERS - 1), base.z + 3.5);
}

function setupMap1(w: World) {
  startUnits(w);
}

function setupStress(w: World) {
  w.debug.indestructible = true;
  w.debug.respawnAliens = true;
  w.pool.set([1e9, 1e9, 1e9]);
  w.parts = 1e6;
  startUnits(w);
  const t = w.terrain;
  let placed = 0;
  for (const d of t.deposits) {
    if (w.placeBuilding(d.kind === 'mass' ? B.massExtractor : B.rareExtractor, d.tx, d.ty, true) >= 0) placed++;
  }
  // Mixed kinds, excluding the extractors (they need deposits). Walls get extra weight.
  const pool = BUILDING_KINDS.map((_, i) => i).filter((k) => k !== B.massExtractor && k !== B.rareExtractor && k !== B.tempTurret);
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
