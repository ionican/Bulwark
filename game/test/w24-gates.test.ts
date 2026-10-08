// W24 acceptance 5 (gates). Placement is accepted on a complete straight run of depth d for
// d = 1..4, on both axes, with the 3 × d footprint replaced atomically; refused (with W23's
// reasons) on a reserved or started tile, a corner, a T, a missing end, and depth 5. After
// building: a player unit's path crosses the gate's corridor; with no other way in, an alien flow
// field routes to the gate and aliens attack it; no alien enters a standing gate's tiles, including
// diagonally at its corners; when the gate is destroyed, aliens pass.

import { describe, expect, it } from 'vitest';
import { World, buildingPathCost } from '../src/sim/world.ts';
import { A, B, CAT_DEFENCES, U, buildingInfo } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_STARTED, T_BUILDING } from '../src/sim/schema.ts';
import { TILE_ROCK, flatTerrain } from '../src/sim/terrain.ts';
import { GATE_MAX_DEPTH, GATE_WIDTH, checkGate, type GateGrid } from '../src/sim/gate.ts';
import { GATE_COST_MULT } from '../src/sim/balance.ts';
import { DX, DZ } from '../src/sim/grid.ts';

// ---- the W23 predicate, ported: W23's own test cases (look/test/w23-walls.test.ts) ------------

/** Just enough of W23's WallGrid for the predicate: walls (tier > 0) and gate tiles. */
class TestGrid implements GateGrid {
  readonly tier: Uint8Array;
  readonly gate: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.tier = new Uint8Array(w * h);
    this.gate = new Uint8Array(w * h);
  }
  inside = (x: number, z: number) => x >= 0 && z >= 0 && x < this.w && z < this.h;
  solid = (x: number, z: number) => this.inside(x, z) && this.tier[z * this.w + x]! > 0;
  plainWall = (x: number, z: number) => this.solid(x, z) && !this.gate[z * this.w + x];
  /** W23 line(): a straight run along the dominant axis. */
  line(x0: number, z0: number, x1: number, z1: number) {
    if (Math.abs(x1 - x0) >= Math.abs(z1 - z0)) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.tier[z0 * this.w + x] = 1;
    else for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) this.tier[z * this.w + x0] = 1;
  }
  rect(x0: number, z0: number, x1: number, z1: number) {
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.tier[z * this.w + x] = 1;
  }
  clear() {
    this.tier.fill(0);
    this.gate.fill(0);
  }
}

describe('W23 gate predicate, ported (same cases as look/test/w23-walls.test.ts)', () => {
  it('accepts straight runs of the right length and rejects everything else', () => {
    expect([GATE_WIDTH, GATE_MAX_DEPTH]).toEqual([3, 4]);
    const g = new TestGrid(16, 16);
    g.line(1, 3, 7, 3); // 7 tiles: x 1..7
    expect(checkGate(g, 4, 3).ok).toBe(true);
    expect(checkGate(g, 4, 3).axis).toBe('x');
    expect(checkGate(g, 3, 3).ok).toBe(true); // 3 + 1 tile of wall on each side is enough
    expect(checkGate(g, 2, 3).ok).toBe(false); // no wall past the west end
    expect(checkGate(g, 6, 3).ok).toBe(false); // no wall past the east end
    expect(checkGate(g, 4, 4).ok).toBe(false); // not on wall

    g.clear();
    g.line(1, 3, 4, 3); // 4 tiles: too short for 3 + 1 + 1
    for (let x = 1; x <= 4; x++) expect(checkGate(g, x, 3).ok).toBe(false);

    g.clear();
    g.line(1, 3, 7, 3); // an L
    g.line(7, 3, 7, 9);
    expect(checkGate(g, 6, 3).ok).toBe(false); // into a corner
    expect(checkGate(g, 7, 4).ok).toBe(false); // round a corner
    expect(checkGate(g, 7, 6).ok).toBe(true); // straight leg of the L, N–S
    expect(checkGate(g, 7, 6).axis).toBe('z');

    g.clear();
    g.line(1, 3, 9, 3); // a T
    g.line(5, 4, 5, 8);
    expect(checkGate(g, 5, 3).ok).toBe(false);
    expect(checkGate(g, 5, 3).reason).toMatch(/straight run/);
    expect(checkGate(g, 3, 3).ok).toBe(true);

    g.clear();
    g.rect(1, 3, 9, 4); // 2 deep
    const c2 = checkGate(g, 5, 3);
    expect(c2.ok).toBe(true);
    expect(c2.hi - c2.lo + 1).toBe(2);
    expect(c2.tiles.length).toBe(6);
    expect(checkGate(g, 5, 4).ok).toBe(true);
    g.clear();
    g.rect(1, 3, 9, 6); // 4 deep
    const c4 = checkGate(g, 5, 4);
    expect(c4.ok).toBe(true);
    expect(c4.hi - c4.lo + 1).toBe(4);
    g.clear();
    g.rect(1, 3, 9, 7); // 5 deep
    expect(checkGate(g, 5, 5).ok).toBe(false);
  });
});

