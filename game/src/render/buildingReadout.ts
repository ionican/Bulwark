// W29: the hover readout of a complete building (ui/siteHover.ts shows it; render/siteReadout.ts
// covers sites under construction or upgrade). Text only, so nothing depends on colour.
//
//   extractor, belts on   name; "buffer <n> / <cap> mass|rare"; "full — not digging" when full
//   core                  name; hp; delivered mass and rare; "DISABLED …" at 0 hp
//   any other damaged     name; hp
//   damaged, with builders selected: "right-click: repair" as the last line
//
// An undamaged building that is neither an extractor (belts on) nor the core has no readout.

import { B, buildingInfo, isExtractor } from '../sim/kinds.ts';
import { BF_COMPLETE, BF_DISABLED, BF_IDLE, BF_UPGRADING, G_BELTS, G_CORE_MASS, G_CORE_RARE } from '../sim/schema.ts';
import { extractorCap } from '../sim/tuning.ts';
import type { Snapshot } from '../sim/snapshot.ts';
import { snapshotRules } from '../snapshotRules.ts';
import { rowOf } from './siteReadout.ts';

export interface BuildingReadout {
  id: number;
  lines: string[];
}

/** The readout of complete building `id` in snapshot `s` (null: none). `builders`: engineers or the commander are selected. */
export function buildingReadout(s: Snapshot, id: number, builders: boolean): BuildingReadout | null {
  const r = rowOf(s, id);
  if (r < 0) return null;
  const c = s.buildings.cols;
  const flags = c.flags[r]!;
  if (!(flags & BF_COMPLETE) || flags & BF_UPGRADING) return null;
  const kind = c.kind[r]!;
  const info = buildingInfo(kind);
  const hp = c.hp[r]!;
  const max = c.maxHp[r]!;
  const damaged = hp < max;
  const hpLine = `hp ${Math.ceil(hp)} / ${Math.round(max)}`;
  const lines = [info.label];
  const g = s.globals;
  if (kind === B.core) {
    lines.push(hpLine, `delivered mass ${g[G_CORE_MASS]} · rare ${g[G_CORE_RARE]}`);
    if (flags & BF_DISABLED) lines.push('DISABLED — takes nothing until repaired to full');
  } else if (g[G_BELTS] === 1 && isExtractor(kind)) {
    // whole items: the buffer is an f32 sum of tenths, so 9.99999 is 10
    lines.push(`buffer ${Math.floor(c.stock[r]! + 1e-3)} / ${extractorCap(snapshotRules(s), kind)} ${kind === B.massExtractor ? 'mass' : 'rare'}`);
    if (flags & BF_IDLE) lines.push('full — not digging');
    if (damaged) lines.push(hpLine);
  } else if (damaged) lines.push(hpLine);
  else return null;
  if (damaged && builders) lines.push('right-click: repair');
  return { id, lines };
}
