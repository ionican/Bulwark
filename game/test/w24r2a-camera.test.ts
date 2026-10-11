// W24 run 2a, Richard's feedback: the workshop camera's feel (cameraRig.ts Orbit, input.ts Gestures).
// Picking stays correct after an orbit down to the lowest tilt and after a pan (three.js raycast of
// the drawn ground); a click of under 5 px selects and never moves the camera; Shift + left-drag
// box-selects; a left-drag in build mode lays a wall run and does not orbit; a plain left-drag
// orbits; the tilt stays within 10°–89° and survives zooming.

import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import { B, U } from '../src/sim/kinds.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { World } from '../src/sim/world.ts';
import { Orbit, RIG_LIMITS, applyRig, pitchOf, type Rig } from '../src/render/cameraRig.ts';
import { groundHeight } from '../src/render/ground.ts';
import { buildGroundGeometry } from '../src/render/groundView.ts';
import { boxSelect, buildOccupancy, pickScreen, screenToGround, type Pick, type PickView } from '../src/render/picking.ts';
import { Gestures, type GestureHost } from '../src/input.ts';
import { Rand } from '../src/render/workshop/noise.ts';
import { terrain } from './w24r2a-fixtures.ts';

const VW = 1440;
const VH = 900;
const DEG = Math.PI / 180;

const world = new World(1, terrain, { waves: false });
const gun = world.placeBuilding(B.gun, 60, 56, true);
const engineer = world.spawnUnit(U.engineer, 64.5, 60.5);
const engineer2 = world.spawnUnit(U.engineer, 66.5, 60.5);
const snap = decodeSnapshot(encodeSnapshot(world));
const rows = { count: snap.buildings.count, id: snap.buildings.id, kind: snap.buildings.cols.kind, tx: snap.buildings.cols.tx, ty: snap.buildings.cols.ty, fw: snap.buildings.cols.fw, fh: snap.buildings.cols.fh };
const view: PickView = {
  mapW: terrain.w,
  mapH: terrain.h,
  occupancy: buildOccupancy(rows, terrain.w, terrain.h, new Int32Array(terrain.w * terrain.h)),
  buildings: rows,
  units: { count: snap.units.count, id: snap.units.id, kind: snap.units.cols.kind, x: snap.units.cols.x, z: snap.units.cols.z },
  aliens: { count: 0, id: new Uint32Array(0), kind: new Uint8Array(0), x: new Float32Array(0), z: new Float32Array(0) },
};
const ground = new Mesh(buildGroundGeometry(terrain).geometry, new MeshBasicMaterial());
ground.updateMatrixWorld();

function setup(r: Partial<Rig> = {}) {
  const rig: Rig = { x: 64, z: 60, distance: 50, yaw: 0, pitch: 60 * DEG, ...r };
  const camera = new PerspectiveCamera(45, VW / VH, 0.5, 1000);
  const orbit = new Orbit(rig);
  orbit.damping = 1;
  const apply = () => applyRig(camera, rig, groundHeight(terrain, rig.x, rig.z));
  apply();
  return { rig, camera, orbit, apply };
}

const screenOf = (cam: PerspectiveCamera, x: number, z: number) => {
  const p = new Vector3(x, groundHeight(terrain, x, z), z).project(cam);
  return { x: ((p.x + 1) / 2) * VW, y: ((1 - p.y) / 2) * VH };
};

/** 100 screen points: the ground pick lands on the mesh (raycast) within 0.01 tiles. */
function checkPicks(cam: PerspectiveCamera): number {
  const ray = new Raycaster();
  const rnd = new Rand(3);
  let n = 0;
  for (let i = 0; i < 2000 && n < 100; i++) {
    const sx = rnd.range(0, VW);
    const sy = rnd.range(VH * 0.3, VH);
    const pick = screenToGround(cam, sx, sy, VW, VH, terrain);
    if (!pick || pick.x < 0.5 || pick.z < 0.5 || pick.x > terrain.w - 0.5 || pick.z > terrain.h - 0.5) continue;
    ray.setFromCamera(new Vector2((sx / VW) * 2 - 1, -(sy / VH) * 2 + 1), cam);
    const hit = ray.intersectObject(ground, false)[0]!;
    expect(hit.point.distanceTo(new Vector3(pick.x, pick.y, pick.z))).toBeLessThan(0.01);
    n++;
  }
  return n;
}

function host(camera: PerspectiveCamera, building = false) {
  const log: { clicks: Pick[][]; boxes: Pick[][]; runs: Array<[number, number, number, number]> } = { clicks: [], boxes: [], runs: [] };
  const h: GestureHost = {
    camera,
    viewportHeight: () => VH,
    building: () => building,
    click(button, x, y) {
      if (button !== 0) return;
      const p = pickScreen(camera, x, y, VW, VH, terrain, view);
      log.clicks.push(p ? [p] : []);
    },
    box(x0, y0, x1, y1) {
      log.boxes.push(boxSelect(camera, x0, y0, x1, y1, VW, VH, terrain, view));
    },
    boxPreview() {},
    buildDrag(x0, y0, x1, y1) {
      const a = screenToGround(camera, x0, y0, VW, VH, terrain)!;
      const b = screenToGround(camera, x1, y1, VW, VH, terrain)!;
      log.runs.push([Math.floor(a.x), Math.floor(a.z), Math.floor(b.x), Math.floor(b.z)]);
    },
  };
  return { h, log };
}

