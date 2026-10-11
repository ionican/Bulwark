// Game-side balance: every number the game adds to, or changes from, the W12 model
// (model/data/map1.ts). W12 numbers are used unchanged wherever they exist; anything here is
// either new (W12 had no equivalent) or an adjustment, and each one says which and why.
// The README lists the adjustments.

import { map1 } from '../../../model/data/map1.ts';
import type { Cost } from './kinds.ts';

const res = (r: { mass: number; energy: number; rare: number }): Cost => [r.mass, r.energy, r.rare];
const W12R = map1.research;

// ---- research ------------------------------------------------------------------------------
// Research stations (W12 "lab") make research points (RP) at W12's labRate: 1 RP per second each.
// A node needs `seconds` RP (W12's research duration at one lab) and drains its W12 cost over
// that time, by the same worst-supply-ratio rule as construction. Only one node runs at a time.

export type Branch = 'defence' | 'economy' | 'intel' | 'commander' | 'experimental';
export const BRANCHES: Array<[Branch, string]> = [
  ['defence', 'Defence'],
  ['economy', 'Economy'],
  ['intel', 'Intel'],
  ['commander', 'Commander and engineers'],
  ['experimental', 'Experimental structures'],
];

export interface ResearchNode {
  id: string;
  label: string;
  branch: Branch;
  /** What it does, in a few words (shown in the panel). */
  effect: string;
  cost: Cost;
  /** RP needed (= seconds at one station). */
  seconds: number;
  requires?: string;
  /** Source of the numbers. */
  source: 'W12' | 'new';
}

export const RESEARCH: ResearchNode[] = [
  { id: 'wallT2', label: 'Wall tier 2', branch: 'defence', effect: 'walls can be upgraded to 2× hp', cost: res(W12R.wallT2.cost), seconds: W12R.wallT2.seconds, source: 'W12' },
  { id: 'wallT3', label: 'Wall tier 3', branch: 'defence', effect: 'walls can be upgraded to 3.5× hp', cost: res(W12R.wallT3.cost), seconds: W12R.wallT3.seconds, requires: 'wallT2', source: 'W12' },
  { id: 'gunT2', label: 'Gun turret tier 2', branch: 'defence', effect: 'gun turrets can be upgraded: 1.5× hp and damage', cost: res(W12R.gunT2.cost), seconds: W12R.gunT2.seconds, source: 'W12' },
  { id: 'areaT2', label: 'Area cannon tier 2', branch: 'defence', effect: 'area cannons can be upgraded: 1.5× hp and damage', cost: res(W12R.areaT2.cost), seconds: W12R.areaT2.seconds, source: 'W12' },
  { id: 'beam', label: 'Beam turret', branch: 'defence', effect: 'unlocks the beam turret', cost: res(W12R.beam.cost), seconds: W12R.beam.seconds, source: 'W12' },
  { id: 'shield', label: 'Shield generator', branch: 'defence', effect: 'unlocks the shield generator', cost: res(W12R.shield.cost), seconds: W12R.shield.seconds, source: 'W12' },
  // New (W12 had no economy, intel or engineer research; costs sized like W12's tier-2 nodes).
  { id: 'extractors', label: 'Deep drills', branch: 'economy', effect: 'mass extractors +25% output', cost: [100, 1000, 15], seconds: 45, source: 'new' },
  { id: 'scanners', label: 'Long-range scanners', branch: 'intel', effect: 'wave ticker also shows the wave after next', cost: [50, 800, 10], seconds: 30, source: 'new' },
  { id: 'fieldEng', label: 'Field engineering', branch: 'commander', effect: 'engineers build 50% faster; turret drop cooldown 75 s → 50 s', cost: [100, 1200, 15], seconds: 45, source: 'new' },
  // Experimental structures branch: the part-fed heavy cannon is the first-slice stand-in for
  // experimental structures (W15/W7: experimentals are fed by conveyor-made parts).
  { id: 'heavy', label: 'Heavy cannon', branch: 'experimental', effect: 'unlocks the heavy cannon (fires advanced parts)', cost: res(W12R.heavy.cost), seconds: W12R.heavy.seconds, source: 'W12' },
  { id: 'heavyT2', label: 'Heavy cannon tier 2', branch: 'experimental', effect: 'heavy cannons can be upgraded: 1.5× hp and damage', cost: [150, 2000, 30], seconds: 60, requires: 'heavy', source: 'new' },
];
export const RESEARCH_INDEX = Object.fromEntries(RESEARCH.map((r, i) => [r.id, i])) as Record<string, number>;
export const researchBit = (id: string): number => 1 << RESEARCH_INDEX[id]!;

/** Research a building kind needs before it can be built (W12 `requires`). */
export const BUILD_REQUIRES: Record<string, string> = { beam: 'beam', heavy: 'heavy', shield: 'shield' };
/** Research each upgrade tier needs: kind -> [tier 2, tier 3]. */
export const TIER_REQUIRES: Record<string, string[]> = { wall: ['wallT2', 'wallT3'], gate: ['wallT2', 'wallT3'], gun: ['gunT2'], area: ['areaT2'], heavy: ['heavyT2'] };
/** Heavy cannon tier 2 (new; same shape as W12's gun and area tier 2). */
export const HEAVY_T2 = { hpMult: 1.5, damageMult: 1.5, cost: [250, 1000, 10] as Cost, time: 200 };

export const EXTRACTOR_BOOST = 1.25;
export const FIELD_ENG_BUILD_MULT = 1.5;
export const FIELD_ENG_TURRET_COOLDOWN = 50;

