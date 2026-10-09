#!/usr/bin/env node
// Browser check for W24 run 2a (criterion 9 and the scene inspection on both scenarios) and run 2b
// (warm-up, the combined performance gate, the 2b screenshots), and W27's browser check.
//
//   node scripts/check-render.mjs [--shots <dir>] [--no-build] [--only-2b]
//
// (--only-2b, for development: only the run 2b and W27 checks.)
// Builds this tree, serves it with `vite preview` on strict port 8823, and drives agent-browser
// (session `w24-2b`, 1440 × 900, quality medium):
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
//
// Run 2b (PLAN "Run 2b", criteria 8 and 9), gated:
//   warm-up: two cold launches of the stress scene (a fresh browser each), with and without the
//     warm-up frame (`?warmup=0`): __game.warmup must report the warm-up frame and its composer
//     passes; the longest frame in the 10 s after the first visible frame must be lower with it,
//     and under 250 ms with it when the load average is below 8. Loading time is reported for both.
//   combined performance gate: the sandbox recreated from scratch for each pose and each retry
//     (benchFixture: a walled base with 2 gates, 20 turrets of all five kinds, both extractors,
//     every W17 kind, 12 engineers, the commander, at least 150 aliens kept alive by re-issued
//     spawns, a long wall run outlasting the measurement, an engineer shuttling through a gate,
//     temporary turrets re-dropped); 20 s per pose after 5 s, frame times from requestAnimationFrame.
//     Every second, through __game.inspect (entities actually drawn) and __game.activity (visible
//     entities only), the workload must be visible and active, or the pose fails as such.
//     Pass: game camera ≥ 55 fps average and ≥ 45 1%-low; strategic zoom-out ≥ 40 average. A pose
//     that fails at a 1-minute load average above 8 is measured once more after the load falls
//     below 8 (waiting up to 5 min); both results are printed.
//   screenshots, written on every run (to --shots <dir>, else the vault's Bulwark Art Reference)
//     and required: w24-2b-engineers-beaming, w24-2b-turret-recoil-flash, w24-2b-shots-in-flight,
//     w24-2b-gate-open, w24-2b-strategic-zoom.
// W27 (criterion 5, real mouse): the gun turret tool, the mouse over a free tile: the wireframe
// preview is in the scene at that tile and pulses; then a wall drag held mid-way carries wall
// wireframes. Screenshots w27-wireframe-preview.png and w27-wall-drag-preview.png (same folder).
//
// With --shots <dir> it also writes the run 2a screenshots (w24-2a2-*.png: game camera, the same
// view tilted low, map edge, aliens close up, full zoom-out) there.
// It always stops the preview server and closes its agent-browser session. Exit 1 on any failed
// check (the 2a budgets and benchmark figures never fail it; the 2b gate does).

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8823;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = 'w24-2b';
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

// ---- W24 run 2b ------------------------------------------------------------------------------

