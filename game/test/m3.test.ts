// M3: waves, time controls, call-early bonus, checkpoints, research, win and loss, saves, and
// command validation.

import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world.ts';
import { createWorld } from '../src/sim/scenarios.ts';
import { A, ALIEN_KINDS, B, U } from '../src/sim/kinds.ts';
import { BF_COMPLETE } from '../src/sim/schema.ts';
import { encodeSnapshot, snapshotBytes } from '../src/sim/snapshot.ts';
import { SimRunner } from '../src/sim/runner.ts';
import { SAVE_VERSION, SaveVersionError, deserializeWorld, serializeWorld } from '../src/sim/save.ts';
import { CALL_EARLY_BONUS_PER_SECOND, RESEARCH, researchBit } from '../src/sim/balance.ts';
import { alienKindIndex, buildingKindIndex, researchNodeId } from '../src/sim/names.ts';
import { map1 } from '../../model/data/map1.ts';
import type { Command } from '../src/sim/commands.ts';
import { unitIds } from './fixtures.ts';

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const bytesOf = (w: World) => snapshotBytes(encodeSnapshot(w)).slice();

// ---- waves ----------------------------------------------------------------------------------

describe('waves', () => {
  it('nothing arrives before wave 1 (3:00); wave 1 arrives at it', () => {
    const w = createWorld(1, 'map1');
    const wave1 = map1.waves[0]!.at * 10;
    expect(wave1).toBe(1800);
    while (w.tick < wave1) {
      w.step();
      if (w.aliens.count > 0) throw new Error(`alien before wave 1 at tick ${w.tick}`);
    }
    expect(w.nextWave).toBe(0);
    w.step(); // tick 1800: wave 1 starts and its first alien appears
    expect(w.nextWave).toBe(1);
    expect(w.aliens.count).toBe(1);
    expect(w.lastWaveTick).toBe(1800);
  });

  it("every wave's composition (kind, count, entry) matches map1.ts", () => {
    const w = createWorld(2, 'map1');
    // Compress the schedule (400 ticks apart) and kill everything at once, so the test is quick.
    for (let i = 0; i < w.waveTicks.length; i++) w.waveTicks[i] = 100 + i * 400;
    const seen = new Map<string, number>();
    const spawn = w.spawnAlien.bind(w);
    w.spawnAlien = (kind, x, z) => {
      const e = w.terrain.entries.reduce((best, en, i) => (Math.hypot(en.x - x, en.z - z) < Math.hypot(w.terrain.entries[best]!.x - x, w.terrain.entries[best]!.z - z) ? i : best), 0);
      const key = `${w.nextWave}|${w.terrain.entries[e]!.name}|${ALIEN_KINDS[kind]}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return spawn(kind, x, z);
    };
    while (w.nextWave < w.waveTicks.length || w.pendingSpawns > 0) {
      w.step();
      for (let s = 0; s < w.aliens.highWater; s++) if (w.aliens.alive[s]) w.aliens.cols.hp[s] = 0;
    }
    const expected = new Map<string, number>();
    map1.waves.forEach((wave, i) => {
      for (const g of wave.groups) expected.set(`${i + 1}|${g.entry}|${g.kind}`, (expected.get(`${i + 1}|${g.entry}|${g.kind}`) ?? 0) + g.count);
    });
    expect(Object.fromEntries(seen)).toEqual(Object.fromEntries(expected));
    expect(map1.waves.length).toBe(20);
  });
});

// ---- time controls --------------------------------------------------------------------------

describe('pause and speed', () => {
  it('pause stops ticks, still accepts orders, and applies them after resume', () => {
    const r = new SimRunner(createWorld(1, 'map1'), 0);
    let now = 0;
    for (; now < 1000; now += 10) r.advance(now);
    const tick = r.world.tick;
    expect(tick).toBeGreaterThan(5);
    r.setPaused(true, now);
    const before = bytesOf(r.world);
    const cmdr = unitIds(r.world, U.commander)[0]!;
    expect(r.submit({ t: 'move', ids: [cmdr], x: 40, z: 40 })).toBeNull();
    for (let i = 0; i < 300; i++, now += 10) expect(r.advance(now)).toBe(0);
    expect(r.world.tick).toBe(tick);
    expect(same(bytesOf(r.world), before)).toBe(true); // nothing moved, the order waits
    r.setPaused(false, now);
    for (let i = 0; i < 100; i++, now += 10) r.advance(now);
    expect(r.world.tick).toBeGreaterThan(tick);
    expect(r.world.log.some((s) => s.cmd.t === 'move' && s.tick === tick)).toBe(true); // applied on the first tick after resume
    const s = r.world.units.slotForId(cmdr);
    // W29: the core stands west of the commander, so the first steps go north round it; the move
    // applied shows as the commander nearer (40, 40) than where it stood
    expect(Math.hypot(r.world.units.cols.x[s]! - 40, r.world.units.cols.z[s]! - 40)).toBeLessThan(Math.hypot(64.5 - 40, 64.5 - 40));
  });

  it('1× and 3× runs of the same command log give identical state at the same tick', () => {
    const script: Array<[number, (w: World) => Command]> = [
      [5, (w) => ({ t: 'build', ids: unitIds(w), kind: B.gun, tx: 62, ty: 54 })],
      [40, (w) => ({ t: 'move', ids: unitIds(w, U.engineer).slice(0, 1), x: 50, z: 70 })],
      [120, () => ({ t: 'spawn', kind: A.rusher, entry: 0, count: 6 })],
      [300, () => ({ t: 'callWave' })],
    ];
    const run = (speed: number) => {
      const r = new SimRunner(createWorld(9, 'map1'), 0);
      r.setSpeed(speed, 0);
      const sent = new Set<number>();
      let now = 0;
      while (r.world.tick < 900) {
        for (const [t, f] of script) if (r.world.tick === t && !sent.has(t)) {
          expect(r.submit(f(r.world))).toBeNull();
          sent.add(t);
        }
        now += 5; // small steps: at most one tick per advance at 3×
        r.advance(now);
      }
      return { bytes: bytesOf(r.world), wall: now };
    };
    const a = run(1);
    const b = run(3);
    expect(same(a.bytes, b.bytes)).toBe(true);
    expect(b.wall).toBeLessThan(a.wall / 2.5); // 3× reached tick 900 in about a third of the time
  });
});

// ---- call early --------------------------------------------------------------------------------

describe('calling the next wave early', () => {
  it('brings the wave forward to now and pays exactly the stated bonus', () => {
    const called = createWorld(4, 'map1');
    const control = createWorld(4, 'map1');
    for (let i = 0; i < 100; i++) {
      called.step();
      control.step();
    }
    expect(called.submit({ t: 'callWave' })).toBeNull();
    called.step(); // tick 100: applied; the wave moves to tick 101
    control.step();
    const skipped = 1800 - 101;
    expect(called.waveTicks[0]).toBe(101);
    expect(called.waveTicks[1]).toBe(map1.waves[1]!.at * 10 - skipped); // later waves move too
    expect(called.skippedTicks).toBe(skipped);
    const bonus = [(skipped / 10) * CALL_EARLY_BONUS_PER_SECOND[0], (skipped / 10) * CALL_EARLY_BONUS_PER_SECOND[1]];
    expect(bonus[0]).toBeCloseTo(254.85, 9); // 169.9 s × 1.5 mass
    expect(bonus[1]).toBeCloseTo(849.5, 9); // 169.9 s × 5 energy
    expect(called.pool[0]! - control.pool[0]!).toBeCloseTo(bonus[0]!, 9);
    expect(called.pool[1]! - control.pool[1]!).toBeCloseTo(bonus[1]!, 9);
    expect(called.pool[2]).toBe(control.pool[2]);
    called.step(); // tick 101: wave 1 starts
    expect(called.nextWave).toBe(1);
    expect(called.aliens.count).toBe(1);
    expect(control.nextWave).toBe(0);
  });
});

// ---- checkpoints -------------------------------------------------------------------------------

describe('wave checkpoints', () => {
  it('restore + replay of the same commands is byte-identical to the original run', () => {
    const r = new SimRunner(createWorld(6, 'map1'), 0);
    const w0 = r.world;
    for (let i = 0; i < 10; i++) w0.waveTicks[i] = 300 + i * 300; // compress waves 1..10
    const ids = unitIds(w0);
    const plan: Array<[number, Command]> = [
      [1, { t: 'build', ids, kind: B.gun, tx: 62, ty: 54 }],
      [2, { t: 'build', ids, kind: B.area, tx: 66, ty: 54, queue: true }],
      [250, { t: 'move', ids: ids.slice(1, 2), x: 70, z: 70 }],
      [450, { t: 'build', ids, kind: B.wall, tx: 60, ty: 50, queue: true }],
      [700, { t: 'spawn', kind: A.saboteur, entry: 1, count: 3 }],
      [880, { t: 'callWave' }],
    ];
    const runTo = (end: number, from: Array<[number, Command]>) => {
      while (r.world.tick < end) {
        for (const [t, c] of from) if (r.world.tick === t) expect(r.submit(c)).toBeNull();
        r.stepOnce();
      }
    };
    runTo(1300, plan);
    expect(r.checkpoints.map((c) => c.wave)).toEqual([1, 2, 3, 4]);
    const original = serializeWorld(r.world);
    const originalSnap = bytesOf(r.world);
    // Rewind to the checkpoint at wave 2's start and replay the commands given after it.
    const cp = r.checkpoints[1]!;
    r.world = deserializeWorld(cp.bytes);
    expect(r.world.tick).toBe(cp.tick);
    runTo(1300, plan.filter(([t]) => t >= cp.tick));
    expect(same(bytesOf(r.world), originalSnap)).toBe(true);
    expect(same(serializeWorld(r.world), original)).toBe(true);
  });

  it('rewind restores the start of the current wave, then the one before', () => {
    const r = new SimRunner(createWorld(6, 'map1'), 0);
    for (let i = 0; i < 4; i++) r.world.waveTicks[i] = 200 + i * 200;
    while (r.world.tick < 700) r.stepOnce();
    expect(r.rewind()).toEqual({ wave: 3, tick: 600 });
    expect(r.world.tick).toBe(600);
    expect(r.rewind()).toEqual({ wave: 2, tick: 400 });
    expect(r.checkpoints.length).toBe(2);
  });
});

// ---- research ----------------------------------------------------------------------------------

describe('research', () => {
  it('gates wall tiers: an upgrade before the research is rejected, after it succeeds', () => {
    const w = createWorld(1, 'map1');
    w.pool.set([1e5, 1e5, 1e3]);
    const wall = w.placeBuilding(B.wall, 60, 60, true);
    const eng = unitIds(w, U.engineer);
    const refused = w.submit({ t: 'upgrade', ids: eng, target: wall });
    expect(refused).toMatch(/needs research "Wall tier 2"/);
    w.placeBuilding(B.lab, 66, 66, true);
    expect(w.submit({ t: 'research', node: 'wallT2' })).toBeNull();
    let t = 0;
    while (!w.researched('wallT2') && t++ < 2000) w.step();
    expect(w.researched('wallT2')).toBe(true);
    expect(t).toBeGreaterThanOrEqual(RESEARCH.find((r) => r.id === 'wallT2')!.seconds * 10 - 1); // one station: 1 RP/s
    expect(w.submit({ t: 'upgrade', ids: eng, target: wall })).toBeNull();
    for (let i = 0; i < 600; i++) w.step();
    expect(w.buildings.cols.tier[w.buildings.slotForId(wall)]).toBe(2);
    expect(w.buildings.cols.maxHp[w.buildings.slotForId(wall)]).toBe(3000);
    // Tier 3 still needs its own research.
    expect(w.submit({ t: 'upgrade', ids: eng, target: wall })).toMatch(/Wall tier 3/);
  });

  it('cannot be refunded or undone: no repeat, and it survives losing the station', () => {
    const w = createWorld(1, 'map1');
    w.pool.set([1e5, 1e5, 1e3]);
    const lab = w.placeBuilding(B.lab, 66, 66, true);
    w.submit({ t: 'research', node: 'gunT2' });
    while (!w.researched('gunT2')) w.step();
    const pool = Array.from(w.pool);
    expect(w.submit({ t: 'research', node: 'gunT2' })).toMatch(/already researched/);
    expect(Array.from(w.pool)).toEqual(pool); // a refused request costs and refunds nothing
    w.removeBuilding(w.buildings.slotForId(lab));
    for (let i = 0; i < 50; i++) w.step();
    expect(w.researchDone & researchBit('gunT2')).toBe(researchBit('gunT2'));
  });

  it('gates buildings: the beam turret needs its research', () => {
    const w = createWorld(1, 'map1');
    expect(w.submit({ t: 'build', ids: unitIds(w), kind: B.beam, tx: 60, ty: 50 })).toMatch(/needs research "Beam turret"/);
    w.researchDone |= researchBit('beam');
    expect(w.submit({ t: 'build', ids: unitIds(w), kind: B.beam, tx: 60, ty: 50 })).toBeNull();
  });

  it('stations draw the node cost from the pool and research stops with no station', () => {
    const w = createWorld(1, 'map1');
    w.pool.set([1e5, 1e5, 1e3]);
    w.submit({ t: 'research', node: 'scanners' });
    for (let i = 0; i < 100; i++) w.step();
    expect(w.researchProgress).toBe(0); // no station yet
    w.placeBuilding(B.lab, 66, 66, true);
    const rare0 = w.pool[2]!;
    for (let i = 0; i < 100; i++) w.step();
    expect(w.researchProgress).toBeGreaterThan(0.3);
    expect(w.pool[2]!).toBeLessThan(rare0); // the rare material is spent as it runs
  });
});

// ---- win and loss ------------------------------------------------------------------------------

describe('win and loss', () => {
  it('losing every extractor does not end the run; losing the commander does', () => {
    const w = createWorld(1, 'map1');
    const ex = [w.placeBuilding(B.massExtractor, 54, 50, true), w.placeBuilding(B.massExtractor, 72, 49, true)];
    for (const id of ex) w.buildings.cols.hp[w.buildings.slotForId(id)] = 0;
    for (let i = 0; i < 20; i++) w.step();
    expect(w.buildings.count).toBe(1); // W29: the core stays
    expect(w.outcome).toBe(0);
    for (const id of unitIds(w, U.engineer)) w.units.cols.hp[w.units.slotForId(id)] = 0;
    w.step();
    expect(w.outcome).toBe(0); // engineers gone: still playing
    w.units.cols.hp[w.commanderSlot()] = 0;
    w.step();
    expect(w.outcome).toBe(1);
    const end = w.tick;
    expect(w.endTick).toBe(end - 1);
    w.step();
    expect(w.tick).toBe(end); // the run is over
  });

  it('surviving wave 20 wins', () => {
    const w = createWorld(3, 'map1');
    for (let i = 0; i < w.waveTicks.length; i++) w.waveTicks[i] = 50 + i * 400;
    let guard = 0;
    while (w.outcome === 0 && guard++ < 20000) {
      w.step();
      for (let s = 0; s < w.aliens.highWater; s++) if (w.aliens.alive[s]) w.aliens.cols.hp[s] = 0;
    }
    expect(w.outcome).toBe(2);
    expect(w.nextWave).toBe(20);
    expect(w.kills).toBe(map1.waves.reduce((n, wave) => n + wave.groups.reduce((m, g) => m + g.count, 0), 0));
  });

  it('wave 19 cleared is not a win while wave 20 is still to come', () => {
    const w = createWorld(3, 'map1');
    for (let i = 0; i < 19; i++) w.waveTicks[i] = 50 + i * 400;
    w.waveTicks[19] = 50 + 19 * 400 + 3000;
    for (let i = 0; i < 50 + 19 * 400 + 1000; i++) {
      w.step();
      for (let s = 0; s < w.aliens.highWater; s++) if (w.aliens.alive[s]) w.aliens.cols.hp[s] = 0;
    }
    expect(w.nextWave).toBe(19);
    expect(w.outcome).toBe(0);
  });
});

// ---- saves -------------------------------------------------------------------------------------

describe('save files', () => {
  it('export -> import round-trips byte-identically, and the loaded game steps identically', () => {
    const w = createWorld(8, 'map1');
    w.waveTicks[0] = 200;
    w.enqueue({ t: 'build', ids: unitIds(w), kind: B.gun, tx: 62, ty: 54 });
    w.enqueue({ t: 'research', node: 'wallT2' });
    for (let i = 0; i < 600; i++) w.step();
    expect(w.aliens.count + w.wrecks.count).toBeGreaterThan(0);
    const saved = serializeWorld(w);
    const loaded = deserializeWorld(saved.slice().buffer);
    expect(same(serializeWorld(loaded), saved)).toBe(true);
    for (let i = 0; i < 300; i++) {
      w.step();
      loaded.step();
    }
    expect(same(bytesOf(loaded), bytesOf(w))).toBe(true);
  });

  it('refuses a save of another version with a clear message', () => {
    const saved = serializeWorld(createWorld(1, 'map1'));
    const old = saved.slice();
    new DataView(old.buffer).setUint32(4, SAVE_VERSION - 1, true);
    expect(() => deserializeWorld(old)).toThrow(SaveVersionError);
    // W24: SAVE_VERSION went from 1 to 2, so the message names the versions from the constant.
    // W32: SAVE_VERSION 5; version 4 is still read, but only with state format 7, so this save
    // (version 4 in the header, state format 8) is still refused.
    expect(() => deserializeWorld(old)).toThrow(new RegExp(`version ${SAVE_VERSION - 1} .* reads version ${SAVE_VERSION}`));
    expect(() => deserializeWorld(new Uint8Array(64))).toThrow(/not a Bulwark save/);
  });
});

// ---- command validation ------------------------------------------------------------------------

describe('unknown kinds are rejected and reported', () => {
  it('the world refuses unknown building kinds, alien kinds, nodes and commands with a reason', () => {
    const w = createWorld(1, 'map1');
    const ids = unitIds(w);
    expect(w.submit({ t: 'build', ids, kind: 99, tx: 60, ty: 50 })).toMatch(/unknown building kind 99/);
    expect(w.submit({ t: 'build', ids, kind: 'gunTurret' as unknown as number, tx: 60, ty: 50 })).toMatch(/unknown building kind "gunTurret"/);
    expect(w.submit({ t: 'spawn', kind: 7, entry: 0, count: 3 })).toMatch(/unknown alien kind/);
    expect(w.submit({ t: 'research', node: 'warpDrive' })).toMatch(/unknown research node/);
    expect(w.submit({ t: 'teleport' } as unknown as Command)).toMatch(/unknown command/);
    w.step();
    expect(w.buildings.count).toBe(1); // W29: the core, nothing else
    expect(w.log.length).toBe(0);
  });

  it('name lookups used by the debug helpers throw on unknown names', () => {
    expect(buildingKindIndex('gun')).toBe(B.gun);
    expect(() => buildingKindIndex('gunTurret')).toThrow(/unknown building kind "gunTurret"; valid: .*gun/);
    expect(() => alienKindIndex('dragon')).toThrow(/unknown alien kind/);
    expect(() => researchNodeId('warpDrive')).toThrow(/unknown research node/);
    expect(() => buildingKindIndex(42)).toThrow(/unknown building kind index 42/);
  });

  it('a command refused at apply time (state changed) is recorded, not silently lost', () => {
    const w = createWorld(1, 'map1');
    const ids = unitIds(w);
    expect(w.submit({ t: 'build', ids, kind: B.gun, tx: 62, ty: 54 })).toBeNull();
    w.placeBuilding(B.wall, 62, 54, true); // the site is taken before the command applies
    w.step();
    expect(w.applyRejected.length).toBe(1);
    expect(w.applyRejected[0]!.reason).toMatch(/cannot stand/);
    void BF_COMPLETE;
  });
});
