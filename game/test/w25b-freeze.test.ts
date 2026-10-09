// W25b: Richard's "build seems to freeze here" (2026-10-09). Reproduced with his sequence — the
// commander and both engineers selected; a wall drag; Shift + drag a run west from its west end;
// Shift + drag a run south from its east end; Shift + place a gun turret at the south end — run
// headless here and with real mouse input in the browser (scripts/check-queue.mjs, item W25b).
//
// Cause: resource starvation, not a stuck simulation. The sandbox starts with about 600 mass and
// the commander's income of 1 mass/s; a wall costs 100 mass and 150 energy. With free spending
// off the pool is empty after about 30 s (tick ~280), and from then on every site in progress
// shares 1 mass/s: three builders on three wall tiles take about 300 s per three tiles. The
// builders keep their beams on their sites and the progress moves by fractions of a percent per
// second, which looks frozen. With free spending on, the same orders finish (all four items).
//
// The fix makes the wait visible by shape and label (render/waiting.ts, render/waitView.ts,
// ui/hud.ts): every site that builders are working on and that gets less than its full supply
// carries an hourglass marker labelled "waiting for <resource>", each of its builders carries the
// same label, and the resource readout marks the short resource and how many sites wait on it.

import { describe, expect, it } from 'vitest';
import { Scene } from 'three';
import { createWorld } from '../src/sim/scenarios.ts';
import { B, U } from '../src/sim/kinds.ts';
import { isReserved } from '../src/sim/schema.ts';
import { waitingState, waitingText } from '../src/render/waiting.ts';
import { WaitOverlay, inspectWaiting } from '../src/render/waitView.ts';
import { economyText } from '../src/ui/hud.ts';
import { flatWorld } from './fixtures.ts';
import { camera, mobile, snapshotOf } from './w24r2a-fixtures.ts';
import { inProgress, richardsSequence, sites } from './w25b-fixtures.ts';

describe('W25b: waiting made visible', () => {
  /** Richard's sequence, free spending off, 60 s after the mass ran out. */
  function starved() {
    const { w, ids } = richardsSequence(false);
    while (w.tick < 900) w.step();
    return { w, ids, snap: snapshotOf(w) };
  }

  it('waitingState: every site being built at less than full supply waits for mass, and so do its builders', () => {
    const { w, ids, snap } = starved();
    const ws = waitingState(snap);
    expect(ws.short).toEqual(['mass']);
    const working = inProgress(w).filter((b) => w.buildings.cols.builders[w.buildings.slotForId(b.id)]! > 0);
    expect(working.length).toBe(3);
    expect(ws.sites.map((s) => s.id).sort()).toEqual(working.map((b) => b.id).sort());
    for (const s of ws.sites) {
      expect(s.short).toEqual(['mass']);
      expect(s.supply).toBeGreaterThan(0);
      expect(s.supply).toBeLessThan(0.1);
      const slot = w.buildings.slotForId(s.id);
      expect(s.x).toBe(w.buildings.cols.tx[slot]! + 0.5);
      expect(s.z).toBe(w.buildings.cols.ty[slot]! + 0.5);
    }
    // all three builders are on a waiting site, each labelled with its site and the resource
    expect(ws.builders.map((b) => b.id).sort()).toEqual([...ids].sort());
    for (const b of ws.builders) {
      expect(b.short).toEqual(['mass']);
      expect(w.units.cols.work[w.units.slotForId(b.id)]! - 1).toBe(b.site);
    }
    expect(waitingText(['mass'])).toBe('waiting for mass');
    expect(waitingText(['mass', 'energy'])).toBe('waiting for mass and energy');
  });

  it('free spending on: nothing waits', () => {
    const { w } = richardsSequence(true);
    while (w.tick < 300) w.step();
    expect(inProgress(w).length).toBeGreaterThan(0);
    const ws = waitingState(snapshotOf(w));
    expect(ws).toEqual({ short: [], sites: [], builders: [] });
  });

  it('the resource is the one the site draws that is short: a wall with no energy waits for energy, not mass', () => {
    const w = flatWorld(30, 30); // no commander: no income
    w.pool.set([5000, 0, 0]);
    const e = w.spawnUnit(U.engineer, 10.5, 12.5);
    w.enqueue({ t: 'build', ids: [e], kind: B.wall, tx: 10, ty: 10 });
    for (let i = 0; i < 5; i++) w.step();
    const ws = waitingState(snapshotOf(w));
    expect(ws.short).toEqual(['energy']);
    expect(ws.sites.length).toBe(1);
    expect(ws.sites[0]!.short).toEqual(['energy']);
    expect(ws.sites[0]!.supply).toBe(0);
    expect(ws.builders).toEqual([{ id: e, site: ws.sites[0]!.id, short: ['energy'] }]);
  });

  it('a site with no builder on it does not wait (it is not being built): no marker on reserved or abandoned sites', () => {
    const { w, snap } = starved();
    const ws = waitingState(snap);
    const reserved = sites(w).filter((b) => isReserved(b.flags)).map((b) => b.id);
    expect(reserved.length).toBeGreaterThan(0);
    expect(ws.sites.some((s) => reserved.includes(s.id))).toBe(false);
  });

  it('the scene: an hourglass marker labelled "waiting for mass" on each waiting site, and the same label over each of its builders', () => {
    const { snap } = starved();
    const ws = waitingState(snap);
    const scene = new Scene();
    const o = new WaitOverlay(scene, createWorld(1, 'sandbox').terrain);
    o.update({ camera: camera({ x: 64, z: 62, distance: 40, yaw: 0 }), viewportHeight: 900, snapshot: snap, units: mobile(snap.units) });
    const got = inspectWaiting(scene);
    expect(got.sites.length).toBe(3);
    for (const m of got.sites) {
      expect(m.text).toBe('waiting for mass');
      expect(m.icon).toBe('hourglass');
      const s = ws.sites.find((x) => x.id === m.site)!;
      expect(s, `marker for site ${m.site}`).toBeTruthy();
      expect(m.x).toBeCloseTo(s.x, 5);
      expect(m.z).toBeCloseTo(s.z, 5);
    }
    expect(got.builders.length).toBe(3);
    for (const l of got.builders) {
      expect(l.text).toBe('waiting for mass');
      expect(l.icon).toBe('hourglass');
      const r = Array.prototype.indexOf.call(snap.units.id, l.unit);
      expect(l.x).toBeCloseTo(snap.units.cols.x[r]!, 5);
      expect(l.z).toBeCloseTo(snap.units.cols.z[r]!, 5);
    }
    // once supply is back (free spending), the markers go
    const { w: rich } = richardsSequence(true);
    while (rich.tick < 300) rich.step();
    const snap2 = snapshotOf(rich);
    o.update({ camera: camera({ x: 64, z: 62, distance: 40, yaw: 0 }), viewportHeight: 900, snapshot: snap2, units: mobile(snap2.units) });
    expect(inspectWaiting(scene)).toEqual({ sites: [], builders: [] });
  });

  it('the resource readout marks the short resource and how many sites wait on it (text and a ▲, no colour)', () => {
    const text = economyText({
      pool: [0, 812, 0],
      income: [1, 10, 0],
      spend: [1, 2.5, 0],
      short: [true, false, false],
      waiting: [3, 0, 0],
      parts: 0,
      commanderHp: 6000,
      commanderMax: 6000,
      aliens: 0,
      kills: 0,
      upkeep: 1,
      lost: false,
      won: false,
    });
    const [mass, energy, rare] = text.split('\n');
    expect(mass).toMatch(/^MASS .*▲SHORT · 3 sites waiting$/);
    expect(energy).not.toMatch(/SHORT|waiting/);
    expect(rare).not.toMatch(/SHORT|waiting/);
    const one = economyText({ pool: [0, 0, 0], income: [1, 0, 0], spend: [1, 0, 0], short: [true, false, false], waiting: [1, 0, 0], parts: 0, commanderHp: 1, commanderMax: 1, aliens: 0, kills: 0, upkeep: 1, lost: false, won: false });
    expect(one.split('\n')[0]).toMatch(/▲SHORT · 1 site waiting$/);
  });
});

