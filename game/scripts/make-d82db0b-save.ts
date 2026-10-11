// W29 (PLAN-W29 item 12): writes the populated old-format save fixture that test/w29-save.test.ts
// loads. It must run against the code of commit d82db0b (save version 3, state format 6), not this
// tree, so it imports the simulation from an export of that commit:
//
//   git archive d82db0b game/src game/test model | tar -x -C /tmp/w29-d82db0b
//   node game/scripts/make-d82db0b-save.ts /tmp/w29-d82db0b
//
// It plays map 1 with that commit's balanced plan to tick 5,400 (9:00: waves 1 and 2 fought, so
// shots, kills and wrecks exist), then on to the first tick with shots in flight, with the plan's
// queued build orders standing, and writes
//   game/test/fixtures/d82db0b-map1.save        the save bytes
//   game/test/fixtures/d82db0b-map1.json        what that code read from the world at the save
// The JSON is the reference the test compares the migrated load with (per-kind statistics by name).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node make-d82db0b-save.ts <export of d82db0b>');
const mod = (p: string) => import(pathToFileURL(join(root, p)).href);
const { createWorld } = await mod('game/src/sim/scenarios.ts');
const { serializeWorld, SAVE_VERSION } = await mod('game/src/sim/save.ts');
const { SNAPSHOT_VERSION } = await mod('game/src/sim/snapshot.ts');
const { statsReport } = await mod('game/src/sim/stats.ts');
const { BALANCED, drive } = await mod('game/test/plans.ts');

const TICK = 5400;
const w = createWorld(1, 'map1');
drive(w, BALANCED, { maxTicks: TICK });
// then on to a tick with shots in flight (the projectile table carries attribution to migrate)
while (w.projectiles.count === 0 && w.tick < TICK + 600) w.step();
let queued = 0;
for (let s = 0; s < w.units.highWater; s++) if (w.units.alive[s]) queued += w.orders[s]?.length ?? 0;
const bytes: Uint8Array = serializeWorld(w);
const out = join(fileURLToPath(new URL('..', import.meta.url)), 'test', 'fixtures');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'd82db0b-map1.save'), bytes);
const ref = {
  commit: 'd82db0b',
  saveVersion: SAVE_VERSION,
  stateFormat: SNAPSHOT_VERSION,
  tick: w.tick,
  kills: w.kills,
  buildings: w.buildings.count,
  aliens: w.aliens.count,
  projectiles: w.projectiles.count,
  wrecks: w.wrecks.count,
  queuedOrders: queued,
  pool: Array.from(w.pool),
  stats: statsReport(w.stats),
};
writeFileSync(join(out, 'd82db0b-map1.json'), `${JSON.stringify(ref, null, 2)}\n`);
console.log(`wrote ${bytes.length} bytes: save ${SAVE_VERSION}, state ${SNAPSHOT_VERSION}, tick ${w.tick}, kills ${w.kills}, ${w.projectiles.count} projectiles, ${queued} queued orders`);
