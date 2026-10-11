// Snapshot encode benchmark (stress scene): median ms per encode and bytes. Run with
// npx vitest run scripts/snapbench.test.ts --dir scripts (not part of npm test).
import { it } from 'vitest';
import { createWorld } from '../src/sim/scenarios.ts';
import { encodeSnapshot, snapshotBytes } from '../src/sim/snapshot.ts';

it('snapshot encode, stress scene', () => {
  const w = createWorld(1, 'stress');
  for (let i = 0; i < 300; i++) w.step();
  let buf = encodeSnapshot(w);
  const times: number[] = [];
  for (let i = 0; i < 400; i++) {
    w.step();
    const t0 = performance.now();
    buf = encodeSnapshot(w, buf);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`encode median ${times[200]!.toFixed(4)} ms, p90 ${times[360]!.toFixed(4)} ms, bytes ${snapshotBytes(buf).length}, buildings ${w.buildings.count}, aliens ${w.aliens.count}, projectiles ${w.projectiles.count}`);
});
