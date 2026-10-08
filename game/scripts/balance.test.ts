// Balance probe (not part of npm test): the balanced plan at a given commander build power, with
// optional build-order/timing variants (VARIANT=a,b,...). Prints the outcome.
// BP=10 VARIANT=a npx vitest run --config scripts/vitest.bench.config.ts scripts/balance.test.ts
import { it } from 'vitest';
import { createWorld } from '../src/sim/scenarios.ts';
import { B, UNIT_INFO } from '../src/sim/kinds.ts';
import { BALANCED, drive, type PlanStep } from '../test/plans.ts';

/** Moves the build step of `kind` at (tx, ty) to minute `min`, keeping the plan sorted by minute. */
function retime(plan: PlanStep[], kind: number, tx: number, ty: number, min: number): PlanStep[] {
  const i = plan.findIndex((s) => 'build' in s.act && s.act.build === kind && s.act.at[0] === tx && s.act.at[1] === ty);
  if (i < 0) throw new Error(`no step ${kind} ${tx},${ty}`);
  const [step] = plan.splice(i, 1);
  const moved = { ...step!, min };
  const at = plan.findIndex((s) => s.min > min);
  plan.splice(at < 0 ? plan.length : at, 0, moved);
  return plan;
}

const VARIANTS: Record<string, (p: PlanStep[]) => PlanStep[]> = {
  coreGuns: (p) => retime(retime(p, B.gun, 60, 59, 1.5), B.gun, 67, 59, 1.5),
  coreGuns2: (p) => retime(retime(p, B.gun, 60, 59, 2), B.gun, 67, 59, 2),
  beamEarly: (p) => retime(retime(p, B.beam, 57, 59, 6), B.beam, 70, 59, 7),
  shieldEarly: (p) => retime(p, B.shield, 63, 61, 8),
};

it('balanced plan', { timeout: 600_000 }, () => {
  if (process.env.BP) (UNIT_INFO.commander as { buildRate: number }).buildRate = Number(process.env.BP);
  let plan = BALANCED.map((s) => ({ ...s }));
  for (const v of (process.env.VARIANT ?? '').split(',').filter(Boolean)) plan = VARIANTS[v]!(plan);
  const w = createWorld(1, 'map1');
  const r = drive(w, plan, { log: process.env.LOG ? (s) => console.log(s) : undefined });
  console.log(`BP ${UNIT_INFO.commander.buildRate} ${process.env.VARIANT ?? ''}: outcome ${r.outcome} end ${r.endTick} wave ${r.wave} cmdr ${r.commanderHp.toFixed(0)} kills ${r.kills} lostB ${r.buildingsLost} lostU ${r.unitsLost} made ${r.partsMade} used ${r.partsUsed} skipped ${r.skipped.length}`);
});
