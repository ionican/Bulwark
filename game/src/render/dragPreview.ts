// W25 item 7: the live preview of a build-mode drag (wall run or belt line), drawn every frame
// while the button is down, as W23's painter does (look/src/w23/painter.ts). The tiles come from
// dragPlan.ts (the simulation's own planner, run on the latest snapshot); this module only draws.
//
// Told apart by shape, never colour alone (Richard is colour-blind): a tile that will be built gets
// the placement ghost's solid outline (ghost.ts); a tile that will be skipped gets the dashed
// outline and a cross. Pooled instanced meshes, filled from zero each frame and grown only when a
// longer drag needs more; nothing else is allocated per frame. Names `overlay/drag/…`, so the model
// inspection counts them as overlays; inspectDrag reads them back from the scene.
//
// W27 (models view): each tile that will be built also carries the pulsing wireframe of what will
// stand there (preview.ts), in step with the placement ghost. A wall run is laid out with W23's
// autotiler as one run (a scratch wall layout of the planned tiles), so the wireframes are the
// wall parts the run will be drawn with; other kinds use models.ts previewBuilding per tile. The
// wireframes are recomputed only when the planned tiles change.

import { InstancedMesh, MeshBasicMaterial, type BufferGeometry, type Object3D } from 'three';
import { B, buildingFootprint } from '../sim/kinds.ts';
import type { Terrain } from '../sim/terrain.ts';
import { groundHeight } from './ground.ts';
import { ghostMarkGeometry, ghostOutlineGeometry } from './geometry.ts';
import { rowsOfPlan, type Captured, type ModelRenderer } from './models.ts';
import { WireframePool, pulseOpacity } from './preview.ts';
import { WallLayout } from './wallLayout.ts';

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
  private readonly wire: WireframePool | null;
  private walls: WallLayout | null = null;
  private readonly captured: Captured[] = [];
  /** Kind and build tiles the wireframes were made for (kind, then x, z, dir per tile). */
  private planned = new Int32Array(64);
  private plannedN = -1;
  /** Tiles drawn last update (tests, __game.dragPreview). */
  shown: DragTiles | null = null;

  constructor(
    parent: Object3D,
    terrain: Terrain,
    private readonly models: ModelRenderer | null = null,
  ) {
    this.terrain = terrain;
    this.wire = models ? new WireframePool(parent, 'overlay/drag/wire') : null;
    const flat = new MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, toneMapped: false });
    this.build = new Pool(parent, ghostOutlineGeometry(true), flat, 'overlay/drag/build');
    this.skipOutline = new Pool(parent, ghostOutlineGeometry(false), flat, 'overlay/drag/skip');
    this.skipCross = new Pool(parent, ghostMarkGeometry(false), flat, 'overlay/drag/skip-cross');
  }

  /** Draws `tiles` (null: nothing). Call every frame while a drag is under way; `time` is real time in seconds (the pulse). */
  update(tiles: DragTiles | null, time = 0): void {
    for (const p of [this.build, this.skipOutline, this.skipCross]) p.reset();
    this.shown = tiles;
    this.wires(tiles, time);
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

  /** The wireframes of the tiles to be built: refilled only when the plan changes; the pulse every call. */
  private wires(tiles: DragTiles | null, time: number): void {
    const W = this.wire;
    const M = this.models;
    if (!W || !M) return;
    if (!tiles || tiles.build.length === 0) {
      if (this.plannedN !== 0) W.clear();
      this.plannedN = 0;
      return;
    }
    W.opacity = pulseOpacity(time);
    if (this.samePlan(tiles)) return;
    if (tiles.kind === B.wall) {
      // one run through W23's autotiler: the parts the placed run will be drawn with
      const walls = (this.walls ??= new WallLayout(this.terrain));
      walls.update(rowsOfPlan(tiles.build.map(([x, z]) => [x, z] as const), B.wall));
      W.begin();
      for (const [x, z] of tiles.build) {
        const tile = z * this.terrain.w + x;
        const first = walls.first[tile]!;
        const n = walls.count[tile]!;
        for (let k = 0; k < n; k++)
          for (const g of M.parts.get(walls.parts[first + k]!).levels[0].values()) W.push(g, walls.matrices, (first + k) * 16);
      }
      W.commit();
      return;
    }
    W.begin();
    for (const [x, z, dir] of tiles.build) {
      M.previewBuilding(tiles.kind, x, z, dir, this.captured);
      for (const c of this.captured) W.push(c.geometry, c.matrix);
    }
    W.commit();
  }

  /** True when `tiles` plans the same kind and build tiles as the wireframes drawn; else records them. */
  private samePlan(tiles: DragTiles): boolean {
    const n = 1 + tiles.build.length * 3;
    let same = n === this.plannedN && this.planned[0] === tiles.kind;
    if (same)
      for (let i = 0; i < tiles.build.length && same; i++) {
        const t = tiles.build[i]!;
        same = this.planned[1 + i * 3] === t[0] && this.planned[2 + i * 3] === t[1] && this.planned[3 + i * 3] === t[2];
      }
    if (same) return true;
    if (this.planned.length < n) this.planned = new Int32Array(n * 2);
    this.planned[0] = tiles.kind;
    tiles.build.forEach((t, i) => {
      this.planned[1 + i * 3] = t[0];
      this.planned[2 + i * 3] = t[1];
      this.planned[3 + i * 3] = t[2];
    });
    this.plannedN = n;
    return false;
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
