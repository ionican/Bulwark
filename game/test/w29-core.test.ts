// W29 (PLAN-W29 items 3, 3a, 7, 15): the core — a fixed 3 × 3 building beside the commander's start,
// impassable to aliens in every flow-field cost grid and never an obstruction target; at 0 hp it is
// disabled (clamped, flagged, refusing items, not a target), never removed; repair to full re-enables it.

import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world.ts';
import { createWorld } from '../src/sim/scenarios.ts';
import { flatTerrain } from '../src/sim/terrain.ts';
import { A, B, ITEM_MASS, U, buildingInfo } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_DISABLED, T_BUILDING } from '../src/sim/schema.ts';
import { CORE_HP } from '../src/sim/balance.ts';
import { damageBuilding } from '../src/sim/combat.ts';
import { BALANCED } from './plans.ts';
import { ROW, beltLine, slot, steps } from './w29-fixtures.ts';

function coreOf(w: World): number {
  for (let s = 0; s < w.buildings.highWater; s++) if (w.buildings.alive[s] && w.buildings.cols.kind[s] === B.core) return s;
  return -1;
}

describe('W29 the core on map 1 and in the sandbox', () => {
  it('is complete, 3 × 3, 4,000 hp, within 3 tiles of (64.5, 64.5), clear of the start units and of every building in the plans', () => {
    for (const scenario of ['map1', 'sandbox'] as const) {
      const w = createWorld(1, scenario);
      const s = coreOf(w);
      expect(s, scenario).toBeGreaterThanOrEqual(0);
      const c = w.buildings.cols;
      expect(c.flags[s]! & BF_COMPLETE).not.toBe(0);
      expect([c.fw[s], c.fh[s]]).toEqual([3, 3]);
      expect(c.hp[s]).toBe(CORE_HP);
      expect(CORE_HP).toBe(4000);
      expect(w.coreId).toBe(w.buildings.id(s));
      const cx = c.tx[s]! + 1.5;
      const cz = c.ty[s]! + 1.5;
      expect(Math.hypot(cx - 64.5, cz - 64.5)).toBeLessThanOrEqual(3);
      const inCore = (x: number, z: number) => x >= c.tx[s]! && x < c.tx[s]! + 3 && z >= c.ty[s]! && z < c.ty[s]! + 3;
      for (let u = 0; u < w.units.highWater; u++) if (w.units.alive[u]) expect(inCore(Math.floor(w.units.cols.x[u]!), Math.floor(w.units.cols.z[u]!)), `unit ${u}`).toBe(false);
      for (const step of BALANCED) {
        if (!('build' in step.act)) continue;
        const info = buildingInfo(step.act.build);
        const [tx, ty] = step.act.at;
        for (let j = 0; j < info.fh; j++) for (let i = 0; i < info.fw; i++) expect(inCore(tx + i, ty + j), `${info.label} at ${tx},${ty}`).toBe(false);
      }
    }
  });

  it('is not in the build bar, not buildable and not placeable by command', () => {
    const w = createWorld(1, 'sandbox');
    expect(buildingInfo(B.core).key).toBe('');
    expect(w.submit({ t: 'build', ids: [w.commanderId], kind: B.core, tx: 40, ty: 40 })).toMatch(/core/i);
    expect(w.submit({ t: 'place', kind: B.core, tx: 40, ty: 40 })).toMatch(/core/i);
    expect(w.submit({ t: 'upgrade', ids: [w.commanderId], target: w.coreId })).not.toBeNull();
  });

  it('is impassable in every flow-field cost grid, so routes go round it', () => {
    const w = createWorld(1, 'map1');
    w.step();
    const s = coreOf(w);
    const c = w.buildings.cols;
    const W = w.terrain.w;
    const cells: number[] = [];
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) cells.push((c.ty[s]! + j) * W + c.tx[s]! + i);
    for (const cell of cells) {
      expect(w.cost[cell]).toBe(-1);
      expect(w.costBypass[cell]).toBe(-1);
      expect(w.walk[cell]).toBe(0);
    }
    for (let cat = 0; cat < 4; cat++) w.rebuildField(cat);
    for (const r of w.routes) for (const cell of r.cells) expect(cells.includes(cell), `route ${r.category} from entry ${r.entry}`).toBe(false);
    // the commander's field still reaches the commander from both entries
    for (const r of w.routes.filter((q) => q.category === 0)) expect(r.cells.length).toBeGreaterThan(30);
  });

  it('an alien whose route passes the core goes round it (its pass already spent)', () => {
    // flat 30 × 40: core in the middle of the way from the north entry to the base (no commander: the
    // rusher's field falls back to the base)
    const w = new World(1, flatTerrain(30, 40, { base: { x: 15, z: 34 } }), { waves: false, belts: true });
    w.placeBuilding(B.core, 14, 18, true);
    const a = w.aliens.slotForId(w.spawnAlien(A.rusher, 15.5, 4.5));
    w.aliens.cols.pass[a] = 2; // spent: the pass rule does not stop it
    const core = new Set<number>();
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) core.add((18 + j) * 30 + 14 + i);
    let reached = false;
    for (let t = 0; t < 600 && !reached; t++) {
      w.step();
      const cell = Math.floor(w.aliens.cols.z[a]!) * 30 + Math.floor(w.aliens.cols.x[a]!);
      expect(core.has(cell)).toBe(false);
      expect(w.aliens.cols.tType[a] === T_BUILDING && w.aliens.cols.tId[a] === w.coreId).toBe(false);
      reached = w.aliens.cols.z[a]! > 30;
    }
    expect(reached, 'the alien got past the core').toBe(true);
  });
});

