// W24 acceptance 2 (construction states), for a wall tile and a gun turret:
//   reserved (no build power yet): blocks placement, not movement, no flow cost
//   started (first build power applied): blocks a unit and an alien, enters flow cost at its hit points
//   complete: blocks both
// and an entity standing on a tile when it starts is moved off it that tick (nearest free passable
// tile, ring by ring round its tile, then by (ty, tx)).

import { describe, expect, it } from 'vitest';
import { World, buildingPathCost, isReserved } from '../src/sim/world.ts';
import { A, B, U, alienInfo, buildingInfo } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_STARTED, T_BUILDING } from '../src/sim/schema.ts';
import { flatWorld } from './fixtures.ts';

const W = 30;
const flat = () => flatWorld(W, W, { rich: true, terrain: { base: { x: 15, z: 2 } } });

const KINDS = [
  { name: 'wall', kind: B.wall, size: 1 },
  { name: 'gun turret', kind: B.gun, size: 2 },
] as const;

const footprint = (tx: number, ty: number, size: number) => {
  const cells: number[] = [];
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) cells.push((ty + j) * W + tx + i);
  return cells;
};
const tileOf = (x: number, z: number) => Math.floor(z) * W + Math.floor(x);
const state = (w: World, id: number) => {
  const s = w.buildings.slotForId(id);
  if (s < 0) return 'gone';
  const f = w.buildings.cols.flags[s]!;
  return f & BF_COMPLETE ? 'complete' : f & BF_STARTED ? 'started' : 'reserved';
};

/** A line of complete walls across the map at z = 15, leaving x in `gap` open for the site. */
function wallLine(w: World, gap: number[]) {
  for (let x = 0; x < W; x++) if (!gap.includes(x)) w.placeBuilding(B.wall, x, 15, true);
}

/** Gives a site exactly one tick of build power (assist, then stop), so it is started, not built. */
function startOnce(w: World, site: number, at: [number, number]) {
  const e = w.spawnUnit(U.engineer, at[0], at[1]);
  w.enqueue({ t: 'assist', ids: [e], target: site });
  w.step();
  w.enqueue({ t: 'stop', ids: [e] });
  w.step();
  return e;
}

