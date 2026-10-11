// Alien machines walking into the bench range (W17's code-built alien kinds, drawn through
// ModelLayer). Each one enters at the far end of a gully, walks to the gully mouth and then
// straight towards a stopping point near the turret, at constant speed per leg, so the turret's
// lead has a constant velocity to work with on each leg. Hits spark; at 0 HP the alien explodes,
// leaves a burning wreck that smokes for a while and sinks away, and (with auto waves on) a
// replacement spawns after a short delay.

import { Group, Quaternion, Vector3 } from 'three';
import type { Particles } from '../fx/particles.ts';
import { Builder, cbox } from '../models/kit.ts';
import type { Mats } from '../models/materials.ts';
import { ALIEN_MAKERS } from '../models/procedural/aliens.ts';
import { part } from '../models/procedural/common.ts';
import { Rand } from '../noise.ts';
import { ModelLayer, placeMatrix } from '../scene/modelLayer.ts';
import type { AlienKind } from '../world/layout.ts';
import type { BrainTarget } from './brain.ts';
import { GULLIES, rangeHeight } from './range.ts';

const KINDS: AlienKind[] = ['rusher', 'hunter', 'breaker', 'saboteur'];
const SPEED: Record<AlienKind, number> = { rusher: 2.4, hunter: 4.4, breaker: 0.9, saboteur: 1.8 };
const HP: Record<AlienKind, number> = { rusher: 3, hunter: 2, breaker: 12, saboteur: 5 };
const GAIT: Record<AlienKind, number> = { rusher: 5.5, hunter: 0, breaker: 0, saboteur: 0 };
/** Drawn 1.5× their simulation size, as in the W17 vista. */
const SCALE = 1.5;
const CAP = 12;

export interface Alien {
  id: number;
  kind: AlienKind;
  slot: number;
  pos: Vector3;
  vel: Vector3;
  aim: Vector3;
  path: Vector3[];
  leg: number;
  hp: number;
  alive: boolean;
  radius: number;
  height: number;
  /** Seconds left before a hold-position alien fires its own (harmless) bolt at the turret. */
  shotIn: number;
}

interface Wreck {
  slot: number;
  age: number;
  life: number;
  x: number;
  z: number;
  y: number;
  scale: number;
  yaw: number;
  cooled: boolean;
  emitters: ReturnType<Particles['addEmitter']>[];
}

export class Targets {
  readonly group = new Group();
  readonly aliens: Alien[] = [];
  auto = true;
  /** Aliens kept on the range when auto waves are on. */
  population = 5;
  kills = 0;
  spawned = 0;
  private layers = new Map<AlienKind, ModelLayer>();
  private free = new Map<AlienKind, number[]>();
  private wreckLayer: ModelLayer;
  private wrecks: Wreck[] = [];
  private wreckFree: number[] = [];
  private nextId = 1;
  private respawnIn: number[] = [];
  private rnd = new Rand(77);
  readonly onAlienShot: Array<(from: Vector3) => void> = [];

  constructor(
    mats: Mats,
    private fx: Particles,
  ) {
    for (const k of KINDS) {
      const l = new ModelLayer(ALIEN_MAKERS[k](mats), CAP, { dynamic: true });
      for (let i = 0; i < CAP; i++) {
        l.add(placeMatrix(0, -50, 0, 0), i / CAP);
        l.states[i]!.visible = false;
      }
      this.layers.set(k, l);
      this.free.set(k, Array.from({ length: CAP }, (_, i) => CAP - 1 - i));
      this.group.add(l.group);
    }
    const wb = new Builder(mats);
    const r = new Rand(5);
    for (let i = 0; i < 9; i++) wb.add(i % 3 ? 'hull' : 'trim', cbox(r.range(0.2, 0.7), r.range(0.1, 0.35), r.range(0.2, 0.6), 0.03), { x: r.range(-0.8, 0.8), y: r.range(-0.05, 0.15), z: r.range(-0.7, 0.7), ry: r.range(0, 3), rz: r.range(-0.5, 0.5), rx: r.range(-0.4, 0.4) });
    this.wreckLayer = new ModelLayer({ name: 'wreck', parts: [part('debris', wb)], radius: 1.2, height: 0.5 }, 16, { dynamic: true });
    for (let i = 0; i < 16; i++) {
      this.wreckLayer.add(placeMatrix(0, -50, 0, 0));
      this.wreckLayer.states[i]!.visible = false;
      this.wreckFree.push(15 - i);
    }
    this.group.add(this.wreckLayer.group);
  }

  get alive(): Alien[] {
    return this.aliens.filter((a) => a.alive);
  }

