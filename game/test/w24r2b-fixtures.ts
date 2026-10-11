// Shared fixtures for the W24 run 2b tests (animation and effects from snapshots). Not a test file.
//
// Every assertion reads the Three.js scene graph: instance matrices of the drawn batches (by mesh
// name), and the particle buffers of the effect meshes. Nothing asks the renderer what it drew.
//
// Effect mesh names (render/effects.ts): overlay/fx/build-beam, overlay/fx/build-pulse,
// overlay/fx/reclaim-beam, overlay/fx/reclaim-pulse, overlay/fx/turret-beam, overlay/fx/tracer,
// overlay/fx/alien-shot, overlay/fx/flash, overlay/fx/smoke and overlay/fx/glow (W21 particles).

import { InstancedBufferGeometry, InstancedMesh, Mesh, type InstancedBufferAttribute, type Object3D, type PerspectiveCamera } from 'three';
import { slotOf } from '../src/sim/table.ts';
import type { Snapshot } from '../src/sim/snapshot.ts';
import type { World } from '../src/sim/world.ts';
import { ResetWatch } from '../src/render/anim.ts';
import { drawnMeshes } from '../src/render/inspect.ts';
import type { MobileView } from '../src/render/interp.ts';
import type { ModelRenderer } from '../src/render/models.ts';
import { camera, mobile, snapshotOf } from './w24r2a-fixtures.ts';

export { camera, everyKind, mobile, renderer, rowIn, rowOf, snapshotOf, terrain } from './w24r2a-fixtures.ts';

export interface Step {
  /** Effect clock: seconds since start, and this frame's advance. */
  t: number;
  dt: number;
  /** The worker's world epoch (RunnerInfo.world). */
  world?: number;
  level?: number | null;
  cam?: PerspectiveCamera;
  aliens?: MobileView;
  units?: MobileView;
  projectiles?: MobileView;
}

/** One reset detector per renderer, as main.ts's EffectClock: a new world epoch or a tick going backwards. */
const watches = new WeakMap<ModelRenderer, ResetWatch>();

/**
 * Draws one frame of snapshot `s` at effect-clock time `o.t` (culling off unless a camera is given).
 * The frame is a global reset when `o.world` or the tick says so (render/anim.ts ResetWatch).
 */
export function drawAt(r: ModelRenderer, s: Snapshot, o: Step): void {
  let watch = watches.get(r);
  if (!watch) watches.set(r, (watch = new ResetWatch()));
  r.forcedLevel = o.level === undefined ? 0 : o.level;
  r.cull = !!o.cam;
  r.update({
    camera: o.cam ?? camera(),
    viewportHeight: 900,
    yaw: 0,
    snapshot: s,
    aliens: o.aliens ?? mobile(s.aliens),
    units: o.units ?? mobile(s.units),
    projectiles: o.projectiles ?? mobile(s.projectiles),
    dt: o.dt,
    time: { t: o.t, dt: o.dt, reset: watch.check(s.tick, o.world ?? 0) },
  });
}

/** A fresh world epoch per call, so each test starts from a global reset (render/anim.ts). */
let epoch = 100;
export const nextEpoch = (): number => ++epoch;

/**
 * World matrices (16 floats each) of every drawn instance in every drawn mesh (the meshes of one
 * batch, one per material, repeat the same instances), in scene order: a whole-scene fingerprint.
 */
export function everything(root: Object3D): Float32Array[] {
  const out: Float32Array[] = [];
  for (const d of drawnMeshes(root)) for (let i = 0; i < d.count; i++) out.push(d.worlds.slice(i * 16, i * 16 + 16));
  return out;
}

/** World matrices of the instances of the first drawn instanced mesh whose userData matches `want`. */
function batchInstances(root: Object3D, want: (u: Record<string, unknown>) => boolean): Float32Array[] {
  root.updateMatrixWorld(true);
  let found: InstancedMesh | null = null;
  root.traverseVisible((o) => {
    if (!found && o instanceof InstancedMesh && o.count > 0 && want(o.userData)) found = o;
  });
  if (!found) return [];
  const m = found as InstancedMesh;
  const a = m.instanceMatrix.array as Float32Array;
  return Array.from({ length: m.count }, (_, i) => a.slice(i * 16, i * 16 + 16));
}

/** Instances of the batch of W23/kit part `part` (userData.part) at level `level`, world matrices. */
export function partInstances(root: Object3D, part: string, level = 0): Float32Array[] {
  return batchInstances(root, (u) => u.part === part && u.level === level);
}

/** Instances of the W17 batch of model `model` (userData.model), world matrices. */
export function modelInstances(root: Object3D, model: string): Float32Array[] {
  return batchInstances(root, (u) => u.model === model);
}

/** Instances in the overlay mesh named exactly `name` (effects), world matrices. */
export function fx(root: Object3D, name: string): Float32Array[] {
  root.updateMatrixWorld(true);
  const out: Float32Array[] = [];
  root.traverseVisible((o) => {
    if (!(o instanceof InstancedMesh) || o.name !== name || o.count <= 0) return;
    const a = o.instanceMatrix.array as Float32Array;
    for (let i = 0; i < o.count; i++) out.push(a.slice(i * 16, i * 16 + 16));
  });
  return out;
}

/** Live particle positions of the W21 particle mesh `overlay/fx/smoke` or `overlay/fx/glow`. */
export function particles(root: Object3D, which: 'smoke' | 'glow'): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  root.traverse((o) => {
    if (!(o instanceof Mesh) || o.name !== `overlay/fx/${which}`) return;
    const g = o.geometry as InstancedBufferGeometry;
    const p = g.getAttribute('iPos') as InstancedBufferAttribute;
    const a = p.array as Float32Array;
    for (let i = 0; i < g.instanceCount; i++) out.push([a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!]);
  });
  return out;
}

/** Largest absolute difference between two lists of matrices (Infinity if their lengths differ). */
export function diff(a: Float32Array[], b: Float32Array[]): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) for (let k = 0; k < 16; k++) d = Math.max(d, Math.abs(a[i]![k]! - b[i]![k]!));
  return d;
}

/** Points within `r` tiles (ground distance) of (x, z). */
export const near = (pts: Array<[number, number, number]>, x: number, z: number, r: number): Array<[number, number, number]> =>
  pts.filter(([px, , pz]) => Math.hypot(px - x, pz - z) <= r);

/** Unit slot of an id in a world (to edit its columns directly). */
export const slot = (id: number): number => slotOf(id);

/** Snapshot of `w` at tick `tick` (the world's tables as they stand; the tick overridden). */
export function snapAt(w: World, tick: number): Snapshot {
  const s = snapshotOf(w);
  s.tick = tick;
  return s;
}

