// W25c finding 5 (Codex adversarial review, 9 Oct, medium): units were hard to select with the
// camera tilted low. Picking projected the click onto the ground and tested ground-position radii,
// but the commander model is about 3.7 tiles tall and the camera goes down to 10° elevation: a click
// on its torso at 10° hit the ground about 17 tiles behind it, and at 50° it also missed.
// Required: units and aliens are picked with the click ray against a volume per kind sized to the
// model; box selection uses the projected volumes; buildings are picked as before.
// The click points are taken from the rigs themselves (W23 CommanderRig / EngineerRig at rest): the
// head, torso and foot segment origins.

import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3, type Matrix4 } from 'three';
import { World } from '../src/sim/world.ts';
import { B, U } from '../src/sim/kinds.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { map1Terrain } from '../src/sim/terrain.ts';
import { applyRig } from '../src/render/cameraRig.ts';
import { groundHeight } from '../src/render/ground.ts';
import { boxSelect, buildOccupancy, pickScreen, type PickView } from '../src/render/picking.ts';
import { CSEG, CommanderRig } from '../src/render/workshop/w23/rig/commander.ts';
import { EngineerRig, SEG, VARIANTS } from '../src/render/workshop/w23/rig/engineer.ts';

const VW = 1440;
const VH = 900;
const terrain = map1Terrain();
const ground = (x: number, z: number) => groundHeight(terrain, x, z);

const w = new World(1, terrain, { waves: false });
const commander = w.spawnUnit(U.commander, 40.5, 92.5);
const engineer = w.spawnUnit(U.engineer, 56.5, 92.5);
const gun = w.placeBuilding(B.gun, 48, 80, true); // 2 × 2, well away from both units
const snap = decodeSnapshot(encodeSnapshot(w));
const b = snap.buildings;
const view: PickView = {
  mapW: terrain.w,
  mapH: terrain.h,
  occupancy: buildOccupancy({ count: b.count, id: b.id, kind: b.cols.kind, tx: b.cols.tx, ty: b.cols.ty, fw: b.cols.fw, fh: b.cols.fh }, terrain.w, terrain.h, new Int32Array(terrain.w * terrain.h)),
  buildings: { count: b.count, id: b.id, kind: b.cols.kind, tx: b.cols.tx, ty: b.cols.ty, fw: b.cols.fw, fh: b.cols.fh },
  units: { count: snap.units.count, id: snap.units.id, kind: snap.units.cols.kind, x: snap.units.cols.x, z: snap.units.cols.z },
  aliens: { count: snap.aliens.count, id: snap.aliens.id, kind: snap.aliens.cols.kind, x: snap.aliens.cols.x, z: snap.aliens.cols.z },
};

const pos = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);
/** Head, torso and foot points of each unit's model at rest, facing yaw 0.3 (W23 rigs). */
function bodyPoints(): Record<'commander' | 'engineer', Record<'head' | 'torso' | 'feet', Vector3>> {
  const c = new CommanderRig();
  c.place(40.5, 92.5, 0.3, ground);
  c.update(0, 40.5, 92.5, 0.3, ground);
  const e = new EngineerRig(VARIANTS[0]!);
  e.place(56.5, 92.5, 0.3, ground);
  e.update(0, 56.5, 92.5, 0.3, ground);
  return {
    commander: { head: pos(c.mats[CSEG.head]!), torso: pos(c.mats[CSEG.torso]!), feet: pos(c.mats[CSEG.footL]!) },
    engineer: { head: pos(e.mats[SEG.head]!), torso: pos(e.mats[SEG.torso]!), feet: pos(e.mats[SEG.footL]!) },
  };
}
const POINTS = bodyPoints();
const IDS = { commander, engineer };

function cameraAt(x: number, z: number, elevationDeg: number, yaw: number): PerspectiveCamera {
  const cam = new PerspectiveCamera(45, VW / VH, 0.5, 1000);
  applyRig(cam, { x, z, distance: 25, yaw, pitch: (elevationDeg * Math.PI) / 180 }, ground(x, z));
  return cam;
}
function toScreen(cam: PerspectiveCamera, p: Vector3) {
  const v = p.clone().project(cam);
  return { sx: ((v.x + 1) / 2) * VW, sy: ((1 - v.y) / 2) * VH };
}

const ELEVATIONS = [10, 30, 50, 89];
const YAWS = [0, 2.2];

describe('W25c finding 5: units are picked by their volumes at every camera tilt', () => {
  it('the review probe: the commander’s head and torso stand well above the ground (the rig is about 3.7 tiles tall)', () => {
    expect(POINTS.commander.head.y - ground(40.5, 92.5)).toBeGreaterThan(2.5);
    expect(POINTS.engineer.head.y - ground(56.5, 92.5)).toBeGreaterThan(0.6);
  });

  for (const unit of ['commander', 'engineer'] as const) {
    for (const el of ELEVATIONS) {
      it(`${unit}: a click on the head, the torso and the feet selects it at ${el}°`, () => {
        const id = IDS[unit];
        const centre = unit === 'commander' ? [40.5, 92.5] : [56.5, 92.5];
        const missed: string[] = [];
        for (const yaw of YAWS) {
          const cam = cameraAt(centre[0]!, centre[1]!, el, yaw);
          for (const part of ['head', 'torso', 'feet'] as const) {
            const s = toScreen(cam, POINTS[unit][part]);
            const p = pickScreen(cam, s.sx, s.sy, VW, VH, terrain, view);
            if (p?.type !== 'unit' || p.id !== id) missed.push(`${part} yaw ${yaw}: ${JSON.stringify(p)}`);
          }
        }
        expect(missed).toEqual([]);
      });

      it(`${unit}: a box round its torso selects it at ${el}°, a box beside it does not`, () => {
        const id = IDS[unit];
        const centre = unit === 'commander' ? [40.5, 92.5] : [56.5, 92.5];
        for (const yaw of YAWS) {
          const cam = cameraAt(centre[0]!, centre[1]!, el, yaw);
          const s = toScreen(cam, POINTS[unit].torso);
          const picks = boxSelect(cam, s.sx - 12, s.sy - 12, s.sx + 12, s.sy + 12, VW, VH, terrain, view);
          expect(picks.some((p) => p.type === 'unit' && p.id === id), `yaw ${yaw}: ${JSON.stringify(picks)}`).toBe(true);
          const beside = boxSelect(cam, s.sx + 300, s.sy - 12, s.sx + 330, s.sy + 12, VW, VH, terrain, view);
          expect(beside.some((p) => p.id === id), `beside, yaw ${yaw}`).toBe(false);
        }
      });
    }
  }

  for (const el of ELEVATIONS) {
    it(`buildings are unaffected at ${el}°: a click on each footprint tile picks the gun turret, a box round it selects it`, () => {
      const cam = cameraAt(49, 81, el, 0.4);
      for (const [x, z] of [[48.5, 80.5], [49.5, 80.5], [48.5, 81.5], [49.5, 81.5]] as const) {
        const s = toScreen(cam, new Vector3(x, ground(x, z), z));
        expect(pickScreen(cam, s.sx, s.sy, VW, VH, terrain, view, 0), `${x},${z}`).toEqual({ type: 'building', id: gun, kind: B.gun });
      }
      const c = toScreen(cam, new Vector3(49, ground(49, 81), 81));
      expect(boxSelect(cam, c.sx - 15, c.sy - 15, c.sx + 15, c.sy + 15, VW, VH, terrain, view)).toEqual([{ type: 'building', id: gun, kind: B.gun }]);
    });
  }
});
