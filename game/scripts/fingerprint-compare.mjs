#!/usr/bin/env node
// Simulation-unchanged check (W24 run 2a, criterion 11): runs scripts/fingerprint.test.ts — hashes
// of snapshots and saves over scripted sandbox, stress and map 1 runs — on this tree and on a
// baseline commit, and fails unless every hash is identical.
//
//   node scripts/fingerprint-compare.mjs <commit> [--strip-queue]
//
// Strict (the default): every snapshot and save hash must be identical.
// --strip-queue (W25): both runs hash snapshots with the W25 queue section removed and saves with
// the state-format word set back to 4 (fingerprint.test.ts FP_STRIP_QUEUE), so a tree that only
// added the queue section compares identical with one from before it. Saves are compared only when
// both trees write the same SAVE_VERSION; if the save format itself changed, the save entries are
// listed and left out of the verdict.
//
// The baseline's game/ and model/ are exported with `git archive` into a temporary directory that
// uses this tree's node_modules, and both runs use this tree's copy of the fingerprint script, so
// only the simulation sources differ. The two runs go in parallel; the directory is removed after.

import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const strip = args.includes('--strip-queue');
const commit = args.find((a) => !a.startsWith('--'));
if (!commit) {
  console.error('usage: node scripts/fingerprint-compare.mjs <commit> [--strip-queue]');
  process.exit(2);
}
const game = fileURLToPath(new URL('..', import.meta.url));
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: game, encoding: 'utf8' }).trim();
const sha = execFileSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], { cwd: repo, encoding: 'utf8' }).trim();
const tmp = mkdtempSync(join(tmpdir(), 'bulwark-fp-'));

function run(cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, FP_STRIP_QUEUE: strip ? '1' : '0' };
    const p = spawn('npx', ['vitest', 'run', '--config', 'scripts/vitest.bench.config.ts', 'scripts/fingerprint.test.ts', '--reporter=verbose', '--silent=false'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => {
      const line = out.split('\n').find((l) => l.includes('FP {'));
      if (code !== 0 || !line) reject(new Error(`fingerprint run in ${cwd} failed (exit ${code}):\n${out.slice(-2000)}`));
      else resolve(JSON.parse(line.slice(line.indexOf('FP ') + 3)));
    });
  });
}

let ok = false;
try {
  const tar = execFileSync('git', ['archive', '--format=tar', sha, 'game', 'model'], { cwd: repo, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', tmp], { input: tar });
  const base = join(tmp, 'game');
  symlinkSync(join(game, 'node_modules'), join(base, 'node_modules'), 'dir');
  for (const f of ['fingerprint.test.ts', 'vitest.bench.config.ts']) cpSync(join(game, 'scripts', f), join(base, 'scripts', f));
  const t0 = Date.now();
  const [here, there] = await Promise.all([run(game), run(base)]);
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  let diffs = 0;
  let skipped = 0;
  const saveVersion = (e) => /^save-v(\d+):/.exec(e ?? '')?.[1];
  for (const key of new Set([...Object.keys(here), ...Object.keys(there)])) {
    const a = here[key] ?? [];
    const b = there[key] ?? [];
    const n = Math.max(a.length, b.length);
    let first = -1;
    for (let i = 0; i < n; i++) {
      if (a[i] === b[i]) continue;
      // stripped mode: saves of different SAVE_VERSIONs are not comparable; listed, not counted
      if (strip && saveVersion(a[i]) && saveVersion(b[i]) && saveVersion(a[i]) !== saveVersion(b[i])) {
        console.log(`${key}: entry ${i} is a save of another format (${a[i]} vs ${b[i]}): not compared`);
        skipped++;
        continue;
      }
      if (first < 0) first = i;
      diffs++;
    }
    console.log(`${key}: ${a.length} hashes here, ${b.length} at ${sha.slice(0, 7)}; ${first < 0 ? 'identical' : `differ from entry ${first} (${a[first]} vs ${b[first]})`}; last ${a[a.length - 1]}`);
  }
  const mode = strip ? 'stripped of the W25 queue section' : 'strict';
  console.log(`fingerprint (${mode}) ${diffs === 0 ? 'IDENTICAL' : `DIFFERS in ${diffs} entries`}${skipped ? ` (${skipped} save entries of another format not compared)` : ''} — this tree vs ${sha.slice(0, 7)} (${seconds} s)`);
  ok = diffs === 0;
} catch (e) {
  console.error(String(e?.stack ?? e));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
