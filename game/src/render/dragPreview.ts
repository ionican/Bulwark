// W25 item 7: the live preview of a build-mode drag (wall run or belt line), drawn every frame
// while the button is down, as W23's painter does (look/src/w23/painter.ts). The tiles come from
// dragPlan.ts (the simulation's own planner, run on the latest snapshot); this module only draws.
//
// Told apart by shape, never colour alone (Richard is colour-blind): a tile that will be built gets
// the placement ghost's solid outline (ghost.ts); a tile that will be skipped gets the dashed
// outline and a cross. Pooled instanced meshes, filled from zero each frame and grown only when a
// longer drag needs more; nothing else is allocated per frame. Names `overlay/drag/…`, so the model
// inspection counts them as overlays; inspectDrag reads them back from the scene.

import { InstancedMesh, MeshBasicMaterial, type BufferGeometry, type Object3D } from 'three';
import { buildingFootprint } from '../sim/kinds.ts';
import type { Terrain } from '../sim/terrain.ts';
import { groundHeight } from './ground.ts';
import { ghostMarkGeometry, ghostOutlineGeometry } from './geometry.ts';

/** What the preview draws: footprint anchors to build, tiles skipped. */
export interface DragTiles {
  kind: number;
  build: ReadonlyArray<readonly [number, number, number]>;
  skipped: ReadonlyArray<readonly [number, number]>;
}

/** Marks lie this far above the ground (tiles), over the reserved outlines (models.ts: 0.06). */
const LIFT = 0.14;

class Pool {
  mesh: InstancedMesh;
  private n = 0;
  constructor(
    private readonly parent: Object3D,
    private readonly geometry: BufferGeometry,
    private readonly material: MeshBasicMaterial,
    private readonly name: string,
  ) {
    this.mesh = this.make(128);
  }
  private make(cap: number): InstancedMesh {
    const m = new InstancedMesh(this.geometry, this.material, cap);
    m.name = this.name;
    m.frustumCulled = false;
    m.renderOrder = 16; // with the placement ghost
    m.count = 0;
    m.visible = false;
    this.parent.add(m);
    return m;
  }
  reset() {
    this.n = 0;
  }
  /** A flat mark centred on (x, z), half extents (hx, hz). */
  push(x: number, y: number, z: number, hx: number, hz: number) {
    if (this.n >= this.mesh.instanceMatrix.count) {
      const old = this.mesh;
      this.mesh = this.make(old.instanceMatrix.count * 2);
      (this.mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
      old.removeFromParent();
      old.dispose();
    }
    const a = this.mesh.instanceMatrix.array as Float32Array;
    const o = this.n++ * 16;
    a.fill(0, o, o + 16);
    a[o] = hx;
    a[o + 5] = 1;
    a[o + 10] = hz;
    a[o + 12] = x;
    a[o + 13] = y;
    a[o + 14] = z;
    a[o + 15] = 1;
  }
  commit() {
    const m = this.mesh;
    m.count = this.n;
    m.visible = this.n > 0;
    if (this.n > 0) {
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, this.n * 16);
      m.instanceMatrix.needsUpdate = true;
    }
  }
}

export class DragPreview {
  private readonly build: Pool;
  private readonly skipOutline: Pool;
  private readonly skipCross: Pool;
  private readonly terrain: Terrain;
  /** Tiles drawn last update (tests, __game.dragPreview). */
  shown: DragTiles | null = null;

  constructor(parent: Object3D, terrain: Terrain) {
    this.terrain = terrain;
    const flat = new MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, toneMapped: false });
    this.build = new Pool(parent, ghostOutlineGeometry(true), flat, 'overlay/drag/build');
    this.skipOutline = new Pool(parent, ghostOutlineGeometry(false), flat, 'overlay/drag/skip');
    this.skipCross = new Pool(parent, ghostMarkGeometry(false), flat, 'overlay/drag/skip-cross');
  }

  /** Draws `tiles` (null: nothing). Call every frame while a drag is under way. */
  update(tiles: DragTiles | null): void {
    for (const p of [this.build, this.skipOutline, this.skipCross]) p.reset();
    this.shown = tiles;
    if (tiles) {
      const [fw, fh] = buildingFootprint(tiles.kind);
      const t = this.terrain;
      for (const [tx, ty] of tiles.build) {
        const x = tx + fw / 2;
        const z = ty + fh / 2;
        this.build.push(x, groundHeight(t, x, z) + LIFT, z, fw / 2, fh / 2);
      }
      for (const [tx, ty] of tiles.skipped) {
        const x = tx + 0.5;
        const z = ty + 0.5;
        const y = groundHeight(t, x, z) + LIFT;
        this.skipOutline.push(x, y, z, 0.5, 0.5);
        this.skipCross.push(x, y + 0.01, z, 0.36, 0.36);
      }
    }
    for (const p of [this.build, this.skipOutline, this.skipCross]) p.commit();
  }
}

/** The preview as drawn: ground centres (x, z) of the build outlines and of the skipped crosses. */
export function inspectDrag(root: Object3D): { build: Array<[number, number]>; skipped: Array<[number, number]> } {
  const out = { build: [] as Array<[number, number]>, skipped: [] as Array<[number, number]> };
  root.traverseVisible((o) => {
    if (!(o instanceof InstancedMesh)) return;
    const list = o.name === 'overlay/drag/build' ? out.build : o.name === 'overlay/drag/skip-cross' ? out.skipped : null;
    if (!list) return;
    const a = o.instanceMatrix.array as Float32Array;
    for (let i = 0; i < o.count; i++) list.push([a[i * 16 + 12]!, a[i * 16 + 14]!]);
  });
  return out;
}
