#!/usr/bin/env node
// Browser check for W24 run 2a (criterion 9 and the scene inspection on both scenarios).
//
//   node scripts/check-render.mjs [--shots <dir>] [--no-build]
//
// Builds this tree, serves it with `vite preview` on strict port 8823, and drives agent-browser
// (session `w24-2a`, 1440 × 900, quality medium):
//
//   map 1 (/) and the sandbox (/?sandbox=1)
//     - loads with 0 console errors (page errors, console.error, __game.errors) and model rendering
//     - a fixture through the game's own commands: every building kind placed complete (`place`), a
//       wall run built and converted to a gate, a temporary turret dropped, every alien kind spawned
//       (sandbox); map 1 gets a few buildings by `place` and its starting units
//     - scene inspection (__game.inspect: the scene graph itself) at a close view and at the full
//       zoom-out: every kind present has model instances (close) and icon instances (zoom-out),
//       no greybox anywhere, no batch overflow
//   budgets, reported, not gated: terrain + scenery and post-processing cost at the game camera
//     (__game.renderCost: forced-completion timing) against 5 ms and 3.5 ms
//   static benchmark (reported, not gated): the stress scene (/?stress=1, 300 buildings, 500
//     aliens) paused, fps and frame cost at the game camera and at the full zoom-out
//
// With --shots <dir> it also writes the criterion 10 screenshots (w24-2a-*.png) there.
// It always stops the preview server and closes the agent-browser session. Exit 1 on any failed
// check (budgets and benchmark figures never fail it).

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8823;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = 'w24-2a';
const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
const BUDGET = { terrainMs: 5, postMs: 3.5 };
const INVENTORY = [
  'massExtractor', 'generator', 'rareExtractor', 'lab', 'depot', 'shredder', 'smelter', 'assembler', 'wall', 'gun', 'area', 'beam',
  'heavy', 'shield', 'tempTurret', 'belt', 'splitter', 'merger', 'gate', 'commander', 'engineer', 'rusher', 'hunter', 'breaker', 'saboteur',
];

const failures = [];
const report = [];
const fail = (msg) => {
  failures.push(msg);
  console.log(`FAIL ${msg}`);
};
const note = (msg) => {
  report.push(msg);
  console.log(msg);
};

function agentBrowser() {
  const onPath = spawnSync('agent-browser', ['--version'], { encoding: 'utf8' });
  if (onPath.status === 0) return 'agent-browser';
  const nvm = join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(nvm))
    for (const v of readdirSync(nvm).sort().reverse()) {
      const p = join(nvm, v, 'bin', 'agent-browser');
      if (existsSync(p)) return p;
    }
  throw new Error('agent-browser not found (PATH or ~/.nvm/versions/node/*/bin)');
}
const AB = agentBrowser();

function ab(...a) {
  const r = spawnSync(AB, ['--session', SESSION, '--json', ...a], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 240_000 });
  let out;
  try {
    out = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop() ?? 'null');
  } catch {
    throw new Error(`agent-browser ${a[0]}: unreadable output: ${r.stdout?.slice(0, 500)} ${r.stderr?.slice(0, 500)}`);
  }
  if (!out?.success) throw new Error(`agent-browser ${a[0]}: ${out?.error ?? r.stderr}`);
  return out.data;
}
const js = (code) => ab('eval', code).result;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function until(what, code, seconds) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try {
      v = js(code);
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() - t0 > seconds * 1000) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

async function load(path) {
  ab('open', `${ORIGIN}${path}`);
  ab('set', 'viewport', '1440', '900');
  await until(`${path} ready`, 'window.__game?.ready === true', 120);
  ab('errors', '--clear');
  ab('console', '--clear');
}

/** Page errors, console errors and the game's own error count since the last clear. */
function errorsNow(label) {
  const page = ab('errors').errors ?? [];
  const consoleErrs = (ab('console').messages ?? ab('console').logs ?? []).filter((m) => (m.type ?? m.level) === 'error');
  const game = js('__game.errors');
  if (page.length || consoleErrs.length || game) fail(`${label}: ${page.length} page errors, ${consoleErrs.length} console errors, __game.errors ${game}: ${JSON.stringify([...page, ...consoleErrs]).slice(0, 600)}`);
  else note(`${label}: 0 console errors`);
}

const GAME_CAMERA = { x: 64, z: 62, distance: 50, yaw: 0 };
const camera = (rig) => js(`(__game.camera.set(${JSON.stringify(rig)}), true)`);
const frames = (n) => js(`new Promise((res) => { let k = 0; const f = () => (++k >= ${n} ? res(true) : requestAnimationFrame(f)); requestAnimationFrame(f); })`);

