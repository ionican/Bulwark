// W24 run 3, criterion 6 (simulation part): the two carried order fixes, through the real
// validation and application code (World.submit / step).
//
// C2 (Codex R1-2, R2-1): an unshifted single build on a reserved site of exactly that kind, anchor
// and direction is accepted when at least one live issuing unit holds the site and no live unit
// outside the issuers does. The queue becomes that one order on the same building id; other
// unstarted sites only those units held are removed. Refused: another live unit holds it; no
// issuing unit holds it (including a site whose owner died); Shift held; kind, anchor or direction
// differ. The one predicate (queue.ts ownReservedSite) gives the same answer on the snapshot
// (the placement preview and the build-bar click) as on the world.
//
// C3 (Codex R1-1, R2-2): an unshifted buildRun with a full run table is planned without mutation:
// the runs and sites the replacement releases (the orphan-cleanup rule, so a reserved gate is never
// released) and the sites the new run keeps in place. Capacity is credited only for sites that are
// actually removed. Both tables are checked; a refusal changes nothing (the world equals a twin
// advanced the same ticks without the command). The table never exceeds 32 runs.

import { describe, expect, it } from 'vitest';
import { B, U } from '../src/sim/kinds.ts';
import { BF_COMPLETE, isReserved } from '../src/sim/schema.ts';
import { decodeSnapshot, encodeSnapshot, snapshotBytes } from '../src/sim/snapshot.ts';
import { deserializeWorld, serializeWorld } from '../src/sim/save.ts';
import { RUN_CAPACITY } from '../src/sim/runs.ts';
import { ownReservedSite, worldSiteSource } from '../src/sim/queue.ts';
import { snapshotSiteSource } from '../src/dragPlan.ts';
import { CAPACITY, type World } from '../src/sim/world.ts';
import type { Command } from '../src/sim/commands.ts';
import { flatWorld } from './fixtures.ts';

const orders = (w: World, id: number) => w.orders[w.units.slotForId(id)] ?? [];
const exists = (w: World, id: number) => w.buildings.slotForId(id) >= 0;
const siteAt = (w: World, tx: number, ty: number) => {
  const s = w.occupancy[ty * w.terrain.w + tx]! - 1;
  return s >= 0 ? w.buildings.id(s) : -1;
};
const kill = (w: World, id: number) => {
  w.units.cols.hp[w.units.slotForId(id)] = 0;
  w.step();
};
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const snapBytes = (w: World) => snapshotBytes(encodeSnapshot(w));

/** Gun site at (40, 40), reserved, held by the engineers in `holders`; engineers stand far off, so it stays reserved. */
function c2World(holders: 'e1' | 'e2' | 'both') {
  const w = flatWorld(60, 60, { rich: true });
  const e1 = w.spawnUnit(U.engineer, 4.5, 4.5);
  const e2 = w.spawnUnit(U.engineer, 5.5, 4.5);
  const e3 = w.spawnUnit(U.engineer, 6.5, 4.5);
  const ids = holders === 'e1' ? [e1] : holders === 'e2' ? [e2] : [e1, e2];
  w.enqueue({ t: 'build', ids, kind: B.gun, tx: 40, ty: 40, dir: 0, queue: true });
  // a second unstarted site that only e1 holds
  if (holders !== 'e2') w.enqueue({ t: 'build', ids: [e1], kind: B.gun, tx: 44, ty: 40, dir: 0, queue: true });
  w.step();
  const site = siteAt(w, 40, 40);
  expect(site).toBeGreaterThanOrEqual(0);
  expect(isReserved(w.buildings.cols.flags[w.buildings.slotForId(site)]!)).toBe(true);
  return { w, e1, e2, e3, site, other: holders !== 'e2' ? siteAt(w, 44, 40) : -1 };
}

const build = (ids: number[], over: Partial<{ kind: number; tx: number; ty: number; dir: number; queue: boolean }> = {}): Command => ({
  t: 'build',
  ids,
  kind: over.kind ?? B.gun,
  tx: over.tx ?? 40,
  ty: over.ty ?? 40,
  dir: over.dir ?? 0,
  queue: over.queue ?? false,
});

