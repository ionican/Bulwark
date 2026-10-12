// W32 (PLAN-W32 test 4 and the shifted reissue at a full queue): what a demolish command refuses, with
// the reason, and what it leaves unchanged. Every refusal is checked against an accepted control in
// the same world, so a tree without the command (which refuses it as unknown) fails here too.
// Also: the commands a building being demolished refuses (upgrade, upgradeBelts, assist on its
// upgrade, repair, gate conversion), and the gate's own order of events both ways round.

import { describe, expect, it } from 'vitest';
import type { Command } from '../src/sim/commands.ts';
import { B, U } from '../src/sim/kinds.ts';
import { BF_UPGRADING } from '../src/sim/schema.ts';
import { MAX_ORDERS, type World } from '../src/sim/world.ts';
import { SimRunner, type CommandResult } from '../src/sim/runner.ts';
import { RESEARCH_INDEX } from '../src/sim/balance.ts';
import { flatWorld } from './fixtures.ts';
import { alive, demolish, demolishOf, demolishTargets, orderList, setDemolish, steps, why } from './w32-fixtures.ts';

const research = (w: World, id: string) => w.completeResearch(RESEARCH_INDEX[id]!);
const slotOf = (w: World, id: number) => w.buildings.slotForId(id);

/** A flat rich world: a commander and two engineers by (10, 10); walls at (10..15, 10). */
function world() {
  const w = flatWorld(40, 40, { rich: true });
  const cmdr = w.spawnUnit(U.commander, 8.5, 13.5);
  const e1 = w.spawnUnit(U.engineer, 10.5, 13.5);
  const e2 = w.spawnUnit(U.engineer, 11.5, 13.5);
  const walls = [10, 11, 12, 13, 14, 15].map((x) => w.placeBuilding(B.wall, x, 10, true));
  return { w, cmdr, e1, e2, walls };
}

/** Runs a command validated now and applied `delay` ticks later through a SimRunner; returns its final result. */
function tracked(w: World, cmd: Command, delay = 0, before?: () => void): CommandResult | string {
  const runner = new SimRunner(w, 0);
  const out: CommandResult[] = [];
  runner.onResult = (r) => out.push(r);
  const s = w.submitCommand(cmd, w.tick + delay);
  if (typeof s === 'string') return s;
  (runner as unknown as { tracked: Map<unknown, number> }).tracked.set(s, 1);
  before?.();
  for (let i = 0; i <= delay + 1 && !out.length; i++) runner.stepOnce();
  return out[0] ?? 'no result';
}

