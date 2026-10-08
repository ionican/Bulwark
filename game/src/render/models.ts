// Snapshot-driven model drawing for W24 run 2a: every building, unit, alien and wreck drawn with the
// W17–W23 models in its static pose, on the one ground surface (ground.ts). Inventory (PLAN, frozen):
//
//   wall, gate                  W23 walls and gates through WallLayout (layout key, rebuild only on
//                               topology change); doors closed
//   massExtractor, rareExtractor W23 extractors (idle pose) on their deposits; bare deposits W23's
//   gun, area, beam, heavy,     W22 kit kinds bastion, anvil, lantern, rampart, lookout: the kit's
//     tempTurret                parts placed by the kit's pivots (pose.ts), yaw only, towards the
//                               snapshot target; submitted to the shared part batches, one batch per
//                               part × material × level shared by every kind (W22 strategy B)
//   generator … shield, belt    W17 procedural models (w17Batches.ts)
//   splitter, merger            W17 belt plus a distinct top marker each (fan-out / fan-in chevrons)
//   commander, engineer         W23 rigs, placed and posed at rest each frame (no gait yet)
//   rusher … saboteur           W17/W21 alien models, 1.5 × (W21's scale), tilted to the ground
//   wrecks                      W21's debris model
//
// Construction (PLAN "Construction"): reserved = dotted outline only; started = the model cut at
// base + height × progress per instance (W23's cut and depth material; materials.ts patches W17's
// materials the same way); complete = the model. Damage: two states from the hit-point fraction
// (below 2/3 scuffed, below 1/3 heavily damaged) on complete buildings.
// Foundations: each building stands at the highest ground under its footprint on a plinth down to
// the lowest (ground.ts footprintRange), so it neither sinks nor floats on a slope.
// Detail levels per object by camera distance with hysteresis (W21's rule, W23's thresholds);
// level 3 is the strategic icon (icons.ts), one per kind, told apart by shape.
// Capacities: every batch grows up to a maximum derived from the simulation's table capacities
// passed in by the caller; `overflowed` reports an instance dropped past it.

import { BoxGeometry, Frustum, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Sphere, Vector3, DynamicDrawUsage, type BufferGeometry, type Material, type PerspectiveCamera, type Texture } from 'three';
import { B, U, isBelt } from '../sim/kinds.ts';
import { BF_COMPLETE, isReserved } from '../sim/schema.ts';
import { slotOf } from '../sim/table.ts';
import type { Terrain } from '../sim/terrain.ts';
import type { Snapshot } from '../sim/snapshot.ts';
import { footprintRange, groundHeight } from './ground.ts';
import { reservedOutlineGeometry } from './geometry.ts';
import { ICON, IconBatches, type IconName, type TurretIconSpecs } from './icons.ts';
import type { MobileView } from './interp.ts';
import type { RenderMaterials } from './materials.ts';
import { W17Batches, bakeModel, type BakedModel } from './w17Batches.ts';
import { WallLayout, type BuildingRows } from './wallLayout.ts';
import { worldPerPixel } from './cameraRig.ts';
import type { TurretMats } from './workshop/bench/surface.ts';
import { buildTurret } from './workshop/bench/turretModel.ts';
import { TurretRig } from './workshop/bench/turretRig.ts';
import { buildKit, type Kind, type Kit } from './workshop/kit/kit.ts';
import { writePart, writePivots } from './workshop/kit/pose.ts';
import { Builder, cbox, prism } from './workshop/models/kit.ts';
import { BUILDING_MAKERS } from './workshop/models/procedural/buildings.ts';
import { ALIEN_MAKERS } from './workshop/models/procedural/aliens.ts';
import type { ModelDef } from './workshop/models/types.ts';
import { Rand } from './workshop/noise.ts';
import { PartBatches } from './workshop/w23/batches.ts';
import { EXTRACTOR_HEIGHT, FLOW_SEGS, extractorBuilders, extractorMatrix, extractorPose, flowSegment, pivotMatrix, type ExtractorPose } from './workshop/w23/extractors.ts';
import { HYSTERESIS, LEVEL_NEW, chooseLevel } from './workshop/stress/lod.ts';
import { THRESHOLDS, type AssetKind } from './workshop/w23/lod.ts';
import { BUILT } from './workshop/w23/mats.ts';
import { PartSet, type PartDef } from './workshop/w23/parts.ts';
import { CMD_PARTS, CMD_SEGS, CommanderRig, commanderBuilders } from './workshop/w23/rig/commander.ts';
import { EngineerRig, VARIANTS, engineerBuilders, engineerSimple, segmentParts } from './workshop/w23/rig/engineer.ts';
import { wallBuilders } from './workshop/w23/walls/geometry.ts';
import { PYLON_H, TIERS } from './workshop/w23/walls/layout.ts';

