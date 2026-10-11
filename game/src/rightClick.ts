// The order a right-click on a building gives the selected builders (main.ts rightClick): repair a
// complete damaged building, upgrading or not (W29, PLAN-W29 item 10: an upgrading building keeps
// BF_COMPLETE, and repair is free, so a starved upgrade never holds back its recovery); help an
// unfinished site or an undamaged building's upgrade (assist); otherwise nothing (the click falls
// through to a move).

import { BF_COMPLETE, BF_UPGRADING } from './sim/schema.ts';

/** The order for a right-click on a building with these flags and hit points (null: none). */
export function buildingRightClick(flags: number, hp: number, maxHp: number): 'assist' | 'repair' | null {
  const complete = (flags & BF_COMPLETE) !== 0;
  if (complete && hp < maxHp) return 'repair';
  if (!complete || flags & BF_UPGRADING) return 'assist';
  return null;
}
