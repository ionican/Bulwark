// Instanced meshes refilled from zero every frame (W21): `begin`, then `take` or `push` per
// instance, then `commit`, which uploads only the instances written. The buffers start small and
// double when a frame needs more, up to a maximum (past it an instance is dropped and `overflowed`
// set). Used by models.ts (plinths, reserved outlines), effects.ts (pulses, tracers, alien shots,
// flashes) and dragPreview.ts (outlines and crosses); preview.ts grows its wireframes with
// `growInstances`.

import { DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, type BufferGeometry, type Material } from 'three';

/**
 * Doubles `mesh`'s instance buffers (the matrices, and the colours if it has them), keeping their
 * contents, to at most `max` instances. Returns false when the mesh already holds `max`.
 */
export function growInstances(mesh: InstancedMesh, max = Infinity): boolean {
  const cap = mesh.instanceMatrix.count;
  if (cap >= max) return false;
  const n = Math.min(max, cap * 2);
  const a = new InstancedBufferAttribute(new Float32Array(n * 16), 16);
  a.setUsage(DynamicDrawUsage);
  (a.array as Float32Array).set(mesh.instanceMatrix.array as Float32Array);
  mesh.instanceMatrix = a;
  if (mesh.instanceColor) {
    const c = new InstancedBufferAttribute(new Float32Array(n * 3), 3);
    c.setUsage(DynamicDrawUsage);
    (c.array as Float32Array).set(mesh.instanceColor.array as Float32Array);
    mesh.instanceColor = c;
  }
  return true;
}

export class SimpleBatch {
  readonly mesh: InstancedMesh;
  count = 0;
  overflowed = false;

  /** `colours`: a per-instance colour attribute (written by the caller through `mesh.instanceColor`). */
  constructor(geometry: BufferGeometry, material: Material, readonly max: number, name: string, colours = false) {
    const cap = Math.min(64, max);
    this.mesh = new InstancedMesh(geometry, material, cap);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    if (colours) {
      this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.mesh.instanceColor.setUsage(DynamicDrawUsage);
    }
  }

  begin(): void {
    this.count = 0;
  }

  /** Index of the next instance (the buffers grown if needed), or −1 and `overflowed` past `max`. */
  take(): number {
    if (this.count >= this.mesh.instanceMatrix.count && !growInstances(this.mesh, this.max)) {
      this.overflowed = true;
      return -1;
    }
    return this.count++;
  }

  /** An axis-aligned instance: scale (sx, sy, sz) at (x, y, z). Returns its index, or −1. */
  push(x: number, y: number, z: number, sx: number, sy: number, sz: number): number {
    const k = this.take();
    if (k < 0) return -1;
    const a = this.mesh.instanceMatrix.array as Float32Array;
    a.fill(0, k * 16, k * 16 + 16);
    a[k * 16] = sx;
    a[k * 16 + 5] = sy;
    a[k * 16 + 10] = sz;
    a[k * 16 + 12] = x;
    a[k * 16 + 13] = y;
    a[k * 16 + 14] = z;
    a[k * 16 + 15] = 1;
    return k;
  }

  commit(): void {
    const m = this.mesh;
    const n = this.count;
    m.count = n;
    m.visible = n > 0;
    if (!n) return;
    m.instanceMatrix.clearUpdateRanges();
    m.instanceMatrix.addUpdateRange(0, n * 16);
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) {
      m.instanceColor.clearUpdateRanges();
      m.instanceColor.addUpdateRange(0, n * 3);
      m.instanceColor.needsUpdate = true;
    }
  }
}
