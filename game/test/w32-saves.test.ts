// W32 (PLAN-W32 tests 8 and 9): saves and determinism. A build-179 save (version 4, state format 7;
// fixture written by scripts/make-c926e26-save.ts from commit c926e26) loads with every building's
// demolish progress 0 and runs on, demolish included; so do a version 3 save (the d82db0b fixture)
// and a version 2 save (the same fixture with its W25c order ids taken out and its header set to
// version 2, state format 5: the documented difference between the two versions, save.ts header).
// A world saved mid-demolish restores exactly; a save with a demolish value outside 0..1 or NaN fails
// with a named error; two runs of one command log with demolishes give identical snapshots.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { B, U } from '../src/sim/kinds.ts';
import { BF_COMPLETE } from '../src/sim/schema.ts';
import { deserializeWorld, serializeWorld } from '../src/sim/save.ts';
import { encodeSnapshot, snapshotBytes } from '../src/sim/snapshot.ts';
import type { World } from '../src/sim/world.ts';
import { flatWorld } from './fixtures.ts';
import { alive, demolish, demolishOf, demolishTargets, demolishedCount, refundCounter, steps, until, why } from './w32-fixtures.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const snapOf = (w: World) => snapshotBytes(encodeSnapshot(w)).slice();
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Every live building's demolish progress. */
function demolishValues(w: World): number[] {
  const out: number[] = [];
  for (let s = 0; s < w.buildings.highWater; s++) if (w.buildings.alive[s]) out.push(demolishOf(w, w.buildings.id(s)));
  return out;
}

/** A save's bytes as version 2 (state format 5): order ids and the order counter taken out (scripts/fingerprint.test.ts normaliseSave). */
function asVersion2(b: Uint8Array): Uint8Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const state = JSON.parse(new TextDecoder().decode(b.subarray(16, 16 + jsonLen)));
  delete state.scalars.nextOrderId;
  for (const q of state.orders as Array<Array<Record<string, unknown>> | null>) for (const o of q ?? []) delete o.oid;
  const json = new TextEncoder().encode(JSON.stringify(state));
  const blobs = b.subarray(16 + ((jsonLen + 7) & ~7));
  const head = 16 + ((json.length + 7) & ~7);
  const out = new Uint8Array(head + blobs.length);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, dv.getUint32(0, true), true);
  ov.setUint32(4, 2, true);
  ov.setUint32(8, 5, true);
  ov.setUint32(12, json.length, true);
  out.set(json, 16);
  out.set(blobs, head);
  return out;
}

/** An engineer next to a finished wall of the loaded world (spawned there), demolishing it to the end: the refund it credits. */
function demolishAWall(w: World): number {
  const c = w.buildings.cols;
  let wall = -1;
  for (let s = 0; s < w.buildings.highWater && wall < 0; s++) if (w.buildings.alive[s] && c.kind[s] === B.wall && c.flags[s]! & BF_COMPLETE && c.tier[s] === 1) wall = w.buildings.id(s);
  expect(wall, 'a finished tier-1 wall in the save').toBeGreaterThanOrEqual(0);
  const s = w.buildings.slotForId(wall);
  const eng = w.spawnUnit(U.engineer, c.tx[s]! + 0.5, c.ty[s]! + 2.5);
  const before = refundCounter(w)[0];
  expect(why(w.submit(demolish([eng], [wall])))).toBe('(accepted)');
  w.step();
  expect(demolishOf(w, wall)).toBeGreaterThan(0);
  until(w, () => !alive(w, wall), 2000);
  return refundCounter(w)[0] - before;
}

describe('W32 older saves (test 8)', () => {
  it('a build-179 save (version 4, state format 7) loads with every demolish 0 and the new counters 0, runs on, and demolishes', () => {
    const ref = JSON.parse(readFileSync(fixture('c926e26-map1.json'), 'utf8'));
    expect([ref.saveVersion, ref.stateFormat]).toEqual([4, 7]);
    const w = deserializeWorld(readFileSync(fixture('c926e26-map1.save')));
    expect(w.tick).toBe(ref.tick);
    expect(w.buildings.count).toBe(ref.buildings);
    const d = demolishValues(w);
    expect(d.length).toBe(ref.buildings);
    expect(d.every((v) => v === 0)).toBe(true);
    expect(demolishedCount(w)).toBe(0);
    expect(refundCounter(w)).toEqual([0, 0]);
    steps(w, 50);
    expect(w.tick).toBe(ref.tick + 50);
    expect(demolishAWall(w)).toBe(50);
  });

  it('a version 3 save (d82db0b) and a version 2 save load the same way', () => {
    const v3 = readFileSync(fixture('d82db0b-map1.save'));
    const ref = JSON.parse(readFileSync(fixture('d82db0b-map1.json'), 'utf8'));
    expect([ref.saveVersion, ref.stateFormat]).toEqual([3, 6]);
    const v2 = asVersion2(new Uint8Array(v3));
    expect(new DataView(v2.buffer).getUint32(4, true)).toBe(2);
    for (const [name, bytes] of [
      ['version 3', v3],
      ['version 2', v2],
    ] as const) {
      const w = deserializeWorld(bytes);
      expect(w.tick, name).toBe(ref.tick);
      const d = demolishValues(w);
      expect(d.length, name).toBe(ref.buildings);
      expect(d.every((v) => v === 0), name).toBe(true);
      expect(demolishedCount(w), name).toBe(0);
      steps(w, 50);
      expect(demolishAWall(w), name).toBe(50);
    }
  });
});

