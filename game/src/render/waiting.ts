// W25b: which sites are waiting for resources, read from a snapshot (Richard's "build seems to
// freeze here", 2026-10-09: the builders beamed at their sites while the mass pool was empty and
// the progress crept at the 1 mass/s income).
//
// A site waits when builders are adding build power to it (snapshot `builders` > 0) and it gets
// less than its full supply this tick (`eff` < 255: economy.ts stores the supply ratio it built
// at, 0..255). The resources it waits for are the ones its outstanding work draws (kinds.ts siteWork)
// that are short now (the snapshot's G_SHORT mask, set by the same supply ratios). A unit waits
// when the site it is building (state building, `work` = site id + 1) waits. Reserved sites and
// sites nobody is building are never waiting: nothing is being built there.
//
// Pure: no DOM, no three.js (render/waitView.ts draws it; main.ts gives the readout the counts).

import type { Snapshot } from '../sim/snapshot.ts';
import { BF_COMPLETE, BF_UPGRADING, G_SHORT, US_BUILDING } from '../sim/schema.ts';
import { siteWork } from '../sim/kinds.ts';

export const RESOURCE_NAMES = ['mass', 'energy', 'rare'] as const;
export type ResourceName = (typeof RESOURCE_NAMES)[number];

export interface WaitingSite {
  id: number;
  /** Footprint centre. */
  x: number;
  z: number;
  /** The short resources this site draws. */
  short: ResourceName[];
  /** Supply ratio it built at this tick, 0..1. */
  supply: number;
  builders: number;
}

export interface WaitingBuilder {
  id: number;
  /** The site it is building. */
  site: number;
  short: ResourceName[];
}

export interface WaitingState {
  /** Resources short now (the readout marks them). */
  short: ResourceName[];
  sites: WaitingSite[];
  builders: WaitingBuilder[];
}

/** "waiting for mass", "waiting for mass and energy". */
export function waitingText(short: readonly ResourceName[]): string {
  return `waiting for ${short.length > 1 ? `${short.slice(0, -1).join(', ')} and ${short[short.length - 1]}` : (short[0] ?? 'resources')}`;
}

export function waitingState(snap: Snapshot): WaitingState {
  const mask = snap.globals[G_SHORT]! | 0;
  const short = RESOURCE_NAMES.filter((_, k) => (mask & (1 << k)) !== 0);
  const out: WaitingState = { short, sites: [], builders: [] };
  if (!short.length) return out;
  const b = snap.buildings;
  const c = b.cols;
  const byId = new Map<number, WaitingSite>();
  for (let r = 0; r < b.count; r++) {
    const f = c.flags[r]!;
    const site = !(f & BF_COMPLETE) || (f & BF_UPGRADING) !== 0;
    if (!site || c.builders[r]! === 0 || c.eff[r]! >= 255) continue;
    const { cost } = siteWork(c.kind[r]!, (f & BF_UPGRADING) !== 0, c.tier[r]!, c.fw[r]!, c.fh[r]!);
    const draws = RESOURCE_NAMES.filter((_, k) => cost[k]! > 0 && (mask & (1 << k)) !== 0);
    const w: WaitingSite = {
      id: b.id[r]!,
      x: c.tx[r]! + c.fw[r]! / 2,
      z: c.ty[r]! + c.fh[r]! / 2,
      short: draws.length ? draws : short,
      supply: c.eff[r]! / 255,
      builders: c.builders[r]!,
    };
    out.sites.push(w);
    byId.set(w.id, w);
  }
  const u = snap.units;
  for (let r = 0; r < u.count; r++) {
    // `work` names a wreck while reclaiming: only a building unit's work is a site.
    const work = u.cols.state[r] === US_BUILDING ? u.cols.work[r]! - 1 : -1;
    const s = work >= 0 ? byId.get(work) : undefined;
    if (s) out.builders.push({ id: u.id[r]!, site: s.id, short: s.short });
  }
  return out;
}

/** Waiting sites per resource (mass, energy, rare), for the resource readout. */
export function waitingCounts(ws: WaitingState): number[] {
  return RESOURCE_NAMES.map((name) => ws.sites.filter((s) => s.short.includes(name)).length);
}
