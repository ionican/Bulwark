// Effects drawn from snapshots (W24 run 2b): build and reclaim beams, the beam turret's beam, shots
// and their impacts, muzzle flashes, and smoke. render/anim.ts decides when each is on; this
// module only draws, refilling its pools from zero every frame. Pools are sized from the
// simulation's table capacities (units, buildings, projectiles), with `overflowed` set if one is
// ever exceeded; particles are bounded by W21's caps (a particle past a cap is not spawned).
//
//   build beam        W23 nano-beam (workshop/w23/beams.ts), emitter → site, with three diamond
//                     pulses travelling to the site
//   reclaim beam      the same streak in the opposite direction, wreck → emitter, with ring pulses
//                     travelling to the emitter: told apart from a build beam by direction and
//                     pulse shape, never by colour alone
//   turret beam       the beam turret's beam, muzzle → target, every frame while it fires; its
//                     width pulses with the effect clock
//   tracers           every observed projectile row (bullets, shells, heavy shells) as a W21 HDR
//                     streak; a new row's first point is its shooter's muzzle when the shooter is
//                     still there, so the shot leaves the barrel
//   alien shots       alien projectile rows as small round blobs (a different shape from tracers)
//   impacts           when a row is gone, W21 particles at its last drawn position: sparks for a
//                     bullet or an alien shot, a small explosion for a shell, a larger one for a
//                     heavy shell. Best effort (render/anim.ts header): some shots are never seen.
//   muzzle flash      a short cone at the muzzle along the barrel (FLASH_LIFE of effect clock), plus
//                     W21's muzzle blast particles
//   smoke             W21 chimney smoke over a working smelter
//
// Mesh names `overlay/fx/…`, so the scene inspection counts them as overlays, never as models of
// the entity they are drawn over. Particles are the W21 meshes `overlay/fx/smoke` and
// `overlay/fx/glow`. A reset (render/anim.ts) clears everything with no impacts.

import {
  AdditiveBlending,
  Color,
  ConeGeometry,
  Group,
  IcosahedronGeometry,
  Matrix4,
  MeshBasicMaterial,
  OctahedronGeometry,
  Quaternion,
  TorusGeometry,
  Vector3,
  BoxGeometry,
  type BufferGeometry,
  type Material,
  type Camera,
} from 'three';
import { P_ALIEN, P_BEAM, P_HEAVY, P_SHELL } from '../sim/kinds.ts';
import { slotOf } from '../sim/table.ts';
import { FLASH_LIFE } from './anim.ts';
import type { MobileView } from './interp.ts';
import { Particles, PType } from './workshop/fx/particles.ts';
import { PARTICLE_CAPS, blastMiddle, blastSimple } from './workshop/stress/effects.ts';
import { BEAM_CYAN, Beams } from './workshop/w23/beams.ts';
import { SimpleBatch } from './simpleBatch.ts';

export interface EffectsCapacity {
  buildings: number;
  units: number;
  projectiles: number;
}

/** Visibility test (frustum), centre and radius in tiles; always true with culling off. */
export type Visible = (x: number, y: number, z: number, r: number) => boolean;

/**
 * What this frame committed for drawing (models.ts activity reads it): build and reclaim beams,
 * shots in flight (tracers and alien shots) and muzzle flashes, counted from the instances uploaded
 * in `commit`; turret beams pushed for a turret on screen. Set in `commit`, not by the states that
 * asked for the effects (W24 review).
 */
export interface Activity {
  beams: number;
  shots: number;
  flashes: number;
  turretBeams: number;
}

const NONE = 0xffffffff;
const PULSES = 3;
const X = new Vector3(1, 0, 0);
const _a = new Vector3();
const _b = new Vector3();
const _d = new Vector3();
const _s = new Vector3();
const _k = new Vector3();
const _q = new Quaternion();
const _m = new Matrix4();
const TRACER_COL: Record<number, [number, number, number]> = { 0: [5, 2.9, 1.1], 1: [5.5, 2.4, 0.9], 2: [6, 2.2, 0.7] };

