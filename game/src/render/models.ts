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
//
// W24 run 2b: animation and effects. anim.ts decides what moves and when (its header has the input
// matrix); this module poses the models by it — door leaves at their opening, turrets by yaw,
// pitch and recoil through the kit's pivots, extractors and the generator running, machines'
// moving parts, the engineers' build pose and carry pod — and hands beams, flashes, shots and smoke
// to effects.ts. Effect state advances for every building each frame before culling. W17 models
// with a moving part (generator vane, shredder rollers, assembler arm) are baked as the static
// model plus one model per moving part, keyed `<model>/<part>`. The lab dish and shield ring stay
// static. W27: `previewRun` sends buildings' draws to a capture instead of the batches, so the
// placement ghost and the drag preview are the same geometry at the same matrices.

import { BoxGeometry, Frustum, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Sphere, Vector3, type BufferGeometry, type PerspectiveCamera, type Texture } from 'three';
import { ALIEN_KINDS, B, U, buildingFootprint, isBelt } from '../sim/kinds.ts';
import { AS_ATTACKING, BF_COMPLETE, BF_FIRING, BF_STARTED, T_ALIEN, T_BUILDING, T_UNIT, isReserved } from '../sim/schema.ts';
import { slotOf } from '../sim/table.ts';
import type { Terrain } from '../sim/terrain.ts';
import type { Snapshot } from '../sim/snapshot.ts';
import { footprintRange, groundHeight } from './ground.ts';
import { reservedOutlineGeometry } from './geometry.ts';
import { ICON, IconBatches, type IconName, type TurretIconSpecs } from './icons.ts';
import { tagGroup, type MeshGroup } from './inspect.ts';
import type { MobileView } from './interp.ts';
import type { RenderMaterials } from './materials.ts';
import { W17Batches, bakeModel, type BakedModel } from './w17Batches.ts';
import { WallLayout, leafMatrices, type BuildingRows } from './wallLayout.ts';
import { ALIEN_AIM_HEIGHT, ALIEN_SCALE, Animator, REST_YAW, beamOf, carryLoad, flatPitch, gateWanted, isMachine, isTurret, recoils, runsWhenComplete, type EffectTime } from './anim.ts';
import { Effects } from './effects.ts';
import { SimpleBatch } from './simpleBatch.ts';
import { barrelPoint } from './workshop/stress/turretPose.ts';
import { ALIEN_PHASE_PER_TILE, Tracks, motionAt } from './walk.ts';
import { worldPerPixel } from './cameraRig.ts';
import type { TurretMats } from './workshop/bench/surface.ts';
import { buildTurret } from './workshop/bench/turretModel.ts';
import { TurretRig } from './workshop/bench/turretRig.ts';
import { buildKit, type Kind, type Kit } from './workshop/kit/kit.ts';
import { writePart, writePivots } from './workshop/kit/pose.ts';
import { Builder, cbox, prism } from './workshop/models/kit.ts';
import { BUILDING_MAKERS, SMELTER_CHIMNEY_TOPS } from './workshop/models/procedural/buildings.ts';
import { ALIEN_MAKERS } from './workshop/models/procedural/aliens.ts';
import type { ModelDef, Motion } from './workshop/models/types.ts';
import { Rand } from './workshop/noise.ts';
import { PartBatches } from './workshop/w23/batches.ts';
import { EXTRACTOR_HEIGHT, FLOW_SEGS, extractorBuilders, extractorMatrix, extractorPose, flowSegment, pivotMatrix, type ExtractorPose } from './workshop/w23/extractors.ts';
import { HYSTERESIS, LEVEL_NEW, chooseLevel } from './workshop/stress/lod.ts';
import { THRESHOLDS, type AssetKind } from './workshop/w23/lod.ts';
import { BUILT } from './workshop/w23/mats.ts';
import { PartSet, type PartDef } from './workshop/w23/parts.ts';
import { CMD_PARTS, CMD_SEGS, CommanderRig, commanderBuilders } from './workshop/w23/rig/commander.ts';
import { EngineerRig, SEG, VARIANTS, engineerBuilders, engineerSimple, segmentParts } from './workshop/w23/rig/engineer.ts';
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
/** Alien draw scale (anim.ts, where the turrets' aim height uses it). */
export { ALIEN_SCALE };

/** W23 part assets drawn on units (every other asset draws buildings or deposits). */
const UNIT_ASSETS = new Set<string>(['engineer', 'commander']);
/** Icons that draw units, aliens and wrecks; every other icon draws a building or deposit. */
const ICON_GROUP = new Map<string, MeshGroup>([
  ['engineer', 'unit'],
  ['commander', 'unit'],
  ['commanderRing', 'unit'],
  ['wreck', 'wreck'],
  ...ALIEN_KINDS.map((k) => [k, 'alien'] as [string, MeshGroup]),
]);
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
  /** Projectile table capacity (run 2b effect pools); the buildings' if absent. */
  projectiles?: number;
}

/** W17 models with a moving part drawn separately (part name → its batch, run 2b). */
const MOVING_PARTS: Record<string, readonly string[]> = { generator: ['vane'], shredder: ['rollA', 'rollB'], assembler: ['arm'] };
/** Carry pod scale at no load and at a full load. */
const POD_MIN = 1.2;
const POD_MAX = 2.5;

/** Where one building's draw goes: the frame's batches, or a capture (W27 previews). */
export interface BuildingSink {
  part(part: PartDef, level: number, m: Matrix4 | Float32Array, o: number, glow: number, damage: number, cut: number): void;
  model(index: number, m: ArrayLike<number>, o: number, damage: number, cut: number): void;
  plinth(x: number, y: number, z: number, sx: number, sy: number, sz: number): void;
}

/** One captured instance of a preview: a geometry the batches draw, and its world matrix. */
export interface Captured {
  geometry: BufferGeometry;
  matrix: Float32Array;
}

/** This frame's pose of the building being drawn (anim.ts state, read by drawBuilding). */
interface BuildingPose {
  door: number;
  /** Change of the door opening this frame (+ opening, − closing). */
  doorDelta: number;
  yaw: number;
  pitch: number;
  recoil: number;
  run: number;
  working: boolean;
  flash: boolean;
  beam: boolean;
  /** Muzzle and barrel direction; the beam turret's target aim point. */
  mx: number;
  my: number;
  mz: number;
  dx: number;
  dy: number;
  dz: number;
  ax: number;
  ay: number;
  az: number;
}