/** The predicate on the world and on its snapshot agree; returns the world's answer. */
function predicate(w: World, ids: number[], kind = B.gun, tx = 40, ty = 40, dir = 0, queue = false): number {
  const onWorld = ownReservedSite(worldSiteSource(w), ids, kind, tx, ty, dir, queue);
  const onSnap = ownReservedSite(snapshotSiteSource(decodeSnapshot(encodeSnapshot(w))), ids, kind, tx, ty, dir, queue);
  expect(onSnap, 'snapshot and world predicates agree').toBe(onWorld);
  return onWorld;
}

describe('run 3 C2: an unshifted build on the unit’s own reserved site', () => {
  it('accepted: the queue becomes that one order on the same building id; the other site only it held goes', () => {
    const { w, e1, site, other } = c2World('e1');
    expect(orders(w, e1).length).toBe(2);
    expect(predicate(w, [e1])).toBe(site);
    expect(w.submit(build([e1]))).toBeNull();
    const count = w.buildings.count;
    w.step();
    expect(w.applyRejected).toEqual([]);
    const q = orders(w, e1);
    expect(q.length).toBe(1);
    expect(q[0]).toMatchObject({ t: 'build', id: site });
    expect(exists(w, site), 'the site keeps its id (not removed and re-reserved)').toBe(true);
    expect(isReserved(w.buildings.cols.flags[w.buildings.slotForId(site)]!)).toBe(true);
    expect(exists(w, other), 'the other unstarted site only e1 held is removed').toBe(false);
    expect(w.buildings.count).toBe(count - 1);
  });

  it('accepted when the site is shared by issuing units only', () => {
    const { w, e1, e2, site } = c2World('both');
    expect(predicate(w, [e1, e2])).toBe(site);
    expect(w.submit(build([e1, e2]))).toBeNull();
    w.step();
    expect(orders(w, e1).map((o) => o.t === 'build' && o.id)).toEqual([site]);
    expect(orders(w, e2).map((o) => o.t === 'build' && o.id)).toEqual([site]);
  });

  it('refused when a live unit outside the issuers also holds it', () => {
    const { w, e1, site } = c2World('both');
    expect(predicate(w, [e1])).toBe(-1);
    expect(w.submit(build([e1]))).toMatch(/cannot stand/);
    expect(exists(w, site)).toBe(true);
  });

  it('refused when no issuing unit holds it, and when its owner died (a site with no holder is not "own")', () => {
    const a = c2World('e2');
    expect(predicate(a.w, [a.e1])).toBe(-1);
    expect(a.w.submit(build([a.e1]))).toMatch(/cannot stand/);
    const b = c2World('e1');
    kill(b.w, b.e1);
    expect(b.w.units.slotForId(b.e1)).toBe(-1);
    expect(exists(b.w, b.site), 'the dead owner’s site stays').toBe(true);
    expect(predicate(b.w, [b.e3])).toBe(-1);
    expect(predicate(b.w, [b.e1, b.e3]), 'a dead issuer holds nothing').toBe(-1);
    expect(b.w.submit(build([b.e3]))).toMatch(/cannot stand/);
  });

  it('refused with Shift held, and when the kind, anchor or direction differ', () => {
    const { w, e1 } = c2World('e1');
    expect(predicate(w, [e1], B.gun, 40, 40, 0, true)).toBe(-1);
    expect(w.submit(build([e1], { queue: true }))).toMatch(/cannot stand/);
    expect(predicate(w, [e1], B.area)).toBe(-1);
    expect(w.submit(build([e1], { kind: B.area }))).toMatch(/cannot stand/);
    expect(predicate(w, [e1], B.gun, 41, 40)).toBe(-1);
    expect(w.submit(build([e1], { tx: 41 }))).toMatch(/cannot stand/);
    expect(predicate(w, [e1], B.gun, 40, 40, 1)).toBe(-1);
    expect(w.submit(build([e1], { dir: 1 }))).toMatch(/cannot stand/);
  });

  it('a started site is not reserved: refused as before', () => {
    const { w, e1, site } = c2World('e1');
    w.buildings.cols.flags[w.buildings.slotForId(site)] = 32; // BF_STARTED
    expect(predicate(w, [e1])).toBe(-1);
    expect(w.submit(build([e1]))).toMatch(/cannot stand/);
  });
});