/** Game turret kind → W22 kit kind (PLAN inventory, frozen). */
export const TURRET_KINDS: ReadonlyMap<number, string> = new Map([
  [B.gun, 'bastion'],
  [B.area, 'anvil'],
  [B.beam, 'lantern'],
  [B.heavy, 'rampart'],
  [B.tempTurret, 'lookout'],
]);
/**
 * Kit turrets are modelled for a 2 × 2 footprint; the heavy cannon's is 3 × 3 and the temporary
 * turret's 1 × 1, so those two are scaled about their footprint centre.
 */
export const TURRET_SCALE: ReadonlyMap<number, number> = new Map([
  [B.gun, 1],
  [B.area, 1],
  [B.beam, 1],
  [B.heavy, 1.35],
  [B.tempTurret, 0.6],
]);
/** Game building kinds drawn with W17 procedural models (W17 maker name). */
export const W17_BUILDING_MODEL: ReadonlyMap<number, string> = new Map([
  [B.generator, 'generator'],
  [B.lab, 'lab'],
  [B.depot, 'depot'],
  [B.shredder, 'shredder'],
  [B.smelter, 'smelter'],
  [B.assembler, 'assembler'],
  [B.shield, 'shield'],
  [B.belt, 'belt'],
  [B.splitter, 'belt'],
  [B.merger, 'belt'],
]);
export const KIT_IDS = ['bastion', 'anvil', 'lantern', 'rampart', 'lookout'] as const;
/** Alien draw scale (W17/W20/W21: drawn 1.5 × their simulation size). */
export const ALIEN_SCALE = 1.5;
/** Icon of each building kind. */
const BUILDING_ICON: Record<number, IconName> = {
  [B.massExtractor]: 'mass',
  [B.generator]: 'generator',
  [B.rareExtractor]: 'rare',
  [B.lab]: 'lab',
  [B.depot]: 'depot',
  [B.shredder]: 'shredder',
  [B.smelter]: 'smelter',
  [B.assembler]: 'assembler',
  [B.wall]: 'wall',
  [B.gun]: 'gun',
  [B.area]: 'area',
  [B.beam]: 'beam',
  [B.heavy]: 'heavy',
  [B.shield]: 'shield',
  [B.tempTurret]: 'tempTurret',
  [B.belt]: 'belt',
  [B.splitter]: 'splitter',
  [B.merger]: 'merger',
  [B.gate]: 'gate',
};
const ALIEN_ICON: IconName[] = ['rusher', 'hunter', 'breaker', 'saboteur'];
const ALIEN_MODEL_NAMES = ['rusher', 'hunter', 'breaker', 'saboteur'] as const;
/** Icon quad size in screen pixels (the drawn shape fills about 70 % of it). */
const ICON_PX = { building: 26, belt: 12, alien: 17, commander: 34, engineer: 20, wreck: 11 } as const;
const BELT_YAW = [0, -Math.PI / 2, Math.PI, Math.PI / 2];
export const ICON_LEVEL = 3;
/** Thresholds (tiles from the camera) for W17 buildings, aliens and wrecks: model, or icon beyond. */
const W17_THRESHOLDS = [24, 85, 160];

export interface ModelCapacity {
  buildings: number;
  aliens: number;
  units: number;
  wrecks: number;
}

export interface ModelFrame {
  camera: PerspectiveCamera;
  viewportHeight: number;
  /** Camera rig yaw (icons turn so their "up" is screen-up). */
  yaw: number;
  snapshot: Snapshot;
  aliens: MobileView;
  units: MobileView;
}

export interface ModelCounts {
  full: number;
  middle: number;
  simple: number;
  icon: number;
  culled: number;
}

/** Material stand-ins for building the kit geometry: the builder only needs material names. */
function kitNameMats(): TurretMats {
  const m = (name: string) => new MeshStandardMaterial({ name });
  const t = { ceramic: m('ceramic'), gunmetal: m('gunmetal'), bronze: m('bronze'), dark: m('dark'), glow: m('glow'), brass: m('brass') };
  return { ...t, all: Object.values(t) };
}

function assetOf(id: string): AssetKind {
  if (id.startsWith('kit/')) return 'turret';
  if (id.startsWith('gate')) return 'gate';
  if (id.startsWith('mass') || id.startsWith('flow')) return 'mass';
  if (id.startsWith('rare')) return 'rare';
  if (id.startsWith('deposit')) return 'deposit';
  if (id.startsWith('eng')) return 'engineer';
  if (id.startsWith('cmd')) return 'commander';
  return 'wall';
}

/**
 * Splitter and merger top markers: a raised hub on the belt with arrowhead plates on it, so neither
 * is ever drawn like a plain belt. Splitter: one arrow in from the back, three out (front, left,
 * right). Merger: three in (back, left, right), one out at the front. Model +x is the belt's flow.
 */
