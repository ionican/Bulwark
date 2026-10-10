// W24 run 3: two rules the render thread re-states because it may not import their sim modules
// (test/w24r2a-imports): the snapshot's research-done global (snapshotRules.ts) and a gate's
// corridor column (render/picking.ts). Each must agree with the simulation's own.

import { describe, expect, it } from 'vitest';
import { G_RESEARCH_DONE, decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { inGateCorridor } from '../src/sim/gate.ts';
import { RESEARCH_INDEX } from '../src/sim/balance.ts';
import { U } from '../src/sim/kinds.ts';
import { unitBuildRate } from '../src/sim/tuning.ts';
import { RESEARCH_DONE_GLOBAL, snapshotRules } from '../src/snapshotRules.ts';
import { gateCorridorTile } from '../src/render/picking.ts';
import { flatWorld } from './fixtures.ts';

describe('run 3: rules re-stated on the render thread agree with the simulation', () => {
  it('the research-done global index, and the rules read from a snapshot', () => {
    expect(RESEARCH_DONE_GLOBAL).toBe(G_RESEARCH_DONE);
    const w = flatWorld(20, 20);
    w.completeResearch(RESEARCH_INDEX.fieldEng!);
    const s = decodeSnapshot(encodeSnapshot(w));
    const r = snapshotRules(s);
    expect(r.researched('fieldEng')).toBe(true);
    expect(unitBuildRate(r, U.engineer)).toBe(unitBuildRate(w, U.engineer));
  });

  it('a gate corridor column', () => {
    for (const dir of [0, 1])
      for (let x = 8; x < 14; x++) for (let z = 8; z < 14; z++) expect(gateCorridorTile(10, 10, dir, x, z), `${dir} ${x} ${z}`).toBe(inGateCorridor(10, 10, dir, x, z));
  });
});
