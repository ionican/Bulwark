// Entity kinds and their fixed properties. Numbers come from the W12 model (model/data/map1.ts);
// footprints, sizes, ranges in tiles and the belt pieces are new here because W12 is not spatial.
//
// Scale: 1 tile = 2 m. Map 1 is 128 × 128 tiles (256 m). Every W12 distance in metres is halved
// to get tiles; every W12 speed in m/s is halved and multiplied by the tick length.

import { map1 } from '../../../model/data/map1.ts';
import type { BuildingDef, WeaponDef } from '../../../model/src/types.ts';
import { BELT_COST_MASS, BUILD_RATE, CORE_HP, CORE_REPAIR_TIME, HEAVY_T2, RARE_EXTRACTOR_OUTPUT, gateStats } from './balance.ts';

export const METRES_PER_TILE = 2;
export const TICK_HZ = 10;
export const TICK_SECONDS = 1 / TICK_HZ;
const m2t = (metres: number) => metres / METRES_PER_TILE;

export const RES_KEYS = ['mass', 'energy', 'rare'] as const;
export type Cost = [mass: number, energy: number, rare: number];
const costOf = (d: BuildingDef): Cost => [d.cost.mass, d.cost.energy, d.cost.rare];

// ---- Aliens (kinds first: weapons refer to them) -------------------------------------------
export const ALIEN_KINDS = ['rusher', 'hunter', 'breaker', 'saboteur'] as const;
export type AlienKind = (typeof ALIEN_KINDS)[number];
export const A = Object.fromEntries(ALIEN_KINDS.map((k, i) => [k, i])) as Record<AlienKind, number>;

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
  'belt',
  'splitter',
  'merger',
  // W24: appended (the order is part of the snapshot format).
  'gate',
  // W29: appended.
  'core',
] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];
export const B = Object.fromEntries(BUILDING_KINDS.map((k, i) => [k, i])) as Record<BuildingKind, number>;

/**
 * What an alien target category sees a building as. 'core' (W29) is no category's goal: aliens
 * attack it only in passing (aliens.ts).
 */
export type BuildingRole = 'economy' | 'chain' | 'wall' | 'defence' | 'floor' | 'core';

export interface Weapon {
  /** Tiles. */
  range: number;
  damage: number;
  /** Seconds between shots. */
  interval: number;
  /** Extra aliens hit by each shot and the radius (tiles) they must be within. */
  splashTargets: number;
  splashRadius: number;
  splashFactor: number;
  energyPerSecond: number;
  partsPerShot: number;
  prefer: number; // alien kind id, -1 = none
  /** Projectile speed in tiles per second; 0 = instant beam. */
  shotSpeed: number;
  /** Projectile kind drawn by the renderer (P_* below). */
  shot: number;
}

export interface BuildingInfo {
  label: string;
  /**
   * Default footprint in tiles, fw along x by fh along z, from the anchor tile (tx, ty). Every kind
   * but the gate is square (fw = fh = W13's `size`); a gate's footprint is set per building from
   * its depth and axis (gate.ts) and stored in the fw and fh columns.
   */
  fw: number;
  fh: number;
  hp: number;
  cost: Cost;
  /** Build-power-seconds (commander builds at 8 BP, an engineer at 5: balance.ts BUILD_RATE). */
  buildTime: number;
  role: BuildingRole;
  income?: Cost;
  weapon?: Weapon;
  /** Chain machine: input item kind, seconds per output, inputs per output, energy per second. */
  machine?: { input: number; output: number; seconds: number; inputPerOutput: number; energyPerSecond: number };
  /** Tier 2 (and 3 for walls), each gated by research (balance.ts TIER_REQUIRES). */
  tiers?: Array<{ hpMult: number; damageMult: number; cost: Cost; time: number }>;
  /** Hotkey in the build bar. */
  key: string;
}

// Projectile kinds.
export const P_BULLET = 0;
export const P_SHELL = 1;
export const P_HEAVY = 2;
export const P_ALIEN = 3;
export const P_BEAM = 4;

// Belt item kinds (0 = empty slot).
export const ITEM_NONE = 0;
export const ITEM_SALVAGE = 1;
export const ITEM_SCRAP = 2;
export const ITEM_ALLOY = 3;
export const ITEM_PART = 4;
// W29: mined resources on belts, one unit each (appended).
export const ITEM_MASS = 5;
export const ITEM_RARE = 6;
export const ITEM_NAMES = ['', 'salvage', 'scrap', 'alloy', 'part', 'mass', 'rare'] as const;

