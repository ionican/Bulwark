// W29 (PLAN-W29 item 8): an alien within reach of an enabled core attacks it once, for at most
// CORE_PASS_SECONDS (5 s = 50 ticks), then resumes its own targeting; a spent alien never targets
// the core again. The rule runs before the keep-shooting-your-target step, so that step cannot
// extend it. Hunters do it too.

import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world.ts';
import { flatTerrain } from '../src/sim/terrain.ts';
import { A, B, U } from '../src/sim/kinds.ts';
import { T_BUILDING } from '../src/sim/schema.ts';
import { CORE_HP, CORE_PASS_SECONDS } from '../src/sim/balance.ts';
import { damageBuilding } from '../src/sim/combat.ts';

/** 40 × 40 belts world, core at tiles 19–21 × 18–20, the base (alien goal without a commander) far south. */
function world(): { w: World; core: number } {
  const w = new World(1, flatTerrain(40, 40, { base: { x: 20, z: 37 } }), { waves: false, belts: true });
  const core = w.placeBuilding(B.core, 19, 18, true);
  return { w, core };
}

const onCore = (w: World, a: number, core: number) => w.aliens.cols.tType[a] === T_BUILDING && w.aliens.cols.tId[a] === core;

describe('W29 aliens attack the core in passing', () => {
  it('the attack lasts exactly 50 ticks although the core stays in reach, then the alien moves on', () => {
    expect(CORE_PASS_SECONDS).toBe(5);
    const { w, core } = world();
    const a = w.aliens.slotForId(w.spawnAlien(A.rusher, 20.5, 17.4));
    const s = w.buildings.slotForId(core);
    let ticks = 0;
    let last = -1;
    for (let t = 0; t < 120; t++) {
      w.step();
      if (onCore(w, a, core)) {
        ticks++;
        last = t;
      }
    }
    expect(ticks).toBe(50);
    expect(last).toBe(49);
    expect(w.buildings.cols.hp[s]).toBeLessThan(CORE_HP);
    // it went on its way (round the core towards the base)
    expect(w.aliens.cols.z[a]).toBeGreaterThan(19);
  });

  it('ends early when the core is disabled', () => {
    const { w, core } = world();
    const a = w.aliens.slotForId(w.spawnAlien(A.rusher, 20.5, 17.4));
    let ticks = 0;
    for (let t = 0; t < 80; t++) {
      if (t === 20) damageBuilding(w, w.buildings.slotForId(core), CORE_HP);
      w.step();
      if (onCore(w, a, core)) ticks++;
    }
    expect(ticks).toBe(20);
  });

  it('a spent alien passing again does not attack the same core', () => {
    const { w, core } = world();
    const a = w.aliens.slotForId(w.spawnAlien(A.rusher, 20.5, 17.4));
    for (let t = 0; t < 60; t++) w.step();
    expect(onCore(w, a, core)).toBe(false);
    // back beside the core
    w.aliens.cols.x[a] = 18.4;
    w.aliens.cols.z[a] = 19.5;
    for (let t = 0; t < 60; t++) {
      w.step();
      expect(onCore(w, a, core), `tick ${w.tick}`).toBe(false);
    }
  });

  it('the keep-shooting step cannot extend the pass: a breaker, shooting the core every second, stops at 50 ticks too', () => {
    const { w, core } = world();
    const a = w.aliens.slotForId(w.spawnAlien(A.breaker, 20.5, 17.0));
    let ticks = 0;
    for (let t = 0; t < 200; t++) {
      w.step();
      if (onCore(w, a, core)) ticks++;
    }
    expect(ticks).toBe(50);
  });

  it('hunters attack the core in passing too (W29 changes W5)', () => {
    const { w, core } = world();
    w.spawnUnit(U.commander, 20.5, 36.5);
    const a = w.aliens.slotForId(w.spawnAlien(A.hunter, 18.4, 19.5));
    let ticks = 0;
    for (let t = 0; t < 70; t++) {
      w.step();
      if (onCore(w, a, core)) ticks++;
    }
    expect(ticks).toBe(50);
  });
});
