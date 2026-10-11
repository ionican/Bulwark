// Player commands: main thread -> worker. The worker stamps each with the tick it applies to,
// so a replay of (seed, scenario, stamped commands) reproduces a game exactly.
// `queue: true` appends the order to the units' queues instead of replacing them. W25: replacing
// (or removing, with dequeue and clearQueue) an order removes any reserved site no unit has queued
// any more; started sites stay.

import type { TuneTarget } from './tuning.ts';

export type Command =
  /** Move player units (commander, engineers) to a world point. Ids are unit-table ids. */
  | { t: 'move'; ids: number[]; x: number; z: number; queue?: boolean }
  /** Lay out a construction site and send the units to build it. `dir` 0..3 for belt pieces. */
  | { t: 'build'; ids: number[]; kind: number; tx: number; ty: number; dir?: number; queue?: boolean }
  /** Help build (or upgrade) an existing site. */
  | { t: 'assist'; ids: number[]; target: number; queue?: boolean }
  /** Upgrade a wall to its next tier in place. */
  | { t: 'upgrade'; ids: number[]; target: number; queue?: boolean }
  /** Engineers reclaim a wreck and carry the salvage to a depot. */
  | { t: 'reclaim'; ids: number[]; wreck: number; queue?: boolean }
  | { t: 'stop'; ids: number[] }
  /** An engineer drops a temporary turret where it stands (cooldown). */
  | { t: 'dropTurret'; id: number }
  /** Queue a research node (balance.ts RESEARCH id). Research cannot be cancelled or refunded. */
  | { t: 'research'; node: string }
  /** The commander produces an engineer (W12 cost and build time), queued like a build. */
  | { t: 'produce'; id: number; queue?: boolean }
  /** Bring the next wave forward to the next tick and pay the call-early bonus. */
  | { t: 'callWave' }
  /** Debug: spawn a group of `count` aliens of `kind` at entry index `entry`. */
  | { t: 'spawn'; kind: number; entry: number; count: number }
  /** Debug: place a finished building instantly. */
  | { t: 'place'; kind: number; tx: number; ty: number; dir?: number }
  // ---- W24 ----
  /**
   * Lay a straight wall run (runs.ts) and give each unit one order to work through it. `from` and
   * `to` are tiles; `depth` 1..4 rows. Always tier 1.
   */
  | { t: 'buildRun'; ids: number[]; from: [number, number]; to: [number, number]; depth: number; queue?: boolean }
  /** Remove a run's remaining reserved tiles (started tiles stay as sites). */
  | { t: 'cancelRun'; run: number }
  /**
   * Convert finished walls into a gate site centred on (tx, ty) (gate.ts) and send the units to
   * build it. `axis` forces the run axis; without it the axis is picked as W23 does.
   */
  | { t: 'gate'; ids: number[]; tx: number; ty: number; axis?: 'x' | 'z'; queue?: boolean }
  // ---- W25: build queue ----
  /**
   * Remove order `order` (its id: units.ts Order.oid, the snapshot's queue `oid`) from unit `id`'s
   * queue, wherever it is in the queue by the command's tick. W25c: refused with a reason when the
   * unit no longer holds it (completed or removed), so a stale request never removes another order
   * (it used to name a kind and target, which every move, and every produce order, shared). A
   * reserved site no unit holds any more is removed (world.ts dropOrphans).
   */
  | { t: 'dequeue'; id: number; order: number }
  /** Empty the queues of `ids`, under the same rule. */
  | { t: 'clearQueue'; ids: number[] }
  // ---- W29 ----
  /** Repair a complete, damaged building (free; units.ts). Any building, the core included. */
  | { t: 'repair'; ids: number[]; target: number; queue?: boolean }
  // Sandbox only (sandbox.ts): refused with a reason in any other scenario.
  /** Spawn `count` (1..50) aliens of `kind` round world point (x, z). */
  | { t: 'spawnAt'; kind: number; x: number; z: number; count: number }
  /** Multiply one field of one kind by `mult` (0.1..10) on top of tiers and research (tuning.ts). */
  | { t: 'tune'; target: TuneTarget; kind: number; field: string; mult: number }
  /** Multipliers back to 1: all, one target, or one kind of one target. */
  | { t: 'tuneReset'; target?: TuneTarget; kind?: number }
  /** Free spending: construction, upgrades, research, engineers, energy upkeep and parts cost nothing. */
  | { t: 'setUnlimited'; on: boolean }
  /** Complete research without cost: every node, or one. */
  | { t: 'grantResearch'; all?: boolean; node?: string }
  /** Send map 1 wave `index` (0-based) now, at its entry points. Does not start the schedule. */
  | { t: 'startWave'; index: number }
  | { t: 'clearAliens' }
  | { t: 'clearWrecks' }
  | { t: 'resetStats' }
  /** Back to the sandbox start state; tuning and unlimited are kept unless `full`. */
  | { t: 'resetSandbox'; full?: boolean }
  /** W29 debug: `amount` hit points of damage to a building, as a hit (combat.ts damageBuilding). */
  | { t: 'damage'; target: number; amount: number }
  /** W29 debug: every complete extractor's buffer to its cap (the delivery-load benchmark). */
  | { t: 'fillBuffers' };

/** Commands refused outside the sandbox scenario. */
export const SANDBOX_COMMANDS: ReadonlySet<Command['t']> = new Set([
  'spawnAt',
  'tune',
  'tuneReset',
  'setUnlimited',
  'grantResearch',
  'startWave',
  'clearAliens',
  'clearWrecks',
  'resetStats',
  'resetSandbox',
  'damage',
  'fillBuffers',
]);

export interface StampedCommand {
  tick: number;
  /** Arrival order within the tick; ties are applied in this order. */
  seq: number;
  cmd: Command;
}