describe('W32 demolish validation (test 4)', () => {
  it('a command naming only the commander is refused (only engineers demolish); the same with an engineer is accepted', () => {
    const { w, cmdr, e1, walls } = world();
    expect(why(w.submit(demolish([cmdr], [walls[0]!])))).toMatch(/only engineers demolish/);
    expect(why(w.submit(demolish([cmdr, e1], [walls[0]!])))).toBe('(accepted)');
    w.step();
    expect(demolishTargets(w, e1)).toEqual([walls[0]]);
    expect(demolishTargets(w, cmdr), 'the commander gets no demolish order').toEqual([]);
  });

  it('the core and an unfinished site are refused with the reason; a finished wall in the same world is accepted', () => {
    const { w, e1, walls } = world();
    const core = w.placeBuilding(B.core, 20, 20, true);
    const site = w.placeBuilding(B.wall, 16, 10, false);
    expect(why(w.submit(demolish([e1], [core])))).toMatch(/nothing to demolish.*core 1/);
    expect(why(w.submit(demolish([e1], [site])))).toMatch(/nothing to demolish.*unfinished site 1/);
    expect(why(w.submit(demolish([e1], [core, site, walls[0]!])))).toBe('(accepted)');
    w.step();
    expect(demolishTargets(w, e1)).toEqual([walls[0]]);
    expect(demolishOf(w, core)).toBe(0);
    expect(demolishOf(w, site)).toBe(0);
  });

  it('no live engineer when it applies: refused at apply time, nothing changes; the control with a live engineer applies', () => {
    const a = world();
    const r = tracked(a.w, demolish([a.e1], [a.walls[0]!]), 3, () => a.w.units.remove(a.w.units.slotForId(a.e1)));
    expect(typeof r).toBe('object');
    expect((r as CommandResult).ok).toBe(false);
    expect((r as CommandResult).reason).toMatch(/no live engineer/);
    steps(a.w, 5);
    expect(demolishOf(a.w, a.walls[0]!)).toBe(0);
    const b = world();
    const ok = tracked(b.w, demolish([b.e1], [b.walls[0]!]), 3);
    expect((ok as CommandResult).ok).toBe(true);
    expect(demolishTargets(b.w, b.e1)).toEqual([b.walls[0]]);
  });

  it('all targets skipped, shifted or not: refused, every queue unchanged; with one target left the same command is accepted', () => {
    for (const queue of [false, true]) {
      const { w, e1, walls } = world();
      const core = w.placeBuilding(B.core, 20, 20, true);
      w.enqueue({ t: 'move', ids: [e1], x: 30.5, z: 30.5, queue: false });
      w.step();
      const before = orderList(w, e1);
      const cmd = demolish([e1], [core, core], queue);
      expect(why(w.submit(cmd)), `queue ${queue}`).toMatch(/nothing to demolish: all 2 targets skipped \(duplicate 1, gone 0, core 1, unfinished site 0\)/);
      w.enqueue(cmd);
      w.step();
      expect(orderList(w, e1).map((o) => o.oid)).toEqual(before.map((o) => o.oid));
      expect(w.applyRejected.some((r) => /nothing to demolish/.test(r.reason))).toBe(true);
      expect(why(w.submit(demolish([e1], [core, walls[0]!], queue)))).toBe('(accepted)');
      w.step();
      expect(demolishTargets(w, e1)).toEqual([walls[0]]);
      expect(orderList(w, e1).length).toBe(queue ? before.length + 1 : 1);
    }
  });

  it('capacity: an engineer holding 60 orders refuses a shifted demolish of 5 (nothing changes) and accepts 4', () => {
    const w = flatWorld(60, 40, { rich: true });
    const e = w.spawnUnit(U.engineer, 10.5, 13.5);
    const walls = [10, 11, 12, 13, 14].map((x) => w.placeBuilding(B.wall, x, 10, true));
    for (let k = 0; k < 60; k++) w.enqueue({ t: 'move', ids: [e], x: 40.5 + (k % 5), z: 30.5, queue: true });
    w.step();
    expect(orderList(w, e).length).toBe(60);
    expect(why(w.submit(demolish([e], walls, true)))).toMatch(/order queue full: unit \d+ would hold 65 orders/);
    w.enqueue(demolish([e], walls, true));
    w.step();
    expect(orderList(w, e).length).toBe(60);
    expect(why(w.submit(demolish([e], walls.slice(0, 4), true)))).toBe('(accepted)');
    w.step();
    expect(orderList(w, e).length).toBe(MAX_ORDERS);
    expect(demolishTargets(w, e)).toEqual(walls.slice(0, 4));
  });

  it('duplicate unit ids count once; a recipient never holds two demolish orders for one target', () => {
    const { w, e1, walls } = world();
    expect(why(w.submit(demolish([e1, e1], [walls[0]!, walls[1]!])))).toBe('(accepted)');
    w.step();
    expect(demolishTargets(w, e1)).toEqual([walls[0], walls[1]]);
    // a shifted reissue of both plus a third: only the third is added
    expect(why(w.submit(demolish([e1], [walls[1]!, walls[0]!, walls[2]!], true)))).toBe('(accepted)');
    w.step();
    expect(demolishTargets(w, e1)).toEqual([walls[0], walls[1], walls[2]]);
  });

  it('a target destroyed before the command applies is skipped and counted (gone)', () => {
    const { w, e1, walls } = world();
    const r = tracked(w, demolish([e1], walls.slice(0, 3)), 4, () => w.removeBuilding(slotOf(w, walls[1]!)));
    expect((r as CommandResult).ok).toBe(true);
    expect((r as CommandResult).detail).toMatchObject({ demolishes: 2, skipped: { gone: 1, duplicate: 0, core: 0, site: 0 } });
    expect(demolishTargets(w, e1)).toEqual([walls[0], walls[2]]);
  });
});

