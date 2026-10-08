// Pooled firing effects for hundreds of turrets. Every pool has a fixed size chosen up front; when
// a pool is full the oldest entry is reused (shells, casings, muzzle lights) or the new one is not
// created (particles, in Particles.spawn). Nothing is allocated per shot except W20's muzzle-blast
// vectors for turrets at full detail.
//
//   shells     1024  in flight, W20's exact ballistic arc, tested each frame against the aliens
//                    in the grid cells the frame's segment crosses; drawn as HDR tracer streaks
//   casings     256  brass casings, ejected by turrets at full detail only; 6 s each
//   lights        2  muzzle point lights, given to the latest shots of full-detail turrets
//   particles  4000 smoke + 4000 glow (Particles caps)
//   wrecks       96  (aliens.ts); only the 12 newest burn and smoke
//
// How much a shot spawns depends on the firing turret's detail level:
//   full    W20's muzzle blast (forward flash, 6 sparks, a flash and a smoke puff out of each of
//           the 5 brake ports on both sides, a forward smoke ring) and the breech vent
//   middle  one forward flash, a flash out of each side of the brake, one smoke puff
//   simple  one forward flash
//   icon / off screen: the tracer only

import { BoxGeometry, Color, CylinderGeometry, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicMaterial, PointLight, Quaternion, Vector3, type Material } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GRAVITY } from '../bench/aim.ts';
import { PType, type Particles } from '../fx/particles.ts';
import type { AlienGrid, AlienView } from './fireControl.ts';

export const SHELL_CAP = 1024;
export const CASING_CAP = 256;
export const LIGHT_CAP = 2;
export const PARTICLE_CAPS = { smoke: 4000, glow: 4000 };
/** Largest alien hit radius (breaker: 1.6 × 1.5 × 0.55). */
const MAX_ALIEN_R = 1.35;

/** Distance from p to segment a→b (W20 segPointDist on scalars). */
function segDist(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const l2 = abx * abx + aby * aby + abz * abz;
  let u = l2 > 0 ? ((cx - ax) * abx + (cy - ay) * aby + (cz - az) * abz) / l2 : 0;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(ax + abx * u - cx, ay + aby * u - cy, az + abz * u - cz);
}

/** Shells in flight: structure of arrays, swap-remove, oldest reused when full. */
export class ShellPool {
  readonly cap: number;
  n = 0;
  readonly p0: Float64Array;
  readonly v0: Float64Array;
  readonly prev: Float64Array;
  readonly head: Float64Array;
  readonly age: Float64Array;
  hits = 0;
  misses = 0;
  fired = 0;
  reused = 0;

  constructor(cap = SHELL_CAP) {
    this.cap = cap;
    this.p0 = new Float64Array(cap * 3);
    this.v0 = new Float64Array(cap * 3);
    this.prev = new Float64Array(cap * 3);
    this.head = new Float64Array(cap * 3);
    this.age = new Float64Array(cap);
  }

  fire(fx: number, fy: number, fz: number, vx: number, vy: number, vz: number): void {
    let i = this.n;
    if (i >= this.cap) {
      // full: reuse the oldest shell
      let oldest = 0;
      for (let k = 1; k < this.n; k++) if (this.age[k]! > this.age[oldest]!) oldest = k;
      i = oldest;
      this.reused++;
    } else this.n++;
    this.fired++;
    const o = i * 3;
    this.p0[o] = this.prev[o] = this.head[o] = fx;
    this.p0[o + 1] = this.prev[o + 1] = this.head[o + 1] = fy;
    this.p0[o + 2] = this.prev[o + 2] = this.head[o + 2] = fz;
    this.v0[o] = vx;
    this.v0[o + 1] = vy;
    this.v0[o + 2] = vz;
    this.age[i] = 0;
  }

  private kill(i: number): void {
    const j = --this.n;
    if (i === j) return;
    this.p0.copyWithin(i * 3, j * 3, j * 3 + 3);
    this.v0.copyWithin(i * 3, j * 3, j * 3 + 3);
    this.prev.copyWithin(i * 3, j * 3, j * 3 + 3);
    this.head.copyWithin(i * 3, j * 3, j * 3 + 3);
    this.age[i] = this.age[j]!;
  }

