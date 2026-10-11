// W24 run 3, criterion 7 (Codex R1-3): determinism and save continuation for the two new order
// paths. The baseline fingerprint comparison with 60ebba6 does not exercise them, so this script
// does: C2 (an unshifted build on the unit's own reserved site), shared ownership (a site held by
// two units, one issuing: refused; both issuing: accepted), C3 with an overlapping reuse (a full
// run table, the unshifted run keeping the old run's sites), a command made invalid between issue
// and apply (validated, then another unit takes the site first), and a C3 refusal. Every command is
// submitted through validation. The script runs twice and once saved at its midpoint and loaded;
// the full snapshot (queues and order ids included) and the save bytes are compared every 50 ticks.

import { describe, expect, it } from 'vitest';
import { B, U } from '../src/sim/kinds.ts';
import { encodeSnapshot, snapshotBytes } from '../src/sim/snapshot.ts';
import { deserializeWorld, serializeWorld } from '../src/sim/save.ts';
import { RUN_CAPACITY } from '../src/sim/runs.ts';
import type { Command } from '../src/sim/commands.ts';
import { World } from '../src/sim/world.ts';
import { flatTerrain } from '../src/sim/terrain.ts';

const END = 600;
const MID = 300;

function fnv(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
  return h;
}

interface Ids {
  e1: number;
  e2: number;
  e3: number;
  hoarder: number;
  idle: number;
}

function start(): { w: World; ids: Ids } {
  const w = new World(7, flatTerrain(100, 100), { waves: false });
  w.pool.set([1e6, 1e6, 1e6]);
  const ids: Ids = {
    e1: w.spawnUnit(U.engineer, 20.5, 20.5),
    e2: w.spawnUnit(U.engineer, 22.5, 20.5),
    e3: w.spawnUnit(U.engineer, 24.5, 20.5),
    hoarder: w.spawnUnit(U.engineer, 90.5, 90.5),
    idle: w.spawnUnit(U.engineer, 92.5, 92.5),
  };
  return { w, ids };
}

const siteAt = (w: World, tx: number, ty: number) => {
  const s = w.occupancy[ty * w.terrain.w + tx]! - 1;
  return s >= 0 ? w.buildings.id(s) : -1;
};

/** The script: commands submitted (validated) at their tick, before it runs. */
function script(w: World, ids: Ids): Command[] {
  const { e1, e2, e3, hoarder, idle } = ids;
  const t = w.tick;
  const out: Command[] = [];
  const b = (bids: number[], kind: number, tx: number, ty: number, queue: boolean): Command => ({ t: 'build', ids: bids, kind, tx, ty, dir: 0, queue });
  if (t === 1) out.push(b([e1], B.gun, 40, 30, true), b([e1], B.gun, 44, 30, true));
  if (t === 2) out.push(b([e1], B.gun, 40, 30, false)); // C2
  if (t === 3) out.push(b([e2, e3], B.area, 50, 30, true));
  if (t === 4) out.push(b([e2], B.area, 50, 30, false)); // shared, one issuing: refused
  if (t === 5) out.push(b([e2, e3], B.area, 50, 30, false)); // shared, both issuing: accepted
  if (t === 10) {
    out.push({ t: 'buildRun', ids: [e1], from: [10, 60], to: [14, 60], depth: 1, queue: true });
    for (let i = 0; i < RUN_CAPACITY - 1; i++) out.push({ t: 'buildRun', ids: [hoarder], from: [60, 10 + 2 * i], to: [62, 10 + 2 * i], depth: 1, queue: true });
  }
  if (t === 12) out.push({ t: 'buildRun', ids: [e1], from: [10, 60], to: [17, 60], depth: 1 }); // C3 with reuse
  if (t === 18) out.push(b([e2], B.gun, 60, 80, true));
  if (t === 20) {
    // validated now; at apply the assist goes first, so e3 holds the site and the build is refused
    const site = siteAt(w, 60, 80);
    out.push({ t: 'assist', ids: [e3], target: site, queue: true }, b([e2], B.gun, 60, 80, false));
  }
  if (t === 25) out.push({ t: 'buildRun', ids: [idle], from: [10, 90], to: [14, 90], depth: 1 }); // C3 refused
  return out;
}

