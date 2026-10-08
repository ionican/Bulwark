// W24 sandbox: map 1 terrain and deposits, the commander and the map 1 starting engineers, map 1
// starting stock and no wave schedule (no wave arrives unless started). The scenario is world
// state (World.scenario), so saves and snapshots carry it. The sandbox never wins or loses: a dead
// commander leaves its wreck and a new one appears at the base 10 s later (balance.ts
// SANDBOX_RESPAWN_TICKS), and commands keep applying throughout.
//
// The sandbox commands (commands.ts) are refused with a reason in any other scenario. Each is
// deterministic and replayable like any other command; the render thread never changes the
// simulation directly.

import { ALIEN_KINDS, alienInfo } from './kinds.ts';
import { TILE_ROCK, tileAt } from './terrain.ts';
import type { World } from './world.ts';

export const SPAWN_AT_MAX = 50;
/** Tiles round the spawn point searched for room (Euclidean, to tile centres). */
export const SPAWN_RADIUS = 6;
/** Minimum distance between a new alien and any other alien, in tiles. */
export const SPAWN_SPACING = 0.8;
/** Recent spawn origins kept for the route overlay. */
export const MAX_SPAWN_ORIGINS = 8;
/** Wreck kind used for the commander's wreck (alien wreck kinds are 0..ALIEN_KINDS.length-1). */
export const WRECK_COMMANDER = ALIEN_KINDS.length;

export interface SpawnOrigin {
  x: number;
  z: number;
  kind: number;
}

/**
 * Where `spawnAt` puts `count` aliens: one per tile centre, on passable tiles with no building,
 * within SPAWN_RADIUS tiles of (x, z) and at least SPAWN_SPACING from every alien, searched ring
 * by ring round the point's tile and within a ring by (ty, tx). Returns the points, or the reason
 * the full count cannot be placed (then nothing is spawned).
 */
export function spawnPlaces(w: World, kind: number, x: number, z: number, count: number): Array<[number, number]> | string {
  if (w.aliens.count + count > w.aliens.capacity) return `the alien table would overflow (${w.aliens.count} + ${count} > ${w.aliens.capacity})`;
  const t = w.terrain;
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const out: Array<[number, number]> = [];
  const ac = w.aliens.cols;
  const clear = (px: number, pz: number) => {
    for (let s = 0; s < w.aliens.highWater; s++) {
      if (!w.aliens.alive[s]) continue;
      const dx = ac.x[s]! - px;
      const dz = ac.z[s]! - pz;
      if (dx * dx + dz * dz < SPAWN_SPACING * SPAWN_SPACING) return false;
    }
    return true;
  };
  for (let r = 0; r <= SPAWN_RADIUS && out.length < count; r++) {
    for (let ty = z0 - r; ty <= z0 + r && out.length < count; ty++) {
      for (let tx = x0 - r; tx <= x0 + r && out.length < count; tx++) {
        if (Math.max(Math.abs(tx - x0), Math.abs(ty - z0)) !== r) continue;
        if (tx < 0 || ty < 0 || tx >= t.w || ty >= t.h) continue;
        const px = tx + 0.5;
        const pz = ty + 0.5;
        if ((px - x) ** 2 + (pz - z) ** 2 > SPAWN_RADIUS * SPAWN_RADIUS) continue;
        if (tileAt(t, tx, ty) === TILE_ROCK || w.occupancy[ty * t.w + tx] !== 0) continue;
        if (!clear(px, pz)) continue;
        out.push([px, pz]);
      }
    }
  }
  if (out.length < count) return `only ${out.length} of ${count} ${ALIEN_KINDS[kind]}s fit within ${SPAWN_RADIUS} tiles of ${x.toFixed(1)},${z.toFixed(1)} (passable, free, ${SPAWN_SPACING} apart)`;
  return out;
}

/** Spawns the aliens at the planned points and records the origin for the route overlay. */
export function applySpawnAt(w: World, kind: number, x: number, z: number, count: number): void {
  const places = spawnPlaces(w, kind, x, z, count);
  if (typeof places === 'string') return;
  for (const [px, pz] of places) w.spawnAlien(kind, px, pz);
  w.spawnOrigins.push({ x, z, kind });
  if (w.spawnOrigins.length > MAX_SPAWN_ORIGINS) w.spawnOrigins.shift();
  w.computeOriginRoutes();
}

/** The predicted route of each recent spawn origin's aliens (their category's flow field). */
export function originRoutes(w: World): Array<{ origin: number; category: number; cells: number[] }> {
  const t = w.terrain;
  return w.spawnOrigins.map((o, i) => {
    const cx = Math.min(t.w - 1, Math.max(0, Math.floor(o.x)));
    const cz = Math.min(t.h - 1, Math.max(0, Math.floor(o.z)));
    const category = alienInfo(o.kind).category;
    return { origin: i, category, cells: w.fields[category]!.trace(cz * t.w + cx, 600) };
  });
}

/** Removes every alien and pending spawn. No wrecks, no kills, no statistics. */
export function clearAliens(w: World): void {
  const a = w.aliens;
  for (let s = 0; s < a.highWater; s++) if (a.alive[s]) a.remove(s);
  w.pending = [];
}

export function clearWrecks(w: World): void {
  const wr = w.wrecks;
  for (let s = 0; s < wr.highWater; s++) if (wr.alive[s]) wr.remove(s);
}
