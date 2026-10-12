// W29: the hover readout of a complete building (ui/siteHover.ts shows it; render/siteReadout.ts
// covers sites under construction or upgrade). Text only, so nothing depends on colour.
//
//   extractor, belts on   name; "buffer <n> / <cap> mass|rare"; "full — not digging" when full
//   core                  name; hp; delivered mass and rare; "DISABLED …" at 0 hp
//   belt (W31)            "Conveyor belt · Slow (1.7 tiles/s)" (its speed in words and tiles a
//                         second); hp when damaged
//   any other damaged     name; hp
//   damaged, with builders selected: "right-click: repair" as the last line
//
// An undamaged building that is neither an extractor (belts on), the core nor a belt has no
// readout. A belt being upgraded shows the site readout (siteReadout.ts) instead.
//
// W32 demolish (demolishReadout), which takes precedence over both (hoverReadout):
//   being demolished      name; "Demolishing 40% · +2 mass when done"
//   demolish tool active  name; "Demolish: +2 mass, 2 s" (the refund, and the time at the selected
//                         engineers' build power); the core: "the core cannot be demolished"
//   either, with items    "items inside are lost" (a belt's item, a machine's buffers, a depot's or
//                         extractor's stock)
// A building demolished mid-upgrade shows the demolish text, not the upgrade's site readout.

import { B, U, beltSpeedText, buildingInfo, demolishRefund, demolishSkip, demolishTime, isBelt, isExtractor } from '../sim/kinds.ts';
import { BF_COMPLETE, BF_DISABLED, BF_IDLE, BF_UPGRADING, G_BELTS, G_CORE_MASS, G_CORE_RARE } from '../sim/schema.ts';
import { extractorCap, unitBuildRate } from '../sim/tuning.ts';
import type { Snapshot } from '../sim/snapshot.ts';
import { snapshotRules } from '../snapshotRules.ts';
import { rowOf, siteReadout, type SiteReadout } from './siteReadout.ts';

export interface BuildingReadout {
  id: number;
  lines: string[];
}

/**
 * The readout of complete building `id` in snapshot `s` (null: none). `builders`: engineers or the
 * commander are selected; as a function, asked only when the building is damaged.
 */
export function buildingReadout(s: Snapshot, id: number, builders: boolean | (() => boolean)): BuildingReadout | null {
  const r = rowOf(s, id);
  if (r < 0) return null;
  const c = s.buildings.cols;
  const flags = c.flags[r]!;
  if (!(flags & BF_COMPLETE) || flags & BF_UPGRADING) return null;
  const kind = c.kind[r]!;
  const hp = c.hp[r]!;
  const max = c.maxHp[r]!;
  const damaged = hp < max;
  const hpLine = `hp ${Math.ceil(hp)} / ${Math.round(max)}`;
  const lines = [titleOf(s, r)];
  const g = s.globals;
  if (kind === B.belt) {
    if (damaged) lines.push(hpLine);
  } else if (kind === B.core) {
    lines.push(hpLine, `delivered mass ${g[G_CORE_MASS]} · rare ${g[G_CORE_RARE]}`);
    if (flags & BF_DISABLED) lines.push('DISABLED — takes nothing until repaired to full');
  } else if (g[G_BELTS] === 1 && isExtractor(kind)) {
    // whole items: the buffer is an f32 sum of tenths, so 9.99999 is 10
    lines.push(`buffer ${Math.floor(c.stock[r]! + 1e-3)} / ${extractorCap(snapshotRules(s), kind)} ${kind === B.massExtractor ? 'mass' : 'rare'}`);
    if (flags & BF_IDLE) lines.push('full — not digging');
    if (damaged) lines.push(hpLine);
  } else if (damaged) lines.push(hpLine);
  else return null;
  if (damaged && (typeof builders === 'function' ? builders() : builders)) lines.push('right-click: repair');
  return { id, lines };
}

/** A building's first readout line: its name; a belt's with its speed (W31). */
function titleOf(s: Snapshot, r: number): string {
  const c = s.buildings.cols;
  const label = buildingInfo(c.kind[r]!).label;
  return c.kind[r] === B.belt ? `${label} · ${beltSpeedText(c.tier[r]!)}` : label;
}