const additive = (r: number, g: number, b: number) => new MeshBasicMaterial({ color: new Color(r, g, b), toneMapped: false, transparent: true, blending: AdditiveBlending, depthWrite: false, fog: false });

export class Effects {
  readonly group = new Group();
  readonly particles: Particles;
  private readonly buildBeams: Beams;
  private readonly reclaimBeams: Beams;
  private readonly turretBeams: Beams;
  private readonly buildPulses: SimpleBatch;
  private readonly reclaimPulses: SimpleBatch;
  private readonly tracers: SimpleBatch;
  private readonly alienShots: SimpleBatch;
  private readonly flashes: SimpleBatch;
  /** Every instanced pool and beam set above, for begin, commit and `overflowed`. */
  private readonly pools: SimpleBatch[];
  private readonly beamSets: Beams[];
  private beamOverflow = false;
  /** Beams pushed this frame: build, reclaim, turret (Beams drops one past its capacity silently). */
  private readonly beamN = [0, 0, 0];
  // flash pool (structure of arrays): position, direction, age
  private readonly fPos: Float32Array;
  private readonly fDir: Float32Array;
  private readonly fAge: Float32Array;
  private readonly fBig: Uint8Array;
  private fN = 0;
  private flashOverflow = false;
  // projectile slots: id, origin and last drawn head; the frame each was last seen
  private readonly pId: Uint32Array;
  private readonly pOrigin: Float32Array;
  /** Flight height over the origin (ground + 0.6), sampled once when the slot is assigned. */
  private readonly pFlight: Float32Array;
  private readonly pHead: Float32Array;
  private readonly pKind: Uint8Array;
  private readonly pSeen: Uint32Array;
  private alive: Int32Array;
  private aliveNext: Int32Array;
  private aliveN = 0;
  private frameNo = 1;
  /** Smoke emitter accumulators per building slot. */
  private readonly smokeAcc: Float32Array;
  private readonly smokeId: Uint32Array;
  private cam: Camera | null = null;
  private camPos = new Vector3();
  private wppd = 0;
  private t = 0;
  private dt = 0;
  readonly activity: Activity = { beams: 0, shots: 0, flashes: 0, turretBeams: 0 };
  /** Frustum test for the frame (models.ts sets it before drawing); turret beams on screen count. */
  visible: Visible = () => true;

