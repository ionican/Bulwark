// Messages between the render thread and the simulation worker.

import type { Command } from './commands.ts';
import type { ScenarioName } from './scenarios.ts';

export type ToWorker =
  /** `rich`: debug start with 1,000,000 of each resource. */
  | { type: 'init'; seed: number; scenario: ScenarioName; rich?: boolean }
  /** With a `ref`, the final result (applied or refused) is reported once the command's tick runs. */
  | { type: 'command'; cmd: Command; ref?: number }
  /** A snapshot buffer the render thread has finished with, returned for reuse. */
  | { type: 'recycle'; buffer: ArrayBuffer }
  | { type: 'speed'; speed: number }
  | { type: 'pause'; paused: boolean }
  | { type: 'rewind' }
  | { type: 'save' }
  /** `bytes` is transferred. */
  | { type: 'load'; bytes: ArrayBuffer };

export interface RunnerInfo {
  speed: number;
  paused: boolean;
  /** W25c: worlds replaced so far (loads and rewinds); the interpolator does not interpolate across a change. */
  world: number;
  checkpoints: Array<{ wave: number; tick: number }>;
}

export type FromWorker =
  /** `buffer` is transferred. `tickMs` is wall time for the last step plus encode (not in the snapshot bytes). */
  | { type: 'snapshot'; buffer: ArrayBuffer; tickMs: number; ticksRun: number; runner: RunnerInfo }
  | { type: 'rejected'; reason: string; cmd: Command; ref?: number }
  /**
   * A command with a `ref` was applied at its tick (`tick`). `detail`: what it did (buildRun: tiles
   * and skips). Refusals, at submit or at the tick, come as 'rejected' with the same ref.
   */
  | { type: 'accepted'; ref: number; tick: number; detail?: Record<string, unknown> }
  | { type: 'saved'; bytes: ArrayBuffer; tick: number }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string };
