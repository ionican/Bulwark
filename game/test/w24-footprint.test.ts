// W24 acceptance 3 (footprints): rectangular fw × fh footprints replace W13's square `size`
// everywhere (occupancy, placement, removal, attack distance, picking). For every existing kind the
// results are unchanged: each is compared with the W13 code (game/src at 0192b27), copied below as
// reference functions, and with W13's per-kind sizes.

import { describe, expect, it } from 'vitest';
import { World, canPlaceOn } from '../src/sim/world.ts';
import { B, BUILDING_KINDS, buildingFootprint, buildingInfo, type BuildingKind } from '../src/sim/kinds.ts';
import { TILE_GROUND, TILE_MASS, TILE_RARE, flatTerrain, tileAt, type Terrain } from '../src/sim/terrain.ts';
import { centreOf, distToBuilding } from '../src/sim/combat.ts';
import { buildOccupancy } from '../src/render/picking.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';

/** W13's `size` per kind (game/src/sim/kinds.ts at 0192b27). */
const W13_SIZE: Record<Exclude<BuildingKind, 'gate'>, number> = {
  massExtractor: 2,
  generator: 2,
  rareExtractor: 2,
  lab: 3,
  depot: 2,
  shredder: 2,
  smelter: 2,
  assembler: 2,
  wall: 1,
  gun: 2,
  area: 2,
  beam: 2,
  heavy: 3,
  shield: 2,
  tempTurret: 1,
  belt: 1,
  splitter: 1,
  merger: 1,
};
const EXISTING = BUILDING_KINDS.filter((k) => k !== 'gate') as Array<Exclude<BuildingKind, 'gate'>>;

// ---- W13 reference code (0192b27), with the size passed in --------------------------------------

