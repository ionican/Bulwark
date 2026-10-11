// Scene inspection (W24 run 2a, criterion 2): reads what is actually in the Three.js scene graph —
// every visible mesh, and every instanced batch with count > 0, with its material names and the
// world transform of each instance — and attributes each instance to the entity under it, by
// position. Nothing here asks the renderer what it drew; it reads the buffers that are submitted.
// Used by the tests (Node) and by `__game.inspect()` / `inspectNextFrame()` in the browser (scripts/check-render.mjs).
//
// Attribution: an instance belongs to the entity whose footprint (buildings) or radius (units,
// aliens, wrecks) contains its world translation (x, z), expanded by a margin; if several do, the
// nearest centre wins. W24 run 2b: each model and icon mesh carries the entity group it draws in
// `userData.group` (set where the batch is created, models.ts: `tagGroup`), and matches only
// entities of that group, so an engineer standing on the temporary turret it dropped, or on a wall
// tile it builds, is not counted as that building. A drawn mesh that is neither greybox nor an
// overlay and carries no group is attributed to nothing and listed under `ungrouped` in the
// report (scripts fail on it). Of two entities at the same distance, one the mesh has not yet been
// attributed to wins. Meshes named `terrain/…` and the sky are ground, not entities, and are left
// out. `greybox/…` is W13's renderer and `overlay/…` (or group 'overlay') the overlays (bars,
// beams, shots, routes, markers, effects); both match any entity.

import { InstancedBufferGeometry, InstancedMesh, Matrix4, Mesh, type Material, type Object3D } from 'three';
import { ALIEN_KINDS, BUILDING_KINDS, U, UNIT_KINDS, alienInfo } from '../sim/kinds.ts';
import type { Snapshot } from '../sim/snapshot.ts';
import type { MobileView } from './interp.ts';

export interface DrawnMesh {
  name: string;
  materials: string[];
  /** Instances submitted (1 for a plain mesh). */
  count: number;
  /** World matrix of each instance, 16 floats each (column-major). */
  worlds: Float32Array;
  greybox: boolean;
  overlay: boolean;
  /** The entity group the mesh draws (`userData.group`); null when untagged. */
  group: EntityRef['group'] | null;
}

/** What a mesh draws: one entity group, or overlays drawn over any entity. */
export type MeshGroup = EntityRef['group'] | 'overlay';

/** Tags every mesh under `root` with the group it draws (`userData.group`, read by `drawnMeshes`). */
export function tagGroup(root: Object3D, group: MeshGroup | ((mesh: Mesh) => MeshGroup)): void {
  root.traverse((o) => {
    if (o instanceof Mesh) o.userData.group = typeof group === 'function' ? group(o) : group;
  });
}

/** The report key that lists drawn model meshes with no group (they are attributed to nothing). */
export const UNGROUPED = 'ungrouped';

/** The report key `__game.inspectNextFrame()` adds for the frame it inspected (InspectFrame). */
export const INSPECT_FRAME = '__frame';

/**
 * The frame an inspection was taken on: its snapshot tick, whether the game was paused, what the
 * scene pass submitted (renderer.info) and the least it had to (submissionFloor).
 */
export interface InspectFrame {
  tick: number;
  paused: boolean;
  calls: number;
  triangles: number;
  floorCalls: number;
  floorTriangles: number;
}

export interface EntityRef {
  group: 'building' | 'unit' | 'alien' | 'wreck';
  kindName: string;
  id: number;
  /** Centre and half extents on the ground (tiles). */
  x: number;
  z: number;
  hx: number;
  hz: number;
}

export interface KindReport {
  /** Instances attributed to this kind (all meshes). */
  instances: number;
  /** Non-greybox, non-overlay model instances and icon instances. */
  models: number;
  icons: number;
  /** Greybox instances (must be 0 outside `?greybox=1`). */
  greybox: number;
  meshes: string[];
  materials: string[];
  /** Entities of the kind in the snapshot, and how many got at least one model or icon instance. */
  entities: number;
  covered: number;
}

const _m = new Matrix4();
const _w = new Matrix4();

function materialNames(m: Material | Material[]): string[] {
  return (Array.isArray(m) ? m : [m]).map((x) => x.name || x.type);
}

