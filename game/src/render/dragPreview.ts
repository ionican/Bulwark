// W25 item 7: the live preview of a build-mode drag (wall run, belt line or painted row), drawn every frame
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
// stand there (preview.ts), in step with the placement ghost, from models.ts previewRun: the run is
// laid out in one call (walls and gates through W23's autotiler, as the placed run will be drawn),
// with the plinths a placed building gets on sloping ground. The wireframes are recomputed only
// when the planned tiles change.

import { InstancedMesh, MeshBasicMaterial, type BufferGeometry, type Object3D } from 'three';
import { buildingFootprint } from '../sim/kinds.ts';
import type { Terrain } from '../sim/terrain.ts';
import { groundHeight } from './ground.ts';
import { ghostMarkGeometry, ghostOutlineGeometry } from './geometry.ts';
import type { Captured, ModelRenderer } from './models.ts';
import { WireframePool, pulseOpacity } from './preview.ts';
import { SimpleBatch } from './simpleBatch.ts';

/** What the preview draws: footprint anchors to build, tiles skipped. */
export interface DragTiles {
  kind: number;
  build: ReadonlyArray<readonly [number, number, number]>;
  skipped: ReadonlyArray<readonly [number, number]>;
}

/** Marks lie this far above the ground (tiles), over the reserved outlines (models.ts: 0.06). */
const LIFT = 0.14;

/** A pool of flat marks drawn with the placement ghost: `push(x, y, z, hx, hz)` (half extents). */
function marks(parent: Object3D, geometry: BufferGeometry, material: MeshBasicMaterial, name: string): SimpleBatch {
  const b = new SimpleBatch(geometry, material, Infinity, name);
  b.mesh.renderOrder = 16; // with the placement ghost
  parent.add(b.mesh);
  return b;
}

export class DragPreview {
  private readonly build: SimpleBatch;
  private readonly skipOutline: SimpleBatch;
  private readonly skipCross: SimpleBatch;
  private readonly terrain: Terrain;
  private readonly wire: WireframePool;
  private readonly captured: Captured[] = [];
  /** Kind and build tiles the wireframes were made for (kind, then x, z, dir per tile). */
  private planned = new Int32Array(64);
  private plannedN = -1;
  /** Tiles drawn last update (tests, __game.dragPreview). */
  shown: DragTiles | null = null;

  constructor(
    parent: Object3D,
    terrain: Terrain,
    private readonly models: ModelRenderer,
  ) {
    this.terrain = terrain;
    this.wire = new WireframePool(parent, 'overlay/drag/wire');
    const flat = new MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, toneMapped: false });
    this.build = marks(parent, ghostOutlineGeometry(true), flat, 'overlay/drag/build');
    this.skipOutline = marks(parent, ghostOutlineGeometry(false), flat, 'overlay/drag/skip');
    this.skipCross = marks(parent, ghostMarkGeometry(false), flat, 'overlay/drag/skip-cross');
  }

  /** Draws `tiles` (null: nothing). Call every frame while a drag is under way; `time` is real time in seconds (the pulse). */
  update(tiles: DragTiles | null, time = 0): void {
    this.build.begin();
    this.skipOutline.begin();
    this.skipCross.begin();
    this.shown = tiles;
    this.wires(tiles, time);
    if (tiles) {
      const [fw, fh] = buildingFootprint(tiles.kind);
      const t = this.terrain;
      for (const [tx, ty] of tiles.build) {
        const x = tx + fw / 2;
        const z = ty + fh / 2;
        this.build.push(x, groundHeight(t, x, z) + LIFT, z, fw / 2, 1, fh / 2);
      }
      // a skipped position: the dashed outline round its footprint and a cross (a painted row's
      // 2 × 2 or 3 × 3 kinds as well as a run's or line's single tiles)
      const c = Math.min(fw, fh) * 0.36;
      for (const [tx, ty] of tiles.skipped) {
        const x = tx + fw / 2;
        const z = ty + fh / 2;
        const y = groundHeight(t, x, z) + LIFT;
        this.skipOutline.push(x, y, z, fw / 2, 1, fh / 2);
        this.skipCross.push(x, y + 0.01, z, c, 1, c);
      }
    }
    this.build.commit();
    this.skipOutline.commit();
    this.skipCross.commit();
  }

  /** The wireframes of the tiles to be built: refilled only when the plan changes; the pulse every call. */
  private wires(tiles: DragTiles | null, time: number): void {
    const W = this.wire;
    const M = this.models;
    if (!tiles || tiles.build.length === 0) {
      if (this.plannedN !== 0) W.clear();
      this.plannedN = 0;
      return;
    }
    W.opacity = pulseOpacity(time);
    if (!this.samePlan(tiles)) W.fill(M.previewRun(tiles.kind, tiles.build, this.captured));
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
