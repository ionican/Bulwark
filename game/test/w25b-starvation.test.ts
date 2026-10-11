// W25b: Richard's "build seems to freeze here" (2026-10-09), reproduced headless with his sequence
// (w25b-fixtures.ts richardsSequence). These pass on the simulation as it was: the simulation is
// not stuck. With free spending on, everything finishes; with it off, the mass runs out about 30 s
// in and every site in progress then shares the commander's 1 mass/s income. The visible fix is in
// w25b-freeze.test.ts.

import { describe, expect, it } from 'vitest';
import { BF_COMPLETE, isReserved } from '../src/sim/schema.ts';
import { inProgress, queuesEmpty, richardsSequence, sites } from './w25b-fixtures.ts';

describe('W25b: the freeze reproduced (headless)', () => {
  it('free spending on: the same orders finish — every site complete, every queue empty, no builder stuck', () => {
    const { w, ids } = richardsSequence(true);
    let t = 0;
    while (!queuesEmpty(w, ids) && t++ < 3000) w.step();
    expect(queuesEmpty(w, ids), `queues still hold orders at tick ${w.tick}`).toBe(true);
    const all = sites(w);
    expect(all.length).toBe(13 + 6 + 9 + 1 + 1); // W29: the sandbox's core is a building too
    expect(all.filter((b) => !(b.flags & BF_COMPLETE))).toEqual([]);
    expect(w.runs.every((r) => r === null)).toBe(true);
  });

  it('free spending off: the mass runs out about 30 s in; after that the simulation still ticks and the sites move at the 1 mass/s income', () => {
    const { w } = richardsSequence(false);
    let emptyAt = -1;
    while (w.tick < 600) {
      w.step();
      if (emptyAt < 0 && w.pool[0]! < 1) emptyAt = w.tick;
    }
    expect(emptyAt, 'tick the mass pool emptied').toBeGreaterThan(200);
    expect(emptyAt).toBeLessThan(400);
    expect(w.shortMask & 1, 'mass is the short resource').toBe(1);
    expect(w.shortMask & 2, 'energy is not short').toBe(0);
    // 60 s on: the simulation advances 600 ticks, spends exactly what comes in (1 mass/s) and the
    // builders stay on their sites: progress creeps (a wall is 100 mass, so 0.6 walls in 60 s).
    const built = () => sites(w).reduce((n, b) => n + (b.flags & BF_COMPLETE ? 1 : b.progress), 0);
    const before = built();
    expect(inProgress(w).length).toBe(3);
    let spent = 0;
    for (let i = 0; i < 600; i++) {
      w.step();
      spent += w.spendTick[0]!;
    }
    expect(w.tick).toBe(1200);
    expect(spent).toBeGreaterThan(59);
    expect(spent).toBeLessThan(61);
    expect(w.pool[0]!).toBeLessThan(1);
    const gained = built() - before;
    expect(gained, 'wall-equivalents built in 60 s').toBeGreaterThan(0.5);
    expect(gained).toBeLessThan(0.7);
    // The rest is still reserved (dotted), as in Richard's screenshot.
    expect(sites(w).filter((b) => isReserved(b.flags)).length).toBeGreaterThan(20);
  });
});
