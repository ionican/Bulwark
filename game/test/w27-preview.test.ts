// W27: the pulsing wireframe placement preview (render/ghost.ts, render/dragPreview.ts,
// render/preview.ts), read from the scene graph.
//   1 for every building kind, the preview is the full-detail model the renderer draws for that
//     kind (the same geometry objects as the placed building's batches), drawn as wireframe, with
//     the same world bounds as a placed complete building at the same tile and direction
//   2 the wireframe's opacity pulses with real time (it is UI: no game clock involved)
//   3 validity by shape: solid outline and a tick when allowed, dashed outline and a cross when not
//   4 a 10-tile wall drag across one blocked tile: 9 tiles carry wall wireframes, 1 cross; pools
//     stable (no allocation) across 100 frames

import { describe, expect, it } from 'vitest';
import { Box3, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Scene, Vector3, type BufferGeometry, type Object3D } from 'three';
import { B, BUILDING_KINDS, buildingFootprint } from '../src/sim/kinds.ts';
import { World } from '../src/sim/world.ts';
import { DragPreview } from '../src/render/dragPreview.ts';
import { Ghost } from '../src/render/ghost.ts';
import { KIND_SPOTS } from './w24r2a-fixtures.ts';
import { drawAt, nextEpoch, renderer, snapAt, terrain } from './w24r2b-fixtures.ts';

const { r, scene } = renderer();

interface Drawn {
  geometries: Set<BufferGeometry>;
  box: Box3;
  wire: boolean;
  instances: number;
}

const _m = new Matrix4();
const _b = new Box3();

/** Geometries and world bounds of the visible meshes under `root` that `pick` accepts. */
function drawn(root: Object3D, pick: (o: Mesh) => boolean): Drawn {
  root.updateMatrixWorld(true);
  const out: Drawn = { geometries: new Set(), box: new Box3(), wire: true, instances: 0 };
  root.traverseVisible((o) => {
    if (!(o instanceof Mesh) || !pick(o)) return;
    const g = o.geometry as BufferGeometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const n = o instanceof InstancedMesh ? o.count : 1;
    if (n <= 0) return;
    out.geometries.add(g);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (!mats.every((m) => (m as MeshBasicMaterial).wireframe === true)) out.wire = false;
    for (let i = 0; i < n; i++) {
      if (o instanceof InstancedMesh) _m.fromArray(o.instanceMatrix.array as Float32Array, i * 16).premultiply(o.matrixWorld);
      else _m.copy(o.matrixWorld);
      out.box.union(_b.copy(g.boundingBox!).applyMatrix4(_m));
      out.instances++;
    }
  });
  return out;
}

/** The placed building's model meshes (no icons, outlines, overlays or the map's bare deposits). */
const isModel = (o: Mesh) =>
  !o.name.startsWith('icon/') && o.name !== 'reserved-outline' && !o.name.startsWith('overlay/') && !String(o.userData.part ?? '').startsWith('deposit/');
const isWire = (o: Mesh) => o.name === 'overlay/preview/wire';

const SPOTS: Array<[string, number, number, number]> = [...KIND_SPOTS.map(([k, x, y, d]) => [k, x, y, d ?? 0] as [string, number, number, number]), ['gate', 72, 66, 0]];

describe('W27 criterion 1: the preview is the full-detail model, as wireframe, at the placed building’s bounds', () => {
  it('covers every building kind', () => {
    expect(SPOTS.map(([k]) => k).sort()).toEqual([...BUILDING_KINDS].sort());
  });

  for (const [k, tx, ty, dir] of SPOTS) {
    it(`${k}: same geometry objects, wireframe, bounds within 0.01 tiles`, () => {
      const kind = B[k as keyof typeof B];
      const [fw, fh] = buildingFootprint(kind);
      const w = new World(1, terrain, { waves: false });
      const id = w.placeBuilding(kind, tx, ty, true, dir, fw, fh);
      expect(id, `place ${k}`).toBeGreaterThanOrEqual(0);
      drawAt(r, snapAt(w, 10), { t: 0, dt: 0, world: nextEpoch() });
      const placed = drawn(r.group, isModel);
      expect(placed.instances).toBeGreaterThan(0);

      const ui = new Scene();
      const ghost = new Ghost(ui, terrain, r);
      ghost.show(kind, tx, ty, dir, true, 0.05, 0, 0);
      const wire = drawn(ui, isWire);
      expect(wire.instances, `${k}: wireframe instances`).toBeGreaterThan(0);
      expect(wire.wire, `${k}: drawn as wireframe`).toBe(true);
      const ids = (s: Set<BufferGeometry>) => [...s].map((g) => g.uuid).sort();
      expect(ids(wire.geometries), `${k}: the placed model's geometry objects`).toEqual(ids(placed.geometries));
      for (const c of ['min', 'max'] as const)
        for (const a of ['x', 'y', 'z'] as const) expect(Math.abs(wire.box[c][a] - placed.box[c][a]), `${k}: bounds ${c}.${a}`).toBeLessThan(0.01);
      // the old simple model is gone: nothing else visible but the outline and the mark
      const others: string[] = [];
      ui.traverseVisible((o) => {
        if (o instanceof Mesh && !isWire(o) && !o.name.startsWith('overlay/preview/')) others.push(o.name || o.type);
      });
      expect(others).toEqual([]);
    });
  }
});

