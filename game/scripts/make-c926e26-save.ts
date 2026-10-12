// W32 (PLAN-W32 test 8): writes the build-179 save fixture that test/w32-saves.test.ts loads. It must
// run against the code of commit c926e26 (build 179: save version 4, state format 7, no demolish
// column), not this tree, so it imports the simulation from an export of that commit:
//
//   git archive c926e26 game/src game/test model | tar -x -C /tmp/w32-c926e26
//   node game/scripts/make-c926e26-save.ts /tmp/w32-c926e26
//
// It plays map 1 with that commit's balanced plan to tick 9,000 (15:00: walls, turrets and belts
// standing, engineers at work) and writes
//   game/test/fixtures/c926e26-map1.save        the save bytes
//   game/test/fixtures/c926e26-map1.json        what that code read from the world at the save
// The JSON is the reference the test compares the load with.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node make-c926e26-save.ts <export of c926e26>');
const mod = (p: string) => import(pathToFileURL(join(root, p)).href);
const { createWorld } = await mod('game/src/sim/scenarios.ts');
const { serializeWorld, SAVE_VERSION } = await mod('game/src/sim/save.ts');
const { SNAPSHOT_VERSION } = await mod('game/src/sim/snapshot.ts');
const { BUILDING_KINDS } = await mod('game/src/sim/kinds.ts');
const { BALANCED, drive } = await mod('game/test/plans.ts');

const TICK = 9000;
const w = createWorld(1, 'map1');
drive(w, BALANCED, { maxTicks: TICK });
const c = w.buildings.cols;
const kinds: Record<string, number> = {};
let complete = 0;
for (let s = 0; s < w.buildings.highWater; s++) {
  if (!w.buildings.alive[s]) continue;
  const k = BUILDING_KINDS[c.kind[s]] as string;
  kinds[k] = (kinds[k] ?? 0) + 1;
  if (c.flags[s] & 1) complete++;
}
if (!kinds.wall || !kinds.belt) throw new Error(`no walls or belts at the save: ${JSON.stringify(kinds)}`);
const bytes: Uint8Array = serializeWorld(w);
const out = join(fileURLToPath(new URL('..', import.meta.url)), 'test', 'fixtures');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'c926e26-map1.save'), bytes);
const ref = {
  commit: 'c926e26',
  saveVersion: SAVE_VERSION,
  stateFormat: SNAPSHOT_VERSION,
  tick: w.tick,
  buildings: w.buildings.count,
  complete,
  kinds,
  units: w.units.count,
  buildingsLost: w.buildingsLost,
  pool: Array.from(w.pool),
};
writeFileSync(join(out, 'c926e26-map1.json'), `${JSON.stringify(ref, null, 2)}\n`);
console.log(`wrote ${bytes.length} bytes: save ${SAVE_VERSION}, state ${SNAPSHOT_VERSION}, tick ${w.tick}, ${w.buildings.count} buildings (${complete} complete), ${w.units.count} units`);
