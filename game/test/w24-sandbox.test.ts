// W24 acceptance 6–10 (sandbox): spawnAt, tune, unlimited, sandbox-only commands and the scenario
// in saves, and no end state. Plus the effect of every other sandbox command.

import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world.ts';
import { createWorld } from '../src/sim/scenarios.ts';
import { A, ALIEN_KINDS, B, START_STOCK, U, alienInfo, buildingInfo, unitInfo } from '../src/sim/kinds.ts';
import { BF_COMPLETE, T_BUILDING } from '../src/sim/schema.ts';
import { TILE_ROCK } from '../src/sim/terrain.ts';
import { decodeSnapshot, encodeSnapshot, G_SCENARIO } from '../src/sim/snapshot.ts';
import { deserializeWorld, serializeWorld } from '../src/sim/save.ts';
import { SimRunner } from '../src/sim/runner.ts';
import { SANDBOX_COMMANDS, type Command } from '../src/sim/commands.ts';
import { MAX_SPAWN_ORIGINS, WRECK_COMMANDER } from '../src/sim/sandbox.ts';
import { TB_DAMAGE, TUNE_FIELDS } from '../src/sim/tuning.ts';
import { RESEARCH, SANDBOX_RESPAWN_TICKS } from '../src/sim/balance.ts';
import { SH_SHOTS, shooterIndex } from '../src/sim/stats.ts';
import { map1 } from '../../model/data/map1.ts';
import { flatWorld, unitIds } from './fixtures.ts';

const sandbox = () => createWorld(1, 'sandbox');
/** A flat sandbox (no commander unless added): for checks that need a quiet map. */
const flatSandbox = (rocks: Array<[number, number]> = []) => {
  const w = flatWorld(40, 40, { rich: true, terrain: { rocks, base: { x: 20, z: 36 } } });
  w.scenario = 'sandbox';
  return w;
};
/** Records every alien spawn (kind, x, z) as it happens, before the aliens move. */
function recordSpawns(w: World) {
  const out: Array<{ kind: number; x: number; z: number }> = [];
  const spawn = w.spawnAlien.bind(w);
  w.spawnAlien = (kind, x, z) => {
    out.push({ kind, x, z });
    return spawn(kind, x, z);
  };
  return out;
}

// ---- 6: spawnAt ---------------------------------------------------------------------------------

