// 500 alien machines (W17's four procedural kinds) in flat arrays, advancing in waves along five
// lanes and holding on a ring just outside the turrets, and their instanced drawing.
//
// Movement is W20's (src/bench/targets.ts): constant speed along each leg of a polyline, so the
// turrets' lead has a constant velocity to work with per leg; height and tilt follow the ground;
// rushers walk with W17's gait. A wave is 10–24 aliens of mixed kinds from one lane, spaced out
// along the approach; waves keep coming while fewer than `population` are alive. Hit points are
// four times W20's so that the front line builds up and keeps most turrets firing (with W20's
// values the aliens die as fast as they arrive and most of the base stands idle).

import { Frustum, Group, InstancedMesh, Matrix4, Quaternion, Sphere, Vector3, type BufferAttribute, type BufferGeometry, type Material } from 'three';
import { Builder, cbox } from '../models/kit.ts';
import type { Mats } from '../models/materials.ts';
import { ALIEN_MAKERS } from '../models/procedural/aliens.ts';
import type { ModelDef, PartDef } from '../models/types.ts';
import { Rand } from '../noise.ts';
import { motionMatrix, type InstanceState } from '../scene/modelLayer.ts';
import type { AlienKind } from '../world/layout.ts';
import { alienView, type AlienView } from './fireControl.ts';
import { BASE, LANES, type Ground } from './world.ts';

export const KINDS: AlienKind[] = ['rusher', 'hunter', 'breaker', 'saboteur'];
const SPEED = [2.4, 4.4, 0.9, 1.8];
const HP = [12, 8, 48, 20];
const GAIT = [5.5, 0, 0, 0];
/** Drawn 1.5× their simulation size, as in W17 and W20. */
export const SCALE = 1.5;
const MAX_PTS = 4;

export class AlienSim {
  readonly cap: number;
  readonly view: AlienView;
  readonly kind: Uint8Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly hp: Float32Array;
  readonly height: Float32Array;
  readonly heading: Float32Array;
  readonly phase: Float32Array;
  readonly seed: Float32Array;
  readonly leg: Uint8Array;
  readonly nPts: Uint8Array;
  readonly pts: Float64Array;
  population = 500;
  holdRadius = 30;
  kills = 0;
  spawned = 0;
  alive = 0;
  private nextId = 1;
  private waveIn = 0;
  private rnd = new Rand(2121);
  /** W22: restart the random stream, so a reset battle replays the same waves. */
  reseed(seed = 2121): void {
    this.rnd = new Rand(seed);
  }
  private radiusOf: number[];
  private heightOf: number[];
  /** Called when an alien is destroyed (slot, kind index, position). */
  onKill: ((slot: number, kind: number, x: number, y: number, z: number) => void) | null = null;

  constructor(
    cap: number,
    models: ModelDef[],
    private ground: Ground,
  ) {
    this.cap = cap;
    this.view = alienView(cap);
    this.kind = new Uint8Array(cap);
    this.x = new Float64Array(cap);
    this.y = new Float64Array(cap);
    this.z = new Float64Array(cap);
    this.hp = new Float32Array(cap);
    this.height = new Float32Array(cap);
    this.heading = new Float32Array(cap);
    this.phase = new Float32Array(cap);
    this.seed = new Float32Array(cap);
    this.leg = new Uint8Array(cap);
    this.nPts = new Uint8Array(cap);
    this.pts = new Float64Array(cap * MAX_PTS * 2);
    this.radiusOf = models.map((m) => Math.max(0.45, m.radius * SCALE * 0.55));
    this.heightOf = models.map((m) => m.height * SCALE);
  }

  private pickKind(): number {
    const r = this.rnd.next();
    return r < 0.5 ? 0 : r < 0.72 ? 1 : r < 0.86 ? 3 : 2;
  }

  private freeSlot(): number {
    for (let s = 0; s < this.cap; s++) if (!this.view.alive[s]) return s;
    return -1;
  }

