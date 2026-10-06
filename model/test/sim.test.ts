import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { map1 } from '../data/map1.ts';
import { rowsToCsv } from '../src/csv.ts';
import { DT, Sim, type Strategy } from '../src/sim.ts';
import { STRATEGIES, balanced, noSalvage, turtle } from '../src/strategies.ts';
import { RES, res, type MapData, type StorageVariant } from '../src/types.ts';

/** map1 with no waves, no starting engineers and no commander income, adjusted by `f`. */
function bareMap(f: (m: MapData) => void = () => {}): MapData {
  const m: MapData = structuredClone(map1);
  m.waves = [];
  m.engineer.startCount = 0;
  m.commander.income = res(0, 0, 0);
  f(m);
  return m;
}

const idle: Strategy = { name: 'idle', description: '', reclaimShare: 0, decide() {} };

describe('determinism', () => {
  test('same seed gives byte-identical CSV; a different seed does not', () => {
    const csv = (seed: number) => {
      const sim = new Sim({ map: map1, strategy: balanced, storage: 'capped', seed });
      sim.run();
      return rowsToCsv(sim.rows);
    };
    const a = csv(7);
    const b = csv(7);
    assert.ok(a.length > 1_000_000, 'CSV should cover a full run');
    assert.equal(a, b);
    // Guards against a hollow pass: the seed must actually feed the simulation.
    assert.notEqual(csv(8), a);
  });
});

describe('resource conservation', () => {
  for (const s of STRATEGIES) {
    for (const v of ['uncapped', 'capped'] as StorageVariant[]) {
      test(`${s.name} / ${v}: spent <= earned + start, and the pool balances, every tick`, () => {
        const sim = new Sim({ map: map1, strategy: s, storage: v, seed: 3, record: false });
        let ticks = 0;
        while (!sim.done) {
          sim.step();
          ticks++;
          for (const k of RES) {
            const start = map1.startStock[k];
            assert.ok(sim.spent[k] <= sim.earned[k] + start + 1e-6, `${k} overspent at tick ${sim.tick}`);
            assert.ok(sim.pool[k] >= -1e-6, `${k} pool negative at tick ${sim.tick}`);
            const expected = start + sim.earned[k] - sim.spent[k] - sim.wasted[k];
            const scale = Math.max(1, start + sim.earned[k]);
            assert.ok(Math.abs(sim.pool[k] - expected) <= 1e-9 * scale, `${k} pool does not balance at tick ${sim.tick}`);
          }
        }
        assert.ok(ticks > 1000);
        if (v === 'uncapped') for (const k of RES) assert.equal(sim.wasted[k], 0);
      });
    }
  }
});

