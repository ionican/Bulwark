// Regression (found in the browser): after a snapshot is recycled to the worker its buffer is
// detached; the interpolator's views must never still point into it.

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/scenarios.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { Interpolator } from '../src/render/interp.ts';
import { CAPACITY } from '../src/sim/world.ts';

describe('interpolator and recycled snapshots', () => {
  it('views stay readable after the dropped snapshot buffer is transferred away', () => {
    const w = createWorld(1, 'map1');
    const interp = new Interpolator(CAPACITY);
    const snaps = [];
    for (let i = 0; i < 3; i++) {
      w.step();
      snaps.push(decodeSnapshot(encodeSnapshot(w)));
    }
    interp.push(snaps[0]!, 0);
    interp.update(10); // a frame
    interp.push(snaps[1]!, 100);
    const dropped = interp.push(snaps[2]!, 200); // two snapshots arrive between frames
    expect(dropped).toBe(snaps[0]);
    structuredClone(dropped!.buffer, { transfer: [dropped!.buffer] }); // what postMessage transfer does
    expect(dropped!.buffer.byteLength).toBe(0);
    expect(() => Array.from(interp.units.id.subarray(0, interp.units.count))).not.toThrow();
    expect(interp.units.count).toBe(3);
  });
});