function weapon(w: WeaponDef, shot: number, shotSpeed: number): Weapon {
  return {
    range: m2t(w.range),
    damage: w.damage,
    interval: 1 / w.shotsPerSecond,
    splashTargets: w.splashTargets,
    splashRadius: m2t(w.splashRadius),
    splashFactor: w.splashFactor,
    energyPerSecond: w.energyPerSecond,
    partsPerShot: w.partsPerShot,
    prefer: w.prefer ? ALIEN_KINDS.indexOf(w.prefer) : -1,
    shotSpeed,
    shot,
  };
}

const bd = map1.buildings;
const tiersOf = (d: BuildingDef) =>
  d.tiers?.map((t) => ({ hpMult: t.hpMult, damageMult: t.damageMult, cost: [t.upgradeCost.mass, t.upgradeCost.energy, t.upgradeCost.rare] as Cost, time: t.upgradeTime }));
const machineOf = (d: BuildingDef, input: number, output: number) => ({
  input,
  output,
  seconds: d.machine!.seconds,
  inputPerOutput: d.machine!.inputPerOutput,
  energyPerSecond: d.machine!.energyPerSecond,
});

const GATE_1 = gateStats(3);
const INFO: Record<BuildingKind, BuildingInfo> = {
  massExtractor: { label: bd.massExtractor.label, fw: 2, fh: 2, hp: bd.massExtractor.hp, cost: costOf(bd.massExtractor), buildTime: bd.massExtractor.buildTime, role: 'economy', income: [1, 0, 0], key: 'm' },
  generator: { label: bd.generator.label, fw: 2, fh: 2, hp: bd.generator.hp, cost: costOf(bd.generator), buildTime: bd.generator.buildTime, role: 'economy', income: [0, bd.generator.income!.energy!, 0], key: 'g' },
  rareExtractor: { label: bd.rareExtractor.label, fw: 2, fh: 2, hp: bd.rareExtractor.hp, cost: costOf(bd.rareExtractor), buildTime: bd.rareExtractor.buildTime, role: 'economy', income: [0, 0, RARE_EXTRACTOR_OUTPUT], key: 'k' },
  lab: { label: 'Research station', fw: 3, fh: 3, hp: bd.lab.hp, cost: costOf(bd.lab), buildTime: bd.lab.buildTime, role: 'economy', key: 'l' },
  depot: { label: bd.depot.label, fw: 2, fh: 2, hp: bd.depot.hp, cost: costOf(bd.depot), buildTime: bd.depot.buildTime, role: 'chain', key: 'p' },
  shredder: { label: bd.shredder.label, fw: 2, fh: 2, hp: bd.shredder.hp, cost: costOf(bd.shredder), buildTime: bd.shredder.buildTime, role: 'chain', machine: machineOf(bd.shredder, ITEM_SALVAGE, ITEM_SCRAP), key: '7' },
  smelter: { label: bd.smelter.label, fw: 2, fh: 2, hp: bd.smelter.hp, cost: costOf(bd.smelter), buildTime: bd.smelter.buildTime, role: 'chain', machine: machineOf(bd.smelter, ITEM_SCRAP, ITEM_ALLOY), key: '8' },
  assembler: { label: bd.assembler.label, fw: 2, fh: 2, hp: bd.assembler.hp, cost: costOf(bd.assembler), buildTime: bd.assembler.buildTime, role: 'chain', machine: machineOf(bd.assembler, ITEM_ALLOY, ITEM_PART), key: '9' },
  wall: { label: bd.wall.label, fw: 1, fh: 1, hp: bd.wall.hp, cost: costOf(bd.wall), buildTime: bd.wall.buildTime, role: 'wall', tiers: tiersOf(bd.wall), key: '1' },
  gun: { label: bd.gun.label, fw: 2, fh: 2, hp: bd.gun.hp, cost: costOf(bd.gun), buildTime: bd.gun.buildTime, role: 'defence', weapon: weapon(bd.gun.weapon!, P_BULLET, 30), tiers: tiersOf(bd.gun), key: '2' },
  area: { label: bd.area.label, fw: 2, fh: 2, hp: bd.area.hp, cost: costOf(bd.area), buildTime: bd.area.buildTime, role: 'defence', weapon: weapon(bd.area.weapon!, P_SHELL, 14), tiers: tiersOf(bd.area), key: '3' },
  beam: { label: bd.beam.label, fw: 2, fh: 2, hp: bd.beam.hp, cost: costOf(bd.beam), buildTime: bd.beam.buildTime, role: 'defence', weapon: weapon(bd.beam.weapon!, P_BEAM, 0), key: '4' },
  heavy: { label: bd.heavy.label, fw: 3, fh: 3, hp: bd.heavy.hp, cost: costOf(bd.heavy), buildTime: bd.heavy.buildTime, role: 'defence', weapon: weapon(bd.heavy.weapon!, P_HEAVY, 18), tiers: [HEAVY_T2], key: '5' },
  shield: { label: bd.shield.label, fw: 2, fh: 2, hp: bd.shield.hp, cost: costOf(bd.shield), buildTime: bd.shield.buildTime, role: 'defence', key: '6' },
  tempTurret: { label: 'Temporary turret', fw: 1, fh: 1, hp: map1.tempTurret.hp, cost: [0, 0, 0], buildTime: 1, role: 'defence', weapon: weapon(map1.tempTurret.weapon, P_BULLET, 30), key: '' },
  // Belt pieces: not in W12. First-pass numbers; cheap so a chain is a layout question, not a cost one.
  belt: { label: 'Conveyor belt', fw: 1, fh: 1, hp: 100, cost: [BELT_COST_MASS, 0, 0], buildTime: 4, role: 'floor', key: 'b' },
  splitter: { label: 'Splitter', fw: 1, fh: 1, hp: 150, cost: [10, 20, 0], buildTime: 10, role: 'floor', key: 'v' },
  merger: { label: 'Merger', fw: 1, fh: 1, hp: 150, cost: [10, 20, 0], buildTime: 10, role: 'floor', key: 'n' },
  // W24 gate: converted from finished walls only (gate.ts), never placed from the build bar. Its
  // footprint, hit points, cost and build time scale with the footprint (balance.ts gateStats);
  // these per-kind values are the depth-1 gate (3 wall tiles). Tiers follow the wall's tiers.
  gate: {
    label: 'Gate',
    fw: 3,
    fh: 1,
    hp: GATE_1.hp,
    cost: GATE_1.cost,
    buildTime: GATE_1.time,
    role: 'wall',
    tiers: tiersOf(bd.wall),
    key: '',
  },
  // W29: placed complete by createWorld on map 1 and in the sandbox; never built, reclaimed or
  // upgraded. buildTime is the repair time (repair restores maxHp per construction time).
  core: { label: 'Core', fw: 3, fh: 3, hp: CORE_HP, cost: [0, 0, 0], buildTime: CORE_REPAIR_TIME, role: 'core', key: '' },
};
/**
 * Every kind's fixed properties. `size` is W13's square footprint side, kept only because look/
 * (the W17 vista, layout.ts sizeOf) reads it; the game itself uses fw and fh (W24).
 */