/** A building at rest: doors shut, turret at its rest aim, nothing running or firing (W27 previews). */
const REST_POSE: Readonly<BuildingPose> = Object.freeze({ door: 0, doorDelta: 0, yaw: REST_YAW, pitch: 0, recoil: 0, run: 0, working: false, flash: false, beam: false, mx: 0, my: 0, mz: 0, dx: 1, dy: 0, dz: 0, ax: 0, ay: 0, az: 0 });

export interface ModelFrame {
  camera: PerspectiveCamera;
  viewportHeight: number;
  /** Camera rig yaw (icons turn so their "up" is screen-up). */
  yaw: number;
  snapshot: Snapshot;
  aliens: MobileView;
  units: MobileView;
  /** Seconds since the last frame, 0 while paused (walking: rigs ease and feet settle by it). */
  dt?: number;
  /** Run 2b: projectile rows (interpolated), and the effect clock (its `reset` marks a global reset). */
  projectiles?: MobileView;
  time?: EffectTime;
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

interface AlienPart {
  batch: number;
  /** Alien space (scaled 1.5 ×) → part, at rest. */
  pivot: Matrix4;
  motion: Motion;
}

/** W21's test for parts that can share a batch: identical position arrays. */
function samePositions(a: BufferGeometry, b: BufferGeometry): boolean {
  const pa = a.getAttribute('position').array;
  const pb = b.getAttribute('position').array;
  if (pa.length !== pb.length) return false;
  for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return false;
  return true;
}

const _m = new Matrix4();
const _m2 = new Matrix4();
const _mot = new Matrix4();
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
  /**
   * Run 2b activity of what is on screen (scripts/check-render.mjs): running totals of frames in
   * which a build or reclaim beam, a shot in flight, or a muzzle flash or on-screen turret beam was
   * committed for drawing (effects.ts activity), an attacking alien was drawn, and a gate drawn as a
   * model had its doors opening or closing. `now` is this frame's flags.
   */
  readonly activity = { frames: 0, beaming: 0, firing: 0, shots: 0, attacking: 0, doorOpening: 0, doorClosing: 0 };
  readonly activityNow = { beaming: false, firing: false, flash: false, shots: false, attacking: false, doorOpening: false, doorClosing: false };