function inspect(label, kinds, want) {
  const rep = js('__game.inspect()');
  const missing = [];
  for (const k of kinds) {
    const e = rep[k];
    if (!e || !e.entities) {
      missing.push(`${k} (not in the snapshot)`);
      continue;
    }
    const n = want === 'icons' ? e.icons : e.models;
    if (!n) missing.push(`${k} (${e.entities} entities, 0 ${want})`);
  }
  const grey = Object.entries(rep).filter(([, e]) => e.greybox > 0).map(([k, e]) => `${k} ${e.greybox}`);
  if (missing.length) fail(`${label}: no ${want} for ${missing.join(', ')}`);
  if (grey.length) fail(`${label}: greybox instances on ${grey.join(', ')}`);
  if (js('__game.overflowed')) fail(`${label}: a batch overflowed`);
  if (!missing.length && !grey.length) note(`${label}: ${kinds.length} kinds with ${want}, 0 greybox (${Object.values(rep).reduce((s, e) => s + e.models + e.icons, 0)} model and icon instances on entities)`);
  return rep;
}

async function shot(name) {
  if (!shotsDir) return;
  js(`(document.querySelectorAll('body > :not(canvas)').forEach((e) => (e.dataset.shotHidden = e.style.visibility, e.style.visibility = 'hidden')), true)`);
  await frames(6);
  ab('screenshot', join(shotsDir, `w24-2a-${name}.png`));
  js(`(document.querySelectorAll('[data-shot-hidden]').forEach((e) => { e.style.visibility = e.dataset.shotHidden; delete e.dataset.shotHidden; }), true)`);
  note(`screenshot w24-2a-${name}.png`);
}

/** The sandbox fixture: every kind, through the game's commands. */
const SPOTS = [
  ['gun', 48, 56], ['area', 53, 56], ['beam', 58, 56], ['heavy', 68, 55], ['shield', 74, 56],
  ['generator', 40, 44], ['lab', 47, 44], ['depot', 58, 44], ['shredder', 66, 44], ['smelter', 74, 44], ['assembler', 82, 44],
  ['massExtractor', 54, 50], ['massExtractor', 72, 49], ['rareExtractor', 73, 29],
  ['belt', 70, 70, 0], ['belt', 71, 70, 0], ['splitter', 72, 70, 0], ['belt', 73, 70, 0], ['merger', 74, 70, 0], ['belt', 75, 70, 0],
];

async function sandboxFixture() {
  const r = js(`(async () => {
    const g = __game;
    const out = [];
    out.push(await g.setUnlimited(true));
    out.push(await g.grantResearch('all'));
    for (const [k, x, y, d] of ${JSON.stringify(SPOTS)}) out.push(await g.place(k, x, y, d ?? 0));
    return out.filter((r) => !r.ok).map((r) => r.reason);
  })()`);
  if (r.length) fail(`sandbox fixture refused: ${r.join('; ')}`);
  // a finished run of wall to convert into a gate (builders tuned fast)
  js(`(async () => {
    const g = __game;
    await g.tune('unit', 'commander', 'buildRate', 20);
    await g.tune('unit', 'engineer', 'buildRate', 20);
    return g.buildRun([56, 60], [66, 60], 2);
  })()`);
  await until('the wall run', `__game.runs.length === 0 && __game.list('building').filter((b) => b.kindName === 'wall' && b.complete).length >= 22`, 120);
  const gate = js(`__game.gate(61, 60)`);
  if (!gate.ok) fail(`gate refused: ${gate.reason}`);
  await until('the gate', `__game.list('building').some((b) => b.kindName === 'gate' && b.complete)`, 120);
  // a temporary turret from an engineer, and every alien kind north of the wall
  js(`(() => { const e = __game.list('unit').find((u) => u.kindName === 'engineer'); __game.cmd.dropTurret(e.id); return true; })()`);
  await until('the temporary turret', `__game.list('building').some((b) => b.kindName === 'tempTurret')`, 60);
  const spawned = js(`(async () => {
    const out = [];
    for (const [k, x] of [['rusher', 44.5], ['hunter', 54.5], ['breaker', 64.5], ['saboteur', 84.5]]) out.push(await __game.spawnAt(k, x, 34.5, 3));
    return out.filter((r) => !r.ok).map((r) => r.reason);
  })()`);
  if (spawned.length) fail(`spawnAt refused: ${spawned.join('; ')}`);
  await until('aliens in the snapshot', `__game.entityCounts.aliens >= 12`, 30);
  js(`(__game.paused || __game.control.pause(), true)`);
  await until('paused', `__game.paused === true`, 10);
}