  /** Spawns one alien on a lane; `back` moves the start further out; `progress` 0..1 pre-walks it. */
  spawn(lane: number, back = 0, progress = 0): number {
    const s = this.freeSlot();
    if (s < 0) return -1;
    const k = this.pickKind();
    const L = LANES[lane]!;
    const v = this.view;
    const o = s * MAX_PTS * 2;
    let n = 0;
    const lat = this.rnd.range(-1, 1);
    for (let i = 0; i < L.approach.length; i++) {
      const [ax, az] = L.approach[i]!;
      const [bx, bz] = L.approach[Math.min(i + 1, L.approach.length - 1)]!;
      let dx = bx - ax;
      let dz = bz - az;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      const spread = i === 0 ? 6 : 4;
      let px = ax - dz * lat * spread;
      let pz = az + dx * lat * spread;
      if (i === 0 && back > 0) {
        px -= dx * back;
        pz -= dz * back;
      }
      this.pts[o + n * 2] = px;
      this.pts[o + n * 2 + 1] = pz;
      n++;
    }
    // hold point on the ring, within ±22° of the lane's bearing
    const b = ((L.bearing + this.rnd.range(-22, 22)) * Math.PI) / 180;
    const r = this.holdRadius + this.rnd.range(0, 4);
    this.pts[o + n * 2] = BASE.x + Math.cos(b) * r;
    this.pts[o + n * 2 + 1] = BASE.z - Math.sin(b) * r;
    n++;
    this.nPts[s] = n;
    this.leg[s] = 0;
    this.kind[s] = k;
    this.x[s] = this.pts[o]!;
    this.z[s] = this.pts[o + 1]!;
    this.hp[s] = HP[k]!;
    this.height[s] = this.heightOf[k]!;
    this.seed[s] = this.rnd.next();
    this.phase[s] = this.seed[s]! * 6.283;
    v.id[s] = this.nextId++;
    v.alive[s] = 1;
    v.radius[s] = this.radiusOf[k]!;
    v.vx[s] = v.vy[s] = v.vz[s] = 0;
    this.alive++;
    this.spawned++;
    if (progress > 0) {
      // walk it forward along its path without simulating every frame
      let total = 0;
      for (let i = 0; i + 1 < n; i++) total += Math.hypot(this.pts[o + (i + 1) * 2]! - this.pts[o + i * 2]!, this.pts[o + (i + 1) * 2 + 1]! - this.pts[o + i * 2 + 1]!);
      let d = total * progress;
      let i = 0;
      while (i + 1 < n) {
        const ax = this.pts[o + i * 2]!;
        const az = this.pts[o + i * 2 + 1]!;
        const bx = this.pts[o + (i + 1) * 2]!;
        const bz = this.pts[o + (i + 1) * 2 + 1]!;
        const l = Math.hypot(bx - ax, bz - az);
        if (d < l) {
          this.x[s] = ax + ((bx - ax) * d) / l;
          this.z[s] = az + ((bz - az) * d) / l;
          break;
        }
        d -= l;
        i++;
        this.x[s] = bx;
        this.z[s] = bz;
      }
      this.leg[s] = i;
    }
    this.place(s, 0);
    return s;
  }

  /** Fills the field at start: `n` aliens in waves spread along all lanes. */
  prefill(n: number): void {
    let left = n;
    while (left > 0) {
      const size = Math.min(left, 10 + this.rnd.int(15));
      const lane = this.rnd.int(LANES.length);
      const prog = this.rnd.range(0, 0.92);
      for (let i = 0; i < size; i++) this.spawn(lane, 0, Math.max(0, prog - i * 0.012));
      left -= size;
    }
  }

  clear(): void {
    this.view.alive.fill(0);
    this.alive = 0;
  }

