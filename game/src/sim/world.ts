// The simulation state and its fixed-step update. Pure TypeScript: no DOM, no timers, no
// transcendental Math, iteration in slot order. Runs unchanged in the worker and in Node tests.
//
// Step order (one tick = 0.1 s):
//   1 commands   2 alien spawns   3 grids and flow fields (within a rebuild budget)
//   4 income     5 turret target acquisition   6 energy upkeep (beams, shields, machines)
//   7 conveyors and machines   8 units (move, build, reclaim)   9 construction drain
//   10 turrets fire   11 projectiles   12 aliens move and attack   13 deaths, wrecks
//   14 shields, wreck decay, temporary turrets   15 statistics

import {
  ALIEN_FIELDS,
  BF_COMPLETE,
  BF_UPGRADING,
  BUILDING_FIELDS,
  PROJECTILE_FIELDS,
  UNIT_FIELDS,
  US_IDLE,
  WRECK_FIELDS,
} from './schema.ts';
import { Table } from './table.ts';
import { Rng } from './rng.ts';
import {
  ALIEN_KINDS,
  B,
  BUILDING_KINDS,
  CATEGORY_COUNT,
  CAT_COMMANDER,
  CAT_DEFENCES,
  CAT_ECONOMY,
  CAT_STRUCTURES,
  COMMANDER_INCOME,
  SPAWN_INTERVAL_TICKS,
  START_STOCK,
  U,
  alienInfo,
  buildingInfo,
  isBelt,
  unitInfo,
  type Cost,
} from './kinds.ts';
import { TILE_GROUND, TILE_MASS, TILE_RARE, TILE_ROCK, map1Terrain, tileAt, type Terrain } from './terrain.ts';
import { FlowField } from './flowfield.ts';
import { Pathfinder } from './pathfind.ts';
import type { Command, StampedCommand } from './commands.ts';
import { stepEconomyIncome, stepUpkeep, stepConstruction } from './economy.ts';
import { stepConveyors } from './conveyor.ts';
import { acquireTargets, fireTurrets, stepProjectiles, stepShieldsAndTimers, AlienGrid } from './combat.ts';
import { stepAliens } from './aliens.ts';
import { stepUnits, type Order } from './units.ts';

export const CAPACITY = { buildings: 4096, aliens: 4096, units: 256, wrecks: 4096, projectiles: 4096 } as const;

/** Resolved goal set of a flow field. */
export const GOAL_TURRETS = 0;
export const GOAL_STRUCTURES = 1;
export const GOAL_ECONOMY = 2;
export const GOAL_COMMANDER = 3;

export interface Route {
  entry: number;
  category: number;
  cells: number[];
}

interface PendingGroup {
  kind: number;
  entry: number;
  left: number;
  nextTick: number;
}

export interface DebugFlags {
  /** Wall tiers 2 and 3 without research (research arrives in M3). */
  allTiers: boolean;
  /** Stress scene: buildings and units never drop below 1 hp. */
  indestructible: boolean;
  /** Stress scene: a killed alien is replaced at a random entry. */
  respawnAliens: boolean;
}

/** Extra flow-field cost of a building tile: +20 plus one per 10 hit points; belts +2. */
export function buildingPathCost(kind: number, hp: number): number {
  if (isBelt(kind)) return 2;
  return 20 + Math.round(hp / 10);
}

export class World {
  readonly terrain: Terrain;
  readonly rng: Rng;
  readonly seed: number;
  /** Ticks completed. The next step() executes tick number `tick`. */
  tick = 0;
  readonly buildings = new Table(BUILDING_FIELDS, CAPACITY.buildings);
  readonly aliens = new Table(ALIEN_FIELDS, CAPACITY.aliens);
  readonly units = new Table(UNIT_FIELDS, CAPACITY.units);
  readonly wrecks = new Table(WRECK_FIELDS, CAPACITY.wrecks);
  readonly projectiles = new Table(PROJECTILE_FIELDS, CAPACITY.projectiles);
  /** Building slot + 1 per tile; 0 = free. */
  readonly occupancy: Int32Array;

