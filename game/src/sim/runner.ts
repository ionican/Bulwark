// Fixed-step clock for the simulation, with pause, speed and wave checkpoints. Pure TypeScript
// (the worker drives it with performance.now(); tests drive it with a fake clock).
//
// Speed changes how many ticks run per wall-clock second (tick length 100 ms ÷ speed), never what
// a tick does, so a game replays identically at any speed. While paused no ticks run, but
// commands are still validated and queued; they apply on the first tick after resuming.
// A checkpoint (the full serialized state) is taken just before the tick on which a wave starts.

import { World } from './world.ts';
import { TICK_HZ } from './kinds.ts';
import { deserializeWorld, serializeWorld } from './save.ts';
import type { Command, StampedCommand } from './commands.ts';
import { planRun } from './runs.ts';

export interface Checkpoint {
  /** Wave number (1-based) that starts on this tick. */
  wave: number;
  tick: number;
  bytes: Uint8Array;
}

export const SPEEDS = [1, 2, 3] as const;
const BASE_TICK_MS = 1000 / TICK_HZ;
/** After a stall, run at most this many ticks per advance() (per unit of speed). */
const MAX_CATCH_UP = 5;

/** The final outcome of a command sent with a `ref`: applied at its tick, or refused with a reason. */
export interface CommandResult {
  ref: number | undefined;
  ok: boolean;
  tick: number;
  cmd: Command;
  reason?: string;
  /** buildRun: tiles laid and tiles skipped. */
  detail?: Record<string, unknown>;
}

export class SimRunner {
  private _world!: World;
  /**
   * Final results (review 3): every command sent with submitTracked when it is applied or refused
   * at its tick, every untracked command refused at its tick, and tracked commands lost when the
   * world is replaced (rewind, load).
   */
  onResult: ((r: CommandResult) => void) | null = null;
  private readonly tracked = new Map<StampedCommand, number>();
  speed = 1;
  paused = false;
  /** W25c: worlds replaced so far by load and rewind (RunnerInfo.world; the renderer's interpolator reads it). */
  worldEpoch = 0;
  readonly checkpoints: Checkpoint[] = [];
  private nextTickAt: number;

  constructor(world: World, now: number) {
    this.world = world;
    this.nextTickAt = now + this.tickMs();
  }

  get world(): World {
    return this._world;
  }

  /** Replacing the world drops its queued commands: tracked ones are reported as lost. */
  set world(w: World) {
    if (this._world && this.tracked.size) {
      for (const [s, ref] of this.tracked) this.onResult?.({ ref, ok: false, tick: this._world.tick, cmd: s.cmd, reason: 'the game was rewound or a save was loaded before it ran' });
      this.tracked.clear();
    }
    if (this._world) this._world.commandListener = null;
    this._world = w;
    w.commandListener = (s, problem) => this.applied(s, problem);
  }

  private applied(s: StampedCommand, problem: string | null): void {
    const ref = this.tracked.get(s);
    this.tracked.delete(s);
    if (ref === undefined && !problem) return;
    const w = this._world;
    if (problem) {
      this.onResult?.({ ref, ok: false, tick: w.tick, cmd: s.cmd, reason: problem });
      return;
    }
    let detail: Record<string, unknown> | undefined;
    if (s.cmd.t === 'buildRun') {
      const plan = w.validatedResult<ReturnType<typeof planRun>>(s.cmd);
      if (plan && typeof plan !== 'string') detail = { tiles: plan.tiles.length, skipped: plan.skipped, axis: plan.axis, start: plan.start };
    }
    this.onResult?.({ ref, ok: true, tick: w.tick, cmd: s.cmd, detail });
  }

  /**
   * Validates and queues a command whose final result is reported through onResult with `ref`.
   * Returns the reason if it is refused now (then nothing is reported later).
   */
  submitTracked(cmd: Command, ref: number): string | null {
    const r = this._world.submitCommand(cmd);
    if (typeof r === 'string') return r;
    this.tracked.set(r, ref);
    return null;
  }

  tickMs(): number {
    return BASE_TICK_MS / this.speed;
  }

  setSpeed(speed: number, now: number): void {
    if (!Number.isFinite(speed) || speed <= 0) throw new Error(`bad speed ${speed}`);
    this.speed = speed;
    this.nextTickAt = now + this.tickMs();
  }

  setPaused(paused: boolean, now: number): void {
    this.paused = paused;
    if (!paused) this.nextTickAt = now + this.tickMs();
  }

  /** Validates and queues a command (also while paused). Returns the reason if refused. */
  submit(cmd: Command): string | null {
    return this.world.submit(cmd);
  }

  /** One tick, with the wave checkpoint first when a wave starts on it. */
  stepOnce(): void {
    const w = this.world;
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (w.waveDue() && (!last || last.tick !== w.tick)) this.checkpoints.push({ wave: w.nextWave + 1, tick: w.tick, bytes: serializeWorld(w) });
    w.step();
  }

  /** Runs the ticks due by wall time `now`. Returns how many ran. */
  advance(now: number): number {
    if (this.paused || this.world.outcome !== 0) {
      this.nextTickAt = now + this.tickMs();
      return 0;
    }
    let ran = 0;
    const limit = MAX_CATCH_UP * Math.ceil(this.speed);
    while (now >= this.nextTickAt && ran < limit) {
      this.stepOnce();
      ran++;
      this.nextTickAt += this.tickMs();
    }
    if (now >= this.nextTickAt) this.nextTickAt = now + this.tickMs(); // dropped ticks: resume from now
    return ran;
  }

  /**
   * advance(), but an exception in a tick is caught and returned instead of stopping the clock:
   * the caller reports it, and the next tick is scheduled as usual (review 1).
   */
  advanceSafe(now: number): { ran: number; error?: string } {
    try {
      return { ran: this.advance(now) };
    } catch (e) {
      this.nextTickAt = now + this.tickMs();
      return { ran: 0, error: e instanceof Error ? `${e.message}${e.stack ? `\n${e.stack}` : ''}` : String(e) };
    }
  }

  /** Milliseconds until the next tick is due. */
  delay(now: number): number {
    return Math.max(0, this.nextTickAt - now);
  }

  /**
   * Restores the checkpoint at the start of the current wave, or of the previous one when the
   * current wave began less than 5 s ago (so pressing rewind twice steps back twice). After a loss
   * it restores the start of the wave the commander died in. Later checkpoints are dropped.
   */
  rewind(): { wave: number; tick: number } | string {
    const w = this.world;
    const margin = w.outcome !== 0 ? 0 : 50;
    let i = this.checkpoints.length - 1;
    while (i >= 0 && this.checkpoints[i]!.tick > w.tick - margin) i--;
    if (i < 0) return 'no checkpoint yet: the first one is taken when wave 1 arrives';
    const cp = this.checkpoints[i]!;
    this.world = deserializeWorld(cp.bytes);
    this.worldEpoch++;
    this.checkpoints.length = i + 1;
    return { wave: cp.wave, tick: cp.tick };
  }

  /** Replaces the world with a loaded save; checkpoints from the old game are dropped. */
  load(bytes: Uint8Array): void {
    this.world = deserializeWorld(bytes);
    this.worldEpoch++;
    this.checkpoints.length = 0;
  }
}
