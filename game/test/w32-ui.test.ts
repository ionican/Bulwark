// W32 (PLAN-W32 test 10): the Demolish tool's identity and its words. The button is in the Engineers
// group, "Demolish [Del]", chosen by Delete or Backspace; without an engineer selected it is disabled
// and says why (a label, not a colour). The hover readout: with the tool, a finished building's
// refund and time; a building being demolished, its progress and refund, and that text wins over the
// upgrade readout of a building demolished mid-upgrade; the core says it cannot be demolished. The
// preview label and the queue text.

import { describe, expect, it } from 'vitest';
import { B, U, buildingInfo } from '../src/sim/kinds.ts';
import { BF_UPGRADING } from '../src/sim/schema.ts';
import type { World } from '../src/sim/world.ts';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from '../src/sim/snapshot.ts';
import { buildOccupancy } from '../src/render/picking.ts';
import * as buildbar from '../src/ui/buildbar.ts';
import * as tools from '../src/tools.ts';
import * as readout from '../src/render/buildingReadout.ts';
import * as dragPlan from '../src/dragPlan.ts';
import type { DragView } from '../src/dragPlan.ts';
import { flatWorld } from './fixtures.ts';
import { setDemolish } from './w32-fixtures.ts';

const snapOf = (w: World) => decodeSnapshot(encodeSnapshot(w));
function viewOf(w: World, s: Snapshot): DragView {
  const c = s.buildings.cols;
  const occupancy = buildOccupancy({ count: s.buildings.count, id: s.buildings.id, kind: c.kind, tx: c.tx, ty: c.ty, fw: c.fw, fh: c.fh }, w.terrain.w, w.terrain.h, new Int32Array(w.terrain.w * w.terrain.h));
  return { terrain: w.terrain, occupancy, kinds: c.kind, units: { count: s.units.count, id: s.units.id, x: s.units.cols.x, z: s.units.cols.z }, snapshot: s };
}

type Lines = { lines: string[] } | null;
const R = readout as unknown as {
  demolishReadout?: (s: Snapshot, id: number, tool: boolean, power?: number) => Lines;
  hoverReadout?: (prev: Snapshot | null, curr: Snapshot, id: number, opts: { demolishTool: boolean; builders: () => boolean; power?: number }) => Lines;
  demolishQueueText?: (s: Snapshot, id: number) => string;
};
const WALL = buildingInfo(B.wall).label;
/** One decimal, a whole number without one (the readouts' rule: "+50 mass", "+12.5 mass"). */
const one = (v: number) => {
  const t = Math.round(v * 10) / 10;
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
};

describe('W32 Demolish button and keys (test 10)', () => {
  type Action = { id: string; label: string; sub: string };
  const actions = () => (buildbar as unknown as { ENGINEER_ACTIONS?: Action[] }).ENGINEER_ACTIONS ?? [];
  const state = (buildbar as unknown as { engineerAction?: (id: string, has: { engineers: boolean; commander: boolean }) => { disabled: boolean; sub: string } }).engineerAction;

  it('the Engineers group has "Demolish [Del]" ("click or drag a building"), after Upgrade', () => {
    const ids = actions().map((a) => a.id);
    expect(ids).toContain('demolish');
    expect(ids.indexOf('demolish')).toBe(ids.indexOf('upgrade') + 1);
    expect(actions().find((a) => a.id === 'demolish')).toMatchObject({ label: 'Demolish [Del]', sub: 'click or drag a building' });
  });

  it('disabled without an engineer, and its label says why; enabled with one', () => {
    expect(typeof state, 'engineerAction').toBe('function');
    expect(state!('demolish', { engineers: false, commander: true })).toEqual({ disabled: true, sub: 'needs an engineer' });
    expect(state!('demolish', { engineers: true, commander: false })).toEqual({ disabled: false, sub: 'click or drag a building' });
  });

  it('Delete and Backspace choose the tool; a tool that needs an engineer does not arm without one', () => {
    const keys = (tools as unknown as { DEMOLISH_KEYS?: readonly string[] }).DEMOLISH_KEYS;
    expect(keys).toEqual(['Delete', 'Backspace']);
    const t = new tools.Tools(() => true);
    const choose = t.chooseForBuilders.bind(t) as unknown as (name: string, builders: boolean) => boolean;
    expect(choose('demolish', false)).toBe(false);
    expect(t.name).toBe('select');
    expect(choose('demolish', true)).toBe(true);
    expect(t.name as string).toBe('demolish');
    expect(tools.toolLabel(t, {})).toMatch(/^Tool: demolish/);
    // a valid click acts (and closes the tool without Shift); the core does not
    const hint = (tools as unknown as { demolishClickHint?: (kind: number, flags: number) => string | null }).demolishClickHint;
    expect(typeof hint).toBe('function');
    expect(hint!(B.wall, 1 | 32)).toBeNull();
    expect(hint!(B.core, 1 | 32)).toMatch(/core cannot be demolished/);
    expect(hint!(B.wall, 0)).toMatch(/unfinished/);
    expect(hint!(-1, 0)).toMatch(/finished building/);
  });
});

