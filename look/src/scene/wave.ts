// A wave of aliens advancing down the north and east canyons towards the walls. Each alien walks
// its path with a lateral offset, follows the ground (height and tilt from the heightfield) and
// advances its gait with ground speed. Turrets damage them (scene/base.ts); damaged aliens burn,
// destroyed ones explode, sometimes leave a burning wreck, and respawn at the far end so the wave
// keeps coming. A few wrecks burn in the canyon from the start for the smoke plumes.

import { Group, Quaternion, Vector3 } from 'three';
import { Rand } from '../noise.ts';
import type { Particles } from '../fx/particles.ts';
import { Builder, cbox } from '../models/kit.ts';
import type { Mats } from '../models/materials.ts';
import type { ModelSource } from '../models/types.ts';
import { PATHS, heightAt } from '../world/heightfield.ts';
import type { AlienKind } from '../world/layout.ts';
import type { Target } from './base.ts';
import { ModelLayer, placeMatrix } from './modelLayer.ts';
import { part } from '../models/procedural/common.ts';

const SPEED: Record<AlienKind, number> = { rusher: 2.4, hunter: 4.4, breaker: 0.9, saboteur: 1.8 };
const HP: Record<AlienKind, number> = { rusher: 3, hunter: 2, breaker: 16, saboteur: 5 };
const SPREAD: Record<AlienKind, number> = { rusher: 6, hunter: 4, breaker: 3, saboteur: 5 };
const GAIT: Record<AlienKind, number> = { rusher: 5.5, hunter: 0, breaker: 0, saboteur: 0 };
/** Display scale: aliens are drawn larger than their sim radius so they read at RTS distance. */
export const ALIEN_DISPLAY_SCALE = 1.5;

const COMPOSITION: Array<{ path: 'north' | 'east'; kind: AlienKind; n: number }> = [
  { path: 'north', kind: 'rusher', n: 46 },
  { path: 'north', kind: 'hunter', n: 6 },
  { path: 'north', kind: 'breaker', n: 3 },
  { path: 'north', kind: 'saboteur', n: 4 },
  { path: 'east', kind: 'rusher', n: 34 },
  { path: 'east', kind: 'hunter', n: 4 },
  { path: 'east', kind: 'breaker', n: 3 },
  { path: 'east', kind: 'saboteur', n: 3 },
];

type Path = Array<{ x: number; z: number }>;

function pathLength(p: Path): number {
  let l = 0;
  for (let i = 0; i + 1 < p.length; i++) l += Math.hypot(p[i + 1]!.x - p[i]!.x, p[i + 1]!.z - p[i]!.z);
  return l;
}
function pathAt(p: Path, s: number): { x: number; z: number; dx: number; dz: number } {
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[i]!;
    const b = p[i + 1]!;
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    if (s <= l || i + 2 === p.length) {
      const t = Math.min(1, s / l);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: (b.x - a.x) / l, dz: (b.z - a.z) / l };
    }
    s -= l;
  }
  const a = p[p.length - 1]!;
  return { x: a.x, z: a.z, dx: 1, dz: 0 };
}

class Alien implements Target {
  pos = new Vector3();
  alive = true;
  hp: number;
  s: number;
  off: number;
  burning: ReturnType<Particles['addEmitter']>[] = [];
  constructor(
    readonly kind: AlienKind,
    readonly path: 'north' | 'east',
    readonly layer: ModelLayer,
    readonly index: number,
    s: number,
    off: number,
    private wave: Wave,
  ) {
    this.hp = HP[kind];
    this.s = s;
    this.off = off;
  }
  hit(damage: number, at: Vector3): void {
    if (!this.alive) return;
    this.hp -= damage;
    this.wave.fx.sparks(at.x, at.y, at.z, 8, 6);
    if (this.hp <= 0) this.wave.destroy(this);
    else if (this.hp < HP[this.kind] * 0.6 && this.burning.length === 0 && this.wave.burningCount() < 10) this.wave.ignite(this);
  }
}

export class Wave {
  readonly group = new Group();
  readonly aliens: Alien[] = [];
  private layers = new Map<AlienKind, ModelLayer>();
  private wrecks: ModelLayer;
  private wreckAge: number[] = [];
  private rnd = new Rand(1234);
  private lengths: Record<'north' | 'east', number>;