  private place(s: number, dt: number): void {
    const v = this.view;
    const o = s * MAX_PTS * 2;
    const n = this.nPts[s]!;
    const k = this.kind[s]!;
    const sp = SPEED[k]!;
    const holding = this.leg[s]! >= n - 1;
    if (!holding) {
      const tx = this.pts[o + (this.leg[s]! + 1) * 2]!;
      const tz = this.pts[o + (this.leg[s]! + 1) * 2 + 1]!;
      const dx = tx - this.x[s]!;
      const dz = tz - this.z[s]!;
      const d = Math.hypot(dx, dz);
      if (d < sp * dt + 1e-3) {
        this.x[s] = tx;
        this.z[s] = tz;
        this.leg[s]!++;
      } else {
        v.vx[s] = (dx / d) * sp;
        v.vz[s] = (dz / d) * sp;
        this.x[s]! += v.vx[s]! * dt;
        this.z[s]! += v.vz[s]! * dt;
      }
    }
    if (this.leg[s]! >= n - 1) {
      v.vx[s] = 0;
      v.vz[s] = 0;
    }
    const y = this.ground.height(this.x[s]!, this.z[s]!);
    this.y[s] = y;
    v.ax[s] = this.x[s]!;
    v.ay[s] = y + this.height[s]! * 0.45;
    v.az[s] = this.z[s]!;
    const moving = v.vx[s] !== 0 || v.vz[s] !== 0;
    const hx = moving ? v.vx[s]! : BASE.x - this.x[s]!;
    const hz = moving ? v.vz[s]! : BASE.z - this.z[s]!;
    this.heading[s] = Math.atan2(-hz, hx);
    this.phase[s]! += sp * dt * GAIT[k]! * (moving ? 1 : 0);
  }

  update(dt: number): void {
    const v = this.view;
    for (let s = 0; s < this.cap; s++) if (v.alive[s]) this.place(s, dt);
    // waves: a group from one lane while fewer than the population are alive
    this.waveIn -= dt;
    if (this.waveIn <= 0 && this.alive < this.population) {
      const size = Math.min(this.population - this.alive, 10 + this.rnd.int(15));
      const lane = this.rnd.int(LANES.length);
      for (let i = 0; i < size; i++) this.spawn(lane, i * 2.2);
      this.waveIn = 0.8 + this.rnd.next() * 1.2;
    }
  }

  /** Damage from a shell; returns true when it destroyed the alien. */
  hit(s: number, dmg = 1): boolean {
    const v = this.view;
    if (!v.alive[s]) return false;
    this.hp[s]! -= dmg;
    if (this.hp[s]! > 0) return false;
    v.alive[s] = 0;
    this.alive--;
    this.kills++;
    this.onKill?.(s, this.kind[s]!, this.x[s]!, this.y[s]!, this.z[s]!);
    return true;
  }
}

// ---- drawing -----------------------------------------------------------------------------------

interface PartGroup {
  parts: PartDef[];
  mesh: InstancedMesh;
}