describe('W29 the disabled core', () => {
  it('at 0 hp it is disabled, not removed: hp clamps at 0 and further damage is ignored', () => {
    const { w, core } = beltLine(10);
    const s = slot(w, core);
    const c = w.buildings.cols;
    damageBuilding(w, s, CORE_HP - 1);
    expect(c.hp[s]).toBe(1);
    damageBuilding(w, s, 200);
    expect(c.hp[s]).toBe(0);
    expect(c.flags[s]! & BF_DISABLED).not.toBe(0);
    damageBuilding(w, s, 200);
    expect(c.hp[s]).toBe(0);
    steps(w, 5);
    expect(w.buildings.slotForId(core)).toBe(s);
    expect(c.hp[s]).toBe(0);
  });

  it('refuses all items while disabled; the belt backs up', () => {
    const { w, core, belts } = beltLine(10);
    damageBuilding(w, slot(w, core), CORE_HP);
    steps(w, 200);
    expect(w.delivered[0]).toBe(0);
    const last = slot(w, belts[belts.length - 1]!);
    expect(w.buildings.cols.item[last]).toBe(ITEM_MASS);
    expect(w.buildings.cols.itemPos[last]).toBe(1);
  });

  it('is not a valid alien target, and never holds an alien in place', () => {
    const { w, core, coreX } = beltLine(10);
    damageBuilding(w, slot(w, core), CORE_HP);
    // a rusher touching the core's south face, not yet started its pass
    const a = w.aliens.slotForId(w.spawnAlien(A.rusher, coreX + 1.5, ROW + 3.4));
    const x0 = w.aliens.cols.x[a]!;
    const z0 = w.aliens.cols.z[a]!;
    let moved = 0;
    for (let t = 0; t < 30; t++) {
      w.step();
      expect(w.aliens.cols.tType[a] === T_BUILDING && w.aliens.cols.tId[a] === core, `tick ${w.tick}`).toBe(false);
      moved = Math.hypot(w.aliens.cols.x[a]! - x0, w.aliens.cols.z[a]! - z0);
    }
    expect(moved).toBeGreaterThan(1);
  });

  it('repair to full hp re-enables it (the commander alone takes 25 s from 0) and delivery resumes', () => {
    const { w, core, coreX } = beltLine(10);
    const s = slot(w, core);
    damageBuilding(w, s, CORE_HP);
    const cmd = w.spawnUnit(U.commander, coreX + 1.5, ROW + 4.5);
    steps(w, 100);
    const before = w.delivered[0]!;
    expect(before).toBe(0);
    expect(w.submit({ t: 'repair', ids: [cmd], target: core })).toBeNull();
    w.step(); // the order is applied, the commander already in range repairs from this tick
    steps(w, 248);
    expect(w.buildings.cols.flags[s]! & BF_DISABLED, 'still disabled before 25 s').not.toBe(0);
    steps(w, 2);
    expect(w.buildings.cols.hp[s]).toBe(CORE_HP);
    expect(w.buildings.cols.flags[s]! & BF_DISABLED).toBe(0);
    steps(w, 50);
    expect(w.delivered[0]).toBeGreaterThan(before);
  });
});