function beltMarker(mats: RenderMaterials['w17'], kind: 'splitter' | 'merger'): ModelDef {
  const b = new Builder(mats);
  const y = 0.27;
  b.add('trim', prism(8, 0.13, 0.09, 0.012), { y: y - 0.07 });
  // an arrowhead plate pointing along `ang` (0 = +x), tip at distance r from the hub centre
  const arrow = (ang: number, r: number, s: number) => {
    const tri = prism(3, 0.14 * s, 0.05, 0.006, false); // a vertex on +x: the tip
    b.add('ivory', tri, { x: Math.cos(ang) * (r - 0.07 * s), y: y + 0.02, z: -Math.sin(ang) * (r - 0.07 * s), ry: ang });
  };
  if (kind === 'splitter') {
    arrow(0, -0.2, 0.85);
    for (const a of [0, Math.PI / 2, -Math.PI / 2]) arrow(a, 0.42, 1);
  } else {
    for (const a of [Math.PI, Math.PI / 2, -Math.PI / 2]) arrow(a + Math.PI, -0.22, 0.85);
    arrow(0, 0.44, 1.15);
  }
  const { geometry, material } = b.build();
  return { name: `${kind}Marker`, parts: [{ name: 'marker', geometry, material, pivot: new Matrix4(), motion: { kind: 'static' }, castShadow: true }], radius: 0.5, height: 0.36 };
}

/** W21's wreck debris (stress/aliens.ts AlienRenderer), one unit across. */
function wreckModel(mats: RenderMaterials['w17']): ModelDef {
  const wb = new Builder(mats);
  const r = new Rand(5);
  for (let i = 0; i < 9; i++) wb.add(i % 3 ? 'hull' : 'trim', cbox(r.range(0.2, 0.7), r.range(0.1, 0.35), r.range(0.2, 0.6), 0.03), { x: r.range(-0.8, 0.8), y: r.range(-0.05, 0.15), z: r.range(-0.7, 0.7), ry: r.range(0, 3), rz: r.range(-0.5, 0.5), rx: r.range(-0.4, 0.4) });
  const { geometry, material } = wb.build();
  return { name: 'wreck', parts: [{ name: 'debris', geometry, material, pivot: new Matrix4(), motion: { kind: 'static' }, castShadow: true }], radius: 1, height: 0.5 };
}

/** One instanced batch of a fixed geometry with per-instance matrices (plinths, outlines). */
class SimpleBatch {
  readonly mesh: InstancedMesh;
  count = 0;
  overflowed = false;