/** Whether the renderer draws a mesh with these materials at all (three.js skips a hidden material). */
function drawable(m: Material | Material[]): boolean {
  return (Array.isArray(m) ? m : [m]).some((x) => x.visible !== false);
}

/**
 * Every drawn mesh under `root` (visible, count > 0, at least one material not hidden), with world
 * instance matrices. A mesh whose materials are all hidden is not drawn (W24 review: hidden model
 * materials left the coverage the performance gate reads unchanged).
 */
export function drawnMeshes(root: Object3D): DrawnMesh[] {
  root.updateMatrixWorld(true);
  const out: DrawnMesh[] = [];
  root.traverseVisible((o) => {
    if (!(o instanceof Mesh) || !drawable(o.material)) return;
    if (o.name.startsWith('terrain/') || o.name === 'sky') return;
    // an unnamed mesh is reported by its type and parent, so an `ungrouped` entry can be traced
    const name = o.name || `(${o.type} in ${o.parent?.name || 'an unnamed group'})`;
    const greybox = o.name.startsWith('greybox/');
    const tag = o.userData.group as MeshGroup | undefined;
    const overlay = o.name.startsWith('overlay/') || tag === 'overlay';
    const group = tag && tag !== 'overlay' ? tag : null;
    if (o instanceof InstancedMesh) {
      const n = o.count;
      if (n <= 0) return;
      const worlds = new Float32Array(n * 16);
      const a = o.instanceMatrix.array as Float32Array;
      for (let i = 0; i < n; i++) {
        _m.fromArray(a, i * 16);
        _w.multiplyMatrices(o.matrixWorld, _m);
        _w.toArray(worlds, i * 16);
      }
      out.push({ name, materials: materialNames(o.material), count: n, worlds, greybox, overlay, group });
    } else {
      out.push({ name, materials: materialNames(o.material), count: 1, worlds: new Float32Array(o.matrixWorld.elements), greybox, overlay, group });
    }
  });
  return out;
}

/**
 * The least the main scene pass must submit for `root`: one draw call per visible mesh that has a
 * drawable material, is not frustum-culled (frustumCulled false, so three.js always submits it)
 * and has instances, and its triangles (instances × triangles per instance; multi-material and
 * wireframe meshes count a call and no triangles). Shadow maps and frustum-culled meshes only add
 * to what the renderer reports, so `renderer.info` for the scene pass must be at least this.
 */
export function submissionFloor(root: Object3D): { calls: number; triangles: number } {
  let calls = 0;
  let triangles = 0;
  root.traverseVisible((o) => {
    if (!(o instanceof Mesh) || o.frustumCulled || !drawable(o.material)) return;
    const g = o.geometry;
    let instances = 1;
    if (o instanceof InstancedMesh) instances = o.count;
    else if (g instanceof InstancedBufferGeometry) instances = Number.isFinite(g.instanceCount) ? g.instanceCount : 0;
    if (instances <= 0) return;
    calls++;
    const m = o.material as Material | Material[];
    if (Array.isArray(m) || (m as Material & { wireframe?: boolean }).wireframe) return;
    const n = Math.min(g.index ? g.index.count : (g.attributes.position?.count ?? 0), g.drawRange.count);
    triangles += Math.floor(n / 3) * instances;
  });
  return { calls, triangles };
}

