// Headless full map 1 (M3 verify 2): W12's balanced plan, played with real commands on real tiles
// (test/plans.ts), survives all 20 waves; the same economy with no defences loses its commander.

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/scenarios.ts';
import { BALANCED, NO_DEFENCE, drive } from './plans.ts';

const mmss = (ticks: number) => `${Math.floor(ticks / 600)}:${String(Math.floor((ticks % 600) / 10)).padStart(2, '0')}`;

describe('full map 1, headless', () => {
  it('the balanced plan wins', { timeout: 600_000 }, () => {
    const w = createWorld(1, 'map1');
    const r = drive(w, BALANCED);
    console.log(`balanced: outcome ${r.outcome} at ${mmss(r.endTick)}, wave ${r.wave}/20, commander ${r.commanderHp.toFixed(0)}/6000 hp, kills ${r.kills}, buildings lost ${r.buildingsLost}, units lost ${r.unitsLost}, parts made ${r.partsMade} used ${r.partsUsed}`);
    expect(r.outcome).toBe(2);
    expect(r.wave).toBe(20);
    expect(r.commanderHp).toBeGreaterThan(0);
    expect(r.skipped).toEqual([]);
    expect(r.partsUsed).toBeGreaterThan(0); // the salvage chain fed the heavy cannons
  });

  it('the same economy with no defences loses to commander death', { timeout: 600_000 }, () => {
    const w = createWorld(1, 'map1');
    const r = drive(w, NO_DEFENCE);
    console.log(`no defence: outcome ${r.outcome} at ${mmss(r.endTick)}, wave ${r.wave}/20, buildings ${w.buildings.count} standing`);
    expect(r.outcome).toBe(1);
    expect(w.commanderSlot()).toBe(-1);
  });
});