  constructor(geometry: BufferGeometry, material: Material, readonly max: number, name: string) {
    this.mesh = new InstancedMesh(geometry, material, Math.min(64, max));
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  push(x: number, y: number, z: number, sx: number, sy: number, sz: number): number {
    const m = this.mesh;
    if (this.count >= m.instanceMatrix.count) {
      const cap = m.instanceMatrix.count;
      if (cap >= this.max) {
        this.overflowed = true;
        return -1;
      }
      const n = Math.min(this.max, cap * 2);
      const a = new InstancedBufferAttribute(new Float32Array(n * 16), 16);
      a.setUsage(DynamicDrawUsage);
      (a.array as Float32Array).set(m.instanceMatrix.array as Float32Array);
      m.instanceMatrix = a;
      if (m.instanceColor) {
        const c = new InstancedBufferAttribute(new Float32Array(n * 3), 3);
        (c.array as Float32Array).set(m.instanceColor.array as Float32Array);
        m.instanceColor = c;
      }
    }
    const k = this.count++;
    const a = m.instanceMatrix.array as Float32Array;
    a.fill(0, k * 16, k * 16 + 16);
    a[k * 16] = sx;
    a[k * 16 + 5] = sy;
    a[k * 16 + 10] = sz;
    a[k * 16 + 12] = x;
    a[k * 16 + 13] = y;
    a[k * 16 + 14] = z;
    a[k * 16 + 15] = 1;
    return k;
  }

  commit(): void {
    const m = this.mesh;
    m.count = this.count;
    m.visible = this.count > 0;
    if (this.count) {
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, this.count * 16);
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
}

const _m = new Matrix4();
const _m2 = new Matrix4();
const _q = new Quaternion();
const _qt = new Quaternion();
const _p = new Vector3();
const _s = new Vector3(1, 1, 1);
const _n = new Vector3();
const UP = new Vector3(0, 1, 0);

export class ModelRenderer {
  readonly group = new Group();
  readonly parts = new PartSet();
  readonly batches: PartBatches;
  readonly w17: W17Batches;
  readonly icons: IconBatches;
  readonly walls: WallLayout;
  readonly kit: Kit;
  readonly kitKinds = new Map<number, Kind>();
  private readonly kitPart: PartDef[] = [];
  private readonly models: BakedModel[] = [];
  private readonly modelIndex = new Map<string, number>();
  private readonly plinths: SimpleBatch;
  private readonly outlines: SimpleBatch;
  /** Fixed detail level for every object (tests and the detail-level check), or null. */
  forcedLevel: number | null = null;
  /** Frustum culling (off in tests that must see every object). */
  cull = true;
  readonly counts: ModelCounts = { full: 0, middle: 0, simple: 0, icon: 0, culled: 0 };

  private readonly lv: { b: Uint8Array; bId: Uint32Array; a: Uint8Array; aId: Uint32Array; u: Uint8Array; uId: Uint32Array; w: Uint8Array; wId: Uint32Array; d: Uint8Array };
  private readonly turretYaw: Float32Array;
  private readonly turretYawId: Uint32Array;
  private readonly rigs: Array<EngineerRig | CommanderRig | null>;
  private readonly rigId: Uint32Array;
  private readonly alienRow: Int32Array;
  private readonly extractorAt = new Map<number, number>();
  private readonly frustum = new Frustum();
  private readonly projView = new Matrix4();
  private readonly sphere = new Sphere();
  private readonly camPos = new Vector3();
  private readonly pivots = new Float32Array(96);
  private readonly tmp = new Float32Array(16);
  private readonly pose: ExtractorPose = { spin: 0, slide: 0, fill: 0, light: 0, flow: [] };
  private wppd = 0;
  private iconYaw = 0;
  private readonly ground: (x: number, z: number) => number;

  constructor(
    readonly terrain: Terrain,
    readonly materials: RenderMaterials,
    readonly capacity: ModelCapacity,
    /** Builds the icon atlas once the kit's turret icon specs are known (tests: any texture). */
    makeAtlas: (turrets: TurretIconSpecs) => Texture,
  ) {
    this.group.name = 'models';
    this.ground = (x, z) => groundHeight(terrain, x, z);
    // ---- W23 parts: walls, gates, extractors, deposits, engineers, commander
    const engSimple = engineerSimple();
    for (const builders of [wallBuilders(), extractorBuilders(), engineerBuilders(), commanderBuilders()])
      for (const [id, fn] of builders) this.parts.add(id, assetOf(id), fn, { shadow: !id.startsWith('flow') && !id.endsWith('/light'), levels: engSimple.has(id) ? { 2: engSimple.get(id)! } : undefined });
    // ---- W22 kit: the five game turret kinds; each part becomes a shared part of the batches
    const tm = kitNameMats();
    const w20 = buildTurret(tm);
    this.kit = buildKit(tm, w20, new TurretRig(w20, tm, 'simple'), KIT_IDS);
    for (const p of this.kit.parts) this.kitPart[p.index] = this.parts.addPieces(`kit/${p.id}`, 'turret', p.levels, true);
    for (const [game, id] of TURRET_KINDS) this.kitKinds.set(game, this.kit.kinds.find((k) => k.id === id)!);
    const C = capacity;
    const deposits = terrain.deposits.length;
    this.batches = new PartBatches(this.parts.parts, materials.asset, (p) => {
      switch (p.asset) {
        case 'wall':
        case 'gate':
          return C.buildings * 8;
        case 'mass':
        case 'rare':
        case 'deposit':
          return Math.max(1, deposits) * FLOW_SEGS;
        case 'engineer':
        case 'commander':
          return C.units * 2;
        default:
          return C.buildings;
      }
    });
    this.group.add(this.batches.group);
    // ---- W17 models: buildings, belt markers, aliens, wreck debris
    const w = materials.w17;
    const addModel = (key: string, def: ModelDef, scale = 1) => {
      this.modelIndex.set(key, this.models.length);
      this.models.push(bakeModel(def, scale));
    };
    for (const name of new Set(W17_BUILDING_MODEL.values())) addModel(name, BUILDING_MAKERS[name as keyof typeof BUILDING_MAKERS](w));
    addModel('splitterMarker', beltMarker(w, 'splitter'));
    addModel('mergerMarker', beltMarker(w, 'merger'));
    for (const a of ALIEN_MODEL_NAMES) addModel(a, ALIEN_MAKERS[a](materials.alien), ALIEN_SCALE);
    addModel('wreck', wreckModel(w));
    const alienModel = new Set(ALIEN_MODEL_NAMES.map((a) => this.modelIndex.get(a)!));
    const wreckIdx = this.modelIndex.get('wreck')!;
    this.w17 = new W17Batches(this.models, materials.depth, (i) => (alienModel.has(i) ? C.aliens : i === wreckIdx ? C.wrecks : C.buildings));
    this.group.add(this.w17.group);
    // ---- icons, plinths, reserved outlines
    this.icons = new IconBatches(makeAtlas(ModelRenderer.turretIcons(this.kit, this.kitKinds)), C.buildings + C.aliens + C.units + C.wrecks);
    this.group.add(this.icons.group);
    const box = new BoxGeometry(1, 1, 1).translate(0, -0.5, 0);
    this.plinths = new SimpleBatch(box, materials.plinth, C.buildings, 'plinth');
    this.plinths.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(64 * 3).fill(BUILT), 3);
    this.plinths.mesh.castShadow = true;
    this.plinths.mesh.receiveShadow = true;
    this.plinths.mesh.customDepthMaterial = materials.depth;
    this.outlines = new SimpleBatch(reservedOutlineGeometry(), materials.outline, C.buildings, 'reserved-outline');
    this.outlines.mesh.renderOrder = 14;
    this.group.add(this.plinths.mesh, this.outlines.mesh);
    this.walls = new WallLayout(terrain);
    const L = (n: number) => new Uint8Array(n).fill(LEVEL_NEW);
    this.lv = { b: L(C.buildings), bId: new Uint32Array(C.buildings), a: L(C.aliens), aId: new Uint32Array(C.aliens), u: L(C.units), uId: new Uint32Array(C.units), w: L(C.wrecks), wId: new Uint32Array(C.wrecks), d: L(deposits) };
    this.turretYaw = new Float32Array(C.buildings).fill(Math.PI / 2);
    this.turretYawId = new Uint32Array(C.buildings).fill(0xffffffff);
    this.rigs = new Array(C.units).fill(null);
    this.rigId = new Uint32Array(C.units).fill(0xffffffff);
    this.alienRow = new Int32Array(C.aliens);
  }

  /** Kit icon spec of each game turret kind, for the atlas. */
  static turretIcons(kit: Kit, kinds: ReadonlyMap<number, Kind>): TurretIconSpecs {
    const out: TurretIconSpecs = {};
    for (const [game, kind] of kinds) out[BUILDING_ICON[game]!] = kit.icons[kind.icon]!;
    return out;
  }

  get overflowed(): boolean {
    return this.batches.overflowed || this.w17.overflowed || this.icons.overflowed || this.plinths.overflowed || this.outlines.overflowed;
  }

  /** Part definition of a W22 kit part (for tests). */
  kitPartDef(index: number): PartDef {
    return this.kitPart[index]!;
  }

  private visible(x: number, y: number, z: number, r: number): boolean {
    if (!this.cull) return true;
    this.sphere.center.set(x, y, z);
    this.sphere.radius = r;
    return this.frustum.intersectsSphere(this.sphere);
  }

  private dist(x: number, y: number, z: number): number {
    return Math.hypot(x - this.camPos.x, y - this.camPos.y, z - this.camPos.z);
  }

  private level(state: Uint8Array, ids: Uint32Array | null, slot: number, id: number, d: number, th: readonly number[]): number {
    if (this.forcedLevel !== null) return this.forcedLevel;
    const prev = ids && ids[slot] !== id ? LEVEL_NEW : state[slot]!;
    const l = chooseLevel(prev, d, th, HYSTERESIS);
    state[slot] = l;
    if (ids) ids[slot] = id;
    return l;
  }

  private tally(l: number): void {
    if (l === 0) this.counts.full++;
    else if (l === 1) this.counts.middle++;
    else if (l === 2) this.counts.simple++;
    else this.counts.icon++;
  }

  /** Icon of `size` tiles, or `px` pixels if that is larger. */
  private icon(name: IconName, x: number, y: number, z: number, size: number, px: number, yaw = this.iconYaw): void {
    const s = Math.max(size, px * this.wppd * this.dist(x, y, z));
    this.icons.push(ICON[name], x, y, z, yaw, s);
  }

  update(f: ModelFrame): void {
    const cam = f.camera;
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    this.camPos.copy(cam.position);
    this.wppd = worldPerPixel(cam, 1, f.viewportHeight);
    // icon "up" = screen-up: the camera's forward direction on the ground
    this.iconYaw = Math.atan2(Math.cos(f.yaw), -Math.sin(f.yaw));
    const c = this.counts;
    c.full = c.middle = c.simple = c.icon = c.culled = 0;
    this.batches.begin();
    this.w17.begin();
    this.icons.begin();
    this.plinths.count = 0;
    this.outlines.count = 0;
    const snap = f.snapshot;
    this.alienRow.fill(-1);
    for (let r = 0; r < f.aliens.count; r++) this.alienRow[slotOf(f.aliens.id[r]!)] = r;
    this.walls.update(rowsOf(snap));
    this.drawBuildings(f);
    this.drawDeposits();
    this.drawUnits(f.units);
    this.drawAliens(f.aliens);
    this.drawWrecks(snap);
    this.batches.commit();
    this.w17.commit();
    this.icons.commit();
    this.plinths.commit();
    this.outlines.commit();
  }

  private drawBuildings(f: ModelFrame): void {
    const snap = f.snapshot;
    const col = snap.buildings.cols;
    const t = this.terrain;
    const W = t.w;
    this.extractorAt.clear();
    for (let r = 0; r < snap.buildings.count; r++) {
      const id = snap.buildings.id[r]!;
      const kind = col.kind[r]!;
      const flags = col.flags[r]!;
      const tx = col.tx[r]!;
      const ty = col.ty[r]!;
      const fw = col.fw[r]!;
      const fh = col.fh[r]!;
      const reserved = isReserved(flags);
      if ((kind === B.massExtractor || kind === B.rareExtractor) && !reserved) this.extractorAt.set(ty * W + tx, r);
      const { top, bottom } = footprintRange(t, tx, ty, fw, fh);
      const cx = tx + fw / 2;
      const cz = ty + fh / 2;
      if (!this.visible(cx, top + 1, cz, Math.max(fw, fh) * 0.75 + 1.5)) {
        this.counts.culled++;
        continue;
      }
      const slot = slotOf(id);
      const d = this.dist(cx, top, cz);
      const th = kind === B.wall ? THRESHOLDS.wall : kind === B.gate ? THRESHOLDS.gate : W17_BUILDING_MODEL.has(kind) ? W17_THRESHOLDS : THRESHOLDS.turret;
      const lv = this.level(this.lv.b, this.lv.bId, slot, id, d, th);
      this.tally(lv);
      if (reserved) {
        // no build power yet: nothing stands there, a dotted outline marks the held tiles
        this.outlines.push(cx, top + 0.06, cz, fw / 2, 1, fh / 2);
        continue;
      }
      const complete = (flags & BF_COMPLETE) !== 0;
      const progress = col.progress[r]!;
      const frac = col.maxHp[r]! > 0 ? col.hp[r]! / col.maxHp[r]! : 1;
      const damage = complete ? (frac > 2 / 3 ? 0 : frac > 1 / 3 ? 1 : 2) : 0;
      if (lv === ICON_LEVEL) {
        this.buildingIcon(kind, r, snap, cx, top, cz, fw, fh);
        continue;
      }
      if (top - bottom > 0.01) {
        const k = this.plinths.push(cx, top + 0.02, cz, fw, top - bottom + 0.1, fh);
        if (k >= 0) (this.plinths.mesh.instanceColor!.array as Float32Array).set([1, 0, BUILT], k * 3);
      }
      const cutOf = (height: number) => (complete ? BUILT : top + height * progress);
      if (kind === B.wall) {
        const tile = ty * W + tx;
        const first = this.walls.first[tile]!;
        const n = this.walls.count[tile]!;
        const cut = cutOf(TIERS[Math.max(1, Math.min(3, col.tier[r]!))]!.top + 0.3);
        for (let k = 0; k < n; k++) this.batches.push(this.parts.get(this.walls.parts[first + k]!), lv, this.walls.matrices, (first + k) * 16, 1, damage + 10, cut);
      } else if (kind === B.gate) {
        const pieces = this.walls.gates.get(ty * W + tx);
        const cut = cutOf(PYLON_H + 0.3);
        if (pieces) for (const pc of pieces) this.batches.push(this.parts.get(pc.part), lv, pc.m, 0, pc.part === 'gate/leaf' ? 0.6 : 1, pc.part === 'gate/leaf' ? damage : damage + 10, cut);
      } else if (kind === B.massExtractor || kind === B.rareExtractor) {
        this.drawExtractor(kind === B.massExtractor ? 'mass' : 'rare', cx, top, cz, complete ? 1 : progress, damage, lv);
      } else if (TURRET_KINDS.has(kind)) {
        this.drawTurret(kind, r, f, cx, top, cz, damage, complete, progress, lv);
      } else {
        const name = W17_BUILDING_MODEL.get(kind);
        if (name === undefined) continue;
        const mi = this.modelIndex.get(name)!;
        const model = this.models[mi]!;
        const yaw = isBelt(kind) ? BELT_YAW[col.dir[r]! & 3]! : 0;
        _m.makeRotationY(yaw).setPosition(cx, top, cz);
        const cut = cutOf(model.height + 0.2);
        this.w17.push(mi, _m.elements, 0, 1, damage, cut);
        if (kind === B.splitter || kind === B.merger) this.w17.push(this.modelIndex.get(kind === B.splitter ? 'splitterMarker' : 'mergerMarker')!, _m.elements, 0, 1, damage, cut);
      }
    }
  }

  private buildingIcon(kind: number, r: number, snap: Snapshot, cx: number, top: number, cz: number, fw: number, fh: number): void {
    const y = top + 0.4;
    if (kind === B.wall) return this.icon('wall', cx, y, cz, 1, 0);
    if (kind === B.gate) {
      // the gate icon's gap runs across the passage: turn it to the run axis
      const alongZ = snap.buildings.cols.dir[r] === 1;
      return this.icon('gate', cx, y, cz, 3.2, 0, alongZ ? 0 : Math.PI / 2);
    }
    if (isBelt(kind)) return this.icon(BUILDING_ICON[kind]!, cx, y, cz, 0.9, ICON_PX.belt, BELT_YAW[snap.buildings.cols.dir[r]! & 3]!);
    if (TURRET_KINDS.has(kind)) {
      const slot = slotOf(snap.buildings.id[r]!);
      return this.icon(BUILDING_ICON[kind]!, cx, y, cz, Math.max(fw, fh) * 0.9, ICON_PX.building, this.turretYaw[slot]!);
    }
    this.icon(BUILDING_ICON[kind]!, cx, y, cz, Math.max(fw, fh) * 0.9, ICON_PX.building);
  }

  private drawExtractor(kind: 'mass' | 'rare', x: number, y: number, z: number, built: number, damage: number, lv: number): void {
    const B_ = this.batches;
    const P = (id: string) => this.parts.get(id);
    const base = extractorMatrix(_m, { x, y, z, rot: 0 });
    const pose = extractorPose({ kind, x, y, z, rot: 0, built, working: false, t: 0, damage }, this.pose);
    const cut = built < 1 ? y + (EXTRACTOR_HEIGHT[kind] + 0.3) * built : BUILT;
    if (kind === 'mass') {
      B_.push(P('mass/base'), lv, base, 0, 1, damage, cut);
      B_.push(P('mass/drum'), lv, pivotMatrix(_m2, base, pose.spin, 0), 0, 1, damage, cut);
      B_.push(P('mass/head'), lv, pivotMatrix(_m2, base, 0, pose.slide), 0, 1, damage, cut);
      B_.push(P('mass/fill'), lv, pivotMatrix(_m2, base, 0, 0.08 + pose.fill), 0, 1, 0, cut);
      B_.push(P('mass/light'), lv, base, 0, pose.light * 2, 0, cut);
    } else {
      B_.push(P('rare/base'), lv, base, 0, 1, damage, cut);
      B_.push(P('rare/ring'), lv, pivotMatrix(_m2, base, pose.spin, 0), 0, 0.2, damage, cut);
      B_.push(P('rare/pump'), lv, pivotMatrix(_m2, base, 0, pose.slide), 0, 0.2, damage, cut);
      B_.push(P('rare/light'), lv, base, 0, pose.light * 2, 0, cut);
    }
    if (lv <= 1)
      for (let k = 0; k < FLOW_SEGS; k++) B_.push(P('flow/seg'), lv, pivotMatrix(_m2, base, 0, 0, flowSegment(kind, k)), 0, pose.flow[k]!, 0, cut);
  }

  private drawTurret(kind: number, r: number, f: ModelFrame, cx: number, top: number, cz: number, damage: number, complete: boolean, progress: number, lv: number): void {
    const k = this.kitKinds.get(kind)!;
    const s = TURRET_SCALE.get(kind) ?? 1;
    const col = f.snapshot.buildings.cols;
    const id = f.snapshot.buildings.id[r]!;
    const slot = slotOf(id);
    if (this.turretYawId[slot] !== id) {
      this.turretYawId[slot] = id;
      this.turretYaw[slot] = Math.PI / 2; // a new turret faces north, where the waves come from
    }
    // yaw only, towards the snapshot target (alien id + 1; 0 = none: keep the last yaw)
    const target = col.target[r]!;
    if (target > 0) {
      const ar = this.alienRow[slotOf(target - 1)]!;
      if (ar >= 0 && f.aliens.id[ar] === target - 1) this.turretYaw[slot] = Math.atan2(-(f.aliens.z[ar]! - cz), f.aliens.x[ar]! - cx);
    }
    const cut = complete ? BUILT : top + (k.top * s + 0.3) * progress;
    this.pushKit(k, cx, top, cz, this.turretYaw[slot]!, s, lv, damage, cut);
  }

  /** Every part of kit kind `k` at its level, placed on (x, y, z) with yaw, scaled by s. */
  pushKit(k: Kind, x: number, y: number, z: number, yaw: number, s: number, lv: number, damage = 0, cut = BUILT): void {
    const piv = this.pivots;
    const m = this.tmp;
    writePivots(piv, k.frame, 0, 0, 0, yaw, 0, 0, 0);
    for (const pl of k.placed) {
      if (pl.part.levels[lv]!.size === 0) continue;
      writePart(m, 0, piv, pl.pivot[lv]!, pl.off);
      for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) m[i]! *= s;
      m[12] = m[12]! * s + x;
      m[13] = m[13]! * s + y;
      m[14] = m[14]! * s + z;
      this.batches.push(this.kitPart[pl.part.index]!, lv, m, 0, 1, damage, cut);
    }
  }

