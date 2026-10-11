// W28: the construction hover readout (render/siteReadout.ts) over snapshot pairs. A gun turret
// costs 200 mass, 600 energy and no rare (model/data/map1.ts), the cost world.ts workOf charges.

import { describe, expect, it } from 'vitest';
import { B, BUILDING_INFO, U } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_STARTED, BF_UPGRADING } from '../src/sim/schema.ts';
import type { Snapshot } from '../src/sim/snapshot.ts';
import { siteReadout } from '../src/render/siteReadout.ts';
import { flatWorld } from './fixtures.ts';
import { snapshotOf } from './w24r2a-fixtures.ts';

/** Two snapshots of a world with one gun site and its engineer, and the site's id and rows. */
function gunPair() {
  const w = flatWorld(30, 30, { rich: true });
  const e = w.spawnUnit(U.engineer, 10.5, 13.5);
  w.enqueue({ t: 'build', ids: [e], kind: B.gun, tx: 10, ty: 10 });
  w.step();
  const a = snapshotOf(w);
  const b = snapshotOf(w);
  const r = a.buildings.cols.kind.subarray(0, a.buildings.count).indexOf(B.gun);
  expect(r, 'the gun site').toBeGreaterThanOrEqual(0);
  return { a, b, id: a.buildings.id[r]!, r };
}

/** Sets the site's flags, tier and progress on a snapshot, and its tick. */
function at(s: Snapshot, r: number, tick: number, progress: number, flags = BF_STARTED, tier = 1, builders = 1) {
  s.tick = tick;
  s.buildings.cols.flags[r] = flags;
  s.buildings.cols.tier[r] = tier;
  s.buildings.cols.progress[r] = progress;
  s.buildings.cols.builders[r] = builders;
}

describe('W28: construction hover readout', () => {
  it('a gun site advancing 0.1 over 1 game second takes in 20 mass/s and 60 energy/s; rare (no cost) is not listed', () => {
    const { a, b, id, r } = gunPair();
    at(a, r, 100, 0.2, BF_STARTED, 1, 2);
    at(b, r, 110, 0.3, BF_STARTED, 1, 2);
    const o = siteReadout(a, b, id)!;
    expect(o).not.toBeNull();
    expect(o.intake.map((i) => i.resource)).toEqual(['mass', 'energy']);
    expect(o.intake[0]!.perSecond).toBeCloseTo(20, 3);
    expect(o.intake[1]!.perSecond).toBeCloseTo(60, 3);
    expect(o.percent).toBe(30);
    expect(o.builders).toBe(2);
    // W24 run 3 (D2): "<resource> <received> / <wanted> per s"; the one engineer working wants 6.7 mass/s
    expect(o.lines).toEqual(['Gun turret', '30% complete', 'mass 20 / 6.7 per s', 'energy 60 / 20 per s', '2 builders']);
  });

  it('a starved pair (no progress between the snapshots) shows 0/s', () => {
    const { a, b, id, r } = gunPair();
    at(a, r, 100, 0.25);
    at(b, r, 103, 0.25);
    const o = siteReadout(a, b, id)!;
    expect(o.intake.map((i) => i.perSecond)).toEqual([0, 0]);
    expect(o.lines).toContain('mass 0 / 6.7 per s');
    expect(o.lines).toContain('energy 0 / 20 per s');
    expect(o.lines).toContain('1 builder');
  });

  it('a reserved site reads "reserved — not started"', () => {
    const { a, b, id, r } = gunPair();
    at(a, r, 100, 0, 0, 1, 0);
    at(b, r, 101, 0, 0, 1, 0);
    const o = siteReadout(a, b, id)!;
    expect(o.reserved).toBe(true);
    expect(o.lines[1]).toBe('reserved — not started');
    expect(o.lines).not.toContain('0% complete');
  });

  it('an upgrade names the tier it leads to and uses the upgrade cost', () => {
    const { a, b, id, r } = gunPair();
    const up = BUILDING_INFO.gun.tiers![0]!.cost; // tier 1 → 2
    expect(up).not.toEqual(BUILDING_INFO.gun.cost);
    const f = BF_STARTED | BF_COMPLETE | BF_UPGRADING;
    at(a, r, 200, 0.4, f, 1);
    at(b, r, 220, 0.5, f, 1);
    const o = siteReadout(a, b, id)!;
    expect(o.lines[0]).toBe('Gun turret — upgrading to tier 2');
    expect(o.upgradeTo).toBe(2);
    const names = ['mass', 'energy', 'rare'] as const;
    expect(o.intake.map((i) => i.resource)).toEqual(names.filter((_, k) => up[k]! > 0));
    o.intake.forEach((i) => expect(i.perSecond!).toBeCloseTo((up[names.indexOf(i.resource)]! * 0.1) / 2, 3));
    // a complete building that is not upgrading is not a site
    at(b, r, 220, 1, BF_STARTED | BF_COMPLETE, 1);
    expect(siteReadout(a, b, id)).toBeNull();
  });

  it('a paused pair (equal ticks) shows "paused" and never divides by zero', () => {
    const { a, b, id, r } = gunPair();
    at(a, r, 150, 0.5);
    at(b, r, 150, 0.5);
    const o = siteReadout(a, b, id)!;
    expect(o.intakeNote).toBe('paused');
    expect(o.intake.every((i) => i.perSecond === null)).toBe(true);
    for (const line of o.lines) expect(line).not.toMatch(/NaN|Infinity/);
    expect(o.lines).toContain('mass paused / 6.7 per s');
    // no earlier snapshot, or one from another piece of work: "measuring", not a figure
    expect(siteReadout(null, b, id)!.intakeNote).toBe('measuring');
    at(a, r, 140, 0.9, BF_STARTED | BF_COMPLETE | BF_UPGRADING, 1);
    expect(siteReadout(a, b, id)!.intakeNote).toBe('measuring');
  });

  it('on a running world the figure is what the simulation spent: cost × Δprogress ÷ Δseconds', () => {
    const w = flatWorld(30, 30);
    w.pool.set([1e6, 1e6, 0]);
    const e = w.spawnUnit(U.engineer, 10.5, 13.5);
    w.enqueue({ t: 'build', ids: [e], kind: B.gun, tx: 10, ty: 10 });
    let prev = snapshotOf(w);
    let id = -1;
    let seen = 0;
    for (let t = 0; t < 200 && seen < 5; t++) {
      const before = w.pool[0]!;
      w.step();
      const spent = before - w.pool[0]!; // no commander, so no income: the change is what construction spent
      const curr = snapshotOf(w);
      const r = curr.buildings.cols.kind.subarray(0, curr.buildings.count).indexOf(B.gun);
      if (r < 0) continue;
      id = curr.buildings.id[r]!;
      const o = siteReadout(prev, curr, id);
      if (o && !o.intakeNote && o.intake[0]!.perSecond! > 0) {
        // one tick of 0.1 s: the mass spent that tick is the mass rate × 0.1
        expect(o.intake[0]!.perSecond! * 0.1).toBeCloseTo(spent, 2);
        seen++;
      }
      prev = curr;
    }
    expect(seen, `samples of gun ${id} while it was built`).toBe(5);
  });
});
