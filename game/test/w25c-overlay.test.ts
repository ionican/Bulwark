// W25c finding 2 (Codex adversarial review, 9 Oct, high): the queue overlay's cost was unbounded.
// Every frame it expanded every selected path into one instance per dash, off-screen sections
// included, and made a label per move: 256 units × 64 orders came to 6.66 M instances, 514 MiB and
// about 164 ms per update.
// Required: dashes drawn by a shader (a bounded number of segment pieces), clipped to the viewport,
// geometry cached while the queues, selection and camera are unchanged, at most 200 labels with a
// "+N more" note, and a hard cap on the instances the overlay may create. Target (Node CPU here;
// the browser figures are scripts/check-queue.mjs's): 40 engineers × 64 orders at the game camera,
// ≤ 1 ms per update when nothing changed, ≤ 5 ms on a change; 256 × 64 within the caps, no freeze.

import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Scene, Sprite, Vector3, type Object3D, type PerspectiveCamera } from 'three';
import { U } from '../src/sim/kinds.ts';
import { World } from '../src/sim/world.ts';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from '../src/sim/snapshot.ts';
import { map1Terrain } from '../src/sim/terrain.ts';
import * as QV from '../src/render/queueView.ts';
import type { Pick } from '../src/render/picking.ts';
import { camera, mobile } from './w24r2a-fixtures.ts';

const { QueueOverlay, inspectQueue } = QV;
const CAP = (QV as unknown as { QUEUE_MAX_INSTANCES?: number }).QUEUE_MAX_INSTANCES;
const terrain = map1Terrain();
const GAME_CAMERA = { x: 64, z: 62, distance: 50, yaw: 0 };

/** `n` engineers round the base, each with 64 queued moves spread over the whole map (seeded). */
function queues(n: number, seed = 1): { w: World; ids: number[]; snap: Snapshot } {
  const w = new World(1, terrain, { waves: false });
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(w.spawnUnit(U.engineer, 50.5 + (i % 16) * 2, 50.5 + Math.floor(i / 16) * 2));
  let s = seed * 2654435761;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 2 ** 32);
  for (const id of ids) for (let k = 0; k < 64; k++) w.enqueue({ t: 'move', ids: [id], x: 2.5 + rnd() * 123, z: 2.5 + rnd() * 123, queue: true });
  w.step();
  return { w, ids, snap: decodeSnapshot(encodeSnapshot(w)) };
}
const picks = (ids: number[]): Pick[] => ids.map((id) => ({ type: 'unit', id, kind: U.engineer }));

function instancedMeshes(root: Object3D): InstancedMesh[] {
  const out: InstancedMesh[] = [];
  root.traverse((o) => {
    if (o instanceof InstancedMesh) out.push(o);
  });
  return out;
}
/** Instances the overlay has allocated (buffer capacity) and submitted (count of visible meshes). */
function instances(root: Object3D): { allocated: number; drawn: number } {
  let allocated = 0;
  let drawn = 0;
  for (const m of instancedMeshes(root)) {
    allocated += m.instanceMatrix.count;
    if (m.visible) drawn += m.count;
  }
  return { allocated, drawn };
}
/** Versions of every instance buffer and attribute under the overlay (unchanged = nothing re-uploaded). */
function versions(root: Object3D): number[] {
  const out: number[] = [];
  for (const m of instancedMeshes(root)) {
    out.push(m.instanceMatrix.version);
    for (const a of Object.values(m.geometry.attributes)) out.push((a as { version: number }).version);
  }
  return out;
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;

/** Instances whose position is off the screen by more than half a screen, or behind the camera. */
function offScreen(root: Object3D, cam: PerspectiveCamera): number {
  const m = new Matrix4();
  const p = new Vector3();
  let n = 0;
  for (const mesh of instancedMeshes(root)) {
    if (!mesh.visible) continue;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      p.setFromMatrixPosition(m).applyMatrix4(cam.matrixWorldInverse);
      if (p.z > 0) {
        n++;
        continue;
      }
      p.applyMatrix4(cam.projectionMatrix);
      if (Math.abs(p.x) > 1.5 || Math.abs(p.y) > 1.5) n++;
    }
  }
  return n;
}

