// Instanced drawing of everything the simulation sends: buildings, aliens, player units, wrecks,
// belt items, projectiles, beams, shields, construction frames, health bars, the aliens' predicted
// and selection markers. One InstancedMesh per kind per detail level, so the draw-call count
// depends on the number of kinds, not the number of entities.
// Each frame every entity is frustum-tested, given its own LOD by camera distance (with hysteresis,
// see lod.ts) and written straight into its mesh's instance matrix array.
// W24 construction states are drawn by shape: a reserved site as a dotted outline only, a started
// site as the scaffold frame round its growing model, a complete building as its model. A gate is
// its 3 × depth footprint box with the centre column open (the corridor), turned to its axis.
// W24 run 2a (Richard): alien routes are not drawn (the simulation still computes them).
// W24 run 2a: this is W13's greybox renderer. With `models: false` (the default view; models.ts
// draws every building, unit, alien and wreck) it draws only the overlays: belt items, health bars,
// shields and selection markers (W24 run 2b: beams, work lines and shots are drawn by effects.ts in
// that view, so they are drawn here only in the greybox view). With `models: true`
// (`?greybox=1`) it draws everything, as in W13. Heights come from the drawn ground (ground.ts).
// Its model batches are named `greybox/…`, so a scene inspection can tell them apart.

import {
  DoubleSide,
  Frustum,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Sphere,
  Vector3,
  type BufferGeometry,
  type Material,
  type PerspectiveCamera,
  type Scene,
} from 'three';
import { B, BUILDING_KINDS, ITEM_PART, SHIELD, U, UNIT_KINDS, ALIEN_KINDS, alienInfo, isBelt, unitInfo } from '../sim/kinds.ts';
import { BF_COMPLETE, BF_FIRING, BF_UPGRADING, isReserved } from '../sim/schema.ts';
import type { Terrain } from '../sim/terrain.ts';
import { groundHeight as heightAt } from './ground.ts';
import { GATE_AXIS_Z as AXIS_Z, gateDepthOf as gateDepth } from './wallLayout.ts';
import { slotOf } from '../sim/table.ts';
import type { Snapshot } from '../sim/snapshot.ts';
import type { EffectTime } from './anim.ts';
import {
  alienGeometries,
  barGeometry,
  buildingGeometries,
  constructionFrameGeometry,
  dashedRingGeometry,
  itemGeometries,
  lineGeometry,
  projectileGeometries,
  reservedOutlineGeometry,
  selectionMarkerGeometry,
  shieldDomeGeometry,
  unitGeometries,
  wreckGeometry,
  type KindGeometry,
} from './geometry.ts';
import { LOD_FULL, LOD_ICON, LOD_LEVELS, LOD_THRESHOLDS, chooseLod } from './lod.ts';
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
const BDX = [1, 0, -1, 0];
const BDZ = [0, 1, 0, -1];

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

