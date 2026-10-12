// W31 (PLAN-W31 tests 6–9): laying belts at a speed, their costs, reserved-site identity with the
// speed in it, and the drag-upgrade command (one command per drag, `{ id, expectedTier }` per
// target, whole-batch queue capacity checked before any upgrade flag is set).

import { describe, expect, it } from 'vitest';
import type { Command } from '../src/sim/commands.ts';
import { B, U, siteWork } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_UPGRADING, isReserved } from '../src/sim/schema.ts';
import { MAX_ORDERS, type World } from '../src/sim/world.ts';
import { SimRunner, type CommandResult } from '../src/sim/runner.ts';
import { deserializeWorld, serializeWorld } from '../src/sim/save.ts';
import { encodeSnapshot, decodeSnapshot } from '../src/sim/snapshot.ts';
import { ownReservedSite, worldSiteSource } from '../src/sim/queue.ts';
import { placeableOn, snapshotSiteSource, type DragView } from '../src/dragPlan.ts';
import { buildOccupancy } from '../src/render/picking.ts';
import { flatWorld } from './fixtures.ts';
import { research, setTier } from './w31-fixtures.ts';

/** A refusal reason, or '(accepted)' (so a reason test fails as an assertion on an accepted command). */
const why = (r: string | null) => r ?? '(accepted)';
const slotOf = (w: World, id: number) => w.buildings.slotForId(id);
const tierOf = (w: World, id: number) => w.buildings.cols.tier[slotOf(w, id)]!;
const flagsOf = (w: World, id: number) => w.buildings.cols.flags[slotOf(w, id)]!;
const orderList = (w: World, unit: number) => (w.orders[w.units.slotForId(unit)] ?? []).map((o) => ({ ...o }));
/** A complete belt at (x, z) facing +x at `tier`. */
function belt(w: World, x: number, z: number, tier: number, dir = 0): number {
  const id = w.placeBuilding(B.belt, x, z, true, dir);
  expect(id, `belt at ${x},${z}`).toBeGreaterThanOrEqual(0);
  setTier(w, id, tier);
  return id;
}
function steps(w: World, n: number) {
  for (let i = 0; i < n; i++) w.step();
}
/** Steps until `done` holds (at most `max` ticks); returns the ticks taken. */
function until(w: World, done: () => boolean, max = 2000): number {
  for (let t = 0; t < max; t++) {
    if (done()) return t;
    w.step();
  }
  throw new Error(`not done after ${max} ticks`);
}

