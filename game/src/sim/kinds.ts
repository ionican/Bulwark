// Entity kinds and their fixed properties. Numbers come from the W12 model (model/data/map1.ts);
// footprints, sizes and speeds in tiles are new here because the W12 model is not spatial.
//
// Scale: 1 tile = 2 m. Map 1 is 128 × 128 tiles (256 m), so an alien entering at the north edge
// walks about 64 tiles (128 m) to the base centre — W12's 100 m approach plus the base radius.

import { map1 } from '../../../model/data/map1.ts';

export const METRES_PER_TILE = 2;
export const TICK_HZ = 10;
export const TICK_SECONDS = 1 / TICK_HZ;

// ---- Buildings -----------------------------------------------------------------------------
// Index = kind id stored in the entity table. Order is part of the snapshot format: append only.
export const BUILDING_KINDS = [
  'massExtractor',
  'generator',
  'rareExtractor',
  'lab',
  'depot',
  'shredder',
  'smelter',
  'assembler',
  'wall',
  'gun',
  'area',
  'beam',
  'heavy',
  'shield',
  'tempTurret',
] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];
export const B = Object.fromEntries(BUILDING_KINDS.map((k, i) => [k, i])) as Record<BuildingKind, number>;

export interface BuildingInfo {
  label: string;
  /** Footprint in tiles (square). */
  size: number;
  hp: number;
}

const bdef = map1.buildings;
export const BUILDING_INFO: Record<BuildingKind, BuildingInfo> = {
  massExtractor: { label: bdef.massExtractor.label, size: 2, hp: bdef.massExtractor.hp },
  generator: { label: bdef.generator.label, size: 2, hp: bdef.generator.hp },
  rareExtractor: { label: bdef.rareExtractor.label, size: 2, hp: bdef.rareExtractor.hp },
  lab: { label: 'Research station', size: 3, hp: bdef.lab.hp },
  depot: { label: bdef.depot.label, size: 2, hp: bdef.depot.hp },
  shredder: { label: bdef.shredder.label, size: 2, hp: bdef.shredder.hp },
  smelter: { label: bdef.smelter.label, size: 2, hp: bdef.smelter.hp },
  assembler: { label: bdef.assembler.label, size: 2, hp: bdef.assembler.hp },
  wall: { label: bdef.wall.label, size: 1, hp: bdef.wall.hp },
  gun: { label: bdef.gun.label, size: 2, hp: bdef.gun.hp },
  area: { label: bdef.area.label, size: 2, hp: bdef.area.hp },
  beam: { label: bdef.beam.label, size: 2, hp: bdef.beam.hp },
  heavy: { label: bdef.heavy.label, size: 3, hp: bdef.heavy.hp },
  shield: { label: bdef.shield.label, size: 2, hp: bdef.shield.hp },
  tempTurret: { label: 'Temporary turret', size: 1, hp: map1.tempTurret.hp },
};
export const buildingSize = (kind: number): number => BUILDING_INFO[BUILDING_KINDS[kind]!].size;

// ---- Aliens --------------------------------------------------------------------------------
export const ALIEN_KINDS = ['rusher', 'hunter', 'breaker', 'saboteur'] as const;
export type AlienKind = (typeof ALIEN_KINDS)[number];
export const A = Object.fromEntries(ALIEN_KINDS.map((k, i) => [k, i])) as Record<AlienKind, number>;

export interface MobileInfo {
  label: string;
  hp: number;
  /** Tiles per tick. */
  speed: number;
  /** Pick and draw radius in tiles. */
  radius: number;
}

const tilesPerTick = (metresPerSecond: number) => (metresPerSecond / METRES_PER_TILE) * TICK_SECONDS;
const adef = map1.aliens;
export const ALIEN_INFO: Record<AlienKind, MobileInfo> = {
  rusher: { label: adef.rusher.label, hp: adef.rusher.hp, speed: tilesPerTick(adef.rusher.speed), radius: 0.35 },
  hunter: { label: adef.hunter.label, hp: adef.hunter.hp, speed: tilesPerTick(adef.hunter.speed), radius: 0.4 },
  breaker: { label: adef.breaker.label, hp: adef.breaker.hp, speed: tilesPerTick(adef.breaker.speed), radius: 0.8 },
  saboteur: { label: adef.saboteur.label, hp: adef.saboteur.hp, speed: tilesPerTick(adef.saboteur.speed), radius: 0.45 },
};

// ---- Player units (commander and engineers) ------------------------------------------------
export const UNIT_KINDS = ['commander', 'engineer'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];
export const U = Object.fromEntries(UNIT_KINDS.map((k, i) => [k, i])) as Record<UnitKind, number>;

// W12 has no walking speeds; these are first-pass values (commander 3 m/s, engineer 5 m/s).
export const UNIT_INFO: Record<UnitKind, MobileInfo> = {
  commander: { label: 'Commander', hp: map1.commander.hp, speed: tilesPerTick(3), radius: 0.9 },
  engineer: { label: 'Engineer', hp: map1.engineer.hp, speed: tilesPerTick(5), radius: 0.45 },
};

export const alienInfo = (kind: number): MobileInfo => ALIEN_INFO[ALIEN_KINDS[kind]!];
export const unitInfo = (kind: number): MobileInfo => UNIT_INFO[UNIT_KINDS[kind]!];
