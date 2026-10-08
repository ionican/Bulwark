#!/usr/bin/env node
// Browser check for W24 run 2a (criterion 9 and the scene inspection on both scenarios).
//
//   node scripts/check-render.mjs [--shots <dir>] [--no-build]
//
// Builds this tree, serves it with `vite preview` on strict port 8823, and drives agent-browser
// (session `w24-2a`, 1440 × 900, quality medium):
//
//   input on map 1 (real mouse through agent-browser; Shift by pointer events): a click of under
//     5 px selects an engineer without moving the camera; Shift + left-drag box-selects; in build
//     mode a left-drag queues a wall run without orbiting; a plain left-drag orbits; right-drag pans
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
//   walking benchmark (reported, not gated): 40 engineers and 300 aliens walking in the sandbox
//   static benchmark (reported, not gated): the stress scene (/?stress=1, 300 buildings, 500
//     aliens) paused, fps and frame cost at the game camera and at the full zoom-out
//
// With --shots <dir> it also writes the screenshots (w24-2a2-*.png: game camera, the same view
// tilted low, map edge, aliens close up, full zoom-out) there.
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

/** W10's eased elevation for a distance (render/cameraRig.ts pitchFor): the tilt of a preset view. */
const pitchFor = (d) => {
  let t = (Math.log(d) - Math.log(10)) / (Math.log(200) - Math.log(10));
  t = Math.min(1, Math.max(0, t));
  t = t * t * (3 - 2 * t);
  return ((50 + 34 * t) * Math.PI) / 180;
};
const GAME_CAMERA = { x: 64, z: 62, distance: 50, yaw: 0, pitch: pitchFor(50) };
/** Sets the camera rig; a rig without a pitch gets the preset tilt for its distance. */
const camera = (rig) => js(`(__game.camera.set(${JSON.stringify({ pitch: pitchFor(rig.distance), ...rig })}), true)`);
const rigNow = () => JSON.stringify(js('__game.camera.get()'));
/** Real mouse input through agent-browser (CDP): press, move in steps, release. */
async function mouseDrag(x0, y0, x1, y1, button = 'left', steps = 8) {
  ab('mouse', 'move', String(Math.round(x0)), String(Math.round(y0)));
  ab('mouse', 'down', button);
  for (let k = 1; k <= steps; k++) ab('mouse', 'move', String(Math.round(x0 + ((x1 - x0) * k) / steps)), String(Math.round(y0 + ((y1 - y0) * k) / steps)));
  ab('mouse', 'up', button);
  await frames(60);
}
const key = (k, code) => js(`(window.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', code: '${code}' })), window.dispatchEvent(new KeyboardEvent('keyup', { key: '${k}', code: '${code}' })), true)`);
/** Shift + left-drag as pointer events with shiftKey (agent-browser's mouse carries no modifiers). */
function shiftDrag(x0, y0, x1, y1) {
  js(`(() => {
    const c = document.querySelector('canvas.view');
    const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, shiftKey: true, pointerId: 7, pointerType: 'mouse' }));
    ev('pointerdown', ${x0}, ${y0});
    for (let k = 1; k <= 8; k++) ev('pointermove', ${x0} + (${x1 - x0}) * k / 8, ${y0} + (${y1 - y0}) * k / 8);
    ev('pointerup', ${x1}, ${y1});
    return true;
  })()`);
}
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
  ab('screenshot', join(shotsDir, `w24-2a2-${name}.png`));
  js(`(document.querySelectorAll('[data-shot-hidden]').forEach((e) => { e.style.visibility = e.dataset.shotHidden; delete e.dataset.shotHidden; }), true)`);
  note(`screenshot w24-2a2-${name}.png`);
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
    // ---- input: the workshop camera's feel, with the game's clicks, box and build drags
    camera({ x: 64, z: 62, distance: 30, yaw: 0, pitch: (60 * Math.PI) / 180 });
    await frames(10);
    const units = js(`__game.list('unit').map((u) => ({ id: u.id, kindName: u.kindName, ...__game.screenOf('unit', u.id) }))`);
    const eng = units.filter((u) => u.kindName === 'engineer');
    let before = rigNow();
    ab('mouse', 'move', String(Math.round(eng[0].x + 2)), String(Math.round(eng[0].y)));
    ab('mouse', 'down', 'left');
    ab('mouse', 'move', String(Math.round(eng[0].x + 4)), String(Math.round(eng[0].y + 1)));
    ab('mouse', 'up', 'left');
    await frames(30);
    const sel = js('__game.selected');
    if (!(sel.length === 1 && sel[0].id === eng[0].id && rigNow() === before)) fail(`input: a 3-px click on engineer ${eng[0].id} selected ${JSON.stringify(sel)} and the camera ${rigNow() === before ? 'stayed' : 'moved'}`);
    else note('input: a click (under 5 px) on an engineer selects it; the camera does not move');
    const xs = units.map((u) => u.x);
    const ys = units.map((u) => u.y);
    shiftDrag(Math.min(...xs) - 30, Math.min(...ys) - 40, Math.max(...xs) + 30, Math.max(...ys) + 30);
    await frames(30);
    const boxed = js('__game.selected').length;
    if (boxed !== units.length || rigNow() !== before) fail(`input: Shift + left-drag selected ${boxed} of ${units.length} units; camera ${rigNow() === before ? 'stayed' : 'moved'}`);
    else note(`input: Shift + left-drag box-selects all ${boxed} units; the camera does not move`);
    // the wall tool's key (agent-browser's `press` also toggled the pause button here, so a key event)
    key('1', 'Digit1');
    await frames(5);
    const runs0 = js('__game.runs.length');
    const a = js('__game.worldToScreen(57.5, 64.5)');
    const b = js('__game.worldToScreen(66.5, 64.5)');
    await mouseDrag(a.x, a.y, b.x, b.y);
    await until('the wall run', `__game.runs.length > ${runs0}`, 10).catch(() => null);
    const runs1 = js('__game.runs');
    if (runs1.length !== runs0 + 1 || rigNow() !== before) fail(`input: build-mode left-drag: runs ${runs0} → ${runs1.length}; camera ${rigNow() === before ? 'stayed' : 'moved'}`);
    else note(`input: in build mode a left-drag queues a wall run (${runs1[runs1.length - 1].tiles} tiles) and does not orbit`);
    key('Escape', 'Escape');
    await mouseDrag(720, 450, 820, 400);
    const after = js('__game.camera.get()');
    const b0 = JSON.parse(before);
    if (Math.abs(after.yaw - b0.yaw) < 0.05 || Math.abs(after.pitch - b0.pitch) < 0.02) fail(`input: a plain left-drag did not orbit (${before} → ${JSON.stringify(after)})`);
    else note(`input: a plain left-drag orbits (yaw ${b0.yaw.toFixed(2)} → ${after.yaw.toFixed(2)}, tilt ${((b0.pitch * 180) / Math.PI).toFixed(0)}° → ${((after.pitch * 180) / Math.PI).toFixed(0)}°)`);
    before = rigNow();
    await mouseDrag(720, 450, 620, 520, 'right');
    if (rigNow() === before) fail('input: a right-drag did not pan');
    else note('input: a right-drag pans');
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
      // resume (commands apply at a tick)
      js(`(__game.paused && __game.control.pause(), true)`);
      await until('running', `__game.paused === false`, 10);
      // fresh aliens of every kind close together for their close-up, then hold everything still
      js(`(async () => { for (const [k, x] of [['rusher', 58.5], ['hunter', 62.5], ['breaker', 66.5], ['saboteur', 70.5]]) await __game.spawnAt(k, x, 36.5, 1); __game.control.pause(); return true; })()`);
      await until('paused', `__game.paused === true`, 10);
      camera(GAME_CAMERA);
      await shot('game-camera');
      camera({ ...GAME_CAMERA, pitch: (20 * Math.PI) / 180 });
      await shot('game-camera-tilted-low');
      camera({ x: 112, z: 18, distance: 75, yaw: -0.8, pitch: (32 * Math.PI) / 180 });
      await shot('map-edge');
      camera({ x: 64.5, z: 37.5, distance: 12, yaw: 0.2, pitch: (40 * Math.PI) / 180 });
      await shot('aliens-close');
      camera({ x: 64, z: 64, distance: 200, yaw: 0, pitch: (84 * Math.PI) / 180 });
      await shot('strategic-zoom');
    }
    errorsNow('sandbox');

    // ---- budgets at the game camera (sandbox fixture, medium, 1440 × 900)
    // the budget is a rendering cost: measured on a still frame (simulation paused), three times,
    // each figure the median of the three runs (each run itself interleaved medians, cost.ts)
    js(`(__game.paused || __game.control.pause(), true)`);
    await until('paused', `__game.paused === true`, 10);
    camera(GAME_CAMERA);
    await frames(10);
    const runs = [0, 1, 2].map(() => js('__game.renderCost(15)'));
    const med = (f) => runs.map(f).sort((x, y) => x - y)[1];
    const cost = {
      buffer: runs[0].buffer,
      terrainMs: med((c) => c.terrainMs),
      terrainIsolatedMs: med((c) => c.terrainIsolatedMs),
      postMs: med((c) => c.postMs),
      fullMs: med((c) => c.fullMs),
      passMs: Object.fromEntries(Object.keys(runs[0].passMs).map((k) => [k, med((c) => c.passMs[k])])),
    };
    note(`budget runs (terrain, post): ${runs.map((c) => `${c.terrainMs.toFixed(2)} / ${c.postMs.toFixed(2)} ms`).join('; ')}`);
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

    // ---- walking benchmark (reported, not gated): 40 engineers and 300 aliens walking, game camera
    await load('/?sandbox=1');
    js(`(async () => { const g = __game; await g.setUnlimited(true); await g.tune('unit', 'commander', 'buildRate', 10); for (let i = 0; i < 40; i++) g.cmd.produce(); return true; })()`);
    await until('40 engineers', `__game.list('unit').filter((u) => u.kindName === 'engineer').length >= 40`, 180);
    const walk = js(`(async () => {
      const g = __game;
      const ids = g.list('unit').filter((u) => u.kindName === 'engineer').map((u) => u.id);
      ids.forEach((id, i) => g.cmd.move([id], 50 + (i % 8) * 4, 48 + Math.floor(i / 8) * 4));
      for (const [k, x] of [['rusher', 40], ['hunter', 50], ['breaker', 60], ['saboteur', 70], ['rusher', 80], ['hunter', 90]]) await g.spawnAt(k, x, 30.5, 50);
      g.camera.set(${JSON.stringify(GAME_CAMERA)});
      await new Promise((r) => setTimeout(r, 2500));
      const upd = [];
      for (let i = 0; i < 60; i++) { await new Promise((r) => requestAnimationFrame(r)); upd.push(g.timing.updateMs); }
      upd.sort((a, b) => a - b);
      const walking = g.list('unit').filter((u) => u.state === 1).length;
      return { aliens: g.entityCounts.aliens, engineers: ids.length, walkingUnits: walking, updateMs: upd[30], frameCpuMs: g.frameCpuMs, fps: g.fps, drawCalls: g.drawCalls };
    })()`);
    const wc = js('__game.renderCost(15)');
    note(`walking benchmark (sandbox, ${walk.engineers} engineers (${walk.walkingUnits} walking at the sample) and ${walk.aliens} aliens, game camera, medium): scene update ${walk.updateMs.toFixed(2)} ms CPU per frame (median, rigs and gait included); frame CPU ${walk.frameCpuMs.toFixed(2)} ms; ${walk.fps} fps (display-capped); ${wc.fullMs.toFixed(2)} ms per frame forced-complete; terrain + scenery ${wc.terrainMs.toFixed(2)} ms; post ${wc.postMs.toFixed(2)} ms; draw calls ${walk.drawCalls}`);
    errorsNow('walking benchmark');
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
