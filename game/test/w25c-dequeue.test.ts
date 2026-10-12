// W25c finding 3 (Codex adversarial review, 9 Oct, medium): a stale dequeue removed a different
// order. All moves shared the identity (Q_MOVE, -1), and so did all produce orders, so after the
// displayed first move completed, removing it with its snapshot expectation deleted the second
// move. Each order now has an immutable id from a per-world counter, saved and carried in the
// snapshot; `dequeue` names that id, and an id that is completed or removed is refused with a reason.

import { describe, expect, it } from 'vitest';
import { U } from '../src/sim/kinds.ts';
import { SNAPSHOT_VERSION, decodeSnapshot, encodeSnapshot, queueOf } from '../src/sim/snapshot.ts';
import { deserializeWorld, serializeWorld } from '../src/sim/save.ts';
import type { Command } from '../src/sim/commands.ts';
import type { World } from '../src/sim/world.ts';
import { flatWorld } from './fixtures.ts';

/** Order ids as the world holds them (`oid`), first order first. */
const oids = (w: World, id: number): number[] => (w.orders[w.units.slotForId(id)] ?? []).map((o) => (o as { oid?: number }).oid ?? NaN);
const kinds = (w: World, id: number) => (w.orders[w.units.slotForId(id)] ?? []).map((o) => o.t);
/** The dequeue command naming an order id (cast: the base tree's command type has no `order`). */
const dequeue = (id: number, order: number) => ({ t: 'dequeue', id, order }) as unknown as Command;

/** An engineer with two queued moves: M1 two tiles away (done in about 3 s), M2 far away. */
function twoMoves() {
  const w = flatWorld(48, 48);
  const a = w.spawnUnit(U.engineer, 10.5, 10.5);
  w.enqueue({ t: 'move', ids: [a], x: 12.5, z: 10.5 });
  w.enqueue({ t: 'move', ids: [a], x: 40.5, z: 10.5, queue: true });
  w.step();
  expect(kinds(w, a)).toEqual(['move', 'move']);
  return { w, a };
}

describe('W25c finding 3: orders have ids, and dequeue names one', () => {
  it('every order gets its own id, carried in the snapshot (the version is bumped)', () => {
    const { w, a } = twoMoves();
    const ids = oids(w, a);
    expect(ids.every((n) => Number.isInteger(n) && n > 0), `ids ${ids}`).toBe(true);
    expect(new Set(ids).size).toBe(2);
    const snap = decodeSnapshot(encodeSnapshot(w));
    const row = Array.from(snap.units.id.subarray(0, snap.units.count)).indexOf(a);
    expect(queueOf(snap, row).map((q) => (q as { oid?: number }).oid)).toEqual(ids);
    // W32 (PLAN-W32 item 8): the demolish column took the state format to 8
    expect(SNAPSHOT_VERSION).toBe(8);
  });

  it('the review probe: after the first move completed, removing it is refused and the second move stays', () => {
    const { w, a } = twoMoves();
    const [m1, m2] = oids(w, a);
    // The panel showed [M1, M2]; the player removes M1, but the command applies 40 ticks later,
    // after M1 has completed. Valid when sent:
    expect(w.submit(dequeue(a, m1!), w.tick + 40)).toBeNull();
    for (let t = 0; t < 45; t++) w.step();
    expect(oids(w, a)).toEqual([m2]);
    expect(w.applyRejected[w.applyRejected.length - 1]?.reason ?? '').toMatch(/completed or removed/);
    // Sent now, it is refused at once.
    expect(w.submit(dequeue(a, m1!))).toMatch(/completed or removed/);
  });

  it('removing an order by id removes exactly that order, wherever it has moved in the queue', () => {
    const { w, a } = twoMoves();
    w.enqueue({ t: 'move', ids: [a], x: 40.5, z: 30.5, queue: true });
    w.step();
    const [, m2, m3] = oids(w, a);
    expect(w.submit(dequeue(a, m3!), w.tick + 40)).toBeNull();
    for (let t = 0; t < 45; t++) w.step(); // M1 completes first: M3 is at index 1 now, not 2
    expect(oids(w, a)).toEqual([m2]);
  });

  it('ids are never reused, an unknown id is refused, and a removed one is refused the second time', () => {
    const { w, a } = twoMoves();
    const before = oids(w, a);
    w.enqueue({ t: 'move', ids: [a], x: 5.5, z: 5.5 }); // replaces both
    w.step();
    const [m] = oids(w, a);
    expect(before).not.toContain(m);
    expect(m!).toBeGreaterThan(Math.max(...before));
    expect(w.submit(dequeue(a, 999_999))).toMatch(/no order 999999/);
    expect(w.submit(dequeue(a, 0.5))).toMatch(/order id/);
    expect(w.submit(dequeue(a, m!))).toBeNull();
    w.step();
    expect(oids(w, a)).toEqual([]);
    expect(w.submit(dequeue(a, m!))).toMatch(/completed or removed/);
  });

  it('two produce orders: the completed one cannot be removed in place of the other', () => {
    const w = flatWorld(48, 48, { rich: true });
    const c = w.spawnUnit(U.commander, 20.5, 20.5);
    w.enqueue({ t: 'produce', id: c });
    w.enqueue({ t: 'produce', id: c });
    w.step();
    const [p1, p2] = oids(w, c);
    for (let t = 0; t < 3000 && oids(w, c).length === 2; t++) w.step();
    expect(oids(w, c)).toEqual([p2]);
    expect(w.submit(dequeue(c, p1!))).toMatch(/completed or removed/);
    expect(oids(w, c)).toEqual([p2]);
  });

  it('ids and the counter are saved: a restored world gives the next order the next id', () => {
    const { w, a } = twoMoves();
    const restored = deserializeWorld(serializeWorld(w));
    expect(oids(restored, a)).toEqual(oids(w, a));
    for (const x of [w, restored]) {
      x.enqueue({ t: 'move', ids: [a], x: 20.5, z: 20.5, queue: true });
      x.step();
    }
    expect(oids(restored, a)).toEqual(oids(w, a));
  });
});
