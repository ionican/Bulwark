// Messages between the render thread and the simulation worker.

import type { Command } from './commands.ts';
import type { ScenarioName } from './scenarios.ts';

export type ToWorker =
  /** `rich`: debug start with 1,000,000 of each resource. */
  | { type: 'init'; seed: number; scenario: ScenarioName; rich?: boolean }
  /** `ref` is echoed back if the command is refused, and (when given) on acceptance too. */
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
  checkpoints: Array<{ wave: number; tick: number }>;
}

export type FromWorker =
  /** `buffer` is transferred. `tickMs` is wall time for the last step plus encode (not in the snapshot bytes). */
  | { type: 'snapshot'; buffer: ArrayBuffer; tickMs: number; ticksRun: number; runner: RunnerInfo }
  | { type: 'rejected'; reason: string; cmd: Command; ref?: number }
  /** A command with a `ref` was validated and queued. `detail`: what it will do (buildRun: tiles and skips). */
  | { type: 'accepted'; ref: number; tick: number; detail?: Record<string, unknown> }
  | { type: 'saved'; bytes: ArrayBuffer; tick: number }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string };