/** world.ts canPlaceOn. */
function w13CanPlace(terrain: Terrain, occupancy: Int32Array, kind: number, size: number, tx: number, ty: number): boolean {
  const need = kind === B.massExtractor ? TILE_MASS : kind === B.rareExtractor ? TILE_RARE : TILE_GROUND;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = tx + i;
      const y = ty + j;
      if (tileAt(terrain, x, y) !== need) return false;
      if (occupancy[y * terrain.w + x] !== 0) return false;
    }
  }
  return true;
}
/** world.ts placeBuilding occupancy loop: the tiles marked. */
function w13Tiles(w: number, size: number, tx: number, ty: number): number[] {
  const out: number[] = [];
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) out.push((ty + j) * w + tx + i);
  return out;
}
/** combat.ts distToBuilding. */
function w13Dist(size: number, x0: number, z0: number, x: number, z: number): number {
  const dx = x < x0 ? x0 - x : x > x0 + size ? x - x0 - size : 0;
  const dz = z < z0 ? z0 - z : z > z0 + size ? z - z0 - size : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

// A 40 × 40 flat map with one mass and one rare deposit; something else stands nearby so the
// placement checks see occupied tiles as well as free ones.
function setup() {
  const terrain = flatTerrain(40, 40, { deposits: [{ kind: 'mass', tx: 10, ty: 10 }, { kind: 'rare', tx: 20, ty: 20 }] });
  const w = new World(1, terrain, { waves: false });
  w.placeBuilding(B.lab, 14, 9, true); // a 3 × 3 neighbour
  return w;
}
const anchorFor = (k: string): [number, number] => (k === 'massExtractor' ? [10, 10] : k === 'rareExtractor' ? [20, 20] : [9, 14]);

describe('footprints: every existing kind is unchanged from W13', () => {
  it("each kind's footprint is W13's square size", () => {
    for (const k of EXISTING) {
      expect(buildingFootprint(B[k]), k).toEqual([W13_SIZE[k], W13_SIZE[k]]);
      expect(buildingInfo(B[k]).fw).toBe(W13_SIZE[k]);
      expect(buildingInfo(B[k]).fh).toBe(W13_SIZE[k]);
    }
  });

  for (const k of EXISTING) {
    it(`${k}: occupancy, placement, removal, attack distance, centre and picking match W13`, () => {
      const w = setup();
      const kind = B[k];
      const size = W13_SIZE[k];
      const [tx, ty] = anchorFor(k);
      const Wd = w.terrain.w;

      // Placement: the same answer as W13 for every anchor round the spot, before placing.
      for (let y = ty - 4; y <= ty + 4; y++)
        for (let x = tx - 4; x <= tx + 4; x++)
          expect(w.canPlace(kind, x, y), `${k} at ${x},${y}`).toBe(w13CanPlace(w.terrain, w.occupancy, kind, size, x, y));
      expect(canPlaceOn(w.terrain, w.occupancy, kind, tx, ty)).toBe(true);

      // Occupancy: exactly W13's tiles, marked with the new building's slot.
      const before = Int32Array.from(w.occupancy);
      const id = w.placeBuilding(kind, tx, ty, true);
      expect(id).toBeGreaterThanOrEqual(0);
      const slot = w.buildings.slotForId(id);
      const tiles = new Set(w13Tiles(Wd, size, tx, ty));
      for (let i = 0; i < w.occupancy.length; i++) {
        if (tiles.has(i)) expect(w.occupancy[i], `tile ${i}`).toBe(slot + 1);
        else expect(w.occupancy[i], `tile ${i}`).toBe(before[i]);
      }
      expect([w.buildings.cols.fw[slot], w.buildings.cols.fh[slot]]).toEqual([size, size]);

      // Placement after: the same answer as W13 everywhere round it (now occupied).
      for (let y = ty - 4; y <= ty + 4; y++)
        for (let x = tx - 4; x <= tx + 4; x++) expect(w.canPlace(B.wall, x, y)).toBe(w13CanPlace(w.terrain, w.occupancy, B.wall, 1, x, y));

      // Attack distance (nearest footprint point) and centre, at points inside, on edges and around.
      for (let z = ty - 3; z <= ty + size + 3; z += 0.5)
        for (let x = tx - 3; x <= tx + size + 3; x += 0.5) expect(distToBuilding(w, slot, x, z)).toBe(w13Dist(size, tx, ty, x, z));
      expect(centreOf(w, slot)).toEqual([tx + size / 2, ty + size / 2]);

      // Picking: the render thread's occupancy from the snapshot covers the same tiles.
      const snap = decodeSnapshot(encodeSnapshot(w));
      const c = snap.buildings.cols;
      const pick = buildOccupancy({ count: snap.buildings.count, id: snap.buildings.id, kind: c.kind, tx: c.tx, ty: c.ty, fw: c.fw, fh: c.fh }, Wd, w.terrain.h, new Int32Array(Wd * w.terrain.h));
      const row = Array.from(snap.buildings.id).indexOf(id);
      for (let i = 0; i < pick.length; i++) expect(pick[i] === row + 1, `pick tile ${i}`).toBe(tiles.has(i));

      // Removal: exactly those tiles are freed, nothing else changes.
      w.removeBuilding(slot);
      expect(Array.from(w.occupancy)).toEqual(Array.from(before));
    });
  }
});

describe('footprints: rectangles', () => {
  it('a 3 × 2 footprint (a depth-2 gate along x) occupies, measures and frees as a rectangle', () => {
    const w = new World(1, flatTerrain(20, 20), { waves: false });
    const id = w.placeBuilding(B.gate, 5, 7, true, 0, 3, 2);
    const s = w.buildings.slotForId(id);
    const occupied: number[] = [];
    for (let i = 0; i < w.occupancy.length; i++) if (w.occupancy[i] === s + 1) occupied.push(i);
    expect(occupied).toEqual([7 * 20 + 5, 7 * 20 + 6, 7 * 20 + 7, 8 * 20 + 5, 8 * 20 + 6, 8 * 20 + 7]);
    expect(centreOf(w, s)).toEqual([6.5, 8]);
    expect(distToBuilding(w, s, 6.5, 10)).toBe(1); // 1 beyond the south edge (z = 9)
    expect(distToBuilding(w, s, 10, 8)).toBe(2); // 2 beyond the east edge (x = 8)
    expect(w.canPlace(B.wall, 7, 8)).toBe(false);
    expect(w.canPlace(B.wall, 8, 8)).toBe(true);
    w.removeBuilding(s);
    expect(w.occupancy.every((v) => v === 0)).toBe(true);
  });
});
