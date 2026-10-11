// Per-instance matrices for the moving parts of a W20 turret, written straight into instanced
// matrix arrays (three.js column-major order). Pure arithmetic, unit-tested against W20's object
// hierarchy (src/bench/turretRig.ts):
//
//   base    T(p)                                   static
//   pinion  T(p + pinionAt) · Ry(−yaw · ratio)     geared to the slewing ring
//   yaw     T(p) · Ry(yaw)                         slewing ring + head
//   cradle  T(p) · Ry(yaw) · T(0, trunnionY, 0) · Rz(pitch)
//   barrel  cradle · T(−recoil, 0, 0)
//   icon    T(p + (0, 0.4, 0)) · Ry(yaw) · S(s)    constant screen size
//
// With R = Ry(yaw)·Rz(pitch): the barrel's axis (+X) is R's first column (cos y cos p, sin p,
// −sin y cos p), its side (+Z) the third (sin y, 0, cos y).

export interface TurretFrame {
  pinionAt: readonly [number, number, number];
  pinionRatio: number;
  trunnionY: number;
}

/** Translation + rotation about +Y (+ uniform scale) at offset o (16 floats). */
export function writeYaw(a: Float32Array, o: number, x: number, y: number, z: number, ang: number, s = 1): void {
  const c = Math.cos(ang) * s;
  const n = Math.sin(ang) * s;
  a[o] = c;
  a[o + 1] = 0;
  a[o + 2] = -n;
  a[o + 3] = 0;
  a[o + 4] = 0;
  a[o + 5] = s;
  a[o + 6] = 0;
  a[o + 7] = 0;
  a[o + 8] = n;
  a[o + 9] = 0;
  a[o + 10] = c;
  a[o + 11] = 0;
  a[o + 12] = x;
  a[o + 13] = y;
  a[o + 14] = z;
  a[o + 15] = 1;
}

export function writeTranslate(a: Float32Array, o: number, x: number, y: number, z: number): void {
  a.fill(0, o, o + 16);
  a[o] = a[o + 5] = a[o + 10] = a[o + 15] = 1;
  a[o + 12] = x;
  a[o + 13] = y;
  a[o + 14] = z;
}

/** Cradle (recoil = 0) or barrel (recoil > 0) frame: T(p) · Ry(yaw) · T(0, ty, 0) · Rz(pitch) · T(−recoil, 0, 0). */
export function writePitch(a: Float32Array, o: number, x: number, y: number, z: number, yaw: number, pitch: number, ty: number, recoil: number): void {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const c0x = cy * cp;
  const c0y = sp;
  const c0z = -sy * cp;
  a[o] = c0x;
  a[o + 1] = c0y;
  a[o + 2] = c0z;
  a[o + 3] = 0;
  a[o + 4] = -cy * sp;
  a[o + 5] = cp;
  a[o + 6] = sy * sp;
  a[o + 7] = 0;
  a[o + 8] = sy;
  a[o + 9] = 0;
  a[o + 10] = cy;
  a[o + 11] = 0;
  a[o + 12] = x - recoil * c0x;
  a[o + 13] = y + ty - recoil * c0y;
  a[o + 14] = z - recoil * c0z;
  a[o + 15] = 1;
}

export interface PartArrays {
  base?: Float32Array;
  pinion?: Float32Array;
  yaw?: Float32Array;
  cradle?: Float32Array;
  barrel?: Float32Array;
}

/** Writes every part matrix present in `out` for instance k. */
export function writeTurret(out: PartArrays, k: number, f: TurretFrame, x: number, y: number, z: number, yaw: number, pitch: number, recoil: number): void {
  const o = k * 16;
  if (out.base) writeTranslate(out.base, o, x, y, z);
  if (out.pinion) writeYaw(out.pinion, o, x + f.pinionAt[0], y + f.pinionAt[1], z + f.pinionAt[2], -yaw * f.pinionRatio);
  if (out.yaw) writeYaw(out.yaw, o, x, y, z, yaw);
  if (out.cradle) writePitch(out.cradle, o, x, y, z, yaw, pitch, f.trunnionY, 0);
  if (out.barrel) writePitch(out.barrel, o, x, y, z, yaw, pitch, f.trunnionY, recoil);
}

/** World point of a barrel-space point (cradle frame with recoil), into out[0..2]. */
export function barrelPoint(out: Float64Array, ox: number, x: number, y: number, z: number, yaw: number, pitch: number, ty: number, recoil: number, lx: number, ly: number, lz: number): void {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const ax = lx - recoil;
  out[ox] = x + cy * cp * ax - cy * sp * ly + sy * lz;
  out[ox + 1] = y + ty + sp * ax + cp * ly;
  out[ox + 2] = z - sy * cp * ax + sy * sp * ly + cy * lz;
}
