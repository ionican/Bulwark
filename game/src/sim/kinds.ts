// Entity kinds and their fixed properties. Numbers come from the W12 model (model/data/map1.ts);
// footprints, sizes, ranges in tiles and the belt pieces are new here because W12 is not spatial.
//
// Scale: 1 tile = 2 m. Map 1 is 128 × 128 tiles (256 m). Every W12 distance in metres is halved
// to get tiles; every W12 speed in m/s is halved and multiplied by the tick length.

import { map1 } from '../../../model/data/map1.ts';
import type { BuildingDef, WeaponDef } from '../../../model/src/types.ts';
import { BELT_COST_MASS, BELT_UPGRADES, BUILD_RATE, CORE_HP, CORE_REPAIR_TIME, HEAVY_T2, RARE_EXTRACTOR_OUTPUT, gateStats, tierRequires } from './balance.ts';
import { BF_COMPLETE, BF_UPGRADING } from './schema.ts';

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
  /** Tier 2 (and 3 for walls and belts), each gated by research (balance.ts TIER_REQUIRES). */
  tiers?: Array<{ hpMult: number; damageMult: number; cost: Cost; time: number }>;
  /** Hotkey in the build bar. */
  key: string;
  /** Set: never placed or built by command; the text is the refusal reason (validate.ts). */
  placedBy?: string;
  /** W29 core: at 0 hp it is disabled (BF_DISABLED) and ignores damage, never removed (combat.ts damageBuilding). */
  disablesAtZero?: true;
  /** W29 core: impassable in every flow-field grid, never broken through or kept as a target (aliens attack it only in passing). */
  impassable?: true;
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
  tempTurret: { label: 'Temporary turret', fw: 1, fh: 1, hp: map1.tempTurret.hp, cost: [0, 0, 0], buildTime: 1, role: 'defence', weapon: weapon(map1.tempTurret.weapon, P_BULLET, 30), key: '', placedBy: 'the temporary turret is dropped by an engineer, not built' },
  // Belt pieces: not in W12. First-pass numbers; cheap so a chain is a layout question, not a cost one.
  // W31: tier 1/2/3 = Slow/Medium/Fast (BELT_STEP below). The tiers change speed only.
  belt: {
    label: 'Conveyor belt',
    fw: 1,
    fh: 1,
    hp: 100,
    cost: [BELT_COST_MASS, 0, 0],
    buildTime: 4,
    role: 'floor',
    tiers: BELT_UPGRADES.map((u) => ({ hpMult: 1, damageMult: 1, cost: [u.mass, 0, 0] as Cost, time: u.time })),
    key: 'b',
  },
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
    placedBy: 'a gate is made from finished walls (the gate command), not built',
  },
  // W29: placed complete by createWorld on map 1 and in the sandbox; never built, reclaimed (reclaim
  // takes wrecks only) or upgraded (no tiers). buildTime is the repair time (repair restores maxHp per
  // construction time).
  core: {
    label: 'Core',
    fw: 3,
    fh: 3,
    hp: CORE_HP,
    cost: [0, 0, 0],
    buildTime: CORE_REPAIR_TIME,
    role: 'core',
    key: '',
    placedBy: 'the core stands from the start; it is not built or placed',
    disablesAtZero: true,
    impassable: true,
  },
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
// W31: belt speed is the crossing time of a tile in whole ticks, by tier (index 0 unused): Slow 6,
// Medium 4, Fast 3 (build 170's belt, step 0.4, unchanged tick for tick). An item's stored f32
// position reaches 1 in exactly that many steps. Splitter and merger move at the Fast step.
export const BELT_TOP_TIER = 3;
export const BELT_TICKS_PER_TILE = [0, 6, 4, 3] as const;
export const BELT_STEP = [0, 1 / 6, 0.25, 0.4] as const;
export const BELT_SPEED_NAMES = ['', 'Slow', 'Medium', 'Fast'] as const;
/** Tiles a second an item crosses on a belt of `tier` (Slow 1.67, Medium 2.5, Fast 3.33). */
export const beltTilesPerSecond = (tier: number): number => TICK_HZ / BELT_TICKS_PER_TILE[tier]!;
/** "Slow (1.7 tiles/s)" per tier, worked out once. */
const BELT_SPEED_TEXT = BELT_SPEED_NAMES.map((name, t) => (t ? `${name} (${beltTilesPerSecond(t).toFixed(1)} tiles/s)` : ''));
/** "Slow (1.7 tiles/s)": the readout's name for a belt speed. */
export const beltSpeedText = (tier: number): string => BELT_SPEED_TEXT[tier]!;
/** A tier's name in messages: a belt's speed ("Medium"), any other kind's "tier 2". */
export const tierName = (kind: number, tier: number): string => (kind === B.belt ? BELT_SPEED_NAMES[tier]! : `tier ${tier}`);
/**
 * Why a building is not upgraded by a drag along belts (W31): not a finished belt, already upgrading,
 * at Fast, or its next speed not researched; W32: being demolished.
 */