export const BUILDING_INFO = Object.fromEntries(Object.entries(INFO).map(([k, v]) => [k, { ...v, size: v.fw }])) as Record<
  BuildingKind,
  BuildingInfo & { readonly size: number }
>;
export const buildingInfo = (kind: number): BuildingInfo => BUILDING_INFO[BUILDING_KINDS[kind]!];
/** Default footprint of a kind, [fw, fh] (a placed gate's own footprint is in its fw, fh columns). */
export const buildingFootprint = (kind: number): [number, number] => {
  const i = buildingInfo(kind);
  return [i.fw, i.fh];
};

export const SHIELD = {
  capacity: bd.shield.shield!.capacity,
  regenPerSecond: bd.shield.shield!.regenPerSecond,
  energyPerSecond: bd.shield.shield!.energyPerSecond,
  /** Tiles. W12 shields covered a whole approach; here a radius round the generator. */
  radius: 8,
};
export const TEMP_TURRET = { cooldown: map1.tempTurret.cooldown, lifetime: map1.tempTurret.lifetime };
export const BELT_TILES_PER_SECOND = map1.beltItemsPerSecond;
export const WRECK_DECAY_PER_SECOND = map1.wreckDecayPerSecond;
export const START_STOCK: Cost = [map1.startStock.mass, map1.startStock.energy, map1.startStock.rare];
export const COMMANDER_INCOME: Cost = [map1.commander.income.mass, map1.commander.income.energy, map1.commander.income.rare];
export const RECLAIM_RATE = map1.engineer.reclaimRate;
/** Salvage an engineer can carry before walking it to a depot (not in W12). */
export const CARRY_CAPACITY = 20;
export const START_ENGINEERS = map1.engineer.startCount;
export const isBelt = (kind: number): boolean => kind === B.belt || kind === B.splitter || kind === B.merger;

// ---- Aliens --------------------------------------------------------------------------------

// Target categories: one flow field each.
export const CAT_COMMANDER = 0;
export const CAT_DEFENCES = 1;
export const CAT_STRUCTURES = 2;
export const CAT_ECONOMY = 3;
export const CATEGORY_COUNT = 4;
export const CATEGORY_NAMES = ['commander', 'defences', 'walls and turrets', 'economy'] as const;

export interface MobileInfo {
  label: string;
  hp: number;
  /** Tiles per tick. */
  speed: number;
  /** Pick and draw radius in tiles. */
  radius: number;
}

