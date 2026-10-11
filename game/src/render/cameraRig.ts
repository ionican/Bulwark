// Camera rig: one perspective camera orbiting a ground target point.
//
// W24 run 2a (Richard's feedback): the user owns the tilt, as in the workshop's camera
// (look/src/render/camera.ts: OrbitControls with damping 0.08, at most 80° from vertical, panning
// on the ground plane). `Orbit` below is that control's maths — rotate, ground-plane pan and dolly
// deltas applied with the same damping (each frame a share `damping` of the outstanding delta is
// applied and the rest carried) — driven by the game's own input, so a click (under 5 px) never
// moves the camera and left-drag can mean box selection or a wall run in other modes.
// A rig without `pitch` (older callers, tests) uses W10's eased pitch for its distance.
// Pure maths on a three.js camera: no DOM, so the picking tests can drive it in Node.

import { Vector3, type PerspectiveCamera } from 'three';

export interface Rig {
  /** Ground target, world units (tiles). */
  x: number;
  z: number;
  /** Camera-to-target distance. */
  distance: number;
  /** Radians. 0 = camera south of the target looking north (north is screen-up). */
  yaw: number;
  /** Elevation above the horizon, radians (the user's tilt). Absent: pitchFor(distance). */
  pitch?: number;
}

export const RIG_LIMITS = {
  minDistance: 10,
  maxDistance: 200,
  /** The workshop's polar limit: at most 80° from vertical, so at least 10° above the horizon. */
  minPitch: (10 * Math.PI) / 180,
  maxPitch: (89 * Math.PI) / 180,
} as const;
const PITCH_NEAR = (50 * Math.PI) / 180;
const PITCH_FAR = (84 * Math.PI) / 180;

/** W10's elevation for a distance, eased on a log scale (the default for a rig without a pitch). */
export function pitchFor(distance: number): number {
  const lo = Math.log(RIG_LIMITS.minDistance);
  const hi = Math.log(RIG_LIMITS.maxDistance);
  let t = (Math.log(distance) - lo) / (hi - lo);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  t = t * t * (3 - 2 * t);
  return PITCH_NEAR + (PITCH_FAR - PITCH_NEAR) * t;
}

/** The rig's elevation: its own pitch, clamped to the limits (or the eased default). */
export function pitchOf(rig: Rig): number {
  const p = rig.pitch ?? pitchFor(rig.distance);
  return Math.min(RIG_LIMITS.maxPitch, Math.max(RIG_LIMITS.minPitch, p));
}

export function clampRig(rig: Rig, mapW: number, mapH: number): void {
  rig.distance = Math.min(RIG_LIMITS.maxDistance, Math.max(RIG_LIMITS.minDistance, rig.distance));
  rig.x = Math.min(mapW, Math.max(0, rig.x));
  rig.z = Math.min(mapH, Math.max(0, rig.z));
  if (rig.pitch !== undefined) rig.pitch = pitchOf(rig);
}

/** Places the camera for `rig`. `groundY` is the terrain height under the target. */
export function applyRig(camera: PerspectiveCamera, rig: Rig, groundY = 0): void {
  const pitch = pitchOf(rig);
  const horiz = rig.distance * Math.cos(pitch);
  camera.position.set(rig.x + Math.sin(rig.yaw) * horiz, groundY + rig.distance * Math.sin(pitch), rig.z + Math.cos(rig.yaw) * horiz);
  camera.up.set(0, 1, 0);
  camera.lookAt(rig.x, groundY, rig.z);
  camera.near = Math.max(0.3, rig.distance * 0.02);
  camera.far = rig.distance * 3 + 400;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/** World units covered by one screen pixel at distance `dist` from a perspective camera. */
export function worldPerPixel(camera: PerspectiveCamera, dist: number, viewportHeight: number): number {
  return (2 * dist * Math.tan(((camera.fov * Math.PI) / 180) / 2)) / viewportHeight;
}

const _right = new Vector3();
const _fwd = new Vector3();

/**
 * OrbitControls' rotate, pan and dolly for a Rig. Inputs add deltas; `update()` applies a share
 * `damping` of what is outstanding each frame (OrbitControls' damping), so the total applied equals
 * the input and the motion eases out. `damping = 1` applies everything at once (tests).
 */
export class Orbit {
  damping = 0.08;
  /** OrbitControls' rotateSpeed, panSpeed and zoomSpeed. */
  rotateSpeed = 1;
  panSpeed = 1;
  private dYaw = 0;
  private dPitch = 0;
  private dx = 0;
  private dz = 0;
  /** Outstanding dolly as a log of the distance factor. */
  private dLogDist = 0;

  constructor(readonly rig: Rig) {}

  /** Left-drag by (dx, dy) screen pixels: yaw and tilt (OrbitControls rotateLeft / rotateUp). */
  rotate(dxPx: number, dyPx: number, viewportHeight: number): void {
    this.dYaw -= ((2 * Math.PI * dxPx) / viewportHeight) * this.rotateSpeed;
    this.dPitch += ((2 * Math.PI * dyPx) / viewportHeight) * this.rotateSpeed;
  }

  /**
   * Right-drag by (dx, dy) pixels: pan on the ground plane (screenSpacePanning false). One pixel
   * moves the target by the world size of a pixel at the target's distance; screen-up moves it
   * along the camera's forward direction projected on the ground.
   */
  pan(dxPx: number, dyPx: number, camera: PerspectiveCamera, viewportHeight: number): void {
    const k = (worldPerPixel(camera, this.rig.distance, viewportHeight) * this.panSpeed);
    _right.setFromMatrixColumn(camera.matrixWorld, 0);
    _right.y = 0;
    _right.normalize();
    _fwd.set(-Math.sin(this.rig.yaw), 0, -Math.cos(this.rig.yaw));
    this.dx += -dxPx * k * _right.x + dyPx * k * _fwd.x;
    this.dz += -dxPx * k * _right.z + dyPx * k * _fwd.z;
  }

  /** Middle-drag: dolly; dragging down moves away (factor 1.01 per pixel). */
  dolly(dyPx: number): void {
    this.dLogDist += dyPx * Math.log(1.01);
  }

  /** True while a delta is still being applied. */
  get moving(): boolean {
    return Math.abs(this.dYaw) + Math.abs(this.dPitch) + Math.abs(this.dx) + Math.abs(this.dz) + Math.abs(this.dLogDist) > 1e-5;
  }

  stop(): void {
    this.dYaw = this.dPitch = this.dx = this.dz = this.dLogDist = 0;
  }

  /** Applies this frame's share of the outstanding deltas. Returns true if the rig changed. */
  update(): boolean {
    if (!this.moving) return false;
    const f = this.damping;
    const r = this.rig;
    r.yaw += this.dYaw * f;
    r.pitch = Math.min(RIG_LIMITS.maxPitch, Math.max(RIG_LIMITS.minPitch, (r.pitch ?? pitchFor(r.distance)) + this.dPitch * f));
    r.x += this.dx * f;
    r.z += this.dz * f;
    r.distance = Math.min(RIG_LIMITS.maxDistance, Math.max(RIG_LIMITS.minDistance, r.distance * Math.exp(this.dLogDist * f)));
    this.dYaw *= 1 - f;
    this.dPitch *= 1 - f;
    this.dx *= 1 - f;
    this.dz *= 1 - f;
    this.dLogDist *= 1 - f;
    return true;
  }
}