interface Trace {
  snaps: Map<number, number>;
  saves: Map<number, number>;
  submitRefusals: string[];
  applyRefusals: string[];
  seen: Record<string, unknown>;
  save: Uint8Array | null;
}

function play(w: World, ids: Ids, end: number, saveAt = -1): Trace {
  const tr: Trace = { snaps: new Map(), saves: new Map(), submitRefusals: [], applyRefusals: [], seen: {}, save: null };
  while (w.tick < end) {
    if (w.tick === saveAt) tr.save = serializeWorld(w);
    if (w.tick % 50 === 0) {
      tr.snaps.set(w.tick, fnv(snapshotBytes(encodeSnapshot(w))));
      tr.saves.set(w.tick, fnv(serializeWorld(w)));
    }
    for (const c of script(w, ids)) {
      const r = w.submit(c);
      if (r) tr.submitRefusals.push(`${w.tick}: ${r}`);
    }
    const t = w.tick;
    const before = w.applyRejected.length;
    w.step();
    for (const r of w.applyRejected.slice(before)) tr.applyRefusals.push(`${t}: ${r.reason}`);
    const q = (id: number) => w.orders[w.units.slotForId(id)] ?? [];
    if (t === 2) tr.seen.c2 = q(ids.e1).map((o) => (o.t === 'build' ? o.id : o.t));
    if (t === 2) tr.seen.c2site = siteAt(w, 40, 30);
    if (t === 5) tr.seen.shared = [q(ids.e2).length, q(ids.e3).length];
    if (t === 10) tr.seen.full = w.runs.filter((r) => r !== null).length;
    if (t === 12) {
      const o = q(ids.e1)[0];
      const run = w.runs.find((r) => r !== null && o?.t === 'run' && r.id === o.run);
      tr.seen.c3 = { runs: w.runs.filter((r) => r !== null).length, tiles: run?.sites.length ?? -1 };
    }
  }
  tr.snaps.set(w.tick, fnv(snapshotBytes(encodeSnapshot(w))));
  tr.saves.set(w.tick, fnv(serializeWorld(w)));
  return tr;
}

describe('run 3 criterion 7: C2 and C3 are deterministic and continue from a save', () => {
  const a = (() => {
    const { w, ids } = start();
    return play(w, ids, END, MID);
  })();

  it('the script exercises C2, shared ownership, C3 with reuse, an apply-time refusal and a C3 refusal', () => {
    expect((a.seen.c2 as number[]).length).toBe(1);
    expect(a.seen.c2).toEqual([a.seen.c2site]);
    expect(a.seen.shared).toEqual([1, 1]);
    expect(a.seen.full).toBe(RUN_CAPACITY);
    expect(a.seen.c3).toEqual({ runs: RUN_CAPACITY, tiles: 8 });
    expect(a.submitRefusals.some((r) => r.startsWith('4: '))).toBe(true);
    expect(a.submitRefusals.some((r) => r.startsWith('25: ') && /run table is full/.test(r))).toBe(true);
    expect(a.applyRefusals.some((r) => r.startsWith('20: '))).toBe(true);
  });

  it('a second run gives the same snapshots and saves every 50 ticks', () => {
    const { w, ids } = start();
    const b = play(w, ids, END);
    expect([...b.snaps]).toEqual([...a.snaps]);
    expect([...b.saves]).toEqual([...a.saves]);
    expect(b.submitRefusals).toEqual(a.submitRefusals);
    expect(b.applyRefusals).toEqual(a.applyRefusals);
  });

  it('saved at the midpoint and loaded, it continues identically', () => {
    expect(a.save).not.toBeNull();
    const { ids } = start();
    const w = deserializeWorld(a.save!);
    expect(w.tick).toBe(MID);
    const c = play(w, ids, END);
    for (const [tick, h] of c.snaps) expect(h, `snapshot at tick ${tick}`).toBe(a.snaps.get(tick));
    for (const [tick, h] of c.saves) expect(h, `save at tick ${tick}`).toBe(a.saves.get(tick));
  });
});
