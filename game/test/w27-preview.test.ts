// W27: the pulsing wireframe placement preview (render/ghost.ts, render/dragPreview.ts,
// render/preview.ts), read from the scene graph.
//   1 for every building kind, the preview is drawn as line segments (feature edges, not a
//     triangle wireframe) of the low-detail level the renderer draws for that kind (W27b, Richard
//     2026-10-09: "could do with less detail"; models.ts previewLevel), with the world bounds of a
//     placed complete building at the same tile and direction within 0.05 tiles, and fewer line
//     vertices than the old full-detail wireframe for every turret kind
//   2 the wireframe's opacity pulses with real time (it is UI: no game clock involved)
//   3 validity by shape: solid outline and a tick when allowed, dashed outline and a cross when not
//   4 a 10-tile wall drag across one blocked tile: 9 tiles carry wall wireframes, 1 cross; pools
//     stable (no allocation) across 100 frames

import { describe, expect, it } from 'vitest';
import { Box3, InstancedMesh, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, Scene, Vector3, type BufferGeometry, type Object3D } from 'three';
import { B, BUILDING_KINDS, buildingFootprint } from '../src/sim/kinds.ts';
import { World } from '../src/sim/world.ts';
import { DragPreview } from '../src/render/dragPreview.ts';
import { Ghost } from '../src/render/ghost.ts';
import { TURRET_KINDS, previewLevel } from '../src/render/models.ts';
import { BLOCKED_COLOUR, inspectPreview } from '../src/render/preview.ts';
import { KIND_SPOTS } from './w24r2a-fixtures.ts';
import { drawAt, nextEpoch, renderer, snapAt, terrain } from './w24r2b-fixtures.ts';

const { r } = renderer();

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

const SPOTS: Array<[string, number, number, number]> = [...KIND_SPOTS.map(([k, x, y, d]) => [k, x, y, d ?? 0] as [string, number, number, number]), ['gate', 72, 66, 0]];

/** The preview's line segments under `root` named `name`: the source geometries' uuids, the world points drawn, and whether any wire is a triangle mesh. */
function lines(root: Object3D, name: string): { sources: string[]; points: Vector3[]; box: Box3; meshes: number; material: boolean } {
  root.updateMatrixWorld(true);
  const out = { sources: [] as string[], points: [] as Vector3[], box: new Box3(), meshes: 0, material: true };
  root.traverseVisible((o) => {
    if (o.name !== name) return;
    if (o instanceof Mesh) out.meshes++;
    if (!(o instanceof LineSegments)) return;
    if (!(o.material instanceof LineBasicMaterial)) out.material = false;
    out.sources.push(...((o.userData.sources as string[]) ?? []));
    const a = o.geometry.attributes.position!.array as Float32Array;
    const { start, count } = o.geometry.drawRange;
    for (let i = start; i < start + Math.min(count, a.length / 3 - start); i++) {
      const p = new Vector3(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]).applyMatrix4(o.matrixWorld);
      out.points.push(p);
      out.box.expandByPoint(p);
    }
  });
  return out;
}

/** Triangles of a geometry (three.js draws `wireframe: true` as 6 line vertices per triangle). */
const triangles = (g: BufferGeometry) => Math.floor((g.index ? g.index.count : g.attributes.position!.count) / 3);