/**
 * A 100 × 100 flat world whose run table is full: e1 holds run R1 alone (5 reserved tiles at
 * (10..14, 10)); `hoarder` holds the other 31 runs (queued). Every engineer is far away.
 */
function fullTable() {
  const w = flatWorld(100, 100, { rich: true });
  const e1 = w.spawnUnit(U.engineer, 90.5, 90.5);
  const hoarder = w.spawnUnit(U.engineer, 92.5, 90.5);
  const idle = w.spawnUnit(U.engineer, 94.5, 90.5);
  w.enqueue({ t: 'buildRun', ids: [e1], from: [10, 10], to: [14, 10], depth: 1, queue: true });
  for (let i = 0; i < RUN_CAPACITY - 1; i++) w.enqueue({ t: 'buildRun', ids: [hoarder], from: [30, 20 + 2 * i], to: [32, 20 + 2 * i], depth: 1, queue: true });
  w.step();
  const live = w.runs.filter((r) => r !== null);
  expect(live.length).toBe(RUN_CAPACITY);
  const r1 = w.runs.find((r) => r !== null && r.sites.includes(siteAt(w, 10, 10)))!;
  return { w, e1, hoarder, idle, r1: { id: r1.id, sites: [...r1.sites] } };
}

/** A copy of the world (save and load). */
const twin = (w: World) => deserializeWorld(serializeWorld(w));

