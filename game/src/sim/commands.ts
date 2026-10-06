// Player commands: main thread -> worker. The worker stamps each with the tick it applies to,
// so a replay of (seed, scenario, stamped commands) reproduces a game exactly.
// `queue: true` appends the order to the units' queues instead of replacing them.

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
  | { t: 'place'; kind: number; tx: number; ty: number; dir?: number };

export interface StampedCommand {
  tick: number;
  /** Arrival order within the tick; ties are applied in this order. */
  seq: number;
  cmd: Command;
}
