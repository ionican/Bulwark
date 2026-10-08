// Refactor guard (not part of npm test): hashes of snapshots and saves over several scripted runs.
// Run before and after a refactor; the output must be identical.
// npx vitest run --config scripts/vitest.bench.config.ts scripts/fingerprint.test.ts
import { it } from 'vitest';
import { createWorld } from '../src/sim/scenarios.ts';
import { A, B, U } from '../src/sim/kinds.ts';
import { encodeSnapshot, snapshotBytes } from '../src/sim/snapshot.ts';
import { serializeWorld } from '../src/sim/save.ts';
import type { Command } from '../src/sim/commands.ts';
import type { World } from '../src/sim/world.ts';

const fnv = (b: Uint8Array) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193) >>> 0;
  return h.toString(16);
};
const snapHash = (w: World) => fnv(snapshotBytes(encodeSnapshot(w)));
const ids = (w: World, kind?: number) => {
  const o: number[] = [];
  for (let s = 0; s < w.units.highWater; s++) if (w.units.alive[s] && (kind === undefined || w.units.cols.kind[s] === kind)) o.push(w.units.id(s));
  return o;
};

function play(w: World, script: Array<[number, (w: World) => Command]>, ticks: number, every = 50) {
  const out: string[] = [];
  for (let t = 0; t < ticks; t++) {
    for (const [tick, f] of script) if (tick === w.tick) w.enqueue(f(w));
    w.step();
    if (w.tick % every === 0) out.push(snapHash(w));
  }
  out.push(`save:${fnv(serializeWorld(w))}`);
  out.push(`len:${snapshotBytes(encodeSnapshot(w)).length}`);
  return out;
}

const SANDBOX: Array<[number, (w: World) => Command]> = [
  [1, () => ({ t: 'setUnlimited', on: true })],
  [2, (w) => ({ t: 'buildRun', ids: ids(w), from: [58, 58], to: [66, 58], depth: 1 })],
  [500, (w) => ({ t: 'gate', ids: ids(w), tx: 62, ty: 58 })],
  [700, () => ({ t: 'tune', target: 'building', kind: B.gun, field: 'damage', mult: 1.5 })],
  [800, () => ({ t: 'place', kind: B.gun, tx: 60, ty: 50 })],
  [810, () => ({ t: 'place', kind: B.shield, tx: 63, ty: 50 })],
  [820, () => ({ t: 'place', kind: B.area, tx: 66, ty: 50 })],
  [900, (w) => ({ t: 'dropTurret', id: ids(w, U.engineer)[0]! })],
  [1000, () => ({ t: 'spawnAt', kind: A.rusher, x: 61, z: 40, count: 8 })],
  [1200, (w) => ({ t: 'buildRun', ids: ids(w), from: [54, 74], to: [62, 74], depth: 2 })],
  [1300, () => ({ t: 'tune', target: 'unit', kind: U.commander, field: 'hp', mult: 0.5 })],
  [1450, () => ({ t: 'spawnAt', kind: A.hunter, x: 60.5, z: 41.5, count: 6 })],
  [1600, () => ({ t: 'tune', target: 'alien', kind: A.rusher, field: 'hp', mult: 2 })],
  [1700, () => ({ t: 'startWave', index: 4 })],
  [1800, () => ({ t: 'grantResearch', node: 'beam' })],
  [2000, () => ({ t: 'spawnAt', kind: A.breaker, x: 58.5, z: 44.5, count: 3 })],
  [2100, () => ({ t: 'spawnAt', kind: A.saboteur, x: 50.5, z: 50.5, count: 4 })],
  [2200, () => ({ t: 'tune', target: 'unit', kind: U.engineer, field: 'buildRate', mult: 2 })],
  [2300, () => ({ t: 'tune', target: 'alien', kind: A.hunter, field: 'speed', mult: 1.7 })],
  [2400, () => ({ t: 'tune', target: 'building', kind: B.gun, field: 'interval', mult: 0.6 })],
  [2450, () => ({ t: 'tune', target: 'building', kind: B.area, field: 'range', mult: 1.4 })],
  [2500, () => ({ t: 'setUnlimited', on: false })],
  [2600, (w) => ({ t: 'buildRun', ids: ids(w), from: [40, 80], to: [50, 82], depth: 3 })],
  [2700, () => ({ t: 'tuneReset', target: 'alien' })],
  [2800, () => ({ t: 'clearWrecks' })],
  [2900, () => ({ t: 'resetSandbox' })],
  [2950, (w) => ({ t: 'buildRun', ids: ids(w), from: [58, 58], to: [62, 60], depth: 2 })],
  [3100, () => ({ t: 'resetSandbox', full: true })],
];

it('fingerprint', { timeout: 600_000 }, () => {
  const res: Record<string, string[]> = {};
  res.sandbox = play(createWorld(3, 'sandbox'), SANDBOX, 3300);
  res.stress = play(createWorld(1, 'stress'), [], 600);
  res.map1 = play(
    createWorld(9, 'map1'),
    [
      [1, (w) => ({ t: 'build', ids: ids(w), kind: B.massExtractor, tx: 54, ty: 50, queue: true })],
      [1, (w) => ({ t: 'build', ids: ids(w), kind: B.gun, tx: 62, ty: 54, queue: true })],
      [2, (w) => ({ t: 'build', ids: ids(w), kind: B.depot, tx: 50, ty: 70, queue: true })],
      [2, (w) => ({ t: 'build', ids: ids(w), kind: B.belt, tx: 52, ty: 70, queue: true })],
      [3, (w) => ({ t: 'build', ids: ids(w), kind: B.shredder, tx: 53, ty: 70, queue: true })],
      [4, (w) => ({ t: 'buildRun', ids: ids(w), from: [56, 44], to: [70, 45], depth: 2, queue: true })],
      [5, () => ({ t: 'research', node: 'wallT2' })],
      [600, () => ({ t: 'callWave' })],
      [1200, () => ({ t: 'spawn', kind: A.breaker, entry: 0, count: 3 })],
    ],
    3000,
    100,
  );
  console.log('FP ' + JSON.stringify(res));
});