describe('spawnAt', () => {
  it('places exactly count aliens on distinct passable free tiles within 6 tiles, at least 0.8 apart', () => {
    const w = sandbox();
    w.placeBuilding(B.gun, 61, 49, true); // a building inside the radius: its tiles are not used
    const spawned = recordSpawns(w);
    const x = 60.3;
    const z = 50.7;
    expect(w.submit({ t: 'spawnAt', kind: A.breaker, x, z, count: 40 })).toBeNull();
    const before = w.aliens.count;
    w.step();
    expect(w.aliens.count - before).toBe(40);
    expect(spawned.length).toBe(40);
    const tiles = new Set<number>();
    for (const p of spawned) {
      expect(p.kind).toBe(A.breaker);
      const tx = Math.floor(p.x);
      const tz = Math.floor(p.z);
      const cell = tz * w.terrain.w + tx;
      tiles.add(cell);
      expect(w.terrain.tiles[cell]).not.toBe(TILE_ROCK);
      expect(w.occupancy[cell]).toBe(0);
      expect(Math.hypot(p.x - x, p.z - z)).toBeLessThanOrEqual(6);
    }
    expect(tiles.size).toBe(40); // distinct tiles
    for (let i = 0; i < spawned.length; i++)
      for (let j = i + 1; j < spawned.length; j++) expect(Math.hypot(spawned[i]!.x - spawned[j]!.x, spawned[i]!.z - spawned[j]!.z)).toBeGreaterThanOrEqual(0.8);
  });

  it('is refused, and spawns nothing, when the full count cannot fit', () => {
    // Rock everywhere but a 3 × 3 pocket round (20, 20).
    const rocks: Array<[number, number]> = [];
    for (let z = 0; z < 40; z++) for (let x = 0; x < 40; x++) if (Math.abs(x - 20) > 1 || Math.abs(z - 20) > 1) rocks.push([x, z]);
    const w = flatSandbox(rocks);
    expect(w.submit({ t: 'spawnAt', kind: A.rusher, x: 20.5, z: 20.5, count: 10 })).toMatch(/only 9 of 10 rushers fit within 6 tiles/);
    w.enqueue({ t: 'spawnAt', kind: A.rusher, x: 20.5, z: 20.5, count: 10 }); // forced past validation
    w.step();
    expect(w.aliens.count).toBe(0);
    expect(w.spawnOrigins.length).toBe(0);
    expect(w.submit({ t: 'spawnAt', kind: A.rusher, x: 20.5, z: 20.5, count: 9 })).toBeNull();
    w.step();
    expect(w.aliens.count).toBe(9);
  });

  it('is refused, and spawns nothing, when the alien table would overflow', () => {
    const w = flatSandbox();
    for (let i = 0; w.aliens.count < w.aliens.capacity - 5; i++) w.spawnAlien(A.rusher, 1 + (i % 38), 1 + Math.floor(i / 38) * 0.3);
    const n = w.aliens.count;
    expect(w.submit({ t: 'spawnAt', kind: A.rusher, x: 30.5, z: 35.5, count: 10 })).toMatch(/alien table would overflow/);
    w.enqueue({ t: 'spawnAt', kind: A.rusher, x: 30.5, z: 35.5, count: 10 });
    w.step();
    expect(w.aliens.count).toBeLessThanOrEqual(n); // none added (some may have died)
    expect(w.spawnOrigins.length).toBe(0);
  });

  it('refuses counts outside 1..50 and unknown kinds', () => {
    const w = sandbox();
    expect(w.submit({ t: 'spawnAt', kind: A.rusher, x: 60, z: 50, count: 0 })).toMatch(/1\.\.50/);
    expect(w.submit({ t: 'spawnAt', kind: A.rusher, x: 60, z: 50, count: 51 })).toMatch(/1\.\.50/);
    expect(w.submit({ t: 'spawnAt', kind: 9, x: 60, z: 50, count: 1 })).toMatch(/unknown alien kind/);
  });

  it('puts the route trace from the spawn origin in the snapshot; at most 8 origins are kept', () => {
    const w = sandbox();
    w.enqueue({ t: 'spawnAt', kind: A.rusher, x: 30.5, z: 30.5, count: 3 });
    w.step();
    const snap = decodeSnapshot(encodeSnapshot(w));
    expect(snap.originRoutes.length).toBe(1);
    const r = snap.originRoutes[0]!;
    expect([r.x, r.z, r.kind, r.category]).toEqual([30, 30, A.rusher, alienInfo(A.rusher).category]);
    expect(r.cells[0]).toBe(30 * w.terrain.w + 30); // starts at the origin
    expect(r.cells.length).toBeGreaterThan(20);
    const last = r.cells[r.cells.length - 1]!;
    expect(w.fields[r.category]!.dist[last]).toBe(0); // ends on the field's goal
    for (let i = 0; i < MAX_SPAWN_ORIGINS + 1; i++) w.enqueue({ t: 'spawnAt', kind: A.breaker, x: 40.5 + i * 2, z: 90.5, count: 1 });
    w.step();
    const s2 = decodeSnapshot(encodeSnapshot(w));
    expect(s2.originRoutes.length).toBe(MAX_SPAWN_ORIGINS);
    expect(s2.originRoutes[0]!.x).toBe(42); // the oldest two (30,30 and 40,90) dropped out
  });
});

// ---- 7: tune ------------------------------------------------------------------------------------