// ---- the world ---------------------------------------------------------------------------------

const MAP = 30;

/** Maps run coordinates (u along the run, v across it) onto tiles for each axis. */
const onAxis = (axis: 'x' | 'z', u: number, v: number): [number, number] => (axis === 'x' ? [u, v] : [v, u]);

/** A complete wall run, 9 tiles long (u = 5..13), `depth` rows from v = 10. Gate centre: u = 9, v = 10. */
function wallBlock(w: World, axis: 'x' | 'z', depth: number) {
  for (let v = 10; v < 10 + depth; v++) for (let u = 5; u <= 13; u++) w.placeBuilding(B.wall, ...onAxis(axis, u, v), true);
}
const flat = () => {
  const w = new World(1, flatTerrain(MAP, MAP), { waves: false });
  w.pool.set([1e6, 1e6, 1e6]);
  return w;
};
const gateSlot = (w: World) => {
  for (let s = 0; s < w.buildings.highWater; s++) if (w.buildings.alive[s] && w.buildings.cols.kind[s] === B.gate) return s;
  return -1;
};

describe('gate placement in the world', () => {
  for (const axis of ['x', 'z'] as const) {
    for (let d = 1; d <= 4; d++) {
      it(`accepted on a complete run, axis ${axis}, depth ${d}: the 3 × ${d} footprint is replaced in one tick`, () => {
        const w = flat();
        wallBlock(w, axis, d);
        const walls = w.buildings.count;
        expect(walls).toBe(9 * d);
        const pool = Array.from(w.pool);
        const [cx, cz] = onAxis(axis, 9, 10);
        expect(w.submit({ t: 'gate', ids: [], tx: cx, ty: cz })).toBeNull();
        w.step();
        const g = gateSlot(w);
        expect(g).toBeGreaterThanOrEqual(0);
        const c = w.buildings.cols;
        // Footprint: 3 along the run, d across, anchored at the lowest tile, with its axis.
        const [ax, ay] = onAxis(axis, 8, 10);
        expect([c.tx[g], c.ty[g]]).toEqual([ax, ay]);
        expect([c.fw[g], c.fh[g]]).toEqual(axis === 'x' ? [3, d] : [d, 3]);
        expect(c.dir[g]).toBe(axis === 'x' ? 0 : 1);
        // Atomic: the 3d walls went and the gate took every tile of them in the same tick.
        expect(w.buildings.count).toBe(walls - 3 * d + 1);
        for (let v = 10; v < 10 + d; v++) {
          for (let u = 5; u <= 13; u++) {
            const [x, y] = onAxis(axis, u, v);
            const occ = w.occupancy[y * MAP + x]! - 1;
            if (u >= 8 && u <= 10) expect(occ).toBe(g);
            else expect(c.kind[occ]).toBe(B.wall);
          }
        }
        // Tier 1, hit points = wall hp × tiles, cost and time = wall's × tiles × 1.5, no refund.
        const wall = buildingInfo(B.wall);
        expect(c.tier[g]).toBe(1);
        expect(c.maxHp[g]).toBe(wall.hp * 3 * d);
        expect(c.flags[g]! & (BF_STARTED | BF_COMPLETE)).toBe(0); // a new site: reserved
        const work = w.workOf(g);
        expect(work.cost).toEqual([wall.cost[0] * 3 * d * GATE_COST_MULT, wall.cost[1] * 3 * d * GATE_COST_MULT, wall.cost[2] * 3 * d * GATE_COST_MULT]);
        expect(work.time).toBe(wall.buildTime * 3 * d * GATE_COST_MULT);
        expect(Array.from(w.pool)).toEqual(pool);
      });
    }
  }

  const refused = (setup: (w: World) => void, cx: number, cz: number, reason: RegExp) => {
    const w = flat();
    setup(w);
    const occ = Int32Array.from(w.occupancy);
    const count = w.buildings.count;
    expect(w.submit({ t: 'gate', ids: [], tx: cx, ty: cz })).toMatch(reason);
    // Forced past validation, the apply step refuses too, and nothing changes.
    w.enqueue({ t: 'gate', ids: [], tx: cx, ty: cz });
    w.step();
    expect(w.buildings.count).toBe(count);
    expect(Array.from(w.occupancy)).toEqual(Array.from(occ));
    expect(w.applyRejected.length).toBe(1);
  };
  const line = (w: World, x0: number, x1: number, z: number) => {
    for (let x = x0; x <= x1; x++) w.placeBuilding(B.wall, x, z, true);
  };
  const lineZ = (w: World, x: number, z0: number, z1: number) => {
    for (let z = z0; z <= z1; z++) w.placeBuilding(B.wall, x, z, true);
  };

  it('refused on a reserved tile', () => {
    refused(
      (w) => {
        line(w, 5, 8, 10);
        w.placeBuilding(B.wall, 9, 10, false); // a reserved wall site in the middle
        line(w, 10, 13, 10);
      },
      9,
      10,
      /refused: every gate tile must be a finished wall: the wall at 9,10 is reserved/,
    );
  });

  it('refused on a started tile', () => {
    refused(
      (w) => {
        line(w, 5, 9, 10);
        const site = w.placeBuilding(B.wall, 10, 10, false);
        w.startSite(w.buildings.slotForId(site));
        line(w, 11, 13, 10);
      },
      9,
      10,
      /the wall at 10,10 is under construction/,
    );
  });

  it('refused at a corner', () => {
    refused(
      (w) => {
        line(w, 1, 7, 3);
        lineZ(w, 7, 4, 9);
      },
      6,
      3,
      /the wall must continue past both ends/,
    );
  });

  it('refused at a T', () => {
    refused(
      (w) => {
        line(w, 1, 9, 3);
        lineZ(w, 5, 4, 8);
      },
      5,
      3,
      /not a straight run \(something joins the side\)/,
    );
  });

  it('refused with a missing end', () => {
    refused((w) => line(w, 1, 4, 3), 2, 3, /the wall must continue past both ends/);
  });

  it('refused at depth 5', () => {
    refused(
      (w) => {
        for (let z = 3; z <= 7; z++) line(w, 1, 9, z);
      },
      5,
      5,
      /wall deeper than 4/,
    );
  });

  it('refused from build and place: a gate is made from walls', () => {
    const w = flat();
    expect(w.submit({ t: 'build', ids: [], kind: B.gate, tx: 5, ty: 5 })).toMatch(/made from finished walls/);
    expect(w.submit({ t: 'place', kind: B.gate, tx: 5, ty: 5 })).toMatch(/made from finished walls/);
  });
});

