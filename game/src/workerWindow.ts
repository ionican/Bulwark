// W24 run 3 (criterion 10): the benchmark's worker timing window. Each snapshot message carries the
// timing of the batch of ticks it follows (sim/protocol.ts WorkerBatchTiming, on the page clock once
// main.ts has converted it). The recorder keeps every batch, unbounded, that started at or after
// start() and ended at or before stop(), in the world epoch current at start(), with no tick range
// repeating or overlapping the last one kept; every other batch is counted by the reason it was
// dropped. The rolling sample buffer behind the HUD is not used: it holds only the last few seconds.

import type { WorkerBatchTiming } from './sim/protocol.ts';

/** One batch's timing, its startedAt and endedAt on the page clock (ms). */
export type BatchTiming = WorkerBatchTiming;

export interface WorkerWindowReport {
  /** Batches kept. */
  kept: number;
  /** Ticks in the kept batches. */
  ticks: number;
  /** Length of the window (start() to stop()). */
  seconds: number;
  /** Tick-weighted: each batch's mean per-tick step time counted once per tick it ran. */
  medianTickMs: number;
  maxTickMs: number;
  /** Per batch (one snapshot encoded per batch). */
  encodeMedianMs: number;
  encodeMaxMs: number;
  dropped: { beforeStart: number; afterStop: number; epoch: number; repeated: number };
}

export class WorkerWindow {
  private running = false;
  private startAt = 0;
  private epoch = 0;
  private batches: BatchTiming[] = [];
  private dropped = { beforeStart: 0, afterStop: 0, epoch: 0, repeated: 0 };
  private last: WorkerWindowReport | null = null;

  start(now: number, epoch: number): void {
    this.running = true;
    this.startAt = now;
    this.epoch = epoch;
    this.batches = [];
    this.dropped = { beforeStart: 0, afterStop: 0, epoch: 0, repeated: 0 };
    this.last = null;
  }

  /** Ignored unless recording. A batch that ran no ticks (paused) carries no step time and is skipped. */
  record(b: BatchTiming): void {
    if (!this.running || !(b.ticksRun > 0)) return;
    if (b.startedAt < this.startAt) this.dropped.beforeStart++;
    else if (b.epoch !== this.epoch) this.dropped.epoch++;
    else if (this.batches.length && b.firstTick <= this.batches[this.batches.length - 1]!.lastTick) this.dropped.repeated++;
    else this.batches.push(b);
  }

  /** Ends the window and reports it; a second call returns the same report. */
  stop(now: number): WorkerWindowReport {
    if (!this.running && this.last) return this.last;
    this.running = false;
    // whether a batch ended inside the window is only known once the window has an end
    const kept = this.batches.filter((b) => b.endedAt <= now);
    this.dropped.afterStop += this.batches.length - kept.length;
    const perTick = kept.map((b) => ({ ms: b.stepMs / b.ticksRun, n: b.ticksRun })).sort((a, b) => a.ms - b.ms);
    const ticks = perTick.reduce((a, x) => a + x.n, 0);
    let median = Number.NaN;
    let seen = 0;
    for (const x of perTick) {
      seen += x.n;
      if (seen * 2 >= ticks) {
        median = x.ms;
        break;
      }
    }
    const enc = kept.map((b) => b.encodeMs).sort((a, b) => a - b);
    this.last = {
      kept: kept.length,
      ticks,
      seconds: (now - this.startAt) / 1000,
      medianTickMs: median,
      maxTickMs: perTick.length ? perTick[perTick.length - 1]!.ms : Number.NaN,
      encodeMedianMs: enc.length ? enc[(enc.length - 1) >> 1]! : Number.NaN,
      encodeMaxMs: enc.length ? enc[enc.length - 1]! : Number.NaN,
      dropped: { ...this.dropped },
    };
    return this.last;
  }
}