  private drawDeposits(): void {
    const t = this.terrain;
    const P = (id: string) => this.parts.get(id);
    t.deposits.forEach((dp, i) => {
      const occupied = this.extractorAt.get(dp.ty * t.w + dp.tx);
      const x = dp.tx + 1;
      const z = dp.ty + 1;
      const { top } = footprintRange(t, dp.tx, dp.ty, 2, 2);
      if (!this.visible(x, top + 1, z, 2.4)) return;
      const lv = this.level(this.lv.d, null, i, 0, this.dist(x, top + 1, z), THRESHOLDS.deposit);
      if (lv === ICON_LEVEL) {
        if (occupied === undefined) this.icon(dp.kind === 'mass' ? 'massDeposit' : 'rareDeposit', x, top + 0.3, z, 2.4, 16);
        return;
      }
      const base = extractorMatrix(_m, { x, y: top, z, rot: 0 });
      if (dp.kind === 'mass') {
        if (occupied === undefined) {
          this.batches.push(P('deposit/massOre'), lv, base);
          this.batches.push(P('deposit/markerMass'), lv, base);
        }
      } else {
        this.batches.push(P('deposit/rareCrystal'), lv, base, 0, 0.45);
        if (occupied === undefined) this.batches.push(P('deposit/markerRare'), lv, base);
      }
    });
  }

