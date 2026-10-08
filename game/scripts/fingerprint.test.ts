// Refactor guard (not part of npm test): hashes of snapshots and saves over several scripted runs.
// Run before and after a refactor; the output must be identical.
// npx vitest run --config scripts/vitest.bench.config.ts scripts/fingerprint.test.ts
//
// FP_STRIP_QUEUE=1 (W25, fingerprint-compare.mjs --strip-queue): hashes a snapshot of version 5 or
// later with its queue section removed and its header and globals put back as version 4 had them
// (version 4, length without the section, G_QUEUE_ORDERS 0), and a save with its state-format word
// put back to 4, so a tree with the queue section compares equal to one without when nothing else
// changed. Save hashes are labelled with their SAVE_VERSION. Self-contained on purpose: the compare
// script runs this file against a baseline tree whose sources have none of this.
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
const STRIP = process.env.FP_STRIP_QUEUE === '1';
// snapshot.ts header and globals layout (unchanged from version 4 to 5)
const H_VERSION = 1;
const H_N_UNITS = 9;
const H_BYTES = 10;
const GLOBALS_AT = 16 * 4;
const G_QUEUE_ORDERS = 44;
/** A version ≥ 5 snapshot as version 4 would have written it: the trailing queue section removed. */
function stripQueue(bytes: Uint8Array): Uint8Array {
  const h = new Uint32Array(bytes.buffer, bytes.byteOffset, 16);
  if (h[H_VERSION]! < 5) return bytes;
  const orders = new Float64Array(bytes.buffer, bytes.byteOffset + GLOBALS_AT, 48)[G_QUEUE_ORDERS]!;
  const len = h[H_BYTES]! - (h[H_N_UNITS]! * 4 + orders * 20); // a count per unit, 5 × 4 bytes per order
  const out = bytes.slice(0, len);
  const oh = new Uint32Array(out.buffer, 0, 16);
  oh[H_VERSION] = 4;
  oh[H_BYTES] = len;
  new Float64Array(out.buffer, GLOBALS_AT, 48)[G_QUEUE_ORDERS] = 0;
  return out;
}
const snapOut = (w: World) => (STRIP ? stripQueue(snapshotBytes(encodeSnapshot(w))) : snapshotBytes(encodeSnapshot(w)));
const snapHash = (w: World) => fnv(snapOut(w));
/** Save bytes; stripped: the state-format word (bytes 8–11) back to 4. */
function saveEntry(w: World): string {
  const b = serializeWorld(w);
  if (!STRIP) return `save:${fnv(b)}`;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(8, true) >= 5) dv.setUint32(8, 4, true);
  return `save-v${dv.getUint32(4, true)}:${fnv(b)}`;
}
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
  out.push(saveEntry(w));
  out.push(`len:${snapOut(w).length}`);
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
