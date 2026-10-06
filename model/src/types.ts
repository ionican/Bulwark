// Shared types for the W12 economy and wave-pacing model.

export const RES = ['mass', 'energy', 'rare'] as const;
export type ResKey = (typeof RES)[number];
export type Res = Record<ResKey, number>;

export const zeroRes = (): Res => ({ mass: 0, energy: 0, rare: 0 });
export const res = (mass = 0, energy = 0, rare = 0): Res => ({ mass, energy, rare });

export type AlienKind = 'rusher' | 'hunter' | 'breaker' | 'saboteur';
export const ALIEN_KINDS: AlienKind[] = ['rusher', 'hunter', 'breaker', 'saboteur'];

/** What a surviving alien damages once it reaches its goal. */
export type TargetCategory = 'commander' | 'defences' | 'economy';

export interface AlienDef {
  label: string;
  hp: number;
  /** Flat reduction applied to every incoming shot (minimum 10% of the shot gets through). */
  armour: number;
  /** Metres per second along the approach. */
  speed: number;
  /** Damage per second against its current target. */
  dps: number;
  /** Multiplier on dps against walls and turrets (wall-breakers). */
  structureMult: number;
  /** Salvage left in the wreck when killed. */
  salvage: number;
  target: TargetCategory;
  /** True: slips round standing walls (slowed by the detour) instead of stopping to break them. */
  bypassWalls: boolean;
  /** Seconds between spawns of this kind within a wave group. */
  spawnInterval: number;
}

/** Where a building sits. An approach id (e.g. 'north'), 'core' (inner base defence) or 'base' (economy). */
export type Place = string;

export type BuildingKind =
  | 'massExtractor'
  | 'generator'
  | 'rareExtractor'
  | 'storage'
  | 'depot'
  | 'shredder'
  | 'smelter'
  | 'assembler'
  | 'lab'
  | 'engineer'
  | 'wall'
  | 'gun'
  | 'area'
  | 'beam'
  | 'heavy'
  | 'shield';

export type Role = 'economy' | 'chain' | 'wall' | 'defence' | 'unit';

export type ResearchId = 'beam' | 'heavy' | 'shield' | 'gunT2' | 'areaT2' | 'wallT2' | 'wallT3';

export interface WeaponDef {
  /** Metres from the base perimeter. Aliens with dist <= range on the same approach can be hit. */
  range: number;
  damage: number;
  shotsPerSecond: number;
  /** Extra aliens hit by each shot (area cannon). */
  splashTargets: number;
  /** Metres either side of the primary target within which splash lands. */
  splashRadius: number;
  /** Fraction of the shot's damage that splash targets take. */
  splashFactor: number;
  /** Energy drawn per second while the weapon has a target (beam turret). */
  energyPerSecond: number;
  /** Advanced parts consumed per shot (heavy cannon). The shot is held if the stock is short. */
  partsPerShot: number;
  /** Alien kind this weapon picks first when one is in range. */
  prefer?: AlienKind;
}

export interface TierDef {
  hpMult: number;
  damageMult: number;
  upgradeCost: Res;
  upgradeTime: number;
  requires: ResearchId;
}

export interface BuildingDef {
  label: string;
  role: Role;
  cost: Res;
  /** Build-power-seconds. One builder of build rate 5 finishes a 100 BP·s item in 20 s. */
  buildTime: number;
  hp: number;
  requires?: ResearchId;
  income?: Partial<Res>;
  storage?: Partial<Res>;
  weapon?: WeaponDef;
  shield?: { capacity: number; regenPerSecond: number; energyPerSecond: number };
  machine?: { stage: 0 | 1 | 2; seconds: number; inputPerOutput: number; energyPerSecond: number };
  /** tiers[0] is tier 2, tiers[1] is tier 3. */
  tiers?: TierDef[];
}

export interface ResearchDef {
  label: string;
  cost: Res;
  /** Seconds at the lab's research rate of 1. */
  seconds: number;
}

export interface WaveGroup {
  entry: string;
  kind: AlienKind;
  count: number;
}

export interface Wave {
  n: number;
  /** Seconds of game time at which the wave starts to arrive. */
  at: number;
  groups: WaveGroup[];
}

export interface CommanderDef {
  hp: number;
  buildRate: number;
  income: Res;
  weapon: WeaponDef;
}

export interface EngineerDef {
  startCount: number;
  buildRate: number;
  hp: number;
  /** Salvage reclaimed per second by one engineer while wrecks remain. */
  reclaimRate: number;
}

export interface TempTurretDef {
  cooldown: number;
  lifetime: number;
  hp: number;
  weapon: WeaponDef;
}

export interface MapData {
  name: string;
  approaches: string[];
  /** Metres from spawn to the base perimeter on every approach. */
  approachLength: number;
  /** Metres from the perimeter at which walls stand. */
  wallLine: number;
  /** Speed multiplier for wall-bypassing aliens while inside wallLine + detourZone and walls stand. */
  detourFactor: number;
  detourZone: number;
  /** Metres from the perimeter at which the contested rare points sit on their approach. */
  rarePointDist: number;
  massDeposits: number;
  rarePoints: Record<string, number>;
  startStock: Res;
  /** Storage cap with no storage buildings (capped variant only). */
  baseStorage: Res;
  /** Fraction of on-field wreck salvage lost per second. */
  wreckDecayPerSecond: number;
  /** One-lane belt limit on items per second through each chain stage. */
  beltItemsPerSecond: number;
  labRate: number;
  commander: CommanderDef;
  engineer: EngineerDef;
  tempTurret: TempTurretDef;
  buildings: Record<BuildingKind, BuildingDef>;
  research: Record<ResearchId, ResearchDef>;
  aliens: Record<AlienKind, AlienDef>;
  waves: Wave[];
}

export type StorageVariant = 'uncapped' | 'capped';