/** Kinds × three detail levels: mesh index = kind * LOD_LEVELS + lod. */
function kindBatch(scene: Scene, geoms: KindGeometry[], capacity: number, max: number, model: Material, icon: Material, iconOrder: number, name: string): Batch {
  const list: BufferGeometry[] = [];
  const mats: Material[] = [];
  for (const g of geoms) {
    list.push(g.full, g.simple, g.icon);
    mats.push(model, model, icon);
  }
  const b = new Batch(scene, list, mats, capacity, 0, max, `greybox/${name}`);
  b.meshes.forEach((m, i) => {
    if (i % LOD_LEVELS === LOD_ICON) m.renderOrder = iconOrder;
  });
  return b;
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

export class EntityRenderer {
  private readonly buildings: Batch;
  private readonly aliens: Batch;
  private readonly units: Batch;
  private readonly wrecks: Batch;
  private readonly items: Batch;
  private readonly shots: Batch;
  private readonly lines: Batch; // 0 beam, 1 work line
  private readonly shields: Batch; // 0 dome, 1 ring
  private readonly frames: Batch;
  private readonly reserved: Batch;
  private readonly bars: Batch; // 0 back, 1 fill
  private readonly markers: Batch;
  private readonly lod: { b: Uint8Array; bId: Uint32Array; a: Uint8Array; aId: Uint32Array; u: Uint8Array; uId: Uint32Array; w: Uint8Array; wId: Uint32Array };
  /** Row of each live alien / building / wreck by slot, for id lookups this frame. */
  private readonly alienRow: Int32Array;
  private readonly buildingRow: Int32Array;
  private readonly wreckRow: Int32Array;
  /** Draw building, unit, alien and wreck models (greybox view); false: overlays only. */
  readonly models: boolean;
  private readonly frustum = new Frustum();
  private readonly projView = new Matrix4();
  private readonly sphere = new Sphere();
  private readonly camPos = new Vector3();
  readonly counts: LodCounts = { full: 0, simple: 0, icon: 0, culled: 0 };
  private readonly terrain: Terrain;
  private wppPerDist = 0;

  constructor(scene: Scene, terrain: Terrain, capacity: Capacity, opts: { models: boolean }) {
    this.terrain = terrain;
    this.models = opts.models;
    const C = capacity;
    const L = (n: number) => new Uint8Array(n).fill(255);
    this.lod = { b: L(C.buildings), bId: new Uint32Array(C.buildings), a: L(C.aliens), aId: new Uint32Array(C.aliens), u: L(C.units), uId: new Uint32Array(C.units), w: L(C.wrecks), wId: new Uint32Array(C.wrecks) };
    this.alienRow = new Int32Array(C.aliens);
    this.buildingRow = new Int32Array(C.buildings);
    this.wreckRow = new Int32Array(C.wrecks);
    const model = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const icon = new MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false });
    const flat = new MeshBasicMaterial({ vertexColors: true });
    // Starting sizes as before; each grows up to what the simulation's tables allow.
    this.buildings = kindBatch(scene, buildingGeometries(), 1536, C.buildings, model, icon, 10, 'building');
    this.aliens = kindBatch(scene, alienGeometries(), 2048, C.aliens, model, icon, 11, 'alien');
    this.units = kindBatch(scene, unitGeometries(), 64, C.units, model, icon, 12, 'unit');
    this.wrecks = kindBatch(scene, [wreckGeometry()], 2048, C.wrecks, model, icon, 9, 'wreck');
    this.items = new Batch(scene, itemGeometries(), [model], 1536, 0, C.buildings);
    this.shots = new Batch(scene, projectileGeometries(), [flat], 2048, 0, C.projectiles);
    this.lines = new Batch(scene, [lineGeometry(0.12, '#cfeeff'), lineGeometry(0.05, '#a8f5df')], [flat], 512, 0, C.buildings + C.units);
    const dome = new MeshBasicMaterial({ color: '#cfe6ff', transparent: true, opacity: 0.12, depthWrite: false, side: DoubleSide });
    this.shields = new Batch(scene, [shieldDomeGeometry(), dashedRingGeometry()], [dome, flat], 128, 0, C.buildings);
    // W24 run 3 (D1): frames are depth-tested on their own material (a building in front hides the
    // part behind it), offset towards the camera so a frame on the ground does not flicker; the
    // strategic icons keep theirs, drawn over everything.
    const frame = new MeshBasicMaterial({ name: 'construction-frame', vertexColors: true, depthTest: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    this.frames = new Batch(scene, [constructionFrameGeometry()], [frame], 512, 14, C.buildings);
    this.reserved = new Batch(scene, [reservedOutlineGeometry()], [icon], 1024, 14, C.buildings);
    const back = new MeshBasicMaterial({ color: '#120f0d', depthTest: false, depthWrite: false });
    const fill = new MeshBasicMaterial({ color: '#f4efe6', depthTest: false, depthWrite: false });
    this.bars = new Batch(scene, [barGeometry(), barGeometry()], [back, fill], 1024, 13, C.buildings + C.aliens + C.units);
    this.bars.meshes[1]!.renderOrder = 14;
    // Selection markers test depth (Richard, 2026-10-09: the brackets of a unit behind a turret drew
    // over the turret), so buildings and terrain in front hide them; the strategic icons do not.
    const marker = new MeshBasicMaterial({ vertexColors: true, depthWrite: false });
    this.markers = new Batch(scene, [selectionMarkerGeometry()], [marker], 2048, 15, C.buildings + C.aliens + C.units + C.wrecks);
    if (BUILDING_KINDS.length + ALIEN_KINDS.length + UNIT_KINDS.length === 0) throw new Error('no kinds');
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

  /** Line from (x0, z0) to (x1, z1) at height y. */
  private line(k: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-3) return;
    this.lines.push(k, dx / len, -dz / len, len, 1, 1, x0, (y0 + y1) / 2, z0);
  }

  update(f: FrameInput): void {
    const { camera, viewportHeight: vh, snapshot: snap } = f;
    const t = this.terrain;
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
    this.alienRow.fill(-1);
    for (let r = 0; r < f.aliens.count; r++) this.alienRow[slotOf(f.aliens.id[r]!)] = r;
    this.buildingRow.fill(-1);
    for (let r = 0; r < snap.buildings.count; r++) this.buildingRow[slotOf(snap.buildings.id[r]!)] = r;
    this.wreckRow.fill(-1);
    for (let r = 0; r < snap.wrecks.count; r++) this.wreckRow[slotOf(snap.wrecks.id[r]!)] = r;

    this.drawBuildings(f, yc, ys);
    this.drawMobiles(f.aliens, this.aliens, this.lod.a, this.lod.aId, (k) => alienInfo(k).radius, () => ICON_PX.alien, (k) => alienInfo(k).hp, yc, ys, snap.aliens.cols.hp);
    this.drawMobiles(
      f.units,
      this.units,
      this.lod.u,
      this.lod.uId,
      (k) => unitInfo(k).radius,
      (k) => (k === U.commander ? ICON_PX.commander : ICON_PX.engineer),
      (k) => unitInfo(k).hp,
      yc,
      ys,
      snap.units.cols.hp,
    );
    if (this.models) this.drawWorkLines(f);
    this.drawWrecks(snap, yc, ys);
    if (this.models) this.drawShots(f.projectiles);
    this.drawSelection(f, wppd);
    for (const b of this.allBatches()) b.commit();
    void t;
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
      // Gates: modelled along x, 1 deep; axis z turns local x onto world +z. Depth stretches local z.
      const gateZ = kind === B.gate && c.dir[r] === AXIS_Z;
      const rc = belt ? BDX[c.dir[r]!]! : gateZ ? 0 : 1;
      const rs = belt ? -BDZ[c.dir[r]!]! : gateZ ? -1 : 0;
      const depth = kind === B.gate ? gateDepth(fw, fh, c.dir[r]!) : 1;
      const complete = (flags & BF_COMPLETE) !== 0;
      const reserved = isReserved(flags);
      const k = kind * LOD_LEVELS + lod;
      // Reserved: no build power yet, so nothing stands there: a dotted outline only.
      if (reserved) {
        if (!this.models) continue;
        const pad = Math.max(0, (ICON_PX.building + 3) * wppd * dist - size / 2) * (lod === LOD_ICON ? 1 : 0);
        this.reserved.push(0, 1, 0, fw / 2 + pad, 1, fh / 2 + pad, x, y + 0.1, z);
        continue;
      }
      if (!this.models) {
        // models.ts draws the building; nothing here
      } else if (lod === LOD_ICON) {
        const s = Math.max(size * 0.45, (belt ? ICON_PX.belt : ICON_PX.building) * wppd * dist) * (complete ? 1 : 0.7);
        if (belt) this.buildings.push(k, rc, rs, s, 1, s, x, y + 0.3, z);
        else this.buildings.push(k, yc, ys, s, 1, s, x, y + 0.3, z);
      } else {
        const sy = complete ? 1 : 0.15 + 0.85 * c.progress[r]!;
        this.buildings.push(k, rc, rs, 1, sy, depth, x, y, z);
      }
      // Construction or upgrade under way: a scaffold frame round the footprint (models view: the
      // build cut shows construction, so the frame marks upgrades only).
      if (this.models ? !complete || flags & BF_UPGRADING : complete && flags & BF_UPGRADING) {
        const pad = Math.max(0.15, (ICON_PX.building + 3) * wppd * dist - size / 2);
        this.frames.push(0, 1, 0, fw / 2 + pad, 1, fh / 2 + pad, x, y + 0.12, z);
      }
      if (lod !== LOD_ICON) {
        // Belt item.
        if (belt && c.item[r]! !== 0) {
          const p = c.itemPos[r]! - 0.5;
          this.items.push(Math.min(ITEM_PART, c.item[r]!), rc, rs, 1, 1, 1, x + BDX[c.dir[r]!]! * p, y + 0.12, z + BDZ[c.dir[r]!]! * p);
        }
        if (c.hp[r]! < c.maxHp[r]! - 0.5 && complete && !belt) this.bar(x, y + 2.4, z, c.hp[r]! / c.maxHp[r]!, size * 0.9, yc, ys);
      }
      // Beam turret firing: a beam to its target.
      if (this.models && kind === B.beam && flags & BF_FIRING && c.target[r]! > 0) {
        const ar = this.alienRow[slotOf(c.target[r]! - 1)]!;
        if (ar >= 0 && f.aliens.id[ar] === c.target[r]! - 1) {
          const ax = f.aliens.x[ar]!;
          const az = f.aliens.z[ar]!;
          this.line(0, x, y + 1.8, z, ax, heightAt(t, ax, az) + 0.5, az);
        }
      }
      // Shield bubble.
      if (shieldUp) {
        const frac = c.shield[r]! / SHIELD.capacity;
        this.shields.push(0, 1, 0, SHIELD.radius, SHIELD.radius * (0.25 + 0.35 * frac), SHIELD.radius, x, y, z);
        this.shields.push(1, 1, 0, SHIELD.radius, 1, SHIELD.radius, x, y + 0.1, z);
      }
    }
  }

  private drawMobiles(
    v: MobileView,
    set: Batch,
    state: Uint8Array,
    ids: Uint32Array,
    radius: (k: number) => number,
    iconPx: (k: number) => number,
    maxHp: (k: number) => number,
    yc: number,
    ys: number,
    hp: Float32Array,
  ) {
    const t = this.terrain;
    const wppd = this.wppPerDist;
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
      const k = kind * LOD_LEVELS + lod;
      if (lod === LOD_ICON) {
        const s = Math.max(rad, iconPx(kind) * wppd * dist);
        if (this.models) set.push(k, yc, ys, s, 1, s, x, y + 0.4, z);
      } else {
        const s = lod === LOD_FULL ? 1 : 1.6;
        if (this.models) set.push(k, v.fx[r]!, -v.fz[r]!, s, s, s, x, y, z);
        const m = maxHp(kind);
        if (hp[r]! < m - 0.5) this.bar(x, y + rad * 2 + 0.9, z, hp[r]! / m, Math.max(0.8, rad * 2), yc, ys);
      }
    }
  }

  private drawWorkLines(f: FrameInput) {
    const uc = f.snapshot.units.cols;
    const t = this.terrain;
    for (let r = 0; r < f.units.count; r++) {
      const target = uc.work[r]! - 1;
      if (target < 0) continue;
      const x = f.units.x[r]!;
      const z = f.units.z[r]!;
      const y = heightAt(t, x, z) + 0.6;
      const br = this.buildingRow[slotOf(target)]!;
      const B_ = f.snapshot.buildings;
      if (br >= 0 && B_.id[br] === target) {
        const bx = B_.cols.tx[br]! + B_.cols.fw[br]! / 2;
        const bz = B_.cols.ty[br]! + B_.cols.fh[br]! / 2;
        this.line(1, x, y, z, bx, heightAt(t, bx, bz) + 0.5, bz);
        continue;
      }
      const wr = this.wreckRow[slotOf(target)]!;
      const W_ = f.snapshot.wrecks;
      if (wr >= 0 && W_.id[wr] === target) {
        const wx = W_.cols.x[wr]!;
        const wz = W_.cols.z[wr]!;
        this.line(1, x, y, z, wx, heightAt(t, wx, wz) + 0.2, wz);
      }
    }
  }

  private drawWrecks(snap: Snapshot, yc: number, ys: number) {
    if (!this.models) return;
    const W_ = snap.wrecks;
    const t = this.terrain;
    for (let r = 0; r < W_.count; r++) {
      const x = W_.cols.x[r]!;
      const z = W_.cols.z[r]!;
      const y = heightAt(t, x, z);
      if (!this.visible(x, y, z, 1.2)) continue;
      const dist = this.distTo(x, y, z);
      const lod = this.lodFor(this.lod.w, this.lod.wId, W_.id[r]!, dist);
      const size = 0.5 + Math.min(1.2, Math.sqrt(W_.cols.salvage[r]! / 10));
      if (lod === LOD_ICON) {
        const s = Math.max(0.5, ICON_PX.wreck * this.wppPerDist * dist);
        this.wrecks.push(lod, yc, ys, s, 1, s, x, y + 0.25, z);
      } else this.wrecks.push(lod, 1, 0, size, size, size, x, y, z);
    }
  }

  private drawShots(v: MobileView) {
    const t = this.terrain;
    const far = LOD_THRESHOLDS[1]! * 1.1;
    for (let r = 0; r < v.count; r++) {
      const x = v.x[r]!;
      const z = v.z[r]!;
      const y = heightAt(t, x, z) + 0.9;
      if (this.distTo(x, y, z) > far || !this.visible(x, y, z, 0.5)) continue;
      this.shots.push(v.kind[r]!, v.fx[r]!, -v.fz[r]!, 1, 1, 1, x, y, z);
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

  /** Reserved sites drawn last frame (dotted outlines). */
  get reservedDrawn(): number {
    return this.reserved.counts[0]!;
  }

  private allBatches(): Batch[] {
    return [this.buildings, this.aliens, this.units, this.wrecks, this.items, this.shots, this.lines, this.shields, this.frames, this.reserved, this.bars, this.markers];
  }
}

function findRow(ids: Uint32Array, count: number, id: number): number {
  for (let r = 0; r < count; r++) if (ids[r] === id) return r;
  return -1;
}
