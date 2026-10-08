// M2 gameplay systems: construction drain, assist, energy and parts gating, flow fields,
// salvage, conveyors, and determinism with every system running.

import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world.ts';
import { createWorld } from '../src/sim/scenarios.ts';
import { A, B, CAT_COMMANDER, CAT_DEFENCES, ITEM_ALLOY, ITEM_SALVAGE, ITEM_SCRAP, TICK_SECONDS, U, buildingInfo } from '../src/sim/kinds.ts';
import { BF_COMPLETE } from '../src/sim/schema.ts';
import { flatTerrain, map1Terrain } from '../src/sim/terrain.ts';
import { encodeSnapshot, snapshotBytes } from '../src/sim/snapshot.ts';
import type { Command } from '../src/sim/commands.ts';
import { flatWorld } from './fixtures.ts';

const DT = TICK_SECONDS;

function site(w: World, id: number) {
  return w.buildings.slotForId(id);
}

function ticksToComplete(w: World, id: number, max = 20000): number {
  for (let i = 0; i < max; i++) {
    const s = site(w, id);
    if (s >= 0 && w.buildings.cols.flags[s]! & BF_COMPLETE) return i;
    w.step();
  }
  return -1;
}

/** A world on flat ground with no commander (so no commander income). */
const flat = (w = 40, h = 40) => flatWorld(w, h);

// ---- map 1 start --------------------------------------------------------------------------

describe('map 1 start', () => {
  // Richard, after M1: "there should be a delay before the first wave". Wave 1 is at 3:00 (M3).
  it('has no aliens at tick 0 or through the first 1,700 ticks (2:50) without debug spawns', () => {
    const w = createWorld(1, 'map1');
    expect(w.aliens.count).toBe(0);
    expect(w.units.count).toBe(3); // commander + W12's 2 starting engineers
    expect(w.buildings.count).toBe(0); // empty base
    for (let i = 0; i < 1700; i++) {
      w.step();
      if (w.aliens.count !== 0 || w.pendingSpawns !== 0) throw new Error(`alien present at tick ${w.tick}`);
    }
    expect(w.tick).toBe(1700);
    expect(w.kills).toBe(0);
  });
});

// ---- construction ----------------------------------------------------------------------------

describe('drain while building', () => {
  it('slows every active build by the worst ratio among the resources it draws, and still finishes', () => {
    const w = flat();
    w.pool.set([1e6, 0, 1e6]); // forced energy shortage
    w.placeBuilding(B.generator, 2, 2, true); // the only income: 5 energy/s
    const gun = w.placeBuilding(B.gun, 10, 10, false); // draws mass and energy
    const area = w.placeBuilding(B.area, 20, 10, false); // draws mass and energy
    const gen = w.placeBuilding(B.generator, 30, 10, false); // draws mass only
    const e1 = w.spawnUnit(U.engineer, 9.5, 10.5);
    const e2 = w.spawnUnit(U.engineer, 19.5, 10.5);
    const e3 = w.spawnUnit(U.engineer, 29.5, 10.5);
    w.enqueue({ t: 'assist', ids: [e1], target: gun });
    w.enqueue({ t: 'assist', ids: [e2], target: area });
    w.enqueue({ t: 'assist', ids: [e3], target: gen });
    w.step(); // orders applied; builders in range from the first tick

    const before = [gun, area, gen].map((id) => w.buildings.cols.progress[site(w, id)]!);
    w.step();
    const after = [gun, area, gen].map((id) => w.buildings.cols.progress[site(w, id)]!);
    const full = [5 * DT / buildingInfo(B.gun).buildTime, 5 * DT / buildingInfo(B.area).buildTime, 5 * DT / buildingInfo(B.generator).buildTime];
    const f = after.map((a, i) => (a - before[i]!) / full[i]!);
    // Energy available this tick is the generator's 0.5; requested is 600·pGun + 1500·pArea.
    const expected = 0.5 / (buildingInfo(B.gun).cost[1] * full[0]! + buildingInfo(B.area).cost[1] * full[1]!);
    expect(expected).toBeLessThan(0.5);
    expect(f[0]).toBeCloseTo(expected, 6);
    expect(f[1]).toBeCloseTo(expected, 6); // same factor for every build drawing energy
    expect(f[2]).toBeCloseTo(1, 6); // the generator draws no energy: not slowed
    expect(w.shortMask & 2).toBe(2);

    const t = ticksToComplete(w, gun);
    const unconstrained = buildingInfo(B.gun).buildTime / 5 / DT;
    expect(t).toBeGreaterThan(unconstrained * 2);
    expect(t).toBeLessThan(20000);
  });

  it('two engineers assisting finish faster than one', () => {
    const time = (n: number) => {
      const w = flat();
      w.pool.set([1e6, 1e6, 1e6]);
      const gun = w.placeBuilding(B.gun, 10, 10, false);
      const eng = Array.from({ length: n }, (_, i) => w.spawnUnit(U.engineer, 9.5, 10.5 + i));
      w.enqueue({ t: 'assist', ids: eng, target: gun });
      return ticksToComplete(w, gun);
    };
    const one = time(1);
    const two = time(2);
    expect(one).toBeGreaterThan(0);
    expect(two).toBeGreaterThan(0);
    expect(two).toBeLessThan(one * 0.6);
  });

  it('engineers walk round buildings to reach a site', () => {
    const w = flat();
    w.pool.set([1e6, 1e6, 1e6]);
    for (let x = 0; x < 30; x++) w.placeBuilding(B.wall, x, 20, true); // wall with a gap at x >= 30
    const e = w.spawnUnit(U.engineer, 5.5, 30.5);
    w.enqueue({ t: 'build', ids: [e], kind: B.gun, tx: 5, ty: 10 });
    let crossedGap = false;
    for (let i = 0; i < 2000; i++) {
      w.step();
      const s = w.units.slotForId(e);
      const z = w.units.cols.z[s]!;
      if (Math.floor(z) === 20 && w.units.cols.x[s]! >= 30) crossedGap = true;
      if (Math.floor(z) === 20) expect(w.units.cols.x[s]!).toBeGreaterThanOrEqual(30);
    }
    expect(crossedGap).toBe(true);
    let gun = -1;
    for (let s = 0; s < w.buildings.highWater; s++) if (w.buildings.alive[s] && w.buildings.cols.kind[s] === B.gun) gun = s;
    expect(w.buildings.cols.flags[gun]! & BF_COMPLETE).toBe(BF_COMPLETE);
  });
});