export interface AlienInfo extends MobileInfo {
  armour: number;
  dps: number;
  structureMult: number;
  salvage: number;
  category: number;
  /** Slips round walls: its field charges buildings four times as much. */
  bypassWalls: boolean;
  /** Attack reach in tiles beyond touching. */
  reach: number;
}

const tilesPerTick = (metresPerSecond: number) => m2t(metresPerSecond) * TICK_SECONDS;
const ad = map1.aliens;
const alien = (k: AlienKind, radius: number, category: number): AlienInfo => ({
  label: ad[k].label,
  hp: ad[k].hp,
  speed: tilesPerTick(ad[k].speed),
  radius,
  armour: ad[k].armour,
  dps: ad[k].dps,
  structureMult: ad[k].structureMult,
  salvage: ad[k].salvage,
  category,
  bypassWalls: ad[k].bypassWalls,
  reach: 0.6,
});
export const ALIEN_INFO: Record<AlienKind, AlienInfo> = {
  rusher: alien('rusher', 0.35, CAT_DEFENCES),
  hunter: alien('hunter', 0.4, CAT_COMMANDER),
  breaker: alien('breaker', 0.8, CAT_STRUCTURES),
  saboteur: alien('saboteur', 0.45, CAT_ECONOMY),
};
/** W12's spawn spacing within a group, in ticks. */
export const SPAWN_INTERVAL_TICKS: Record<AlienKind, number> = {
  rusher: Math.round(ad.rusher.spawnInterval * TICK_HZ),
  hunter: Math.round(ad.hunter.spawnInterval * TICK_HZ),
  breaker: Math.round(ad.breaker.spawnInterval * TICK_HZ),
  saboteur: Math.round(ad.saboteur.spawnInterval * TICK_HZ),
};

// ---- Player units (commander and engineers) ------------------------------------------------
export const UNIT_KINDS = ['commander', 'engineer'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];
export const U = Object.fromEntries(UNIT_KINDS.map((k, i) => [k, i])) as Record<UnitKind, number>;

export interface UnitInfo extends MobileInfo {
  /** Build power (BP). */
  buildRate: number;
  /** Tiles from the footprint edge within which it can build. */
  buildRange: number;
  weapon?: Weapon;
}

// W12 has no walking speeds; these are first-pass values (commander 3 m/s, engineer 5 m/s).
export const UNIT_INFO: Record<UnitKind, UnitInfo> = {
  commander: {
    label: 'Commander',
    hp: map1.commander.hp,
    speed: tilesPerTick(3),
    radius: 0.9,
    buildRate: BUILD_RATE.commander,
    buildRange: 4,
    // W12's commander gun has range 0 (only aliens at the base); spatially it needs a reach: 16 m.
    weapon: { ...weapon(map1.commander.weapon, P_BULLET, 30), range: 8 },
  },
  engineer: { label: 'Engineer', hp: map1.engineer.hp, speed: tilesPerTick(5), radius: 0.45, buildRate: BUILD_RATE.engineer, buildRange: 3 },
};

export const alienInfo = (kind: number): AlienInfo => ALIEN_INFO[ALIEN_KINDS[kind]!];
export const unitInfo = (kind: number): UnitInfo => UNIT_INFO[UNIT_KINDS[kind]!];

/** Cost and build-power-seconds to build a gate with `tiles` footprint tiles. */
export function gateBuildWork(tiles: number): { cost: Cost; time: number } {
  const g = gateStats(tiles);
  return { cost: g.cost, time: g.time };
}

/** Cost and time of upgrading a gate from `tier`: the wall's tier upgrade × footprint tiles. */
export function gateUpgradeWork(tiles: number, tier: number): { cost: Cost; time: number } {
  const t = BUILDING_INFO.wall.tiers![tier - 1]!;
  return { cost: [t.cost[0] * tiles, t.cost[1] * tiles, t.cost[2] * tiles], time: t.time * tiles };
}

/**
 * Cost and BP·s of the work outstanding on a site, from columns both threads have: construction,
 * or the upgrade from `tier` when `upgrading`. World.workOf drains by it; W25b, the render thread's
 * waiting markers (render/waiting.ts) read from it which resources a site draws.
 */
export function siteWork(kind: number, upgrading: boolean, tier: number, fw: number, fh: number): { cost: Cost; time: number } {
  if (kind === B.gate) return upgrading ? gateUpgradeWork(fw * fh, tier) : gateBuildWork(fw * fh);
  const info = buildingInfo(kind);
  if (upgrading) {
    const t = info.tiers![tier - 1]!;
    return { cost: t.cost, time: t.time };
  }
  return { cost: info.cost, time: info.buildTime };
}