describe('W31 tier validation (test 6)', () => {
  const world = () => {
    const w = flatWorld(40, 40, { rich: true });
    const eng = w.spawnUnit(U.engineer, 10.5, 10.5);
    return { w, eng };
  };
  const build = (eng: number, tier: unknown, kind = B.belt, x = 12): Command => ({ t: 'build', ids: [eng], kind, tx: x, ty: 12, dir: 0, tier } as unknown as Command);

  it('build at Medium or Fast is refused until its research is done (the reason names it), then accepted', () => {
    const { w, eng } = world();
    expect(why(w.submit(build(eng, 1)))).toBe('(accepted)');
    expect(why(w.submit(build(eng, 2, B.belt, 13)))).toMatch(/"Medium belts"/);
    expect(why(w.submit(build(eng, 3, B.belt, 14)))).toMatch(/"Fast belts"/);
    research(w, 'beltMedium');
    expect(why(w.submit(build(eng, 2, B.belt, 13)))).toBe('(accepted)');
    expect(why(w.submit(build(eng, 3, B.belt, 14)))).toMatch(/"Fast belts"/);
    research(w, 'beltFast');
    expect(why(w.submit(build(eng, 3, B.belt, 14)))).toBe('(accepted)');
  });

  it('upgrading a belt to Medium, then to Fast, is refused until each research is done', () => {
    const { w, eng } = world();
    const id = belt(w, 12, 12, 1);
    expect(why(w.submit({ t: 'upgrade', ids: [eng], target: id }))).toMatch(/"Medium belts"/);
    research(w, 'beltMedium');
    expect(why(w.submit({ t: 'upgrade', ids: [eng], target: id }))).toBe('(accepted)');
    const fast = belt(w, 14, 12, 2);
    expect(why(w.submit({ t: 'upgrade', ids: [eng], target: fast }))).toMatch(/"Fast belts"/);
    research(w, 'beltFast');
    expect(why(w.submit({ t: 'upgrade', ids: [eng], target: fast }))).toBe('(accepted)');
    const top = belt(w, 16, 12, 3);
    expect(why(w.submit({ t: 'upgrade', ids: [eng], target: top }))).toMatch(/top tier|Fast/);
  });

  it('research for Fast belts is refused before Medium belts (the reason names it)', () => {
    const { w } = world();
    expect(why(w.submit({ t: 'research', node: 'beltFast' }))).toMatch(/"Medium belts"/);
    expect(why(w.submit({ t: 'research', node: 'beltMedium' }))).toBe('(accepted)');
  });

  it('tiers 0, 4, 1.5, NaN, Infinity, a string, and any tier on another kind are refused, also with allTiers on', () => {
    for (const allTiers of [false, true]) {
      const { w, eng } = world();
      w.debug.allTiers = allTiers;
      research(w, 'beltMedium');
      research(w, 'beltFast');
      for (const t of [0, 4, 1.5, NaN, Infinity, -1, '2', null]) expect(why(w.submit(build(eng, t))), `tier ${String(t)} (allTiers ${allTiers})`).toMatch(/tier/);
      for (const [kind, t] of [
        [B.wall, 1],
        [B.wall, 2],
        [B.gun, 1],
        [B.splitter, 1],
        [B.merger, 3],
      ] as const)
        expect(why(w.submit(build(eng, t, kind, 20))), `tier ${t} on kind ${kind} (allTiers ${allTiers})`).toMatch(/tier/);
      // the debug place command takes the same tier rule
      expect(why(w.submit({ t: 'place', kind: B.belt, tx: 20, ty: 20, dir: 0, tier: 4 } as unknown as Command))).toMatch(/tier/);
      expect(why(w.submit({ t: 'place', kind: B.gun, tx: 20, ty: 20, dir: 0, tier: 2 } as unknown as Command))).toMatch(/tier/);
    }
  });

  it('allTiers lifts only the research: a Fast build is accepted without it', () => {
    const { w, eng } = world();
    w.debug.allTiers = true;
    expect(why(w.submit(build(eng, 3)))).toBe('(accepted)');
  });
});