describe('W32 readouts, preview label and queue text (test 10)', () => {
  function world() {
    const w = flatWorld(40, 30, { rich: true });
    w.spawnUnit(U.engineer, 6.5, 13.5);
    const wall = w.placeBuilding(B.wall, 5, 10, true);
    const marked = w.placeBuilding(B.wall, 7, 10, true);
    setDemolish(w, marked, 0.4);
    const upgrading = w.placeBuilding(B.wall, 9, 10, true);
    const s = w.buildings.slotForId(upgrading);
    w.buildings.cols.flags[s] = w.buildings.cols.flags[s]! | BF_UPGRADING;
    w.buildings.cols.progress[s] = 0.7;
    setDemolish(w, upgrading, 0.4);
    const core = w.placeBuilding(B.core, 20, 20, true);
    const belt = w.placeBuilding(B.belt, 12, 10, true, 0);
    w.buildings.cols.item[w.buildings.slotForId(belt)] = 5;
    return { w, wall, marked, upgrading, core, belt };
  }

  it('hover with the tool: "Demolish: +50 mass, 6 s"; being demolished: "Demolishing 40% · +50 mass when done"; the core cannot be demolished', () => {
    const { w, wall, marked, core, belt } = world();
    expect(typeof R.demolishReadout).toBe('function');
    const s = snapOf(w);
    expect(R.demolishReadout!(s, wall, true)?.lines).toEqual([WALL, 'Demolish: +50 mass, 6 s']);
    expect(R.demolishReadout!(s, wall, true, 10)?.lines).toEqual([WALL, 'Demolish: +50 mass, 3 s']);
    expect(R.demolishReadout!(s, wall, false), 'no tool, not being demolished: no demolish readout').toBeNull();
    expect(R.demolishReadout!(s, marked, false)?.lines).toEqual([WALL, 'Demolishing 40% · +50 mass when done']);
    expect(R.demolishReadout!(s, core, true)?.lines).toEqual(['Core', 'the core cannot be demolished']);
    expect(R.demolishReadout!(s, belt, true)?.lines).toEqual(['Conveyor belt · Slow (1.7 tiles/s)', 'Demolish: +0.3 mass, 0.4 s', 'items inside are lost']);
  });

  it('a building demolished mid-upgrade: the demolish text wins over the upgrade readout', () => {
    const { w, upgrading } = world();
    expect(typeof R.hoverReadout).toBe('function');
    const s = snapOf(w);
    const r = R.hoverReadout!(null, s, upgrading, { demolishTool: false, builders: () => false });
    // refund: half of 100 mass + 0.7 × the upgrade's 100 mass and 4 rare
    const p = Math.fround(0.7);
    const mass = 0.5 * (100 + p * 100);
    const rare = 0.5 * (p * 4);
    expect(r?.lines).toEqual([WALL, `Demolishing 40% · +${one(mass)} mass +${one(rare)} rare when done`]);
    expect(r?.lines.some((l) => /upgrading/.test(l))).toBe(false);
  });

  it('the preview label: "Demolish 2 · +100 mass +0 rare · 1 skipped", and "· items inside are lost" when any target holds items', () => {
    const { w } = world();
    const plan = (dragPlan as unknown as { planDemolishPreview?: (v: DragView, from: [number, number], to: [number, number]) => unknown }).planDemolishPreview;
    const label = (dragPlan as unknown as { demolishLabel?: (p: unknown) => string }).demolishLabel;
    expect([typeof plan, typeof label]).toEqual(['function', 'function']);
    const site = w.placeBuilding(B.wall, 6, 10, false);
    expect(site).toBeGreaterThanOrEqual(0);
    const v = viewOf(w, snapOf(w));
    expect(label!(plan!(v, [5, 10], [7, 10]))).toBe('Demolish 2 · +100 mass +0 rare · 1 skipped');
    expect(label!(plan!(v, [12, 10], [12, 10]))).toBe('Demolish 1 · +0.3 mass +0 rare · items inside are lost');
    expect(label!(plan!(v, [14, 10], [16, 10]))).toBe('Demolish 0 · nothing to demolish');
  });

  it('queue text: "Demolish Wall"; a target gone: "Demolish (gone)"', () => {
    const { w, wall } = world();
    expect(typeof R.demolishQueueText).toBe('function');
    const s = snapOf(w);
    expect(R.demolishQueueText!(s, wall)).toBe(`Demolish ${WALL}`);
    expect(R.demolishQueueText!(s, 123456)).toBe('Demolish (gone)');
  });
});