describe('construction drains over the build time', () => {
  // Commander (10 BP) plus two engineers (5 BP each) = 20 BP split over two active builds.
  const shortMap = (mass: number, massIncome: number) =>
    bareMap((m) => {
      m.engineer.startCount = 2;
      m.startStock = res(mass, 1e6, 0);
      m.commander.income = res(massIncome, 0, 0);
    });

  function buildTwo(map: MapData): { finish: Record<string, number>; ratios: number[][] } {
    const sim = new Sim({ map, strategy: null, storage: 'uncapped', seed: 1, maxSeconds: 1000 });
    sim.enqueueBuild('wall', 'north');
    sim.enqueueBuild('generator', 'base');
    const finish: Record<string, number> = {};
    const ratios: number[][] = [];
    while (!sim.done && Object.keys(finish).length < 2) {
      const before = sim.queue.map((q) => ({ kind: q.kind, progress: q.progress }));
      sim.step();
      const tickRatios: number[] = [];
      for (const b of before) {
        const after = sim.queue.find((q) => q.kind === b.kind);
        const delta = (after ? after.progress : 1) - b.progress;
        // Unconstrained progress this tick: 10 BP of the item's build time.
        const full = Math.min(1 - b.progress, (10 * DT) / map.buildings[b.kind].buildTime);
        tickRatios.push(delta / full);
        if (!after && finish[b.kind] === undefined) finish[b.kind] = sim.time;
      }
      // Compare only ticks where both builds were still in progress afterwards; a completing build
      // snaps to 1 within 1e-9, which would distort its measured ratio.
      if (before.length === 2 && sim.queue.length === 2) ratios.push(tickRatios);
    }
    return { finish, ratios };
  }

  test('a forced shortage slows both active builds by the same factor, and both finish later, not never', () => {
    const rich = buildTwo(shortMap(10_000, 0));
    const poor = buildTwo(shortMap(0, 1)); // 1 mass/s against ~24 mass/s requested
    assert.equal(Object.keys(rich.finish).length, 2);
    assert.equal(Object.keys(poor.finish).length, 2, 'both builds must finish under shortage');
    for (const k of ['wall', 'generator']) assert.ok(poor.finish[k] > rich.finish[k] * 5, `${k} should finish much later when short`);
    // In every tick where both were active, both progressed at the same fraction of full speed.
    let slowedTicks = 0;
    for (const [a, b] of poor.ratios) {
      if (a < 0.999) slowedTicks++;
      assert.ok(Math.abs(a - b) < 1e-6, `builds slowed unequally: ${a} vs ${b}`);
      assert.ok(a > 0, 'a build stalled outright instead of slowing');
    }
    assert.ok(slowedTicks > 100);
    for (const [a] of rich.ratios) assert.ok(a > 0.999);
  });

  test('the draw never exceeds what the pool holds', () => {
    const map = shortMap(5, 1);
    const sim = new Sim({ map, strategy: null, storage: 'uncapped', seed: 1, maxSeconds: 400 });
    sim.enqueueBuild('wall', 'north');
    sim.enqueueBuild('generator', 'base');
    while (!sim.done && sim.queue.length) {
      sim.step();
      assert.ok(sim.pool.mass >= -1e-9);
      assert.ok(sim.spent.mass <= sim.earned.mass + 5 + 1e-9);
    }
    assert.equal(sim.count('wall'), 1);
    assert.equal(sim.count('generator'), 1);
  });

  test('per-resource drain: a rare shortage does not slow a build that draws no rare', () => {
    const map = shortMap(10_000, 0);
    map.startStock.rare = 0;
    const sim = new Sim({ map, strategy: null, storage: 'uncapped', seed: 1 });
    sim.researchDone.add('wallT2');
    sim.addBuilding('lab', 'base');
    sim.queueResearch('wallT3'); // needs 40 rare, none available
    sim.enqueueBuild('generator', 'base');
    sim.step();
    const gen = sim.queue.find((q) => q.kind === 'generator')!;
    assert.ok(Math.abs(gen.progress - (20 * DT) / map.buildings.generator.buildTime) < 1e-9);
    assert.equal(sim.researchCurrent!.progress, 0);
  });
});

describe('salvage', () => {
  test('salvage arises only from kills', () => {
    // Depot, chain and reclaiming engineers, but nothing to kill: no salvage, no parts.
    const map = bareMap((m) => {
      m.engineer.startCount = 4;
      m.startStock = res(10_000, 100_000, 100);
    });
    const reclaimAll: Strategy = { name: 'r', description: '', reclaimShare: 1, decide() {} };
    const sim = new Sim({ map, strategy: reclaimAll, storage: 'uncapped', seed: 1, maxSeconds: 300 });
    for (const k of ['depot', 'shredder', 'smelter', 'assembler'] as const) sim.addBuilding(k, 'base');
    sim.run();
    assert.equal(sim.kills, 0);
    assert.equal(sim.wrecks, 0);
    assert.equal(sim.reclaimed, 0);
    assert.equal(sim.partsMade, 0);

    // One kill leaves exactly that alien's salvage.
    const sim2 = new Sim({ map, strategy: reclaimAll, storage: 'uncapped', seed: 1, maxSeconds: 300 });
    sim2.addBuilding('gun', 'north');
    sim2.spawnAlien('rusher', 'north', 20);
    while (sim2.kills === 0) sim2.step();
    assert.equal(sim2.salvageFromKills, map.aliens.rusher.salvage);
    assert.equal(sim2.wrecks, map.aliens.rusher.salvage - sim2.decayed);
  });

  test('over a full run, reclaimed + decayed + lying wrecks equals salvage from kills', () => {
    const sim = new Sim({ map: map1, strategy: balanced, storage: 'uncapped', seed: 5, record: false });
    sim.run();
    assert.ok(sim.kills > 100);
    assert.ok(Math.abs(sim.reclaimed + sim.decayed + sim.wrecks - sim.salvageFromKills) < 1e-6);
    assert.ok(sim.partsMade <= sim.reclaimed / 4 + 1e-9, 'four salvage per part through the chain');
    const noRec = new Sim({ map: map1, strategy: noSalvage, storage: 'uncapped', seed: 5, record: false });
    noRec.run();
    assert.equal(noRec.reclaimed, 0);
    assert.equal(noRec.partsMade, 0);
  });
});