describe('W31 costs (test 7)', () => {
  it('siteWork: Slow 0.5 mass / 4, Medium 1.5 / 8, Fast 3.5 / 12; upgrades Slow → Medium 1 mass / 4, Medium → Fast 2 / 4', () => {
    expect(siteWork(B.belt, false, 1, 1, 1)).toEqual({ cost: [0.5, 0, 0], time: 4 });
    expect(siteWork(B.belt, false, 2, 1, 1)).toEqual({ cost: [1.5, 0, 0], time: 8 });
    expect(siteWork(B.belt, false, 3, 1, 1)).toEqual({ cost: [3.5, 0, 0], time: 12 });
    expect(siteWork(B.belt, true, 1, 1, 1)).toEqual({ cost: [1, 0, 0], time: 4 });
    expect(siteWork(B.belt, true, 2, 1, 1)).toEqual({ cost: [2, 0, 0], time: 4 });
  });

  for (const [tier, mass, time] of [
    [1, 0.5, 4],
    [2, 1.5, 8],
    [3, 3.5, 12],
  ] as const) {
    it(`a belt site laid at tier ${tier} has build time ${time} and drains ${mass} mass by the time it is complete`, () => {
      const w = flatWorld(40, 40, { rich: true });
      research(w, 'beltMedium');
      research(w, 'beltFast');
      const eng = w.spawnUnit(U.engineer, 12.5, 13.5);
      expect(why(w.submit({ t: 'build', ids: [eng], kind: B.belt, tx: 12, ty: 12, dir: 0, tier } as Command))).toBe('(accepted)');
      // read before the first step: the engineer stands beside the tile and builds from that tick
      const spent0 = w.spentTotal[0]!;
      w.step();
      const s = w.occupancy[12 * 40 + 12]! - 1;
      expect(s, 'the site').toBeGreaterThanOrEqual(0);
      expect(w.buildings.cols.tier[s]).toBe(tier);
      expect(w.workOf(s).time).toBe(time);
      until(w, () => (w.buildings.cols.flags[s]! & BF_COMPLETE) !== 0);
      // progress is f32 (economy.ts PROGRESS_SNAP), so the drained total is within about 1e-6
      expect(w.spentTotal[0]! - spent0).toBeCloseTo(mass, 5);
      expect(w.buildings.cols.tier[s]).toBe(tier);
    });
  }

  for (const [from, mass] of [
    [1, 1],
    [2, 2],
  ] as const) {
    it(`an upgrade from tier ${from} drains ${mass} mass with time 4`, () => {
      const w = flatWorld(40, 40, { rich: true });
      research(w, 'beltMedium');
      research(w, 'beltFast');
      const eng = w.spawnUnit(U.engineer, 12.5, 13.5);
      const id = belt(w, 12, 12, from);
      const spent0 = w.spentTotal[0]!;
      expect(why(w.submit({ t: 'upgrade', ids: [eng], target: id }))).toBe('(accepted)');
      w.step();
      expect(w.workOf(slotOf(w, id)).time).toBe(4);
      until(w, () => tierOf(w, id) === from + 1);
      expect(w.spentTotal[0]! - spent0).toBeCloseTo(mass, 6);
      expect(flagsOf(w, id) & BF_UPGRADING).toBe(0);
    });
  }
});