for (const K of KINDS) {
  describe(`construction states: ${K.name}`, () => {
    const gap = K.size === 1 ? [15] : [15, 16];
    const cells = footprint(15, 15, K.size);

    it('reserved: blocks placement, adds no flow cost, and a unit and an alien walk across it', () => {
      const w = flat();
      wallLine(w, gap);
      const site = w.placeBuilding(K.kind, 15, 15, false);
      expect(state(w, site)).toBe('reserved');
      // Placement: every footprint tile is taken for anything else.
      for (const c of cells) expect(w.canPlace(B.wall, c % W, Math.floor(c / W))).toBe(false);
      expect(w.submit({ t: 'build', ids: [], kind: B.wall, tx: 15, ty: 15 })).toMatch(/cannot stand/);
      // Grids: free ground for movement and flow cost.
      w.rebuildField(0);
      for (const c of cells) {
        expect(w.walk[c]).toBe(1);
        expect(w.open[c]).toBe(1);
        expect(w.cost[c]).toBe(10);
      }
      // A unit crosses the line through the site; a hunter (heading for the commander) does too.
      const cmdr = w.spawnUnit(U.commander, 15.5, 2.5);
      const e = w.spawnUnit(U.engineer, 15.5, 25.5);
      w.enqueue({ t: 'move', ids: [e], x: 15.5, z: 6.5 });
      const hunter = w.spawnAlien(A.hunter, 15.5, 26.5);
      let unitOnSite = false;
      let alienOnSite = false;
      let alienNorth = false;
      for (let i = 0; i < 400; i++) {
        w.step();
        const u = w.units.slotForId(e);
        if (cells.includes(tileOf(w.units.cols.x[u]!, w.units.cols.z[u]!))) unitOnSite = true;
        const a = w.aliens.slotForId(hunter);
        if (a >= 0) {
          if (cells.includes(tileOf(w.aliens.cols.x[a]!, w.aliens.cols.z[a]!))) alienOnSite = true;
          if (w.aliens.cols.z[a]! < 14) alienNorth = true;
        }
        expect(state(w, site)).toBe('reserved'); // nobody builds it
      }
      const u = w.units.slotForId(e);
      expect(w.units.cols.z[u]!).toBeCloseTo(6.5, 3); // arrived on the far side
      expect(unitOnSite).toBe(true);
      expect(alienOnSite).toBe(true);
      expect(alienNorth).toBe(true);
      void cmdr;
    });

    it('started: blocks a unit and an alien, and enters flow cost at its current hit points', () => {
      const w = flat();
      wallLine(w, gap);
      const site = w.placeBuilding(K.kind, 15, 15, false);
      startOnce(w, site, [15.5 + K.size + 1.5, 17.5]);
      expect(state(w, site)).toBe('started');
      const s = w.buildings.slotForId(site);
      const hp = w.buildings.cols.hp[s]!;
      expect(hp).toBeLessThan(buildingInfo(K.kind).hp); // a site, not a finished building
      w.rebuildField(0);
      for (const c of cells) {
        expect(w.walk[c]).toBe(0);
        expect(w.open[c]).toBe(0);
        expect(w.cost[c]).toBe(10 + buildingPathCost(K.kind, hp));
      }
      // A unit cannot get through: the move order is dropped as unreachable, it stays south.
      const e = w.spawnUnit(U.engineer, 15.5, 25.5);
      w.enqueue({ t: 'move', ids: [e], x: 15.5, z: 6.5 });
      w.spawnUnit(U.commander, 15.5, 2.5);
      const hunter = w.spawnAlien(A.hunter, 15.5, 26.5);
      let attacked = false;
      for (let i = 0; i < 400; i++) {
        w.step();
        const u = w.units.slotForId(e);
        expect(w.units.cols.z[u]!).toBeGreaterThan(16);
        const a = w.aliens.slotForId(hunter);
        if (a >= 0 && w.buildings.slotForId(site) >= 0) {
          // The alien never stands on the started site; it shoots it instead.
          expect(cells.includes(tileOf(w.aliens.cols.x[a]!, w.aliens.cols.z[a]!))).toBe(false);
          if (w.aliens.cols.tType[a] === T_BUILDING && w.aliens.cols.tId[a] === site) attacked = true;
        }
      }
      expect(attacked).toBe(true);
    });

    it('complete: blocks both, flow cost at full hit points', () => {
      const w = flat();
      const site = w.placeBuilding(K.kind, 15, 15, false);
      const e = w.spawnUnit(U.engineer, 15.5 + K.size + 1.5, 17.5);
      w.enqueue({ t: 'assist', ids: [e], target: site });
      const seen: string[] = [];
      for (let i = 0; i < 2000 && state(w, site) !== 'complete'; i++) {
        seen.push(state(w, site));
        w.step();
      }
      expect(state(w, site)).toBe('complete');
      // reserved before the first tick, then started until complete
      expect(seen[0]).toBe('reserved');
      expect(seen.slice(1).every((x) => x === 'started')).toBe(true);
      const s = w.buildings.slotForId(site);
      w.rebuildField(0);
      for (const c of cells) {
        expect(w.walk[c]).toBe(0);
        expect(w.open[c]).toBe(0);
        expect(w.cost[c]).toBe(10 + buildingPathCost(K.kind, w.buildings.cols.hp[s]!));
      }
    });

    it('an engineer and an alien standing on the site are moved off it the tick it starts', () => {
      const w = flat();
      const site = w.placeBuilding(K.kind, 10, 10, false);
      const fp = footprint(10, 10, K.size);
      // Standing on a reserved site is allowed (it does not block).
      const idle = w.spawnUnit(U.engineer, 10.5, 10.5);
      const idle2 = K.size === 2 ? w.spawnUnit(U.engineer, 11.5, 11.5) : -1;
      const alien = w.spawnAlien(A.rusher, 10.5, 10.5);
      const builder = w.spawnUnit(U.engineer, 13.5, 10.5);
      w.enqueue({ t: 'assist', ids: [builder], target: site });
      w.step(); // tick 0: the builder's power arrives; the site starts; both are moved
      expect(state(w, site)).toBe('started');
      const uc = w.units.cols;
      const i1 = w.units.slotForId(idle);
      // Ring 1 round tile (10, 10) in (ty, tx) order: (9, 9) is the first free passable tile.
      expect([uc.x[i1], uc.z[i1]]).toEqual([9.5, 9.5]);
      if (idle2 >= 0) {
        // Ring 1 round (11, 11): (10, 10) and (11, 10) are the turret; (12, 10) is next.
        const i2 = w.units.slotForId(idle2);
        expect([uc.x[i2], uc.z[i2]]).toEqual([12.5, 10.5]);
      }
      const a = w.aliens.slotForId(alien);
      const ax = w.aliens.cols.x[a]!;
      const az = w.aliens.cols.z[a]!;
      expect(fp.includes(tileOf(ax, az))).toBe(false);
      // Moved to (9.5, 9.5) in the construction step, then at most one step of its own movement.
      expect(Math.hypot(ax - 9.5, az - 9.5)).toBeLessThanOrEqual(alienInfo(A.rusher).speed + 1e-6);
      // The builder was not on the footprint and has not moved.
      const b = w.units.slotForId(builder);
      expect([uc.x[b], uc.z[b]]).toEqual([13.5, 10.5]);
    });
  });
}

describe('construction states: run sites and gates follow the same rule', () => {
  it('a reserved site never turns started without build power, and isReserved matches the flags', () => {
    const w = flat();
    const id = w.placeBuilding(B.wall, 5, 5, false);
    for (let i = 0; i < 50; i++) w.step();
    const s = w.buildings.slotForId(id);
    expect(isReserved(w.buildings.cols.flags[s]!)).toBe(true);
    expect(w.pool[0]).toBe(1e6); // reserved sites cost nothing
    const done = w.placeBuilding(B.wall, 7, 5, true);
    expect(isReserved(w.buildings.cols.flags[w.buildings.slotForId(done)]!)).toBe(false);
  });
});
