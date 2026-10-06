// The simulation state and its fixed-step update. Pure TypeScript: no DOM, no timers, no
// transcendental Math, iteration in slot order. Runs unchanged in the worker and in Node tests.

import { ALIEN_FIELDS, BUILDING_FIELDS, BUILDING_FLAG_COMPLETE, UNIT_FIELDS, UNIT_IDLE, UNIT_MOVING } from './schema.ts';
import { Table } from './table.ts';
import { Rng } from './rng.ts';
import { B, BUILDING_INFO, BUILDING_KINDS, alienInfo, unitInfo } from './kinds.ts';
import { TILE_GROUND, TILE_MASS, TILE_RARE, TILE_ROCK, map1Terrain, tileAt, type Terrain } from './terrain.ts';
import type { Command, StampedCommand } from './commands.ts';

export const CAPACITY = { buildings: 4096, aliens: 4096, units: 256 } as const;

export class World {
  readonly terrain: Terrain;
  readonly rng: Rng;
  readonly seed: number;
  /** Ticks completed. The next step() executes tick number `tick`. */
  tick = 0;
  readonly buildings = new Table(BUILDING_FIELDS, CAPACITY.buildings);
  readonly aliens = new Table(ALIEN_FIELDS, CAPACITY.aliens);
  readonly units = new Table(UNIT_FIELDS, CAPACITY.units);
  /** Building slot + 1 per tile; 0 = free. */
  readonly occupancy: Int32Array;
  /** Commands waiting for their tick, kept sorted by (tick, seq). */
  private pending: StampedCommand[] = [];
  private seq = 0;
  /** Every command applied so far, in order. The replay log for checkpoints and saves. */
  readonly log: StampedCommand[] = [];

  constructor(seed: number, terrain: Terrain = map1Terrain()) {
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.terrain = terrain;
    this.occupancy = new Int32Array(terrain.w * terrain.h);
  }

  /** Queue a command for `atTick` (default: the next tick to run). Late stamps run next tick. */
  enqueue(cmd: Command, atTick = this.tick): StampedCommand {
    const s: StampedCommand = { tick: Math.max(atTick, this.tick), seq: this.seq++, cmd };
    let i = this.pending.length;
    while (i > 0 && (this.pending[i - 1]!.tick > s.tick)) i--;
    this.pending.splice(i, 0, s);
    return s;
  }

  step(): void {
    while (this.pending.length && this.pending[0]!.tick <= this.tick) {
      const s = this.pending.shift()!;
      this.apply(s.cmd);
      this.log.push(s);
    }
    this.stepUnits();
    this.stepAliens();
    this.tick++;
  }

  // ---- commands ----------------------------------------------------------------------------

  private apply(cmd: Command): void {
    switch (cmd.t) {
      case 'move': {
        const { units } = this;
        const n = cmd.ids.length;
        const side = Math.ceil(Math.sqrt(n));
        let k = 0;
        for (const id of cmd.ids) {
          const slot = units.slotForId(id);
          if (slot < 0) continue;
          // Spread a group on a small grid round the target so units do not stack.
          const ox = n > 1 ? ((k % side) - (side - 1) / 2) * 1.5 : 0;
          const oz = n > 1 ? (Math.floor(k / side) - (side - 1) / 2) * 1.5 : 0;
          k++;
          units.cols.goalX[slot] = this.clampX(cmd.x + ox);
          units.cols.goalZ[slot] = this.clampZ(cmd.z + oz);
          units.cols.state[slot] = UNIT_MOVING;
        }
        break;
      }
      case 'place':
        this.placeBuilding(cmd.kind, cmd.tx, cmd.ty, true);
        break;
    }
  }

  private clampX(x: number) {
    return x < 0.5 ? 0.5 : x > this.terrain.w - 0.5 ? this.terrain.w - 0.5 : x;
  }
  private clampZ(z: number) {
    return z < 0.5 ? 0.5 : z > this.terrain.h - 0.5 ? this.terrain.h - 0.5 : z;
  }

  // ---- spawning ----------------------------------------------------------------------------

