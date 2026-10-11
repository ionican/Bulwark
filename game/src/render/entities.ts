// Instanced drawing of the overlays on what the simulation sends: belt items, health bars, shields,
// upgrade frames and selection markers. models.ts draws every building, unit, alien and wreck, and
// effects.ts the beams, work lines and shots (W24 run 2b).
// Each frame every building and mobile is frustum-tested and given its own LOD by camera distance
// (with hysteresis, see lod.ts): items and health bars are drawn at model detail only. Instance
// matrices are written straight into each mesh's array.
// W24 run 2a (Richard): alien routes are not drawn (the simulation still computes them).
// W24 run 3 (G): W13's greybox models (the `models: true` option) are gone. Heights come from the
// drawn ground (ground.ts).

import { DoubleSide, Frustum, InstancedMesh, Matrix4, MeshBasicMaterial, MeshLambertMaterial, Sphere, Vector3, type BufferGeometry, type Material, type PerspectiveCamera, type Scene } from 'three';
import { B, ITEM_NAMES, SHIELD, U, alienInfo, isBelt, unitInfo } from '../sim/kinds.ts';
import { BF_COMPLETE, BF_UPGRADING, isReserved } from '../sim/schema.ts';
import type { Terrain } from '../sim/terrain.ts';
import { groundHeight as heightAt, tileTop } from './ground.ts';
import { BELT_STRAIGHT, itemOnBelt, type BeltShapes } from './beltShapes.ts';
import { BELT_SURFACE_Y } from './workshop/models/procedural/buildings.ts';
import { slotOf } from '../sim/table.ts';
import type { Snapshot } from '../sim/snapshot.ts';
import type { EffectTime } from './anim.ts';
import { barGeometry, constructionFrameGeometry, dashedRingGeometry, itemGeometries, selectionMarkerGeometry, shieldDomeGeometry } from './geometry.ts';
import { FRAME_MATERIAL, ITEM_MATERIAL } from './debugRender.ts';
import { LOD_ICON, chooseLod } from './lod.ts';
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
const ICON_PX = { building: 9, belt: 5, alien: 6.5, commander: 13, engineer: 8, wreck: 4.5, route: 6 } as const;

/** Instance matrix = translate · rotateY(c, s) · scale(sx, sy, sz), written in place. */
function writeM(arr: Float32Array, i: number, c: number, s: number, sx: number, sy: number, sz: number, x: number, y: number, z: number) {
  const o = i * 16;
  arr[o] = c * sx;
  arr[o + 1] = 0;
  arr[o + 2] = -s * sx;
  arr[o + 3] = 0;
  arr[o + 4] = 0;
  arr[o + 5] = sy;
  arr[o + 6] = 0;
  arr[o + 7] = 0;
  arr[o + 8] = s * sz;
  arr[o + 9] = 0;
  arr[o + 10] = c * sz;
  arr[o + 11] = 0;
  arr[o + 12] = x;
  arr[o + 13] = y;
  arr[o + 14] = z;
  arr[o + 15] = 1;
}

/**
 * A batch of InstancedMeshes filled from zero each frame. Each mesh starts at `capacity` instances
 * and doubles when full, up to `max` (the most the simulation can produce: its table capacity), so
 * a normal scene keeps small buffers and a full one is still drawn whole (review 4). `overflowed`
 * is set only if more than `max` are pushed.
 */
class Batch {
  readonly meshes: InstancedMesh[] = [];
  readonly counts: Int32Array;
  overflowed = false;
  private readonly max: number;

  constructor(scene: Scene, geoms: BufferGeometry[], materials: Material[], capacity: number, order = 0, max = capacity, name = 'overlay') {
    this.max = Math.max(capacity, max);
    this.counts = new Int32Array(geoms.length);
    geoms.forEach((g, i) => {
      const m = new InstancedMesh(g, materials[i] ?? materials[0]!, capacity);
      m.name = `${name}/${i}`;
      m.frustumCulled = false;
      m.count = 0;
      m.visible = false;
      m.renderOrder = order;
      scene.add(m);
      this.meshes.push(m);
    });
  }

  reset() {
    this.counts.fill(0);
  }

  push(k: number, c: number, s: number, sx: number, sy: number, sz: number, x: number, y: number, z: number) {
    let m = this.meshes[k]!;
    const n = this.counts[k]!;
    if (n >= m.instanceMatrix.count) {
      if (!this.grow(k)) {
        this.overflowed = true;
        return;
      }
      m = this.meshes[k]!;
    }
    writeM(m.instanceMatrix.array as Float32Array, n, c, s, sx, sy, sz, x, y, z);
    this.counts[k] = n + 1;
  }