describe('W25c finding 2: the queue overlay is bounded, clipped and cached', () => {
  const forty = queues(40);
  const worst = queues(256);

  it('40 engineers × 64 orders: within the instance cap, every instance on screen, at most 200 labels and a "+N more" note', () => {
    const scene = new Scene();
    const o = new QueueOverlay(scene, terrain);
    const cam = camera(GAME_CAMERA);
    o.update({ camera: cam, viewportHeight: 900, snapshot: forty.snap, units: mobile(forty.snap.units), selection: picks(forty.ids) });
    const got = instances(scene);
    expect(CAP, 'QUEUE_MAX_INSTANCES').toBeTypeOf('number');
    expect(CAP!).toBeLessThanOrEqual(65_536);
    expect(got.allocated).toBeLessThanOrEqual(CAP!);
    expect(got.drawn).toBeGreaterThan(0);
    expect(offScreen(scene, cam)).toBe(0);
    const q = inspectQueue(scene);
    expect(q.labels.length).toBeLessThanOrEqual(200);
    expect(q.paths.length).toBe(40);
    const more: string[] = [];
    scene.traverseVisible((s) => {
      if (s instanceof Sprite && s.name === 'queue/more') more.push(String(s.userData.text));
    });
    expect(more.length).toBe(1);
    expect(more[0]).toMatch(/^\+\d+ more$/);
  });

  it('40 × 64: an unchanged frame re-uploads nothing and costs ≤ 1 ms; a change costs ≤ 5 ms (median CPU, Node)', () => {
    const scene = new Scene();
    const o = new QueueOverlay(scene, terrain);
    const cam = camera(GAME_CAMERA);
    const units = mobile(forty.snap.units);
    const sel = picks(forty.ids);
    const frame = (snap = forty.snap, selection = sel) => o.update({ camera: cam, viewportHeight: 900, snapshot: snap, units, selection });
    frame();
    const v0 = versions(scene);
    frame();
    expect(versions(scene)).toEqual(v0);
    const still: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      frame();
      still.push(performance.now() - t0);
    }
    // a change: the selection alternates between all 40 and the first 39 (each frame rebuilds)
    const fewer = sel.slice(0, 39);
    const changed: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      frame(forty.snap, i % 2 ? sel : fewer);
      changed.push(performance.now() - t0);
    }
    console.log(`W25c overlay 40×64 (Node): unchanged median ${median(still).toFixed(3)} ms, changed median ${median(changed).toFixed(3)} ms, max ${Math.max(...changed).toFixed(3)} ms; ${instances(scene).drawn} instances drawn`);
    expect(median(still)).toBeLessThanOrEqual(1);
    expect(median(changed)).toBeLessThanOrEqual(5);
  });

  it('256 × 64 (the review probe): within the caps and no freeze', () => {
    const scene = new Scene();
    const o = new QueueOverlay(scene, terrain);
    const cam = camera(GAME_CAMERA);
    const t0 = performance.now();
    o.update({ camera: cam, viewportHeight: 900, snapshot: worst.snap, units: mobile(worst.snap.units), selection: picks(worst.ids) });
    const ms = performance.now() - t0;
    const got = instances(scene);
    const q = inspectQueue(scene);
    console.log(`W25c overlay 256×64 (Node): first update ${ms.toFixed(1)} ms; ${got.allocated} instances allocated, ${got.drawn} drawn; ${q.labels.length} labels`);
    expect(got.allocated).toBeLessThanOrEqual(CAP ?? 0);
    expect(q.labels.length).toBeLessThanOrEqual(200);
    expect(offScreen(scene, cam)).toBe(0);
    expect(ms).toBeLessThan(100);
  });
});