const ART_REF = join(homedir(), 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents', "Rick's World", 'Resources', 'Bulwark Art Reference');
/** The 2b and W27 screenshots are written on every run: to --shots, else the vault's art reference folder. */
const shots2b = shotsDir ?? ART_REF;
const SHOTS_2B = ['w24-2b-engineers-beaming', 'w24-2b-turret-recoil-flash', 'w24-2b-shots-in-flight', 'w24-2b-gate-open', 'w24-2b-strategic-zoom', 'w27-wireframe-preview', 'w27-wall-drag-preview'];
/** The benchmark's game camera over the base (pitch: the preset tilt for distance 50), and the full zoom-out. */
const BENCH_CAMERA = { x: 68, z: 46, distance: 50, yaw: 0 };
const BENCH_ZOOM = { x: 64, z: 64, distance: 200, yaw: 0 };
const GATE = { gameAvg: 55, gameLow: 45, zoomAvg: 40, longestWarmMs: 250, load: 8 };
const BUILDING_KINDS = ['massExtractor', 'generator', 'rareExtractor', 'lab', 'depot', 'shredder', 'smelter', 'assembler', 'wall', 'gun', 'area', 'beam', 'heavy', 'shield', 'tempTurret', 'belt', 'splitter', 'merger', 'gate'];
const TURRETS = ['gun', 'area', 'beam', 'heavy', 'tempTurret'];
const ALIENS = ['rusher', 'hunter', 'breaker', 'saboteur'];
const load1 = () => loadavg()[0];
const started = Date.now();

async function shot2b(name) {
  mkdirSync(shots2b, { recursive: true });
  js(`(document.querySelectorAll('body > :not(canvas)').forEach((e) => (e.dataset.shotHidden = e.style.visibility, e.style.visibility = 'hidden')), true)`);
  await frames(3);
  const path = join(shots2b, `${name}.png`);
  ab('screenshot', path);
  js(`(document.querySelectorAll('[data-shot-hidden]').forEach((e) => { e.style.visibility = e.dataset.shotHidden; delete e.dataset.shotHidden; }), true)`);
  note(`screenshot ${path}`);
}

/** Resumes, waits in the page until `cond` holds on a drawn frame (up to `seconds`), then pauses at once: the effects freeze there. */
async function catchFrame(what, cond, seconds, start = '') {
  // resume (control.pause toggles, and __game.paused follows a moment later: wait for it), then
  // run `start` (a command for the scene)
  js(`(__game.paused && __game.control.pause(), true)`);
  await until('running', '__game.paused === false', 10);
  if (start) js(`(${start}, true)`);
  // polled in the page frame by frame, in evaluations of at most 8 s (agent-browser times out a
  // longer one), until the condition holds or `seconds` have passed
  let ok = false;
  for (let left = seconds; !ok && left > 0; left -= 8) {
    ok = js(`new Promise((res) => {
      const t0 = performance.now();
      const f = () => {
        let hit = false;
        try { hit = !!(${cond}); } catch { hit = false; }
        if (hit) { __game.control.pause(); res(true); return; }
        if (performance.now() - t0 > ${Math.min(8, left) * 1000}) { res(false); return; }
        requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    })`);
  }
  if (!ok) fail(`screenshot: ${what} not seen within ${seconds} s`);
  await until('paused', '__game.paused === true', 10);
  return ok;
}

/**
 * The benchmark scene, from a fresh sandbox, through the game's own commands (free spending, 1×):
 * walls round x 44–92, z 36–66 with a gate in the south and the west wall; 16 turrets placed and 4
 * temporary turrets dropped by engineers; both extractors (the rare one outside the north wall,
 * given 10 × hit points); every W17 kind; 10 engineers produced (12 in all) and the commander.
 * Aliens 10 × hit points, 0.1 × damage, so at least 150 stay alive attacking the north side.
 */
const FIXTURE_JS = `(async () => {
  const g = __game;
  const log = [];
  const ok = (r, what) => { if (!r || !r.ok) log.push(what + ': ' + (r ? r.reason : 'no result')); return r; };
  ok(await g.setUnlimited(true), 'free spending');
  ok(await g.grantResearch('all'), 'research');
  ok(await g.tune('unit', 'commander', 'buildRate', 10), 'commander build rate');
  ok(await g.tune('unit', 'engineer', 'buildRate', 10), 'engineer build rate');
  for (const k of ${JSON.stringify(ALIENS)}) {
    ok(await g.tune('alien', k, 'hp', 10), k + ' hp');
    ok(await g.tune('alien', k, 'dps', 0.1), k + ' damage');
  }
  ok(await g.tune('building', 'rareExtractor', 'hp', 10), 'rare extractor hp');
  for (let i = 0; i < 10; i++) g.cmd.produce();
  const walls = [];
  for (let x = 44; x <= 92; x++) walls.push([x, 36], [x, 66]);
  for (let z = 37; z <= 65; z++) walls.push([44, z], [92, z]);
  (await Promise.all(walls.map(([x, z]) => g.place('wall', x, z)))).forEach((r, i) => ok(r, 'wall ' + walls[i]));
  const spots = [
    ['gun', 46, 38], ['area', 49, 38], ['beam', 52, 38], ['heavy', 55, 38], ['gun', 59, 38], ['area', 62, 38], ['beam', 65, 38], ['heavy', 68, 38],
    ['gun', 73, 38], ['area', 76, 38], ['beam', 79, 38], ['heavy', 82, 38], ['gun', 86, 38], ['area', 89, 38], ['beam', 50, 42], ['heavy', 60, 42],
    ['massExtractor', 54, 50], ['massExtractor', 72, 49], ['rareExtractor', 73, 29],
    ['generator', 47, 56], ['lab', 51, 56], ['depot', 55, 56], ['shredder', 59, 56], ['smelter', 63, 56], ['assembler', 67, 56], ['shield', 71, 56],
    ['belt', 76, 62, 0], ['belt', 77, 62, 0], ['splitter', 78, 62, 0], ['belt', 79, 62, 0], ['merger', 80, 62, 0], ['belt', 81, 62, 0],
  ];
  (await Promise.all(spots.map(([k, x, z, d]) => g.place(k, x, z, d ?? 0)))).forEach((r, i) => ok(r, 'place ' + spots[i]));
  const engs = () => g.list('unit').filter((u) => u.kindName === 'engineer').map((u) => u.id);
  ok(await g.gate(66, 66, { axis: 'x', ids: engs() }), 'south gate');
  ok(await g.gate(44, 52, { axis: 'z', ids: engs(), queue: true }), 'west gate');
  return log;
})()`;

/**
 * Roles once the 12 engineers and both gates stand: engineers' build rate 0.5 × (the runs outlast
 * the measurement); 7 builders on a 2-deep wall run west of the base, 4 drop temporary turrets and
 * then build a second run beside it, 1 shuttles through the south gate; 160 aliens spawned north.
 * Leaves window.__bench for the measurement's sustain step.
 */
const ROLES_JS = `(async () => {
  const g = __game;
  const log = [];
  const ok = (r, what) => { if (!r || !r.ok) log.push(what + ': ' + (r ? r.reason : 'no result')); return r; };
  const engs = g.list('unit').filter((u) => u.kindName === 'engineer').map((u) => u.id).sort((a, b) => a - b);
  ok(await g.tuneReset('unit'), 'build rates back');
  ok(await g.tune('unit', 'engineer', 'buildRate', 0.5), 'engineer build rate 0.5');
  const shuttle = engs[0];
  const droppers = engs.slice(1, 5);
  const builders = engs.slice(5);
  [[48.5, 47.5], [57.5, 47.5], [77.5, 47.5], [85.5, 47.5]].forEach(([x, z], i) => g.cmd.move([droppers[i]], x, z));
  g.cmd.move([shuttle], 66.5, 58.5);
  // the commander starts beside the south gate, which holds its doors open: move it 10 tiles in
  const cmdr = g.list('unit').find((u) => u.kindName === 'commander');
  if (cmdr) g.cmd.move([cmdr.id], 60.5, 54.5);
  ok(await g.buildRun([40, 38], [40, 54], 2, { ids: builders }), 'builders run');
  for (const [k, x] of [['rusher', 50.5], ['hunter', 60.5], ['breaker', 70.5], ['saboteur', 80.5]]) g.spawnAt(k, x, 30.5, 40);
  await new Promise((r) => setTimeout(r, 6000));
  for (const id of droppers) g.cmd.dropTurret(id);
  await new Promise((r) => setTimeout(r, 1500));
  ok(await g.buildRun([42, 38], [42, 50], 2, { ids: droppers }), 'droppers run');
  window.__bench = { shuttle, droppers, builders, dropped: Object.fromEntries(droppers.map((id) => [id, performance.now()])) };
  return { log, engineers: engs.length, temp: g.list('building').filter((b) => b.kindName === 'tempTurret').length };
})()`;

/**
 * The measurement, in the page: requestAnimationFrame timestamps for `seconds`; every second the
 * sustain step (aliens back to 160, a new wall run if the runs are done, the shuttle turned round
 * every 7 s between z 58.5 and 74.5 (each end 7 tiles from the gate), the commander moved away from
 * the gate if it has respawned there, a temporary turret re-dropped when one has expired) and a sample of __game.activity
 * (deltas) and __game.inspect (entities drawn per kind: covered of entities).
 */
const MEASURE_JS = (seconds) => `(async () => {
  const g = __game;
  const B = window.__bench;
  const R = { times: [], samples: [] };
  let on = true;
  const rec = (now) => { if (!on) return; R.times.push(now); requestAnimationFrame(rec); };
  requestAnimationFrame(rec);
  const t0 = performance.now();
  R.t0 = t0;
  let prev = g.activity;
  let leg = 0;
  let runAt = 0;
  for (let s = 1; s <= ${seconds}; s++) {
    await new Promise((r) => setTimeout(r, Math.max(0, t0 + s * 1000 - performance.now())));
    // sustain
    const alive = g.entityCounts.aliens;
    if (alive < 160) ${JSON.stringify(ALIENS)}.forEach((k, i) => g.spawnAt(k, 50.5 + i * 10, 30.5, Math.ceil((160 - alive) / 4)));
    if (g.runs.length === 0) {
      const spec = [[[36, 38], [36, 54]], [[34, 40], [34, 54]], [[46, 30], [60, 30]]][runAt++ % 3];
      g.buildRun(spec[0], spec[1], 2, { ids: [...B.builders, ...B.droppers] });
    }
    if (s === 1 || s % 7 === 0) g.cmd.move([B.shuttle], 66.5, leg++ % 2 ? 58.5 : 74.5);
    // the commander (re)spawns beside the south gate and would hold its doors open
    const cmdr = g.list('unit').find((u) => u.kindName === 'commander');
    if (cmdr && Math.abs(cmdr.x - 66.5) < 4 && Math.abs(cmdr.z - 66.5) < 4) g.cmd.move([cmdr.id], 60.5, 54.5);
    const temps = g.list('building').filter((b) => b.kindName === 'tempTurret').length;
    if (temps < 4) {
      const id = [...B.builders, ...B.droppers].find((e) => !(performance.now() - (B.dropped[e] ?? -1e9) < 76000));
      if (id !== undefined) { g.cmd.dropTurret(id); B.dropped[id] = performance.now(); }
    }
    // sample
    const a = g.activity;
    const d = {};
    for (const k of ['beaming', 'firing', 'shots', 'attacking', 'doorOpening', 'doorClosing']) d[k] = a[k] - prev[k];
    prev = a;
    // inspect against the snapshot the scene was drawn from (a frame with no snapshot since)
    for (let k = 0; k < 10 && !g.drawnCurrent; k++) await new Promise((r) => requestAnimationFrame(r));
    const rep = g.inspect();
    R.samples.push({ s, d, cov: Object.fromEntries(Object.entries(rep).map(([k, e]) => [k, [e.covered, e.entities]])), alive });
  }
  on = false;
  R.drawCalls = g.drawCalls;
  R.lod = g.lodLevelCounts;
  return R;
})()`;

async function benchFixture() {
  await load('/?sandbox=1');
  const log = js(FIXTURE_JS);
  if (log.length) fail(`benchmark fixture refused: ${log.join('; ')}`);
  await until('12 engineers and both gates', `__game.list('unit').filter((u) => u.kindName === 'engineer').length >= 12 && __game.list('building').filter((b) => b.kindName === 'gate' && b.complete).length === 2`, 240);
  const roles = js(ROLES_JS);
  if (roles.log.length) fail(`benchmark roles refused: ${roles.log.join('; ')}`);
  return roles;
}

/** One pose: a fresh fixture, 5 s warm-up then 20 s measured; the figures and the gate's verdict. */
async function measurePose(label, rig, zoomOut) {
  await benchFixture();
  camera(rig);
  await frames(30);
  const loadStart = load1();
  const R = js(MEASURE_JS(25));
  const loadEnd = load1();
  const t = R.times.filter((x) => x >= R.t0 + 5000 && x <= R.t0 + 25000);
  const iv = [];
  for (let i = 1; i < t.length; i++) iv.push(t[i] - t[i - 1]);
  const secs = (t[t.length - 1] - t[0]) / 1000;
  const worst = [...iv].sort((a, b) => b - a);
  const n1 = Math.max(1, Math.ceil(iv.length / 100));
  const avg = iv.length / secs;
  const low = 1000 / (worst.slice(0, n1).reduce((a, b) => a + b, 0) / n1);
  const cost = js('__game.renderCost(15)');
  const problems = [];
  const window = R.samples.filter((x) => x.s > 5);
  // the workload must be visible: entities actually drawn (covered), every second
  for (const x of window) {
    const c = (k) => x.cov[k]?.[0] ?? 0;
    const sum = (ks) => ks.reduce((a, k) => a + c(k), 0);
    if (zoomOut) {
      const short = Object.entries(x.cov).filter(([, [cov, ent]]) => cov < ent).map(([k, [cov, ent]]) => `${k} ${cov}/${ent}`);
      if (short.length) problems.push(`second ${x.s}: workload not visible (not all drawn: ${short.join(', ')})`);
    } else {
      const miss = [];
      if (sum(ALIENS) < 100) miss.push(`aliens ${sum(ALIENS)} < 100`);
      if (sum(TURRETS) < 15) miss.push(`turrets ${sum(TURRETS)} < 15`);
      if (c('engineer') < 10) miss.push(`engineers ${c('engineer')} < 10`);
      if (c('commander') < 1) miss.push('no commander');
      const kinds = [...BUILDING_KINDS, ...ALIENS].filter((k) => c(k) < 1);
      if (kinds.length) miss.push(`not drawn: ${kinds.join(', ')}`);
      if (miss.length) problems.push(`second ${x.s}: workload not visible (${miss.join('; ')})`);
    }
    if (x.alive < 150) problems.push(`second ${x.s}: ${x.alive} aliens alive (< 150)`);
    const idle = ['beaming', 'firing', 'attacking', 'shots'].filter((k) => !(x.d[k] > 0));
    if (idle.length) problems.push(`second ${x.s}: scene not active (no visible ${idle.join(', ')})`);
  }
  const doors = window.reduce((a, x) => [a[0] + x.d.doorOpening, a[1] + x.d.doorClosing], [0, 0]);
  if (!(doors[0] > 0 && doors[1] > 0)) problems.push(`scene not active: door opening frames ${doors[0]}, closing frames ${doors[1]} in the 20 s`);
  const perf = zoomOut ? avg >= GATE.zoomAvg : avg >= GATE.gameAvg && low >= GATE.gameLow;
  if (!perf) problems.push(zoomOut ? `${avg.toFixed(1)} fps average < ${GATE.zoomAvg}` : `${avg.toFixed(1)} fps average / ${low.toFixed(1)} 1%-low (gate ${GATE.gameAvg} / ${GATE.gameLow})`);
  const last = window[window.length - 1];
  const visible = Object.entries(last?.cov ?? {}).map(([k, [cov, ent]]) => `${k} ${cov}/${ent}`).join(', ');
  const act = window.reduce((a, x) => { for (const k in x.d) a[k] = (a[k] ?? 0) + x.d[k]; return a; }, {});
  note(
    `benchmark ${label}: ${avg.toFixed(1)} fps average, ${low.toFixed(1)} 1%-low (mean of the slowest 1% of ${iv.length} frame intervals), longest frame ${worst[0].toFixed(1)} ms; ` +
      `load average ${loadStart.toFixed(2)} at start, ${loadEnd.toFixed(2)} at end; forced-complete frame ${cost.fullMs.toFixed(2)} ms (terrain ${cost.terrainMs.toFixed(2)}, post ${cost.postMs.toFixed(2)}); draw calls ${R.drawCalls}; ` +
      `LOD ${JSON.stringify(R.lod)}; visible (drawn/in snapshot) ${visible}; activity frames in the 20 s ${JSON.stringify(act)}; inspect sampled once a second (its cost is in the frame times)`,
  );
  return { label, avg, low, loadStart, loadEnd, problems };
}

/** A pose through the gate, with the load-average retry rule. */
async function gatedPose(label, rig, zoomOut) {
  const a = await measurePose(label, rig, zoomOut);
  if (!a.problems.length) {
    note(`ok   benchmark ${label}: passes`);
    return;
  }
  if (Math.max(a.loadStart, a.loadEnd) > GATE.load) {
    note(`benchmark ${label} failed at load average ${Math.max(a.loadStart, a.loadEnd).toFixed(2)} (> ${GATE.load}): ${a.problems.slice(0, 6).join(' | ')}; waiting for load < ${GATE.load} (up to 5 min) to measure once more`);
    const t0 = Date.now();
    while (load1() >= GATE.load && Date.now() - t0 < 300_000) await sleep(10_000);
    note(`load average now ${load1().toFixed(2)} after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    const b = await measurePose(`${label} (re-measured)`, rig, zoomOut);
    if (!b.problems.length) {
      note(`ok   benchmark ${label}: passes when re-measured (first result: ${a.problems.slice(0, 3).join(' | ')})`);
      return;
    }
    fail(`benchmark ${label}: ${b.problems.slice(0, 8).join(' | ')} (first measurement: ${a.problems.slice(0, 3).join(' | ')})`);
    return;
  }
  fail(`benchmark ${label} at load average ${Math.max(a.loadStart, a.loadEnd).toFixed(2)}: ${a.problems.slice(0, 8).join(' | ')}`);
}

/** A cold launch of the stress scene in a fresh browser (the session closed first), warm-up on or off. */
async function coldLaunch(warm) {
  spawnSync(AB, ['--session', SESSION, 'close'], { timeout: 30_000 });
  await sleep(2000);
  // a blank page first, so the viewport is set before the game loads (opening the game straight
  // after a close and then setting the viewport left a blank page: agent-browser 0.37)
  ab('open', 'about:blank');
  ab('set', 'viewport', '1440', '900');
  const loadStart = load1();
  ab('open', `${ORIGIN}/?stress=1${warm ? '' : '&warmup=0'}`);
  await until('the 10 s after the first visible frame', '__game?.warmup?.windowDone === true', 180);
  const w = js('__game.warmup');
  return { ...w, loadStart, loadEnd: load1() };
}

async function run2b() {
  // ---- warm-up: two equivalent cold launches
  const off = await coldLaunch(false);
  const on = await coldLaunch(true);
  const fmt = (w) => `loading ${(w.loadingMs / 1000).toFixed(2)} s to the first visible frame, longest frame in the next 10 s ${w.longestFrameMs.toFixed(1)} ms (${w.frames} frames), load average ${w.loadStart.toFixed(2)} → ${w.loadEnd.toFixed(2)}`;
  note(`warm-up off (?warmup=0): ${fmt(off)}`);
  note(`warm-up on: ${fmt(on)}; warm-up frame ${on.ran ? 'rendered' : 'NOT rendered'}: ${on.meshes} meshes primed, compile ${on.compileMs.toFixed(0)} ms, frame ${on.frameMs.toFixed(0)} ms through passes ${on.passes.join(', ')}`);
  if (!on.ran || on.passes.length < 2) fail(`warm-up: did not run through the composer (${JSON.stringify(on)})`);
  if (off.ran) fail('warm-up: ran with ?warmup=0');
  if (!(on.longestFrameMs < off.longestFrameMs)) fail(`warm-up: longest frame ${on.longestFrameMs.toFixed(1)} ms with it, not lower than ${off.longestFrameMs.toFixed(1)} ms without`);
  else note(`ok   warm-up: longest frame ${on.longestFrameMs.toFixed(1)} ms with it < ${off.longestFrameMs.toFixed(1)} ms without`);
  if (Math.max(on.loadStart, on.loadEnd) < GATE.load) {
    if (on.longestFrameMs >= GATE.longestWarmMs) fail(`warm-up: longest frame ${on.longestFrameMs.toFixed(1)} ms ≥ ${GATE.longestWarmMs} ms at load average below ${GATE.load}`);
    else note(`ok   warm-up: longest frame ${on.longestFrameMs.toFixed(1)} ms < ${GATE.longestWarmMs} ms (load average below ${GATE.load})`);
  } else note(`warm-up: the 250 ms bound is not judged at load average ${Math.max(on.loadStart, on.loadEnd).toFixed(2)} (≥ ${GATE.load})`);
  errorsNow('warm-up launches');

  // ---- the combined performance gate, each pose from a fresh fixture
  await gatedPose('game camera', BENCH_CAMERA, false);
  await gatedPose('strategic zoom-out', BENCH_ZOOM, true);
  errorsNow('benchmark');

  // ---- the 2b screenshots, on the last pose's scene (the effects frozen by pausing)
  const close = (x, z, distance, yaw, pitchDeg) => camera({ x, z, distance, yaw, pitch: (pitchDeg * Math.PI) / 180 });
  close(41.5, 49, 16, 0.5, 42);
  await catchFrame('engineers beaming', '__game.activity.now.beaming', 20);
  await shot2b('w24-2b-engineers-beaming');
  close(60, 40.5, 9, 0.9, 32);
  await catchFrame('a muzzle flash', '__game.activity.now.flash', 30);
  await shot2b('w24-2b-turret-recoil-flash');
  close(64, 35, 22, 0, 48);
  await catchFrame('shots in flight', '__game.activity.now.shots', 20);
  await shot2b('w24-2b-shots-in-flight');
  close(66.5, 66.5, 11, 0.4, 40);
  await catchFrame(
    'the engineer in the open gate',
    `(() => { const u = __game.list('unit').find((u) => u.id === window.__bench.shuttle); return u && Math.abs(u.x - 66.5) < 0.8 && u.z > 66.1 && u.z < 66.9; })()`,
    30,
    `__game.cmd.move([window.__bench.shuttle], 66.5, __game.list('unit').find((u) => u.id === window.__bench.shuttle).z < 66.5 ? 71.5 : 61.5)`,
  );
  await shot2b('w24-2b-gate-open');
  camera({ ...BENCH_ZOOM, pitch: (84 * Math.PI) / 180 });
  await frames(10);
  await shot2b('w24-2b-strategic-zoom');
  errorsNow('2b screenshots');

  // ---- W27: the wireframe placement preview, real mouse
  js(`(__game.paused && __game.control.pause(), true)`);
  await until('running', '__game.paused === false', 10);
  // a build tool needs a builder selected: the commander, by a real click on it with the camera
  // centred on it (clear of the build bar at the foot of the screen)
  const cpos = js(`(() => { const u = __game.list('unit').find((u) => u.kindName === 'commander'); return u ? { id: u.id, x: u.x, z: u.z } : null; })()`);
  let picked = false;
  for (let k = 0; cpos && !picked && k < 3; k++) {
    const u = js(`(() => { const u = __game.list('unit').find((u) => u.id === ${cpos.id}); return u ? { x: u.x, z: u.z } : null; })()`);
    if (!u) break;
    camera({ x: u.x, z: u.z, distance: 22, yaw: 0, pitch: (55 * Math.PI) / 180 });
    await frames(10);
    const p = js(`__game.screenOf('unit', ${cpos.id})`);
    ab('mouse', 'move', String(Math.round(p.x)), String(Math.round(p.y)));
    ab('mouse', 'down', 'left');
    ab('mouse', 'up', 'left');
    await frames(10);
    picked = js('__game.selected').some((s) => s.id === cpos.id);
  }
  if (!picked) fail(`W27: could not select the commander by clicking it (${JSON.stringify(cpos)}, selected ${JSON.stringify(js('__game.selected'))})`);
  camera({ x: 60, z: 49, distance: 22, yaw: 0, pitch: (55 * Math.PI) / 180 });
  await frames(10);
  key('2', 'Digit2');
  await frames(5);
  const tile = [62, 46];
  const p = js(`__game.worldToScreen(${tile[0] + 1}, ${tile[1] + 1})`);
  ab('mouse', 'move', String(Math.round(p.x)), String(Math.round(p.y)));
  await frames(10);
  const ghost = js('__game.ghost');
  const wire = js('__game.inspectPreview()')['overlay/preview/wire'];
  if (!ghost || ghost.kindName !== 'gun' || ghost.tx !== tile[0] || ghost.ty !== tile[1] || !ghost.ok) fail(`W27: the gun tool over tile ${tile}: ghost ${JSON.stringify(ghost)}`);
  else if (!wire || wire.instances < 1 || Math.hypot(wire.centre[0] - (tile[0] + 1), wire.centre[1] - (tile[1] + 1)) > 1.5) fail(`W27: no wireframe at the hovered tile: ${JSON.stringify(wire)}`);
  else note(`ok   W27: the gun tool over tile ${tile}: wireframe preview drawn there (${wire.instances} instances, ${wire.geometries} geometries, centre ${wire.centre.map((v) => v.toFixed(2)).join(', ')})`);
  const op0 = js(`__game.inspectPreview()['overlay/preview/wire']?.opacity`);
  await sleep(500);
  const op1 = js(`__game.inspectPreview()['overlay/preview/wire']?.opacity`);
  await sleep(250);
  const op2 = js(`__game.inspectPreview()['overlay/preview/wire']?.opacity`);
  if (!(Math.max(Math.abs(op1 - op0), Math.abs(op2 - op1)) > 0.05)) fail(`W27: the wireframe does not pulse (opacity ${op0}, ${op1}, ${op2})`);
  else note(`ok   W27: the wireframe pulses (opacity ${op0.toFixed(2)} → ${op1.toFixed(2)} → ${op2.toFixed(2)} over 0.75 s)`);
  await shot2b('w27-wireframe-preview');
  key('Escape', 'Escape');
  // the drag row in the middle of the screen (z 61.5 lies under the build bar from the last pose)
  camera({ x: 53, z: 58, distance: 22, yaw: 0, pitch: (55 * Math.PI) / 180 });
  await frames(10);
  key('1', 'Digit1');
  await frames(5);
  const a = js('__game.worldToScreen(48.5, 61.5)');
  const b = js('__game.worldToScreen(57.5, 61.5)');
  ab('mouse', 'move', String(Math.round(a.x)), String(Math.round(a.y)));
  ab('mouse', 'down', 'left');
  for (let k = 1; k <= 8; k++) ab('mouse', 'move', String(Math.round(a.x + ((b.x - a.x) * k) / 8)), String(Math.round(a.y + ((b.y - a.y) * k) / 8)));
  await frames(10);
  const drag = js('__game.dragPreview');
  const dw = js('__game.inspectPreview()')['overlay/drag/wire'];
  if (!drag || !dw || dw.instances < drag.build.length) fail(`W27: mid-drag wall wireframes: plan ${JSON.stringify(drag?.build?.length)} tiles, wires ${JSON.stringify(dw)}`);
  else note(`ok   W27: mid wall drag: ${drag.build.length} tiles planned, ${dw.instances} wall wireframe instances (${dw.geometries} wall pieces)`);
  await shot2b('w27-wall-drag-preview');
  key('Escape', 'Escape');
  ab('mouse', 'up', 'left');
  await frames(5);
  errorsNow('W27');

  // ---- every 2b and W27 screenshot written by this run
  const missing = SHOTS_2B.filter((n) => {
    const f = join(shots2b, `${n}.png`);
    return !existsSync(f) || statSync(f).size === 0 || statSync(f).mtimeMs < started;
  });
  if (missing.length) fail(`screenshots missing or not written by this run: ${missing.join(', ')}`);
  else note(`ok   ${SHOTS_2B.length} run 2b and W27 screenshots written to ${shots2b}`);
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
    if (args.includes('--only-2b')) {
      // development: the run 2b and W27 checks alone
      await run2b();
      throw null;
    }

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

    // ---- W24 run 2b and W27
    await run2b();
  } catch (e) {
    if (e !== null) fail(String(e?.message ?? e));
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