describe('tune', () => {
  it('gun damage 2×: raw damage per shot doubles from the next shot fired; shots in flight keep theirs', () => {
    const w = flatSandbox();
    const gun = w.placeBuilding(B.gun, 10, 10, true);
    w.spawnAlien(A.breaker, 11, 21); // 10 tiles away, in range (12.5); a shot flies ~4 ticks
    const base = buildingInfo(B.gun).weapon!.damage;
    const seen = new Map<number, number>(); // projectile id -> damage when first seen
    const fresh = () => {
      const p = w.projectiles;
      const out: number[] = [];
      for (let s = 0; s < p.highWater; s++) {
        if (!p.alive[s] || p.cols.srcType[s] !== T_BUILDING || p.cols.srcId[s] !== gun) continue;
        const id = p.id(s);
        if (!seen.has(id)) {
          seen.set(id, p.cols.damage[s]!);
          out.push(id);
        }
      }
      return out;
    };
    let inFlight = -1;
    for (let i = 0; i < 50 && inFlight < 0; i++) {
      w.step();
      const f = fresh();
      if (f.length) inFlight = f[0]!;
    }
    expect(seen.get(inFlight)).toBe(base);
    w.enqueue({ t: 'tune', target: 'building', kind: B.gun, field: 'damage', mult: 2 });
    w.step();
    // The shot already flying still carries the old damage.
    const s = w.projectiles.slotForId(inFlight);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(w.projectiles.cols.damage[s]).toBe(base);
    let next: number[] = [];
    for (let i = 0; i < 20 && !next.length; i++) {
      next = fresh();
      if (!next.length) w.step();
    }
    expect(next.length).toBeGreaterThan(0);
    for (const id of next) expect(seen.get(id)).toBe(base * 2);
    expect(w.tuning.b(B.gun, TB_DAMAGE)).toBe(2);
  });

  it('alien hp 2× keeps each alien hit-point fraction, and applies to new aliens', () => {
    const w = flatSandbox();
    const max = alienInfo(A.rusher).hp;
    const a = w.spawnAlien(A.rusher, 5, 5);
    const b = w.spawnAlien(A.rusher, 7, 5);
    w.aliens.cols.hp[w.aliens.slotForId(a)] = max * 0.3;
    w.enqueue({ t: 'tune', target: 'alien', kind: A.rusher, field: 'hp', mult: 2 });
    w.step();
    expect(w.aliens.cols.hp[w.aliens.slotForId(a)]).toBeCloseTo(max * 2 * 0.3, 4);
    expect(w.aliens.cols.hp[w.aliens.slotForId(b)]).toBeCloseTo(max * 2, 4);
    const c = w.spawnAlien(A.rusher, 9, 5);
    expect(w.aliens.cols.hp[w.aliens.slotForId(c)]).toBe(max * 2);
    w.enqueue({ t: 'tuneReset' });
    w.step();
    expect(w.aliens.cols.hp[w.aliens.slotForId(a)]).toBeCloseTo(max * 0.3, 4);
    expect(w.tuning.a(A.rusher, 0)).toBe(1);
  });

  it('building and unit hp tuning keeps fractions; unit speed and build power apply', () => {
    const w = flatSandbox();
    const wall = w.placeBuilding(B.wall, 5, 5, true);
    const ws = w.buildings.slotForId(wall);
    w.buildings.cols.hp[ws] = buildingInfo(B.wall).hp / 2;
    const e = w.spawnUnit(U.engineer, 20.5, 20.5);
    w.enqueue({ t: 'tune', target: 'building', kind: B.wall, field: 'hp', mult: 3 });
    w.enqueue({ t: 'tune', target: 'unit', kind: U.engineer, field: 'hp', mult: 0.5 });
    w.enqueue({ t: 'tune', target: 'unit', kind: U.engineer, field: 'speed', mult: 2 });
    w.step();
    expect(w.buildings.cols.maxHp[ws]).toBe(buildingInfo(B.wall).hp * 3);
    expect(w.buildings.cols.hp[ws]).toBeCloseTo((buildingInfo(B.wall).hp * 3) / 2, 3);
    expect(w.gridsDirty || w.fieldDirty.some((d) => d === 0)).toBe(true);
    expect(w.units.cols.hp[w.units.slotForId(e)]).toBe(unitInfo(U.engineer).hp * 0.5);
    w.enqueue({ t: 'move', ids: [e], x: 30.5, z: 20.5 });
    w.step();
    expect(w.units.cols.x[w.units.slotForId(e)]! - 20.5).toBeCloseTo(unitInfo(U.engineer).speed * 2, 5);
  });

  it('refuses multipliers outside 0.1–10 and unsupported fields and kinds, with a reason', () => {
    const w = flatSandbox();
    const tune = (target: string, kind: number, field: string, mult: number) => w.submit({ t: 'tune', target, kind, field, mult } as Command);
    expect(tune('building', B.gun, 'damage', 0.1)).toBeNull();
    expect(tune('building', B.gun, 'damage', 10)).toBeNull();
    expect(tune('building', B.gun, 'damage', 0.09)).toMatch(/multiplier must be 0\.1 to 10/);
    expect(tune('building', B.gun, 'damage', 10.01)).toMatch(/multiplier must be 0\.1 to 10/);
    expect(tune('building', B.gun, 'damage', Number.NaN)).toMatch(/multiplier/);
    expect(tune('building', B.wall, 'damage', 2)).toMatch(/Wall has no weapon: only hp can be tuned/);
    expect(tune('building', B.wall, 'hp', 2)).toBeNull();
    expect(tune('alien', A.rusher, 'reach', 2)).toMatch(/aliens have no tunable field "reach"/);
    expect(tune('alien', A.rusher, 'damage', 2)).toMatch(/no tunable field/); // aliens use dps
    expect(tune('unit', U.commander, 'range', 2)).toMatch(/no tunable field/);
    expect(tune('unit', 7, 'hp', 2)).toMatch(/unknown unit kind/);
    expect(tune('tree', 0, 'hp', 2)).toMatch(/tune target must be one of/);
    for (const f of TUNE_FIELDS.alien) expect(tune('alien', A.hunter, f, 2)).toBeNull();
    for (const f of TUNE_FIELDS.unit) expect(tune('unit', U.engineer, f, 2)).toBeNull();
  });

  it('tuneReset restores 1× (all, one target, or one kind)', () => {
    const w = flatSandbox();
    w.enqueue({ t: 'tune', target: 'building', kind: B.gun, field: 'damage', mult: 3 });
    w.enqueue({ t: 'tune', target: 'building', kind: B.area, field: 'range', mult: 2 });
    w.enqueue({ t: 'tune', target: 'alien', kind: A.hunter, field: 'speed', mult: 0.5 });
    w.step();
    w.enqueue({ t: 'tuneReset', target: 'building', kind: B.gun });
    w.step();
    expect(w.tuning.b(B.gun, TB_DAMAGE)).toBe(1);
    expect(w.tuning.b(B.area, 2)).toBe(2);
    w.enqueue({ t: 'tuneReset', target: 'building' });
    w.step();
    expect(w.tuning.b(B.area, 2)).toBe(1);
    expect(w.tuning.a(A.hunter, 2)).toBe(0.5);
    w.enqueue({ t: 'tuneReset' });
    w.step();
    expect([...w.tuning.building, ...w.tuning.alien, ...w.tuning.unit].every((m) => m === 1)).toBe(true);
  });
});

