// W25 acceptance 5: the snapshot carries each unit's queue — order kind, target id or position, and
// for runs the run id — and it matches the world's orders after a scripted sequence. The snapshot
// and the save round-trip: a world restored from a save encodes byte-identical snapshots, now and
// after stepping on.

import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world.ts';
import { B, U } from '../src/sim/kinds.ts';
import { BF_COMPLETE, Q_BUILD, Q_MOVE, Q_PRODUCE, Q_RECLAIM, Q_RUN } from '../src/sim/schema.ts';
import { SNAPSHOT_VERSION, decodeSnapshot, encodeSnapshot, queueOf, snapshotBytes } from '../src/sim/snapshot.ts';
import { deserializeWorld, serializeWorld } from '../src/sim/save.ts';
import { createWorld } from '../src/sim/scenarios.ts';
import type { Order } from '../src/sim/units.ts';
import { unitIds } from './fixtures.ts';

/** What the snapshot should say about one order, worked out from the world independently. */
function expected(w: World, unitSlot: number, o: Order) {
  const bc = w.buildings.cols;
  const centre = (id: number): [number, number] => {
    const s = w.buildings.slotForId(id);
    return s < 0 ? [-1, -1] : [bc.tx[s]! + bc.fw[s]! / 2, bc.ty[s]! + bc.fh[s]! / 2];
  };
  switch (o.t) {
    case 'move':
      return { kind: Q_MOVE, target: -1, run: 0, x: o.x, z: o.z };
    case 'build': {
      const [x, z] = centre(o.id);
      return { kind: Q_BUILD, target: o.id, run: 0, x, z };
    }
    case 'run': {
      const run = w.runs.find((r) => r && r.id === o.run)!;
      const open = run.sites.find((id) => {
        const s = w.buildings.slotForId(id);
        return s >= 0 && !(bc.flags[s]! & BF_COMPLETE);
      });
      const at = o.site >= 0 && w.buildings.slotForId(o.site) >= 0 ? o.site : (open ?? -1);
      const [x, z] = at >= 0 ? centre(at) : [-1, -1];
      return { kind: Q_RUN, target: o.site, run: o.run, x, z };
    }
    case 'produce':
      return { kind: Q_PRODUCE, target: -1, run: 0, x: w.units.cols.x[unitSlot]!, z: w.units.cols.z[unitSlot]! };
    case 'reclaim': {
      const s = w.wrecks.slotForId(o.id);
      return { kind: Q_RECLAIM, target: o.id, run: 0, x: s >= 0 ? w.wrecks.cols.x[s]! : o.x, z: s >= 0 ? w.wrecks.cols.z[s]! : o.z };
    }
  }
}

function scripted(): World {
  const w = createWorld(5, 'sandbox');
  w.unlimited = true;
  // map 1 starts with 2 engineers; three more at the base
  for (let i = 0; i < 3; i++) w.spawnUnit(U.engineer, w.terrain.base.x - 2.5 + i * 2, w.terrain.base.z + 5.5);
  const all = unitIds(w);
  const engs = unitIds(w, U.engineer);
  const cmdr = unitIds(w, U.commander)[0]!;
  w.addWreck(1, 70.5, 74.5, 40);
  const wreck = w.wrecks.id(0);
  const at = (tick: number, f: () => void) => ({ tick, f });
  const script = [
    at(0, () => w.enqueue({ t: 'build', ids: all, kind: B.gun, tx: 60, ty: 50 })),
    at(0, () => w.enqueue({ t: 'build', ids: [engs[0]!], kind: B.wall, tx: 52, ty: 52, queue: true })),
    at(1, () => w.enqueue({ t: 'buildRun', ids: [engs[1]!, engs[2]!], from: [54, 74], to: [62, 74], depth: 2, queue: true })),
    at(1, () => w.enqueue({ t: 'move', ids: [engs[2]!], x: 40.25, z: 70.75, queue: true })),
    at(2, () => w.enqueue({ t: 'reclaim', ids: [engs[3]!], wreck, queue: true })),
    at(2, () => w.enqueue({ t: 'produce', id: cmdr })),
    at(3, () => w.enqueue({ t: 'produce', id: cmdr })),
    at(40, () => w.enqueue({ t: 'dequeue', id: engs[0]!, index: 1 })),
    at(60, () => w.enqueue({ t: 'build', ids: [engs[4]!], kind: B.depot, tx: 66, ty: 66, queue: true })),
  ];
  for (let t = 0; t < 120; t++) {
    for (const s of script) if (s.tick === w.tick) s.f();
    w.step();
  }
  return w;
}

describe('W25 acceptance 5: the queue in the snapshot', () => {
  it('the snapshot version is bumped for the queue section', () => {
    expect(SNAPSHOT_VERSION).toBe(5);
  });

  it('each unit’s queue in the snapshot matches the world’s orders after a scripted sequence', () => {
    const w = scripted();
    const snap = decodeSnapshot(encodeSnapshot(w));
    let total = 0;
    const kinds = new Set<number>();
    for (let row = 0; row < snap.units.count; row++) {
      const id = snap.units.id[row]!;
      const s = w.units.slotForId(id);
      const want = (w.orders[s] ?? []).map((o) => expected(w, s, o));
      const got = queueOf(snap, row);
      expect(got.length, `unit ${id}`).toBe(want.length);
      got.forEach((g, i) => {
        expect([g.kind, g.target, g.run], `unit ${id} order ${i}`).toEqual([want[i]!.kind, want[i]!.target, want[i]!.run]);
        expect(g.x).toBeCloseTo(want[i]!.x, 4);
        expect(g.z).toBeCloseTo(want[i]!.z, 4);
        kinds.add(g.kind);
      });
      total += got.length;
    }
    expect(total).toBeGreaterThan(5);
    // The script left every order kind queued somewhere.
    expect([...kinds].sort()).toEqual([Q_MOVE, Q_BUILD, Q_RUN, Q_PRODUCE, Q_RECLAIM].sort());
  });

  it('the snapshot and the save round-trip', () => {
    const w = scripted();
    const bytes = snapshotBytes(encodeSnapshot(w)).slice();
    const restored = deserializeWorld(serializeWorld(w));
    expect(snapshotBytes(encodeSnapshot(restored))).toEqual(bytes);
    expect(restored.orders.slice(0, w.units.highWater)).toEqual(w.orders.slice(0, w.units.highWater));
    // Decoding and re-encoding nothing changes: the decoded queue is the encoded one.
    const snap = decodeSnapshot(bytes.buffer);
    for (let row = 0; row < snap.units.count; row++) expect(queueOf(snap, row)).toEqual(queueOf(decodeSnapshot(encodeSnapshot(restored)), row));
    // Both worlds go on identically, queues included (a dequeue on the restored one too).
    const eng = unitIds(w, U.engineer)[1]!;
    for (const x of [w, restored]) x.enqueue({ t: 'dequeue', id: eng, index: 0 });
    for (let t = 0; t < 200; t++) {
      w.step();
      restored.step();
    }
    expect(snapshotBytes(encodeSnapshot(restored))).toEqual(snapshotBytes(encodeSnapshot(w)));
  });
});
