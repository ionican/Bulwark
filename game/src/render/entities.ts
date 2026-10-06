// Instanced drawing of buildings, aliens and player units. One InstancedMesh per kind per detail
// level, so the draw-call count depends on the number of kinds, not the number of entities.
// Each frame every entity is frustum-tested, given its own LOD by camera distance (with
// hysteresis, see lod.ts) and written straight into its mesh's instance matrix array.

import {
  Frustum,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Sphere,
  Vector3,
  type BufferGeometry,
  type PerspectiveCamera,
  type Scene,
} from 'three';
import { BUILDING_KINDS, alienInfo, buildingSize, unitInfo, UNIT_KINDS, ALIEN_KINDS, U } from '../sim/kinds.ts';
import { CAPACITY } from '../sim/world.ts';
import { heightAt, type Terrain } from '../sim/terrain.ts';
import { slotOf } from '../sim/table.ts';
import type { Snapshot } from '../sim/snapshot.ts';
import { alienGeometries, buildingGeometries, selectionMarkerGeometry, unitGeometries, type KindGeometry } from './geometry.ts';
import { LOD_FULL, LOD_ICON, LOD_LEVELS, chooseLod } from './lod.ts';
import { worldPerPixel } from './cameraRig.ts';
import type { MobileView } from './interp.ts';
import type { Pick } from './picking.ts';

export interface LodCounts {
  full: number;
  simple: number;
  icon: number;
  /** Outside the view frustum: not drawn at any level. */
  culled: number;
}

/** Icon radius in screen pixels. */
const ICON_PX = { building: 9, alien: 6.5, commander: 13, engineer: 8 } as const;

function writeTRS(arr: Float32Array, i: number, c: number, s: number, scale: number, x: number, y: number, z: number) {
  const o = i * 16;
  arr[o] = c * scale;
  arr[o + 1] = 0;
  arr[o + 2] = -s * scale;
  arr[o + 3] = 0;
  arr[o + 4] = 0;
  arr[o + 5] = scale;
  arr[o + 6] = 0;
  arr[o + 7] = 0;
  arr[o + 8] = s * scale;
  arr[o + 9] = 0;
  arr[o + 10] = c * scale;
  arr[o + 11] = 0;
  arr[o + 12] = x;
  arr[o + 13] = y;
  arr[o + 14] = z;
  arr[o + 15] = 1;
}

class KindSet {
  /** meshes[kind * LOD_LEVELS + lod] */
  readonly meshes: InstancedMesh[] = [];
  readonly counts: Int32Array;
  readonly capacity: number;
  overflowed = false;

  constructor(scene: Scene, geoms: KindGeometry[], capacity: number, model: MeshLambertMaterial, icon: MeshBasicMaterial, iconOrder: number) {
    this.capacity = capacity;
    this.counts = new Int32Array(geoms.length * LOD_LEVELS);
    for (const g of geoms) {
      for (const [lod, geo] of [g.full, g.simple, g.icon].entries() as Iterable<[number, BufferGeometry]>) {
        const m = new InstancedMesh(geo, lod === LOD_ICON ? icon : model, capacity);
        m.frustumCulled = false; // culled per instance below
        m.count = 0;
        m.visible = false;
        if (lod === LOD_ICON) m.renderOrder = iconOrder;
        scene.add(m);
        this.meshes.push(m);
      }
    }
  }

  reset() {
    this.counts.fill(0);
  }

  push(kind: number, lod: number, c: number, s: number, scale: number, x: number, y: number, z: number) {
    const k = kind * LOD_LEVELS + lod;
    const n = this.counts[k]!;
    if (n >= this.capacity) {
      this.overflowed = true;
      return;
    }
    writeTRS(this.meshes[k]!.instanceMatrix.array as Float32Array, n, c, s, scale, x, y, z);
    this.counts[k] = n + 1;
  }

  commit() {
    for (let k = 0; k < this.meshes.length; k++) {
      const m = this.meshes[k]!;
      const n = this.counts[k]!;
      m.count = n;
      m.visible = n > 0;
      if (n > 0) {
        m.instanceMatrix.clearUpdateRanges();
        m.instanceMatrix.addUpdateRange(0, n * 16);
        m.instanceMatrix.needsUpdate = true;
      }
    }
  }
}

