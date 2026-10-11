// W25 acceptance 6 (scene inspection): for the selected units the scene holds each unit's queue as
// a line from the unit through each queued target in order, with a numbered label on each target
// (its position in that unit's queue; one label listing the positions where selected units share
// an item). Nothing is drawn for unselected units. Read from the scene graph (render/queueView.ts
// inspectQueue walks the Line positions and the label sprites), never from a renderer report.

import { describe, expect, it } from 'vitest';
import { InstancedMesh, Scene } from 'three';
import { B, U } from '../src/sim/kinds.ts';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from '../src/sim/snapshot.ts';
import { QueueOverlay, inspectQueue } from '../src/render/queueView.ts';
import type { Pick } from '../src/render/picking.ts';
import { camera, mobile } from './w24r2a-fixtures.ts';
import { flatWorld } from './fixtures.ts';

function fixture() {
  const w = flatWorld(48, 48, { rich: true });
  const a = w.spawnUnit(U.engineer, 30.5, 30.5);
  const b = w.spawnUnit(U.engineer, 34.5, 30.5);
  const c = w.spawnUnit(U.engineer, 38.5, 30.5); // never selected
  w.enqueue({ t: 'build', ids: [a, b], kind: B.gun, tx: 10, ty: 10 }); // X, shared
  w.enqueue({ t: 'build', ids: [a], kind: B.gun, tx: 16, ty: 10, queue: true }); // Y
  w.enqueue({ t: 'build', ids: [a], kind: B.wall, tx: 22, ty: 12, queue: true }); // Z
  w.enqueue({ t: 'build', ids: [b], kind: B.gun, tx: 10, ty: 20, queue: true }); // W
  w.enqueue({ t: 'move', ids: [c], x: 5.5, z: 40.5 });
  w.step();
  return { w, a, b, c, snap: decodeSnapshot(encodeSnapshot(w)) };
}

function draw(o: QueueOverlay, snap: Snapshot, selection: Pick[]) {
  o.update({ camera: camera({ x: 20, z: 20, distance: 50, yaw: 0 }), viewportHeight: 900, snapshot: snap, units: mobile(snap.units), selection });
}
const pick = (id: number): Pick => ({ type: 'unit', id, kind: U.engineer });
const unitPos = (snap: Snapshot, id: number): [number, number] => {
  const r = Array.prototype.indexOf.call(snap.units.id, id);
  return [snap.units.cols.x[r]!, snap.units.cols.z[r]!];
};

describe('W25 acceptance 6: the queue drawn for the selection', () => {
  it('one unit with 3 queued items: the line goes from the unit through the 3 targets in order, labelled 1, 2, 3', () => {
    const { w, a, snap } = fixture();
    const scene = new Scene();
    const o = new QueueOverlay(scene, w.terrain);
    draw(o, snap, [pick(a)]);
    const q = inspectQueue(scene);
    expect(q.paths.length).toBe(1);
    expect(q.paths[0]!.unit).toBe(a);
    const want: Array<[number, number]> = [unitPos(snap, a), [11, 11], [17, 11], [22.5, 12.5]];
    expect(q.paths[0]!.points.length).toBe(4);
    q.paths[0]!.points.forEach(([x, z], i) => {
      expect(x, `point ${i} x`).toBeCloseTo(want[i]![0], 3);
      expect(z, `point ${i} z`).toBeCloseTo(want[i]![1], 3);
    });
    const labels = [...q.labels].sort((p, r) => p.text.localeCompare(r.text));
    expect(labels.map((l) => l.text)).toEqual(['1', '2', '3']);
    labels.forEach((l, i) => {
      expect(l.x).toBeCloseTo(want[i + 1]![0], 3);
      expect(l.z).toBeCloseTo(want[i + 1]![1], 3);
    });
    // The direction is drawn by shape: an arrowhead per target.
    expect(q.arrows).toBe(3);
  });

  it('nothing selected: no queue geometry at all', () => {
    const { w, a, snap } = fixture();
    const scene = new Scene();
    const o = new QueueOverlay(scene, w.terrain);
    draw(o, snap, [pick(a)]);
    draw(o, snap, []);
    const q = inspectQueue(scene);
    expect(q.paths).toEqual([]);
    expect(q.labels).toEqual([]);
    expect(q.arrows).toBe(0);
    let instances = 0;
    scene.traverse((n) => {
      if (n instanceof InstancedMesh && n.visible) instances += n.count;
    });
    expect(instances).toBe(0);
  });

  it('two selected units: a path each, one label on the shared item, nothing for the unselected unit', () => {
    const { w, a, b, c, snap } = fixture();
    const scene = new Scene();
    const o = new QueueOverlay(scene, w.terrain);
    draw(o, snap, [pick(a), pick(b)]);
    const q = inspectQueue(scene);
    expect(q.paths.map((p) => p.unit).sort()).toEqual([a, b].sort());
    expect(q.paths.find((p) => p.unit === b)!.points.length).toBe(3);
    expect(q.paths.some((p) => p.unit === c)).toBe(false);
    // X is first in both queues: one label "1" there; Y 2 and Z 3 are A's, W 2 is B's.
    const at = (x: number, z: number) => q.labels.filter((l) => Math.abs(l.x - x) < 1e-3 && Math.abs(l.z - z) < 1e-3).map((l) => l.text);
    expect(at(11, 11)).toEqual(['1']);
    expect(at(17, 11)).toEqual(['2']);
    expect(at(22.5, 12.5)).toEqual(['3']);
    expect(at(11, 21)).toEqual(['2']);
    expect(q.labels.length).toBe(4);
    // Nothing at C's move target.
    expect(at(5.5, 40.5)).toEqual([]);
  });

  it('a shared item at different positions lists both', () => {
    const w = flatWorld(48, 48, { rich: true });
    const a = w.spawnUnit(U.engineer, 30.5, 30.5);
    const b = w.spawnUnit(U.engineer, 34.5, 30.5);
    w.enqueue({ t: 'build', ids: [a], kind: B.gun, tx: 10, ty: 10 });
    w.enqueue({ t: 'build', ids: [a, b], kind: B.gun, tx: 16, ty: 10, queue: true });
    w.step();
    const snap = decodeSnapshot(encodeSnapshot(w));
    const scene = new Scene();
    const o = new QueueOverlay(scene, w.terrain);
    draw(o, snap, [pick(a), pick(b)]);
    const q = inspectQueue(scene);
    expect(q.labels.filter((l) => Math.abs(l.x - 17) < 1e-3).map((l) => l.text)).toEqual(['1, 2']);
  });
});