  /**
   * Advances every shell on its exact arc. A shell ends on the first alien whose centre is within
   * its radius of the segment flown this frame (lowest slot first, as W20 takes the first in its
   * list), on the ground, or after 4 s. `onHit(slot, x, y, z)`: slot −1 = ground.
   */
  update(dt: number, a: AlienView, grid: AlienGrid, ground: (x: number, z: number) => number, onHit: (slot: number, x: number, y: number, z: number) => void): void {
    for (let i = this.n - 1; i >= 0; i--) {
      this.age[i]! += dt;
      const t = this.age[i]!;
      const o = i * 3;
      const px = this.p0[o]! + this.v0[o]! * t;
      const py = this.p0[o + 1]! + this.v0[o + 1]! * t - 0.5 * GRAVITY * t * t;
      const pz = this.p0[o + 2]! + this.v0[o + 2]! * t;
      const qx = this.prev[o]!;
      const qy = this.prev[o + 1]!;
      const qz = this.prev[o + 2]!;
      let hit = -1;
      const x0 = grid.cx(Math.min(px, qx) - MAX_ALIEN_R);
      const x1 = grid.cx(Math.max(px, qx) + MAX_ALIEN_R);
      const z0 = grid.cz(Math.min(pz, qz) - MAX_ALIEN_R);
      const z1 = grid.cz(Math.max(pz, qz) + MAX_ALIEN_R);
      for (let cz = z0; cz <= z1; cz++)
        for (let cx = x0; cx <= x1; cx++) {
          const c = cz * grid.nx + cx;
          for (let k = grid.start[c]!; k < grid.start[c + 1]!; k++) {
            const s = grid.items[k]!;
            if (hit >= 0 && s > hit) continue;
            if (!a.alive[s]) continue;
            if (segDist(qx, qy, qz, px, py, pz, a.ax[s]!, a.ay[s]!, a.az[s]!) <= a.radius[s]!) hit = s;
          }
        }
      if (hit >= 0) {
        this.hits++;
        // impact point: 40 % of the way from the shell to the alien's centre (W20)
        onHit(hit, px + (a.ax[hit]! - px) * 0.4, py + (a.ay[hit]! - py) * 0.4, pz + (a.az[hit]! - pz) * 0.4);
        this.kill(i);
        continue;
      }
      const g = ground(px, pz);
      if (py < g) {
        this.misses++;
        onHit(-1, px, g + 0.05, pz);
        this.kill(i);
        continue;
      }
      if (t > 4) {
        this.kill(i);
        continue;
      }
      this.prev[o] = this.head[o] = px;
      this.prev[o + 1] = this.head[o + 1] = py;
      this.prev[o + 2] = this.head[o + 2] = pz;
    }
  }

  clear(): void {
    this.n = 0;
  }
}

/** Brass casings: tumble, bounce with friction, settle, sink; oldest reused when full. */
export class CasingPool {
  readonly cap: number;
  n = 0;
  readonly p: Float64Array;
  readonly v: Float64Array;
  readonly q: Float64Array;
  readonly w: Float64Array;
  readonly age: Float64Array;
  readonly rest: Uint8Array;
  readonly life = 6;
  private head = 0;

  constructor(cap = CASING_CAP) {
    this.cap = cap;
    this.p = new Float64Array(cap * 3);
    this.v = new Float64Array(cap * 3);
    this.q = new Float64Array(cap * 4);
    this.w = new Float64Array(cap * 3);
    this.age = new Float64Array(cap);
    this.rest = new Uint8Array(cap);
  }