describe('W32 commands a building being demolished refuses (test 4)', () => {
  /** walls[0] being demolished (progress 0.3); walls[1] not. Both researches done for upgrades. */
  function marked() {
    const x = world();
    research(x.w, 'wallT2');
    setDemolish(x.w, x.walls[0]!, 0.3);
    expect(demolishOf(x.w, x.walls[0]!)).toBeCloseTo(0.3, 6);
    return x;
  }

  it('upgrade: refused naming the demolish; the wall beside it is accepted', () => {
    const { w, e2, walls } = marked();
    expect(why(w.submit({ t: 'upgrade', ids: [e2], target: walls[0]! }))).toMatch(/being demolished/);
    expect(why(w.submit({ t: 'upgrade', ids: [e2], target: walls[1]! }))).toBe('(accepted)');
  });

  it('upgradeBelts: a belt being demolished is skipped as demolishing; the belt beside it is upgraded', () => {
    const w = flatWorld(40, 40, { rich: true });
    research(w, 'beltMedium');
    const e = w.spawnUnit(U.engineer, 10.5, 13.5);
    const a = w.placeBuilding(B.belt, 10, 10, true, 0);
    const b = w.placeBuilding(B.belt, 11, 10, true, 0);
    setDemolish(w, a, 0.5);
    const cmd = { t: 'upgradeBelts', ids: [e], targets: [{ id: a, expectedTier: 1 }], queue: false } as unknown as Command;
    expect(why(w.submit(cmd))).toMatch(/nothing to upgrade.*demolishing 1/);
    const r = tracked(w, { t: 'upgradeBelts', ids: [e], targets: [a, b].map((id) => ({ id, expectedTier: 1 })), queue: false } as unknown as Command);
    expect((r as CommandResult).ok).toBe(true);
    expect((r as CommandResult).detail).toMatchObject({ upgrades: 1, skipped: { demolishing: 1 } });
    expect(w.buildings.cols.flags[slotOf(w, a)]! & BF_UPGRADING).toBe(0);
    expect(w.buildings.cols.flags[slotOf(w, b)]! & BF_UPGRADING).not.toBe(0);
  });

  it('assist on an upgrade under way: refused when the building is being demolished; accepted on another upgrading wall', () => {
    const { w, e2, walls } = marked();
    for (const id of [walls[0]!, walls[1]!]) w.buildings.cols.flags[slotOf(w, id)] = w.buildings.cols.flags[slotOf(w, id)]! | BF_UPGRADING;
    expect(why(w.submit({ t: 'assist', ids: [e2], target: walls[0]! }))).toMatch(/being demolished/);
    expect(why(w.submit({ t: 'assist', ids: [e2], target: walls[1]! }))).toBe('(accepted)');
  });

  it('repair: refused when the building is being demolished; the damaged wall beside it is accepted', () => {
    const { w, e2, walls } = marked();
    const c = w.buildings.cols;
    for (const id of [walls[0]!, walls[1]!]) c.hp[slotOf(w, id)] = c.maxHp[slotOf(w, id)]! / 2;
    expect(why(w.submit({ t: 'repair', ids: [e2], target: walls[0]! }))).toMatch(/being demolished/);
    expect(why(w.submit({ t: 'repair', ids: [e2], target: walls[1]! }))).toBe('(accepted)');
  });

  it('gate conversion over a wall being demolished, or one a unit holds a demolish order on, is refused; over untouched walls it is accepted', () => {
    // three runs of five walls along x at z = 10, 20 and 30 (a gate takes the middle three)
    const w = flatWorld(60, 40, { rich: true });
    const e1 = w.spawnUnit(U.engineer, 5.5, 5.5);
    const runs = [10, 20, 30].map((z) => [20, 21, 22].map((x) => w.placeBuilding(B.wall, x, z, true)));
    for (const z of [10, 20, 30]) for (const x of [19, 23]) w.placeBuilding(B.wall, x, z, true);
    setDemolish(w, runs[0]![1]!, 0.2);
    expect(why(w.submit({ t: 'gate', ids: [e1], tx: 21, ty: 10, axis: 'x' }))).toMatch(/being demolished/);
    // a pending demolish order (the engineer is walking: no progress yet)
    const far = w.spawnUnit(U.engineer, 55.5, 2.5);
    expect(why(w.submit(demolish([far], [runs[1]![0]!])))).toBe('(accepted)');
    w.step();
    expect(demolishOf(w, runs[1]![0]!)).toBe(0);
    expect(demolishTargets(w, far)).toEqual([runs[1]![0]]);
    expect(why(w.submit({ t: 'gate', ids: [e1], tx: 21, ty: 20, axis: 'x' }))).toMatch(/demolish/);
    expect(why(w.submit({ t: 'gate', ids: [e1], tx: 21, ty: 30, axis: 'x' }))).toBe('(accepted)');
  });

  it('gate first, then demolish: the converted walls are gone, so they are skipped (gone) and the one other target is accepted', () => {
    const w = flatWorld(60, 40, { rich: true });
    const e1 = w.spawnUnit(U.engineer, 21.5, 13.5);
    const walls = [20, 21, 22].map((x) => w.placeBuilding(B.wall, x, 10, true));
    for (const x of [19, 23]) w.placeBuilding(B.wall, x, 10, true);
    const other = w.placeBuilding(B.wall, 30, 10, true);
    expect(why(w.submit({ t: 'gate', ids: [e1], tx: 21, ty: 10, axis: 'x' }))).toBe('(accepted)');
    w.step();
    expect(walls.every((id) => !alive(w, id))).toBe(true);
    expect(why(w.submit(demolish([e1], walls)))).toMatch(/nothing to demolish.*gone 3/);
    const r = tracked(w, demolish([e1], [...walls, other]));
    expect((r as CommandResult).detail).toMatchObject({ demolishes: 1, skipped: { gone: 3 } });
  });
});

