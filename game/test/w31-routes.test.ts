// W31 (PLAN-W31 test 13): the scripted plans' belt router (test/beltRoute.ts) plans every route at a
// belt speed, and a section's capacity is that speed's (10 ÷ ticks per tile items a second: Slow
// 1.67, Medium 2.5, Fast 3.33). It accepts a join only if the combined peak producer output of
// everything downstream of it fits each downstream tile's capacity. Map 1's plans lay Slow belts.

import { describe, expect, it } from 'vitest';
import { B, BDX as DX, BDZ as DZ } from '../src/sim/kinds.ts';
import { beltRoutesToCore, lineCapacity, type RouteReport } from './beltRoute.ts';
import { BALANCED } from './plans.ts';
import { createWorld } from '../src/sim/scenarios.ts';
import { flatWorld } from './fixtures.ts';

/** Core at (30–32, 18–20); mass extractor A at (10, 19) east of which a line runs along z = 19; mass extractor B at (15, 21), whose north side faces A's line. */
function world() {
  const w = flatWorld(40, 40, { belts: true, terrain: { deposits: [{ tx: 10, ty: 19, kind: 'mass' }, { tx: 15, ty: 21, kind: 'mass' }] } });
  w.placeBuilding(B.core, 30, 18, true);
  const ex: Array<[number, number, number]> = [
    [B.massExtractor, 10, 19],
    [B.massExtractor, 15, 21],
  ];
  return { w, ex };
}
const intoCore = (route: Array<[number, number, number]>) => {
  const [x, z, d] = route[route.length - 1]!;
  const nx = x + DX[d]!;
  const nz = z + DZ[d]!;
  return nx >= 30 && nx < 33 && nz >= 18 && nz < 21;
};

describe('W31 belt routes by planned speed (test 13)', () => {
  it('section capacity per speed: Slow 10/6, Medium 2.5, Fast 10/3 items a second', () => {
    expect(typeof lineCapacity, 'lineCapacity').toBe('function');
    expect(lineCapacity(1)).toBeCloseTo(10 / 6, 9);
    expect(lineCapacity(2)).toBeCloseTo(2.5, 9);
    expect(lineCapacity(3)).toBeCloseTo(10 / 3, 9);
  });

  it('two boosted mass extractors (2.5 items/s) may not share a Slow section: the second runs into the core; at Medium or Fast it joins the first line', () => {
    for (const tier of [1, 2, 3]) {
      const { w, ex } = world();
      const report: RouteReport = { joins: [] };
      const [a, b] = beltRoutesToCore(w, ex, { join: 'nearest', tier, report });
      expect(a && intoCore(a), `tier ${tier}: A into the core`).toBe(true);
      expect(b, `tier ${tier}: B has a route`).not.toBeNull();
      if (tier === 1) {
        expect(intoCore(b!), 'Slow: B runs into the core on its own').toBe(true);
        expect(report.joins).toEqual([]);
      } else {
        expect(intoCore(b!), `tier ${tier}: B joins A's line`).toBe(false);
        expect(b!.length, `tier ${tier}: one tile, from B's north side into A's line`).toBe(1);
        expect(report.joins.length).toBe(1);
        const j = report.joins[0]!;
        expect(j.route).toBe(1);
        for (const [k, load] of j.loads.entries()) {
          expect(load).toBeCloseTo(2.5, 9);
          expect(load).toBeLessThanOrEqual(j.capacities[k]! + 1e-9);
        }
      }
    }
  });

  it('the balanced plan’s routes, planned Slow, all pass the check: every join is reported, and its combined downstream load fits each section’s capacity', () => {
    // the plan's extractors and footprints, as plans.ts withBelts routes them
    const planned: Array<[number, number, number]> = [];
    const extractors: Array<[number, number, number]> = [];
    for (const s of BALANCED) {
      if (!('build' in s.act) || s.act.build === B.belt) continue;
      planned.push([s.act.build, s.act.at[0], s.act.at[1]]);
      if (s.act.build === B.massExtractor || s.act.build === B.rareExtractor) extractors.push([s.act.build, s.act.at[0], s.act.at[1]]);
    }
    const w = createWorld(1, 'map1');
    const report: RouteReport = { joins: [] };
    const routes = beltRoutesToCore(w, extractors, { planned, join: 'nearest', tier: 1, report });
    expect(routes.every((r) => r !== null)).toBe(true);
    // the routes are the plan's belts
    const laid = new Set(BALANCED.filter((s) => 'build' in s.act && s.act.build === B.belt).map((s) => ('build' in s.act ? `${s.act.at},${s.act.dir}` : '')));
    for (const r of routes) for (const [x, z, d] of r!) expect(laid.has(`${x},${z},${d}`), `${x},${z} → ${d} is a plan belt`).toBe(true);
    const c = w.buildings.cols;
    const core = w.buildings.slotForId(w.coreId);
    const joining = routes.filter((r) => {
      const [x, z, d] = r![r!.length - 1]!;
      const nx = x + DX[d]!;
      const nz = z + DZ[d]!;
      return !(nx >= c.tx[core]! && nx < c.tx[core]! + 3 && nz >= c.ty[core]! && nz < c.ty[core]! + 3);
    }).length;
    expect(report.joins.length, `joins reported (${joining} routes end on another line)`).toBe(joining);
    for (const j of report.joins) {
      expect(j.capacities.every((cap) => Math.abs(cap - 10 / 6) < 1e-9), `route ${j.route}: planned Slow`).toBe(true);
      j.loads.forEach((load, k) => expect(load, `route ${j.route} at ${j.at}: tile ${k} downstream`).toBeLessThanOrEqual(j.capacities[k]! + 1e-9));
    }
  });
});