  eject(at: Vector3, outward: Vector3, dir: Vector3, rnd: () => number): void {
    let i: number;
    if (this.n < this.cap) i = this.n++;
    else {
      i = this.head;
      this.head = (this.head + 1) % this.cap;
    }
    const o = i * 3;
    const k = 1.1 + rnd() * 0.5;
    this.p[o] = at.x;
    this.p[o + 1] = at.y;
    this.p[o + 2] = at.z;
    this.v[o] = outward.x * k - dir.x * 0.4;
    this.v[o + 1] = outward.y * k - dir.y * 0.4 + 1.3 + rnd() * 0.4;
    this.v[o + 2] = outward.z * k - dir.z * 0.4;
    _qa.setFromUnitVectors(X, _va.copy(dir).normalize());
    this.q[i * 4] = _qa.x;
    this.q[i * 4 + 1] = _qa.y;
    this.q[i * 4 + 2] = _qa.z;
    this.q[i * 4 + 3] = _qa.w;
    this.w[o] = (rnd() - 0.5) * 18;
    this.w[o + 1] = (rnd() - 0.5) * 6;
    this.w[o + 2] = (rnd() - 0.5) * 18;
    this.age[i] = 0;
    this.rest[i] = 0;
  }

  update(dt: number, ground: (x: number, z: number) => number): void {
    for (let i = 0; i < this.n; i++) {
      this.age[i]! += dt;
      if (this.rest[i]) continue;
      const o = i * 3;
      this.v[o + 1]! -= GRAVITY * dt;
      this.p[o]! += this.v[o]! * dt;
      this.p[o + 1]! += this.v[o + 1]! * dt;
      this.p[o + 2]! += this.v[o + 2]! * dt;
      _wa.set(this.w[o]!, this.w[o + 1]!, this.w[o + 2]!);
      const wl = _wa.length();
      _qa.set(this.q[i * 4]!, this.q[i * 4 + 1]!, this.q[i * 4 + 2]!, this.q[i * 4 + 3]!);
      if (wl > 1e-4) _qa.premultiply(_qb.setFromAxisAngle(_wa.divideScalar(wl), wl * dt));
      const g = ground(this.p[o]!, this.p[o + 2]!) + 0.035;
      if (this.p[o + 1]! < g) {
        this.p[o + 1] = g;
        if (Math.abs(this.v[o + 1]!) < 0.6) {
          this.rest[i] = Math.hypot(this.v[o]!, this.v[o + 2]!) < 0.3 ? 1 : 0;
          this.v[o + 1] = 0;
        } else this.v[o + 1] = -this.v[o + 1]! * 0.32;
        this.v[o]! *= 0.55;
        this.v[o + 2]! *= 0.55;
        this.w[o]! *= 0.5;
        this.w[o + 1]! *= 0.5;
        this.w[o + 2]! *= 0.5;
        if (this.rest[i]) {
          const fx = _va.set(1, 0, 0).applyQuaternion(_qa);
          _qa.setFromAxisAngle(Y, Math.atan2(-fx.z, fx.x));
        }
      }
      this.q[i * 4] = _qa.x;
      this.q[i * 4 + 1] = _qa.y;
      this.q[i * 4 + 2] = _qa.z;
      this.q[i * 4 + 3] = _qa.w;
    }
    // expire (swap-remove keeps the array dense; the ring head only matters when full)
    for (let i = this.n - 1; i >= 0; i--) {
      if (this.age[i]! < this.life) continue;
      const j = --this.n;
      if (i !== j) {
        this.p.copyWithin(i * 3, j * 3, j * 3 + 3);
        this.v.copyWithin(i * 3, j * 3, j * 3 + 3);
        this.w.copyWithin(i * 3, j * 3, j * 3 + 3);
        this.q.copyWithin(i * 4, j * 4, j * 4 + 4);
        this.age[i] = this.age[j]!;
        this.rest[i] = this.rest[j]!;
      }
      if (this.head >= this.n) this.head = 0;
    }
  }

  clear(): void {
    this.n = 0;
    this.head = 0;
  }
}

/** A fixed set of muzzle point lights; a flash takes the dimmest. */
export class LightPool {
  readonly lights: PointLight[] = [];
  readonly level: Float64Array;

  constructor(n = LIGHT_CAP) {
    for (let i = 0; i < n; i++) {
      const l = new PointLight(new Color(1, 0.62, 0.3), 0, 9, 2);
      l.castShadow = false;
      this.lights.push(l);
    }
    this.level = new Float64Array(n);
  }