// ---- 8: unlimited -------------------------------------------------------------------------------

describe('setUnlimited', () => {
  it('a wall, a research node and heavy-cannon shots spend nothing: the pool changes by income only, parts unchanged', () => {
    const w = sandbox();
    const ids = unitIds(w);
    w.placeBuilding(B.lab, 70, 70, true);
    w.placeBuilding(B.heavy, 56, 40, true);
    w.parts = 0;
    w.enqueue({ t: 'setUnlimited', on: true });
    w.enqueue({ t: 'build', ids, kind: B.wall, tx: 66, ty: 60 });
    w.enqueue({ t: 'research', node: 'wallT2' });
    w.enqueue({ t: 'spawnAt', kind: A.breaker, x: 57.5, z: 30.5, count: 2 });
    const p0 = Array.from(w.pool);
    const income = [0, 0, 0];
    let wallDone = false;
    for (let i = 0; i < 1200; i++) {
      w.step();
      for (let k = 0; k < 3; k++) income[k] += w.incomeRate[k]! * 0.1;
      for (let s = 0; s < w.buildings.highWater; s++) if (w.buildings.alive[s] && w.buildings.cols.kind[s] === B.wall && w.buildings.cols.flags[s]! & BF_COMPLETE) wallDone = true;
    }
    expect(w.unlimited).toBe(true);
    expect(wallDone).toBe(true);
    expect(w.researched('wallT2')).toBe(true);
    expect(w.stats[shooterIndex(B.heavy, SH_SHOTS)]).toBeGreaterThan(0); // the heavy cannon fired
    expect(w.parts).toBe(0);
    expect(w.partsUsed).toBe(0);
    for (let k = 0; k < 3; k++) expect(w.pool[k]! - p0[k]!).toBeCloseTo(income[k]!, 6);
    expect(income[0]).toBeGreaterThan(0); // income continued (the commander's)

    // Turned off, the next build drains normally.
    w.enqueue({ t: 'setUnlimited', on: false });
    w.enqueue({ t: 'build', ids, kind: B.wall, tx: 66, ty: 62 });
    const p1 = Array.from(w.pool);
    const inc1 = [0, 0, 0];
    let second = -1;
    for (let i = 0; i < 1200 && second < 0; i++) {
      w.step();
      for (let k = 0; k < 3; k++) inc1[k] += w.incomeRate[k]! * 0.1;
      const occ = w.occupancy[62 * w.terrain.w + 66]! - 1;
      if (occ >= 0 && w.buildings.cols.flags[occ]! & BF_COMPLETE) second = i;
    }
    expect(second).toBeGreaterThan(0);
    const wall = buildingInfo(B.wall).cost;
    expect(p1[0]! + inc1[0]! - w.pool[0]!).toBeCloseTo(wall[0], 2);
    expect(p1[1]! + inc1[1]! - w.pool[1]!).toBeCloseTo(wall[1], 2);
  });
});