describe('running costs', () => {
  test('a heavy cannon with zero parts deals zero damage; with parts it fires and uses them', () => {
    const sim = new Sim({ map: bareMap(), strategy: null, storage: 'uncapped', seed: 1, maxSeconds: 600 });
    sim.addBuilding('heavy', 'north');
    const target = sim.spawnAlien('breaker', 'north', 35);
    for (let i = 0; i < 40; i++) sim.step();
    assert.equal(target.hp, map1.aliens.breaker.hp);
    assert.ok(sim.heavyDryTicks >= 40);
    sim.parts = 3;
    for (let i = 0; i < 40; i++) sim.step();
    assert.ok(target.hp < map1.aliens.breaker.hp);
    assert.ok(sim.partsUsed >= 1);
    assert.equal(sim.parts, 3 - sim.partsUsed);
  });

  test('a beam turret with zero energy does nothing; with energy it fires', () => {
    const map = bareMap((m) => (m.startStock = res(0, 0, 0)));
    const sim = new Sim({ map, strategy: null, storage: 'uncapped', seed: 1, maxSeconds: 600 });
    sim.addBuilding('beam', 'north');
    const target = sim.spawnAlien('breaker', 'north', 58);
    for (let i = 0; i < 20; i++) sim.step();
    assert.equal(target.hp, map1.aliens.breaker.hp);
    assert.equal(sim.spent.energy, 0);
    sim.pool.energy = 1000;
    for (let i = 0; i < 20; i++) sim.step();
    assert.ok(target.hp < map1.aliens.breaker.hp);
    assert.ok(sim.spent.energy > 0);
  });

  test('a shield generator with zero energy absorbs nothing; with energy it protects the commander', () => {
    const map = bareMap((m) => (m.startStock = res(0, 0, 0)));
    const run = (energy: number) => {
      const sim = new Sim({ map, strategy: null, storage: 'uncapped', seed: 1, maxSeconds: 600 });
      const sh = sim.addBuilding('shield', 'core');
      sh.shieldHp = map.buildings.shield.shield!.capacity;
      sim.pool.energy = energy;
      sim.spawnAlien('hunter', 'north', 0); // inside the base; hunters go only for the commander
      for (let i = 0; i < 10; i++) sim.step();
      return { lost: map.commander.hp - sim.commanderHp, shield: sh.shieldHp, energy: sim.spent.energy };
    };
    const off = run(0);
    const on = run(10_000);
    assert.ok(Math.abs(off.lost - map.aliens.hunter.dps * 10 * DT) < 1e-6, `unshielded loss ${off.lost}`);
    assert.equal(off.shield, map.buildings.shield.shield!.capacity);
    assert.equal(on.lost, 0);
    assert.equal(off.energy, 0);
    assert.ok(on.energy > 0, 'an active shield draws energy');
  });
});

describe('end conditions', () => {
  test("the commander's death ends the run as a loss", () => {
    const map = bareMap((m) => (m.commander.hp = 500));
    const sim = new Sim({ map, strategy: idle, storage: 'uncapped', seed: 1, maxSeconds: 600 });
    for (let i = 0; i < 6; i++) sim.spawnAlien('hunter', 'north', 0);
    const r = sim.run();
    assert.equal(r.outcome, 'lost');
    assert.equal(r.commanderHp, 0);
    assert.ok(r.endTime > 0 && r.endTime < 10, `ended at ${r.endTime}`);
    const tick = sim.tick;
    sim.step();
    assert.equal(sim.tick, tick, 'no ticks after the loss');
    assert.equal(sim.rows[sim.rows.length - 1].commanderHp, 0);
  });

  test('surviving the whole wave list is a win', () => {
    const map: MapData = structuredClone(map1);
    map.waves = [{ n: 1, at: 5, groups: [{ entry: 'north', kind: 'rusher', count: 3 }] }];
    const sim = new Sim({ map, strategy: null, storage: 'uncapped', seed: 1 });
    sim.addBuilding('gun', 'north');
    const r = sim.run();
    assert.equal(r.outcome, 'won');
    assert.equal(r.kills, 3);
  });
});

describe('first-pass numbers leave room for choices', () => {
  test('balanced wins under at least one storage variant; turtle or no-salvage loses or ends below 50% HP', () => {
    const run = (s: Strategy, v: StorageVariant) => new Sim({ map: map1, strategy: s, storage: v, seed: 20261006, record: false }).run();
    const bal = (['uncapped', 'capped'] as StorageVariant[]).map((v) => run(balanced, v));
    assert.ok(bal.some((r) => r.outcome === 'won'));
    const weak = [run(turtle, 'uncapped'), run(noSalvage, 'uncapped')];
    assert.ok(weak.some((r) => r.outcome !== 'won' || r.commanderHp < 0.5 * r.commanderMaxHp));
  });
});