  get wreckCount(): number {
    return this.wrecks.length;
  }

  /** Spawns one alien; `kind` random if omitted; `gully` index random if omitted. */
  spawn(kind?: AlienKind, gully?: number, startDist?: number): Alien | null {
    const k = kind ?? this.pickKind();
    const slots = this.free.get(k)!;
    if (!slots.length) return null;
    const slot = slots.pop()!;
    const gi = gully ?? this.rnd.int(GULLIES.length);
    const a = (GULLIES[gi]! * Math.PI) / 180;
    const dir = new Vector3(Math.cos(a), 0, -Math.sin(a));
    const side = new Vector3(-dir.z, 0, dir.x);
    const d0 = startDist ?? this.rnd.range(62, 82);
    const start = dir.clone().multiplyScalar(d0).addScaledVector(side, this.rnd.range(-4, 4));
    const mouth = dir.clone().multiplyScalar(this.rnd.range(30, 36)).addScaledVector(side, this.rnd.range(-3, 3));
    // stop somewhere in front of the turret, off the line of approach by up to ±35°
    const sa = a + this.rnd.range(-0.6, 0.6);
    const stop = new Vector3(Math.cos(sa), 0, -Math.sin(sa)).multiplyScalar(this.rnd.range(5.5, 10));
    const path = [start, mouth, stop];
    for (const p of path) p.y = rangeHeight(p.x, p.z);
    const model = this.layers.get(k)!.model;
    const al: Alien = {
      id: this.nextId++,
      kind: k,
      slot,
      pos: start.clone(),
      vel: new Vector3(),
      aim: new Vector3(),
      path,
      leg: 0,
      hp: HP[k],
      alive: true,
      radius: Math.max(0.45, model.radius * SCALE * 0.55),
      height: model.height * SCALE,
      shotIn: 1 + this.rnd.next() * 2,
    };
    this.layers.get(k)!.states[slot]!.visible = true;
    this.aliens.push(al);
    this.spawned++;
    this.place(al, 0);
    return al;
  }

  /** Spawns an alien that walks the given ground points (x, z) and holds at the last one. */
  spawnPath(kind: AlienKind, pts: Array<[number, number]>): Alien | null {
    const a = this.spawn(kind, 0, 60);
    if (!a) return null;
    a.path = pts.map(([x, z]) => new Vector3(x, rangeHeight(x, z), z));
    a.leg = 0;
    a.pos.copy(a.path[0]!);
    this.place(a, 0);
    return a;
  }

  spawnGroup(n = 5): void {
    const gi = this.rnd.int(GULLIES.length);
    for (let i = 0; i < n; i++) this.spawn(undefined, gi, 60 + i * 3.5);
  }

  clear(): void {
    for (const a of this.aliens) this.layers.get(a.kind)!.states[a.slot]!.visible = false;
    for (const a of this.aliens) this.free.get(a.kind)!.push(a.slot);
    this.aliens.length = 0;
    for (const w of this.wrecks) this.removeWreck(w);
    this.wrecks.length = 0;
    this.respawnIn.length = 0;
  }

  private pickKind(): AlienKind {
    const r = this.rnd.next();
    return r < 0.5 ? 'rusher' : r < 0.72 ? 'hunter' : r < 0.86 ? 'saboteur' : 'breaker';
  }

  /** Damage from a shell; returns true when this hit destroyed it. */
  hit(a: Alien, at: Vector3, dmg = 1): boolean {
    if (!a.alive) return false;
    a.hp -= dmg;
    this.fx.sparks(at.x, at.y, at.z, 10, 6);
    if (a.hp > 0) return false;
    this.destroy(a);
    return true;
  }

  private destroy(a: Alien): void {
    a.alive = false;
    this.kills++;
    const big = a.kind === 'breaker' ? 1.5 : a.kind === 'rusher' ? 0.75 : 1;
    this.fx.explosion(a.pos.x, a.pos.y, a.pos.z, big);
    this.layers.get(a.kind)!.states[a.slot]!.visible = false;
    this.free.get(a.kind)!.push(a.slot);
    this.aliens.splice(this.aliens.indexOf(a), 1);
    this.addWreck(a.pos.x, a.pos.z, big * 0.8);
    if (this.auto) this.respawnIn.push(2.5 + this.rnd.next() * 2);
  }