export type BeltUpgradeSkip = 'notBelt' | 'upgrading' | 'top' | 'locked' | 'demolishing';
/**
 * W31: the one rule both the upgrade drag's preview (dragPlan.ts planBeltUpgrade, on a snapshot) and
 * the upgradeBelts command (validate.ts planBeltUpgrades, on the world) apply to a building of `kind`
 * with `flags` at `tier`: null when it goes up one speed, else why not. `researched` takes a research
 * id. W32: `demolish` is the building's demolish progress (above 0: being demolished, skipped).
 */
export function beltUpgradeSkip(kind: number, flags: number, tier: number, researched: (id: string) => boolean, demolish = 0): BeltUpgradeSkip | null {
  if (kind !== B.belt || !(flags & BF_COMPLETE)) return 'notBelt';
  if (demolish > 0) return 'demolishing';
  if (flags & BF_UPGRADING) return 'upgrading';
  if (tier >= BELT_TOP_TIER) return 'top';
  const req = tierRequires('belt', tier + 1);
  return req && !researched(req) ? 'locked' : null;
}
/** True for a tier a belt may have: an integer 1..3. */
export const isBeltTier = (tier: unknown): tier is number => typeof tier === 'number' && Number.isInteger(tier) && tier >= 1 && tier <= BELT_TOP_TIER;
export const WRECK_DECAY_PER_SECOND = map1.wreckDecayPerSecond;
export const START_STOCK: Cost = [map1.startStock.mass, map1.startStock.energy, map1.startStock.rare];
export const COMMANDER_INCOME: Cost = [map1.commander.income.mass, map1.commander.income.energy, map1.commander.income.rare];
export const RECLAIM_RATE = map1.engineer.reclaimRate;
/** Salvage an engineer can carry before walking it to a depot (not in W12). */
export const CARRY_CAPACITY = 20;
export const START_ENGINEERS = map1.engineer.startCount;
export const isBelt = (kind: number): boolean => kind === B.belt || kind === B.splitter || kind === B.merger;
/** A mass or rare extractor (W29: with belts on, it digs into its own buffer). */
export const isExtractor = (kind: number): boolean => kind === B.massExtractor || kind === B.rareExtractor;

/** Belt direction 0..3: +x, +z, −x, −z (a tile step per direction). */
export const BDX = [1, 0, -1, 0] as const;
export const BDZ = [0, 1, 0, -1] as const;

/**
 * The directions a belt piece of `kind` facing `dir` puts items out to: a splitter to its left and
 * right (never its front), a belt or merger to its front. The conveyor (conveyor.ts) and the belt
 * shapes the renderer draws (render/beltShapes.ts) both read this.
 */
export function outputDirs(kind: number, dir: number): readonly number[] {
  return kind === B.splitter ? [(dir + 1) & 3, (dir + 3) & 3] : [dir & 3];
}

/**
 * Whether a complete building of `kind` puts items on belts (conveyor.ts stepConveyors): a depot
 * (salvage), a chain machine whose output is an item (the assembler's parts go to the pool, not a
 * belt) and, with belts on (World.belts), an extractor. Each puts them only on a belt in its
 * outputRing whose direction is the cell's away direction (its back faces the building).
 */
export function outputsToBelts(kind: number, belts: boolean): boolean {
  if (kind === B.depot) return true;
  if (isExtractor(kind)) return belts;
  const m = buildingInfo(kind).machine;
  return m !== undefined && m.output !== ITEM_PART;
}

/**
 * The cells a building with footprint fw × fh at (tx, ty) puts items into, each with the direction
 * pointing away from the footprint, in conveyor.ts's round-robin order (for a square footprint
 * W13's: east, south, west, north for each i). Cells may lie off the map.
 */
