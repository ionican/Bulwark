// W24 run 3, criterion 6 (C1, Codex R1-12, R2-12): picking through a building. A click whose ray
// reaches a building's pick volume before a unit's or alien's cylinder selects the building.
// Volumes depend on the construction state: a reserved site has none (it draws only an outline); a
// started site is its footprint × the renderer's construction height × progress; a complete
// building its footprint × the renderer's height; a gate only its two side columns (the corridor
// column has none). The base is the footprint's highest ground (ground.ts footprintRange, as the
// renderer places it) and the height is the renderer's own construction cut span
// (ModelRenderer.buildHeight, the function drawBuilding cuts the model by).
// Negatives: an engineer behind a reserved site, a 10 % started site, or a gate's corridor stays
// selectable; an engineer's visible part beside a turret selects the engineer.

import { describe, expect, it } from 'vitest';
import { Box3, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { World } from '../src/sim/world.ts';
import { B, U, buildingFootprint } from '../src/sim/kinds.ts';
import { BF_STARTED } from '../src/sim/schema.ts';
import { flatTerrain } from '../src/sim/terrain.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { applyRig } from '../src/render/cameraRig.ts';
import { footprintRange, groundHeight } from '../src/render/ground.ts';
import { buildOccupancy, pickScreen, type PickView } from '../src/render/picking.ts';
import { renderer, terrain as mapTerrain } from './w24r2a-fixtures.ts';

const VW = 1440;
const VH = 900;
const terrain = flatTerrain(120, 120);
const { r: models } = renderer();

const w = new World(1, terrain, { waves: false });
const gun = w.placeBuilding(B.gun, 48, 80, true); // tiles 48–49 × 80–81
const hidden = w.spawnUnit(U.engineer, 49, 78.6); // straight behind the gun from the camera
const beside = w.spawnUnit(U.engineer, 50.9, 78.6); // half beside it
const reserved = w.placeBuilding(B.gun, 56, 80, false); // reserved: no volume
const behindReserved = w.spawnUnit(U.engineer, 57, 78.6);
const started = w.placeBuilding(B.gun, 64, 80, false);
w.buildings.cols.flags[w.buildings.slotForId(started)] = BF_STARTED;
w.buildings.cols.progress[w.buildings.slotForId(started)] = 0.1;
const behindStarted = w.spawnUnit(U.engineer, 65, 78.6);
const gate = w.placeBuilding(B.gate, 72, 80, true, 0, 3, 1); // along x: corridor column x = 73
const behindCorridor = w.spawnUnit(U.engineer, 73.5, 78.4);
for (const id of [gun, reserved, started, gate]) expect(id).toBeGreaterThanOrEqual(0);

const snap = decodeSnapshot(encodeSnapshot(w));
const bs = snap.buildings;
const rows = { count: bs.count, id: bs.id, kind: bs.cols.kind, tx: bs.cols.tx, ty: bs.cols.ty, fw: bs.cols.fw, fh: bs.cols.fh };
const view: PickView = {
  mapW: terrain.w,
  mapH: terrain.h,
  occupancy: buildOccupancy(rows, terrain.w, terrain.h, new Int32Array(terrain.w * terrain.h)),
  buildings: { ...rows, flags: bs.cols.flags, progress: bs.cols.progress, tier: bs.cols.tier, dir: bs.cols.dir },
  buildingHeight: (kind, tier) => models.buildHeight(kind, tier),
  units: { count: snap.units.count, id: snap.units.id, kind: snap.units.cols.kind, x: snap.units.cols.x, z: snap.units.cols.z },
  aliens: { count: snap.aliens.count, id: snap.aliens.id, kind: snap.aliens.cols.kind, x: snap.aliens.cols.x, z: snap.aliens.cols.z },
};

/** The camera south of `x`, z 81, 16 tiles away at 30° (yaw 0 looks towards −z). */
function cam(x: number): PerspectiveCamera {
  const c = new PerspectiveCamera(45, VW / VH, 0.5, 1000);
  applyRig(c, { x, z: 81, distance: 16, yaw: 0, pitch: (30 * Math.PI) / 180 }, groundHeight(terrain, x, 81));
  return c;
}
function screen(c: PerspectiveCamera, x: number, y: number, z: number) {
  const v = new Vector3(x, y, z).project(c);
  return { sx: ((v.x + 1) / 2) * VW, sy: ((1 - v.y) / 2) * VH };
}
const pick = (c: PerspectiveCamera, x: number, y: number, z: number) => {
  const p = screen(c, x, y, z);
  return pickScreen(c, p.sx, p.sy, VW, VH, terrain, view);
};
const torso = (x: number, z: number) => groundHeight(terrain, x, z) + 0.5;

describe('run 3 C1: building pick volumes', () => {
  it('a click on an engineer standing straight behind a complete turret selects the turret (its volume comes first)', () => {
    const c = cam(49);
    expect(pick(c, 49, torso(49, 78.6), 78.6)).toEqual({ type: 'building', id: gun, kind: B.gun });
    const top = footprintRange(terrain, 48, 80, 2, 2).top;
    expect(pick(c, 49, top + 1, 81)).toEqual({ type: 'building', id: gun, kind: B.gun });
  });

  it('the visible part of an engineer beside the turret selects the engineer', () => {
    const c = cam(49);
    expect(pick(c, 51.25, torso(50.9, 78.6), 78.6)).toEqual({ type: 'unit', id: beside, kind: U.engineer });
  });

  it('a reserved site has no volume: the engineer behind it is selected', () => {
    const c = cam(57);
    expect(pick(c, 57, torso(57, 78.6), 78.6)).toEqual({ type: 'unit', id: behindReserved, kind: U.engineer });
  });

  it('a started site’s volume is cut at its progress: the engineer behind a 10 % site is selected', () => {
    const c = cam(65);
    expect(pick(c, 65, torso(65, 78.6), 78.6)).toEqual({ type: 'unit', id: behindStarted, kind: U.engineer });
    // a click low on the site itself, below the cut, still selects the site
    const top = footprintRange(terrain, 64, 80, 2, 2).top;
    expect(pick(c, 65, top + 0.05, 82)?.id).toBe(started);
  });

  it('a gate: the corridor column has no volume (the engineer behind it is selected); the side columns do', () => {
    const c = cam(73.5);
    expect(pick(c, 73.5, torso(73.5, 78.4), 78.4)).toEqual({ type: 'unit', id: behindCorridor, kind: U.engineer });
    const top = footprintRange(terrain, 72, 80, 3, 1).top;
    expect(pick(c, 72.5, top + 1, 80.5)).toEqual({ type: 'building', id: gate, kind: B.gate });
    expect(pick(c, 74.5, top + 1, 80.5)).toEqual({ type: 'building', id: gate, kind: B.gate });
  });

  it('without heights (no renderer), buildings are picked by ground tile as before', () => {
    const c = cam(49);
    const p = screen(c, 49, torso(49, 78.6), 78.6);
    const old = pickScreen(c, p.sx, p.sy, VW, VH, terrain, { ...view, buildingHeight: undefined });
    expect(old?.type).toBe('unit');
    void hidden;
  });
});

describe('run 3 C1: the pick height is the renderer’s construction cut span', () => {
  it('for each kind the span covers the drawn model (its bounds) and is at most 0.5 above it', () => {
    for (const kind of [B.gun, B.heavy, B.wall, B.generator, B.lab, B.shield]) {
      const [fw, fh] = buildingFootprint(kind);
      const caps = models.previewRun(kind, [[10, 10, 0]], [], 0);
      const box = new Box3();
      const part = new Box3();
      for (const c of caps) {
        c.geometry.computeBoundingBox();
        part.copy(c.geometry.boundingBox!).applyMatrix4(new Matrix4().fromArray(c.matrix));
        box.union(part);
      }
      const drawn = box.max.y - footprintRange(mapTerrain, 10, 10, fw, fh).top;
      const h = models.buildHeight(kind, 1);
      expect(h, `kind ${kind}: span ${h} vs drawn ${drawn.toFixed(3)}`).toBeGreaterThanOrEqual(drawn - 1e-6);
      expect(h - drawn, `kind ${kind}`).toBeLessThanOrEqual(0.5);
    }
  });
});
