// Balance probe (not part of npm test): the balanced plan at a given commander build power.
// BP=10 npx vitest run --config scripts/vitest.bench.config.ts scripts/balance.test.ts
import { it } from 'vitest';
import { createWorld } from '../src/sim/scenarios.ts';
import { UNIT_INFO } from '../src/sim/kinds.ts';
import { BALANCED, drive } from '../test/plans.ts';

it('balanced plan', { timeout: 600_000 }, () => {
  if (process.env.BP) (UNIT_INFO.commander as { buildRate: number }).buildRate = Number(process.env.BP);
  const w = createWorld(1, 'map1');
  const r = drive(w, BALANCED, { log: process.env.LOG ? (s) => console.log(s) : undefined });
  console.log(`BP ${UNIT_INFO.commander.buildRate}: outcome ${r.outcome} end ${r.endTick} wave ${r.wave} cmdr ${r.commanderHp.toFixed(0)} kills ${r.kills} lostB ${r.buildingsLost} lostU ${r.unitsLost} made ${r.partsMade} used ${r.partsUsed} skipped ${r.skipped.length}`);
});