// ---- 9: sandbox only, scenario in saves ---------------------------------------------------------

const ALL_SANDBOX: Command[] = [
  { t: 'spawnAt', kind: A.rusher, x: 60, z: 50, count: 1 },
  { t: 'tune', target: 'alien', kind: A.rusher, field: 'hp', mult: 2 },
  { t: 'tuneReset' },
  { t: 'setUnlimited', on: true },
  { t: 'grantResearch', all: true },
  { t: 'startWave', index: 0 },
  { t: 'clearAliens' },
  { t: 'clearWrecks' },
  { t: 'resetStats' },
  { t: 'resetSandbox' },
  // W29 debug commands
  { t: 'damage', target: 0, amount: 10 }, // building 0: the sandbox's core
  { t: 'fillBuffers' },
];

describe('sandbox only', () => {
  it('every sandbox command is refused in map1 with a reason (at submit and at apply)', () => {
    expect(new Set(ALL_SANDBOX.map((c) => c.t))).toEqual(SANDBOX_COMMANDS);
    const w = createWorld(1, 'map1');
    for (const cmd of ALL_SANDBOX) expect(w.submit(cmd), cmd.t).toBe(`${cmd.t} is a sandbox command (this game is map1)`);
    for (const cmd of ALL_SANDBOX) w.enqueue(cmd);
    w.step();
    expect(w.applyRejected.length).toBe(ALL_SANDBOX.length);
    expect(w.aliens.count + w.pendingSpawns).toBe(0);
    expect(w.unlimited).toBe(false);
    // ... and accepted in the sandbox.
    const s = sandbox();
    for (const cmd of ALL_SANDBOX) expect(s.submit(cmd), cmd.t).toBeNull();
  });

  it('the scenario survives save and load in both directions, and through either starting world', () => {
    const sb = sandbox();
    for (let i = 0; i < 20; i++) sb.step();
    const sbBytes = serializeWorld(sb);
    const loadedSb = deserializeWorld(sbBytes);
    expect(loadedSb.scenario).toBe('sandbox');
    expect(decodeSnapshot(encodeSnapshot(loadedSb)).globals[G_SCENARIO]).toBe(3);
    expect(loadedSb.waveTicks.length).toBe(0);
    expect(loadedSb.submit({ t: 'spawnAt', kind: A.rusher, x: 60, z: 50, count: 1 })).toBeNull();

    const m1 = createWorld(1, 'map1');
    for (let i = 0; i < 20; i++) m1.step();
    const m1Bytes = serializeWorld(m1);
    const loadedM1 = deserializeWorld(m1Bytes);
    expect(loadedM1.scenario).toBe('map1');
    expect(decodeSnapshot(encodeSnapshot(loadedM1)).globals[G_SCENARIO]).toBe(0);
    expect(loadedM1.submit({ t: 'spawnAt', kind: A.rusher, x: 60, z: 50, count: 1 })).toMatch(/sandbox command/);

    // A map 1 game (?sandbox absent) loading a sandbox save becomes a sandbox, and back.
    const r1 = new SimRunner(createWorld(2, 'map1'), 0);
    r1.load(sbBytes);
    expect(r1.world.scenario).toBe('sandbox');
    expect(r1.submit({ t: 'clearAliens' })).toBeNull();
    const r2 = new SimRunner(createWorld(2, 'sandbox'), 0);
    r2.load(m1Bytes);
    expect(r2.world.scenario).toBe('map1');
    expect(r2.submit({ t: 'clearAliens' })).toMatch(/sandbox command/);
  });
});