describe('run 3 C3: an unshifted buildRun with a full run table', () => {
  it('accepted when the replacement frees a slot: the old run and its tiles go, the table stays at 32', () => {
    const { w, e1, r1 } = fullTable();
    const cmd: Command = { t: 'buildRun', ids: [e1], from: [10, 14], to: [17, 14], depth: 1 };
    expect(w.submit(cmd)).toBeNull();
    w.step();
    expect(w.applyRejected).toEqual([]);
    expect(w.runs.length).toBe(RUN_CAPACITY);
    expect(w.runs.filter((r) => r !== null).length).toBe(RUN_CAPACITY);
    expect(w.runs.some((r) => r?.id === r1.id)).toBe(false);
    for (const s of r1.sites) expect(exists(w, s), `old tile ${s}`).toBe(false);
    const q = orders(w, e1);
    expect(q.length).toBe(1);
    expect(q[0]!.t).toBe('run');
    const run = w.runs.find((r) => r !== null && q[0]!.t === 'run' && r.id === q[0]!.run)!;
    expect(run.sites.length).toBe(8);
  });

  it('an overlapping replacement keeps the reused sites’ ids', () => {
    const { w, e1, r1 } = fullTable();
    expect(w.submit({ t: 'buildRun', ids: [e1], from: [10, 10], to: [16, 10], depth: 1 })).toBeNull();
    w.step();
    const q = orders(w, e1);
    const run = w.runs.find((r) => r !== null && q[0]!.t === 'run' && r.id === q[0]!.run)!;
    expect(run.sites.length).toBe(7);
    for (const s of r1.sites) expect(run.sites, `reused site ${s}`).toContain(s);
    expect(w.runs.filter((r) => r !== null).length).toBe(RUN_CAPACITY);
  });

  it('refused when no slot would be freed: nothing changes (a twin without the command is identical)', () => {
    const { w, idle } = fullTable();
    const t = twin(w);
    const reason = w.submit({ t: 'buildRun', ids: [idle], from: [10, 30], to: [14, 30], depth: 1 });
    expect(reason).toMatch(/run table is full/);
    for (let i = 0; i < 3; i++) {
      w.step();
      t.step();
    }
    expect(same(serializeWorld(w), serializeWorld(t))).toBe(true);
  });

  it('an apply-time refusal changes nothing but the rejection record', () => {
    const { w, idle } = fullTable();
    const t = twin(w);
    // made invalid between issue and apply: queued without validation
    w.enqueue({ t: 'buildRun', ids: [idle], from: [10, 30], to: [14, 30], depth: 1 });
    w.step();
    t.step();
    expect(w.applyRejected.length).toBe(1);
    expect(w.applyRejected[0]!.reason).toMatch(/run table is full/);
    expect(same(snapBytes(w), snapBytes(t))).toBe(true);
    expect(w.runs.filter((r) => r !== null).length).toBe(RUN_CAPACITY);
  });

  it('the building table: credit only for sites actually removed; refused (nothing changed) when it would still overflow', () => {
    // run table not full here: e1 holds 5 reserved tiles; the building table is filled with complete walls
    const make = (spare: number) => {
      const w = flatWorld(100, 100, { rich: true });
      const e1 = w.spawnUnit(U.engineer, 90.5, 90.5);
      w.enqueue({ t: 'buildRun', ids: [e1], from: [10, 10], to: [14, 10], depth: 1, queue: true });
      w.step();
      for (let y = 20; y < 98 && w.buildings.count < CAPACITY.buildings - spare; y++)
        for (let x = 0; x < 100 && w.buildings.count < CAPACITY.buildings - spare; x++) w.placeBuilding(B.wall, x, y, true);
      expect(w.buildings.count).toBe(CAPACITY.buildings - spare);
      return { w, e1 };
    };
    // 2 spare + 5 released ≥ 6 new: accepted
    const ok = make(2);
    expect(ok.w.submit({ t: 'buildRun', ids: [ok.e1], from: [10, 14], to: [15, 14], depth: 1 })).toBeNull();
    ok.w.step();
    expect(ok.w.applyRejected).toEqual([]);
    expect(ok.w.buildings.count).toBe(CAPACITY.buildings - 2 - 5 + 6);
    // 0 spare + 5 released < 6 new: refused, nothing changed
    const no = make(0);
    const t = twin(no.w);
    expect(no.w.submit({ t: 'buildRun', ids: [no.e1], from: [10, 14], to: [15, 14], depth: 1 })).toMatch(/building table/);
    no.w.step();
    t.step();
    expect(same(serializeWorld(no.w), serializeWorld(t))).toBe(true);
  });

  it('a reserved gate that the issuer alone holds is never released: no credit, refused, the gate survives', () => {
    const w = flatWorld(100, 100, { rich: true });
    const e1 = w.spawnUnit(U.engineer, 90.5, 90.5);
    // five finished walls in a row, then a gate ordered on the middle three (reserved: e1 is far away)
    for (let x = 10; x <= 14; x++) w.placeBuilding(B.wall, x, 10, true);
    w.enqueue({ t: 'gate', ids: [e1], tx: 12, ty: 10 });
    w.step();
    const gate = siteAt(w, 12, 10);
    const gs = w.buildings.slotForId(gate);
    expect(w.buildings.cols.kind[gs]).toBe(B.gate);
    expect(isReserved(w.buildings.cols.flags[gs]!)).toBe(true);
    expect(orders(w, e1).map((o) => o.t === 'build' && o.id)).toEqual([gate]);
    for (let y = 20; y < 98 && w.buildings.count < CAPACITY.buildings; y++) for (let x = 0; x < 100 && w.buildings.count < CAPACITY.buildings; x++) w.placeBuilding(B.wall, x, y, true);
    expect(w.buildings.count).toBe(CAPACITY.buildings);
    const t = twin(w);
    expect(w.submit({ t: 'buildRun', ids: [e1], from: [10, 14], to: [10, 14], depth: 1 })).toMatch(/building table/);
    w.step();
    t.step();
    expect(exists(w, gate), 'the gate site survives').toBe(true);
    expect(same(serializeWorld(w), serializeWorld(t))).toBe(true);
  });

  it('the run table never exceeds 32 entries', () => {
    const { w, e1, hoarder } = fullTable();
    for (let i = 0; i < 4; i++) {
      w.submit({ t: 'buildRun', ids: [e1], from: [10, 40 + i], to: [14, 40 + i], depth: 1 });
      w.submit({ t: 'buildRun', ids: [hoarder], from: [50, 40 + i], to: [54, 40 + i], depth: 1, queue: true });
      w.step();
      expect(w.runs.length).toBe(RUN_CAPACITY);
    }
    expect(w.runs.filter((r) => r !== null).length).toBeLessThanOrEqual(RUN_CAPACITY);
    void BF_COMPLETE;
  });
});