// ---- passage -------------------------------------------------------------------------------------

/**
 * A barrier across the map at v = 15..15+depth-1: rock everywhere except a 5-tile wall run
 * (u = 7..11), converted into a gate at u = 8..10 and built. The two walls left at the ends are
 * then replaced by rock, so the gate is the only way through.
 */
function gatedBarrier(axis: 'x' | 'z', depth: number) {
  const rocks: Array<[number, number]> = [];
  for (let v = 15; v < 15 + depth; v++) for (let u = 0; u < MAP; u++) if (u < 7 || u > 11) rocks.push(onAxis(axis, u, v));
  const terrain = flatTerrain(MAP, MAP, { rocks, base: { x: 15, z: 2 } });
  const w = new World(1, terrain, { waves: false });
  w.pool.set([1e6, 1e6, 1e6]);
  for (let v = 15; v < 15 + depth; v++) for (let u = 7; u <= 11; u++) w.placeBuilding(B.wall, ...onAxis(axis, u, v), true);
  const builder = w.spawnUnit(U.engineer, ...(onAxis(axis, 9.5, 15 + depth + 1.5) as [number, number]));
  expect(w.submit({ t: 'gate', ids: [builder], tx: onAxis(axis, 9, 15)[0], ty: onAxis(axis, 9, 15)[1] })).toBeNull();
  for (let i = 0; i < 4000; i++) {
    w.step();
    const g = gateSlot(w);
    if (g >= 0 && w.buildings.cols.flags[g]! & BF_COMPLETE) break;
  }
  const g = gateSlot(w);
  expect(w.buildings.cols.flags[g]! & BF_COMPLETE).toBe(BF_COMPLETE);
  for (let v = 15; v < 15 + depth; v++) {
    for (const u of [7, 11]) {
      const [x, y] = onAxis(axis, u, v);
      w.removeBuilding(w.occupancy[y * MAP + x]! - 1);
      terrain.tiles[y * MAP + x] = TILE_ROCK;
    }
  }
  w.gridsDirty = true;
  w.fieldDirty.fill(1);
  w.units.remove(w.units.slotForId(builder));
  const tiles = new Set<number>();
  for (let v = 15; v < 15 + depth; v++) for (let u = 8; u <= 10; u++) tiles.add(onAxis(axis, u, v)[1] * MAP + onAxis(axis, u, v)[0]);
  return { w, gate: w.buildings.id(g), tiles };
}

