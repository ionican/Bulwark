// The contract between the scene and whatever supplies the meshes. W17 supplies code-built models
// (models/procedural); W18 can supply glTF models through the same interface without touching
// terrain, lighting, effects or placement.
//
// A model is a list of parts. Each part is one geometry (it may carry groups, one per material)
// placed in model space by `pivot`, with an optional motion the scene animates per instance.
// Model space: +Y up, origin at the ground centre of the footprint, forward = +X, 1 unit = 1 tile.

import type { BufferGeometry, Material, Matrix4 } from 'three';
import type { AlienKind, BuildingKind } from '../world/layout.ts';

export type Motion =
  | { kind: 'static' }
  /** Turns about the part's local Y to the instance's aim angle (turret heads). */
  | { kind: 'aim' }
  /** Pitches about the part's local Z by the instance's elevation (barrels). */
  | { kind: 'elevate' }
  /** Constant spin about a local axis, radians per second. */
  | { kind: 'spin'; axis: 'x' | 'y' | 'z'; speed: number }
  /** Vertical bob, tiles, at a rate in Hz; phase comes from the instance. */
  | { kind: 'bob'; amp: number; rate: number }
  /** Leg swing about local Z with a lift on the forward stroke; phase offset per leg. */
  | { kind: 'gait'; phase: number; swing: number; lift: number }
  /** Recoil along local -X after each shot (barrels). */
  | { kind: 'recoil'; dist: number };

export interface PartDef {
  name: string;
  geometry: BufferGeometry;
  material: Material | Material[];
  /** Part space → model space at rest. */
  pivot: Matrix4;
  motion: Motion;
  /** Name of the part whose motion this part inherits (e.g. barrel follows head). */
  parent?: string;
  castShadow?: boolean;
}

export interface ModelDef {
  name: string;
  parts: PartDef[];
  /** Bounding radius in tiles (culling, effects anchors). */
  radius: number;
  /** Height of the top in tiles (smoke and spark anchors). */
  height: number;
  /** Muzzle position in head space for weapons, tiles. */
  muzzle?: [number, number, number];
}

export interface ModelSource {
  readonly name: string;
  /** `tier` selects upgrade variants where they look different (tier 3 walls are wall towers). */
  building(kind: BuildingKind, tier?: number): ModelDef;
  unit(kind: 'commander' | 'engineer'): ModelDef;
  alien(kind: AlienKind): ModelDef;
}
