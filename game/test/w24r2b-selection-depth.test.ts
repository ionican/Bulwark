// W24 sandbox (Richard, 2026-10-09, screenshot): the yellow selection brackets of a unit standing
// behind a turret drew on top of the turret, because the markers shared the strategic icons'
// material, which has depth testing off. The selection markers get their own material with depth
// testing on (depth writes still off, same draw order), so buildings and terrain in front hide them;
// the strategic icons keep theirs.

import { describe, expect, it } from 'vitest';
import { InstancedMesh, MeshBasicMaterial, PerspectiveCamera, Scene, type BufferGeometry } from 'three';
import { CAPACITY } from '../src/sim/world.ts';
import { U } from '../src/sim/kinds.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { EntityRenderer } from '../src/render/entities.ts';
import { selectionMarkerGeometry } from '../src/render/geometry.ts';
import { Interpolator } from '../src/render/interp.ts';
import { applyRig } from '../src/render/cameraRig.ts';
import { flatWorld } from './fixtures.ts';

const same = (a: BufferGeometry, b: BufferGeometry) =>
  (a.getAttribute('position').array as Float32Array).join(',') === (b.getAttribute('position').array as Float32Array).join(',');

/** A flat world with one selected engineer, drawn once; the scene and the drawn meshes. */
function selectedEngineer() {
  const w = flatWorld(40, 40);
  const id = w.spawnUnit(U.engineer, 20.5, 20.5);
  const snap = decodeSnapshot(encodeSnapshot(w));
  const scene = new Scene();
  const renderer = new EntityRenderer(scene, w.terrain, CAPACITY);
  const interp = new Interpolator(CAPACITY);
  interp.push(snap, 0);
  const camera = new PerspectiveCamera(60, 1, 0.5, 2000);
  applyRig(camera, { x: 20, z: 20, distance: 30, yaw: 0 }, 0);
  camera.updateMatrixWorld();
  renderer.update({ camera, viewportHeight: 900, yaw: 0, snapshot: snap, aliens: interp.aliens, units: interp.units, projectiles: interp.projectiles, selection: [{ type: 'unit', id, kind: U.engineer }] });
  const meshes: InstancedMesh[] = [];
  scene.traverse((o) => {
    if (o instanceof InstancedMesh) meshes.push(o);
  });
  return meshes;
}

describe('the selection markers are hidden by what stands in front of them', () => {
  it('overlays: the marker material tests depth', () => {
    const meshes = selectedEngineer();
    const marker = selectionMarkerGeometry();
    const markers = meshes.filter((m) => same(m.geometry, marker));
    expect(markers.length, 'one selection marker mesh').toBe(1);
    const m = markers[0]!;
    expect(m.count, 'the selected engineer is marked').toBe(1);
    const mat = m.material as MeshBasicMaterial;
    expect(mat.depthTest, 'marker depthTest').toBe(true);
    expect(mat.depthWrite, 'marker depthWrite').toBe(false);
    expect(m.renderOrder, 'marker draw order').toBe(15);
    expect(mat.vertexColors, 'marker vertex colours').toBe(true);
  });
});