  flash(x: number, y: number, z: number): void {
    let k = 0;
    for (let i = 1; i < this.level.length; i++) if (this.level[i]! < this.level[k]!) k = i;
    this.level[k] = 1;
    this.lights[k]!.position.set(x, y, z);
  }

  update(dt: number): void {
    for (let i = 0; i < this.level.length; i++) {
      this.level[i] = Math.max(0, this.level[i]! - dt * 14);
      this.lights[i]!.intensity = 60 * this.level[i]! * this.level[i]!;
    }
  }

  get active(): number {
    let n = 0;
    for (const v of this.level) if (v > 0) n++;
    return n;
  }
}

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const _va = new Vector3();
const _wa = new Vector3();
const _qa = new Quaternion();
const _qb = new Quaternion();
const _m = new Matrix4();
const _b = new Vector3();
const _d = new Vector3();
const _s = new Vector3();

/** Instanced tracer streaks for the shell pool (W20's look: HDR orange, at least `minPx` wide). */
export class TracerMesh {
  readonly mesh: InstancedMesh;
  private colours: InstancedBufferAttribute;

  constructor(cap = SHELL_CAP) {
    const g = new BoxGeometry(1, 1, 1);
    g.translate(-0.5, 0, 0);
    this.mesh = new InstancedMesh(g, new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.colours = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.colours.setUsage(DynamicDrawUsage);
    this.mesh.instanceColor = this.colours;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  }

  update(pool: ShellPool, cam: Vector3, wppd: number, minPx: number): void {
    let n = 0;
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    const col = this.colours.array as Float32Array;
    for (let i = 0; i < pool.n; i++) {
      const o = i * 3;
      const t = pool.age[i]!;
      _b.set(pool.head[o]!, pool.head[o + 1]!, pool.head[o + 2]!);
      _d.set(pool.v0[o]!, pool.v0[o + 1]! - GRAVITY * t, pool.v0[o + 2]!).normalize();
      const dist = Math.hypot(_b.x - pool.p0[o]!, _b.y - pool.p0[o + 1]!, _b.z - pool.p0[o + 2]!);
      const w = Math.max(0.032, minPx * wppd * _b.distanceTo(cam));
      const flown = Math.min(Math.max(1.1, w * 25), dist);
      if (flown <= 0.02) continue;
      _qa.setFromUnitVectors(X, _d);
      _m.compose(_b, _qa, _s.set(flown, w, w));
      _m.toArray(arr, n * 16);
      col[n * 3] = 5;
      col[n * 3 + 1] = 2.9;
      col[n * 3 + 2] = 1.1;
      n++;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, Math.max(1, n) * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colours.clearUpdateRanges();
    this.colours.addUpdateRange(0, Math.max(1, n) * 3);
    this.colours.needsUpdate = true;
  }
}

/** Instanced brass casings for the casing pool. */
export class CasingMesh {
  readonly mesh: InstancedMesh;

  constructor(material: Material, cap = CASING_CAP) {
    const body = new CylinderGeometry(0.032, 0.035, 0.2, 10);
    const rim = new CylinderGeometry(0.04, 0.04, 0.012, 10);
    rim.translate(0, -0.1, 0);
    const g = mergeGeometries([body.toNonIndexed(), rim.toNonIndexed()], false)!;
    g.rotateZ(Math.PI / 2);
    this.mesh = new InstancedMesh(g, material, cap);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
  }

  update(pool: CasingPool): void {
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < pool.n; i++) {
      const sink = Math.max(0, pool.age[i]! - (pool.life - 1.5)) * 0.05;
      _qa.set(pool.q[i * 4]!, pool.q[i * 4 + 1]!, pool.q[i * 4 + 2]!, pool.q[i * 4 + 3]!);
      _m.compose(_b.set(pool.p[i * 3]!, pool.p[i * 3 + 1]! - sink, pool.p[i * 3 + 2]!), _qa, _s.set(1, 1, 1));
      _m.toArray(arr, i * 16);
    }
    this.mesh.count = pool.n;
    this.mesh.visible = pool.n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

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