  private drawUnits(v: MobileView): void {
    for (let r = 0; r < v.count; r++) {
      const id = v.id[r]!;
      const kind = v.kind[r]!;
      const x = v.x[r]!;
      const z = v.z[r]!;
      const y = this.ground(x, z);
      const commander = kind === U.commander;
      const h = commander ? 3.6 : 0.9;
      if (!this.visible(x, y + h / 2, z, h)) {
        this.counts.culled++;
        continue;
      }
      const slot = slotOf(id);
      const lv = this.level(this.lv.u, this.lv.uId, slot, id, this.dist(x, y + h / 2, z), commander ? THRESHOLDS.commander : THRESHOLDS.engineer);
      this.tally(lv);
      if (lv === ICON_LEVEL) {
        if (commander) this.icon('commanderRing', x, y + 0.4, z, 2.4, ICON_PX.commander);
        else this.icon('engineer', x, y + 0.4, z, 0.9, ICON_PX.engineer);
        continue;
      }
      const yaw = Math.atan2(-v.fz[r]!, v.fx[r]!);
      let rig = this.rigs[slot];
      if (this.rigId[slot] !== id || !rig || rig instanceof CommanderRig !== commander) {
        rig = commander ? new CommanderRig() : new EngineerRig(VARIANTS[id % VARIANTS.length]!);
        this.rigs[slot] = rig;
        this.rigId[slot] = id;
      }
      // static pose (2a): stand at rest on the ground, both feet planted on the sampled surface
      rig.place(x, z, yaw, this.ground);
      rig.update(0, x, z, yaw, this.ground);
      if (rig instanceof CommanderRig) {
        CMD_SEGS.forEach((s, k) => this.batches.push(this.parts.get(CMD_PARTS[s]), lv, rig.mats[k]!));
        if (lv >= 2) this.icon('commander', x, y + 4.2, z, 0, ICON_PX.commander * 0.8);
      } else {
        const er = rig as EngineerRig;
        segmentParts(er.variant, false).forEach((pid, k) => {
          if (pid) this.batches.push(this.parts.get(pid), lv, er.mats[k]!);
        });
        if (lv >= 2) this.icon('engineer', x, y + 1.2, z, 0, ICON_PX.engineer * 0.8);
      }
    }
  }