// ---- weapons gated by energy and parts ------------------------------------------------------

describe('weapons that need energy or parts', () => {
  function shoot(kind: number, alienKind: number, setup: (w: World) => void) {
    const w = flat();
    w.placeBuilding(kind, 18, 18, true);
    const a = w.spawnAlien(alienKind, 20, 24);
    setup(w);
    const hp0 = w.aliens.cols.hp[w.aliens.slotForId(a)]!;
    for (let i = 0; i < 30; i++) w.step();
    const s = w.aliens.slotForId(a);
    return s < 0 ? hp0 : hp0 - w.aliens.cols.hp[s]!;
  }

  it('beam turret deals no damage at zero energy, and does with energy', () => {
    expect(shoot(B.beam, A.hunter, (w) => w.pool.set([0, 0, 0]))).toBe(0);
    expect(shoot(B.beam, A.hunter, (w) => w.pool.set([0, 1e6, 0]))).toBeGreaterThan(0);
  });

  it('heavy cannon deals no damage at zero parts, and spends a part per shot with parts', () => {
    expect(shoot(B.heavy, A.breaker, (w) => (w.parts = 0))).toBe(0);
    let used = 0;
    const dealt = shoot(B.heavy, A.breaker, (w) => {
      w.parts = 5;
      const step = w.step.bind(w);
      w.step = () => {
        step();
        used = w.partsUsed;
      };
    });
    expect(dealt).toBeGreaterThan(0);
    expect(used).toBeGreaterThan(0);
  });
});

// ---- flow fields ------------------------------------------------------------------------------