  // ---- economy ----
  /** mass, energy, rare. No storage cap (W12: caps change little). */
  readonly pool = new Float64Array(3);
  parts = 0;
  /** Last tick's income and smoothed spend, per second. */
  readonly incomeRate = new Float64Array(3);
  readonly spendRate = new Float64Array(3);
  /** This tick's spend (reset each tick). */
  readonly spendTick = new Float64Array(3);
  /** Energy upkeep ratio this tick: 1 = every energy consumer fully supplied. */
  upkeep = 1;
  /** Lowest supply ratio among active builds this tick (1 = none slowed). */
  buildEff = 1;
  /** Bit k set: resource k was short this tick (builds slowed, or energy upkeep below 1). */
  shortMask = 0;

  // ---- counters ----
  kills = 0;
  salvageFromKills = 0;
  salvageReclaimed = 0;
  salvageDelivered = 0;
  partsMade = 0;
  partsUsed = 0;
  /** 0 playing, 1 lost (commander destroyed). */
  outcome = 0;
  commanderId = -1;

  // ---- orders and paths (per unit slot) ----
  readonly orders: Order[][] = [];
  readonly paths: Array<number[] | null> = [];
  readonly pathPos: number[] = [];
  readonly pathKey: string[] = [];
  readonly pathfinder: Pathfinder;
  /** Build power delivered to each building slot this tick, and builder count. */
  readonly buildPower: Float64Array;
  readonly builderCount: Uint8Array;

  // ---- grids, flow fields and routes ----
  /** Entering cost per tile for normal and wall-bypassing aliens; -1 = rock. */
  readonly cost: Int32Array;
  readonly costBypass: Int32Array;
  /** 1 where a diagonal may pass (no rock, no solid building). */
  readonly open: Uint8Array;
  /** 1 where a player unit may stand. */
  readonly walk: Uint8Array;
  readonly fields: FlowField[];
  readonly fieldGoal = new Int8Array(CATEGORY_COUNT);
  readonly fieldDirty = new Uint8Array(CATEGORY_COUNT).fill(1);
  gridsDirty = true;
  /** A building took damage since the last cost refresh. */
  costDrift = false;
  private lastCostRefresh = 0;
  private lastCommanderCell = -1;
  private lastCommanderRebuild = -100;
  routes: Route[] = [];
  routesVersion = 0;
  /** Flow-field rebuilds so far (diagnostics). */
  fieldBuilds = 0;

  // ---- conveyors ----
  beltOrder: Int32Array = new Int32Array(0);
  beltsDirty = true;

  readonly alienGrid: AlienGrid;
  private pending: PendingGroup[] = [];

  /** Commands waiting for their tick, kept sorted by (tick, seq). */
  private queue: StampedCommand[] = [];
  private seq = 0;
  /** Every command applied so far, in order. The replay log for checkpoints and saves. */
  readonly log: StampedCommand[] = [];

  readonly debug: DebugFlags = { allTiers: true, indestructible: false, respawnAliens: false };

  constructor(seed: number, terrain: Terrain = map1Terrain()) {
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.terrain = terrain;
    const n = terrain.w * terrain.h;
    this.occupancy = new Int32Array(n);
    this.cost = new Int32Array(n);
    this.costBypass = new Int32Array(n);
    this.open = new Uint8Array(n);
    this.walk = new Uint8Array(n);
    this.fields = Array.from({ length: CATEGORY_COUNT }, () => new FlowField(terrain.w, terrain.h));
    this.pathfinder = new Pathfinder(terrain.w, terrain.h);
    this.buildPower = new Float64Array(CAPACITY.buildings);
    this.builderCount = new Uint8Array(CAPACITY.buildings);
    this.alienGrid = new AlienGrid(terrain.w, terrain.h, CAPACITY.aliens);
    this.pool.set(START_STOCK);
  }