async function main() {
  if (!args.includes('--no-build')) {
    console.log('building…');
    execFileSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: GAME, stdio: 'inherit' });
  }
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: GAME, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let serverOut = '';
  server.stdout.on('data', (d) => (serverOut += d));
  server.stderr.on('data', (d) => (serverOut += d));
  try {
    const t0 = Date.now();
    for (;;) {
      try {
        if ((await fetch(`${ORIGIN}/`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (server.exitCode !== null) throw new Error(`vite preview exited: ${serverOut}`);
      if (Date.now() - t0 > 30_000) throw new Error(`vite preview did not start on ${PORT}: ${serverOut}`);
      await sleep(250);
    }
    note(`preview: ${ORIGIN} (this tree's build)`);

    // ---- map 1
    await load('/');
    if (js('__game.renderMode') !== 'models') fail('map 1: not the model view');
    note(`map 1: renderer ${js('__game.renderer')}; viewport ${JSON.stringify(js('__game.viewport'))}; quality ${js('__game.quality')}`);
    const placed = js(`(async () => { const out = []; for (const [k, x, y] of [['gun', 48, 56], ['wall', 52, 58], ['wall', 53, 58], ['generator', 40, 44], ['massExtractor', 54, 50]]) out.push(await __game.place(k, x, y)); return out.filter((r) => !r.ok).map((r) => r.reason); })()`);
    if (placed.length) fail(`map 1 place refused: ${placed.join('; ')}`);
    camera({ x: 56, z: 56, distance: 40, yaw: 0 });
    await frames(10);
    inspect('map 1, close', ['commander', 'engineer', 'gun', 'wall', 'generator', 'massExtractor'], 'models');
    camera({ x: 64, z: 64, distance: 200, yaw: 0 });
    await frames(10);
    inspect('map 1, full zoom-out', ['commander', 'engineer', 'gun', 'wall', 'generator', 'massExtractor'], 'icons');
    errorsNow('map 1');

    // ---- sandbox
    await load('/?sandbox=1');
    if (js('__game.renderMode') !== 'models') fail('sandbox: not the model view');
    await sandboxFixture();
    // a view per region; every kind must have models in one of them
    const seen = new Set();
    const greyIn = [];
    for (const rig of [
      { x: 62, z: 44, distance: 40, yaw: 0 },
      { x: 62, z: 58, distance: 40, yaw: 0 },
      { x: 72, z: 68, distance: 30, yaw: 0 },
      { x: 64, z: 34, distance: 40, yaw: 0 },
      { x: 75, z: 31, distance: 30, yaw: 0 },
    ]) {
      camera(rig);
      await frames(8);
      const rep = js('__game.inspect()');
      for (const [k, e] of Object.entries(rep)) {
        if (e.models > 0) seen.add(k);
        if (e.greybox > 0) greyIn.push(k);
      }
    }
    const lacking = INVENTORY.filter((k) => !seen.has(k));
    if (lacking.length) fail(`sandbox, close views: no model instances for ${lacking.join(', ')}`);
    else note(`sandbox, close views: all ${INVENTORY.length} kinds of the inventory have model instances`);
    if (greyIn.length) fail(`sandbox, close views: greybox on ${[...new Set(greyIn)].join(', ')}`);
    camera({ x: 64, z: 64, distance: 200, yaw: 0 });
    await frames(10);
    inspect('sandbox, full zoom-out', INVENTORY, 'icons');
    note(`sandbox: wall topology rebuilds ${js('__game.wallRebuilds')}; LOD ${JSON.stringify(js('__game.lodLevelCounts'))}`);

    if (shotsDir) {
      // the wall run partly built: a second run at normal build power
      // resume (commands apply at a tick), drop the build-power tuning, lay the run
      js(`(async () => { if (__game.paused) __game.control.pause(); await __game.tuneReset('unit'); return __game.buildRun([56, 66], [70, 66], 1); })()`);
      const row66 = (state) => `__game.list('building').filter((b) => b.kindName === 'wall' && b.ty === 66 && b.state === '${state}').length`;
      await until('a partly built run', `${row66('complete')} >= 3 && ${row66('started')} >= 1 && ${row66('reserved')} >= 3`, 180);
      // a fresh temporary turret (the first one expires after 30 s): every engineer tries, one is off cooldown
      js(`(() => { for (const u of __game.list('unit')) if (u.kindName === 'engineer') __game.cmd.dropTurret(u.id); return true; })()`);
      await until('a temporary turret', `__game.list('building').some((b) => b.kindName === 'tempTurret')`, 30);
      // fresh aliens of every kind close together for their close-up, then hold everything still
      js(`(async () => { for (const [k, x] of [['rusher', 58.5], ['hunter', 62.5], ['breaker', 66.5], ['saboteur', 70.5]]) await __game.spawnAt(k, x, 36.5, 1); __game.control.pause(); return true; })()`);
      await until('paused', `__game.paused === true`, 10);
      camera({ x: 63, z: 62, distance: 34, yaw: 0.35 });
      await shot('base-wall-run-gate');
      camera(GAME_CAMERA);
      await shot('game-camera');
      camera({ x: 54, z: 57.5, distance: 17, yaw: 0.25 });
      await shot('turrets-gun-area-beam');
      camera({ x: 71, z: 57, distance: 16, yaw: 0.25 });
      await shot('turrets-heavy-shield');
      camera({ x: 61, z: 61, distance: 14, yaw: -0.5 });
      await shot('gate-and-units');
      const tt = js(`__game.list('building').find((b) => b.kindName === 'tempTurret')`);
      camera({ x: tt.tx + 0.5, z: tt.ty + 0.5, distance: 9, yaw: 0.4 });
      await shot('turret-lookout-temporary');
      camera({ x: 50, z: 46, distance: 18, yaw: 0.3 });
      await shot('economy-generator-lab-extractor');
      camera({ x: 72, z: 46, distance: 20, yaw: 0.3 });
      await shot('chain-depot-shredder-smelter-assembler');
      camera({ x: 72.5, z: 70.5, distance: 12, yaw: 0.6 });
      await shot('belt-splitter-merger');
      camera({ x: 64.5, z: 37.5, distance: 13, yaw: 0.2 });
      await shot('aliens-static');
      camera({ x: 64, z: 64, distance: 200, yaw: 0 });
      await shot('strategic-zoom');
      camera({ x: 64, z: 4, distance: 70, yaw: 2.6 });
      await shot('map-edge-north');
      camera({ x: 124, z: 70, distance: 70, yaw: -1.9 });
      await shot('map-edge-east');
    }
    errorsNow('sandbox');

    // ---- budgets at the game camera (sandbox fixture, medium, 1440 × 900)
    camera(GAME_CAMERA);
    await frames(10);
    const cost = js('__game.renderCost(15)');
    const flag = (v, b) => `${v.toFixed(2)} ms (budget ${b} ms${v > b ? ': OVER' : ''})`;
    note(`budget, game camera, ${js('__game.quality')}, buffer ${cost.buffer.join(' × ')}: terrain + scenery ${flag(cost.terrainMs, BUDGET.terrainMs)} [ground alone, no post: ${cost.terrainIsolatedMs.toFixed(2)} ms]; post ${flag(cost.postMs, BUDGET.postMs)} [by pass: ${Object.entries(cost.passMs).map(([k, v]) => `${k} ${v.toFixed(2)} ms`).join(', ')}]; full frame ${cost.fullMs.toFixed(2)} ms`);

    // ---- static benchmark: the stress scene, paused
    await load('/?stress=1');
    js(`(__game.paused || __game.control.pause(), true)`);
    await until('stress paused', `__game.paused === true`, 10);
    for (const [label, rig] of [
      ['game camera', GAME_CAMERA],
      ['full zoom-out', { x: 64, z: 64, distance: 200, yaw: 0 }],
    ]) {
      camera(rig);
      await sleep(3000);
      const fps = js('__game.fps');
      const c = js('__game.renderCost(15)');
      note(`benchmark (stress scene, ${js('JSON.stringify(__game.entityCounts)')}, paused), ${label}: ${fps} fps (display-capped); ${c.fullMs.toFixed(2)} ms per frame forced-complete (${(1000 / c.fullMs).toFixed(0)} fps uncapped equivalent); draw calls ${js('__game.drawCalls')}; LOD ${JSON.stringify(js('__game.lodLevelCounts'))}`);
    }
    errorsNow('stress scene');
  } catch (e) {
    fail(String(e?.message ?? e));
  } finally {
    try {
      spawnSync(AB, ['--session', SESSION, 'close'], { timeout: 30_000 });
    } catch {
      /* already closed */
    }
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      /* already stopped */
    }
  }
  console.log(failures.length ? `check-render: ${failures.length} FAILED` : 'check-render: all checks passed');
  process.exit(failures.length ? 1 : 0);
}

await main();