describe('W31 reserved-site identity (test 8)', () => {
  /** A Slow belt site at (30, 20) reserved by engineer `a`, who stands far away (it stays reserved for a while). */
  function reserved() {
    const w = flatWorld(60, 40, { rich: true });
    research(w, 'beltMedium');
    research(w, 'beltFast');
    const a = w.spawnUnit(U.engineer, 2.5, 2.5);
    const b = w.spawnUnit(U.engineer, 3.5, 2.5);
    expect(why(w.submit({ t: 'build', ids: [a], kind: B.belt, tx: 30, ty: 20, dir: 0, tier: 1 } as Command))).toBe('(accepted)');
    w.step();
    const site = w.buildings.id(w.occupancy[20 * 60 + 30]! - 1);
    expect(isReserved(flagsOf(w, site))).toBe(true);
    return { w, a, b, site };
  }
  const fast = (ids: number[], queue: boolean): Command => ({ t: 'build', ids, kind: B.belt, tx: 30, ty: 20, dir: 0, tier: 3, queue } as Command);

  it('a shifted Fast build on the tile of the reserved Slow site is refused with a reason; the site and every queue stay', () => {
    const { w, a, site } = reserved();
    const before = orderList(w, a);
    expect(why(w.submit(fast([a], true)))).toMatch(/a Slow belt site is already planned here/);
    w.step();
    expect(slotOf(w, site)).toBeGreaterThanOrEqual(0);
    expect(tierOf(w, site)).toBe(1);
    expect(orderList(w, a)).toEqual(before);
  });

  it('an unshifted Fast build by the site’s only holder: its replace step frees the Slow site and a Fast site is placed', () => {
    const { w, a, site } = reserved();
    expect(why(w.submit(fast([a], false)))).toBe('(accepted)');
    w.step();
    expect(slotOf(w, site), 'the Slow site is gone').toBe(-1);
    const now = w.occupancy[20 * 60 + 30]! - 1;
    expect(now).toBeGreaterThanOrEqual(0);
    expect(w.buildings.cols.kind[now]).toBe(B.belt);
    expect(w.buildings.cols.tier[now]).toBe(3);
    expect(orderList(w, a).map((o) => (o.t === 'build' ? o.id : -1))).toEqual([w.buildings.id(now)]);
  });

  it('an unshifted Fast build is refused while another unit still holds the Slow site (nothing changes)', () => {
    const { w, a, b, site } = reserved();
    expect(why(w.submit({ t: 'assist', ids: [b], target: site }))).toBe('(accepted)');
    w.step();
    const qa = orderList(w, a);
    const qb = orderList(w, b);
    expect(why(w.submit(fast([a], false)))).toMatch(/a Slow belt site is already planned here/);
    w.step();
    expect(tierOf(w, site)).toBe(1);
    expect(orderList(w, a)).toEqual(qa);
    expect(orderList(w, b)).toEqual(qb);
  });

  it('tier is part of the identity on both threads: ownReservedSite finds the site at its own speed only (world and snapshot sources)', () => {
    const { w, a, site } = reserved();
    const snap = decodeSnapshot(encodeSnapshot(w));
    const c = snap.buildings.cols;
    const occupancy = buildOccupancy({ count: snap.buildings.count, id: snap.buildings.id, kind: c.kind, tx: c.tx, ty: c.ty, fw: c.fw, fh: c.fh }, 60, 40, new Int32Array(60 * 40));
    for (const src of [worldSiteSource(w), snapshotSiteSource(snap, occupancy)]) {
      expect(ownReservedSite(src, [a], B.belt, 30, 20, 0, false, 1)).toBe(site);
      expect(ownReservedSite(src, [a], B.belt, 30, 20, 0, false, 3)).toBe(-1);
    }
    // the main thread's click rule: unshifted over the own site at another speed may be sent (the replace step frees it), shifted not
    const view: DragView = { terrain: w.terrain, occupancy, kinds: snap.buildings.cols.kind, units: { count: snap.units.count, id: snap.units.id, x: snap.units.cols.x, z: snap.units.cols.z }, snapshot: snap };
    expect(placeableOn(view, [a], B.belt, 30, 20, 0, false)).toBe(true);
    expect(placeableOn(view, [a], B.belt, 30, 20, 0, true)).toBe(false);
  });

  it('a save with a belt tier of 0 or 4 fails to load with a named error (no silent clamp)', () => {
    for (const bad of [0, 4]) {
      const w = flatWorld(30, 30, { belts: true });
      const id = belt(w, 5, 5, 1);
      w.buildings.cols.tier[slotOf(w, id)] = bad;
      const bytes = serializeWorld(w);
      let err: unknown = null;
      try {
        deserializeWorld(bytes);
      } catch (e) {
        err = e;
      }
      expect(err, `tier ${bad}`).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('SaveBeltTierError');
      expect((err as Error).message).toMatch(new RegExp(`tier ${bad}`));
    }
  });
});