// ---- 10: no end state ---------------------------------------------------------------------------

describe('no end state in the sandbox', () => {
  it('killing the commander does not stop the simulation; commands still apply; a new commander appears 100 ticks later', () => {
    const w = sandbox();
    for (let i = 0; i < 10; i++) w.step();
    const cmdr = w.commanderSlot();
    const where = [w.units.cols.x[cmdr]!, w.units.cols.z[cmdr]!];
    w.units.cols.hp[cmdr] = 0;
    const deathTick = w.tick;
    w.step(); // removed this tick
    expect(w.commanderSlot()).toBe(-1);
    expect(w.outcome).toBe(0);
    expect(w.commanderRespawnTick).toBe(deathTick + SANDBOX_RESPAWN_TICKS);
    // Its wreck stays.
    let wreck = -1;
    for (let s = 0; s < w.wrecks.highWater; s++) if (w.wrecks.alive[s] && w.wrecks.cols.kind[s] === WRECK_COMMANDER) wreck = s;
    expect(wreck).toBeGreaterThanOrEqual(0);
    expect([w.wrecks.cols.x[wreck], w.wrecks.cols.z[wreck]]).toEqual(where.map((v) => Math.fround(v)));
    // A command issued after the death is applied.
    const eng = unitIds(w, U.engineer)[0]!;
    expect(w.submit({ t: 'move', ids: [eng], x: 50.5, z: 50.5 })).toBeNull();
    expect(w.submit({ t: 'spawnAt', kind: A.rusher, x: 40.5, z: 40.5, count: 2 })).toBeNull();
    const aliens = w.aliens.count;
    w.step();
    expect(w.aliens.count).toBe(aliens + 2);
    expect(w.log.slice(-2).map((s) => s.cmd.t)).toEqual(['move', 'spawnAt']);
    const e = w.units.slotForId(eng);
    const start = [w.units.cols.x[e]!, w.units.cols.z[e]!];
    while (w.tick < deathTick + SANDBOX_RESPAWN_TICKS) {
      expect(w.commanderSlot()).toBe(-1);
      w.step();
    }
    expect(w.units.cols.x[e] !== start[0] || w.units.cols.z[e] !== start[1]).toBe(true); // it walked
    // The step that runs tick death + 100 brings the new commander, at the base.
    w.step();
    const n = w.commanderSlot();
    expect(n).toBeGreaterThanOrEqual(0);
    expect(w.units.cols.hp[n]).toBe(unitInfo(U.commander).hp);
    expect(Math.hypot(w.units.cols.x[n]! - (w.terrain.base.x + 0.5), w.units.cols.z[n]! - (w.terrain.base.z + 0.5))).toBeLessThan(1);
    expect(w.commanderDeaths).toBe(1);
    expect(w.outcome).toBe(0);
  });

  it('the same death in map 1 still loses', () => {
    const w = createWorld(1, 'map1');
    w.units.cols.hp[w.commanderSlot()] = 0;
    w.step();
    expect(w.outcome).toBe(1);
  });

  it('the sandbox has no wave schedule and never wins', () => {
    const w = sandbox();
    expect(w.waveTicks.length).toBe(0);
    for (let i = 0; i < 2000; i++) w.step();
    expect(w.aliens.count + w.pendingSpawns).toBe(0);
    expect(w.outcome).toBe(0);
  });
});

// ---- the other sandbox commands -----------------------------------------------------------------