describe('W32 saves mid-demolish (test 8)', () => {
  /** Walls A and B; e1 and e2 on A (under way), e1 with B queued after it. */
  function midDemolish() {
    const w = flatWorld(40, 40, { rich: true });
    const e1 = w.spawnUnit(U.engineer, 10.5, 13.5);
    const e2 = w.spawnUnit(U.engineer, 11.5, 13.5);
    const a = w.placeBuilding(B.wall, 10, 10, true);
    const b = w.placeBuilding(B.wall, 14, 10, true);
    expect(why(w.submit(demolish([e1, e2], [a])))).toBe('(accepted)');
    expect(why(w.submit(demolish([e1], [b], true)))).toBe('(accepted)');
    steps(w, 10);
    return { w, e1, e2, a, b };
  }

  it('saved and restored mid-demolish, the world runs on equal to the uninterrupted one every tick; both remove both walls and credit both refunds', () => {
    const { w: a, e1, e2, a: wa, b: wb } = midDemolish();
    expect(demolishOf(a, wa)).toBeGreaterThan(0);
    expect(demolishTargets(a, e1)).toEqual([wa, wb]);
    expect(demolishTargets(a, e2)).toEqual([wa]);
    const bytes = serializeWorld(a);
    const b = deserializeWorld(bytes);
    expect(same(serializeWorld(b), bytes), 'the restored world saves to the same bytes').toBe(true);
    expect(demolishOf(b, wa)).toBe(demolishOf(a, wa));
    for (let t = 0; t < 200; t++) {
      a.step();
      b.step();
      expect(same(snapOf(b), snapOf(a)), `tick ${a.tick}`).toBe(true);
    }
    for (const w of [a, b]) {
      expect(alive(w, wa) || alive(w, wb)).toBe(false);
      expect(refundCounter(w)).toEqual([100, 0]);
      expect(demolishedCount(w)).toBe(2);
    }
  });

  it('a save with a demolish value of 1.5 or NaN fails to load with a named error', () => {
    for (const bad of [1.5, NaN, -0.5]) {
      const { w, a } = midDemolish();
      const col = (w.buildings.cols as unknown as Record<string, Float32Array | undefined>).demolish;
      expect(col, 'the demolish column').toBeDefined();
      col![w.buildings.slotForId(a)] = bad;
      let err: unknown = null;
      try {
        deserializeWorld(serializeWorld(w));
      } catch (e) {
        err = e;
      }
      expect(err, `demolish ${bad}`).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('SaveDemolishError');
      expect((err as Error).message).toMatch(/demolish/);
    }
  });
});

describe('W32 determinism (test 9)', () => {
  it('two runs of the same command log with demolishes remove the targets, credit the refunds and give identical snapshots every tick', () => {
    const start = () => {
      const w = flatWorld(50, 30, { rich: true });
      const e = [w.spawnUnit(U.engineer, 12.5, 13.5), w.spawnUnit(U.engineer, 20.5, 13.5), w.spawnUnit(U.engineer, 16.5, 13.5)];
      const walls = [10, 11, 12, 13, 14].map((x) => w.placeBuilding(B.wall, x, 10, true));
      const gun = w.placeBuilding(B.gun, 20, 9, true);
      const belts = [22, 23, 24].map((x) => w.placeBuilding(B.belt, x, 10, true, 0));
      w.enqueue(demolish([e[0]!, e[2]!], walls.slice(0, 3)), 0);
      w.enqueue(demolish([e[1]!], [gun, ...belts], false), 5);
      w.enqueue({ t: 'stop', ids: [e[2]!] }, 40);
      w.enqueue(demolish([e[2]!], walls.slice(3), true), 60);
      return { w, ids: [...walls, gun, ...belts] };
    };
    const a = start();
    const b = start();
    for (let t = 0; t < 900; t++) {
      a.w.step();
      b.w.step();
      expect(same(snapOf(b.w), snapOf(a.w)), `tick ${a.w.tick}`).toBe(true);
    }
    for (const r of [a, b]) {
      expect(r.ids.filter((id) => alive(r.w, id)), 'every target removed').toEqual([]);
      expect(refundCounter(r.w)[0]).toBeCloseTo(5 * 50 + 100 + 3 * 0.25, 9);
      expect(demolishedCount(r.w)).toBe(9);
    }
  });
});
