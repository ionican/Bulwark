// The order a right-click on a building gives the selected builders (main.ts rightClick): help an
// unfinished site or an upgrade under way (assist), repair a complete damaged building (W29), or
// nothing (the click falls through to a move).

import { BF_COMPLETE, BF_UPGRADING } from './sim/schema.ts';

/** The order for a right-click on a building with these flags and hit points (null: none). */
export function buildingRightClick(flags: number, hp: number, maxHp: number): 'assist' | 'repair' | null {
  if (!(flags & BF_COMPLETE) || flags & BF_UPGRADING) return 'assist';
  if (hp < maxHp) return 'repair';
  return null;
}
