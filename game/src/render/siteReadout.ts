// W28: the construction hover readout (Richard, 2026-10-09). Hovering a building site — reserved,
// started, or a complete building being upgraded — shows its kind, how far along it is, what it
// takes in per second of game time and how many builders work on it.
//
// Intake per resource is worked out from the last two snapshots: cost × Δprogress ÷ Δgame-seconds.
// The cost is the one the simulation charges (sim/economy.ts stepConstruction spends cost ×
// progress done per tick, with the cost from kinds.ts siteWork, which world.ts workOf calls), so
// the figure is what the site actually drew. A starved site shows 0/s on a snapshot where it made no
// progress and the figure again when supply returns: no smoothing. Equal ticks (paused) show
// "paused"; a site with no earlier sample of the same work (just placed, an upgrade just started,
// a new world) shows "measuring". Text and numbers only, never colour.
//
// W24 run 3 (D2): each resource line reads "<resource> <received> / <wanted> per s". Wanted is the
// rate at full supply: cost × the summed build power of the units working on the site ÷ its build
// time, with the build power from the simulation's own unitBuildRate (kind, Field Engineering, the
// buildRate tune) and cost and time from siteWork, as economy.ts stepConstruction spends them.
// Working units are those building with `work` (id + 1) naming the site in the later snapshot. With
// none: "<resource> <received> / no builder". `stable`: both snapshots have the same working units
// and the same tuning and research, so the received figure was earned at the wanted rate's terms.
//
// Pure: no DOM, no three.js (ui/siteHover.ts draws the panel; main.ts picks the site under the cursor).

import type { Snapshot } from '../sim/snapshot.ts';
import { BF_COMPLETE, BF_UPGRADING, US_BUILDING, isReserved } from '../sim/schema.ts';
import { TICK_HZ, buildingInfo, siteWork } from '../sim/kinds.ts';
import { unitBuildRate } from '../sim/tuning.ts';
import { sameRules, snapshotRules } from '../snapshotRules.ts';
import { RESOURCE_NAMES, type ResourceName } from './waiting.ts';

export interface SiteIntake {
  resource: ResourceName;
  /** Received, per second of game time; null while paused or measuring. */
  perSecond: number | null;
  /** Wanted at full supply by the units working on the site, per second; null with no builder. */
  wanted: number | null;
}

export interface SiteReadout {
  id: number;
  name: string;
  /** The tier an upgrade leads to; 0 when the building is being constructed. */
  upgradeTo: number;
  reserved: boolean;
  /** Whole percent complete (rounded down: 100 only when done). */
  percent: number;
  /** One entry per resource the work costs (non-zero cost only), in mass, energy, rare order. */
  intake: SiteIntake[];
  /** Why the intake has no figure: equal ticks, or no earlier sample of the same work. */
  intakeNote: '' | 'paused' | 'measuring';
  builders: number;
  /** Units building this site in the later snapshot. */
  working: number;
  /** Both snapshots have the same working units, tuning and research. */
  stable: boolean;
  /** The panel's text, one line each. */
  lines: string[];
}

/** The row of building `id` in a snapshot (-1: not in it). */
export function rowOf(snap: Snapshot, id: number): number {
  const ids = snap.buildings.id;
  for (let r = 0; r < snap.buildings.count; r++) if (ids[r] === id) return r;
  return -1;
}

/**
 * The units building `id` in `s`: their ids, ascending (unit rows are in slot order, not id order),
 * and their summed build power with the simulation's multipliers. One pass over the units.
 */
function workers(s: Snapshot, id: number): { ids: number[]; power: number } {
  const u = s.units;
  const ids: number[] = [];
  let power = 0;
  for (let r = 0; r < u.count; r++)
    if (u.cols.state[r] === US_BUILDING && u.cols.work[r]! - 1 === id) {
      ids.push(u.id[r]!);
      power += unitBuildRate(snapshotRules(s), u.cols.kind[r]!);
    }
  return { ids: ids.sort((a, b) => a - b), power };
}

/** "20", "2.5", "0.33", "0". */
export function formatRate(v: number): string {
  if (v === 0) return '0';
  if (v >= 10) return v.toFixed(0);
  if (v >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

/**
 * The readout for building `id` in `curr`, with `prev` the snapshot before it (null when there is
 * none). Null when `id` is not a building site in `curr` (not found, or complete and not upgrading).
 */
export function siteReadout(prev: Snapshot | null, curr: Snapshot, id: number): SiteReadout | null {
  const r = rowOf(curr, id);
  if (r < 0) return null;
  const c = curr.buildings.cols;
  const flags = c.flags[r]!;
  const upgrading = (flags & BF_UPGRADING) !== 0;
  if (flags & BF_COMPLETE && !upgrading) return null;
  const kind = c.kind[r]!;
  const tier = c.tier[r]!;
  const { cost, time } = siteWork(kind, upgrading, tier, c.fw[r]!, c.fh[r]!);
  const progress = c.progress[r]!;
  const reserved = !upgrading && isReserved(flags);
  // the earlier sample must be of the same work: same building, same construction or upgrade
  const pr = prev ? rowOf(prev, id) : -1;
  const pc = prev?.buildings.cols;
  const same = pr >= 0 && prev!.tick <= curr.tick && ((pc!.flags[pr]! & BF_UPGRADING) !== 0) === upgrading && pc!.tier[pr]! === tier && pc!.kind[pr]! === kind;
  const dt = same ? (curr.tick - prev!.tick) / TICK_HZ : 0;
  const intakeNote: SiteReadout['intakeNote'] = !same ? 'measuring' : dt === 0 ? 'paused' : '';
  const done = intakeNote ? 0 : Math.max(0, progress - pc!.progress[pr]!);
  const { ids: working, power: bp } = workers(curr, id);
  const before = prev ? workers(prev, id).ids : null;
  const stable = !!prev && before!.length === working.length && before!.every((v, i) => v === working[i]) && sameRules(prev, curr);
  const intake: SiteIntake[] = [];
  RESOURCE_NAMES.forEach((resource, k) => {
    if (cost[k]! > 0) intake.push({ resource, perSecond: intakeNote ? null : (cost[k]! * done) / dt, wanted: working.length ? (cost[k]! * bp) / time : null });
  });
  const name = buildingInfo(kind).label;
  const upgradeTo = upgrading ? tier + 1 : 0;
  const percent = Math.min(100, Math.floor(progress * 100 + 1e-6));
  const builders = c.builders[r]!;
  const lines = [
    upgrading ? `${name} — upgrading to tier ${upgradeTo}` : name,
    reserved ? 'reserved — not started' : `${percent}% complete`,
    ...intake.map((i) => `${i.resource} ${i.perSecond === null ? intakeNote : formatRate(i.perSecond)} / ${i.wanted === null ? 'no builder' : `${formatRate(i.wanted)} per s`}`),
    `${builders} ${builders === 1 ? 'builder' : 'builders'}`,
  ];
  return { id, name, upgradeTo, reserved, percent, intake, intakeNote, builders, working: working.length, stable, lines };
}