  /** True if a building of `kind` may stand with its footprint origin at (tx, ty). */
  canPlace(kind: number, tx: number, ty: number): boolean {
    const name = BUILDING_KINDS[kind];
    if (!name) return false;
    const size = BUILDING_INFO[name].size;
    const need = kind === B.massExtractor ? TILE_MASS : kind === B.rareExtractor ? TILE_RARE : TILE_GROUND;
    const t = this.terrain;
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const x = tx + i;
        const y = ty + j;
        const tile = tileAt(t, x, y);
        if (tile === TILE_ROCK || tile !== need) return false;
        if (this.occupancy[y * t.w + x] !== 0) return false;
      }
    }
    return true;
  }

  /** Places a building; returns its id, or -1 if the footprint is not free. */
  placeBuilding(kind: number, tx: number, ty: number, complete: boolean): number {
    if (!this.canPlace(kind, tx, ty)) return -1;
    const b = this.buildings;
    const slot = b.create();
    const info = BUILDING_INFO[BUILDING_KINDS[kind]!];
    b.cols.kind[slot] = kind;
    b.cols.tx[slot] = tx;
    b.cols.ty[slot] = ty;
    b.cols.hp[slot] = info.hp;
    b.cols.progress[slot] = complete ? 1 : 0;
    b.cols.flags[slot] = complete ? BUILDING_FLAG_COMPLETE : 0;
    const w = this.terrain.w;
    for (let j = 0; j < info.size; j++) for (let i = 0; i < info.size; i++) this.occupancy[(ty + j) * w + tx + i] = slot + 1;
    return b.id(slot);
  }

  spawnAlien(kind: number, x: number, z: number): number {
    const a = this.aliens;
    const slot = a.create();
    a.cols.kind[slot] = kind;
    a.cols.x[slot] = x;
    a.cols.z[slot] = z;
    a.cols.fx[slot] = 1;
    a.cols.fz[slot] = 0;
    a.cols.hp[slot] = alienInfo(kind).hp;
    a.cols.goalX[slot] = x;
    a.cols.goalZ[slot] = z;
    return a.id(slot);
  }

  spawnUnit(kind: number, x: number, z: number): number {
    const u = this.units;
    const slot = u.create();
    u.cols.kind[slot] = kind;
    u.cols.x[slot] = x;
    u.cols.z[slot] = z;
    u.cols.fx[slot] = 0;
    u.cols.fz[slot] = -1;
    u.cols.hp[slot] = unitInfo(kind).hp;
    u.cols.state[slot] = UNIT_IDLE;
    return u.id(slot);
  }

  // ---- movement ----------------------------------------------------------------------------

  private stepUnits(): void {
    const u = this.units;
    const c = u.cols;
    for (let s = 0; s < u.highWater; s++) {
      if (!u.alive[s] || c.state[s] !== UNIT_MOVING) continue;
      const speed = unitInfo(c.kind[s]!).speed;
      const dx = c.goalX[s]! - c.x[s]!;
      const dz = c.goalZ[s]! - c.z[s]!;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d <= speed) {
        c.x[s] = c.goalX[s]!;
        c.z[s] = c.goalZ[s]!;
        c.state[s] = UNIT_IDLE;
        continue;
      }
      c.fx[s] = dx / d;
      c.fz[s] = dz / d;
      c.x[s] = c.x[s]! + c.fx[s]! * speed;
      c.z[s] = c.z[s]! + c.fz[s]! * speed;
    }
  }

  /** M1 placeholder behaviour: each alien walks to a random nearby point, then picks another. */
  private stepAliens(): void {
    const a = this.aliens;
    const c = a.cols;
    const t = this.terrain;
    for (let s = 0; s < a.highWater; s++) {
      if (!a.alive[s]) continue;
      const speed = alienInfo(c.kind[s]!).speed;
      const dx = c.goalX[s]! - c.x[s]!;
      const dz = c.goalZ[s]! - c.z[s]!;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d <= speed) {
        this.pickWanderGoal(s);
        continue;
      }
      const fx = dx / d;
      const fz = dz / d;
      const nx = c.x[s]! + fx * speed;
      const nz = c.z[s]! + fz * speed;
      if (tileAt(t, Math.floor(nx), Math.floor(nz)) === TILE_ROCK) {
        this.pickWanderGoal(s);
        continue;
      }
      c.fx[s] = fx;
      c.fz[s] = fz;
      c.x[s] = nx;
      c.z[s] = nz;
    }
  }

  private pickWanderGoal(s: number): void {
    const c = this.aliens.cols;
    c.goalX[s] = this.clampX(c.x[s]! + this.rng.range(-16, 16));
    c.goalZ[s] = this.clampZ(c.z[s]! + this.rng.range(-16, 16));
  }
}
