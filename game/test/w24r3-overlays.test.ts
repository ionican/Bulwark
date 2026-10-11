// W24 run 3, criterion 8 (D1, Codex R1-13, R2-6; Richard 2026-10-10: construction frames and
// reserved-site outlines hide behind buildings, health bars stay on top). Frames (entities.ts) and
// reserved outlines (models.ts) each get their own material — not the strategic icons' — with depth
// testing on, depth writes off and a polygon offset towards the camera (they lie on the ground and
// must not flicker against it). Health bars keep depth testing off. A real upgrade frame (an
// upgrade order on a built turret) and a real reserved outline are drawn (non-zero instances).
// The diagnostic controls behind the browser's pixel check (render/debugRender.ts): turning the
// overlays' depth test off and on, and hiding one overlay, touch only those materials and meshes.

import { describe, expect, it } from 'vitest';
import { InstancedMesh, Mesh, PerspectiveCamera, type Material } from 'three';
import { B, U } from '../src/sim/kinds.ts';
import { BF_UPGRADING, isReserved } from '../src/sim/schema.ts';
import { CAPACITY } from '../src/sim/world.ts';
import { EntityRenderer } from '../src/render/entities.ts';
import { Interpolator } from '../src/render/interp.ts';
import { applyRig } from '../src/render/cameraRig.ts';
import { draw, renderer, snapshotOf, terrain } from './w24r2a-fixtures.ts';
import { World } from '../src/sim/world.ts';

/** Map 1 with a built gun turret being upgraded (a real upgrade order) and a reserved gun site. */
function fixture() {
  const w = new World(1, terrain, { waves: false });
  w.pool.set([1e6, 1e6, 1e6]);
  w.debug.allTiers = true;
  const gun = w.placeBuilding(B.gun, 48, 80, true);
  const eng = w.spawnUnit(U.engineer, 47.5, 83.5);
  const far = w.spawnUnit(U.engineer, 20.5, 100.5);
  w.enqueue({ t: 'upgrade', ids: [eng], target: gun });
  w.enqueue({ t: 'build', ids: [far], kind: B.gun, tx: 52, ty: 76, dir: 0 });
  w.step();
  // a damaged complete building, so a health bar is drawn too
  const wall = w.placeBuilding(B.wall, 44, 80, true);
  const ws = w.buildings.slotForId(wall);
  w.buildings.cols.hp[ws] = w.buildings.cols.maxHp[ws]! * 0.5;
  const s = snapshotOf(w);
  const row = (id: number) => Array.prototype.indexOf.call(s.buildings.id, id) as number;
  expect(s.buildings.cols.flags[row(gun)]! & BF_UPGRADING).toBeTruthy();
  const site = s.buildings.id[Array.from(s.buildings.cols.flags.subarray(0, s.buildings.count)).findIndex((f) => isReserved(f))]!;
  expect(site).toBeDefined();
  return { w, s };
}

function drawAll() {
  const { s } = fixture();
  const { r, scene } = renderer();
  const cam = new PerspectiveCamera(45, 1440 / 900, 0.5, 1000);
  applyRig(cam, { x: 50, z: 82, distance: 14, yaw: 0 }, 0);
  draw(r, s, { cam });
  const overlays = new EntityRenderer(scene, terrain, CAPACITY);
  const interp = new Interpolator(CAPACITY);
  interp.push(s, 0);
  overlays.update({ camera: cam, viewportHeight: 900, yaw: 0, snapshot: s, aliens: interp.aliens, units: interp.units, projectiles: interp.projectiles, selection: [] });
  const meshes: InstancedMesh[] = [];
  scene.traverse((o) => {
    if (o instanceof InstancedMesh) meshes.push(o);
  });
  return { scene, meshes };
}

const matOf = (m: Mesh) => m.material as Material;

describe('run 3 criterion 8: frames and outlines are depth-tested on their own materials; health bars are not', () => {
  const { scene, meshes } = drawAll();
  // found by their materials' names (the meshes keep their overlay/… and reserved-outline names)
  const byMaterial = (name: string) => meshes.filter((m) => matOf(m).name === name);
  const frames = byMaterial('construction-frame');
  const outlines = byMaterial('reserved-outline');

  it('a real upgrade frame and a real reserved outline are drawn', () => {
    expect(frames.length).toBe(1);
    expect(outlines.length).toBe(1);
    expect((frames[0] as InstancedMesh).count, 'frame instances').toBeGreaterThan(0);
    expect((outlines[0] as InstancedMesh).count, 'outline instances').toBeGreaterThan(0);
  });

  it('each has its own material, depth-tested, no depth writes, offset towards the camera', () => {
    for (const m of [...frames, ...outlines]) {
      const mat = matOf(m);
      expect(mat.depthTest, `${mat.name} depthTest`).toBe(true);
      expect(mat.depthWrite, `${mat.name} depthWrite`).toBe(false);
      expect(mat.polygonOffset, `${mat.name} polygonOffset`).toBe(true);
      expect(mat.polygonOffsetFactor + mat.polygonOffsetUnits, `${mat.name} offset towards the camera`).toBeLessThan(0);
      // used by no other mesh in the scene
      const users = meshes.filter((x) => matOf(x) === mat);
      expect(users.length, `${mat.name} is its own`).toBe(1);
    }
    expect(matOf(frames[0]!)).not.toBe(matOf(outlines[0]!));
  });

  it('health bars stay on top (no depth test) and are drawn', () => {
    const bars = meshes.filter((m) => m.renderOrder >= 13 && m.renderOrder <= 14 && m.name.startsWith('overlay/') && !frames.includes(m));
    const drawnBars = bars.filter((m) => m.count > 0 && m.geometry.getAttribute('position').count < 64);
    expect(drawnBars.length, 'health bar back and fill drawn').toBeGreaterThanOrEqual(2);
    for (const b of drawnBars) expect(matOf(b).depthTest, `${b.name} depthTest`).toBe(false);
  });

  it('the diagnostic controls change only the overlays: depth test off and back on, one overlay hidden and shown', async () => {
    const { OVERLAY_NAMES, hideOverlay, overlayMeshes, setOverlayDepthTest } = await import('../src/render/debugRender.ts');
    expect(OVERLAY_NAMES).toEqual(['construction-frame', 'reserved-outline']);
    expect(overlayMeshes(scene, 'construction-frame')).toEqual(frames);
    expect(overlayMeshes(scene, 'reserved-outline')).toEqual(outlines);
    const before = new Map(meshes.map((m) => [m, matOf(m).depthTest]));
    expect(setOverlayDepthTest(scene, false)).toBe(2);
    for (const m of meshes) {
      const isOverlay = frames.includes(m) || outlines.includes(m);
      expect(matOf(m).depthTest, m.name).toBe(isOverlay ? false : before.get(m));
    }
    setOverlayDepthTest(scene, true);
    for (const m of meshes) expect(matOf(m).depthTest, m.name).toBe(before.get(m));
    expect(hideOverlay(scene, 'reserved-outline', true)).toBe(1);
    expect(outlines[0]!.material instanceof Array ? false : matOf(outlines[0]!).visible).toBe(false);
    expect(matOf(frames[0]!).visible).toBe(true);
    hideOverlay(scene, 'reserved-outline', false);
    expect(matOf(outlines[0]!).visible).toBe(true);
  });
});
