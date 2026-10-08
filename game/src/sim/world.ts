// The simulation state and its fixed-step update. Pure TypeScript: no DOM, no timers, no
// transcendental Math, iteration in slot order. Runs unchanged in the worker and in Node tests.
//
// Step order (one tick = 0.1 s):
//   1 commands   2 alien spawns   3 grids and flow fields (within a rebuild budget)
//   4 income     5 turret target acquisition   6 energy upkeep (beams, shields, machines)
//   7 conveyors and machines   8 units (move, build, reclaim)   9 construction drain
//   10 turrets fire   11 projectiles   12 aliens move and attack   13 deaths, wrecks
//   14 shields, wreck decay, temporary turrets   15 statistics
// W24 adds: after the commands, the sandbox commander's respawn; after construction, finished
// wall runs are freed (runs.ts).
//
// Construction states (W24, schema.ts BF_STARTED): a site is reserved until build power first
// reaches it (holds its tiles against placement, blocks nobody, adds no flow cost; aliens may still
// make it their goal and shoot it, as in W13), then started (blocks units and aliens, flow cost at
// its current hit points), then complete. Any unit or alien
// on a tile the tick it becomes started is moved to the nearest free passable tile (startSite).

import {
  ALIEN_FIELDS,
  BF_COMPLETE,
  BF_STARTED,
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
import { validateCommand, upgradeProblem } from './validate.ts';
import { COMMANDER_WRECK_SALVAGE, RESEARCH, RESEARCH_INDEX, SANDBOX_RESPAWN_TICKS, callEarlyBonus, EXTRACTOR_BOOST, FIELD_ENG_TURRET_COOLDOWN } from './balance.ts';
import { map1 } from '../../../model/data/map1.ts';
import { START_ENGINEERS, TICK_HZ } from './kinds.ts';
import { TB_HP, TUNE_FIELDS, Tuning, alienMaxHp, resetTune, setTune, tuneFieldIndex, unitMaxHp, type TuneTarget } from './tuning.ts';
import { STAT_COUNT, recordKilled, recordSpawned } from './stats.ts';
import { RUN_CAPACITY, cancelRun, createRun, planRun, stepRuns, type WallRun } from './runs.ts';
import { gateBaseHp, gateBuildWork, gateDepth, gateFootprint, gateUpgradeWork, inGateCorridor, planGate } from './gate.ts';
import { WRECK_COMMANDER, applySpawnAt, clearAliens, clearWrecks, originRoutes, type SpawnOrigin } from './sandbox.ts';

/** Orders a unit can hold queued; more are refused (validate.ts) rather than dropped. */
export const MAX_ORDERS = 64;

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

/** Starting states (scenarios.ts). Stored on the world, in saves and in snapshots (W24). */
export const SCENARIO_NAMES = ['map1', 'stress', 'empty', 'sandbox'] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** True for a site no build power has reached yet (W24 construction state "reserved"). */
export const isReserved = (flags: number): boolean => (flags & (BF_STARTED | BF_COMPLETE)) === 0;

export interface PendingGroup {
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
  /** 0 playing, 1 lost (commander destroyed), 2 won (every wave destroyed). */
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
  /** Engineers in production this tick (filled by units, drained by construction). */
  readonly produceJobs: Array<{ order: { progress: number }; bp: number }> = [];

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
  lastCostRefresh = 0;
  lastCommanderCell = -1;
  lastCommanderRebuild = -100;
  routes: Route[] = [];
  routesVersion = 0;
  /** Flow-field rebuilds so far (diagnostics). */
  fieldBuilds = 0;

  // ---- conveyors ----
  beltOrder: Int32Array = new Int32Array(0);
  beltsDirty = true;

  readonly alienGrid: AlienGrid;
  pending: PendingGroup[] = [];

  /** Commands waiting for their tick, kept sorted by (tick, seq). */
  queue: StampedCommand[] = [];
  seq = 0;
  /** Every command applied so far, in order. The replay log for checkpoints and saves. */
  readonly log: StampedCommand[] = [];

  readonly debug: DebugFlags = { allTiers: false, indestructible: false, respawnAliens: false };

  // ---- waves (map 1's 20 fixed waves, W12 times) ----
  /** Start tick of each wave; calling a wave early moves it and every later wave forward. */
  readonly waveTicks: Int32Array;
  /** Index of the next wave to start (0..20). */
  nextWave = 0;
  lastWaveTick = -1;
  /** Ticks skipped by calling waves early, and the bonus paid for them. */
  skippedTicks = 0;
  readonly bonusPaid = new Float64Array(3);
  /** Tick the run ended (win or loss), -1 while playing. */
  endTick = -1;

  // ---- W24: scenario, sandbox, tuning, statistics, wall runs ----
  /** The starting state this world was made from; sandbox commands need 'sandbox'. */
  scenario: ScenarioName = 'empty';
  /** Sandbox free spending (setUnlimited). Income continues as normal. */
  unlimited = false;
  /** Sandbox per-kind multipliers (tuning.ts). */
  readonly tuning = new Tuning();
  /** Historical per-kind combat counters (stats.ts). */
  readonly stats = new Float64Array(STAT_COUNT);
  /** Wall run table (runs.ts): RUN_CAPACITY slots, null = free. */
  runs: Array<WallRun | null> = new Array<WallRun | null>(RUN_CAPACITY).fill(null);
  nextRunId = 1;
  /** Up to 8 recent sandbox spawn points, and the predicted route from each. */
  spawnOrigins: SpawnOrigin[] = [];
  originRoutes: Array<{ origin: number; category: number; cells: number[] }> = [];
  /** Sandbox: tick a new commander appears at the base, -1 when none is due. */
  commanderRespawnTick = -1;
  /** Sandbox: commanders lost (each one respawns). */
  commanderDeaths = 0;
  buildingsLost = 0;
  unitsLost = 0;

  // ---- research ----
  /** Bit i set: RESEARCH[i] done. Never cleared within a map. */
  researchDone = 0;
  researchQueue: number[] = [];
  researchCurrent = -1;
  /** Progress of the current node, 0..1. */
  researchProgress = 0;
  /** RP per second this tick (complete stations × W12 labRate). */
  researchRate = 0;
  /** Supply ratio the current research got last tick. */
  researchEff = 1;

  /** `waves: false` gives a world with no wave schedule (test maps, the sandbox). */
  constructor(seed: number, terrain: Terrain = map1Terrain(), opts: { waves?: boolean } = {}) {
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
    this.waveTicks = opts.waves === false ? new Int32Array(0) : Int32Array.from(map1.waves.map((wv) => Math.round(wv.at * TICK_HZ)));
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

  /**
   * Validates and queues a command. Returns the reason if it is refused (nothing is queued).
   * Use this for anything that comes from a player; enqueue() skips validation (tests, replays).
   */
  submit(cmd: Command, atTick = this.tick): string | null {
    const problem = validateCommand(this, cmd);
    if (problem) return problem;
    this.enqueue(cmd, atTick);
    return null;
  }

  /** True when the next step() starts a wave (the runner takes a checkpoint first). */
  waveDue(): boolean {
    return this.outcome === 0 && this.nextWave < this.waveTicks.length && this.tick >= this.waveTicks[this.nextWave]!;
  }

  researched(id: string): boolean {
    const i = RESEARCH_INDEX[id];
    return i !== undefined && (this.researchDone & (1 << i)) !== 0;
  }

  /** Commands applied this tick that were refused at apply time (state changed since validation). */
  readonly applyRejected: Array<{ tick: number; reason: string }> = [];

  step(): void {
    if (this.outcome !== 0) return; // the run is over: the state stays as it ended
    while (this.queue.length && this.queue[0]!.tick <= this.tick) {
      const s = this.queue.shift()!;
      const problem = validateCommand(this, s.cmd);
      if (problem) {
        this.applyRejected.push({ tick: this.tick, reason: problem });
        if (this.applyRejected.length > 50) this.applyRejected.shift();
      } else this.apply(s.cmd);
      this.log.push(s);
    }
    // Sandbox: the commander comes back at the base 10 s after it fell.
    if (this.commanderRespawnTick >= 0 && this.tick >= this.commanderRespawnTick) {
      this.commanderRespawnTick = -1;
      const { base } = this.terrain;
      this.spawnUnit(U.commander, base.x + 0.5, base.z + 0.5);
    }
    this.spendTick.fill(0);
    this.stepWaves();
    this.stepSpawns();
    this.updateGridsAndFields();
    stepEconomyIncome(this);
    acquireTargets(this);
    stepUpkeep(this);
    stepConveyors(this);
    stepUnits(this);
    stepConstruction(this);
    stepRuns(this);
    fireTurrets(this);
    stepProjectiles(this);
    stepAliens(this);
    this.removeDead();
    stepShieldsAndTimers(this);
    for (let k = 0; k < 3; k++) this.spendRate[k] = this.spendRate[k]! * 0.9 + this.spendTick[k]! * 10 * 0.1;
    // Win: every wave has arrived and been destroyed (map 1 is survive-only).
    if (this.outcome === 0 && this.waveTicks.length > 0 && this.nextWave >= this.waveTicks.length && this.pendingSpawns === 0 && this.aliens.count === 0) {
      this.outcome = 2;
      this.endTick = this.tick;
    }
    this.tick++;
  }

  private stepWaves(): void {
    if (!(this.nextWave < this.waveTicks.length && this.tick >= this.waveTicks[this.nextWave]!)) return;
    const wave = map1.waves[this.nextWave]!;
    for (const g of wave.groups) {
      const entry = this.terrain.entries.findIndex((e) => e.name === g.entry);
      this.pending.push({ kind: ALIEN_KINDS.indexOf(g.kind), entry: entry < 0 ? 0 : entry, left: g.count, nextTick: this.tick });
    }
    this.nextWave++;
    this.lastWaveTick = this.tick;
  }

  /** Brings the next wave forward to the next tick and pays the bonus for the time skipped. */
  private callWaveEarly(): void {
    if (this.nextWave >= this.waveTicks.length) return;
    const skipped = this.waveTicks[this.nextWave]! - (this.tick + 1);
    if (skipped <= 0) return;
    for (let i = this.nextWave; i < this.waveTicks.length; i++) this.waveTicks[i] = this.waveTicks[i]! - skipped;
    const bonus = callEarlyBonus(skipped);
    for (let k = 0; k < 3; k++) {
      this.pool[k] = this.pool[k]! + bonus[k]!;
      this.bonusPaid[k] = this.bonusPaid[k]! + bonus[k]!;
    }
    this.skippedTicks += skipped;
  }

  /** Mass extractor output per second (research can raise it). */
  extractorOutput(): number {
    return this.researched('extractors') ? EXTRACTOR_BOOST : 1;
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
      case 'research':
        this.researchQueue.push(RESEARCH_INDEX[cmd.node]!);
        break;
      case 'produce': {
        const slot = this.units.slotForId(cmd.id);
        if (slot >= 0) this.giveOrder(slot, { t: 'produce', progress: 0 }, cmd.queue ?? true);
        break;
      }
      case 'callWave':
        this.callWaveEarly();
        break;
      case 'place':
        this.placeBuilding(cmd.kind, cmd.tx, cmd.ty, true, cmd.dir ?? 0);
        break;
      case 'buildRun': {
        const plan = planRun(this, cmd);
        if (typeof plan === 'string' || plan.tiles.length === 0) break;
        const run = createRun(this, plan);
        if (run < 0) break;
        for (const id of cmd.ids) {
          const slot = this.units.slotForId(id);
          if (slot >= 0) this.giveOrder(slot, { t: 'run', run, site: -1 }, cmd.queue ?? false);
        }
        break;
      }
      case 'cancelRun':
        cancelRun(this, cmd.run);
        break;
      case 'gate': {
        const site = this.convertToGate(cmd.tx, cmd.ty, cmd.axis);
        if (site < 0) break;
        for (const id of cmd.ids) {
          const slot = this.units.slotForId(id);
          if (slot >= 0) this.giveOrder(slot, { t: 'build', id: site }, cmd.queue ?? false);
        }
        break;
      }
      case 'spawnAt':
        applySpawnAt(this, cmd.kind, cmd.x, cmd.z, cmd.count);
        break;
      case 'tune':
        setTune(this, cmd.target, cmd.kind, tuneFieldIndex(cmd.target, cmd.field), cmd.mult);
        break;
      case 'tuneReset':
        resetTune(this, cmd.target, cmd.kind);
        break;
      case 'setUnlimited':
        this.unlimited = cmd.on;
        break;
      case 'grantResearch':
        for (let i = 0; i < RESEARCH.length; i++) {
          if (!cmd.all && RESEARCH[i]!.id !== cmd.node) continue;
          this.researchDone |= 1 << i;
          if (this.researchCurrent === i) {
            this.researchCurrent = -1;
            this.researchProgress = 0;
          }
          this.researchQueue = this.researchQueue.filter((q) => q !== i);
        }
        break;
      case 'startWave': {
        for (const g of map1.waves[cmd.index]!.groups) {
          const entry = this.terrain.entries.findIndex((e) => e.name === g.entry);
          this.pending.push({ kind: ALIEN_KINDS.indexOf(g.kind), entry: entry < 0 ? 0 : entry, left: g.count, nextTick: this.tick });
        }
        break;
      }
      case 'clearAliens':
        clearAliens(this);
        break;
      case 'clearWrecks':
        clearWrecks(this);
        break;
      case 'resetStats':
        this.stats.fill(0);
        break;
      case 'resetSandbox':
        this.resetSandbox(cmd.full ?? false);
        break;
    }
  }

  /**
   * Converts the finished walls of a checked gate footprint into a gate site, atomically: the walls
   * are removed and the site created in the same call, or nothing changes. Returns the site id or -1.
   */
  convertToGate(cx: number, cz: number, axis?: 'x' | 'z'): number {
    const check = planGate(this, cx, cz, axis);
    if (!check.ok) return -1;
    const [tx, ty, fw, fh, dir] = gateFootprint(check);
    for (const [x, z] of check.tiles) this.removeBuilding(this.occupancy[z * this.terrain.w + x]! - 1);
    return this.placeBuilding(B.gate, tx, ty, false, dir, fw, fh);
  }

  /** Commander and the map 1 starting engineers at the base (map 1 and the sandbox). */
  spawnStartUnits(): void {
    const { base } = this.terrain;
    this.spawnUnit(U.commander, base.x + 0.5, base.z + 0.5);
    for (let i = 0; i < START_ENGINEERS; i++) this.spawnUnit(U.engineer, base.x - 2.5 + (i * 5) / Math.max(1, START_ENGINEERS - 1), base.z + 3.5);
  }

  /**
   * Sandbox: back to the start state, in place (the tick, the command queue and log carry on).
   * Tuning and unlimited spending are kept unless `full`.
   */
  resetSandbox(full: boolean): void {
    const fresh = new World(this.seed, this.terrain, { waves: false });
    fresh.scenario = 'sandbox';
    fresh.spawnStartUnits();
    fresh.computeRoutes();
    const keep = new Set(['tick', 'seq', 'queue', 'log', 'applyRejected', 'terrain', 'seed']);
    if (!full) {
      keep.add('tuning');
      keep.add('unlimited');
    }
    const self = this as unknown as Record<string, unknown>;
    const src = fresh as unknown as Record<string, unknown>;
    for (const k of Object.keys(src)) if (!keep.has(k)) self[k] = src[k];
    if (!full) {
      // Kept multipliers apply to the fresh entities as they would have at creation.
      for (const t of ['building', 'alien', 'unit'] as TuneTarget[]) {
        const n = TUNE_FIELDS[t].length;
        const arr = this.tuning[t];
        for (let k = 0; k * n < arr.length; k++) {
          const m = arr[k * n + TB_HP]!;
          if (m === 1) continue;
          arr[k * n + TB_HP] = 1;
          setTune(this, t, k, TB_HP, m);
        }
      }
    }
  }

  giveOrder(slot: number, order: Order, queue: boolean): void {
    if (!this.orders[slot]) this.orders[slot] = [];
    if (!queue) {
      this.orders[slot] = [];
      this.paths[slot] = null;
    }
    if (this.orders[slot]!.length < MAX_ORDERS) this.orders[slot]!.push(order);
    else this.applyRejected.push({ tick: this.tick, reason: `unit ${this.units.id(slot)}: order queue full (${MAX_ORDERS})` });
  }

  clampX(x: number) {
    return x < 0.5 ? 0.5 : x > this.terrain.w - 0.5 ? this.terrain.w - 0.5 : x;
  }
  clampZ(z: number) {
    return z < 0.5 ? 0.5 : z > this.terrain.h - 0.5 ? this.terrain.h - 0.5 : z;
  }

  // ---- buildings ---------------------------------------------------------------------------

  /** True if a building of `kind` may stand with its footprint anchor at (tx, ty). */
  canPlace(kind: number, tx: number, ty: number, fw?: number, fh?: number): boolean {
    return canPlaceOn(this.terrain, this.occupancy, kind, tx, ty, fw, fh);
  }

  /** Tier-1 maximum hit points of building slot s before tuning (a gate's scale with its footprint). */
  baseHp(s: number): number {
    const c = this.buildings.cols;
    return c.kind[s] === B.gate ? gateBaseHp(c.fw[s]! * c.fh[s]!) : buildingInfo(c.kind[s]!).hp;
  }

  /** Maximum hit points of slot s at `tier`: base × tier multiplier × tuning. */
  maxHpAt(s: number, tier: number): number {
    const c = this.buildings.cols;
    const kind = c.kind[s]!;
    const tierMult = tier > 1 ? buildingInfo(kind).tiers![tier - 2]!.hpMult : 1;
    return this.baseHp(s) * tierMult * this.tuning.b(kind, TB_HP);
  }

  /**
   * Places a building, or a construction site (reserved: no build power yet); returns its id, or
   * -1 if the footprint is not free. `fw`, `fh` default to the kind's footprint.
   */
  placeBuilding(kind: number, tx: number, ty: number, complete: boolean, dir = 0, fw?: number, fh?: number): number {
    const info = buildingInfo(kind);
    const w0 = fw ?? info.fw;
    const h0 = fh ?? info.fh;
    if (!this.canPlace(kind, tx, ty, w0, h0)) return -1;
    const b = this.buildings;
    const slot = b.create();
    const c = b.cols;
    c.kind[slot] = kind;
    c.tier[slot] = 1;
    c.dir[slot] = dir & 3;
    c.tx[slot] = tx;
    c.ty[slot] = ty;
    c.fw[slot] = w0;
    c.fh[slot] = h0;
    const max = this.maxHpAt(slot, 1);
    c.maxHp[slot] = max;
    c.hp[slot] = complete ? max : max * 0.1;
    c.progress[slot] = complete ? 1 : 0;
    c.flags[slot] = complete ? BF_COMPLETE | BF_STARTED : 0;
    c.moved[slot] = -1;
    if (kind === B.tempTurret) c.life[slot] = 30;
    const w = this.terrain.w;
    for (let j = 0; j < h0; j++) for (let i = 0; i < w0; i++) this.occupancy[(ty + j) * w + tx + i] = slot + 1;
    this.structureChanged();
    return b.id(slot);
  }

  removeBuilding(slot: number): void {
    const c = this.buildings.cols;
    const fw = c.fw[slot]!;
    const fh = c.fh[slot]!;
    const w = this.terrain.w;
    for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) this.occupancy[(c.ty[slot]! + j) * w + c.tx[slot]! + i] = 0;
    this.buildings.remove(slot);
    this.structureChanged();
  }

  /** Building slot standing on `cell` that blocks movement (started or complete, not a reserved site), or -1. */
  blockerAt(cell: number): number {
    const b = this.occupancy[cell]! - 1;
    return b >= 0 && !isReserved(this.buildings.cols.flags[b]!) ? b : -1;
  }

  /**
   * A site gets its first build power: it becomes started, blocks from now on, and any unit or
   * alien standing on its footprint is moved to the nearest free passable tile this tick.
   */
  startSite(slot: number): void {
    const c = this.buildings.cols;
    c.flags[slot] = c.flags[slot]! | BF_STARTED;
    this.structureChanged();
    const x0 = c.tx[slot]!;
    const z0 = c.ty[slot]!;
    const x1 = x0 + c.fw[slot]!;
    const z1 = z0 + c.fh[slot]!;
    const on = (x: number, z: number) => {
      const tx = Math.floor(x);
      const tz = Math.floor(z);
      return tx >= x0 && tx < x1 && tz >= z0 && tz < z1;
    };
    const u = this.units;
    for (let s = 0; s < u.highWater; s++) {
      if (!u.alive[s] || !on(u.cols.x[s]!, u.cols.z[s]!)) continue;
      const cell = this.nearestFree(u.cols.x[s]!, u.cols.z[s]!, (i) => this.unitPassable(i));
      if (cell < 0) continue;
      u.cols.x[s] = (cell % this.terrain.w) + 0.5;
      u.cols.z[s] = Math.floor(cell / this.terrain.w) + 0.5;
      this.paths[s] = null;
    }
    const a = this.aliens;
    for (let s = 0; s < a.highWater; s++) {
      if (!a.alive[s] || !on(a.cols.x[s]!, a.cols.z[s]!)) continue;
      const cell = this.nearestFree(a.cols.x[s]!, a.cols.z[s]!, (i) => this.alienPassable(i));
      if (cell < 0) continue;
      a.cols.x[s] = (cell % this.terrain.w) + 0.5;
      a.cols.z[s] = Math.floor(cell / this.terrain.w) + 0.5;
    }
  }

  /** A player unit may stand on `cell` now (live state, not the grids, which refresh next tick). */
  unitPassable(cell: number): boolean {
    if (this.terrain.tiles[cell] === TILE_ROCK) return false;
    const b = this.blockerAt(cell);
    if (b < 0) return true;
    const c = this.buildings.cols;
    const kind = c.kind[b]!;
    if (isBelt(kind)) return true;
    const W = this.terrain.w;
    return kind === B.gate && (c.flags[b]! & BF_COMPLETE) !== 0 && inGateCorridor(c.tx[b]!, c.ty[b]!, c.dir[b]!, cell % W, Math.floor(cell / W));
  }

  /** An alien may stand on `cell` now. */
  alienPassable(cell: number): boolean {
    if (this.terrain.tiles[cell] === TILE_ROCK) return false;
    const b = this.blockerAt(cell);
    return b < 0 || isBelt(this.buildings.cols.kind[b]!);
  }

  /**
   * Nearest cell to (x, z) for which `ok` holds, searched ring by ring round the point's tile (rings
   * 1..16) and within a ring by (ty, tx). -1 if none.
   */
  nearestFree(x: number, z: number, ok: (cell: number) => boolean): number {
    const t = this.terrain;
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    for (let r = 1; r <= 16; r++) {
      for (let ty = z0 - r; ty <= z0 + r; ty++) {
        for (let tx = x0 - r; tx <= x0 + r; tx++) {
          if (Math.max(Math.abs(tx - x0), Math.abs(ty - z0)) !== r) continue;
          if (tx < 0 || ty < 0 || tx >= t.w || ty >= t.h) continue;
          const cell = ty * t.w + tx;
          if (ok(cell)) return cell;
        }
      }
    }
    return -1;
  }

  structureChanged(): void {
    this.gridsDirty = true;
    this.beltsDirty = true;
    this.fieldDirty.fill(1);
  }

  /** Marks a finished building for upgrade to its next tier. False if not allowed (research, top tier). */
  startUpgrade(slot: number): boolean {
    const c = this.buildings.cols;
    const info = buildingInfo(c.kind[slot]!);
    if (!info.tiers || !(c.flags[slot]! & BF_COMPLETE)) return false;
    if (c.flags[slot]! & BF_UPGRADING) return true;
    if (upgradeProblem(this, slot)) return false;
    c.flags[slot] = c.flags[slot]! | BF_UPGRADING;
    c.progress[slot] = 0;
    return true;
  }

  /** Cost and BP·s of the work outstanding on a site: construction or an upgrade. */
  workOf(slot: number): { cost: Cost; time: number } {
    const c = this.buildings.cols;
    const info = buildingInfo(c.kind[slot]!);
    if (c.kind[slot] === B.gate) {
      const tiles = c.fw[slot]! * c.fh[slot]!;
      return c.flags[slot]! & BF_UPGRADING ? gateUpgradeWork(tiles, c.tier[slot]!) : gateBuildWork(tiles);
    }
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
            this.units.cols.cooldown[u] = this.researched('fieldEng') ? FIELD_ENG_TURRET_COOLDOWN : 75;
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
    c.hp[slot] = alienMaxHp(this, kind);
    recordSpawned(this, kind);
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
    c.hp[slot] = unitMaxHp(this, kind);
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
      // A reserved site (no build power yet) blocks nobody and costs nothing.
      if (occ < 0 || isReserved(bc.flags[occ]!)) {
        this.cost[i] = 10;
        this.costBypass[i] = 10;
        this.open[i] = 1;
        this.walk[i] = 1;
        continue;
      }
      const kind = bc.kind[occ]!;
      if (kind === B.gate) {
        // Every gate tile is wall to aliens, at the gate's hit points ÷ depth, so the gate's
        // breaking cost is charged once along a route (gate.ts). Units: the centre column only,
        // once complete.
        const depth = gateDepth(bc.fw[occ]!, bc.fh[occ]!, bc.dir[occ]!);
        const extra = buildingPathCost(kind, bc.hp[occ]! / depth);
        this.cost[i] = 10 + extra;
        this.costBypass[i] = 10 + extra * 4;
        this.open[i] = 0;
        this.walk[i] = bc.flags[occ]! & BF_COMPLETE && inGateCorridor(bc.tx[occ]!, bc.ty[occ]!, bc.dir[occ]!, i % t.w, Math.floor(i / t.w)) ? 1 : 0;
        continue;
      }
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
      // Sites in every state are goals, as in W13 (a reserved site only stops blocking).
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
    this.originRoutes = originRoutes(this);
    this.routesVersion++;
  }

  /** Recomputes only the sandbox spawn-origin routes (after a spawnAt). */
  computeOriginRoutes(): void {
    this.originRoutes = originRoutes(this);
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
      recordKilled(this, kind);
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
      if (bc.flags[s]! & BF_COMPLETE) this.buildingsLost++;
      this.removeBuilding(s);
    }
    const u = this.units;
    for (let s = 0; s < u.highWater; s++) {
      if (!u.alive[s] || u.cols.hp[s]! > 0) continue;
      if (this.debug.indestructible) {
        u.cols.hp[s] = 1;
        continue;
      }
      // Losing the commander loses the map (W2); nothing else ends the run. The sandbox never
      // ends: the wreck stays and a new commander comes 10 s later.
      if (u.cols.kind[s] === U.commander) {
        if (this.scenario === 'sandbox') {
          this.commanderDeaths++;
          this.commanderRespawnTick = this.tick + SANDBOX_RESPAWN_TICKS;
          if (this.wrecks.count < this.wrecks.capacity) {
            const wr = this.wrecks.create();
            this.wrecks.cols.kind[wr] = WRECK_COMMANDER;
            this.wrecks.cols.x[wr] = u.cols.x[s]!;
            this.wrecks.cols.z[wr] = u.cols.z[s]!;
            this.wrecks.cols.salvage[wr] = COMMANDER_WRECK_SALVAGE;
          }
        } else {
          this.outcome = 1;
          this.endTick = this.tick;
        }
      }
      this.unitsLost++;
      u.remove(s);
      this.orders[s] = [];
      this.paths[s] = null;
    }
  }
}

/**
 * Placement rule shared by the simulation and the render thread's ghost preview: every tile of the
 * fw × fh footprint (default: the kind's) has the right ground and no building in any state.
 */
export function canPlaceOn(terrain: Terrain, occupancy: Int32Array, kind: number, tx: number, ty: number, fw?: number, fh?: number): boolean {
  const name = BUILDING_KINDS[kind];
  if (!name) return false;
  const info = buildingInfo(kind);
  const w = fw ?? info.fw;
  const h = fh ?? info.fh;
  const need = kind === B.massExtractor ? TILE_MASS : kind === B.rareExtractor ? TILE_RARE : TILE_GROUND;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = tx + i;
      const y = ty + j;
      if (tileAt(terrain, x, y) !== need) return false;
      if (occupancy[y * terrain.w + x] !== 0) return false;
    }
  }
  return true;
}

export { CAT_COMMANDER, CAT_DEFENCES, CAT_STRUCTURES, CAT_ECONOMY, COMMANDER_INCOME };
