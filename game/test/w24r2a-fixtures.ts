// Shared fixtures for the W24 run 2a renderer tests: the model renderer with name-only materials
// (no textures in Node), snapshots built from a real World on map 1, and mobile views read
// straight from a snapshot. Not a test file itself.

import { PerspectiveCamera, Scene, Texture } from 'three';
import { A, B, U } from '../src/sim/kinds.ts';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from '../src/sim/snapshot.ts';
import { map1Terrain, type Terrain } from '../src/sim/terrain.ts';
import { CAPACITY, World } from '../src/sim/world.ts';
import { applyRig } from '../src/render/cameraRig.ts';
import { groundHeight } from '../src/render/ground.ts';
import type { MobileView } from '../src/render/interp.ts';
import { standInMaterials } from '../src/render/materials.ts';
import { ModelRenderer } from '../src/render/models.ts';

export const terrain: Terrain = map1Terrain();

let shared: ModelRenderer | null = null;
/** One model renderer per test file (building the kit and every part takes a few seconds). */
export function renderer(): { r: ModelRenderer; scene: Scene } {
  if (!shared) shared = new ModelRenderer(terrain, standInMaterials(), CAPACITY, () => new Texture());
  const scene = new Scene();
  scene.add(shared.group);
  return { r: shared, scene };
}

export function mobile(sec: Snapshot['aliens'] | Snapshot['units'] | Snapshot['projectiles']): MobileView {
  return { count: sec.count, id: sec.id, kind: sec.cols.kind, x: sec.cols.x, z: sec.cols.z, fx: sec.cols.fx, fz: sec.cols.fz };
}

export function snapshotOf(w: World): Snapshot {
  return decodeSnapshot(encodeSnapshot(w));
}

/** A camera at the game's default pose (distance 50 over the base) or a given rig. */
export function camera(rig = { x: 64, z: 62, distance: 50, yaw: 0 }, aspect = 1440 / 900): PerspectiveCamera {
  const c = new PerspectiveCamera(45, aspect, 0.5, 1000);
  applyRig(c, rig, groundHeight(terrain, rig.x, rig.z));
  return c;
}

/** Draws a snapshot through the renderer (culling off unless a camera is given). */
export function draw(r: ModelRenderer, s: Snapshot, opts: { level?: number | null; cam?: PerspectiveCamera } = {}): void {
  r.forcedLevel = opts.level === undefined ? 0 : opts.level;
  r.cull = !!opts.cam;
  r.update({ camera: opts.cam ?? camera(), viewportHeight: 900, yaw: 0, snapshot: s, aliens: mobile(s.aliens), units: mobile(s.units) });
}

/** Every building kind complete on map 1, well apart; ids by kind name. */
export const KIND_SPOTS: Array<[keyof typeof B, number, number, number?]> = [
  ['massExtractor', 54, 50],
  ['rareExtractor', 73, 29],
  ['generator', 40, 44],
  ['lab', 48, 44],
  ['depot', 58, 44],
  ['shredder', 66, 44],
  ['smelter', 74, 44],
  ['assembler', 82, 44],
  ['wall', 40, 56],
  ['gun', 48, 56],
  ['area', 58, 56],
  ['beam', 66, 56],
  ['heavy', 74, 56],
  ['shield', 84, 56],
  ['tempTurret', 40, 66],
  ['belt', 48, 66, 0],
  ['splitter', 56, 66, 1],
  ['merger', 64, 66, 2],
];

export interface Fixture {
  world: World;
  snap: Snapshot;
  /** Building id by kind name (the gate included). */
  ids: Record<string, number>;
  units: { commander: number; engineer: number };
  aliens: Record<string, number>;
}

/** Every building, unit and alien kind on map 1 (complete, full hit points), plus a gate and a wreck. */
export function everyKind(): Fixture {
  const w = new World(1, terrain, { waves: false });
  const ids: Record<string, number> = {};
  for (const [k, tx, ty, dir] of KIND_SPOTS) {
    const id = w.placeBuilding(B[k], tx, ty, true, dir ?? 0);
    if (id < 0) throw new Error(`cannot place ${k} at ${tx},${ty}`);
    ids[k] = id;
  }
  const gate = w.placeBuilding(B.gate, 72, 66, true, 0, 3, 2);
  if (gate < 0) throw new Error('cannot place the gate');
  ids.gate = gate;
  const commander = w.spawnUnit(U.commander, 82.5, 66.5);
  const engineer = w.spawnUnit(U.engineer, 90.5, 66.5);
  const aliens: Record<string, number> = {};
  (['rusher', 'hunter', 'breaker', 'saboteur'] as const).forEach((k, i) => (aliens[k] = w.spawnAlien(A[k], 44.5 + i * 8, 92.5)));
  w.addWreck(A.breaker, 80.5, 92.5, 20);
  return { world: w, snap: snapshotOf(w), ids, units: { commander, engineer }, aliens };
}

/** Snapshot row of a building id. */
export function rowOf(s: Snapshot, id: number): number {
  return rowIn(s.buildings, id);
}

/** Row of `id` in a snapshot section (throws when absent). */
export function rowIn(sec: { count: number; id: Uint32Array }, id: number): number {
  for (let r = 0; r < sec.count; r++) if (sec.id[r] === id) return r;
  throw new Error(`no row for id ${id}`);
}