export interface FrameInput {
  camera: PerspectiveCamera;
  viewportHeight: number;
  yaw: number;
  snapshot: Snapshot;
  aliens: MobileView;
  units: MobileView;
  selection: readonly Pick[];
}

export class EntityRenderer {
  private readonly buildings: KindSet;
  private readonly aliens: KindSet;
  private readonly units: KindSet;
  private readonly markers: InstancedMesh;
  private markerCount = 0;
  private readonly lodB = new Uint8Array(CAPACITY.buildings).fill(255);
  private readonly lodBId = new Uint32Array(CAPACITY.buildings);
  private readonly lodA = new Uint8Array(CAPACITY.aliens).fill(255);
  private readonly lodAId = new Uint32Array(CAPACITY.aliens);
  private readonly lodU = new Uint8Array(CAPACITY.units).fill(255);
  private readonly lodUId = new Uint32Array(CAPACITY.units);
  private readonly frustum = new Frustum();
  private readonly projView = new Matrix4();
  private readonly sphere = new Sphere();
  private readonly camPos = new Vector3();
  readonly counts: LodCounts = { full: 0, simple: 0, icon: 0, culled: 0 };
  private readonly terrain: Terrain;

  constructor(scene: Scene, terrain: Terrain) {
    this.terrain = terrain;
    const model = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const icon = new MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false });
    this.buildings = new KindSet(scene, buildingGeometries(), 1024, model, icon, 10);
    this.aliens = new KindSet(scene, alienGeometries(), 2048, model, icon, 11);
    this.units = new KindSet(scene, unitGeometries(), 64, model, icon, 12);
    this.markers = new InstancedMesh(selectionMarkerGeometry(), icon, 2048);
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 15;
    this.markers.count = 0;
    scene.add(this.markers);
    if (BUILDING_KINDS.length * 3 + ALIEN_KINDS.length * 3 + UNIT_KINDS.length * 3 !== this.meshCount() - 1) {
      throw new Error('mesh table size mismatch');
    }
  }

  meshCount(): number {
    return this.buildings.meshes.length + this.aliens.meshes.length + this.units.meshes.length + 1;
  }

  private lodFor(state: Uint8Array, ids: Uint32Array, id: number, dist: number): number {
    const slot = slotOf(id);
    const prev = ids[slot] === id ? state[slot]! : 255;
    const l = chooseLod(prev, dist);
    state[slot] = l;
    ids[slot] = id;
    return l;
  }

  private visible(x: number, y: number, z: number, r: number): boolean {
    this.sphere.center.set(x, y, z);
    this.sphere.radius = r;
    return this.frustum.intersectsSphere(this.sphere);
  }

  private count(lod: number) {
    if (lod === 0) this.counts.full++;
    else if (lod === 1) this.counts.simple++;
    else this.counts.icon++;
  }

  update(f: FrameInput): void {
    const { camera, viewportHeight: vh, snapshot: snap } = f;
    const t = this.terrain;
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    this.camPos.copy(camera.position);
    const cx = this.camPos.x;
    const cy = this.camPos.y;
    const cz = this.camPos.z;
    const wppPerDist = worldPerPixel(camera, 1, vh);
    const yc = Math.cos(f.yaw);
    const ys = Math.sin(f.yaw);
    this.counts.full = this.counts.simple = this.counts.icon = this.counts.culled = 0;
    this.markerCount = 0;

    // Buildings.
    const B = snap.buildings;
    const bset = this.buildings;
    bset.reset();
    for (let r = 0; r < B.count; r++) {
      const kind = B.cols.kind[r]!;
      const size = buildingSize(kind);
      const x = B.cols.tx[r]! + size / 2;
      const z = B.cols.ty[r]! + size / 2;
      const y = heightAt(t, x, z);
      if (!this.visible(x, y + 0.8, z, size * 0.75 + 1)) {
        this.counts.culled++;
        continue;
      }
      const dx = x - cx;
      const dy = y - cy;
      const dz = z - cz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const lod = this.lodFor(this.lodB, this.lodBId, B.id[r]!, dist);
      this.count(lod);
      if (lod === LOD_ICON) bset.push(kind, lod, yc, ys, Math.max(size * 0.45, ICON_PX.building * wppPerDist * dist), x, y + 0.3, z);
      else bset.push(kind, lod, 1, 0, 1, x, y, z);
    }
    bset.commit();

    this.drawMobiles(f.aliens, this.aliens, this.lodA, this.lodAId, (k) => alienInfo(k).radius, () => ICON_PX.alien, wppPerDist, yc, ys);
    this.drawMobiles(
      f.units,
      this.units,
      this.lodU,
      this.lodUId,
      (k) => unitInfo(k).radius,
      (k) => (k === U.commander ? ICON_PX.commander : ICON_PX.engineer),
      wppPerDist,
      yc,
      ys,
    );
    this.drawSelection(f, wppPerDist);
  }

  private drawMobiles(
    v: MobileView,
    set: KindSet,
    state: Uint8Array,
    ids: Uint32Array,
    radius: (k: number) => number,
    iconPx: (k: number) => number,
    wppPerDist: number,
    yc: number,
    ys: number,
  ) {
    const t = this.terrain;
    const { x: cx, y: cy, z: cz } = this.camPos;
    set.reset();
    for (let r = 0; r < v.count; r++) {
      const kind = v.kind[r]!;
      const x = v.x[r]!;
      const z = v.z[r]!;
      const y = heightAt(t, x, z);
      const rad = radius(kind);
      if (!this.visible(x, y + rad, z, rad * 2 + 0.5)) {
        this.counts.culled++;
        continue;
      }
      const dx = x - cx;
      const dy = y - cy;
      const dz = z - cz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const lod = this.lodFor(state, ids, v.id[r]!, dist);
      this.count(lod);
      if (lod === LOD_ICON) set.push(kind, lod, yc, ys, Math.max(rad, iconPx(kind) * wppPerDist * dist), x, y + 0.4, z);
      else set.push(kind, lod, v.fx[r]!, -v.fz[r]!, lod === LOD_FULL ? 1 : 1.6, x, y, z);
    }
    set.commit();
  }

  private drawSelection(f: FrameInput, wppPerDist: number) {
    const arr = this.markers.instanceMatrix.array as Float32Array;
    const t = this.terrain;
    const { x: cx, y: cy, z: cz } = this.camPos;
    let n = 0;
    const B = f.snapshot.buildings;
    const add = (x: number, z: number, half: number, iconPx: number) => {
      if (n >= this.markers.instanceMatrix.count) return;
      const y = heightAt(t, x, z);
      const dist = Math.hypot(x - cx, y - cy, z - cz);
      const scale = Math.max(half, (iconPx + 8) * wppPerDist * dist);
      writeTRS(arr, n++, 1, 0, scale, x, y + 0.15, z);
    };
    for (const p of f.selection) {
      if (p.type === 'building') {
        const r = findRow(B.id, B.count, p.id);
        if (r < 0) continue;
        const size = buildingSize(B.cols.kind[r]!);
        add(B.cols.tx[r]! + size / 2, B.cols.ty[r]! + size / 2, size / 2 + 0.25, ICON_PX.building);
      } else {
        const v = p.type === 'unit' ? f.units : f.aliens;
        const r = findRow(v.id, v.count, p.id);
        if (r < 0) continue;
        const rad = p.type === 'unit' ? unitInfo(v.kind[r]!).radius : alienInfo(v.kind[r]!).radius;
        add(v.x[r]!, v.z[r]!, rad + 0.3, p.type === 'unit' && v.kind[r] === U.commander ? ICON_PX.commander : ICON_PX.alien);
      }
    }
    this.markerCount = n;
    this.markers.count = n;
    this.markers.visible = n > 0;
    if (n > 0) this.markers.instanceMatrix.needsUpdate = true;
  }

  get selectionMarkers(): number {
    return this.markerCount;
  }

  get overflowed(): boolean {
    return this.buildings.overflowed || this.aliens.overflowed || this.units.overflowed;
  }
}

function findRow(ids: Uint32Array, count: number, id: number): number {
  for (let r = 0; r < count; r++) if (ids[r] === id) return r;
  return -1;
}