const wireOpacity = (root: Object3D, name = 'overlay/preview/wire'): number => {
  let op = -1;
  root.traverseVisible((o) => {
    if (op < 0 && o instanceof Mesh && o.name === name) op = (o.material as MeshBasicMaterial).opacity;
  });
  return op;
};

describe('W27 criterion 2: the wireframe pulses with real time', () => {
  it('opacity differs between two times 0.5 s apart, and cycles about once a second', () => {
    const ui = new Scene();
    const ghost = new Ghost(ui, terrain, r);
    ghost.show(B.gun, 48, 56, 0, true, 0.05, 0, 0);
    const a = wireOpacity(ui);
    ghost.update(0.5);
    const b = wireOpacity(ui);
    expect(a).toBeGreaterThan(0);
    expect(Math.abs(a - b)).toBeGreaterThan(0.2);
    const samples: number[] = [];
    for (let t = 0; t < 2; t += 0.05) {
      ghost.update(t);
      samples.push(wireOpacity(ui));
    }
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.25);
    ghost.update(1);
    expect(wireOpacity(ui)).toBeCloseTo(a, 5);
  });

  it('blocked: the wireframe holds steady (the pulse stops), so validity is also shown by motion', () => {
    const ui = new Scene();
    const ghost = new Ghost(ui, terrain, r);
    ghost.show(B.gun, 48, 56, 0, false, 0.05, 0, 0);
    const a = wireOpacity(ui);
    ghost.update(0.25);
    expect(a).toBeGreaterThan(0);
    expect(wireOpacity(ui)).toBe(a);
  });
});

describe('W27 criterion 3: validity by shape', () => {
  const visible = (root: Object3D) => {
    const names: string[] = [];
    root.traverseVisible((o) => {
      if (o instanceof Mesh && o.name.startsWith('overlay/preview/') && o.name !== 'overlay/preview/wire') names.push(o.name);
    });
    return names.sort();
  };
  it('allowed: a solid outline and a tick; blocked: a dashed outline and a cross', () => {
    const ui = new Scene();
    const ghost = new Ghost(ui, terrain, r);
    ghost.show(B.gun, 48, 56, 0, true, 0.05, 0, 0);
    expect(visible(ui)).toEqual(['overlay/preview/outline-solid', 'overlay/preview/tick']);
    ghost.show(B.gun, 48, 56, 0, false, 0.05, 0, 0);
    expect(visible(ui)).toEqual(['overlay/preview/cross', 'overlay/preview/outline-dashed']);
    ghost.hide();
    expect(visible(ui)).toEqual([]);
  });
});

describe('W27 criterion 4: the wall drag preview', () => {
  it('a 10-tile wall drag across one blocked tile: 9 tiles carry wall wireframes and 1 cross; pools stable over 100 frames', () => {
    const ui = new Scene();
    const dp = new DragPreview(ui, terrain, r);
    const build: Array<[number, number, number]> = [];
    for (let x = 50; x < 60; x++) if (x !== 55) build.push([x, 60, 0]);
    const tiles = { kind: B.wall, build, skipped: [[55, 60]] as Array<[number, number]> };
    dp.update(tiles, 0);
    ui.updateMatrixWorld(true);
    const wires: Vector3[] = [];
    let crosses = 0;
    ui.traverseVisible((o) => {
      if (!(o instanceof InstancedMesh)) return;
      const a = o.instanceMatrix.array as Float32Array;
      if (o.name === 'overlay/drag/wire') for (let i = 0; i < o.count; i++) wires.push(new Vector3(a[i * 16 + 12], a[i * 16 + 13], a[i * 16 + 14]));
      if (o.name === 'overlay/drag/skip-cross') crosses += o.count;
    });
    const tilesWith = new Set<number>();
    for (const p of wires) {
      const hit = build.find(([x, z]) => Math.abs(p.x - (x + 0.5)) <= 0.75 && Math.abs(p.z - (z + 0.5)) <= 0.75);
      if (hit) tilesWith.add(hit[0]);
      expect(Math.hypot(p.x - 55.5, p.z - 60.5), 'no wireframe on the blocked tile').toBeGreaterThan(0.45);
    }
    expect(tilesWith.size).toBe(9);
    expect(crosses).toBe(1);
    // the wire geometry is the W23 wall parts' full-detail geometry
    const wallGeos = new Set<BufferGeometry>();
    for (const p of r.parts.parts) if (p.asset === 'wall') for (const g of p.levels[0].values()) wallGeos.add(g);
    ui.traverse((o) => {
      if (o instanceof InstancedMesh && o.name === 'overlay/drag/wire' && o.count > 0) expect(wallGeos.has(o.geometry)).toBe(true);
    });
    // pulsing in step with the ghost, and nothing allocated frame to frame
    const pool = () => {
      const out: string[] = [];
      ui.traverse((o) => {
        if (o instanceof InstancedMesh) out.push(`${o.uuid}:${o.instanceMatrix.count}:${(o.instanceMatrix.array as Float32Array).length}`);
      });
      return out.join(',');
    };
    const before = pool();
    const ops = new Set<number>();
    for (let k = 1; k <= 100; k++) {
      dp.update(tiles, k * 0.016);
      ops.add(Math.round(wireOpacity(ui, 'overlay/drag/wire') * 1000));
    }
    expect(pool()).toBe(before);
    expect(ops.size).toBeGreaterThan(5);
  });
});