  private addWreck(x: number, z: number, scale: number): void {
    if (!this.wreckFree.length) this.removeWreck(this.wrecks.shift()!);
    const slot = this.wreckFree.pop()!;
    const y = rangeHeight(x, z);
    const p = new Vector3(x, y + 0.3, z);
    const w: Wreck = { slot, age: 0, life: 16, x, z, y, scale, yaw: this.rnd.range(0, 6.28), cooled: false, emitters: [this.fx.addEmitter('fire', p, scale * 0.7), this.fx.addEmitter('plume', p, scale * 0.9)] };
    this.wrecks.push(w);
    this.wreckLayer.states[slot]!.visible = true;
  }

  private removeWreck(w: Wreck): void {
    for (const e of w.emitters) this.fx.removeEmitter(e);
    this.wreckLayer.states[w.slot]!.visible = false;
    this.wreckFree.push(w.slot);
  }

  private place(a: Alien, dt: number): void {
    const st = this.layers.get(a.kind)!.states[a.slot]!;
    const target = a.path[Math.min(a.leg + 1, a.path.length - 1)]!;
    const holding = a.leg >= a.path.length - 1;
    const v = SPEED[a.kind];
    if (!holding) {
      const to = new Vector3(target.x - a.pos.x, 0, target.z - a.pos.z);
      const d = to.length();
      if (d < v * dt + 1e-3) {
        a.pos.set(target.x, a.pos.y, target.z);
        a.leg++;
      } else {
        to.multiplyScalar(1 / d);
        a.vel.set(to.x * v, 0, to.z * v);
        a.pos.x += a.vel.x * dt;
        a.pos.z += a.vel.z * dt;
      }
    }
    if (a.leg >= a.path.length - 1) a.vel.set(0, 0, 0);
    a.pos.y = rangeHeight(a.pos.x, a.pos.z);
    a.aim.set(a.pos.x, a.pos.y + a.height * 0.45, a.pos.z);
    // heading: along the walk, or facing the turret while holding
    const hx = a.vel.lengthSq() > 0 ? a.vel.x : -a.pos.x;
    const hz = a.vel.lengthSq() > 0 ? a.vel.z : -a.pos.z;
    const yaw = Math.atan2(-hz, hx);
    const e = 0.6;
    const n = new Vector3(rangeHeight(a.pos.x - e, a.pos.z) - rangeHeight(a.pos.x + e, a.pos.z), 2 * e, rangeHeight(a.pos.x, a.pos.z - e) - rangeHeight(a.pos.x, a.pos.z + e)).normalize();
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), n);
    st.matrix.copy(placeMatrix(a.pos.x, a.pos.y, a.pos.z, yaw, [SCALE, SCALE, SCALE], q));
    st.phase += v * dt * GAIT[a.kind] * (holding ? 0 : 1);
  }

  update(t: number, dt: number): void {
    for (const a of this.aliens) {
      this.place(a, dt);
      if (a.leg >= a.path.length - 1) {
        a.shotIn -= dt;
        if (a.shotIn <= 0) {
          a.shotIn = 2.2 + this.rnd.next() * 1.5;
          for (const f of this.onAlienShot) f(a.aim.clone());
        }
      }
    }
    for (let i = this.respawnIn.length - 1; i >= 0; i--) {
      this.respawnIn[i]! -= dt;
      if (this.respawnIn[i]! <= 0) {
        this.respawnIn.splice(i, 1);
        if (this.auto) this.spawn();
      }
    }
    if (this.auto && this.aliens.length + this.respawnIn.length < this.population && this.rnd.next() < dt * 0.6) this.spawn();
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i]!;
      w.age += dt;
      if (w.age > 9 && !w.cooled) {
        w.cooled = true;
        for (const e of w.emitters) this.fx.removeEmitter(e);
        w.emitters = [this.fx.addEmitter('plume', new Vector3(w.x, w.y + 0.2, w.z), w.scale * 0.5)];
      }
      const sink = Math.max(0, w.age - (w.life - 2.5)) * 0.25;
      this.wreckLayer.states[w.slot]!.matrix.copy(placeMatrix(w.x, w.y - sink, w.z, w.yaw, [w.scale, w.scale, w.scale]));
      if (w.age >= w.life) {
        this.removeWreck(w);
        this.wrecks.splice(i, 1);
      }
    }
    this.wreckLayer.markDirty();
    for (const l of this.layers.values()) {
      l.markDirty();
      l.update(t);
    }
    this.wreckLayer.update(t);
  }

  brainTargets(): BrainTarget[] {
    return this.aliens.map((a) => ({ id: a.id, pos: [a.aim.x, a.aim.y, a.aim.z], vel: [a.vel.x, 0, a.vel.z], alive: a.alive, radius: a.radius }));
  }

  byId(id: number): Alien | undefined {
    return this.aliens.find((a) => a.id === id);
  }
}
