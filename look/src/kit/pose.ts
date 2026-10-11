// Pivot matrices of one kit turret (see kit.ts for the six pivots), written into a scratch
// Float32Array of 6 × 16 floats in three.js column-major order, and the part matrix
// pivot · T(offset). W21's writers (stress/turretPose.ts) are reused, so W20's kind gets exactly
// W21's matrices.

import { writePitch, writeTranslate, writeYaw } from '../stress/turretPose.ts';
import { GUN, PINION, PINION0, PITCH, STATIC, YAW, type KindFrame } from './kit.ts';

/** Gun frame: T(p) · Ry(yaw) · T(0, ty, 0) · Rz(pitch) · T(−recoil, 0, 0) · Rx(spin). */
export function writeGun(a: Float32Array, o: number, x: number, y: number, z: number, yaw: number, pitch: number, ty: number, recoil: number, spin: number): void {
  writePitch(a, o, x, y, z, yaw, pitch, ty, recoil);
  if (spin === 0) return;
  const cs = Math.cos(spin);
  const ss = Math.sin(spin);
  // columns 1 and 2 turn about column 0: c1' = cs·c1 + ss·c2, c2' = −ss·c1 + cs·c2
  for (let r = 0; r < 3; r++) {
    const c1 = a[o + 4 + r]!;
    const c2 = a[o + 8 + r]!;
    a[o + 4 + r] = cs * c1 + ss * c2;
    a[o + 8 + r] = -ss * c1 + cs * c2;
  }
}

/** All six pivots of a turret at (x, y, z) into `out` (96 floats). */
export function writePivots(out: Float32Array, f: KindFrame, x: number, y: number, z: number, yaw: number, pitch: number, recoil: number, spin: number): void {
  writeTranslate(out, STATIC * 16, x, y, z);
  writeYaw(out, PINION * 16, x + f.pinionAt[0], y + f.pinionAt[1], z + f.pinionAt[2], -yaw * f.pinionRatio);
  writeTranslate(out, PINION0 * 16, x + f.pinionAt[0], y + f.pinionAt[1], z + f.pinionAt[2]);
  writeYaw(out, YAW * 16, x, y, z, yaw);
  writePitch(out, PITCH * 16, x, y, z, yaw, pitch, f.trunnionY, 0);
  writeGun(out, GUN * 16, x, y, z, yaw, pitch, f.trunnionY, recoil * f.recoilScale, spin);
}

/** dst[d..d+16] = pivots[pivot] · T(off). */
export function writePart(dst: Float32Array, d: number, pivots: Float32Array, pivot: number, off: readonly [number, number, number]): void {
  const s = pivot * 16;
  for (let k = 0; k < 16; k++) dst[d + k] = pivots[s + k]!;
  const [ox, oy, oz] = off;
  if (ox === 0 && oy === 0 && oz === 0) return;
  dst[d + 12] = pivots[s + 12]! + pivots[s]! * ox + pivots[s + 4]! * oy + pivots[s + 8]! * oz;
  dst[d + 13] = pivots[s + 13]! + pivots[s + 1]! * ox + pivots[s + 5]! * oy + pivots[s + 9]! * oz;
  dst[d + 14] = pivots[s + 14]! + pivots[s + 2]! * ox + pivots[s + 6]! * oy + pivots[s + 10]! * oz;
}
