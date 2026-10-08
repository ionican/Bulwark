// W23 instanced drawing: one batch per part × material × level, shared by every object that uses the
// part (W22's strategy B). All materials of one part level share one instance-matrix buffer and one
// instance-data buffer (glow, damage, build cut: mats.ts), so a part instance is written once
// however many materials it has. Batches refill from zero each frame (W21), so moving parts, level
// changes and new objects need no bookkeeping.

import { DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, type Matrix4 } from 'three';
import { SHADOW_KEYS, type AssetMats, BUILT } from './mats.ts';
import type { AssetKind } from './lod.ts';
import type { MatKey, PartDef } from './parts.ts';

class Batch {
  readonly meshes: InstancedMesh[] = [];
  matrix: InstancedBufferAttribute;
  data: InstancedBufferAttribute;
  count = 0;
  cap: number;

  constructor(
    readonly part: PartDef,
    readonly level: number,
    mats: AssetMats,
    into: Group,
    cap = 32,
  ) {
    this.cap = cap;
    this.matrix = new InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    this.matrix.setUsage(DynamicDrawUsage);
    this.data = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.data.setUsage(DynamicDrawUsage);
    for (const [key, geo] of part.levels[level as 0 | 1 | 2]) {
      const m = new InstancedMesh(geo, mats.byKey[key as MatKey], cap);
      m.instanceMatrix = this.matrix;
      m.instanceColor = this.data;
      m.name = `${part.id}/${['full', 'middle', 'simple'][level]}/${key}`;
      m.castShadow = part.shadow && level <= 1 && SHADOW_KEYS.has(key as MatKey);
      m.receiveShadow = true;
      m.customDepthMaterial = mats.depth;
      m.frustumCulled = false;
      m.count = 0;
      m.visible = false;
      into.add(m);
      this.meshes.push(m);
    }
  }

  private grow(): void {
    const cap = this.cap * 2;
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
      // InstancedMesh keeps its own count limit from construction; raise it
      (m as unknown as { count: number }).count = 0;
    }
    this.cap = cap;
  }

  push(m: Matrix4 | Float32Array, mo: number, glow: number, damage: number, cut: number): void {
    if (this.count >= this.cap) this.grow();
    const k = this.count++;
    const a = this.matrix.array as Float32Array;
    const isMat = !(m instanceof Float32Array);
    const src = isMat ? (m as Matrix4).elements : m;
    const o = isMat ? 0 : mo;
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

export interface AssetLevelStats {
  /** Objects drawn at each level (filled by the caller through count()). */
  objects: [number, number, number, number];
  /** Triangles submitted at each level. */
  tris: [number, number, number, number];
}

export class PartBatches {
  readonly group = new Group();
  private batches: Array<Array<Batch | null>>;
  private live: Batch[] = [];
  readonly stats = new Map<AssetKind, AssetLevelStats>();

  constructor(
    readonly parts: PartDef[],
    mats: AssetMats,
  ) {
    this.group.name = 'w23-parts';
    this.batches = parts.map((p) => [0, 1, 2].map((lv) => (p.levels[lv as 0 | 1 | 2].size ? new Batch(p, lv, mats, this.group) : null)));
  }

  begin(): void {
    for (const b of this.live) b.count = 0;
    this.live.length = 0;
    for (const s of this.stats.values()) {
      s.objects.fill(0);
      s.tris.fill(0);
    }
  }

  private stat(kind: AssetKind): AssetLevelStats {
    let s = this.stats.get(kind);
    if (!s) {
      s = { objects: [0, 0, 0, 0], tris: [0, 0, 0, 0] };
      this.stats.set(kind, s);
    }
    return s;
  }

  /** Counts one object of an asset kind at a level (for the readout). */
  count(kind: AssetKind, level: number, tris = 0): void {
    const s = this.stat(kind);
    s.objects[level]!++;
    s.tris[level]! += tris;
  }

  /** One part instance. `m` is a Matrix4 or 16 floats at offset `mo`. */
  push(part: PartDef, level: number, m: Matrix4 | Float32Array, mo = 0, glow = 1, damage = 0, cut = BUILT): void {
    const b = this.batches[part.index]![level];
    if (!b) return;
    if (b.count === 0) this.live.push(b);
    b.push(m, mo, glow, damage, cut);
    this.stat(part.asset).tris[level]! += part.tris[level as 0 | 1 | 2];
  }

  commit(): void {
    for (const row of this.batches) for (const b of row) if (b) b.commit();
  }

  /** Batches with instances this frame (scene-pass draw calls of the parts). */
  get drawCalls(): number {
    let n = 0;
    for (const b of this.live) n += b.meshes.length;
    return n;
  }

  get batchCount(): number {
    let n = 0;
    for (const row of this.batches) for (const b of row) if (b) n += b.meshes.length;
    return n;
  }

  /** Every mesh drawable with one instance, to compile programs up front. */
  prime(on: boolean): void {
    for (const row of this.batches)
      for (const b of row)
        if (b)
          for (const m of b.meshes) {
            m.count = on ? 1 : 0;
            m.visible = on;
          }
  }
}