describe('gate passage', () => {
  for (const [axis, depth] of [['x', 2], ['z', 3]] as const) {
    describe(`axis ${axis}, depth ${depth}`, () => {
      it("a player unit's path crosses the corridor (the centre column), never the outer columns", () => {
        const { w, tiles } = gatedBarrier(axis, depth);
        const [sx, sz] = onAxis(axis, 9.5, 27.5);
        const [gx, gz] = onAxis(axis, 9.5, 4.5);
        const e = w.spawnUnit(U.engineer, sx, sz);
        w.enqueue({ t: 'move', ids: [e], x: gx, z: gz });
        const crossed = new Set<number>();
        for (let i = 0; i < 800; i++) {
          w.step();
          const s = w.units.slotForId(e);
          const cell = Math.floor(w.units.cols.z[s]!) * MAP + Math.floor(w.units.cols.x[s]!);
          if (tiles.has(cell)) crossed.add(cell);
        }
        const s = w.units.slotForId(e);
        expect(w.units.cols.x[s]!).toBeCloseTo(gx, 3);
        expect(w.units.cols.z[s]!).toBeCloseTo(gz, 3);
        // It went through every row of the gate, in the centre column (u = 9) only.
        const centre = [...tiles].filter((c) => (axis === 'x' ? c % MAP : Math.floor(c / MAP)) === 9);
        expect([...crossed].sort()).toEqual(centre.sort());
        expect(centre.length).toBe(depth);
      });

      it('aliens route to the gate, attack it, never enter its tiles (not even diagonally), and pass once it falls', () => {
        const { w, gate, tiles } = gatedBarrier(axis, depth);
        w.placeBuilding(B.gun, ...onAxis(axis, 9, 3), true); // the rushers' goal, behind the gate
        w.rebuildField(CAT_DEFENCES);
        const field = w.fields[CAT_DEFENCES]!;
        // The flow field's route from the far side crosses the gate.
        const start = onAxis(axis, 9, 28);
        const route = field.trace(start[1] * MAP + start[0]);
        expect(route.some((c) => tiles.has(c))).toBe(true);
        // No diagonal step anywhere cuts past a gate tile (corner rule).
        for (let c = 0; c < MAP * MAP; c++) {
          const d = field.dir[c]!;
          if (d < 0 || !(d & 1)) continue;
          const x = c % MAP;
          const z = Math.floor(c / MAP);
          expect(tiles.has(z * MAP + x + DX[d]!) || tiles.has((z + DZ[d]!) * MAP + x), `diagonal from ${x},${z}`).toBe(false);
        }
        const aliens = [0, 1, 2, 3, 4, 5].map((i) => w.spawnAlien(A.rusher, ...(onAxis(axis, 6.5 + i, 26.5) as [number, number])));
        const gs = w.buildings.slotForId(gate);
        const hp0 = w.buildings.cols.hp[gs]!;
        let attacked = 0;
        for (let i = 0; i < 600; i++) {
          w.step();
          for (const id of aliens) {
            const a = w.aliens.slotForId(id);
            if (a < 0) continue;
            const cell = Math.floor(w.aliens.cols.z[a]!) * MAP + Math.floor(w.aliens.cols.x[a]!);
            expect(tiles.has(cell), `alien on a gate tile at tick ${w.tick}`).toBe(false);
            if (w.aliens.cols.tType[a] === T_BUILDING && w.aliens.cols.tId[a] === gate) attacked++;
          }
        }
        expect(attacked).toBeGreaterThan(0);
        expect(w.buildings.cols.hp[gs]!).toBeLessThan(hp0); // the gate took damage
        // Destroyed: the aliens come through where it stood.
        w.buildings.cols.hp[gs] = 0;
        let through = false;
        let onFormerGate = false;
        for (let i = 0; i < 600 && !through; i++) {
          w.step();
          for (const id of aliens) {
            const a = w.aliens.slotForId(id);
            if (a < 0) continue;
            const cell = Math.floor(w.aliens.cols.z[a]!) * MAP + Math.floor(w.aliens.cols.x[a]!);
            if (tiles.has(cell)) onFormerGate = true;
            const v = axis === 'x' ? w.aliens.cols.z[a]! : w.aliens.cols.x[a]!;
            if (v < 15) through = true;
          }
        }
        expect(w.buildings.slotForId(gate)).toBe(-1);
        expect(onFormerGate).toBe(true);
        expect(through).toBe(true);
      });

      it("each gate tile's flow cost uses the gate's hit points ÷ depth (charged once along a route)", () => {
        const { w, gate, tiles } = gatedBarrier(axis, depth);
        w.rebuildField(CAT_DEFENCES);
        const hp = w.buildings.cols.hp[w.buildings.slotForId(gate)]!;
        expect(hp).toBe(buildingInfo(B.wall).hp * 3 * depth);
        for (const c of tiles) {
          expect(w.cost[c]).toBe(10 + buildingPathCost(B.gate, hp / depth));
          expect(w.open[c]).toBe(0);
        }
        // Crossing all `depth` rows costs about the gate's hit points once, not depth times.
        const crossing = depth * (buildingPathCost(B.gate, hp / depth) - 20);
        expect(Math.abs(crossing - Math.round(hp / 10))).toBeLessThanOrEqual(depth);
      });
    });
  }
});
