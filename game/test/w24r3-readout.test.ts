// W24 run 3, criterion 9 (D2, Codex R1-14, R1-15; Richard 2026-10-10: "mass 0.5 / 20 per s"). The
// W28 construction hover readout shows, per resource with a cost, what the site received of what it
// wants: "<resource> <received> / <wanted> per s". Wanted is the rate at full supply: the cost ×
// the summed effective build power of the units working on it ÷ its build time, with the
// simulation's own multipliers (tuning.ts unitBuildRate: kind × Field Engineering × the buildRate
// tune; kinds.ts siteWork for cost and time). Working units are those whose `work` field decodes
// (id + 1) to the site. None: "no builder". Received keeps W28's snapshot-pair figure.
// Fixtures are real worlds stepped tick by tick (one engineer, two, with Field Engineering, with a
// buildRate tune), not synthetic progress edits. received ≤ wanted (1 % tolerance) is asserted only
// on stable intervals: the same working units and tuning in both snapshots of the pair.

import { describe, expect, it } from 'vitest';
import { B, BUILDING_INFO, U, UNIT_INFO } from '../src/sim/kinds.ts';
import { RESEARCH_INDEX } from '../src/sim/balance.ts';
import { TU_BUILD_RATE, setTune } from '../src/sim/tuning.ts';
import { formatRate, siteReadout } from '../src/render/siteReadout.ts';
import type { World } from '../src/sim/world.ts';
import { flatWorld } from './fixtures.ts';
import { snapshotOf } from './w24r2a-fixtures.ts';

const COST = BUILDING_INFO.gun.cost; // mass, energy, rare
const TIME = BUILDING_INFO.gun.buildTime;
const BP = UNIT_INFO.engineer.buildRate;

/** A gun site at (10, 10) with `n` engineers standing in range; `prep` changes the world first. */
function world(n: number, prep: (w: World) => void = () => {}) {
  const w = flatWorld(30, 30, { rich: true });
  prep(w);
  const ids = Array.from({ length: n }, (_, i) => w.spawnUnit(U.engineer, 9.5 + i, 13.2));
  if (n) w.enqueue({ t: 'build', ids, kind: B.gun, tx: 10, ty: 10, dir: 0 });
  else w.placeBuilding(B.gun, 10, 10, false);
  return w;
}

/** Steps the world and returns every snapshot pair's readout for the gun site (while it is a site). */
function readouts(w: World, ticks = 60) {
  let prev = snapshotOf(w);
  const out = [];
  for (let t = 0; t < ticks; t++) {
    w.step();
    const curr = snapshotOf(w);
    const r = curr.buildings.cols.kind.subarray(0, curr.buildings.count).indexOf(B.gun);
    if (r >= 0) {
      const o = siteReadout(prev, curr, curr.buildings.id[r]!);
      if (o) out.push(o);
    }
    prev = curr;
  }
  return out;
}

function wantedMass(builders: number, mult = 1) {
  return (COST[0]! * builders * BP * mult) / TIME;
}

describe('run 3 criterion 9: received / wanted per s', () => {
  it('one engineer: wanted = cost × build power ÷ build time; the line reads "mass <received> / <wanted> per s"', () => {
    const rs = readouts(world(1)).filter((o) => o.working === 1 && !o.intakeNote);
    expect(rs.length).toBeGreaterThan(10);
    for (const o of rs) {
      const mass = o.intake.find((i) => i.resource === 'mass')!;
      expect(mass.wanted).toBeCloseTo(wantedMass(1), 6);
      const energy = o.intake.find((i) => i.resource === 'energy')!;
      expect(energy.wanted).toBeCloseTo((COST[1]! * BP) / TIME, 6);
      expect(o.lines).toContain(`mass ${formatRate(mass.perSecond!)} / ${formatRate(mass.wanted!)} per s`);
    }
    // fully supplied (rich), most intervals receive what they want
    expect(rs.filter((o) => Math.abs(o.intake[0]!.perSecond! - o.intake[0]!.wanted!) <= o.intake[0]!.wanted! * 0.01).length).toBeGreaterThan(rs.length / 2);
  });

  it('two engineers want twice as much', () => {
    const rs = readouts(world(2)).filter((o) => o.working === 2 && !o.intakeNote);
    expect(rs.length).toBeGreaterThan(5);
    for (const o of rs) expect(o.intake[0]!.wanted).toBeCloseTo(wantedMass(2), 6);
  });

  it('Field Engineering (1.5×) and a buildRate tune (2×) multiply what one engineer wants', () => {
    const fe = readouts(world(1, (w) => w.completeResearch(RESEARCH_INDEX.fieldEng!))).filter((o) => o.working === 1 && !o.intakeNote);
    expect(fe.length).toBeGreaterThan(5);
    for (const o of fe) expect(o.intake[0]!.wanted).toBeCloseTo(wantedMass(1, 1.5), 6);
    const tuned = readouts(world(1, (w) => setTune(w, 'unit', U.engineer, TU_BUILD_RATE, 2))).filter((o) => o.working === 1 && !o.intakeNote);
    expect(tuned.length).toBeGreaterThan(5);
    for (const o of tuned) expect(o.intake[0]!.wanted).toBeCloseTo(wantedMass(1, 2), 6);
  });

  it('no unit working on the site: "no builder"', () => {
    const rs = readouts(world(0), 5);
    expect(rs.length).toBeGreaterThan(0);
    for (const o of rs) {
      expect(o.working).toBe(0);
      expect(o.intake.every((i) => i.wanted === null)).toBe(true);
      expect(o.lines.some((l) => /^mass .* \/ no builder$/.test(l)), o.lines.join(' | ')).toBe(true);
    }
  });

  it('received ≤ wanted (1 %) on every stable interval; the readout says which intervals are stable', () => {
    // a second engineer joins part-way: the intervals round the change are not stable
    const w = world(1);
    const late = w.spawnUnit(U.engineer, 14.5, 25.5);
    const rs = readouts(w, 8);
    w.enqueue({ t: 'assist', ids: [late], target: rs[rs.length - 1]!.id });
    rs.push(...readouts(w, 80));
    const stable = rs.filter((o) => o.stable && !o.intakeNote);
    expect(stable.length).toBeGreaterThan(20);
    expect(rs.some((o) => !o.stable), 'the join is an unstable interval').toBe(true);
    expect(stable.some((o) => o.working === 2)).toBe(true);
    for (const o of stable) for (const i of o.intake) expect(i.perSecond!, `${i.resource} received`).toBeLessThanOrEqual(i.wanted! * 1.01 + 1e-9);
  });
});
