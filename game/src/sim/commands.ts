// Player commands: main thread -> worker. The worker stamps each with the tick it applies to,
// so a replay of (seed, scenario, stamped commands) reproduces a game exactly.

export type Command =
  /** Move player units (commander, engineers) to a world point. Ids are unit-table ids. */
  | { t: 'move'; ids: number[]; x: number; z: number }
  /** Debug in M1: place a finished building of `kind` with its footprint origin at (tx, ty). */
  | { t: 'place'; kind: number; tx: number; ty: number };

export interface StampedCommand {
  tick: number;
  /** Arrival order within the tick; ties are applied in this order. */
  seq: number;
  cmd: Command;
}