  constructor(readonly capacity: EffectsCapacity) {
    this.group.name = 'effects';
    const C = capacity;
    const named = (b: Beams, name: string) => {
      b.mesh.name = name;
      this.group.add(b.mesh);
      return b;
    };
    this.buildBeams = named(new Beams(C.units), 'overlay/fx/build-beam');
    this.reclaimBeams = named(new Beams(C.units), 'overlay/fx/reclaim-beam');
    this.turretBeams = named(new Beams(C.buildings), 'overlay/fx/turret-beam');
    const pool = (geometry: BufferGeometry, material: Material, cap: number, name: string, colours = false) => {
      const p = new SimpleBatch(geometry, material, cap, name, colours);
      p.mesh.renderOrder = 10;
      p.mesh.castShadow = false;
      p.mesh.receiveShadow = false;
      return p;
    };
    this.buildPulses = pool(new OctahedronGeometry(0.09, 0), additive(0.6, 2.4, 2.8), C.units * PULSES, 'overlay/fx/build-pulse');
    const ring = new TorusGeometry(0.1, 0.028, 4, 10).rotateY(Math.PI / 2); // faces along +x (the beam)
    this.reclaimPulses = pool(ring, additive(0.6, 2.4, 2.8), C.units * PULSES, 'overlay/fx/reclaim-pulse');
    const streak = new BoxGeometry(1, 1, 1).translate(0.5, 0, 0);
    this.tracers = pool(streak, new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: false }), C.projectiles, 'overlay/fx/tracer', true);
    this.alienShots = pool(new IcosahedronGeometry(0.13, 0), additive(1.4, 3.2, 0.9), C.projectiles, 'overlay/fx/alien-shot');
    const cone = new ConeGeometry(0.16, 0.55, 7, 1, true).rotateZ(-Math.PI / 2).translate(0.27, 0, 0); // opens forward along +x
    this.flashes = pool(cone, additive(6, 3.6, 1.5), C.buildings, 'overlay/fx/flash');
    this.pools = [this.buildPulses, this.reclaimPulses, this.tracers, this.alienShots, this.flashes];
    this.beamSets = [this.buildBeams, this.reclaimBeams, this.turretBeams];
    for (const p of this.pools) this.group.add(p.mesh);
    this.particles = new Particles(PARTICLE_CAPS);
    this.particles.smokeMesh.name = 'overlay/fx/smoke';
    this.particles.glowMesh.name = 'overlay/fx/glow';
    this.group.add(this.particles.smokeMesh, this.particles.glowMesh);
    this.fPos = new Float32Array(C.buildings * 3);
    this.fDir = new Float32Array(C.buildings * 3);
    this.fAge = new Float32Array(C.buildings);
    this.fBig = new Uint8Array(C.buildings);
    this.pId = new Uint32Array(C.projectiles).fill(NONE);
    this.pOrigin = new Float32Array(C.projectiles * 3);
    this.pFlight = new Float32Array(C.projectiles);
    this.pHead = new Float32Array(C.projectiles * 3);
    this.pKind = new Uint8Array(C.projectiles);
    this.pSeen = new Uint32Array(C.projectiles);
    this.alive = new Int32Array(C.projectiles);
    this.aliveNext = new Int32Array(C.projectiles);
    this.smokeAcc = new Float32Array(C.buildings);
    this.smokeId = new Uint32Array(C.buildings).fill(NONE);
  }

  get overflowed(): boolean {
    return this.beamOverflow || this.flashOverflow || this.pools.some((p) => p.overflowed);
  }

  /** Drops every effect (a world reset): no impacts for the rows that vanish with it. */
  clear(): void {
    this.particles.clear();
    this.fN = 0;
    for (let i = 0; i < this.aliveN; i++) this.pId[this.alive[i]!] = NONE;
    this.aliveN = 0;
    this.smokeAcc.fill(0);
  }

  /**
   * Starts a frame: the camera position (beam widths) and camera (particle sorting), world units
   * per pixel per unit of distance, the effect clock, and whether this frame is a global reset.
   */
  begin(camPos: Vector3, camera: Camera, wppd: number, t: number, dt: number, reset: boolean): void {
    if (reset) this.clear();
    this.cam = camera;
    this.camPos.copy(camPos);
    this.wppd = wppd;
    this.t = t;
    this.dt = dt;
    // flashes and particles age first, before this frame's spawns, so every new one is drawn at
    // least once however long the frame's step (W24 review: at 10x a 0.1 s step outlived a flash)
    for (let i = this.fN - 1; i >= 0; i--) {
      this.fAge[i]! += dt;
      if (this.fAge[i]! < FLASH_LIFE) continue;
      const j = --this.fN;
      if (i === j) continue;
      this.fPos.copyWithin(i * 3, j * 3, j * 3 + 3);
      this.fDir.copyWithin(i * 3, j * 3, j * 3 + 3);
      this.fAge[i] = this.fAge[j]!;
      this.fBig[i] = this.fBig[j]!;
    }
    this.particles.advance(dt);
    for (const b of this.beamSets) b.begin();
    for (const p of this.pools) p.begin();
    this.beamN.fill(0);
    this.activity.beams = this.activity.shots = this.activity.flashes = this.activity.turretBeams = 0;
    this.frameNo++;
  }

  /**
   * A build beam (emitter → site) or a reclaim beam (wreck → emitter): `a` to `b`, with pulses that
   * travel from a to b as the effect clock advances. `seed` staggers the pulses per unit.
   */
  workBeam(reclaim: boolean, ax: number, ay: number, az: number, bx: number, by: number, bz: number, seed: number): void {
    const beams = reclaim ? this.reclaimBeams : this.buildBeams;
    if (++this.beamN[reclaim ? 1 : 0]! > this.capacity.units) this.beamOverflow = true;
    _a.set(ax, ay, az);
    _b.set(bx, by, bz);
    beams.push(_a, _b, reclaim ? 0.04 : 0.028, BEAM_CYAN, reclaim ? 3.2 : 4, this.camPos, this.wppd, 2.4);
    const pool = reclaim ? this.reclaimPulses : this.buildPulses;
    _d.subVectors(_b, _a);
    const len = _d.length();
    if (len < 1e-4) return;
    _q.setFromUnitVectors(X, _d.divideScalar(len));
    // pulses travel at 3 tiles a second, spaced evenly along the beam
    // at least about 4 pixels across at the game camera
    const k = Math.max(1, Math.min(4, (this.wppd * _a.distanceTo(this.camPos) * 4) / 0.18));
    _k.set(k, k, k);
    for (let p = 0; p < PULSES; p++) {
      const u = ((((this.t * 3) / Math.max(1, len) + p / PULSES + seed) % 1) + 1) % 1;
      const i = pool.take();
      if (i < 0) break;
      _m.compose(_s.set(ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u), _q, _k);
      _m.toArray(pool.mesh.instanceMatrix.array as Float32Array, i * 16);
    }
  }

  /** The beam turret's beam, muzzle → target; its width pulses with the effect clock. */
  turretBeam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, seed: number): void {
    if (++this.beamN[2]! > this.capacity.buildings) this.beamOverflow = true;
    else if (this.visible((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, Math.hypot(bx - ax, by - ay, bz - az) / 2 + 0.5)) this.activity.turretBeams++;
    _a.set(ax, ay, az);
    _b.set(bx, by, bz);
    const pulse = 0.75 + 0.25 * Math.sin(this.t * 31 + seed * 6.283);
    this.turretBeams.push(_a, _b, 0.09 * pulse, BEAM_CYAN, 6 * pulse, this.camPos, this.wppd, 3 * pulse);
  }

  /**
   * A muzzle flash at (x, y, z) along (dx, dy, dz) (a unit vector), and W21's muzzle blast: the
   * middle-detail blast for a turret drawn at full or middle detail, one forward flash otherwise.
   */
  flash(x: number, y: number, z: number, dx: number, dy: number, dz: number, big: boolean, close: boolean): void {
    const i = this.fN;
    if (i >= this.fAge.length) {
      this.flashOverflow = true;
      return;
    }
    this.fN++;
    this.fPos[i * 3] = x;
    this.fPos[i * 3 + 1] = y;
    this.fPos[i * 3 + 2] = z;
    this.fDir[i * 3] = dx;
    this.fDir[i * 3 + 1] = dy;
    this.fDir[i * 3 + 2] = dz;
    this.fAge[i] = 0;
    this.fBig[i] = big ? 1 : 0;
    _d.set(dx, dy, dz);
    if (close) {
      _a.set(dz, 0, -dx).normalize(); // side
      _b.set(x - dx * 0.3, y - dy * 0.3, z - dz * 0.3); // brake ports a little behind the muzzle
      blastMiddle(this.particles, x, y, z, _d, _a, _b);
    } else blastSimple(this.particles, x, y, z, _d);
  }

  /**
   * Every projectile row of `view` (interpolated positions). `origin(id, out, o)` writes the muzzle
   * of a projectile's shooter into out[o..o+2] and returns false when the shooter is not drawn.
   * Beam-turret rows (P_BEAM) are not drawn here: the turret's beam is.
   */
  shots(view: MobileView, ground: (x: number, z: number) => number, origin: (id: number, out: Float32Array, o: number) => boolean, visible: Visible): void {
    const f = this.frameNo;
    let n = 0;
    for (let r = 0; r < view.count; r++) {
      const id = view.id[r]!;
      const s = slotOf(id);
      if (s >= this.pId.length || view.kind[r]! === P_BEAM) continue;
      const x = view.x[r]!;
      const z = view.z[r]!;
      const g = ground(x, z) + 0.6;
      if (this.pId[s] !== id) {
        // a reused slot: the previous row in it went (an impact), then a new shot
        if (this.pId[s] !== NONE && this.pSeen[s] === f - 1) this.impact(s);
        this.pId[s] = id;
        this.pKind[s] = view.kind[r]!;
        if (!origin(id, this.pOrigin, s * 3)) {
          this.pOrigin[s * 3] = x;
          this.pOrigin[s * 3 + 1] = g + 0.3;
          this.pOrigin[s * 3 + 2] = z;
        }
        this.pFlight[s] = ground(this.pOrigin[s * 3]!, this.pOrigin[s * 3 + 2]!) + 0.6;
      }
      this.pSeen[s] = f;
      this.aliveNext[n++] = s;
      // height: from the muzzle's height down to the flight height over the first few tiles
      const ox = this.pOrigin[s * 3]!;
      const oy = this.pOrigin[s * 3 + 1]!;
      const oz = this.pOrigin[s * 3 + 2]!;
      const travel = Math.hypot(x - ox, z - oz);
      const y = g + (oy - this.pFlight[s]!) * Math.exp(-travel / 3);
      this.pHead[s * 3] = x;
      this.pHead[s * 3 + 1] = y;
      this.pHead[s * 3 + 2] = z;
      if (!visible(x, y, z, 1)) continue;
      const kind = view.kind[r]!;
      if (kind === P_ALIEN) {
        const i = this.alienShots.take();
        if (i < 0) continue;
        const k = Math.max(1, (1.6 * this.wppd * this.camPos.distanceTo(_a.set(x, y, z))) / 0.13);
        _m.makeScale(k, k, k).setPosition(x, y, z);
        _m.toArray(this.alienShots.mesh.instanceMatrix.array as Float32Array, i * 16);
        continue;
      }
      const i = this.tracers.take();
      if (i < 0) continue;
      // a W21 streak ending at the head, at most as long as the distance flown from the muzzle
      _d.set(x - ox, y - oy, z - oz);
      const flown = _d.length();
      if (flown > 1e-4) _d.divideScalar(flown);
      else _d.set(view.fx[r]!, 0, view.fz[r]!);
      const w = Math.max(kind === P_HEAVY ? 0.07 : kind === P_SHELL ? 0.05 : 0.032, 1.6 * this.wppd * this.camPos.distanceTo(_a.set(x, y, z)));
      const len = Math.max(0.05, Math.min(Math.max(1.1, w * 25), flown));
      _q.setFromUnitVectors(X, _d);
      _m.compose(_s.set(x - _d.x * len, y - _d.y * len, z - _d.z * len), _q, _b.set(len, w, w));
      _m.toArray(this.tracers.mesh.instanceMatrix.array as Float32Array, i * 16);
      const c = TRACER_COL[kind] ?? TRACER_COL[0]!;
      this.tracers.mesh.instanceColor!.setXYZ(i, c[0], c[1], c[2]);
    }
    // rows seen last frame and not this one are gone: an impact at the last drawn head
    for (let i = 0; i < this.aliveN; i++) {
      const s = this.alive[i]!;
      if (this.pSeen[s] !== f && this.pId[s] !== NONE) {
        this.impact(s);
        this.pId[s] = NONE;
      }
    }
    const t = this.alive;
    this.alive = this.aliveNext;
    this.aliveNext = t;
    this.aliveN = n;
  }

  private impact(s: number): void {
    const x = this.pHead[s * 3]!;
    const y = this.pHead[s * 3 + 1]!;
    const z = this.pHead[s * 3 + 2]!;
    const k = this.pKind[s]!;
    if (k === P_HEAVY) this.particles.explosion(x, y, z, 0.6);
    else if (k === P_SHELL) this.particles.explosion(x, y, z, 0.35);
    else this.particles.sparks(x, y, z, k === P_ALIEN ? 3 : 5, 4);
  }

  /** Smoke from a working smelter's two chimneys (W21's chimney emitter, 4 puffs a second each), building slot `s`. */
  chimneys(s: number, id: number, points: ReadonlyArray<readonly [number, number, number]>): void {
    if (this.smokeId[s] !== id) {
      this.smokeId[s] = id;
      this.smokeAcc[s] = 0;
    }
    this.smokeAcc[s]! += this.dt * 4;
    const r = Math.random;
    while (this.smokeAcc[s]! >= 1) {
      this.smokeAcc[s]! -= 1;
      for (const [x, y, z] of points) {
        const c = 0.38 + 0.1 * r();
        this.particles.spawn({ type: PType.Smoke, x: x + (r() - 0.5) * 0.2, y, z: z + (r() - 0.5) * 0.2, vx: (r() - 0.5) * 0.4, vy: 1.2 + r() * 0.6, vz: (r() - 0.5) * 0.4, life: 3 + r() * 1.5, s0: 0.35, s1: 1.6, r: c * 1.05, g: c * 0.95, b: c * 0.9, a: 0.45, drag: 0.25, buoy: 0.1 });
      }
    }
  }

  /** Ends the frame: flashes drawn (growing with age), emitters spawn, particles and pools uploaded. */
  commit(): void {
    for (let i = 0; i < this.fN; i++) {
      const k = this.flashes.take();
      if (k < 0) break;
      const u = this.fAge[i]! / FLASH_LIFE;
      const sz = (this.fBig[i] ? 2 : 1) * (0.7 + 0.6 * u);
      _d.set(this.fDir[i * 3]!, this.fDir[i * 3 + 1]!, this.fDir[i * 3 + 2]!);
      _q.setFromUnitVectors(X, _d);
      _m.compose(_s.set(this.fPos[i * 3]!, this.fPos[i * 3 + 1]!, this.fPos[i * 3 + 2]!), _q, _a.set(sz, sz * (1 - 0.4 * u), sz * (1 - 0.4 * u)));
      _m.toArray(this.flashes.mesh.instanceMatrix.array as Float32Array, k * 16);
    }
    for (const b of this.beamSets) b.commit();
    for (const p of this.pools) p.commit();
    // activity: what was uploaded for drawing this frame
    const A = this.activity;
    A.beams = this.buildBeams.mesh.count + this.reclaimBeams.mesh.count;
    A.shots = this.tracers.mesh.count + this.alienShots.mesh.count;
    A.flashes = this.flashes.mesh.count;
    this.particles.emit(this.dt);
    if (this.cam) this.particles.draw(this.cam);
  }

  /**
   * The particle meshes drawn once at (x, y, z) for the warm-up frame (their programs compiled), or
   * cleared. The pools and beams are instanced meshes, primed with the rest by models.ts prime.
   */
  prime(on: boolean, x = 0, y = 0, z = 0, camera: Camera | null = null): void {
    if (!on) {
      this.particles.clear();
      return;
    }
    this.particles.spawn({ type: PType.Smoke, x, y: y + 1, z, life: 1, s0: 0.5, s1: 1, r: 0.5, g: 0.5, b: 0.5, a: 0.5 });
    this.particles.spawn({ type: PType.Flash, x, y: y + 1, z, life: 1, s0: 0.5, s1: 1, r: 2, g: 2, b: 2, a: 1 });
    if (camera) this.particles.update(0, camera);
  }
}
