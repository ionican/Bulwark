// Instanced drawing of W17's code-built models (buildings other than walls, gates, extractors and
// turrets; aliens; wreck debris) for W24 run 2a. A W17 model is a list of parts, each a geometry
// with one group per material placed by a pivot. Run 2a draws every model in its static pose, so
// the parts are baked once: every part's geometry is moved by its pivot, split by material and
// merged, giving one geometry per model × material. Each model × material is one InstancedMesh;
// the meshes of one model share one instance-matrix buffer and one instance-data buffer
// (glow, damage, build cut: the layout of W23's batches, read by materials.ts cutMaterial).
// Batches refill from zero each frame and grow by doubling up to a maximum per model (from the
// simulation's table capacities); past it an instance is dropped and `overflowed` is set.

import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, type Material } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ModelDef } from './workshop/models/types.ts';

export interface BakedModel {
  name: string;
  pieces: Array<{ material: Material; geometry: BufferGeometry }>;
  /** Top of the model above its origin (tiles), for the build cut. */
  height: number;
  radius: number;
  triangles: number;
}

/** Bakes a W17 model's parts (static pose: pivots only) into one geometry per material. */
export function bakeModel(def: ModelDef, scale = 1): BakedModel {
  const byMat = new Map<Material, BufferGeometry[]>();
  const s = new Matrix4().makeScale(scale, scale, scale);
  for (const part of def.parts) {
    const g0 = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
    const mats = Array.isArray(part.material) ? part.material : [part.material];
    const groups = g0.groups.length ? g0.groups : [{ start: 0, count: g0.getAttribute('position').count, materialIndex: 0 }];
    const m = new Matrix4().multiplyMatrices(s, part.pivot);
    for (const gr of groups) {
      const mat = mats[gr.materialIndex ?? 0] ?? mats[0]!;
      const sub = new BufferGeometry();
      for (const [name, attr] of Object.entries(g0.attributes)) {
        const a = attr as BufferAttribute;
        const n = a.itemSize;
        sub.setAttribute(name, new BufferAttribute((a.array as Float32Array).slice(gr.start * n, (gr.start + gr.count) * n), n, a.normalized));
      }
      sub.applyMatrix4(m);
      const list = byMat.get(mat) ?? [];
      list.push(sub);
      byMat.set(mat, list);
    }
  }
  const pieces: BakedModel['pieces'] = [];
  let triangles = 0;
  for (const [material, list] of byMat) {
    // pieces with different attribute sets cannot merge; group them by attribute signature
    const bySig = new Map<string, BufferGeometry[]>();
    for (const g of list) {
      const sig = Object.keys(g.attributes).sort().join(',');
      const l = bySig.get(sig) ?? [];
      l.push(g);
      bySig.set(sig, l);
    }
    for (const l of bySig.values()) {
      const geometry = l.length === 1 ? l[0]! : mergeGeometries(l, false)!;
      geometry.computeBoundingSphere();
      triangles += geometry.getAttribute('position').count / 3;
      pieces.push({ material, geometry });
    }
  }
  return { name: def.name, pieces, height: def.height * scale, radius: def.radius * scale, triangles };
}

class ModelBatch {
  readonly meshes: InstancedMesh[] = [];
  matrix: InstancedBufferAttribute;
  data: InstancedBufferAttribute;
  count = 0;
  cap: number;
  overflowed = false;

  constructor(
    readonly model: BakedModel,
    depth: Material,
    into: Group,
    readonly max: number,
    shadows: boolean,
    cap = 16,
  ) {
    this.cap = Math.min(cap, max);
    this.matrix = new InstancedBufferAttribute(new Float32Array(this.cap * 16), 16);
    this.matrix.setUsage(DynamicDrawUsage);
    this.data = new InstancedBufferAttribute(new Float32Array(this.cap * 3), 3);
    this.data.setUsage(DynamicDrawUsage);
    for (const { material, geometry } of model.pieces) {
      const m = new InstancedMesh(geometry, material, this.cap);
      m.instanceMatrix = this.matrix;
      m.instanceColor = this.data;
      m.name = `w17/${model.name}/${material.name}`;
      m.userData.model = model.name;
      m.castShadow = shadows;
      m.receiveShadow = true;
      m.customDepthMaterial = depth;
      m.frustumCulled = false;
      m.count = 0;
      m.visible = false;
      into.add(m);
      this.meshes.push(m);
    }
  }

  private grow(): boolean {
    if (this.cap >= this.max) return false;
    const cap = Math.min(this.max, this.cap * 2);
    const re = (a: InstancedBufferAttribute, n: number) => {
      const b = new InstancedBufferAttribute(new Float32Array(cap * n), n);
      (b.array as Float32Array).set(a.array as Float32Array);
      b.setUsage(DynamicDrawUsage);
      return b;
    };
    this.matrix = re(this.matrix, 16);
    this.data = re(this.data, 3);
    for (const m of this.meshes) {
      m.instanceMatrix = this.matrix;
      m.instanceColor = this.data;
    }
    this.cap = cap;
    return true;
  }

  push(src: ArrayLike<number>, o: number, glow: number, damage: number, cut: number): void {
    if (this.count >= this.cap && !this.grow()) {
      this.overflowed = true;
      return;
    }
    const k = this.count++;
    const a = this.matrix.array as Float32Array;
    for (let i = 0; i < 16; i++) a[k * 16 + i] = src[o + i]!;
    const d = this.data.array as Float32Array;
    d[k * 3] = glow;
    d[k * 3 + 1] = damage;
    d[k * 3 + 2] = cut;
  }

  commit(): void {
    const n = this.count;
    for (const m of this.meshes) {
      m.count = n;
      m.visible = n > 0;
    }
    if (n === 0) return;
    for (const a of [this.matrix, this.data]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }
}

export class W17Batches {
  readonly group = new Group();
  private readonly batches: ModelBatch[];

  constructor(
    readonly models: BakedModel[],
    depth: Material,
    maxOf: (model: number) => number,
    shadows: (model: number) => boolean = () => true,
  ) {
    this.group.name = 'w17-models';
    this.batches = models.map((m, i) => new ModelBatch(m, depth, this.group, maxOf(i), shadows(i)));
  }

  begin(): void {
    for (const b of this.batches) b.count = 0;
  }

  /** One instance of model `i`: 16 floats of `src` from `o` (column-major). */
  push(i: number, src: ArrayLike<number>, o = 0, glow = 1, damage = 0, cut = 1e4): void {
    this.batches[i]!.push(src, o, glow, damage, cut);
  }

  commit(): void {
    for (const b of this.batches) b.commit();
  }

  get overflowed(): boolean {
    return this.batches.some((b) => b.overflowed);
  }

  get drawCalls(): number {
    let n = 0;
    for (const b of this.batches) if (b.count > 0) n += b.meshes.length;
    return n;
  }
}