  constructor(
    src: ModelSource,
    mats: Mats,
    readonly fx: Particles,
  ) {
    this.lengths = { north: pathLength(PATHS.north), east: pathLength(PATHS.east) };
    const counts = new Map<AlienKind, number>();
    for (const c of COMPOSITION) counts.set(c.kind, (counts.get(c.kind) ?? 0) + c.n);
    for (const [k, n] of counts) {
      const l = new ModelLayer(src.alien(k), n, { dynamic: true });
      this.layers.set(k, l);
      this.group.add(l.group);
    }
    for (const c of COMPOSITION) {
      const layer = this.layers.get(c.kind)!;
      for (let i = 0; i < c.n; i++) {
        const idx = layer.add(placeMatrix(0, 0, 0, 0), this.rnd.next());
        const L = this.lengths[c.path];
        const a = new Alien(c.kind, c.path, layer, idx, L * (1 - Math.pow(this.rnd.next(), 1.7)) * 0.96, this.rnd.range(-1, 1) * SPREAD[c.kind], this);
        this.aliens.push(a);
      }
    }
    // wreck debris (code-built, scene-owned)
    const wb = new Builder(mats);
    const r = new Rand(5);
    for (let i = 0; i < 9; i++) wb.add(i % 3 ? 'hull' : 'trim', cbox(r.range(0.2, 0.7), r.range(0.1, 0.35), r.range(0.2, 0.6), 0.03), { x: r.range(-0.8, 0.8), y: r.range(-0.05, 0.15), z: r.range(-0.7, 0.7), ry: r.range(0, 3), rz: r.range(-0.5, 0.5), rx: r.range(-0.4, 0.4) });
    this.wrecks = new ModelLayer({ name: 'wreck', parts: [part('debris', wb)], radius: 1.2, height: 0.5 }, 16, { dynamic: true });
    this.group.add(this.wrecks.group);
    for (const [x, z, s] of [
      [64, -6, 1.6],
      [70, -32, 1.2],
      [128, 62, 1.5],
      [160, 70, 1.1],
      [58, 14, 1.0],
      [74, 26, 1.3],
      [104, 58, 1.2],
      [99, 38, 1.0],
    ] as const) this.addWreck(x, z, s, Infinity);
    this.placeAll(0);
  }

  burningCount(): number {
    return this.aliens.filter((a) => a.burning.length).length;
  }

  ignite(a: Alien): void {
    const follow = () => (a.alive ? a.pos.clone().setY(a.pos.y + a.layer.model.height * 0.7 * ALIEN_DISPLAY_SCALE) : null);
    a.burning.push(this.fx.addEmitter('fire', a.pos, a.kind === 'breaker' ? 0.9 : 0.5, follow));
    a.burning.push(this.fx.addEmitter('plume', a.pos, a.kind === 'breaker' ? 0.7 : 0.4, follow));
  }

  private addWreck(x: number, z: number, scale: number, life: number): void {
    let i = this.wreckAge.findIndex((age) => age <= 0);
    if (i < 0) {
      if (this.wrecks.states.length >= this.wrecks.capacity) return;
      i = this.wrecks.add(placeMatrix(0, 0, 0, 0));
      this.wreckAge.push(0);
    }
    const y = heightAt(x, z);
    this.wrecks.states[i]!.matrix.copy(placeMatrix(x, y, z, this.rnd.range(0, 6.28), [scale, scale, scale]));
    this.wrecks.states[i]!.visible = true;
    this.wrecks.markDirty();
    this.wreckAge[i] = life;
    const p = new Vector3(x, y + 0.3, z);
    const fire = this.fx.addEmitter('fire', p, scale * 0.8);
    const plume = this.fx.addEmitter('plume', p, scale);
    if (Number.isFinite(life)) {
      setTimeout(() => {
        this.fx.removeEmitter(fire);
        this.fx.removeEmitter(plume);
      }, life * 1000);
    }
  }

  destroy(a: Alien): void {
    a.alive = false;
    for (const e of a.burning) this.fx.removeEmitter(e);
    a.burning = [];
    const big = a.kind === 'breaker' ? 1.6 : a.kind === 'rusher' ? 0.7 : 1;
    this.fx.explosion(a.pos.x, a.pos.y, a.pos.z, big);
    if (a.kind === 'breaker' || this.rnd.next() < 0.25) this.addWreck(a.pos.x, a.pos.z, big * 0.8, 20);
    a.layer.states[a.index]!.visible = false;
    setTimeout(() => {
      a.alive = true;
      a.hp = HP[a.kind];
      a.s = this.lengths[a.path] * this.rnd.range(0.2, 0.5);
      a.off = this.rnd.range(-1, 1) * SPREAD[a.kind];
      a.layer.states[a.index]!.visible = true;
    }, 1500 + this.rnd.next() * 2000);
  }

  private placeAll(dt: number): void {
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const n = new Vector3();
    for (const a of this.aliens) {
      if (!a.alive) continue;
      const L = this.lengths[a.path];
      a.s += SPEED[a.kind] * dt;
      if (a.s >= L) {
        // reached the wall line: it attacks and is destroyed there
        this.destroy(a);
        continue;
      }
      const p = pathAt(PATHS[a.path], a.s);
      const wob = Math.sin(a.s * 0.15 + a.index) * 0.8;
      const x = p.x - p.dz * (a.off + wob);
      const z = p.z + p.dx * (a.off + wob);
      const y = heightAt(x, z);
      a.pos.set(x, y, z);
      const yaw = Math.atan2(-p.dz, p.dx);
      // tilt to the ground slope
      const e = 0.6;
      n.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
      q.setFromUnitVectors(up, n);
      const st = a.layer.states[a.index]!;
      const k = ALIEN_DISPLAY_SCALE;
      st.matrix.copy(placeMatrix(x, y, z, yaw, [k, k, k], q));
      st.phase += SPEED[a.kind] * dt * GAIT[a.kind];
    }
  }

  update(t: number, dt: number): void {
    this.placeAll(dt);
    for (let i = 0; i < this.wreckAge.length; i++) {
      if (!Number.isFinite(this.wreckAge[i]!)) continue;
      this.wreckAge[i]! -= dt;
      if (this.wreckAge[i]! <= 0 && this.wrecks.states[i]!.visible) {
        this.wrecks.states[i]!.visible = false;
        this.wrecks.markDirty();
      }
    }
    for (const l of this.layers.values()) l.update(t);
    this.wrecks.update(t);
  }
}
