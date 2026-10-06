import { describe, expect, it } from 'vitest';
import { createWorld, type ScenarioName } from '../src/sim/scenarios.ts';
import { encodeSnapshot, snapshotBytes } from '../src/sim/snapshot.ts';
import { B } from '../src/sim/kinds.ts';
import type { Command } from '../src/sim/commands.ts';
import type { World } from '../src/sim/world.ts';

type Script = Array<{ tick: number; cmd: (w: World) => Command }>;

const unitIds = (w: World) => {
  const ids: number[] = [];
  for (let s = 0; s < w.units.highWater; s++) if (w.units.alive[s]) ids.push(w.units.id(s));
  return ids;
};

const SCRIPT: Script = [
  { tick: 5, cmd: (w) => ({ t: 'move', ids: unitIds(w), x: 40, z: 30 }) },
  { tick: 120, cmd: () => ({ t: 'place', kind: B.gun, tx: 70, ty: 70 }) },
  { tick: 300, cmd: (w) => ({ t: 'move', ids: unitIds(w).slice(0, 1), x: 90, z: 90 }) },
];

function run(seed: number, scenario: ScenarioName, script: Script, ticks = 600): Uint8Array {
  const w = createWorld(seed, scenario);
  for (const s of script) w.enqueue(s.cmd(w), s.tick);
  for (let i = 0; i < ticks; i++) w.step();
  expect(w.tick).toBe(ticks);
  return snapshotBytes(encodeSnapshot(w)).slice();
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

describe('simulation determinism', () => {
  for (const scenario of ['map1', 'stress'] as const) {
    it(`${scenario}: same seed and commands give identical snapshot bytes after 600 ticks`, () => {
      const a = run(42, scenario, SCRIPT);
      const b = run(42, scenario, SCRIPT);
      expect(a.length).toBeGreaterThan(1000);
      expect(same(a, b)).toBe(true);
    });

    it(`${scenario}: a different seed gives different bytes`, () => {
      expect(same(run(42, scenario, SCRIPT), run(43, scenario, SCRIPT))).toBe(false);
    });
  }

  it('the state actually evolves: tick 600 differs from tick 0 beyond the tick counter', () => {
    const w = createWorld(7, 'stress');
    const before = snapshotBytes(encodeSnapshot(w)).slice();
    for (let i = 0; i < 600; i++) w.step();
    const after = snapshotBytes(encodeSnapshot(w)).slice();
    // Ignore the header (tick and RNG state); entity data alone must have changed.
    expect(same(before.subarray(64), after.subarray(64))).toBe(false);
  });

  it('commands change the outcome, and so does the tick they are stamped with', () => {
    const none = run(42, 'map1', []);
    const scripted = run(42, 'map1', SCRIPT);
    const late = run(42, 'map1', SCRIPT.map((s) => ({ ...s, tick: s.tick + 1 })));
    expect(same(none, scripted)).toBe(false);
    expect(same(scripted, late)).toBe(false);
  });

  it('a move command walks the commander to the target', () => {
    const w = createWorld(1, 'map1');
    const [cmdr] = unitIds(w);
    w.enqueue({ t: 'move', ids: [cmdr!], x: 30, z: 30 }, 0);
    for (let i = 0; i < 2000; i++) w.step();
    const slot = w.units.slotForId(cmdr!);
    expect(w.units.cols.x[slot]).toBeCloseTo(30, 4);
    expect(w.units.cols.z[slot]).toBeCloseTo(30, 4);
    expect(w.log.length).toBe(1);
    expect(w.log[0]!.tick).toBe(0);
  });

  it('encoding into a reused buffer gives the same bytes as a fresh buffer', () => {
    const w = createWorld(5, 'stress');
    for (let i = 0; i < 50; i++) w.step();
    const dirty = new ArrayBuffer(512 * 1024);
    new Uint8Array(dirty).fill(0xab);
    const reused = snapshotBytes(encodeSnapshot(w, dirty));
    const fresh = snapshotBytes(encodeSnapshot(w));
    expect(same(reused, fresh)).toBe(true);
  });

  it('stress scene has 500 aliens and 300 buildings', () => {
    const w = createWorld(1, 'stress');
    expect(w.aliens.count).toBe(500);
    expect(w.buildings.count).toBe(300);
  });
});
