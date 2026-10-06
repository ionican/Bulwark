// Strategic-zoom camera rig: one perspective camera orbiting a ground target point.
// Distance is the zoom; pitch eases from oblique (close-up) to nearly top-down (whole map) as the
// distance grows, so the far edge is not foreshortened at map view (a W10 issue).
// Pure maths on a three.js camera: no DOM, so the picking tests can drive it in Node.

import type { PerspectiveCamera } from 'three';

export interface Rig {
  /** Ground target, world units (tiles). */
  x: number;
  z: number;
  /** Camera-to-target distance. */
  distance: number;
  /** Radians. 0 = camera south of the target looking north (north is screen-up). */
  yaw: number;
}

export const RIG_LIMITS = { minDistance: 10, maxDistance: 200 } as const;
const PITCH_NEAR = (50 * Math.PI) / 180;
const PITCH_FAR = (84 * Math.PI) / 180;

/** Elevation angle above the horizon for a distance, eased on a log scale. */
export function pitchFor(distance: number): number {
  const lo = Math.log(RIG_LIMITS.minDistance);
  const hi = Math.log(RIG_LIMITS.maxDistance);
  let t = (Math.log(distance) - lo) / (hi - lo);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  t = t * t * (3 - 2 * t);
  return PITCH_NEAR + (PITCH_FAR - PITCH_NEAR) * t;
}

export function clampRig(rig: Rig, mapW: number, mapH: number): void {
  rig.distance = Math.min(RIG_LIMITS.maxDistance, Math.max(RIG_LIMITS.minDistance, rig.distance));
  rig.x = Math.min(mapW, Math.max(0, rig.x));
  rig.z = Math.min(mapH, Math.max(0, rig.z));
}

/** Places the camera for `rig`. `groundY` is the terrain height under the target. */
export function applyRig(camera: PerspectiveCamera, rig: Rig, groundY = 0): void {
  const pitch = pitchFor(rig.distance);
  const horiz = rig.distance * Math.cos(pitch);
  camera.position.set(rig.x + Math.sin(rig.yaw) * horiz, groundY + rig.distance * Math.sin(pitch), rig.z + Math.cos(rig.yaw) * horiz);
  camera.up.set(0, 1, 0);
  camera.lookAt(rig.x, groundY, rig.z);
  camera.near = Math.max(0.3, rig.distance * 0.02);
  camera.far = rig.distance * 3 + 300;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/** World units covered by one screen pixel at distance `dist` from a perspective camera. */
export function worldPerPixel(camera: PerspectiveCamera, dist: number, viewportHeight: number): number {
  return (2 * dist * Math.tan(((camera.fov * Math.PI) / 180) / 2)) / viewportHeight;
}