  /** Replaces mesh k with one of twice the capacity (at most `max`), keeping what was written. */
  private grow(k: number): boolean {
    const old = this.meshes[k]!;
    const cap = old.instanceMatrix.count;
    if (cap >= this.max) return false;
    const m = new InstancedMesh(old.geometry, old.material, Math.min(this.max, cap * 2));
    m.name = old.name;
    m.frustumCulled = false;
    m.count = 0;
    m.visible = old.visible;
    m.renderOrder = old.renderOrder;
    (m.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    old.parent?.add(m);
    old.removeFromParent();
    old.dispose();
    this.meshes[k] = m;
    return true;
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

/** Table capacities of the simulation (sim/world.ts CAPACITY), passed in by the caller. */
export interface Capacity {
  buildings: number;
  aliens: number;
  units: number;
  wrecks: number;
  projectiles: number;
}

export interface FrameInput {
  camera: PerspectiveCamera;
  viewportHeight: number;
  yaw: number;
  snapshot: Snapshot;
  aliens: MobileView;
  units: MobileView;
  projectiles: MobileView;
  selection: readonly Pick[];
  /** Seconds since the last frame, 0 while paused (models.ts walking). */
  dt?: number;
  /** W24 run 2b: the effect clock (anim.ts EffectClock; its `reset` marks a global reset). */
  time?: EffectTime;
}

/** Scratch for itemOnBelt. */
const _item = { x: 0, z: 0, tx: 0, tz: 0 };

export class EntityRenderer {
  private readonly items: Batch;
  private readonly shields: Batch; // 0 dome, 1 ring
  private readonly frames: Batch;
  private readonly bars: Batch; // 0 back, 1 fill
  private readonly markers: Batch;
  private readonly lod: { b: Uint8Array; bId: Uint32Array; a: Uint8Array; aId: Uint32Array; u: Uint8Array; uId: Uint32Array };
  /** Row of each live building / wreck by slot, for the selection markers' id lookups this frame. */
  private readonly buildingRow: Int32Array;
  private readonly wreckRow: Int32Array;
  private readonly frustum = new Frustum();
  private readonly projView = new Matrix4();
  private readonly sphere = new Sphere();
  private readonly camPos = new Vector3();
  readonly counts: LodCounts = { full: 0, simple: 0, icon: 0, culled: 0 };
  private readonly terrain: Terrain;
  private wppPerDist = 0;
  /** Each item mesh's height above its base. */
  private readonly itemTops: number[];
  /** Debug (the W29b pixel check's negative control): items lowered into the belt, their tops under its surface. */
  itemDrop = false;
  /** Debug (the per-item pixel check, scripts/check-render.mjs): belts (building ids) whose item is not drawn. */
  hiddenItems: ReadonlySet<number> = new Set();

  /**
   * `belts`: each belt tile's shape (corner items follow the curve), the models' instance
   * (models.ts), which view.ts updates from the same snapshot before this renderer runs.
   */
  constructor(
    scene: Scene,
    terrain: Terrain,
    capacity: Capacity,
    private readonly belts: BeltShapes,
  ) {
    this.terrain = terrain;
    const C = capacity;
    const L = (n: number) => new Uint8Array(n).fill(255);
    this.lod = { b: L(C.buildings), bId: new Uint32Array(C.buildings), a: L(C.aliens), aId: new Uint32Array(C.aliens), u: L(C.units), uId: new Uint32Array(C.units) };
    this.buildingRow = new Int32Array(C.buildings);
    this.wreckRow = new Int32Array(C.wrecks);
    const model = new MeshLambertMaterial({ name: ITEM_MATERIAL, vertexColors: true, flatShading: true });
    const flat = new MeshBasicMaterial({ vertexColors: true });
    // Starting sizes as before; each grows up to what the simulation's tables allow.
    // one mesh per item kind (W29: mass and rare have their own), named overlay/item/<kind>
    const items = itemGeometries();
    if (items.length !== ITEM_NAMES.length) throw new Error(`item meshes: ${items.length} for ${ITEM_NAMES.length} item kinds`);
    this.itemTops = items.map((g) => {
      g.computeBoundingBox();
      return g.boundingBox!.max.y;
    });
    this.items = new Batch(scene, items, [model], 1536, 0, C.buildings, 'overlay/item');
    const dome = new MeshBasicMaterial({ color: '#cfe6ff', transparent: true, opacity: 0.12, depthWrite: false, side: DoubleSide });
    this.shields = new Batch(scene, [shieldDomeGeometry(), dashedRingGeometry()], [dome, flat], 128, 0, C.buildings);
    // W24 run 3 (D1): frames are depth-tested on their own material (a building in front hides the
    // part behind it), offset towards the camera so a frame on the ground does not flicker.
    const frame = new MeshBasicMaterial({ name: FRAME_MATERIAL, vertexColors: true, depthTest: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    this.frames = new Batch(scene, [constructionFrameGeometry()], [frame], 512, 14, C.buildings);
    const back = new MeshBasicMaterial({ color: '#120f0d', depthTest: false, depthWrite: false });
    const fill = new MeshBasicMaterial({ color: '#f4efe6', depthTest: false, depthWrite: false });
    this.bars = new Batch(scene, [barGeometry(), barGeometry()], [back, fill], 1024, 13, C.buildings + C.aliens + C.units);
    this.bars.meshes[1]!.renderOrder = 14;
    // Selection markers test depth (Richard, 2026-10-09: the brackets of a unit behind a turret drew
    // over the turret), so buildings and terrain in front hide them; the strategic icons do not.
    const marker = new MeshBasicMaterial({ vertexColors: true, depthWrite: false });
    this.markers = new Batch(scene, [selectionMarkerGeometry()], [marker], 2048, 15, C.buildings + C.aliens + C.units + C.wrecks);
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

  private distTo(x: number, y: number, z: number): number {
    const dx = x - this.camPos.x;
    const dy = y - this.camPos.y;
    const dz = z - this.camPos.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Screen-aligned health bar above a point (only for damaged things at model detail). */
  private bar(x: number, y: number, z: number, frac: number, len: number, yc: number, ys: number) {
    const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
    const sx = x - yc * (len / 2);
    const sz = z + ys * (len / 2);
    this.bars.push(0, yc, ys, len, 1, 1, sx, y, sz);
    this.bars.push(1, yc, ys, Math.max(0.001, len * f), 1.4, 0.6, sx, y + 0.01, sz);
  }

  update(f: FrameInput): void {
    const { camera, viewportHeight: vh, snapshot: snap } = f;
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    this.camPos.copy(camera.position);
    this.wppPerDist = worldPerPixel(camera, 1, vh);
    const wppd = this.wppPerDist;
    const yc = Math.cos(f.yaw);
    const ys = Math.sin(f.yaw);
    this.counts.full = this.counts.simple = this.counts.icon = this.counts.culled = 0;
    for (const b of this.allBatches()) b.reset();

    // Row lookups for this frame.
    this.buildingRow.fill(-1);
    for (let r = 0; r < snap.buildings.count; r++) this.buildingRow[slotOf(snap.buildings.id[r]!)] = r;
    this.wreckRow.fill(-1);
    for (let r = 0; r < snap.wrecks.count; r++) this.wreckRow[slotOf(snap.wrecks.id[r]!)] = r;

    this.drawBuildings(f, yc, ys);
    this.drawMobiles(f.aliens, this.lod.a, this.lod.aId, (k) => alienInfo(k).radius, (k) => alienInfo(k).hp, yc, ys, snap.aliens.cols.hp);
    this.drawMobiles(f.units, this.lod.u, this.lod.uId, (k) => unitInfo(k).radius, (k) => unitInfo(k).hp, yc, ys, snap.units.cols.hp);
    this.drawSelection(f, wppd);
    for (const b of this.allBatches()) b.commit();
  }

  private drawBuildings(f: FrameInput, yc: number, ys: number) {
    const snap = f.snapshot;
    const B_ = snap.buildings;
    const c = B_.cols;
    const t = this.terrain;
    const wppd = this.wppPerDist;
    for (let r = 0; r < B_.count; r++) {
      const kind = c.kind[r]!;
      const fw = c.fw[r]!;
      const fh = c.fh[r]!;
      const size = Math.max(fw, fh);
      const x = c.tx[r]! + fw / 2;
      const z = c.ty[r]! + fh / 2;
      const y = heightAt(t, x, z);
      const flags = c.flags[r]!;
      const shieldUp = kind === B.shield && c.shield[r]! > 0 && flags & BF_COMPLETE;
      if (!this.visible(x, y + 0.8, z, shieldUp ? SHIELD.radius : size * 0.75 + 1)) {
        this.counts.culled++;
        continue;
      }
      const dist = this.distTo(x, y, z);
      const lod = this.lodFor(this.lod.b, this.lod.bId, B_.id[r]!, dist);
      this.count(lod);
      const belt = isBelt(kind);
      const complete = (flags & BF_COMPLETE) !== 0;
      // Reserved: models.ts draws its outline; nothing here.
      if (isReserved(flags)) continue;
      // Upgrade under way: a scaffold frame round the footprint (models.ts's build cut shows construction).
      if (complete && flags & BF_UPGRADING) {
        const pad = Math.max(0.15, (ICON_PX.building + 3) * wppd * dist - size / 2);
        this.frames.push(0, 1, 0, fw / 2 + pad, 1, fh / 2 + pad, x, y + 0.12, z);
      }
      if (lod !== LOD_ICON) {
        // Belt item.
        if (belt && c.item[r]! !== 0 && !this.hiddenItems.has(B_.id[r]!)) {
          // W29b: on the belt's top surface (the model stands on its footprint's top), along the
          // tile's path: the quarter circle on a corner, back to front otherwise
          const bx = c.tx[r]!;
          const bz = c.ty[r]!;
          const shape = kind === B.belt ? this.belts.itemShapeAt(bz * t.w + bx) : BELT_STRAIGHT;
          const o = itemOnBelt(shape, c.dir[r]!, c.itemPos[r]!, _item);
          const item = c.item[r]!;
          const base = tileTop(t, bx, bz) + BELT_SURFACE_Y - (this.itemDrop ? this.itemTops[item]! + 0.02 : 0);
          this.items.push(item, o.tx, -o.tz, 1, 1, 1, x + o.x, base, z + o.z);
        }
        if (c.hp[r]! < c.maxHp[r]! - 0.5 && complete && !belt) this.bar(x, y + 2.4, z, c.hp[r]! / c.maxHp[r]!, size * 0.9, yc, ys);
      }
      // Shield bubble.
      if (shieldUp) {
        const frac = c.shield[r]! / SHIELD.capacity;
        this.shields.push(0, 1, 0, SHIELD.radius, SHIELD.radius * (0.25 + 0.35 * frac), SHIELD.radius, x, y, z);
        this.shields.push(1, 1, 0, SHIELD.radius, 1, SHIELD.radius, x, y + 0.1, z);
      }
    }
  }

  /** Health bars of damaged aliens or units at model detail. */
  private drawMobiles(v: MobileView, state: Uint8Array, ids: Uint32Array, radius: (k: number) => number, maxHp: (k: number) => number, yc: number, ys: number, hp: Float32Array) {
    const t = this.terrain;
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
      const dist = this.distTo(x, y, z);
      const lod = this.lodFor(state, ids, v.id[r]!, dist);
      this.count(lod);
      if (lod !== LOD_ICON) {
        const m = maxHp(kind);
        if (hp[r]! < m - 0.5) this.bar(x, y + rad * 2 + 0.9, z, hp[r]! / m, Math.max(0.8, rad * 2), yc, ys);
      }
    }
  }

  private drawSelection(f: FrameInput, wppd: number) {
    const t = this.terrain;
    const add = (x: number, z: number, half: number, iconPx: number) => {
      const y = heightAt(t, x, z);
      const dist = this.distTo(x, y, z);
      const scale = Math.max(half, (iconPx + 8) * wppd * dist);
      this.markers.push(0, 1, 0, scale, 1, scale, x, y + 0.15, z);
    };
    const B_ = f.snapshot.buildings;
    for (const p of f.selection) {
      if (p.type === 'building') {
        const r = this.buildingRow[slotOf(p.id)]!;
        if (r < 0 || B_.id[r] !== p.id) continue;
        const fw = B_.cols.fw[r]!;
        const fh = B_.cols.fh[r]!;
        add(B_.cols.tx[r]! + fw / 2, B_.cols.ty[r]! + fh / 2, Math.max(fw, fh) / 2 + 0.25, ICON_PX.building);
      } else if (p.type === 'wreck') {
        const r = this.wreckRow[slotOf(p.id)]!;
        if (r < 0 || f.snapshot.wrecks.id[r] !== p.id) continue;
        add(f.snapshot.wrecks.cols.x[r]!, f.snapshot.wrecks.cols.z[r]!, 0.8, ICON_PX.wreck);
      } else {
        const v = p.type === 'unit' ? f.units : f.aliens;
        const r = findRow(v.id, v.count, p.id);
        if (r < 0) continue;
        const rad = p.type === 'unit' ? unitInfo(v.kind[r]!).radius : alienInfo(v.kind[r]!).radius;
        add(v.x[r]!, v.z[r]!, rad + 0.3, p.type === 'unit' && v.kind[r] === U.commander ? ICON_PX.commander : ICON_PX.alien);
      }
    }
  }

  get overflowed(): boolean {
    return this.allBatches().some((b) => b.overflowed);
  }

  private allBatches(): Batch[] {
    return [this.items, this.shields, this.frames, this.bars, this.markers];
  }
}

function findRow(ids: Uint32Array, count: number, id: number): number {
  for (let r = 0; r < count; r++) if (ids[r] === id) return r;
  return -1;
}