  /** The rig drawn for a unit slot (tests read its feet). */
  rigOf(id: number): EngineerRig | CommanderRig | null {
    const s = slotOf(id);
    return this.rigId[s] === id ? this.rigs[s]! : null;
  }

  private drawAliens(v: MobileView): void {
    const g = this.ground;
    for (let r = 0; r < v.count; r++) {
      const id = v.id[r]!;
      const kind = v.kind[r]!;
      const x = v.x[r]!;
      const z = v.z[r]!;
      const y = g(x, z);
      const mi = this.modelIndex.get(ALIEN_MODEL_NAMES[kind]!)!;
      const model = this.models[mi]!;
      if (!this.visible(x, y + 0.6, z, model.radius + 1)) {
        this.counts.culled++;
        continue;
      }
      const lv = this.level(this.lv.a, this.lv.aId, slotOf(id), id, this.dist(x, y, z), W17_THRESHOLDS);
      this.tally(lv);
      if (lv === ICON_LEVEL) {
        this.icon(ALIEN_ICON[kind]!, x, y + 0.4, z, model.radius, ICON_PX.alien, Math.atan2(-v.fz[r]!, v.fx[r]!));
        continue;
      }
      // tilt to the ground (W21), then the heading
      const e = 0.6;
      _n.set(g(x - e, z) - g(x + e, z), 2 * e, g(x, z - e) - g(x, z + e)).normalize();
      _qt.setFromUnitVectors(UP, _n);
      _q.setFromAxisAngle(UP, Math.atan2(-v.fz[r]!, v.fx[r]!)).premultiply(_qt);
      _m.compose(_p.set(x, y, z), _q, _s);
      this.w17.push(mi, _m.elements);
    }
  }