const settle = (o: Orbit, apply: () => void) => {
  for (let i = 0; i < 400 && o.update(); i++) apply();
};

describe('camera: the workshop orbit, driven by the game input', () => {
  it('orbit down to the lowest tilt (10°, the workshop polar limit): picking still lands on the drawn ground', () => {
    const { rig, camera, orbit, apply } = setup();
    orbit.rotate(300, -2000, VH);
    settle(orbit, apply);
    expect(pitchOf(rig)).toBeCloseTo(RIG_LIMITS.minPitch, 9);
    expect(rig.yaw).not.toBe(0);
    expect(checkPicks(camera)).toBe(100);
    const s = screenOf(camera, 61, 57);
    expect(pickScreen(camera, s.x, s.y, VW, VH, terrain, view, 0)).toEqual({ type: 'building', id: gun, kind: B.gun });
  });

  it('pan on the ground plane: the target moves, height stays on the ground, picking still correct', () => {
    const { rig, camera, orbit, apply } = setup({ pitch: 35 * DEG, yaw: 0.6 });
    const y0 = camera.position.y - groundHeight(terrain, rig.x, rig.z);
    orbit.pan(-260, 140, camera, VH);
    settle(orbit, apply);
    expect(Math.hypot(rig.x - 64, rig.z - 60)).toBeGreaterThan(5);
    expect(camera.position.y - groundHeight(terrain, rig.x, rig.z)).toBeCloseTo(y0, 6);
    expect(checkPicks(camera)).toBe(100);
  });

  it('the tilt is clamped to 10°–89° and survives a zoom', () => {
    const { rig, orbit, apply } = setup();
    orbit.rotate(0, 5000, VH);
    settle(orbit, apply);
    expect(pitchOf(rig)).toBeCloseTo(RIG_LIMITS.maxPitch, 9);
    orbit.rotate(0, -VH * 0.05, VH);
    settle(orbit, apply);
    const tilt = rig.pitch!;
    orbit.dolly(120);
    settle(orbit, apply);
    expect(rig.distance).toBeGreaterThan(50);
    expect(rig.pitch).toBe(tilt);
  });

  it('a click under 5 px selects the unit under it and does not move the camera', () => {
    const { rig, camera, orbit, apply } = setup();
    const before = JSON.stringify(rig);
    const { h, log } = host(camera);
    const g = new Gestures(orbit, h);
    const s = screenOf(camera, 64.5, 60.5);
    g.down({ button: 0, x: s.x, y: s.y, shift: false });
    g.move({ button: 0, x: s.x + 3, y: s.y - 1, shift: false });
    g.up({ button: 0, x: s.x + 3, y: s.y - 1, shift: false });
    settle(orbit, apply);
    expect(log.clicks).toEqual([[{ type: 'unit', id: engineer, kind: U.engineer }]]);
    expect(JSON.stringify(rig)).toBe(before);
  });

  it('Shift + left-drag box-selects (and does not orbit); a plain left-drag orbits', () => {
    const { rig, camera, orbit, apply } = setup();
    const before = JSON.stringify(rig);
    const { h, log } = host(camera);
    const g = new Gestures(orbit, h);
    const a = screenOf(camera, 63, 59);
    const b = screenOf(camera, 68, 62);
    g.down({ button: 0, x: a.x, y: a.y, shift: true });
    g.move({ button: 0, x: b.x, y: b.y, shift: true });
    g.up({ button: 0, x: b.x, y: b.y, shift: true });
    settle(orbit, apply);
    expect(log.boxes.map((l) => l.map((p) => p.id).sort())).toEqual([[engineer, engineer2].sort()]);
    expect(JSON.stringify(rig)).toBe(before);
    g.down({ button: 0, x: 700, y: 450, shift: false });
    g.move({ button: 0, x: 760, y: 420, shift: false });
    g.up({ button: 0, x: 760, y: 420, shift: false });
    settle(orbit, apply);
    expect(log.clicks.length).toBe(0);
    expect(rig.yaw).toBeLessThan(0);
    expect(rig.pitch!).toBeLessThan(60 * DEG);
  });

  it('in build mode a left-drag lays the run from the press to the release tile and does not orbit', () => {
    const { rig, camera, orbit, apply } = setup();
    const before = JSON.stringify(rig);
    const { h, log } = host(camera, true);
    const g = new Gestures(orbit, h);
    const a = screenOf(camera, 56.5, 64.5);
    const b = screenOf(camera, 66.5, 64.5);
    g.down({ button: 0, x: a.x, y: a.y, shift: false });
    for (let k = 1; k <= 10; k++) g.move({ button: 0, x: a.x + ((b.x - a.x) * k) / 10, y: a.y + ((b.y - a.y) * k) / 10, shift: false });
    g.up({ button: 0, x: b.x, y: b.y, shift: false });
    settle(orbit, apply);
    expect(log.runs).toEqual([[56, 64, 66, 64]]);
    expect(log.clicks.length).toBe(0);
    expect(JSON.stringify(rig)).toBe(before);
  });
});