  get pendingSpawns(): number {
    let n = 0;
    for (const p of this.pending) n += p.left;
    return n;
  }

  /** Queue a command for `atTick` (default: the next tick to run). Late stamps run next tick. */
  enqueue(cmd: Command, atTick = this.tick): StampedCommand {
    const s: StampedCommand = { tick: Math.max(atTick, this.tick), seq: this.seq++, cmd };
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1]!.tick > s.tick) i--;
    this.queue.splice(i, 0, s);
    return s;
  }

  step(): void {
    while (this.queue.length && this.queue[0]!.tick <= this.tick) {
      const s = this.queue.shift()!;
      this.apply(s.cmd);
      this.log.push(s);
    }
    this.spendTick.fill(0);
    this.stepSpawns();
    this.updateGridsAndFields();
    stepEconomyIncome(this);
    acquireTargets(this);
    stepUpkeep(this);
    stepConveyors(this);
    stepUnits(this);
    stepConstruction(this);
    fireTurrets(this);
    stepProjectiles(this);
    stepAliens(this);
    this.removeDead();
    stepShieldsAndTimers(this);
    for (let k = 0; k < 3; k++) this.spendRate[k] = this.spendRate[k]! * 0.9 + this.spendTick[k]! * 10 * 0.1;
    this.tick++;
  }

  // ---- commands ----------------------------------------------------------------------------

  private apply(cmd: Command): void {
    switch (cmd.t) {
      case 'move': {
        const n = cmd.ids.length;
        const side = Math.ceil(Math.sqrt(n));
        let k = 0;
        for (const id of cmd.ids) {
          const slot = this.units.slotForId(id);
          if (slot < 0) continue;
          const ox = n > 1 ? ((k % side) - (side - 1) / 2) * 1.5 : 0;
          const oz = n > 1 ? (Math.floor(k / side) - (side - 1) / 2) * 1.5 : 0;
          k++;
          this.giveOrder(slot, { t: 'move', x: this.clampX(cmd.x + ox), z: this.clampZ(cmd.z + oz) }, cmd.queue ?? false);
        }
        break;
      }
      case 'build': {
        const site = this.placeBuilding(cmd.kind, cmd.tx, cmd.ty, false, cmd.dir ?? 0);
        if (site < 0) break;
        for (const id of cmd.ids) {
          const slot = this.units.slotForId(id);
          if (slot >= 0) this.giveOrder(slot, { t: 'build', id: site }, cmd.queue ?? false);
        }
        break;
      }
      case 'assist': {
        const b = this.buildings.slotForId(cmd.target);
        if (b < 0) break;
        for (const id of cmd.ids) {
          const slot = this.units.slotForId(id);
          if (slot >= 0) this.giveOrder(slot, { t: 'build', id: cmd.target }, cmd.queue ?? false);
        }
        break;
      }
      case 'upgrade': {
        const b = this.buildings.slotForId(cmd.target);
        if (b < 0 || !this.startUpgrade(b)) break;
        for (const id of cmd.ids) {
          const slot = this.units.slotForId(id);
          if (slot >= 0) this.giveOrder(slot, { t: 'build', id: cmd.target }, cmd.queue ?? false);
        }
        break;
      }
      case 'reclaim': {
        if (this.wrecks.slotForId(cmd.wreck) < 0) break;
        for (const id of cmd.ids) {
          const slot = this.units.slotForId(id);
          if (slot >= 0 && this.units.cols.kind[slot] === U.engineer)
            this.giveOrder(slot, { t: 'reclaim', id: cmd.wreck, phase: 0, x: 0, z: 0 }, cmd.queue ?? false);
        }
        break;
      }
      case 'stop':
        for (const id of cmd.ids) {
          const slot = this.units.slotForId(id);
          if (slot >= 0) {
            this.orders[slot] = [];
            this.paths[slot] = null;
            this.units.cols.state[slot] = US_IDLE;
          }
        }
        break;
      case 'dropTurret':
        this.dropTempTurret(cmd.id);
        break;
      case 'spawn':
        this.pending.push({ kind: cmd.kind, entry: cmd.entry, left: cmd.count, nextTick: this.tick });
        break;
      case 'place':
        this.placeBuilding(cmd.kind, cmd.tx, cmd.ty, true, cmd.dir ?? 0);
        break;
    }
  }

  giveOrder(slot: number, order: Order, queue: boolean): void {
    if (!this.orders[slot]) this.orders[slot] = [];
    if (!queue) {
      this.orders[slot] = [];
      this.paths[slot] = null;
    }
    if (this.orders[slot]!.length < 32) this.orders[slot]!.push(order);
  }

  clampX(x: number) {
    return x < 0.5 ? 0.5 : x > this.terrain.w - 0.5 ? this.terrain.w - 0.5 : x;
  }
  clampZ(z: number) {
    return z < 0.5 ? 0.5 : z > this.terrain.h - 0.5 ? this.terrain.h - 0.5 : z;
  }

  // ---- buildings ---------------------------------------------------------------------------

  /** True if a building of `kind` may stand with its footprint origin at (tx, ty). */
  canPlace(kind: number, tx: number, ty: number): boolean {
    return canPlaceOn(this.terrain, this.occupancy, kind, tx, ty);
  }

  /** Places a building or a construction site; returns its id, or -1 if the footprint is not free. */
  placeBuilding(kind: number, tx: number, ty: number, complete: boolean, dir = 0): number {
    if (!this.canPlace(kind, tx, ty)) return -1;
    const b = this.buildings;
    const slot = b.create();
    const info = buildingInfo(kind);
    const c = b.cols;
    c.kind[slot] = kind;
    c.tier[slot] = 1;
    c.dir[slot] = dir & 3;
    c.tx[slot] = tx;
    c.ty[slot] = ty;
    c.maxHp[slot] = info.hp;
    c.hp[slot] = complete ? info.hp : info.hp * 0.1;
    c.progress[slot] = complete ? 1 : 0;
    c.flags[slot] = complete ? BF_COMPLETE : 0;
    c.moved[slot] = -1;
    if (kind === B.tempTurret) c.life[slot] = 30;
    const w = this.terrain.w;
    for (let j = 0; j < info.size; j++) for (let i = 0; i < info.size; i++) this.occupancy[(ty + j) * w + tx + i] = slot + 1;
    this.structureChanged();
    return b.id(slot);
  }

  removeBuilding(slot: number): void {
    const c = this.buildings.cols;
    const size = buildingInfo(c.kind[slot]!).size;
    const w = this.terrain.w;
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) this.occupancy[(c.ty[slot]! + j) * w + c.tx[slot]! + i] = 0;
    this.buildings.remove(slot);
    this.structureChanged();
  }

  structureChanged(): void {
    this.gridsDirty = true;
    this.beltsDirty = true;
    this.fieldDirty.fill(1);
  }

  /** Marks a complete wall for upgrade to the next tier. False if not allowed. */
  startUpgrade(slot: number): boolean {
    const c = this.buildings.cols;
    const info = buildingInfo(c.kind[slot]!);
    if (!info.tiers || !(c.flags[slot]! & BF_COMPLETE)) return false;
    if (c.flags[slot]! & BF_UPGRADING) return true;
    if (c.tier[slot]! > info.tiers.length) return false;
    if (!this.debug.allTiers) return false; // research gating arrives in M3
    c.flags[slot] = c.flags[slot]! | BF_UPGRADING;
    c.progress[slot] = 0;
    return true;
  }

  /** Cost and BP·s of the work outstanding on a site: construction or an upgrade. */
  workOf(slot: number): { cost: Cost; time: number } {
    const c = this.buildings.cols;
    const info = buildingInfo(c.kind[slot]!);
    if (c.flags[slot]! & BF_UPGRADING) {
      const t = info.tiers![c.tier[slot]! - 1]!;
      return { cost: t.cost, time: t.time };
    }
    return { cost: info.cost, time: info.buildTime };
  }

  private dropTempTurret(unitId: number): void {
    const u = this.units.slotForId(unitId);
    if (u < 0 || this.units.cols.kind[u] !== U.engineer || this.units.cols.cooldown[u]! > 0) return;
    const x0 = Math.floor(this.units.cols.x[u]!);
    const z0 = Math.floor(this.units.cols.z[u]!);
    for (let r = 0; r <= 2; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (this.placeBuilding(B.tempTurret, x0 + dx, z0 + dz, true) >= 0) {
            this.units.cols.cooldown[u] = 75;
            return;
          }
        }
      }
    }
  }

  // ---- spawning ----------------------------------------------------------------------------

  spawnAlien(kind: number, x: number, z: number): number {
    const a = this.aliens;
    const slot = a.create();
    const c = a.cols;
    c.kind[slot] = kind;
    c.x[slot] = x;
    c.z[slot] = z;
    c.fx[slot] = 1;
    c.fz[slot] = 0;
    c.hp[slot] = alienInfo(kind).hp;
    c.ox[slot] = this.rng.range(-0.3, 0.3);
    c.oz[slot] = this.rng.range(-0.3, 0.3);
    c.goalX[slot] = x;
    c.goalZ[slot] = z;
    return a.id(slot);
  }

  spawnUnit(kind: number, x: number, z: number): number {
    const u = this.units;
    const slot = u.create();
    const c = u.cols;
    c.kind[slot] = kind;
    c.x[slot] = x;
    c.z[slot] = z;
    c.fx[slot] = 0;
    c.fz[slot] = -1;
    c.hp[slot] = unitInfo(kind).hp;
    c.state[slot] = US_IDLE;
    this.orders[slot] = [];
    this.paths[slot] = null;
    this.pathPos[slot] = 0;
    this.pathKey[slot] = '';
    const id = u.id(slot);
    if (kind === U.commander) this.commanderId = id;
    return id;
  }

  /** Commander slot, or -1 if dead. */
  commanderSlot(): number {
    return this.commanderId < 0 ? -1 : this.units.slotForId(this.commanderId);
  }

  private stepSpawns(): void {
    for (const p of this.pending) {
      if (p.left <= 0 || this.tick < p.nextTick) continue;
      const e = this.terrain.entries[p.entry] ?? this.terrain.entries[0]!;
      const side = this.rng.range(-3, 3);
      // Spread along the edge, perpendicular to the entry direction.
      const x = this.clampX(e.x + e.dirX * 1.5 + e.dirZ * side);
      const z = this.clampZ(e.z + e.dirZ * 1.5 + e.dirX * side);
      this.spawnAlien(p.kind, x, z);
      p.left--;
      p.nextTick = this.tick + Math.max(1, SPAWN_INTERVAL_TICKS[ALIEN_KINDS[p.kind]!]);
    }
    if (this.pending.length && this.pending.every((p) => p.left <= 0)) this.pending = [];
  }

  // ---- grids and flow fields ---------------------------------------------------------------

  private rebuildGrids(): void {
    const t = this.terrain;
    const bc = this.buildings.cols;
    for (let i = 0; i < t.w * t.h; i++) {
      if (t.tiles[i] === TILE_ROCK) {
        this.cost[i] = -1;
        this.costBypass[i] = -1;
        this.open[i] = 0;
        this.walk[i] = 0;
        continue;
      }
      const occ = this.occupancy[i]! - 1;
      if (occ < 0) {
        this.cost[i] = 10;
        this.costBypass[i] = 10;
        this.open[i] = 1;
        this.walk[i] = 1;
        continue;
      }
      const kind = bc.kind[occ]!;
      const extra = buildingPathCost(kind, bc.hp[occ]!);
      const floor = isBelt(kind);
      this.cost[i] = 10 + extra;
      this.costBypass[i] = 10 + (floor ? extra : extra * 4);
      this.open[i] = floor ? 1 : 0;
      this.walk[i] = floor ? 1 : 0;
    }
    this.gridsDirty = false;
    this.costDrift = false;
    this.lastCostRefresh = this.tick;
  }

  /** Which building kinds a category's alien treats as goals, after the W12 fallback rule. */
  isGoalBuilding(category: number, kind: number): boolean {
    const g = this.fieldGoal[category]!;
    const role = buildingInfo(kind).role;
    if (g === GOAL_TURRETS) return role === 'defence';
    if (g === GOAL_STRUCTURES) return role === 'defence' || role === 'wall';
    if (g === GOAL_ECONOMY) return role === 'economy' || role === 'chain' || role === 'floor';
    return false;
  }

  private goalCells(goal: number, out: number[]): void {
    out.length = 0;
    if (goal === GOAL_COMMANDER) {
      const s = this.commanderSlot();
      if (s >= 0) {
        const x = Math.floor(this.units.cols.x[s]!);
        const z = Math.floor(this.units.cols.z[s]!);
        out.push(z * this.terrain.w + x);
      } else {
        out.push(Math.floor(this.terrain.base.z) * this.terrain.w + Math.floor(this.terrain.base.x));
      }
      return;
    }
    for (let i = 0; i < this.occupancy.length; i++) {
      const occ = this.occupancy[i]! - 1;
      if (occ < 0) continue;
      const role = buildingInfo(this.buildings.cols.kind[occ]!).role;
      const ok =
        goal === GOAL_TURRETS ? role === 'defence' : goal === GOAL_STRUCTURES ? role === 'defence' || role === 'wall' : role === 'economy' || role === 'chain' || role === 'floor';
      if (ok) out.push(i);
    }
  }

  /** Fallback order per category (W12: turrets, then economy, then the commander). */
  private static readonly FALLBACK: number[][] = [
    [GOAL_COMMANDER],
    [GOAL_TURRETS, GOAL_ECONOMY, GOAL_COMMANDER],
    [GOAL_STRUCTURES, GOAL_ECONOMY, GOAL_COMMANDER],
    [GOAL_ECONOMY, GOAL_COMMANDER],
  ];
  private readonly goalScratch: number[] = [];

  /** Rebuilds one category's field now (tests call this directly). */
  rebuildField(cat: number): void {
    if (this.gridsDirty) this.rebuildGrids();
    const cells = this.goalScratch;
    for (const g of World.FALLBACK[cat]!) {
      this.goalCells(g, cells);
      this.fieldGoal[cat] = g;
      if (cells.length) break;
    }
    const bypass = cat === CAT_COMMANDER || cat === CAT_ECONOMY;
    this.fields[cat]!.build(bypass ? this.costBypass : this.cost, this.open, cells, cells.length);
    this.fields[cat]!.builtAt = this.tick;
    this.fieldDirty[cat] = 0;
    this.fieldBuilds++;
  }

  /** Up to two field rebuilds per tick; the commander field follows the commander every 5 ticks. */
  private updateGridsAndFields(): void {
    if (this.costDrift && this.tick - this.lastCostRefresh >= 30) {
      this.gridsDirty = true;
      this.fieldDirty.fill(1);
    }
    if (this.gridsDirty) this.rebuildGrids();
    const cs = this.commanderSlot();
    if (cs >= 0) {
      const cell = Math.floor(this.units.cols.z[cs]!) * this.terrain.w + Math.floor(this.units.cols.x[cs]!);
      if (cell !== this.lastCommanderCell && this.tick - this.lastCommanderRebuild >= 5) {
        this.lastCommanderCell = cell;
        this.lastCommanderRebuild = this.tick;
        for (let c = 0; c < CATEGORY_COUNT; c++) if (this.fieldGoal[c] === GOAL_COMMANDER || c === CAT_COMMANDER) this.fieldDirty[c] = 1;
      }
    }
    let budget = 2;
    let rebuilt = false;
    for (let c = 0; c < CATEGORY_COUNT && budget > 0; c++) {
      if (!this.fieldDirty[c]) continue;
      this.rebuildField(c);
      budget--;
      rebuilt = true;
    }
    if (rebuilt) this.computeRoutes();
  }

  /** The predicted route of each category's aliens from each entry point. */
  computeRoutes(): void {
    const t = this.terrain;
    const routes: Route[] = [];
    t.entries.forEach((e, ei) => {
      const cell = Math.min(t.h - 1, Math.floor(e.z)) * t.w + Math.min(t.w - 1, Math.floor(e.x));
      for (let c = 0; c < CATEGORY_COUNT; c++) routes.push({ entry: ei, category: c, cells: this.fields[c]!.trace(cell, 600) });
    });
    this.routes = routes;
    this.routesVersion++;
  }

  // ---- deaths ------------------------------------------------------------------------------

  private removeDead(): void {
    const a = this.aliens;
    const ac = a.cols;
    for (let s = 0; s < a.highWater; s++) {
      if (!a.alive[s] || ac.hp[s]! > 0) continue;
      const kind = ac.kind[s]!;
      const info = alienInfo(kind);
      if (this.wrecks.count < this.wrecks.capacity) {
        const w = this.wrecks.create();
        this.wrecks.cols.kind[w] = kind;
        this.wrecks.cols.x[w] = ac.x[s]!;
        this.wrecks.cols.z[w] = ac.z[s]!;
        this.wrecks.cols.salvage[w] = info.salvage;
      }
      this.kills++;
      this.salvageFromKills += info.salvage;
      a.remove(s);
      if (this.debug.respawnAliens) {
        const e = this.terrain.entries[this.rng.int(this.terrain.entries.length)]!;
        this.spawnAlien(kind, this.clampX(e.x + e.dirX * 2 + this.rng.range(-4, 4) * e.dirZ), this.clampZ(e.z + e.dirZ * 2 + this.rng.range(-4, 4) * e.dirX));
      }
    }
    const b = this.buildings;
    const bc = b.cols;
    for (let s = 0; s < b.highWater; s++) {
      if (!b.alive[s] || bc.hp[s]! > 0) continue;
      if (this.debug.indestructible) {
        bc.hp[s] = 1;
        continue;
      }
      this.removeBuilding(s);
    }
    const u = this.units;
    for (let s = 0; s < u.highWater; s++) {
      if (!u.alive[s] || u.cols.hp[s]! > 0) continue;
      if (this.debug.indestructible) {
        u.cols.hp[s] = 1;
        continue;
      }
      if (u.cols.kind[s] === U.commander) this.outcome = 1;
      u.remove(s);
      this.orders[s] = [];
      this.paths[s] = null;
    }
  }
}

/** Placement rule shared by the simulation and the render thread's ghost preview. */
export function canPlaceOn(terrain: Terrain, occupancy: Int32Array, kind: number, tx: number, ty: number): boolean {
  const name = BUILDING_KINDS[kind];
  if (!name) return false;
  const size = buildingInfo(kind).size;
  const need = kind === B.massExtractor ? TILE_MASS : kind === B.rareExtractor ? TILE_RARE : TILE_GROUND;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = tx + i;
      const y = ty + j;
      if (tileAt(terrain, x, y) !== need) return false;
      if (occupancy[y * terrain.w + x] !== 0) return false;
    }
  }
  return true;
}

export { CAT_COMMANDER, CAT_DEFENCES, CAT_STRUCTURES, CAT_ECONOMY, COMMANDER_INCOME };
