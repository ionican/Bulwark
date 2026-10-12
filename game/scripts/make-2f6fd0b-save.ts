// W31 (PLAN-W31 tests 10 and 11): writes the build-170 save fixture that test/w31-saves.test.ts
// loads. It must run against the code of commit 2f6fd0b (build 170: save version 4, state format 7,
// one belt speed, eleven research nodes), not this tree, so it imports the simulation from an export
// of that commit:
//
//   git archive 2f6fd0b game/src game/test model | tar -x -C /tmp/w31-2f6fd0b
//   node game/scripts/make-2f6fd0b-save.ts /tmp/w31-2f6fd0b
//
// It plays map 1 with that commit's balanced plan to tick 9,000 (15:00: belts carrying mass and rare
// to the core, research done), then queues research until one node is running and two wait behind
// it, steps one tick so those commands apply, and writes
//   game/test/fixtures/2f6fd0b-map1.save        the save bytes
//   game/test/fixtures/2f6fd0b-map1.json        what that code read from the world at the save
// The JSON is the reference the test compares the load with (research by node id, belt tiles).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node make-2f6fd0b-save.ts <export of 2f6fd0b>');
const mod = (p: string) => import(pathToFileURL(join(root, p)).href);
const { createWorld } = await mod('game/src/sim/scenarios.ts');
const { serializeWorld, SAVE_VERSION } = await mod('game/src/sim/save.ts');
const { SNAPSHOT_VERSION } = await mod('game/src/sim/snapshot.ts');
const { RESEARCH } = await mod('game/src/sim/balance.ts');
const { B } = await mod('game/src/sim/kinds.ts');
const { BALANCED, drive } = await mod('game/test/plans.ts');

const TICK = 9000;
const w = createWorld(1, 'map1');
drive(w, BALANCED, { maxTicks: TICK });
// one node running and two queued: the first nodes without a prerequisite that are neither done nor running
const ids: string[] = RESEARCH.map((n: { id: string }) => n.id);
const want = RESEARCH.filter((n: { id: string; requires?: string }, i: number) => !n.requires && !(w.researchDone & (1 << i)) && w.researchCurrent !== i && !w.researchQueue.includes(i)).slice(
  0,
  Math.max(0, (w.researchCurrent >= 0 ? 2 : 3) - w.researchQueue.length),
);
w.pool[2] = Math.max(w.pool[2], 500); // the queued nodes' rare in hand (the save records the pool as it is)
for (const n of want) {
  const why = w.submit({ t: 'research', node: n.id });
  if (why) throw new Error(`research ${n.id} refused: ${why}`);
}
w.step();
if (w.researchCurrent < 0 || w.researchQueue.length < 2) throw new Error(`research not set up: current ${w.researchCurrent}, queue ${w.researchQueue}`);
const c = w.buildings.cols;
const belts: Array<[number, number, number]> = [];
let carrying = 0;
for (let s = 0; s < w.buildings.highWater; s++) {
  if (!w.buildings.alive[s] || c.kind[s] !== B.belt) continue;
  belts.push([c.tx[s], c.ty[s], c.tier[s]]);
  if (c.item[s] !== 0) carrying++;
}
if (carrying === 0) throw new Error('no belt carries an item at the save');
const bytes: Uint8Array = serializeWorld(w);
const out = join(fileURLToPath(new URL('..', import.meta.url)), 'test', 'fixtures');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, '2f6fd0b-map1.save'), bytes);
const ref = {
  commit: '2f6fd0b',
  saveVersion: SAVE_VERSION,
  stateFormat: SNAPSHOT_VERSION,
  tick: w.tick,
  research: {
    ids,
    done: ids.filter((_, i) => w.researchDone & (1 << i)),
    current: ids[w.researchCurrent],
    progress: w.researchProgress,
    queued: w.researchQueue.map((i: number) => ids[i]),
  },
  belts: belts.length,
  carrying,
  beltTiers: [...new Set(belts.map((b) => b[2]))],
};
writeFileSync(join(out, '2f6fd0b-map1.json'), `${JSON.stringify(ref, null, 2)}\n`);
console.log(`wrote ${bytes.length} bytes: save ${SAVE_VERSION}, state ${SNAPSHOT_VERSION}, tick ${w.tick}, research done ${ref.research.done.join(',')}; current ${ref.research.current}; queued ${ref.research.queued.join(',')}; ${belts.length} belts, ${carrying} carrying`);