describe('W32 shifted reissue at a full queue (test 6)', () => {
  it('an engineer holding 64 orders, one a demolish of A: a shifted demolish of A is accepted and adds nothing; of a new B it is refused for capacity', () => {
    const w = flatWorld(60, 40, { rich: true });
    const e = w.spawnUnit(U.engineer, 5.5, 5.5);
    const a = w.placeBuilding(B.wall, 50, 30, true);
    const b = w.placeBuilding(B.wall, 52, 30, true);
    for (let k = 0; k < MAX_ORDERS - 1; k++) w.enqueue({ t: 'move', ids: [e], x: 40.5 + (k % 5), z: 35.5, queue: true });
    w.enqueue(demolish([e], [a], true));
    w.step();
    expect(orderList(w, e).length).toBe(MAX_ORDERS);
    expect(demolishTargets(w, e)).toEqual([a]);
    expect(why(w.submit(demolish([e], [a], true)))).toBe('(accepted)');
    w.step();
    expect(orderList(w, e).length).toBe(MAX_ORDERS);
    expect(demolishTargets(w, e)).toEqual([a]);
    expect(why(w.submit(demolish([e], [b], true)))).toMatch(/order queue full/);
    w.step();
    expect(orderList(w, e).length).toBe(MAX_ORDERS);
    expect(demolishTargets(w, e)).toEqual([a]);
  });
});
