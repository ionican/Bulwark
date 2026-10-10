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

/**
 * Run 3: the timing of the batch of ticks a snapshot follows (not in the snapshot bytes; no effect
 * on world state). `stepMs`: wall ms stepping the batch's `ticksRun` ticks; `encodeMs`: encoding
 * the snapshot; `firstTick`..`lastTick`: the ticks run (lastTick < firstTick when none ran);
 * `epoch`: the runner's world epoch; `startedAt`, `endedAt`: the worker clock at the batch's start
 * and once the snapshot was encoded, as performance.timeOrigin + performance.now() (ms since the
 * Unix epoch), so the page can put them on its own clock.
 */
export interface WorkerBatchTiming {
  stepMs: number;
  ticksRun: number;
  encodeMs: number;
  firstTick: number;
  lastTick: number;
  epoch: number;
  startedAt: number;
  endedAt: number;
}

export type FromWorker =
  /** `buffer` is transferred. `tickMs` is wall ms per tick of the last batch's step (encoding not included). */
  | { type: 'snapshot'; buffer: ArrayBuffer; tickMs: number; ticksRun: number; runner: RunnerInfo; timing: WorkerBatchTiming }
  | { type: 'rejected'; reason: string; cmd: Command; ref?: number }
  /**
   * A command with a `ref` was applied at its tick (`tick`). `detail`: what it did (buildRun: tiles
   * and skips). Refusals, at submit or at the tick, come as 'rejected' with the same ref.
   */
  | { type: 'accepted'; ref: number; tick: number; detail?: Record<string, unknown> }
  | { type: 'saved'; bytes: ArrayBuffer; tick: number }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string };