  private drawWrecks(snap: Snapshot): void {
    const W_ = snap.wrecks;
    const mi = this.modelIndex.get('wreck')!;
    for (let r = 0; r < W_.count; r++) {
      const id = W_.id[r]!;
      const x = W_.cols.x[r]!;
      const z = W_.cols.z[r]!;
      const y = this.ground(x, z);
      if (!this.visible(x, y, z, 1.6)) continue;
      const lv = this.level(this.lv.w, this.lv.wId, slotOf(id), id, this.dist(x, y, z), W17_THRESHOLDS);
      if (lv === ICON_LEVEL) {
        this.icon('wreck', x, y + 0.3, z, 0.6, ICON_PX.wreck);
        continue;
      }
      const size = 0.5 + Math.min(1.2, Math.sqrt(W_.cols.salvage[r]! / 10));
      _q.setFromAxisAngle(UP, (id % 97) * 0.37);
      _m.compose(_p.set(x, y, z), _q, _n.set(size, size, size));
      this.w17.push(mi, _m.elements);
    }
  }
}

/** The building columns the wall layout reads. */
export function rowsOf(s: Snapshot): BuildingRows {
  const c = s.buildings.cols;
  return { count: s.buildings.count, id: s.buildings.id, kind: c.kind, tier: c.tier, flags: c.flags, dir: c.dir, tx: c.tx, ty: c.ty, fw: c.fw, fh: c.fh };
}