/** Per kind name: what was drawn on the entities of that kind. */
export function inspectScene(root: Object3D, entities: EntityRef[], margin = 0.6): Record<string, KindReport> {
  const drawn = drawnMeshes(root);
  // spatial grid of entities, 4-tile cells
  const cell = 4;
  const grid = new Map<number, number[]>();
  const key = (cx: number, cz: number) => cx * 4096 + cz;
  entities.forEach((e, i) => {
    const x0 = Math.floor((e.x - e.hx - margin) / cell);
    const x1 = Math.floor((e.x + e.hx + margin) / cell);
    const z0 = Math.floor((e.z - e.hz - margin) / cell);
    const z1 = Math.floor((e.z + e.hz + margin) / cell);
    for (let cx = x0; cx <= x1; cx++)
      for (let cz = z0; cz <= z1; cz++) {
        const k = key(cx, cz);
        const l = grid.get(k) ?? [];
        l.push(i);
        grid.set(k, l);
      }
  });
  const reports: Record<string, KindReport & { _covered: Set<number>; _meshes: Set<string>; _mats: Set<string> }> = {};
  const rep = (kind: string) =>
    (reports[kind] ??= { instances: 0, models: 0, icons: 0, greybox: 0, meshes: [], materials: [], entities: 0, covered: 0, _covered: new Set(), _meshes: new Set(), _mats: new Set() });
  for (const e of entities) rep(e.kindName).entities++;
  for (const d of drawn) {
    if (!d.greybox && !d.overlay && d.group === null) {
      const u = rep(UNGROUPED);
      u.instances += d.count;
      u._meshes.add(d.name);
      continue;
    }
    // greybox and overlays: any entity
    const group = d.greybox || d.overlay ? null : d.group;
    // entities this mesh has already been attributed to: of two entities at the same distance (two
    // engineers on one spot, each drawn as one icon at its centre), the one not yet taken wins
    const taken = new Set<number>();
    for (let i = 0; i < d.count; i++) {
      const x = d.worlds[i * 16 + 12]!;
      const z = d.worlds[i * 16 + 14]!;
      const list = grid.get(key(Math.floor(x / cell), Math.floor(z / cell)));
      if (!list) continue;
      let best = -1;
      let bestD = Infinity;
      for (const ei of list) {
        const e = entities[ei]!;
        if (group !== null && e.group !== group) continue;
        if (Math.abs(x - e.x) > e.hx + margin || Math.abs(z - e.z) > e.hz + margin) continue;
        const dd = (x - e.x) ** 2 + (z - e.z) ** 2;
        if (dd < bestD - 1e-9 || (Math.abs(dd - bestD) <= 1e-9 && taken.has(best) && !taken.has(ei))) {
          bestD = dd;
          best = ei;
        }
      }
      if (best < 0) continue;
      taken.add(best);
      const e = entities[best]!;
      const r = rep(e.kindName);
      r.instances++;
      if (d.greybox) r.greybox++;
      else if (!d.overlay) {
        if (d.name.startsWith('icon/')) r.icons++;
        else r.models++;
        r._covered.add(best);
        r._meshes.add(d.name);
        for (const m of d.materials) r._mats.add(m);
      }
    }
  }
  const out: Record<string, KindReport> = {};
  for (const [k, r] of Object.entries(reports)) {
    const { _covered, _meshes, _mats, ...rest } = r;
    out[k] = { ...rest, covered: _covered.size, meshes: [..._meshes].sort(), materials: [..._mats].sort() };
  }
  return out;
}

/** Entities of a snapshot (units and aliens at their drawn, interpolated positions). */
export function entitiesOf(s: Snapshot, aliens: MobileView, units: MobileView): EntityRef[] {
  const out: EntityRef[] = [];
  const b = s.buildings;
  for (let r = 0; r < b.count; r++) {
    const fw = b.cols.fw[r]!;
    const fh = b.cols.fh[r]!;
    out.push({ group: 'building', kindName: BUILDING_KINDS[b.cols.kind[r]!]!, id: b.id[r]!, x: b.cols.tx[r]! + fw / 2, z: b.cols.ty[r]! + fh / 2, hx: fw / 2, hz: fh / 2 });
  }
  for (let r = 0; r < units.count; r++) {
    const h = units.kind[r] === U.commander ? 1.6 : 0.5;
    out.push({ group: 'unit', kindName: UNIT_KINDS[units.kind[r]!]!, id: units.id[r]!, x: units.x[r]!, z: units.z[r]!, hx: h, hz: h });
  }
  for (let r = 0; r < aliens.count; r++) {
    const h = alienInfo(aliens.kind[r]!).radius * 1.5 + 0.4;
    out.push({ group: 'alien', kindName: ALIEN_KINDS[aliens.kind[r]!]!, id: aliens.id[r]!, x: aliens.x[r]!, z: aliens.z[r]!, hx: h, hz: h });
  }
  for (let r = 0; r < s.wrecks.count; r++) out.push({ group: 'wreck', kindName: 'wreck', id: s.wrecks.id[r]!, x: s.wrecks.cols.x[r]!, z: s.wrecks.cols.z[r]!, hx: 1, hz: 1 });
  return out;
}