describe('W31 drag-upgrade command (test 9)', () => {
  type Target = { id: number; expectedTier: number };
  const batch = (ids: number[], targets: Target[], queue = false): Command => ({ t: 'upgradeBelts', ids, targets, queue } as unknown as Command);
  /** A line of `n` Slow belts at z = 10 from x = 4, two engineers beside it, both belt researches done. */
  function world(n = 10, mapW = 40) {
    const w = flatWorld(mapW, 30, { rich: true });
    research(w, 'beltMedium');
    research(w, 'beltFast');
    const ids: number[] = [];
    for (let k = 0; k < n; k++) ids.push(belt(w, 4 + k, 10, 1));
    const e1 = w.spawnUnit(U.engineer, 8.5, 12.5);
    const e2 = w.spawnUnit(U.engineer, 9.5, 12.5);
    return { w, ids, e1, e2 };
  }
  /** Runs a tracked command through a SimRunner; returns its final result after `n` ticks. */
  function tracked(w: World, cmd: Command, n = 1): CommandResult | string {
    const runner = new SimRunner(w, 0);
    const out: CommandResult[] = [];
    runner.onResult = (r) => out.push(r);
    const refused = runner.submitTracked(cmd, 7);
    if (refused) return refused;
    for (let i = 0; i < n && !out.length; i++) runner.stepOnce();
    return out[0] ?? 'no result';
  }

  /** The test's ten targets: six Slow belts, a splitter, a Fast belt, a duplicate and a belt already upgrading. */
  function mixedTargets() {
    const { w, ids, e1, e2 } = world(9);
    const splitter = w.placeBuilding(B.splitter, 14, 12, true, 0);
    setTier(w, ids[6]!, 3);
    // ids[7] already upgrading (a single upgrade by e2, applied)
    expect(why(w.submit({ t: 'upgrade', ids: [e2], target: ids[7]! }))).toBe('(accepted)');
    w.step();
    expect(flagsOf(w, ids[7]!) & BF_UPGRADING).not.toBe(0);
    const targets: Target[] = [
      ...ids.slice(0, 6).map((id) => ({ id, expectedTier: 1 })),
      { id: splitter, expectedTier: 1 },
      { id: ids[6]!, expectedTier: 3 },
      { id: ids[2]!, expectedTier: 1 },
      { id: ids[7]!, expectedTier: 1 },
    ];
    return { w, ids, e1, e2, targets, splitter };
  }

  it('one command over 10 targets: 6 upgrades queued, the splitter, the Fast belt, the duplicate and the one upgrading skipped with counts; unshifted replaces the queue; engineers finish and all 6 read Medium', () => {
    const { w, ids, e1, targets } = mixedTargets();
    w.enqueue({ t: 'move', ids: [e1], x: 30.5, z: 25.5, queue: false });
    w.step();
    expect(orderList(w, e1).map((o) => o.t)).toEqual(['move']);
    const r = tracked(w, batch([e1], targets, false));
    expect(typeof r, `refused: ${String(r)}`).toBe('object');
    const res = r as CommandResult;
    expect(res.ok).toBe(true);
    expect(res.detail).toMatchObject({ upgrades: 6, toMedium: 6, toFast: 0, skipped: { duplicate: 1, notBelt: 1, top: 1, upgrading: 1, gone: 0, changed: 0, locked: 0 } });
    // unshifted: the move went; one build order per upgraded belt, in drag order
    expect(orderList(w, e1).map((o) => (o.t === 'build' ? o.id : o.t))).toEqual(ids.slice(0, 6));
    for (const id of ids.slice(0, 6)) expect(flagsOf(w, id) & BF_UPGRADING, `belt ${id} upgrading`).not.toBe(0);
    until(w, () => ids.slice(0, 6).every((id) => tierOf(w, id) === 2 && !(flagsOf(w, id) & BF_UPGRADING)), 3000);
    expect(ids.slice(0, 6).map((id) => tierOf(w, id))).toEqual([2, 2, 2, 2, 2, 2]);
    expect(tierOf(w, ids[6]!)).toBe(3);
  });

  it('Shift appends the upgrades to the queue', () => {
    const { w, ids, e1, targets } = mixedTargets();
    w.enqueue({ t: 'move', ids: [e1], x: 30.5, z: 25.5, queue: false });
    w.step();
    const r = tracked(w, batch([e1], targets, true)) as CommandResult;
    expect(r.ok).toBe(true);
    expect(orderList(w, e1).map((o) => (o.t === 'build' ? o.id : o.t))).toEqual(['move', ...ids.slice(0, 6)]);
  });

  it('capacity: an engineer with 60 queued orders and a 10-target batch is refused, no upgrade flag changed; a drag of 65 targets is refused the same way', () => {
    const { w, ids, e1 } = world(10);
    for (let k = 0; k < 60; k++) w.enqueue({ t: 'move', ids: [e1], x: 20.5 + (k % 5), z: 20.5, queue: true });
    w.step();
    expect(orderList(w, e1).length).toBe(60);
    const ten = ids.map((id) => ({ id, expectedTier: 1 }));
    expect(why(w.submit(batch([e1], ten, true)))).toMatch(/queue/);
    for (const id of ids) expect(flagsOf(w, id) & BF_UPGRADING).toBe(0);
    // applied without validation at submit (enqueue), the apply-time check refuses it too
    w.enqueue(batch([e1], ten, true));
    w.step();
    for (const id of ids) expect(flagsOf(w, id) & BF_UPGRADING).toBe(0);
    expect(orderList(w, e1).length).toBe(60);

    const big = world(MAX_ORDERS + 1, 80);
    const all = big.ids.map((id) => ({ id, expectedTier: 1 }));
    expect(all.length).toBe(65);
    expect(why(big.w.submit(batch([big.e1], all, false)))).toMatch(/queue/);
    big.w.enqueue(batch([big.e1], all, false));
    big.w.step();
    for (const id of big.ids) expect(flagsOf(big.w, id) & BF_UPGRADING).toBe(0);
  });

  it('a target destroyed before the command applies is skipped and counted', () => {
    const { w, ids, e1 } = world(4);
    const runner = new SimRunner(w, 0);
    const out: CommandResult[] = [];
    runner.onResult = (r) => out.push(r);
    const cmd = batch([e1], ids.map((id) => ({ id, expectedTier: 1 })));
    // validated now, applied 5 ticks later
    const s = w.submitCommand(cmd, w.tick + 5);
    expect(typeof s).toBe('object');
    (runner as unknown as { tracked: Map<unknown, number> }).tracked.set(s, 1);
    w.removeBuilding(slotOf(w, ids[1]!));
    for (let i = 0; i < 6; i++) runner.stepOnce();
    expect(out[0]?.ok).toBe(true);
    expect(out[0]?.detail).toMatchObject({ upgrades: 3, skipped: { gone: 1 } });
    for (const id of [ids[0]!, ids[2]!, ids[3]!]) expect(flagsOf(w, id) & BF_UPGRADING).not.toBe(0);
  });

  it('a target whose competing upgrade to Medium completes before the command applies is skipped, not sent on to Fast', () => {
    const { w, ids, e1, e2 } = world(3);
    const cmd = batch([e1], ids.map((id) => ({ id, expectedTier: 1 })));
    expect(typeof w.submitCommand(cmd, w.tick + 400)).toBe('object');
    expect(why(w.submit({ t: 'upgrade', ids: [e2], target: ids[0]! }))).toBe('(accepted)');
    until(w, () => tierOf(w, ids[0]!) === 2, 390);
    expect(w.tick).toBeLessThan(400);
    steps(w, 400 - w.tick + 1);
    expect(tierOf(w, ids[0]!)).toBe(2);
    expect(flagsOf(w, ids[0]!) & BF_UPGRADING, 'not sent on to Fast').toBe(0);
    expect(flagsOf(w, ids[1]!) & BF_UPGRADING).not.toBe(0);
    expect(orderList(w, e1).some((o) => o.t === 'build' && o.id === ids[0])).toBe(false);
  });

  it('a command whose targets are all skipped changes nothing: no queue is cleared, shifted or not', () => {
    for (const queue of [false, true]) {
      const { w, ids, e1 } = world(3);
      for (const id of ids) setTier(w, id, 3);
      w.enqueue({ t: 'move', ids: [e1], x: 30.5, z: 25.5, queue: false });
      w.step();
      const before = orderList(w, e1);
      const cmd = batch([e1], ids.map((id) => ({ id, expectedTier: 3 })), queue);
      expect(why(w.submit(cmd)), 'refused when sent').toMatch(/nothing to upgrade/);
      w.enqueue(cmd);
      w.step();
      expect(orderList(w, e1)).toEqual(before);
      expect(w.applyRejected.some((r) => /nothing to upgrade/.test(r.reason))).toBe(true);
    }
  });
});