// ---- engineers -----------------------------------------------------------------------------
// The commander produces engineers (W12 cost and build time; W12 put them in the build queue).
export const ENGINEER_COST: Cost = res(map1.buildings.engineer.cost);
export const ENGINEER_BUILD_TIME = map1.buildings.engineer.buildTime;

// ---- waves ---------------------------------------------------------------------------------
/**
 * Calling the next wave early pays, per second skipped: 1.5 mass and 5 energy (half a commander's
 * mass income plus half its energy income, times three). New; W9 only says "a bonus".
 * bonus = skippedTicks / 10 × [1.5, 5, 0]
 */
export const CALL_EARLY_BONUS_PER_SECOND: Cost = [1.5, 5, 0];
export const callEarlyBonus = (skippedTicks: number): Cost => [
  (skippedTicks / 10) * CALL_EARLY_BONUS_PER_SECOND[0],
  (skippedTicks / 10) * CALL_EARLY_BONUS_PER_SECOND[1],
  (skippedTicks / 10) * CALL_EARLY_BONUS_PER_SECOND[2],
];

// ---- gates (W24) ---------------------------------------------------------------------------
/**
 * A gate is converted from finished walls (gate.ts). New: its cost and build time are the wall's
 * per-tile cost and build time × footprint tiles × 1.5, so a gate costs half as much again as the
 * walls it replaces (which are removed with no refund). Its hit points are the wall's tier-1 hit
 * points × footprint tiles; its upgrade tiers are the wall's, with cost and time × footprint tiles.
 */
export const GATE_COST_MULT = 1.5;
/** Tier-1 hit points, cost and build-power-seconds of a gate with `tiles` footprint tiles (before tuning). */
export function gateStats(tiles: number): { hp: number; cost: Cost; time: number } {
  const wall = map1.buildings.wall;
  const m = tiles * GATE_COST_MULT;
  return { hp: wall.hp * tiles, cost: [wall.cost.mass * m, wall.cost.energy * m, wall.cost.rare * m], time: wall.buildTime * m };
}

// ---- sandbox (W24) -------------------------------------------------------------------------
/** Sandbox: a dead commander reappears at the base after 10 s (new; Richard's default, PLAN W24). */
export const SANDBOX_RESPAWN_TICKS = 100;
/**
 * Salvage in the commander's wreck (new; W12's commander leaves no wreck). One engineer load
 * (kinds.ts CARRY_CAPACITY), so the wreck can be reclaimed and lasts about 25 minutes of W12's decay.
 */
export const COMMANDER_WRECK_SALVAGE = 20;
/** Sandbox tuning multipliers are clamped to this range (PLAN W24: 0.1× to 10×). */
export const TUNE_MIN = 0.1;
export const TUNE_MAX = 10;
/** Most aliens one sandbox spawnAt places (validate.ts; the Spawn tab's count). */
export const SPAWN_AT_MAX = 50;
/** Deepest wall run, in rows (validate.ts buildRun; the Build tab's depth buttons). */
export const MAX_RUN_DEPTH = 4;

// ---- belts and the core (W29) ---------------------------------------------------------------
/** Mass per belt tile (Richard's 0.5, PLAN W29 item 6; was 2). Splitter and merger keep their cost. */
export const BELT_COST_MASS = 0.5;
/** An extractor's buffer holds this many seconds of its output, then stops digging (W29 model). */
export const EXTRACTOR_BUFFER_SECONDS = 180;
/** Core hit points (W29 model). At 0 it is disabled, not destroyed. */
export const CORE_HP = 4000;
/** Seconds an alien attacks the core in passing before it moves on (W29 model). */
export const CORE_PASS_SECONDS = 5;
/** Build-power-seconds to repair the core from 0 (first pass: the commander alone takes 25 s). */
export const CORE_REPAIR_TIME = 200;
/**
 * The core's anchor tile relative to the map's base (first pass): on map 1, tiles x 61–63, z 63–65,
 * centre (62.5, 64.5), 2 tiles west of the commander's start (64.5, 64.5); clear of the start units
 * and of every footprint in test/plans.ts (the area cannon at 59,62, the shields at 63,61 and 60,66).
 */
export const CORE_OFFSET: readonly [number, number] = [-3, -1];

// ---- adjustments to W12 numbers ------------------------------------------------------------
// Each is listed in the README with its reason. Nothing else in the game changes a W12 number.

/** Rare material per second per rare extractor. W12: 0.1. */
export const RARE_EXTRACTOR_OUTPUT = 0.25;

/** Build power (BP). W12: commander 10, engineer 5. */
export const BUILD_RATE = { commander: 8, engineer: map1.engineer.buildRate } as const;

export const ADJUSTMENTS: Array<{ what: string; from: string; to: string; why: string }> = [
  {
    what: 'Rare extractor output',
    from: `${map1.buildings.rareExtractor.income!.rare} per second`,
    to: `${RARE_EXTRACTOR_OUTPUT} per second`,
    why:
      'With 0.1/s the scripted balanced plan collected about 300 rare in 48 minutes: the two north points sit 30 tiles beyond the north line and saboteurs keep killing them, as W12 also saw. Research took all of it, so no beam turret stood before minute 32, and the hunter waves (14, 16, 17, 19, 20) killed the commander every run.',
  },
  {
    what: 'Commander build power',
    from: `${map1.commander.buildRate} BP`,
    to: `${BUILD_RATE.commander} BP`,
    why: "Richard's decision (2026-10-08, W24): commander 8, engineer 5, so the commander builds less than two engineers together. W12 (model/data/map1.ts) keeps 10 as the balance reference.",
  },
];
