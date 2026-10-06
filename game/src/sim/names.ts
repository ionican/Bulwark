// Name → kind lookups for anything typed by a person or a test. Unknown names throw, listing the
// valid ones, so a typo is never silently ignored.

import { ALIEN_KINDS, BUILDING_KINDS } from './kinds.ts';
import { RESEARCH_INDEX } from './balance.ts';

function lookup(what: string, names: readonly string[], v: string | number): number {
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 0 && v < names.length) return v;
    throw new TypeError(`unknown ${what} index ${v} (0..${names.length - 1})`);
  }
  const i = names.indexOf(v);
  if (i < 0) throw new TypeError(`unknown ${what} "${v}"; valid: ${names.join(', ')}`);
  return i;
}

export const buildingKindIndex = (v: string | number) => lookup('building kind', BUILDING_KINDS, v);
export const alienKindIndex = (v: string | number) => lookup('alien kind', ALIEN_KINDS, v);
export const researchNodeId = (v: string) => {
  if (!(v in RESEARCH_INDEX)) throw new TypeError(`unknown research node "${v}"; valid: ${Object.keys(RESEARCH_INDEX).join(', ')}`);
  return v;
};
export const entryIndex = (entries: ReadonlyArray<{ name: string }>, v: string | number | undefined) => {
  if (v === undefined) return 0;
  return lookup('entry', entries.map((e) => e.name), v);
};
