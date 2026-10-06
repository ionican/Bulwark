// Messages between the render thread and the simulation worker.

import type { Command } from './commands.ts';
import type { ScenarioName } from './scenarios.ts';

export type ToWorker =
  /** `rich`: debug start with 1,000,000 of each resource. */
  | { type: 'init'; seed: number; scenario: ScenarioName; rich?: boolean }
  | { type: 'command'; cmd: Command }
  /** A snapshot buffer the render thread has finished with, returned for reuse. */
  | { type: 'recycle'; buffer: ArrayBuffer };

export type FromWorker =
  /** `buffer` is transferred. `tickMs` is wall time for the last step plus encode (not in the snapshot bytes). */
  | { type: 'snapshot'; buffer: ArrayBuffer; tickMs: number; ticksRun: number };
