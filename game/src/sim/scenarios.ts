// Starting states. 'demo' is the M1 default scene (a small base and a few wandering aliens, so
// every LOD level has something to show); 'stress' is the debug scene behind /?stress=1.
// M2 replaces 'demo' with the real map 1 start.

import { ALIEN_KINDS, B, BUILDING_KINDS, U } from './kinds.ts';
import { TILE_ROCK, tileAt } from './terrain.ts';
import { World } from './world.ts';

export type ScenarioName = 'demo' | 'stress' | 'empty';

export const STRESS_ALIENS = 500;
export const STRESS_BUILDINGS = 300;

export function createWorld(seed: number, scenario: ScenarioName): World {
  const w = new World(seed);
  if (scenario === 'demo') setupDemo(w);
  else if (scenario === 'stress') setupStress(w);
  return w;
}

function startUnits(w: World) {
  const { base } = w.terrain;
  w.spawnUnit(U.commander, base.x, base.z + 3);
  w.spawnUnit(U.engineer, base.x - 2.5, base.z + 4.5);
  w.spawnUnit(U.engineer, base.x + 2.5, base.z + 4.5);
}

function setupDemo(w: World) {
  startUnits(w);
  const { base } = w.terrain;
  const mass = w.terrain.deposits.filter((d) => d.kind === 'mass');
  for (const d of mass.slice(0, 5)) w.placeBuilding(B.massExtractor, d.tx, d.ty, true);
  const rare = w.terrain.deposits.find((d) => d.kind === 'rare');
  if (rare) w.placeBuilding(B.rareExtractor, rare.tx, rare.ty, true);
  const at = (kind: number, dx: number, dz: number) => w.placeBuilding(kind, base.x + dx, base.z + dz, true);
  at(B.generator, -8, 4);
  at(B.generator, -8, 7);
  at(B.generator, -5, 7);
  at(B.lab, 4, 5);
  at(B.depot, -12, -3);
  at(B.shredder, -9, -3);
  at(B.smelter, -6, -3);
  at(B.assembler, -3, -3);
  // A wall line across the north approach and a short one on the east.
  for (let i = -6; i <= 6; i++) at(B.wall, i, -14);
  for (let i = -5; i <= 5; i++) at(B.wall, 14, i);
  at(B.gun, -4, -17 + 5);
  at(B.gun, 3, -17 + 5);
  at(B.area, -1, -11);
  at(B.beam, 7, -10);
  at(B.heavy, 10, -2);
  at(B.shield, 8, 3);
  at(B.tempTurret, -2, -16);
  // Aliens gathering at both entries.
  for (let i = 0; i < 48; i++) {
    const e = w.terrain.entries[i % w.terrain.entries.length]!;
    const kind = i % ALIEN_KINDS.length;
    const x = e.x + e.dirX * 12 + w.rng.range(-8, 8);
    const z = e.z + e.dirZ * 12 + w.rng.range(-8, 8);
    w.spawnAlien(kind, x, z);
  }
}

function setupStress(w: World) {
  startUnits(w);
  const t = w.terrain;
  let placed = 0;
  for (const d of t.deposits) {
    if (w.placeBuilding(d.kind === 'mass' ? B.massExtractor : B.rareExtractor, d.tx, d.ty, true) >= 0) placed++;
  }
  // Mixed kinds, excluding the extractors (they need deposits). Walls get extra weight.
  const pool = BUILDING_KINDS.map((_, i) => i).filter((k) => k !== B.massExtractor && k !== B.rareExtractor);
  pool.push(B.wall, B.wall, B.wall);
  let attempts = 0;
  while (placed < STRESS_BUILDINGS && attempts++ < 20000) {
    const kind = pool[w.rng.int(pool.length)]!;
    const tx = 4 + w.rng.int(t.w - 8);
    const ty = 4 + w.rng.int(t.h - 8);
    if (w.placeBuilding(kind, tx, ty, true) >= 0) placed++;
  }
  let aliens = 0;
  attempts = 0;
  while (aliens < STRESS_ALIENS && attempts++ < 20000) {
    const x = w.rng.range(2, t.w - 2);
    const z = w.rng.range(2, t.h - 2);
    if (tileAt(t, Math.floor(x), Math.floor(z)) === TILE_ROCK) continue;
    w.spawnAlien(aliens % ALIEN_KINDS.length, x, z);
    aliens++;
  }
}