describe('flow fields', () => {
  // 40 × 40 flat map, entry at the top centre, a gun turret (the rushers' goal) at the bottom.
  const W = 40;
  const setup = () => {
    const w = new World(1, flatTerrain(W, W, { entries: [{ name: 'north', x: 20.5, z: 0.5, dirX: 0, dirZ: 1 }], base: { x: 20, z: 36 } }), { waves: false });
    w.placeBuilding(B.gun, 19, 34, true);
    return w;
  };
  const wallLine = (w: World, skip: (x: number) => boolean) => {
    const ids: number[] = [];
    for (let x = 0; x < W; x++) if (!skip(x)) ids.push(w.placeBuilding(B.wall, x, 15, true));
    return ids;
  };
  const crossing = (w: World) => {
    w.rebuildField(CAT_DEFENCES);
    const route = w.fields[CAT_DEFENCES]!.trace(0 * W + 20);
    const at = route.find((c) => Math.floor(c / W) === 15);
    return { route, x: at === undefined ? -1 : at % W, cost: w.fields[CAT_DEFENCES]!.dist[20]! };
  };

  it('goes through a short gap rather than a wall', () => {
    const w = setup();
    wallLine(w, (x) => x === 23 || x === 24);
    const { x, route } = crossing(w);
    expect([23, 24]).toContain(x);
    expect(route[route.length - 1]! % W).toBeGreaterThanOrEqual(19); // ends on the turret
    expect(Math.floor(route[route.length - 1]! / W)).toBeGreaterThanOrEqual(34);
  });

  it('with the gap closed and only a long detour, goes through the weakest wall', () => {
    const w = setup();
    const ids = wallLine(w, (x) => x === 0); // the only gap is at the far edge
    const weak = w.buildings.slotForId(ids[29]!); // wall at x = 30
    w.buildings.cols.hp[weak] = 200;
    w.gridsDirty = true;
    const { x } = crossing(w);
    expect(x).toBe(30);
  });

  it('a stronger wall raises the cost of the route', () => {
    const w = setup();
    const ids = wallLine(w, (x) => x === 0);
    const weakCost = crossing(w).cost;
    w.debug.allTiers = true; // this test is about path cost, not research
    for (const id of ids) {
      const s = w.buildings.slotForId(id);
      w.startUpgrade(s);
      w.buildings.cols.tier[s] = 3; // tier 3: 3.5 × hp
      w.buildings.cols.hp[s] = buildingInfo(B.wall).hp * 3.5;
      w.buildings.cols.flags[s] = BF_COMPLETE;
    }
    w.gridsDirty = true;
    const strongCost = crossing(w).cost;
    expect(strongCost).toBeGreaterThan(weakCost);
  });

  it("a commander hunter's field leads to the commander", () => {
    const w = createWorld(3, 'map1');
    w.rebuildField(CAT_COMMANDER);
    const t = map1Terrain();
    const cmdr = w.commanderSlot();
    const goal = Math.floor(w.units.cols.z[cmdr]!) * t.w + Math.floor(w.units.cols.x[cmdr]!);
    for (const e of t.entries) {
      const route = w.fields[CAT_COMMANDER]!.trace(Math.floor(e.z) * t.w + Math.min(t.w - 1, Math.floor(e.x)));
      expect(route.length).toBeGreaterThan(30);
      expect(route[route.length - 1]).toBe(goal);
    }
  });

  it('hunters spawned at an entry reach the commander and attack it', () => {
    const w = createWorld(4, 'map1');
    w.enqueue({ t: 'spawn', kind: A.hunter, entry: 0, count: 2 });
    const hp0 = w.units.cols.hp[w.commanderSlot()]!;
    for (let i = 0; i < 600; i++) w.step();
    expect(w.units.cols.hp[w.commanderSlot()]!).toBeLessThan(hp0);
  });
});

// ---- salvage ----------------------------------------------------------------------------------

describe('salvage', () => {
  it('comes only from destroyed aliens', () => {
    const w = flat(); // no commander and no turrets: nothing can kill the aliens
    w.placeBuilding(B.massExtractor, 2, 2, false); // (a site, never built: no weapon)
    w.enqueue({ t: 'spawn', kind: A.rusher, entry: 0, count: 5 });
    for (let i = 0; i < 200; i++) w.step();
    expect(w.wrecks.count).toBe(0); // nothing has died, so no salvage exists
    expect(w.salvageFromKills).toBe(0);
    // Destroy two aliens.
    let killed = 0;
    for (let s = 0; s < w.aliens.highWater && killed < 2; s++) {
      if (!w.aliens.alive[s]) continue;
      w.aliens.cols.hp[s] = 0;
      killed++;
    }
    w.step();
    expect(w.wrecks.count).toBe(2);
    let total = 0;
    for (let s = 0; s < w.wrecks.highWater; s++) if (w.wrecks.alive[s]) total += w.wrecks.cols.salvage[s]!;
    expect(total).toBeCloseTo(2 * 2, 1); // rushers leave 2 salvage each, less one tick of decay
    expect(w.salvageFromKills).toBe(4);
  });

  it('engineers reclaim a wreck and deliver the salvage to a depot', () => {
    const w = flat();
    const depot = w.placeBuilding(B.depot, 5, 5, true);
    w.spawnAlien(A.breaker, 20.5, 20.5);
    w.aliens.cols.hp[0] = 0;
    w.step();
    expect(w.wrecks.count).toBe(1);
    const e = w.spawnUnit(U.engineer, 8.5, 8.5);
    w.enqueue({ t: 'reclaim', ids: [e], wreck: w.wrecks.id(0) });
    for (let i = 0; i < 1200; i++) w.step();
    expect(w.salvageDelivered).toBeGreaterThan(35);
    expect(w.salvageDelivered).toBeLessThanOrEqual(40);
    // The depot put salvage on no belt (none built), so it holds it.
    expect(w.buildings.cols.stock[site(w, depot)]!).toBeCloseTo(w.salvageDelivered, 6);
  });
});

