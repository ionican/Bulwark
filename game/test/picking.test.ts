import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { World } from '../src/sim/world.ts';
import { B, U, buildingFootprint } from '../src/sim/kinds.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { heightAt, map1Terrain } from '../src/sim/terrain.ts';
import { applyRig, type Rig } from '../src/render/cameraRig.ts';
import { boxSelect, buildOccupancy, pickScreen, screenToGround, type PickView } from '../src/render/picking.ts';

const VW = 1440;
const VH = 900;
const terrain = map1Terrain();

// A world with buildings on known tiles away from the flattened base, so the ground is not flat.
const w = new World(1);
const placements = [
  { kind: B.gun, tx: 30, ty: 90 },
  { kind: B.wall, tx: 33, ty: 90 },
  { kind: B.wall, tx: 34, ty: 90 },
  { kind: B.lab, tx: 36, ty: 88 },
  { kind: B.heavy, tx: 26, ty: 95 },
];
const ids = placements.map((p) => {
  const id = w.placeBuilding(p.kind, p.tx, p.ty, true);
  expect(id).toBeGreaterThanOrEqual(0);
  return id;
});
const engineer = w.spawnUnit(U.engineer, 31.5, 97.5);
const snap = decodeSnapshot(encodeSnapshot(w));
const occ = buildOccupancy(
  { count: snap.buildings.count, id: snap.buildings.id, kind: snap.buildings.cols.kind, tx: snap.buildings.cols.tx, ty: snap.buildings.cols.ty, fw: snap.buildings.cols.fw, fh: snap.buildings.cols.fh },
  terrain.w,
  terrain.h,
  new Int32Array(terrain.w * terrain.h),
);
const view: PickView = {
  mapW: terrain.w,
  mapH: terrain.h,
  occupancy: occ,
  buildings: { count: snap.buildings.count, id: snap.buildings.id, kind: snap.buildings.cols.kind, tx: snap.buildings.cols.tx, ty: snap.buildings.cols.ty, fw: snap.buildings.cols.fw, fh: snap.buildings.cols.fh },
  units: { count: snap.units.count, id: snap.units.id, kind: snap.units.cols.kind, x: snap.units.cols.x, z: snap.units.cols.z },
  aliens: { count: snap.aliens.count, id: snap.aliens.id, kind: snap.aliens.cols.kind, x: snap.aliens.cols.x, z: snap.aliens.cols.z },
};

function cameraFor(rig: Rig): PerspectiveCamera {
  const cam = new PerspectiveCamera(45, VW / VH, 0.5, 1000);
  applyRig(cam, rig, heightAt(terrain, rig.x, rig.z));
  return cam;
}

/** Screen pixel of a ground point (x, z), as the browser would report a click there. */
function toScreen(cam: PerspectiveCamera, x: number, z: number) {
  const p = new Vector3(x, heightAt(terrain, x, z), z).project(cam);
  return { sx: ((p.x + 1) / 2) * VW, sy: ((1 - p.y) / 2) * VH, onScreen: Math.abs(p.x) < 1 && Math.abs(p.y) < 1 };
}

// Three camera heights: close-up (full models), mid (simple shapes), whole map (icons).
const RIGS: Array<[string, Rig]> = [
  ['close', { x: 32, z: 93, distance: 20, yaw: 0.4 }],
  ['mid', { x: 40, z: 85, distance: 95, yaw: -0.9 }],
  ['far', { x: 64, z: 64, distance: 200, yaw: 0 }],
];

describe('ground-ray picking', () => {
  it('the test ground is not flat under the targets (so height refinement matters)', () => {
    const hs = placements.map((p) => heightAt(terrain, p.tx + 0.5, p.ty + 0.5));
    expect(Math.max(...hs)).toBeGreaterThan(0.5);
  });

  for (const [name, rig] of RIGS) {
    describe(`camera ${name} (distance ${rig.distance})`, () => {
      const cam = cameraFor(rig);

      it('casts screen pixels back onto the terrain within 0.05 tiles', () => {
        for (const [x, z] of [[30.3, 90.7], [37.9, 89.1], [27.2, 96.4]] as const) {
          const s = toScreen(cam, x, z);
          const g = screenToGround(cam, s.sx, s.sy, VW, VH, terrain)!;
          expect(g).not.toBeNull();
          expect(Math.abs(g.x - x)).toBeLessThan(0.05);
          expect(Math.abs(g.z - z)).toBeLessThan(0.05);
        }
      });

      it('returns the building on the clicked tile, for every footprint tile', () => {
        placements.forEach((p, i) => {
          const [fw, fh] = buildingFootprint(p.kind); // W24: rectangular footprints (square for these kinds)
          for (let j = 0; j < fh; j++) {
            for (let k = 0; k < fw; k++) {
              const s = toScreen(cam, p.tx + k + 0.5, p.ty + j + 0.5);
              expect(s.onScreen).toBe(true);
              const hit = pickScreen(cam, s.sx, s.sy, VW, VH, terrain, view, 0);
              expect(hit, `${name}: building ${i} tile ${k},${j}`).toEqual({ type: 'building', id: ids[i], kind: p.kind });
            }
          }
        });
      });

      it('returns nothing on an empty tile next to the buildings', () => {
        const s = toScreen(cam, 33.5, 92.5);
        expect(pickScreen(cam, s.sx, s.sy, VW, VH, terrain, view, 0)).toBeNull();
      });

      it('returns the engineer when clicking on it', () => {
        const s = toScreen(cam, 31.6, 97.4);
        expect(pickScreen(cam, s.sx, s.sy, VW, VH, terrain, view)).toEqual({ type: 'unit', id: engineer, kind: U.engineer });
      });
    });
  }

  it('box select picks the units inside, else the buildings inside', () => {
    const cam = cameraFor({ x: 32, z: 92, distance: 40, yaw: 0 });
    const a = toScreen(cam, 29.6, 89.6);
    const b = toScreen(cam, 35.4, 91.4);
    const picks = boxSelect(cam, a.sx, a.sy, b.sx, b.sy, VW, VH, terrain, view);
    expect(picks.map((p) => p.id).sort()).toEqual([ids[0], ids[1], ids[2]].sort());
    const e = toScreen(cam, 31.5, 97.5);
    const units = boxSelect(cam, e.sx - 25, e.sy - 25, e.sx + 25, e.sy + 25, VW, VH, terrain, view);
    expect(units).toEqual([{ type: 'unit', id: engineer, kind: U.engineer }]);
  });
});