describe('W25b: the marker follows the shortage tick by tick', () => {
  it('a site starved of mass shows the marker in the first snapshot after the shortage, and loses it in the first snapshot after supply resumes', () => {
    const w = flatWorld(30, 30); // no commander: no income, so the pool alone decides
    w.pool.set([40, 1e6, 0]);
    const e = w.spawnUnit(U.engineer, 10.5, 12.5);
    w.enqueue({ t: 'build', ids: [e], kind: B.wall, tx: 10, ty: 10 });
    const scene = new Scene();
    const o = new WaitOverlay(scene, w.terrain);
    const draw = () => {
      const snap = snapshotOf(w);
      o.update({ camera: camera({ x: 15, z: 15, distance: 30, yaw: 0 }), viewportHeight: 900, snapshot: snap, units: mobile(snap.units) });
      return inspectWaiting(scene);
    };
    // full supply while the 40 mass lasts: no marker on any snapshot
    let t = 0;
    while (!(w.shortMask & 1) && t++ < 400) {
      expect(draw().sites, `tick ${w.tick}: no marker while supplied`).toEqual([]);
      w.step();
    }
    expect(w.shortMask & 1, 'mass ran short').toBe(1);
    // the first snapshot taken after the short tick carries the marker and the builder label
    const short = draw();
    expect(short.sites.map((s) => s.text)).toEqual(['waiting for mass']);
    expect(short.builders.map((b) => [b.unit, b.text])).toEqual([[e, 'waiting for mass']]);
    // starved for a while: still marked on every snapshot
    for (let i = 0; i < 20; i++) {
      w.step();
      expect(draw().sites.length, `tick ${w.tick}: marked while starved`).toBe(1);
    }
    // income resumes (a delivery or bonus into the pool): one tick later the marker is gone
    w.pool[0] = w.pool[0]! + 1000;
    w.step();
    expect(w.shortMask & 1).toBe(0);
    expect(draw()).toEqual({ sites: [], builders: [] });
  });
});