describe('reclaim over many small wrecks', () => {
  // Regression (found in the browser): an engineer in a goal cell but just out of reach stalled forever.
  it('keeps collecting and delivering until the wrecks are gone', () => {
    const w = flat();
    w.placeBuilding(B.depot, 5, 5, true);
    for (let i = 0; i < 15; i++) w.spawnAlien(A.saboteur, 20.5 + (i % 5) * 0.7, 20.5 + Math.floor(i / 5) * 0.7);
    for (let s = 0; s < w.aliens.highWater; s++) w.aliens.cols.hp[s] = 0;
    w.step();
    expect(w.wrecks.count).toBe(15); // 15 × 10 salvage
    const e = w.spawnUnit(U.engineer, 8.5, 8.5);
    w.enqueue({ t: 'reclaim', ids: [e], wreck: w.wrecks.id(0) });
    for (let i = 0; i < 4000; i++) w.step();
    expect(w.wrecks.count).toBe(0);
    // 150 salvage less wreck decay (0.4%/s) while the engineer works through them.
    expect(w.salvageDelivered).toBeGreaterThan(100);
    expect(w.salvageDelivered).toBeCloseTo(w.salvageReclaimed, 3);
  });
});

// ---- conveyors --------------------------------------------------------------------------------

describe('conveyors', () => {
  const beltRow = (w: World, x0: number, x1: number, z: number) => {
    for (let x = x0; x <= x1; x++) w.placeBuilding(B.belt, x, z, true, 0);
  };
  const beltAt = (w: World, x: number, z: number) => w.occupancy[z * w.terrain.w + x]! - 1;
  /** Puts items on the head belt whenever it is empty. */
  const feed = (w: World, x: number, z: number, items: number[], ticks: number) => {
    let i = 0;
    for (let t = 0; t < ticks; t++) {
      const s = beltAt(w, x, z);
      if (i < items.length && w.buildings.cols.item[s] === 0) {
        w.buildings.cols.item[s] = items[i++]!;
        w.buildings.cols.itemPos[s] = 0;
      }
      w.step();
    }
    return i;
  };

  it('carries items in order', () => {
    const w = flat();
    beltRow(w, 5, 12, 5); // 8 belts pointing +x; the last one ends on empty ground
    const items = [ITEM_SALVAGE, ITEM_SCRAP, ITEM_ALLOY, ITEM_SCRAP, ITEM_SALVAGE];
    feed(w, 5, 5, items, 200);
    const onBelt = [12, 11, 10, 9, 8].map((x) => w.buildings.cols.item[beltAt(w, x, 5)]);
    expect(onBelt).toEqual(items); // first in sits at the far end
    expect([7, 6, 5].map((x) => w.buildings.cols.item[beltAt(w, x, 5)])).toEqual([0, 0, 0]);
  });

  it('a full machine input backs up the belt', () => {
    const w = flat();
    w.pool.set([0, 0, 0]); // no energy: the smelter cannot work
    beltRow(w, 5, 10, 5);
    const smelter = w.placeBuilding(B.smelter, 11, 5, true);
    const fed = feed(w, 5, 5, Array(20).fill(ITEM_SCRAP), 400);
    const sm = site(w, smelter);
    expect(w.buildings.cols.inBuf[sm]).toBe(4); // two batches of 2
    expect([5, 6, 7, 8, 9, 10].map((x) => w.buildings.cols.item[beltAt(w, x, 5)])).toEqual(Array(6).fill(ITEM_SCRAP));
    expect(fed).toBe(4 + 6 + 1 - 1 + 0); // 4 in the machine, 6 on the belts
    // With energy the machine works through its input and the belt moves again.
    w.pool.set([0, 1e6, 0]);
    for (let i = 0; i < 200; i++) w.step();
    expect(w.buildings.cols.outBuf[sm]).toBe(2); // no output belt: two alloy wait inside
    expect(w.buildings.cols.item[beltAt(w, 10, 5)]).toBe(ITEM_SCRAP);
  });

  it('a splitter alternates between its two sides', () => {
    const w = flat();
    w.placeBuilding(B.belt, 5, 10, true, 0);
    w.placeBuilding(B.splitter, 6, 10, true, 0); // +x: outputs to +z and -z
    w.placeBuilding(B.belt, 6, 11, true, 1);
    w.placeBuilding(B.belt, 6, 9, true, 3);
    feed(w, 5, 10, [ITEM_SALVAGE, ITEM_SCRAP], 60);
    const down = w.buildings.cols.item[beltAt(w, 6, 11)];
    const up = w.buildings.cols.item[beltAt(w, 6, 9)];
    expect([down, up].sort()).toEqual([ITEM_SALVAGE, ITEM_SCRAP]);
  });
});