describe('other sandbox commands', () => {
  it('startWave sends map 1 wave `index` at its entries, without starting the schedule', () => {
    const w = sandbox();
    w.enqueue({ t: 'startWave', index: 4 });
    w.step();
    const wave = map1.waves[4]!;
    const total = wave.groups.reduce((n, g) => n + g.count, 0);
    expect(w.pendingSpawns + w.aliens.count).toBe(total);
    expect(w.nextWave).toBe(0);
    expect(w.submit({ t: 'startWave', index: 20 })).toMatch(/wave index must be 0\.\.19/);
  });

  it('clearAliens and clearWrecks remove them without kills; resetStats zeroes the counters', () => {
    const w = sandbox();
    w.enqueue({ t: 'spawnAt', kind: A.rusher, x: 40.5, z: 40.5, count: 5 });
    w.enqueue({ t: 'startWave', index: 0 });
    w.step();
    w.aliens.cols.hp[w.aliens.highWater - 1] = 0; // one dies: a wreck and a kill
    w.step();
    expect(w.kills).toBe(1);
    expect(w.wrecks.count).toBe(1);
    w.enqueue({ t: 'clearAliens' });
    w.enqueue({ t: 'clearWrecks' });
    w.step();
    expect(w.aliens.count).toBe(0);
    expect(w.pendingSpawns).toBe(0);
    expect(w.wrecks.count).toBe(0);
    expect(w.kills).toBe(1); // clearing is not killing
    expect(w.stats.some((v) => v !== 0)).toBe(true);
    w.enqueue({ t: 'resetStats' });
    w.step();
    expect(w.stats.every((v) => v === 0)).toBe(true);
  });

  it('grantResearch completes one node or every node without cost', () => {
    const w = sandbox();
    const pool = Array.from(w.pool);
    w.enqueue({ t: 'research', node: 'beam' });
    w.enqueue({ t: 'grantResearch', node: 'shield' });
    w.step();
    expect(w.researched('shield')).toBe(true);
    expect(w.researched('beam')).toBe(false);
    w.enqueue({ t: 'grantResearch', all: true });
    w.step();
    expect(RESEARCH.every((n) => w.researched(n.id))).toBe(true);
    expect(w.researchCurrent).toBe(-1);
    expect(w.researchQueue).toEqual([]);
    expect(w.pool[2]).toBeGreaterThanOrEqual(pool[2]!); // no rare spent
    expect(w.submit({ t: 'grantResearch', node: 'warpDrive' })).toMatch(/unknown research node/);
  });

  it('resetSandbox returns to the start state, keeping tuning and unlimited unless full', () => {
    const w = sandbox();
    const start = createWorld(1, 'sandbox');
    w.enqueue({ t: 'tune', target: 'unit', kind: U.commander, field: 'hp', mult: 2 });
    w.enqueue({ t: 'setUnlimited', on: true });
    w.enqueue({ t: 'build', ids: unitIds(w), kind: B.wall, tx: 66, ty: 60 });
    w.enqueue({ t: 'spawnAt', kind: A.rusher, x: 40.5, z: 40.5, count: 5 });
    w.enqueue({ t: 'buildRun', ids: unitIds(w), from: [50, 70], to: [55, 70], depth: 1 });
    for (let i = 0; i < 50; i++) w.step();
    const tick = w.tick;
    w.enqueue({ t: 'resetSandbox' });
    w.step();
    expect(w.tick).toBe(tick + 1); // time carries on
    expect(w.scenario).toBe('sandbox');
    expect(w.buildings.count).toBe(1); // W29: the core, as at the start
    expect(w.runs.every((r) => r === null)).toBe(true);
    expect(w.units.count).toBe(start.units.count);
    expect(w.unlimited).toBe(true);
    expect(w.tuning.u(U.commander, 0)).toBe(2);
    expect(w.units.cols.hp[w.commanderSlot()]).toBe(unitInfo(U.commander).hp * 2);
    expect(w.pool[0]).toBeGreaterThanOrEqual(START_STOCK[0]); // start stock plus one tick of income
    expect(w.pool[0]).toBeLessThan(START_STOCK[0] + 1);
    w.enqueue({ t: 'resetSandbox', full: true });
    w.step();
    expect(w.unlimited).toBe(false);
    expect(w.tuning.u(U.commander, 0)).toBe(1);
    expect(w.units.cols.hp[w.commanderSlot()]).toBe(unitInfo(U.commander).hp);
    // The reset world steps like a fresh sandbox (same units, same spawn behaviour).
    expect(ALIEN_KINDS.length).toBe(4);
  });
});
