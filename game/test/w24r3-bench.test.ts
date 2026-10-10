// W24 run 3, criterion 10 (Codex 18 remainder; R1-8, R1-9, R2-3, R2-4): the worker timing window.
// Each snapshot message carries its batch's step time, ticks run, snapshot encoding time, first and
// last tick, world epoch, and the worker clock at batch start and end on the page clock. The
// recorder (src/workerWindow.ts) keeps, unbounded, only batches that started after start() and
// ended before stop(), in the world epoch current at start(), with no repeated or overlapping tick
// range, and counts each drop by reason. The statistic is tick-weighted: each batch's mean per-tick
// step time counted once per tick it ran; its median and maximum; encoding reported separately.
// The judge (scripts/benchGate.mjs judgeWorkerWindow) fails a median of 50 ms or more, fewer than
// 8 ticks per second of window, or any missing or non-finite figure.

import { describe, expect, it } from 'vitest';
import { WorkerWindow, type BatchTiming } from '../src/workerWindow.ts';
import { judgeWorkerWindow } from '../scripts/benchGate.mjs';

let tick = 0;
/** A batch of `ticks` ticks at `perTick` ms each, starting at page time `at` (ms). */
function batch(at: number, ticks: number, perTick: number, epoch = 0, first = tick): BatchTiming {
  tick = first + ticks;
  return { stepMs: perTick * ticks, ticksRun: ticks, encodeMs: 0.4, firstTick: first, lastTick: first + ticks - 1, epoch, startedAt: at, endedAt: at + perTick * ticks + 0.4 };
}

/** A 20 s window of batches every 100 ms, `ticks` ticks each at `perTick` ms. */
function steady(perTick: number, ticks = 1, seconds = 20) {
  tick = 0;
  const w = new WorkerWindow();
  w.start(0, 0);
  for (let t = 10; t + 100 < seconds * 1000; t += 100) w.record(batch(t, ticks, perTick));
  return w.stop(seconds * 1000);
}

describe('run 3 criterion 10: the judge', () => {
  it('passes a tick-weighted median of 49 ms; fails 50 ms', () => {
    const ok = steady(49);
    expect(ok.medianTickMs).toBeCloseTo(49, 9);
    expect(judgeWorkerWindow(ok)).toEqual([]);
    const bad = steady(50);
    expect(judgeWorkerWindow(bad).join(' ')).toMatch(/median/);
  });

  it('the mixed batches (51 one-tick batches at 1 ms, 50 three-tick batches at 60 ms) fail: tick-weighted, not per message', () => {
    tick = 0;
    const w = new WorkerWindow();
    w.start(0, 0);
    let t = 10;
    for (let i = 0; i < 101; i++) {
      w.record(i % 2 === 0 ? batch(t, 1, 1) : batch(t, 3, 60));
      t += 190;
    }
    const r = w.stop(20_000);
    expect(r.kept).toBe(101);
    expect(r.ticks).toBe(51 + 150);
    expect(r.medianTickMs).toBeCloseTo(60, 9);
    expect(r.maxTickMs).toBeCloseTo(60, 9);
    expect(judgeWorkerWindow(r).join(' ')).toMatch(/median/);
  });

  it('fails too few ticks for the window, and any missing or non-finite figure', () => {
    // 5 ticks per second for 20 s: 100 ticks < 8 × 20
    tick = 0;
    const w = new WorkerWindow();
    w.start(0, 0);
    for (let t = 10; t < 19_800; t += 200) w.record(batch(t, 1, 2));
    const few = w.stop(20_000);
    expect(few.ticks).toBeLessThan(160);
    expect(judgeWorkerWindow(few).join(' ')).toMatch(/ticks/);
    const empty = new WorkerWindow();
    empty.start(0, 0);
    const none = empty.stop(20_000);
    expect(judgeWorkerWindow(none).length).toBeGreaterThan(0);
    const ok = steady(5);
    for (const key of ['medianTickMs', 'maxTickMs', 'encodeMedianMs', 'ticks', 'seconds'] as const) {
      expect(judgeWorkerWindow({ ...ok, [key]: Number.NaN }).join(' '), key).toMatch(new RegExp(key));
      const missing: Record<string, unknown> = { ...ok };
      delete missing[key];
      expect(judgeWorkerWindow(missing as typeof ok).join(' '), key).toMatch(new RegExp(key));
    }
    expect(judgeWorkerWindow(null as unknown as typeof ok).length).toBeGreaterThan(0);
  });
});

describe('run 3 criterion 10: the recorder', () => {
  it('keeps more than 100 messages within a window (unbounded, not the rolling buffer)', () => {
    const r = steady(3);
    expect(r.kept).toBeGreaterThan(100);
    expect(r.ticks).toBe(r.kept);
  });

  it('drops a batch that started before start(), one from a previous world epoch, a repeated tick range and one that ended after stop(); reports each drop', () => {
    tick = 100;
    const w = new WorkerWindow();
    w.record(batch(-50, 1, 2)); // before start(): not running yet, ignored
    w.start(1000, 4);
    w.record(batch(990, 2, 2, 4)); // started before start()
    w.record(batch(1100, 1, 2, 3)); // a previous world's
    const a = batch(1200, 2, 2, 4);
    w.record(a);
    w.record({ ...a, startedAt: 1300, endedAt: 1305 }); // the same ticks again
    w.record(batch(1400, 2, 2, 4, a.lastTick)); // overlapping the last kept range
    w.record(batch(1500, 1, 2, 4, a.lastTick + 1));
    w.record(batch(1990, 1, 30, 4)); // ends after stop()
    const r = w.stop(2000);
    expect(r.kept).toBe(2);
    expect(r.ticks).toBe(3);
    expect(r.dropped).toEqual({ beforeStart: 1, afterStop: 1, epoch: 1, repeated: 2 });
    w.record(batch(2100, 1, 2, 4)); // after stop(): ignored
    expect(w.stop(2200).kept, 'stopped: nothing more is kept').toBe(2);
  });

  it('per-tick maximum and encoding are reported separately from the median', () => {
    tick = 0;
    const w = new WorkerWindow();
    w.start(0, 0);
    for (let i = 0; i < 30; i++) w.record({ ...batch(10 + i * 100, 1, i === 7 ? 40 : 4), encodeMs: i === 3 ? 9 : 1 });
    const r = w.stop(5000);
    expect(r.medianTickMs).toBeCloseTo(4, 9);
    expect(r.maxTickMs).toBeCloseTo(40, 9);
    expect(r.encodeMedianMs).toBeCloseTo(1, 9);
    expect(r.encodeMaxMs).toBeCloseTo(9, 9);
    expect(r.seconds).toBeCloseTo(5, 9);
  });
});