// ---- determinism with all systems ------------------------------------------------------------

describe('determinism with every system active', () => {
  type Step = { tick: number; cmd: (w: World) => Command | null };
  const all = (w: World) => {
    const out: number[] = [];
    for (let s = 0; s < w.units.highWater; s++) if (w.units.alive[s]) out.push(w.units.id(s));
    return out;
  };
  const eng = (w: World) => all(w).filter((id) => w.units.cols.kind[w.units.slotForId(id)] === U.engineer);
  const firstWreck = (w: World) => {
    for (let s = 0; s < w.wrecks.highWater; s++) if (w.wrecks.alive[s]) return w.wrecks.id(s);
    return -1;
  };
  const SCRIPT: Step[] = [
    { tick: 1, cmd: (w) => ({ t: 'build', ids: all(w), kind: B.massExtractor, tx: 54, ty: 50, queue: true }) },
    { tick: 1, cmd: (w) => ({ t: 'build', ids: all(w), kind: B.gun, tx: 62, ty: 54, queue: true }) },
    { tick: 1, cmd: (w) => ({ t: 'build', ids: all(w), kind: B.depot, tx: 50, ty: 70, queue: true }) },
    { tick: 1, cmd: (w) => ({ t: 'build', ids: all(w), kind: B.belt, tx: 52, ty: 70, dir: 0, queue: true }) },
    { tick: 1, cmd: (w) => ({ t: 'build', ids: all(w), kind: B.shredder, tx: 53, ty: 70, queue: true }) },
    { tick: 1, cmd: (w) => ({ t: 'build', ids: all(w), kind: B.wall, tx: 60, ty: 50, queue: true }) },
    { tick: 1, cmd: (w) => ({ t: 'build', ids: all(w), kind: B.gun, tx: 66, ty: 56, queue: true }) },
    { tick: 1200, cmd: () => ({ t: 'spawn', kind: A.rusher, entry: 0, count: 8 }) },
    { tick: 1250, cmd: () => ({ t: 'spawn', kind: A.saboteur, entry: 1, count: 2 }) },
    { tick: 1300, cmd: () => ({ t: 'spawn', kind: A.hunter, entry: 0, count: 2 }) },
    { tick: 1400, cmd: () => ({ t: 'spawn', kind: A.breaker, entry: 0, count: 1 }) },
    { tick: 1800, cmd: (w) => (firstWreck(w) >= 0 ? { t: 'reclaim', ids: eng(w), wreck: firstWreck(w) } : null) },
    { tick: 2000, cmd: (w) => ({ t: 'dropTurret', id: eng(w)[0]! }) },
    { tick: 2200, cmd: (w) => ({ t: 'move', ids: all(w).slice(0, 1), x: 70, z: 70 }) },
  ];
  function run(seed: number): { bytes: Uint8Array; w: World } {
    const w = createWorld(seed, 'map1');
    for (let t = 0; t < 3000; t++) {
      for (const s of SCRIPT) {
        if (s.tick !== t) continue;
        const c = s.cmd(w);
        if (c) w.enqueue(c);
      }
      w.step();
    }
    return { bytes: snapshotBytes(encodeSnapshot(w)).slice(), w };
  }
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

  it('same seed and command log give identical snapshot bytes after 3000 ticks; another seed differs', () => {
    const a = run(77);
    const b = run(77);
    expect(same(a.bytes, b.bytes)).toBe(true);
    // Every system ran: construction, combat and kills, wrecks and reclaim, flow fields, routes.
    expect(a.w.log.length).toBe(SCRIPT.length);
    expect(a.w.kills).toBeGreaterThan(5);
    expect(a.w.salvageReclaimed).toBeGreaterThan(0);
    expect(a.w.fieldBuilds).toBeGreaterThan(8);
    expect(a.w.routes.length).toBe(8);
    const c = run(78);
    // Compare past the header and globals (the seed itself sits in the header).
    expect(same(a.bytes.subarray(64 + 256), c.bytes.subarray(64 + 256))).toBe(false);
  });
});