describe('W27 criterion 1 (W27b): the preview is the low-detail model as feature-edge lines, at the placed building’s bounds', () => {
  it('covers every building kind', () => {
    expect(SPOTS.map(([k]) => k).sort()).toEqual([...BUILDING_KINDS].sort());
  });

  for (const [k, tx, ty, dir] of SPOTS) {
    it(`${k}: line segments of the preview level's geometry, bounds within 0.05 tiles`, () => {
      const kind = B[k as keyof typeof B];
      const [fw, fh] = buildingFootprint(kind);
      const w = new World(1, terrain, { waves: false });
      const id = w.placeBuilding(kind, tx, ty, true, dir, fw, fh);
      expect(id, `place ${k}`).toBeGreaterThanOrEqual(0);
      const level = previewLevel(kind);
      expect([0, 1, 2], `${k}: preview level`).toContain(level);
      // the placed building at full detail (its bounds) and at the preview's level (its geometries)
      drawAt(r, snapAt(w, 10), { t: 0, dt: 0, world: nextEpoch(), level: 0 });
      const full = drawn(r.group, isModel);
      expect(full.instances).toBeGreaterThan(0);
      drawAt(r, snapAt(w, 11), { t: 0, dt: 0, world: nextEpoch(), level });
      const atLevel = drawn(r.group, isModel);

      const ui = new Scene();
      const ghost = new Ghost(ui, terrain, r);
      ghost.show(kind, tx, ty, dir, true, 0.05, 0, 0);
      const wire = lines(ui, 'overlay/preview/wire');
      expect(wire.meshes, `${k}: no triangle wireframe mesh`).toBe(0);
      expect(wire.points.length, `${k}: line vertices`).toBeGreaterThan(0);
      expect(wire.points.length % 2, `${k}: segments (pairs of vertices)`).toBe(0);
      expect(wire.material, `${k}: line material`).toBe(true);
      const ids = (s: Iterable<BufferGeometry>) => [...new Set([...s].map((g) => g.uuid))].sort();
      expect([...new Set(wire.sources)].sort(), `${k}: the geometry objects of the placed model at level ${level}`).toEqual(ids(atLevel.geometries));
      for (const c of ['min', 'max'] as const)
        for (const a of ['x', 'y', 'z'] as const) expect(Math.abs(wire.box[c][a] - full.box[c][a]), `${k}: bounds ${c}.${a}`).toBeLessThan(0.05);
      // nothing else visible but the outline and the mark
      const others: string[] = [];
      ui.traverseVisible((o) => {
        if ((o instanceof Mesh || o instanceof LineSegments) && o.name !== 'overlay/preview/wire' && !o.name.startsWith('overlay/preview/')) others.push(o.name || o.type);
      });
      expect(others).toEqual([]);
    });
  }

  it('every turret kind draws fewer line vertices than the old full-detail triangle wireframe', () => {
    const counts: string[] = [];
    for (const kind of TURRET_KINDS.keys()) {
      const [k, tx, ty, dir] = SPOTS.find(([name]) => B[name as keyof typeof B] === kind)!;
      const before = r.previewRun(kind, [[tx, ty, dir]], [], 0).reduce((n, c) => n + 6 * triangles(c.geometry), 0);
      const ui = new Scene();
      new Ghost(ui, terrain, r).show(kind, tx, ty, dir, true, 0.05, 0, 0);
      const after = lines(ui, 'overlay/preview/wire').points.length;
      counts.push(`${k} ${before} → ${after}`);
      expect(after, `${k}: preview line vertices`).toBeGreaterThan(0);
      expect(after, `${k}: line vertices ${before} → ${after}`).toBeLessThan(before);
    }
    process.stdout.write(`W27b turret line vertices (full-detail wireframe → preview edges): ${counts.join(', ')}\n`);
  });
});

const wireOpacity = (root: Object3D, name = 'overlay/preview/wire'): number => {
  let op = -1;
  root.traverseVisible((o) => {
    if (op < 0 && (o instanceof Mesh || o instanceof LineSegments) && o.name === name) op = (o.material as MeshBasicMaterial | LineBasicMaterial).opacity;
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

  it('blocked: the wireframe is drawn red, a different colour from the allowed one (shape cues kept)', () => {
    const ui = new Scene();
    const ghost = new Ghost(ui, terrain, r);
    ghost.show(B.gun, 48, 56, 0, true, 0.05, 0, 0);
    const allowed = inspectPreview(ui)['overlay/preview/wire']!.colour;
    ghost.show(B.gun, 48, 56, 0, false, 0.05, 0, 0);
    const blocked = inspectPreview(ui)['overlay/preview/wire']!.colour;
    expect(blocked).toBe(BLOCKED_COLOUR);
    expect(blocked).not.toBe(allowed);
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
    let crosses = 0;
    ui.traverseVisible((o) => {
      if (o instanceof InstancedMesh && o.name === 'overlay/drag/skip-cross') crosses += o.count;
    });
    // W27b: the wires are line segments; a tile carries a wireframe when a line vertex lies inside it
    const wire = lines(ui, 'overlay/drag/wire');
    expect(wire.meshes, 'no triangle wireframe mesh').toBe(0);
    const tilesWith = new Set<number>();
    for (const p of wire.points) {
      const hit = build.find(([x, z]) => p.x > x + 0.02 && p.x < x + 0.98 && p.z > z + 0.02 && p.z < z + 0.98);
      if (hit) tilesWith.add(hit[0]);
      expect(Math.abs(p.x - 55.5) < 0.45 && Math.abs(p.z - 60.5) < 0.45, `no wireframe on the blocked tile (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`).toBe(false);
    }
    expect(tilesWith.size).toBe(9);
    expect(crosses).toBe(1);
    // the wire geometry is the W23 wall parts' geometry at the wall's preview level, and the plinth
    // a placed wall gets on sloping ground (the same plinth rule as a placed building and the ghost)
    const wallGeos = new Set<string>();
    for (const p of r.parts.parts) if (p.asset === 'wall') for (const g of p.levels[previewLevel(B.wall) as 0 | 1 | 2].values()) wallGeos.add(g.uuid);
    r.group.traverse((o) => {
      if (o instanceof InstancedMesh && o.name === 'plinth') wallGeos.add(o.geometry.uuid);
    });
    expect(wire.sources.length).toBeGreaterThan(0);
    for (const g of wire.sources) expect(wallGeos.has(g), `wire source ${g}`).toBe(true);
    // pulsing in step with the ghost, and nothing allocated frame to frame
    const pool = () => {
      const out: string[] = [];
      ui.traverse((o) => {
        if (o instanceof InstancedMesh) out.push(`${o.uuid}:${o.instanceMatrix.count}:${(o.instanceMatrix.array as Float32Array).length}`);
        if (o instanceof LineSegments) out.push(`${o.uuid}:${(o.geometry.attributes.position!.array as Float32Array).length}`);
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