  private readonly lv: { b: Uint8Array; bId: Uint32Array; a: Uint8Array; aId: Uint32Array; u: Uint8Array; uId: Uint32Array; w: Uint8Array; wId: Uint32Array; d: Uint8Array };
  /** Run 2b: effect state per building slot (anim.ts) and the effects drawn from it (effects.ts). */
  readonly anim: Animator;
  readonly effects: Effects;
  /** This frame's pose of the building being drawn (animateBuilding fills it, drawBuilding reads it). */
  private readonly bp: BuildingPose = { ...REST_POSE };
  /** Snapshot row by slot this frame (−1: none), and each building's top. */
  private readonly bRow: Int32Array;
  private readonly wRow: Int32Array;
  private readonly uRow: Int32Array;
  private readonly pRow: Int32Array;
  private readonly aSnapRow: Int32Array;
  private readonly bTop: Float32Array;
  /** Each turret's muzzle this frame, by slot, and the id it was written for (shots leave from it). */
  private readonly muzzle: Float32Array;
  private readonly muzzleId: Uint32Array;
  private readonly mz = new Float64Array(3);
  private readonly leaves = new Float32Array(64);
  private readonly chimneys: Array<[number, number, number]> = SMELTER_CHIMNEY_TOPS.map(() => [0, 0, 0]);
  private readonly movingParts = new Map<string, Array<{ batch: number; pivot: Matrix4; motion: Motion; rate: number }>>();
  private readonly frameSink: BuildingSink;
  private readonly beamAt = { reclaim: false, x: 0, y: 0, z: 0 };
  private readonly beamOfAt = { reclaim: false, id: 0 };
  private snap: Snapshot | null = null;
  /** The snapshot and alien rows the slot → row indexes were built for. */
  private rowsFor: Snapshot | null = null;
  private alienIdsFor: ArrayLike<number> | null = null;
  private alienCountFor = -1;
  private aliensView: MobileView | null = null;
  private previewWalls: WallLayout | null = null;
  private readonly rigs: Array<EngineerRig | CommanderRig | null>;
  private readonly rigId: Uint32Array;
  private readonly alienRow: Int32Array;
  /** Per alien kind: its parts (batch, scaled pivot, motion) and its drawn radius. */
  private readonly alienParts: Array<{ parts: AlienPart[]; radius: number }> = [];
  /** Walking state from snapshots (walk.ts): units' last position and heading, aliens' also their phase. */
  readonly unitTracks: Tracks;
  readonly alienTracks: Tracks;
  /** Frame number each unit's rig was last posed in (a rig not posed last frame is placed afresh). */
  private readonly rigFrame: Uint32Array;
  /**
   * Each unit slot's interpolated position this frame (x, z) and the frame it was written, culled or
   * not, and a rig posed at rest for the shot origin of a commander whose own rig was not posed this
   * frame (icon detail, off screen, or after a load).
   */
  private readonly unitAt: Float32Array;
  private readonly unitAtFrame: Uint32Array;
  private readonly restRig = new CommanderRig();
  private frameNo = 0;
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
    for (const name of new Set(W17_BUILDING_MODEL.values())) {
      const def = BUILDING_MAKERS[name as keyof typeof BUILDING_MAKERS](w);
      const moving = MOVING_PARTS[name] ?? [];
      addModel(name, { ...def, parts: def.parts.filter((pd) => !moving.includes(pd.name)) });
      const list: Array<{ batch: number; pivot: Matrix4; motion: Motion; rate: number }> = [];
      for (const pd of def.parts) {
        if (!moving.includes(pd.name)) continue;
        const key = `${name}/${pd.name}`;
        addModel(key, { name: key, parts: [{ ...pd, pivot: new Matrix4() }], radius: def.radius, height: def.height });
        list.push({ batch: this.modelIndex.get(key)!, pivot: pd.pivot.clone(), motion: pd.motion, rate: pd.motion.kind === 'spin' ? Math.abs(pd.motion.speed) : 1 });
      }
      if (list.length) this.movingParts.set(name, list);
    }
    addModel('splitterMarker', beltMarker(w, 'splitter'));
    addModel('mergerMarker', beltMarker(w, 'merger'));
    // aliens: one batch per distinct part geometry (W21: a rusher's four legs share one), each part
    // drawn at its pivot with its motion at the alien's gait phase (walk.ts)
    const alienBatchMax = new Map<number, number>();
    for (const a of ALIEN_MODEL_NAMES) {
      const def = ALIEN_MAKERS[a](materials.alien);
      const parts: AlienPart[] = [];
      const groups: Array<{ geo: BufferGeometry; mat: unknown; batch: number; n: number }> = [];
      for (const pd of def.parts) {
        let g = groups.find((x) => x.mat === pd.material && samePositions(x.geo, pd.geometry));
        if (!g) {
          const key = `${a}/${pd.name}`;
          addModel(key, { name: key, parts: [{ ...pd, pivot: new Matrix4() }], radius: def.radius, height: def.height });
          g = { geo: pd.geometry, mat: pd.material, batch: this.modelIndex.get(key)!, n: 0 };
          groups.push(g);
        }
        g.n++;
        parts.push({ batch: g.batch, pivot: new Matrix4().makeScale(ALIEN_SCALE, ALIEN_SCALE, ALIEN_SCALE).multiply(pd.pivot), motion: pd.motion });
      }
      for (const g of groups) alienBatchMax.set(g.batch, C.aliens * g.n);
      this.alienParts.push({ parts, radius: def.radius * ALIEN_SCALE });
    }
    addModel('wreck', wreckModel(w));
    const wreckIdx = this.modelIndex.get('wreck')!;
    this.w17 = new W17Batches(this.models, materials.depth, (i) => alienBatchMax.get(i) ?? (i === wreckIdx ? C.wrecks : C.buildings));
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
    this.anim = new Animator(C.buildings);
    const projectiles = C.projectiles ?? C.buildings;
    this.effects = new Effects({ buildings: C.buildings, units: C.units, projectiles });
    this.group.add(this.effects.group);
    // ---- what each mesh draws, for the scene inspection (inspect.ts reads userData.group)
    const assetOfPart = new Map(this.parts.parts.map((p) => [p.id, p.asset]));
    tagGroup(this.batches.group, (m) => (UNIT_ASSETS.has(assetOfPart.get(m.userData.part as string)!) ? 'unit' : 'building'));
    const alienModels = new Set([...alienBatchMax.keys()].map((i) => this.models[i]!.name));
    tagGroup(this.w17.group, (m) => (m.userData.model === 'wreck' ? 'wreck' : alienModels.has(m.userData.model as string) ? 'alien' : 'building'));
    tagGroup(this.icons.group, (m) => ICON_GROUP.get(m.userData.icon as string) ?? 'building');
    tagGroup(this.plinths.mesh, 'building');
    tagGroup(this.outlines.mesh, 'building');
    tagGroup(this.effects.group, 'overlay');
    this.bRow = new Int32Array(C.buildings);
    this.wRow = new Int32Array(C.wrecks);
    this.uRow = new Int32Array(C.units);
    this.pRow = new Int32Array(projectiles);
    this.aSnapRow = new Int32Array(C.aliens);
    this.bTop = new Float32Array(C.buildings);
    this.muzzle = new Float32Array(C.buildings * 3);
    this.muzzleId = new Uint32Array(C.buildings).fill(0xffffffff);
    this.frameSink = {
      part: (p, lv, m, o, glow, damage, cut) => this.batches.push(p, lv, m, o, glow, damage, cut),
      model: (i, m, o, damage, cut) => this.w17.push(i, m, o, 1, damage, cut),
      plinth: (x, y, z, sx, sy, sz) => {
        const k = this.plinths.push(x, y, z, sx, sy, sz);
        if (k >= 0) {
          const c = this.plinths.mesh.instanceColor!.array as Float32Array;
          c[k * 3] = 1;
          c[k * 3 + 1] = 0;
          c[k * 3 + 2] = BUILT;
        }
      },
    };
    this.rigs = new Array(C.units).fill(null);
    this.rigId = new Uint32Array(C.units).fill(0xffffffff);
    this.alienRow = new Int32Array(C.aliens);
    this.unitTracks = new Tracks(C.units);
    this.alienTracks = new Tracks(C.aliens);
    this.rigFrame = new Uint32Array(C.units);
    this.unitAt = new Float32Array(C.units * 2);
    this.unitAtFrame = new Uint32Array(C.units);
  }

  /**
   * Warm-up (run 2b): every instanced mesh of the renderer (every part, model, icon, plinth and
   * effect batch) drawn with one instance at (x, y, z), and the particle meshes with one each, so
   * one full frame compiles every program; `prime(false)` empties them again. The next update
   * refills every batch from zero either way.
   */
  prime(on: boolean, x = 0, y = 0, z = 0, camera: PerspectiveCamera | null = null): number {
    let n = 0;
    this.group.traverse((o) => {
      if (!(o instanceof InstancedMesh)) return;
      n++;
      if (on) {
        const a = o.instanceMatrix.array as Float32Array;
        a.fill(0, 0, 16);
        a[0] = a[5] = a[10] = a[15] = 1;
        a[12] = x;
        a[13] = y;
        a[14] = z;
        o.instanceMatrix.clearUpdateRanges();
        o.instanceMatrix.needsUpdate = true;
      }
      o.count = on ? 1 : 0;
      o.visible = on;
    });
    this.effects.prime(on, x, y, z, camera);
    return n;
  }

  /** Kit icon spec of each game turret kind, for the atlas. */
  static turretIcons(kit: Kit, kinds: ReadonlyMap<number, Kind>): TurretIconSpecs {
    const out: TurretIconSpecs = {};
    for (const [game, kind] of kinds) out[BUILDING_ICON[game]!] = kit.icons[kind.icon]!;
    return out;
  }

  get overflowed(): boolean {
    return this.batches.overflowed || this.w17.overflowed || this.icons.overflowed || this.plinths.overflowed || this.outlines.overflowed || this.effects.overflowed;
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

  private readonly visibleAt = (x: number, y: number, z: number, r: number): boolean => this.visible(x, y, z, r);

  /** Muzzle of a projectile's shooter (effects.ts shots): a turret's muzzle, the commander's gun, an alien's body. */
  private readonly shotOrigin = (id: number, out: Float32Array, o: number): boolean => {
    const snap = this.snap;
    if (!snap) return false;
    const P = snap.projectiles;
    const s = slotOf(id);
    const pr = s < this.pRow.length ? this.pRow[s]! : -1;
    if (pr < 0 || P.id[pr] !== id) return false;
    const type = P.cols.srcType[pr]!;
    const src = P.cols.srcId[pr]!;
    const ss = slotOf(src);
    if (type === T_BUILDING) {
      if (ss >= this.muzzleId.length || this.muzzleId[ss] !== src) return false;
      out[o] = this.muzzle[ss * 3]!;
      out[o + 1] = this.muzzle[ss * 3 + 1]!;
      out[o + 2] = this.muzzle[ss * 3 + 2]!;
      return true;
    }
    if (type === T_UNIT) {
      // the rig's muzzle only when that rig was posed this frame; otherwise the commander's muzzle
      // at rest, at its interpolated position and heading this frame (W24 review: a rig cached
      // before a load, or last posed before zooming out, put the tracer where it used to stand)
      if (ss >= this.unitAtFrame.length || P.cols.srcKind[pr] !== U.commander) return false;
      const rig = this.rigOf(src);
      let m: Vector3;
      if (rig instanceof CommanderRig && this.rigFrame[ss] === this.frameNo) m = rig.muzzle;
      else if (this.unitAtFrame[ss] === this.frameNo) {
        const x = this.unitAt[ss * 2]!;
        const z = this.unitAt[ss * 2 + 1]!;
        const yaw = this.unitTracks.heading[ss]!;
        this.restRig.place(x, z, yaw, this.ground);
        this.restRig.update(0, x, z, yaw, this.ground);
        m = this.restRig.muzzle;
      } else return false;
      out[o] = m.x;
      out[o + 1] = m.y;
      out[o + 2] = m.z;
      return true;
    }
    if (type === T_ALIEN) {
      const v = this.aliensView;
      const ar = ss < this.alienRow.length ? this.alienRow[ss]! : -1;
      if (!v || ar < 0 || v.id[ar] !== src) return false;
      out[o] = v.x[ar]!;
      out[o + 2] = v.z[ar]!;
      out[o + 1] = this.ground(v.x[ar]!, v.z[ar]!) + (ALIEN_AIM_HEIGHT[v.kind[ar]!] ?? 1);
      return true;
    }
    return false;
  };

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
    this.plinths.begin();
    this.outlines.begin();
    const snap = f.snapshot;
    this.snap = snap;
    this.aliensView = f.aliens;
    // slot → row indexes and the wall layout depend only on the snapshot (and the alien view's rows)
    if (snap !== this.rowsFor) {
      this.rowsFor = snap;
      rowIndex(this.bRow, snap.buildings);
      rowIndex(this.wRow, snap.wrecks);
      rowIndex(this.uRow, snap.units);
      rowIndex(this.pRow, snap.projectiles);
      rowIndex(this.aSnapRow, snap.aliens);
      this.walls.update(rowsOf(snap));
    }
    if (f.aliens.id !== this.alienIdsFor || f.aliens.count !== this.alienCountFor) {
      this.alienIdsFor = f.aliens.id;
      this.alienCountFor = f.aliens.count;
      rowIndex(this.alienRow, f.aliens);
    }
    const N = this.activityNow;
    N.beaming = N.firing = N.flash = N.shots = N.attacking = N.doorOpening = N.doorClosing = false;
    this.frameNo++;
    this.unitTracks.tick(snap.tick);
    this.alienTracks.tick(snap.tick);
    const dt = f.dt ?? 0;
    // the effect clock (anim.ts): a reset drops every effect state and clears the effects
    const time = f.time ?? { t: 0, dt, reset: false };
    const reset = this.anim.begin(snap.tick, time);
    this.effects.begin(this.camPos, cam, this.wppd, this.anim.t, this.anim.dt, reset);
    this.effects.visible = this.visibleAt;
    this.drawBuildings(f);
    this.drawDeposits();
    this.drawUnits(f.units, dt, snap);
    this.drawAliens(f.aliens, dt);
    this.drawWrecks(snap);
    if (f.projectiles) this.effects.shots(f.projectiles, this.ground, this.shotOrigin, this.visibleAt);
    this.effects.commit();
    const A = this.activity;
    A.frames++;
    // beams, shots and flashes as committed for drawing this frame (effects.ts activity)
    const E = this.effects.activity;
    N.beaming = E.beams > 0;
    N.shots = E.shots > 0;
    N.flash = E.flashes > 0;
    N.firing = N.flash || E.turretBeams > 0;
    if (N.beaming) A.beaming++;
    if (N.firing) A.firing++;
    if (N.shots) A.shots++;
    if (N.attacking) A.attacking++;
    if (N.doorOpening) A.doorOpening++;
    if (N.doorClosing) A.doorClosing++;
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
    const P = this.bp;
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
      const slot = slotOf(id);
      this.bTop[slot] = top;
      // effect state advances for every building, on screen or not (anim.ts)
      this.animateBuilding(f, r, slot, id, kind, flags, tx, ty, fw, fh, cx, top, cz);
      const seen = this.visible(cx, top + 1, cz, Math.max(fw, fh) * 0.75 + 1.5);
      if (P.beam) {
        // the beam turret's beam: every frame while it fires at a present target
        this.effects.turretBeam(P.mx, P.my, P.mz, P.ax, P.ay, P.az, (id % 61) / 61);
      }
      if (!seen) {
        this.counts.culled++;
        continue;
      }
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
      const frac = col.maxHp[r]! > 0 ? col.hp[r]! / col.maxHp[r]! : 1;
      const damage = complete ? (frac > 2 / 3 ? 0 : frac > 1 / 3 ? 1 : 2) : 0;
      if (lv === ICON_LEVEL) {
        this.buildingIcon(kind, r, snap, cx, top, cz, fw, fh, P.yaw);
        continue;
      }
      // a gate drawn as a model with its doors moving this frame (the leaves are drawn below)
      if (P.doorDelta > 1e-6) this.activityNow.doorOpening = true;
      else if (P.doorDelta < -1e-6) this.activityNow.doorClosing = true;
      if (P.flash) this.effects.flash(P.mx, P.my, P.mz, P.dx, P.dy, P.dz, kind === B.heavy, lv <= 1);
      if (kind === B.smelter && P.working) {
        // the model's chimney tops; the smelter is drawn unturned and unscaled at (cx, top, cz) (drawBuilding)
        const k = this.chimneys;
        SMELTER_CHIMNEY_TOPS.forEach(([x, y, z], i) => {
          k[i]![0] = cx + x;
          k[i]![1] = top + y;
          k[i]![2] = cz + z;
        });
        this.effects.chimneys(slot, id, k);
      }
      this.drawBuilding(this.frameSink, P, this.walls, kind, ty * W + tx, col.dir[r]!, col.tier[r]!, cx, top, bottom, cz, fw, fh, lv, damage, complete, col.progress[r]!);
    }
  }

  /**
   * This frame's effect state of building row `r` (anim.ts) into `this.bp`: door opening, aim,
   * recoil and flash, running time; the muzzle of a turret (shots leave from it); and the beam
   * turret's beam end points.
   */
  private animateBuilding(f: ModelFrame, r: number, slot: number, id: number, kind: number, flags: number, tx: number, ty: number, fw: number, fh: number, cx: number, top: number, cz: number): void {
    const A = this.anim;
    const col = f.snapshot.buildings.cols;
    const P = this.bp;
    A.building(slot, id, col.work[r]!);
    Object.assign(P, REST_POSE);
    if (kind === B.gate) {
      const before = A.door[slot]!;
      P.door = A.gate(slot, gateWanted(f.units, tx, ty, fw, fh));
      P.doorDelta = P.door - before;
      return;
    }
    if (runsWhenComplete(kind) || isMachine(kind)) {
      P.run = A.motion(slot, kind, flags, col.work[r]!);
      P.working = A.working;
      return;
    }
    if (!isTurret(kind)) return;
    const k = this.kitKinds.get(kind)!;
    const s = TURRET_SCALE.get(kind) ?? 1;
    // target − 1 = an alien present: aim at its interpolated position and aim height
    const target = col.target[r]!;
    let ar = -1;
    if (target > 0) {
      const a = this.alienRow[slotOf(target - 1)]!;
      if (a >= 0 && f.aliens.id[a] === target - 1) ar = a;
    }
    if (ar >= 0) {
      P.ax = f.aliens.x[ar]!;
      P.az = f.aliens.z[ar]!;
      P.ay = this.ground(P.ax, P.az) + (ALIEN_AIM_HEIGHT[f.aliens.kind[ar]!] ?? 1);
      A.aim(slot, true, Math.atan2(-(P.az - cz), P.ax - cx), flatPitch(Math.hypot(P.ax - cx, P.az - cz), P.ay - (top + k.frame.trunnionY * s), 0));
    } else A.aim(slot, false, 0, 0);
    P.yaw = A.yaw[slot]!;
    P.pitch = A.pitch[slot]!;
    if (recoils(kind)) {
      P.flash = A.fire(slot, flags);
      P.recoil = A.recoil(slot);
    }
    // the muzzle: the kind's muzzle point in the barrel's frame (with recoil), scaled about the footprint centre
    const m = this.mz;
    barrelPoint(m, 0, 0, 0, 0, P.yaw, P.pitch, k.frame.trunnionY, P.recoil * k.frame.recoilScale, k.muzzle[0], k.muzzle[1], k.muzzle[2]);
    P.mx = cx + m[0]! * s;
    P.my = top + m[1]! * s;
    P.mz = cz + m[2]! * s;
    const cp = Math.cos(P.pitch);
    P.dx = Math.cos(P.yaw) * cp;
    P.dy = Math.sin(P.pitch);
    P.dz = -Math.sin(P.yaw) * cp;
    this.muzzle[slot * 3] = P.mx;
    this.muzzle[slot * 3 + 1] = P.my;
    this.muzzle[slot * 3 + 2] = P.mz;
    this.muzzleId[slot] = id;
    P.beam = kind === B.beam && (flags & BF_FIRING) !== 0 && ar >= 0;
  }

  /**
   * One building's model into `sink` (the frame's batches, or a W27 preview capture) in pose `P`.
   * Walls and gates read their pieces from `layout` at anchor tile `tile`.
   */
  private drawBuilding(sink: BuildingSink, P: Readonly<BuildingPose>, layout: WallLayout, kind: number, tile: number, dir: number, tier: number, cx: number, top: number, bottom: number, cz: number, fw: number, fh: number, lv: number, damage: number, complete: boolean, progress: number): void {
    if (top - bottom > 0.01) sink.plinth(cx, top + 0.02, cz, fw, top - bottom + 0.1, fh);
    const cutOf = (height: number) => (complete ? BUILT : top + height * progress);
    if (kind === B.wall) {
      const first = layout.first[tile]!;
      const n = layout.count[tile]!;
      const cut = cutOf(TIERS[Math.max(1, Math.min(3, tier))]!.top + 0.3);
      for (let k = 0; k < n; k++) sink.part(this.parts.get(layout.parts[first + k]!), lv, layout.matrices, (first + k) * 16, 1, damage + 10, cut);
    } else if (kind === B.gate) {
      const pieces = layout.gates.get(tile);
      const frame = layout.gateFrames.get(tile);
      const cut = cutOf(PYLON_H + 0.3);
      if (pieces) for (const pc of pieces) sink.part(this.parts.get(pc.part), lv, pc.m, 0, 1, damage + 10, cut);
      // the door leaves at this frame's opening (W23 leafOffsets)
      if (frame) {
        leafMatrices(frame, P.door, this.leaves);
        const leaf = this.parts.get('gate/leaf');
        for (let k = 0; k < 4; k++) sink.part(leaf, lv, this.leaves, k * 16, 0.6, damage, cut);
      }
    } else if (kind === B.massExtractor || kind === B.rareExtractor) {
      this.drawExtractor(sink, kind === B.massExtractor ? 'mass' : 'rare', cx, top, cz, complete ? 1 : progress, damage, lv, P.working, P.run);
    } else if (TURRET_KINDS.has(kind)) {
      const k = this.kitKinds.get(kind)!;
      const s = TURRET_SCALE.get(kind) ?? 1;
      const cut = complete ? BUILT : top + (k.top * s + 0.3) * progress;
      this.pushKit(k, cx, top, cz, P.yaw, s, lv, damage, cut, P.pitch, P.recoil, sink);
    } else {
      const name = W17_BUILDING_MODEL.get(kind);
      if (name === undefined) return;
      const mi = this.modelIndex.get(name)!;
      const model = this.models[mi]!;
      const yaw = isBelt(kind) ? BELT_YAW[dir & 3]! : 0;
      _m.makeRotationY(yaw).setPosition(cx, top, cz);
      const cut = cutOf(model.height + 0.2);
      sink.model(mi, _m.elements, 0, damage, cut);
      if (kind === B.splitter || kind === B.merger) sink.model(this.modelIndex.get(kind === B.splitter ? 'splitterMarker' : 'mergerMarker')!, _m.elements, 0, damage, cut);
      // W17 moving parts (generator vane, shredder rollers, assembler arm): turned by the running time
      const moving = this.movingParts.get(name);
      if (moving)
        for (const mp of moving) {
          _m2.multiplyMatrices(_m, mp.pivot).multiply(motionAt(mp.motion, P.run * mp.rate, 0, _mot));
          sink.model(mp.batch, _m2.elements, 0, damage, cut);
        }
    }
  }

  /**
   * W27: complete buildings of `kind` at the anchor tiles `tiles` ([x, z, dir] each), at full
   * detail and at rest (doors shut, turrets at their rest aim, nothing running), captured into `out`
   * instead of drawn: the geometry objects and world matrices the batches would draw for them placed
   * there, plinths on sloping ground included. Walls and gates are laid out together in a scratch
   * layout (a dragged wall run autotiles as the placed run will; one tile is a lone wall or gate),
   * so the frame's layout is untouched. The placement ghost passes one tile, the drag preview the run.
   */
  previewRun(kind: number, tiles: ReadonlyArray<readonly [number, number, number]>, out: Captured[] = []): Captured[] {
    out.length = 0;
    if (tiles.length === 0) return out;
    const dir0 = tiles[0]![2];
    let [fw, fh] = buildingFootprint(kind);
    if (kind === B.gate && dir0 === 1) [fw, fh] = [fh, fw];
    let layout = this.walls;
    if (kind === B.wall || kind === B.gate) {
      layout = this.previewWalls ??= new WallLayout(this.terrain);
      layout.update(rowsOfPlan(tiles, kind, fw, fh, dir0));
    }
    const sink = this.capture(out);
    for (const [tx, ty, dir] of tiles) {
      const { top, bottom } = footprintRange(this.terrain, tx, ty, fw, fh);
      this.drawBuilding(sink, REST_POSE, layout, kind, ty * this.terrain.w + tx, dir, 1, tx + fw / 2, top, bottom, ty + fh / 2, fw, fh, 0, 0, true, 1);
    }
    return out;
  }

  /** A sink that records each instance's geometries and world matrix into `out` (previewRun). */
  private capture(out: Captured[]): BuildingSink {
    const copy = (m: Matrix4 | ArrayLike<number>, o: number) => {
      const src = m instanceof Matrix4 ? m.elements : m;
      const a = new Float32Array(16);
      for (let i = 0; i < 16; i++) a[i] = src[o + i]!;
      return a;
    };
    return {
      part: (p, lv, m, o) => {
        for (const g of p.levels[lv as 0 | 1 | 2].values()) out.push({ geometry: g, matrix: copy(m, o) });
      },
      model: (i, m, o) => {
        for (const pc of this.models[i]!.pieces) out.push({ geometry: pc.geometry, matrix: copy(m, o) });
      },
      plinth: (x, y, z, sx, sy, sz) => {
        const a = new Float32Array(16);
        a[0] = sx;
        a[5] = sy;
        a[10] = sz;
        a[12] = x;
        a[13] = y;
        a[14] = z;
        a[15] = 1;
        out.push({ geometry: this.plinths.mesh.geometry, matrix: a });
      },
    };
  }

  /** `yaw`: a turret's aim this frame (its icon turns with it). */
  private buildingIcon(kind: number, r: number, snap: Snapshot, cx: number, top: number, cz: number, fw: number, fh: number, yaw: number): void {
    const y = top + 0.4;
    if (kind === B.wall) return this.icon('wall', cx, y, cz, 1, 0);
    if (kind === B.gate) {
      // the gate icon's gap runs across the passage: turn it to the run axis
      const alongZ = snap.buildings.cols.dir[r] === 1;
      return this.icon('gate', cx, y, cz, 3.2, 0, alongZ ? 0 : Math.PI / 2);
    }
    if (isBelt(kind)) return this.icon(BUILDING_ICON[kind]!, cx, y, cz, 0.9, ICON_PX.belt, BELT_YAW[snap.buildings.cols.dir[r]! & 3]!);
    if (TURRET_KINDS.has(kind)) return this.icon(BUILDING_ICON[kind]!, cx, y, cz, Math.max(fw, fh) * 0.9, ICON_PX.building, yaw);
    this.icon(BUILDING_ICON[kind]!, cx, y, cz, Math.max(fw, fh) * 0.9, ICON_PX.building);
  }

  private drawExtractor(sink: BuildingSink, kind: 'mass' | 'rare', x: number, y: number, z: number, built: number, damage: number, lv: number, working: boolean, t: number): void {
    const P = (id: string) => this.parts.get(id);
    const base = extractorMatrix(_m, { x, y, z, rot: 0 });
    const pose = extractorPose({ kind, x, y, z, rot: 0, built, working, t, damage }, this.pose);
    const cut = built < 1 ? y + (EXTRACTOR_HEIGHT[kind] + 0.3) * built : BUILT;
    if (kind === 'mass') {
      sink.part(P('mass/base'), lv, base, 0, 1, damage, cut);
      sink.part(P('mass/drum'), lv, pivotMatrix(_m2, base, pose.spin, 0), 0, 1, damage, cut);
      sink.part(P('mass/head'), lv, pivotMatrix(_m2, base, 0, pose.slide), 0, 1, damage, cut);
      sink.part(P('mass/fill'), lv, pivotMatrix(_m2, base, 0, 0.08 + pose.fill), 0, 1, 0, cut);
      sink.part(P('mass/light'), lv, base, 0, pose.light * 2, 0, cut);
    } else {
      sink.part(P('rare/base'), lv, base, 0, 1, damage, cut);
      sink.part(P('rare/ring'), lv, pivotMatrix(_m2, base, pose.spin, 0), 0, 0.2, damage, cut);
      sink.part(P('rare/pump'), lv, pivotMatrix(_m2, base, 0, pose.slide), 0, 0.2, damage, cut);
      sink.part(P('rare/light'), lv, base, 0, pose.light * 2, 0, cut);
    }
    if (lv <= 1)
      for (let k = 0; k < FLOW_SEGS; k++) sink.part(P('flow/seg'), lv, pivotMatrix(_m2, base, 0, 0, flowSegment(kind, k)), 0, pose.flow[k]!, 0, cut);
  }

  /** Every part of kit kind `k` at its level, placed on (x, y, z) with yaw, pitch and recoil, scaled by s. */
  private pushKit(k: Kind, x: number, y: number, z: number, yaw: number, s: number, lv: number, damage: number, cut: number, pitch: number, recoil: number, sink: BuildingSink): void {
    const piv = this.pivots;
    const m = this.tmp;
    writePivots(piv, k.frame, 0, 0, 0, yaw, pitch, recoil, 0);
    for (const pl of k.placed) {
      if (pl.part.levels[lv]!.size === 0) continue;
      writePart(m, 0, piv, pl.pivot[lv]!, pl.off);
      for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) m[i]! *= s;
      m[12] = m[12]! * s + x;
      m[13] = m[13]! * s + y;
      m[14] = m[14]! * s + z;
      sink.part(this.kitPart[pl.part.index]!, lv, m, 0, 1, damage, cut);
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

  private drawUnits(v: MobileView, dt: number, snap: Snapshot): void {
    const T = this.unitTracks;
    const uc = snap.units.cols;
    for (let r = 0; r < v.count; r++) {
      const id = v.id[r]!;
      const kind = v.kind[r]!;
      const x = v.x[r]!;
      const z = v.z[r]!;
      const slot = slotOf(id);
      // walking: distance moved and heading from the interpolated positions (walk.ts)
      const step = T.step(slot, id, x, z, Math.atan2(-v.fz[r]!, v.fx[r]!), dt, 0, v.cut?.[r] ?? 0);
      if (slot < this.unitAtFrame.length) {
        this.unitAt[slot * 2] = x;
        this.unitAt[slot * 2 + 1] = z;
        this.unitAtFrame[slot] = this.frameNo;
      }
      const y = this.ground(x, z);
      const commander = kind === U.commander;
      const h = commander ? 3.6 : 0.9;
      if (!this.visible(x, y + h / 2, z, h)) {
        this.counts.culled++;
        continue;
      }
      // the snapshot row of this unit: its state, work target and load (anim.ts beamOf, carryLoad)
      const sr = this.uRow[slot]!;
      const known = sr >= 0 && snap.units.id[sr] === id;
      const beam = known ? this.beamTarget(snap, uc.state[sr]!, uc.work[sr]!) : null;
      const load = known ? carryLoad(kind, uc.carry[sr]!) : 0;
      const seed = (id % 37) / 37;
      const lv = this.level(this.lv.u, this.lv.uId, slot, id, this.dist(x, y + h / 2, z), commander ? THRESHOLDS.commander : THRESHOLDS.engineer);
      this.tally(lv);
      if (lv === ICON_LEVEL) {
        if (commander) this.icon('commanderRing', x, y + 0.4, z, 2.4, ICON_PX.commander);
        else this.icon('engineer', x, y + 0.4, z, 0.9, ICON_PX.engineer);
        if (beam) this.unitBeam(beam, x, y + (commander ? 2.4 : 0.6), z, seed);
        continue;
      }
      const yaw = T.heading[slot]!;
      let rig = this.rigs[slot];
      let fresh = step.reset || this.rigFrame[slot] !== this.frameNo - 1;
      if (this.rigId[slot] !== id || !rig || rig instanceof CommanderRig !== commander) {
        rig = commander ? new CommanderRig() : new EngineerRig(VARIANTS[id % VARIANTS.length]!);
        this.rigs[slot] = rig;
        this.rigId[slot] = id;
        fresh = true;
      }
      this.rigFrame[slot] = this.frameNo;
      if (beam) rig.aim.set(beam.x, beam.y, beam.z);
      if (fresh) {
        // first sight, a jump or a rewind: stand at rest, both feet planted on the sampled ground
        rig.place(x, z, yaw, this.ground);
        rig.update(0, x, z, yaw, this.ground);
      } else {
        // W23's gait: advances by the distance moved; planted feet stay on their touchdown points.
        // Standing and beaming: W23's build pose (the tool, or the commander's arm, on the target)
        const moving = step.dist > 1e-5 && dt > 0;
        rig.setAction(moving ? 'walk' : beam ? 'build' : 'idle');
        rig.update(dt, x, z, yaw, this.ground);
      }
      if (rig instanceof CommanderRig) {
        CMD_SEGS.forEach((s, k) => this.batches.push(this.parts.get(CMD_PARTS[s]), lv, rig.mats[k]!));
        if (lv >= 2) this.icon('commander', x, y + 4.2, z, 0, ICON_PX.commander * 0.8);
        if (beam) {
          const e = rig.emitter;
          this.unitBeam(beam, e.x, e.y, e.z, seed);
        }
      } else {
        const er = rig as EngineerRig;
        segmentParts(er.variant, false).forEach((pid, k) => {
          if (pid) this.batches.push(this.parts.get(pid), lv, er.mats[k]!);
        });
        if (lv >= 2) this.icon('engineer', x, y + 1.2, z, 0, ICON_PX.engineer * 0.8);
        if (beam) this.unitBeam(beam, er.tip.x, er.tip.y, er.tip.z, seed);
        if (load > 0) {
          // the carry pod on the back: W23's salvage box behind the pack, sized by the load, swaying
          const sway = 0.14 * Math.sin(this.anim.t * 2.6 + (id % 13));
          const k = POD_MIN + (POD_MAX - POD_MIN) * load;
          _m.copy(er.mats[SEG.torso]!).multiply(_m2.makeTranslation(-0.2, 0.06 + 0.05 * k, 0)).multiply(_mot.makeRotationX(sway));
          _m.multiply(_m2.makeScale(k, k, k));
          this.batches.push(this.parts.get('eng/box'), lv, _m);
        }
      }
    }
  }

  /** The point a unit beams at: a building present in the snapshot (build) or a wreck (reclaim); null when absent. */
  private beamTarget(snap: Snapshot, state: number, work: number): { reclaim: boolean; x: number; y: number; z: number } | null {
    const b = this.beamOfAt;
    if (!beamOf(state, work, b)) return null;
    const out = this.beamAt;
    out.reclaim = b.reclaim;
    const s = slotOf(b.id);
    if (!b.reclaim) {
      const br = s < this.bRow.length ? this.bRow[s]! : -1;
      if (br < 0 || snap.buildings.id[br] !== b.id) return null;
      const c = snap.buildings.cols;
      out.x = c.tx[br]! + c.fw[br]! / 2;
      out.z = c.ty[br]! + c.fh[br]! / 2;
      out.y = this.bTop[s]! + 0.5;
      return out;
    }
    const wr = s < this.wRow.length ? this.wRow[s]! : -1;
    if (wr < 0 || snap.wrecks.id[wr] !== b.id) return null;
    out.x = snap.wrecks.cols.x[wr]!;
    out.z = snap.wrecks.cols.z[wr]!;
    out.y = this.ground(out.x, out.z) + 0.25;
    return out;
  }

  /** A unit's beam from its emitter (ex, ey, ez): build = emitter → site; reclaim = wreck → emitter. */
  private unitBeam(b: { reclaim: boolean; x: number; y: number; z: number }, ex: number, ey: number, ez: number, seed: number): void {
    if (b.reclaim) this.effects.workBeam(true, b.x, b.y, b.z, ex, ey, ez, seed);
    else this.effects.workBeam(false, ex, ey, ez, b.x, b.y, b.z, seed);
  }

  /** The rig drawn for a unit slot (tests read its feet). */
  rigOf(id: number): EngineerRig | CommanderRig | null {
    const s = slotOf(id);
    return this.rigId[s] === id ? this.rigs[s]! : null;
  }

  private drawAliens(v: MobileView, dt: number): void {
    const g = this.ground;
    const T = this.alienTracks;
    for (let r = 0; r < v.count; r++) {
      const id = v.id[r]!;
      const kind = v.kind[r]!;
      const x = v.x[r]!;
      const z = v.z[r]!;
      const slot = slotOf(id);
      // walking: heading, W21 gait phase (by distance) and seed derived here (walk.ts)
      T.step(slot, id, x, z, Math.atan2(-v.fz[r]!, v.fx[r]!), dt, ALIEN_PHASE_PER_TILE[kind] ?? 0, v.cut?.[r] ?? 0);
      const y = g(x, z);
      const ak = this.alienParts[kind]!;
      if (!this.visible(x, y + 0.6, z, ak.radius + 1)) {
        this.counts.culled++;
        continue;
      }
      // an attacking alien counts once it is drawn this frame (icon or model, below)
      let attacking = false;
      if (!this.activityNow.attacking && this.snap) {
        const sr = slot < this.aSnapRow.length ? this.aSnapRow[slot]! : -1;
        attacking = sr >= 0 && this.snap.aliens.id[sr] === id && this.snap.aliens.cols.state[sr] === AS_ATTACKING;
      }
      const lv = this.level(this.lv.a, this.lv.aId, slot, id, this.dist(x, y, z), W17_THRESHOLDS);
      this.tally(lv);
      const heading = T.heading[slot]!;
      if (lv === ICON_LEVEL) {
        this.icon(ALIEN_ICON[kind]!, x, y + 0.4, z, ak.radius / ALIEN_SCALE, ICON_PX.alien, heading);
        if (attacking) this.activityNow.attacking = true;
        continue;
      }
      // tilt to the ground (W21), then the heading; each part at its pivot with its motion
      const e = 0.6;
      _n.set(g(x - e, z) - g(x + e, z), 2 * e, g(x, z - e) - g(x, z + e)).normalize();
      _qt.setFromUnitVectors(UP, _n);
      _q.setFromAxisAngle(UP, heading).premultiply(_qt);
      _m.compose(_p.set(x, y, z), _q, _s);
      const phase = T.phase[slot]!;
      const seed = T.seed[slot]!;
      for (const pt of ak.parts) {
        _m2.multiplyMatrices(_m, pt.pivot).multiply(motionAt(pt.motion, phase, seed, _mot));
        this.w17.push(pt.batch, _m2.elements);
      }
      if (attacking) this.activityNow.attacking = true;
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

/** out[slot of each row's id] = the row; −1 for slots with no row (ids past `out` are skipped). */
function rowIndex(out: Int32Array, sec: { count: number; id: ArrayLike<number> }): void {
  out.fill(-1);
  for (let r = 0; r < sec.count; r++) {
    const s = slotOf(sec.id[r]!);
    if (s < out.length) out[s] = r;
  }
}

/** The building columns the wall layout reads. */
export function rowsOf(s: Snapshot): BuildingRows {
  const c = s.buildings.cols;
  return { count: s.buildings.count, id: s.buildings.id, kind: c.kind, tier: c.tier, flags: c.flags, dir: c.dir, tx: c.tx, ty: c.ty, fw: c.fw, fh: c.fh };
}

/** Building rows for a planned run of walls or gates: complete, tier 1, ids 1… (W27 previews). */
function rowsOfPlan(tiles: ReadonlyArray<readonly [number, number, number]>, kind: number, fw = 1, fh = 1, dir = 0): BuildingRows {
  const n = tiles.length;
  const rows: BuildingRows = {
    count: n,
    id: new Uint32Array(n),
    kind: new Uint8Array(n).fill(kind),
    tier: new Uint8Array(n).fill(1),
    flags: new Uint8Array(n).fill(BF_COMPLETE | BF_STARTED),
    dir: new Uint8Array(n).fill(dir),
    tx: new Int16Array(n),
    ty: new Int16Array(n),
    fw: new Uint8Array(n).fill(fw),
    fh: new Uint8Array(n).fill(fh),
  };
  tiles.forEach(([x, z], i) => {
    rows.id[i] = i + 1;
    rows.tx[i] = x;
    rows.ty[i] = z;
  });
  return rows;
}

