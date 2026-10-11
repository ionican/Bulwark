// W24 run 3: the simulation's rule accessors (tuning.ts) read from a snapshot on the main thread
// (snapshotRules.ts) agree with the same accessors on the world. (The research-done index and the
// gate corridor rule are no longer copied into render code: schema.ts holds G_RESEARCH_DONE and
// picking imports sim/gate.ts, both pure modules.)

import { describe, expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { RESEARCH_INDEX } from '../src/sim/balance.ts';
import { U } from '../src/sim/kinds.ts';
import { unitBuildRate } from '../src/sim/tuning.ts';
import { snapshotRules } from '../src/snapshotRules.ts';
import { flatWorld } from './fixtures.ts';

describe('run 3: rules read from a snapshot agree with the simulation', () => {
  it('research and tuning read from a snapshot', () => {
    const w = flatWorld(20, 20);
    w.completeResearch(RESEARCH_INDEX.fieldEng!);
    const s = decodeSnapshot(encodeSnapshot(w));
    const r = snapshotRules(s);
    expect(r.researched('fieldEng')).toBe(true);
    expect(unitBuildRate(r, U.engineer)).toBe(unitBuildRate(w, U.engineer));
  });
});