function samePositions(a: BufferGeometry, b: BufferGeometry): boolean {
  const pa = a.getAttribute('position') as BufferAttribute;
  const pb = b.getAttribute('position') as BufferAttribute;
  if (pa.count !== pb.count) return false;
  const x = pa.array;
  const y = pb.array;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

const _m = new Matrix4();
const _mb = new Matrix4();
const _mot = new Matrix4();
const _q = new Quaternion();
const _qt = new Quaternion();
const _p = new Vector3();
const _s = new Vector3(SCALE, SCALE, SCALE);
const _n = new Vector3();
const UP = new Vector3(0, 1, 0);
const _sphere = new Sphere();

/**
 * One InstancedMesh per kind × distinct part geometry. Parts with identical geometry and material
 * (a rusher's four legs, a breaker's eight wheels) share one mesh with one instance per part, so
 * the draw calls are per kind and part shape, not per leg.
 */
export class AlienRenderer {
  readonly group = new Group();
  private kinds: PartGroup[][];
  private state: InstanceState = { matrix: new Matrix4(), aim: 0, elev: 0, phase: 0, recoil: 0, seed: 0, visible: true };
  private counts: Int32Array[];
  readonly wrecks: InstancedMesh;
  triangles = 0;

  constructor(
    readonly models: ModelDef[],
    cap: number,
    mats: Mats,
    private ground: Ground,
  ) {
    this.kinds = models.map((model) => {
      const groups: Array<{ parts: PartDef[] }> = [];
      for (const p of model.parts) {
        const g = groups.find((x) => x.parts[0]!.material === p.material && samePositions(x.parts[0]!.geometry, p.geometry));
        if (g) g.parts.push(p);
        else groups.push({ parts: [p] });
      }
      return groups.map((g) => {
        const mesh = new InstancedMesh(g.parts[0]!.geometry, g.parts[0]!.material as Material | Material[], cap * g.parts.length);
        mesh.name = `${model.name}/${g.parts[0]!.name}×${g.parts.length}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.count = 0;
        this.group.add(mesh);
        return { parts: g.parts, mesh };
      });
    });
    this.counts = this.kinds.map((k) => new Int32Array(k.length));
    // wreck debris (W20's)
    const wb = new Builder(mats);
    const r = new Rand(5);
    for (let i = 0; i < 9; i++) wb.add(i % 3 ? 'hull' : 'trim', cbox(r.range(0.2, 0.7), r.range(0.1, 0.35), r.range(0.2, 0.6), 0.03), { x: r.range(-0.8, 0.8), y: r.range(-0.05, 0.15), z: r.range(-0.7, 0.7), ry: r.range(0, 3), rz: r.range(-0.5, 0.5), rx: r.range(-0.4, 0.4) });
    const { geometry, material } = wb.build();
    this.wrecks = new InstancedMesh(geometry, material, WRECK_CAP);
    this.wrecks.count = 0;
    this.wrecks.castShadow = true;
    this.wrecks.receiveShadow = true;
    this.wrecks.frustumCulled = false;
    this.group.add(this.wrecks);
  }

  get drawCalls(): number {
    let n = 0;
    this.kinds.forEach((k) =>
      k.forEach((g) => {
        if (g.mesh.count > 0) n += Array.isArray(g.mesh.material) ? g.mesh.material.length : 1;
      }),
    );
    return n;
  }

  /** Writes the instance matrices of every alien inside the frustum. Returns the number drawn. */
  update(sim: AlienSim, t: number, frustum: Frustum): number {
    for (const c of this.counts) c.fill(0);
    let drawn = 0;
    let tris = 0;
    const st = this.state;
    for (let s = 0; s < sim.cap; s++) {
      if (!sim.view.alive[s]) continue;
      const x = sim.x[s]!;
      const y = sim.y[s]!;
      const z = sim.z[s]!;
      _sphere.center.set(x, y + 0.6, z);
      _sphere.radius = 2.6;
      if (!frustum.intersectsSphere(_sphere)) continue;
      drawn++;
      const k = sim.kind[s]!;
      // ground tilt from the height grid, then the heading
      const e = 0.6;
      const g = this.ground;
      _n.set(g.height(x - e, z) - g.height(x + e, z), 2 * e, g.height(x, z - e) - g.height(x, z + e)).normalize();
      _qt.setFromUnitVectors(UP, _n);
      _q.setFromAxisAngle(UP, sim.heading[s]!).premultiply(_qt);
      _mb.compose(_p.set(x, y, z), _q, _s);
      st.phase = sim.phase[s]!;
      st.seed = sim.seed[s]!;
      const groups = this.kinds[k]!;
      const cnt = this.counts[k]!;
      for (let gi = 0; gi < groups.length; gi++) {
        const gr = groups[gi]!;
        for (const p of gr.parts) {
          _m.copy(_mb).multiply(p.pivot).multiply(motionMatrix(p.motion, st, t, _mot));
          _m.toArray(gr.mesh.instanceMatrix.array, cnt[gi]! * 16);
          cnt[gi]!++;
        }
      }
      tris += this.trisOf(k);
    }
    this.kinds.forEach((groups, k) =>
      groups.forEach((gr, gi) => {
        const n = this.counts[k]![gi]!;
        gr.mesh.count = n;
        gr.mesh.visible = n > 0;
        if (n > 0) {
          gr.mesh.instanceMatrix.clearUpdateRanges();
          gr.mesh.instanceMatrix.addUpdateRange(0, n * 16);
          gr.mesh.instanceMatrix.needsUpdate = true;
        }
      }),
    );
    this.triangles = tris;
    return drawn;
  }

  private trisCache: number[] = [];
  private trisOf(k: number): number {
    if (this.trisCache[k] === undefined) {
      let t = 0;
      for (const p of this.models[k]!.parts) {
        const g = p.geometry;
        t += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      }
      this.trisCache[k] = t;
    }
    return this.trisCache[k]!;
  }

  setWrecks(list: Wrecks): void {
    const a = this.wrecks.instanceMatrix.array as Float32Array;
    let n = 0;
    for (let i = 0; i < list.cap; i++) {
      if (!list.on[i]) continue;
      const sink = Math.max(0, list.age[i]! - (list.life - 2.5)) * 0.25;
      _q.setFromAxisAngle(UP, list.yaw[i]!);
      _m.compose(_p.set(list.x[i]!, list.y[i]! - sink, list.z[i]!), _q, _n.setScalar(list.scale[i]!));
      _m.toArray(a, n * 16);
      n++;
    }
    this.wrecks.count = n;
    this.wrecks.visible = n > 0;
    this.wrecks.instanceMatrix.needsUpdate = true;
  }
}

export const WRECK_CAP = 96;

/** Wreck pool: a fixed number of slots; a new wreck replaces the oldest when all are taken. */
export class Wrecks {
  readonly cap: number;
  readonly on: Uint8Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly age: Float32Array;
  readonly yaw: Float32Array;
  readonly scale: Float32Array;
  readonly life = 16;
  private order: number[] = [];

  constructor(cap = WRECK_CAP) {
    this.cap = cap;
    this.on = new Uint8Array(cap);
    this.x = new Float64Array(cap);
    this.y = new Float64Array(cap);
    this.z = new Float64Array(cap);
    this.age = new Float32Array(cap);
    this.yaw = new Float32Array(cap);
    this.scale = new Float32Array(cap);
  }

  get count(): number {
    return this.order.length;
  }

  /** Adds a wreck; returns the slot and the slot it displaced (−1 if none). */
  add(x: number, y: number, z: number, scale: number, yaw: number): { slot: number; replaced: number } {
    let slot = -1;
    let replaced = -1;
    for (let i = 0; i < this.cap; i++)
      if (!this.on[i]) {
        slot = i;
        break;
      }
    if (slot < 0) {
      slot = this.order.shift()!;
      replaced = slot;
    }
    this.on[slot] = 1;
    this.x[slot] = x;
    this.y[slot] = y;
    this.z[slot] = z;
    this.age[slot] = 0;
    this.yaw[slot] = yaw;
    this.scale[slot] = scale;
    this.order.push(slot);
    return { slot, replaced };
  }

  /** Ages every wreck; calls `expired` for each one removed. */
  update(dt: number, expired: (slot: number) => void): void {
    for (let i = 0; i < this.cap; i++) {
      if (!this.on[i]) continue;
      this.age[i]! += dt;
      if (this.age[i]! >= this.life) {
        this.on[i] = 0;
        this.order.splice(this.order.indexOf(i), 1);
        expired(i);
      }
    }
  }

  clear(): void {
    this.on.fill(0);
    this.order.length = 0;
  }
}

export function alienModels(mats: Mats): ModelDef[] {
  return KINDS.map((k) => ALIEN_MAKERS[k](mats));
}