/** W32: "50", "12.5", "0.3": one decimal, a whole number without one. */
export function amount(v: number): string {
  const t = Math.round(v * 10) / 10;
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
}

/** W32: "+50 mass", "+175 mass +7 rare": a demolish refund (rare only when there is some). */
const refundText = (m: number, r: number) => `+${amount(m)} mass${r > 0 ? ` +${amount(r)} rare` : ''}`;

/** W32: the refund demolishing snapshot row `r` returns now (kinds.ts demolishRefund; a part-done upgrade at its stored progress). */
export function rowRefund(s: Snapshot, r: number): [number, number, number] {
  const c = s.buildings.cols;
  return demolishRefund(c.kind[r]!, c.tier[r]!, c.fw[r]!, c.fh[r]!, c.flags[r]! & BF_UPGRADING ? c.progress[r]! : 0);
}

/** W32: snapshot row `r` holds items that demolishing it loses: a belt piece's item, a machine's buffers, a depot's or extractor's stock. */
export function itemsInside(s: Snapshot, r: number): boolean {
  const c = s.buildings.cols;
  const kind = c.kind[r]!;
  if (isBelt(kind)) return c.item[r] !== 0;
  if (buildingInfo(kind).machine) return c.inBuf[r]! > 0 || c.outBuf[r]! > 0;
  return (kind === B.depot || isExtractor(kind)) && c.stock[r]! > 0;
}

/**
 * W32: the demolish readout of building `id` (null: none). A building being demolished always has
 * one; with the demolish tool (`tool`) a finished building shows its refund and the time at `power`
 * BP (the selected engineers' build power; default one engineer's), and the core says it cannot be
 * demolished. An unfinished site has none (its site readout shows).
 */
export function demolishReadout(s: Snapshot, id: number, tool: boolean, power?: number): BuildingReadout | null {
  const r = rowOf(s, id);
  if (r < 0) return null;
  const c = s.buildings.cols;
  const d = c.demolish[r]!;
  const kind = c.kind[r]!;
  if (!(d > 0) && !tool) return null;
  const why = demolishSkip(kind, c.flags[r]!);
  if (why === 'core') return { id, lines: [titleOf(s, r), 'the core cannot be demolished'] };
  if (why) return null;
  const [m, , rare] = rowRefund(s, r);
  const lines = [titleOf(s, r)];
  if (d > 0) lines.push(`Demolishing ${Math.min(99, Math.floor(d * 100 + 1e-6))}% · ${refundText(m, rare)} when done`);
  else {
    const bp = power && power > 0 ? power : unitBuildRate(snapshotRules(s), U.engineer);
    lines.push(`Demolish: ${refundText(m, rare)}, ${amount(demolishTime(kind, c.tier[r]!, c.fw[r]!, c.fh[r]!) / bp)} s`);
  }
  if (itemsInside(s, r)) lines.push('items inside are lost');
  return { id, lines };
}

/**
 * W32: the hover panel's readout of building `id`: the demolish readout first (being demolished, or
 * the demolish tool active), then a site's (construction or upgrade), then a finished building's.
 * `prev` is the snapshot before `curr` (siteReadout's intake), `builders` as buildingReadout takes it,
 * `power` the selected engineers' build power (demolishReadout).
 */
export function hoverReadout(prev: Snapshot | null, curr: Snapshot, id: number, opts: { demolishTool: boolean; builders: boolean | (() => boolean); power?: number }): BuildingReadout | SiteReadout | null {
  return demolishReadout(curr, id, opts.demolishTool, opts.power) ?? siteReadout(prev, curr, id) ?? buildingReadout(curr, id, opts.builders);
}

/** W32: a demolish order in the queue panel: "Demolish Wall", "Demolish (gone)". */
export function demolishQueueText(s: Snapshot, id: number): string {
  const r = rowOf(s, id);
  return r < 0 ? 'Demolish (gone)' : `Demolish ${buildingInfo(s.buildings.cols.kind[r]!).label}`;
}
