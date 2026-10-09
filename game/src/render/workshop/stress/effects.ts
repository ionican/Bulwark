// Ported from look/src/stress/effects.ts for W24 run 2b (game/src/render/workshop/README: copies, adapted only where noted).
// Adapted: only the muzzle blasts and the particle caps are ported. The shell pool (W20's exact
// ballistic arc, tested against the aliens each frame), the casing pool and the muzzle lights are
// the workshop's fire control and collision, which the game does not port: the game's shots come
// from the snapshot's projectile rows (render/effects.ts).

import type { Vector3 } from 'three';
import { PType, type Particles } from '../fx/particles.ts';

export const PARTICLE_CAPS = { smoke: 4000, glow: 4000 };

/** Reduced muzzle blast for turrets at middle detail. */
export function blastMiddle(fx: Particles, mx: number, my: number, mz: number, dir: Vector3, side: Vector3, port: Vector3): void {
  fx.spawn({ type: PType.Flash, x: mx + dir.x * 0.25, y: my + dir.y * 0.25, z: mz + dir.z * 0.25, life: 0.07, s0: 0.42, s1: 0.55, r: 5.5, g: 2.9, b: 1.0, a: 1, drag: 0 });
  for (const sg of [-1, 1]) fx.spawn({ type: PType.Flash, x: port.x + side.x * sg * 0.15, y: port.y, z: port.z + side.z * sg * 0.15, vx: side.x * sg * 4, vz: side.z * sg * 4, life: 0.06, s0: 0.2, s1: 0.3, r: 5, g: 2.5, b: 0.9, a: 1, drag: 0 });
  fx.spawn({ type: PType.Smoke, x: mx + dir.x * 0.3, y: my + dir.y * 0.3, z: mz + dir.z * 0.3, vx: dir.x * 2.5, vy: 0.5, vz: dir.z * 2.5, life: 1.3, s0: 0.25, s1: 1.0, r: 0.58, g: 0.54, b: 0.5, a: 0.45, drag: 2.2, buoy: 0.3 });
}

/** One forward flash for turrets at simple detail. */
export function blastSimple(fx: Particles, mx: number, my: number, mz: number, dir: Vector3): void {
  fx.spawn({ type: PType.Flash, x: mx + dir.x * 0.25, y: my + dir.y * 0.25, z: mz + dir.z * 0.25, life: 0.08, s0: 0.6, s1: 0.8, r: 5.5, g: 2.9, b: 1.0, a: 1, drag: 0 });
}