export function outputRing(tx: number, ty: number, fw: number, fh: number): Array<[number, number, number]> {
  const ring: Array<[number, number, number]> = [];
  for (let i = 0; i < Math.max(fw, fh); i++) {
    if (i < fh) ring.push([tx + fw, ty + i, 0]);
    if (i < fw) ring.push([tx + i, ty + fh, 1]);
    if (i < fh) ring.push([tx - 1, ty + i, 2]);
    if (i < fw) ring.push([tx + i, ty - 1, 3]);
  }
  return ring;
}

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
 * waiting markers (render/waiting.ts) read from it which resources a site draws. W31: a belt site
 * laid at tier 2 or 3 costs the base plus every upgrade step below it (beltLaidWork).
 */
export function siteWork(kind: number, upgrading: boolean, tier: number, fw: number, fh: number): { cost: Cost; time: number } {
  if (kind === B.gate) return upgrading ? gateUpgradeWork(fw * fh, tier) : gateBuildWork(fw * fh);
  const info = buildingInfo(kind);
  if (upgrading) {
    const t = info.tiers![tier - 1]!;
    return { cost: t.cost, time: t.time };
  }
  if (kind === B.belt && tier > 1) return beltLaidWork(tier);
  return { cost: info.cost, time: info.buildTime };
}

/** W31: cost and BP·s of laying a belt at each tier (index = tier; 0 unused): the Slow belt plus each upgrade below it. Built once, frozen. */
const BELT_LAID_WORK: ReadonlyArray<{ readonly cost: Cost; readonly time: number }> = Object.freeze(
  [0, 1, 2, 3].map((tier) => {
    const info = BUILDING_INFO.belt;
    const cost: Cost = [...info.cost];
    let time = info.buildTime;
    for (let t = 1; t < tier; t++) {
      const up = info.tiers![t - 1]!;
      for (let k = 0; k < 3; k++) cost[k] = cost[k]! + up.cost[k]!;
      time += up.time;
    }
    return Object.freeze({ cost: Object.freeze(cost) as Cost, time });
  }),
);
/** W31: cost and BP·s of laying a belt at `tier` (a shared frozen entry: siteWork runs per site per tick and per frame). */
export function beltLaidWork(tier: number): { cost: Cost; time: number } {
  return BELT_LAID_WORK[tier]!;
}

// ---- W32: demolish ----------------------------------------------------------------------------

/** Why a building is not a demolish target (W32): the core, or an unfinished site (its cancel rule stays). */
export type DemolishSkip = 'core' | 'site';
/**
 * W32: the one rule both the demolish drag's preview (dragPlan.ts planDemolishPreview, on a snapshot)
 * and the demolish command (validate.ts planDemolish, on the world) apply to a building of `kind`
 * with `flags`: null when it can be demolished, else why not. A building already being demolished is
 * a target (more engineers may join; a paused demolish resumes).
 */
export function demolishSkip(kind: number, flags: number): DemolishSkip | null {
  if (kind === B.core) return 'core';
  return flags & BF_COMPLETE ? null : 'site';
}

/**
 * W32: the cost and BP·s that went into a finished building of `kind` at `tier` with footprint
 * fw × fh: its laid cost (siteWork) and each upgrade step below its tier (a belt: beltLaidWork).
 * `upgradeDone` (0..1) adds that share of the cost of the upgrade under way (BF_UPGRADING, the
 * stored progress); its time is not added.
 */
export function builtWork(kind: number, tier: number, fw: number, fh: number, upgradeDone = 0): { cost: Cost; time: number } {
  const laid = siteWork(kind, false, 1, fw, fh);
  const cost: Cost = [...laid.cost];
  let time = laid.time;
  for (let t = 1; t < tier; t++) {
    const up = siteWork(kind, true, t, fw, fh);
    for (let k = 0; k < 3; k++) cost[k] = cost[k]! + up.cost[k]!;
    time += up.time;
  }
  if (upgradeDone > 0) {
    const up = siteWork(kind, true, tier, fw, fh);
    for (let k = 0; k < 3; k++) cost[k] = cost[k]! + upgradeDone * up.cost[k]!;
  }
  return { cost, time };
}

/** W32: what demolishing a building returns to the pool: half the mass and rare it cost (builtWork), no energy. */
export function demolishRefund(kind: number, tier: number, fw: number, fh: number, upgradeDone = 0): Cost {
  const { cost } = builtWork(kind, tier, fw, fh, upgradeDone);
  return [cost[0] * 0.5, 0, cost[2] * 0.5];
}

/** W32: BP·s of work to demolish a building: half its build time (builtWork, upgrades included). */
export function demolishTime(kind: number, tier: number, fw: number, fh: number): number {
  return builtWork(kind, tier, fw, fh).time * 0.5;
}
