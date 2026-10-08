#!/usr/bin/env node
// Browser check for W25 (the build queue), with real input: agent-browser's mouse (CDP) and its
// keydown/keyup for Shift (the game reads Shift from the keyboard as well as from the pointer
// event, main.ts shiftHeld, because agent-browser's mouse events carry no modifiers).
//
//   node scripts/check-queue.mjs [--shots <dir>] [--no-build] [--origin <url>]
//
// Builds this tree and serves it with `vite preview` on strict port 8824 (or uses --origin, e.g.
// the dev server), then drives agent-browser (session `w25`, 1440 × 900) in the sandbox:
//   - selects two engineers (a click, then Shift + click), picks the gun turret (key 2), holds
//     Shift and places three turrets with three clicks: build mode stays open while Shift is held
//     and closes when it is released
//   - the queue panel lists 3 items for each engineer
//   - the queue line and the numbers are drawn (__game.inspectQueue: the scene graph)
//   - remove item 2 in the panel (a real click on its × for each engineer): its ghost (the
//     reserved-site outline, read from the scene) stays while the other engineer still holds it,
//     and disappears when neither does
//   - an unshifted placement replaces both queues (one item each); the reserved sites go
//   - item 7, the drag preview: with Shift, the wall tool (key 1), the button held down and the
//     mouse moving across a turret site, the preview (read from the scene) is drawn mid-drag and
//     before release — 11 outlines, 2 skipped tiles with crosses, the label "11 tiles · 2 skipped ·
//     1,100 mass · 1,650 energy"; after release it is gone and the reserved wall sites stand on
//     exactly the previewed tiles; Esc mid-drag queues nothing
//   - 0 console errors
// With --shots <dir> it also saves w25-queue-drag.png (mid-drag), gives the two engineers
// different queues and saves w25-queue-lines.png (the two selected engineers' queue lines) and
// w25-queue-panel.png (the panel, cropped).
// It always stops the preview server and closes the agent-browser session. Exit 1 on any failure.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8824;
const SESSION = 'w25';
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const shotsDir = arg('--shots');
const ORIGIN = arg('--origin') ?? `http://127.0.0.1:${PORT}`;
const serve = !arg('--origin');

const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.log(`FAIL ${msg}`);
};
const note = (msg) => console.log(msg);
const check = (ok, pass, failMsg) => (ok ? note(`ok   ${pass}`) : fail(failMsg));

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
  if (!out?.success) throw new Error(`agent-browser ${a.join(' ')}: ${out?.error ?? r.stderr}`);
  return out.data;
}
const js = (code) => ab('eval', code).result;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const frames = (n) => js(`new Promise((res) => { let k = 0; const f = () => (++k >= ${n} ? res(true) : requestAnimationFrame(f)); requestAnimationFrame(f); })`);

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
    await sleep(300);
  }
}

/** A real click: move, press, release (agent-browser mouse, CDP). */
async function click(x, y, button = 'left') {
  ab('mouse', 'move', String(Math.round(x)), String(Math.round(y)));
  ab('mouse', 'down', button);
  ab('mouse', 'up', button);
  await frames(3);
}
const shiftDown = () => ab('keydown', 'Shift');
const shiftUp = () => ab('keyup', 'Shift');
/**
 * A key press with nothing focused (a focused panel button would take it): keydown then keyup.
 * (agent-browser 0.37's `press 2` left the key down, auto-repeating keydown events.)
 */
function press(key) {
  js('(document.activeElement && document.activeElement !== document.body && document.activeElement.blur(), true)');
  ab('keydown', key);
  ab('keyup', key);
}
const screenOfTile = (x, z) => js(`__game.worldToScreen(${x}, ${z})`);
/** Gun turret (2 × 2) footprint anchor (tx, ty): click at its centre (main.ts footprintAt). */
const gunClick = async (tx, ty) => {
  const p = screenOfTile(tx + 1, ty + 1);
  await click(p.x, p.y);
};
const siteAt = (tx, ty) => js(`(__game.list('building').find((b) => b.tx === ${tx} && b.ty === ${ty}) ?? null)`);
const outlineAt = (tx, ty) => js(`__game.reservedOutlines().some(([x, z]) => Math.abs(x - ${tx + 1}) < 0.3 && Math.abs(z - ${ty + 1}) < 0.3)`);
const queueOf = (id) => js(`(__game.queues.find((q) => q.id === ${id})?.orders ?? [])`);

/** Selects engineer `id` by clicking it (Shift: added to the selection). Retries round the point. */
async function selectEngineer(id, add) {
  for (const [ox, oy] of [[0, 0], [2, -3], [-2, -6], [3, 2]]) {
    const p = js(`__game.screenOf('unit', ${id})`);
    if (add) shiftDown();
    await click(p.x + ox, p.y + oy);
    if (add) shiftUp();
    await frames(3);
    const sel = js('__game.selected.map((s) => s.id)');
    if (sel.includes(id)) return sel;
    if (!add) continue;
  }
  throw new Error(`could not select engineer ${id} by clicking it`);
}

/** The × of item `index` (0-based) in the panel's list for unit `unit`: a real click on it. */
async function removeInPanel(unit, index) {
  const r = js(`(() => {
    const b = document.querySelector('.queue .u[data-unit="${unit}"] li.item:nth-child(${index + 1}) button.rm');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!r) throw new Error(`no remove control for item ${index + 1} of unit ${unit}`);
  const hit = js(`(() => { const e = document.elementFromPoint(${r.x}, ${r.y}); return e ? e.tagName + '.' + e.className + ' ' + e.textContent.slice(0, 40) : null; })()`);
  if (!/^BUTTON\.rm/.test(hit ?? '')) throw new Error(`the remove control at ${Math.round(r.x)},${Math.round(r.y)} is covered by ${hit}`);
  await click(r.x, r.y);
  await frames(5);
  const rej = js('__game.rejected.slice(-2)');
  if (rej.length) note(`refusals so far: ${JSON.stringify(rej)}`);
}

function errorsNow(label) {
  const page = ab('errors').errors ?? [];
  const consoleErrs = (ab('console').messages ?? ab('console').logs ?? []).filter((m) => (m.type ?? m.level) === 'error');
  const game = js('__game.errors');
  check(!page.length && !consoleErrs.length && !game, `${label}: 0 console errors`, `${label}: ${page.length} page errors, ${consoleErrs.length} console errors, __game.errors ${game}: ${JSON.stringify([...page, ...consoleErrs]).slice(0, 600)}`);
}

async function shot(name) {
  if (!shotsDir) return null;
  await frames(6);
  const path = join(shotsDir, `w25-queue-${name}.png`);
  ab('screenshot', path);
  note(`screenshot ${path}`);
  return path;
}

async function run() {
  ab('open', `${ORIGIN}/?sandbox=1`);
  ab('set', 'viewport', '1440', '900');
  await until('the sandbox ready', 'window.__game?.ready === true', 120);
  ab('errors', '--clear');
  ab('console', '--clear');
  // engineers build fast enough to start a site, not to finish three before the checks
  js(`(async () => { await __game.setUnlimited(true); return true; })()`);
  const engs = js(`__game.list('unit').filter((u) => u.kindName === 'engineer').map((u) => u.id)`);
  if (engs.length < 2) throw new Error(`the sandbox has ${engs.length} engineers`);
  const [e1, e2] = engs;
  js(`(__game.camera.set({ x: 63, z: 61, distance: 34, yaw: 0, pitch: ${(62 * Math.PI) / 180} }), true)`);
  await frames(10);

  // ---- select two engineers: a click, then Shift + click
  await selectEngineer(e1, false);
  const sel = await selectEngineer(e2, true);
  check(sel.length === 2 && sel.includes(e1) && sel.includes(e2), `two engineers selected (${e1}, ${e2}) by a click and a Shift + click`, `selection after click + Shift-click: ${JSON.stringify(sel)}`);

  // ---- Shift held: three gun turrets with three clicks; the tool stays open until Shift is released
  press('2');
  await frames(3);
  check(js('__game.buildMode') === 'gun', 'key 2 picks the gun turret', `build mode after key 2: ${js('__game.buildMode')}`);
  const SITES = [
    [58, 58],
    [62, 58],
    [66, 58],
  ];
  shiftDown();
  const modes = [];
  for (const [tx, ty] of SITES) {
    await gunClick(tx, ty);
    modes.push(js('__game.buildMode'));
  }
  await frames(5);
  const heldOpen = js('__game.buildMode');
  shiftUp();
  await frames(5);
  const afterRelease = js('__game.buildMode');
  check(modes.every((m) => m === 'gun') && heldOpen === 'gun', 'build mode stays open while Shift is held (after each of 3 placements)', `build mode while Shift held: ${JSON.stringify(modes)}, then ${heldOpen}`);
  check(afterRelease === null, 'releasing Shift closes build mode', `build mode after releasing Shift: ${afterRelease}`);

  await until('three sites', `${JSON.stringify(SITES)}.every(([x, y]) => __game.list('building').some((b) => b.tx === x && b.ty === y))`, 10);
  const ids = SITES.map(([tx, ty]) => siteAt(tx, ty)?.id);
  await until('both queues of 3', `[${e1}, ${e2}].every((id) => (__game.queues.find((q) => q.id === id)?.orders.length ?? 0) === 3)`, 10);
  const q1 = queueOf(e1).map((o) => o.target);
  const q2 = queueOf(e2).map((o) => o.target);
  check(JSON.stringify(q1) === JSON.stringify(ids) && JSON.stringify(q2) === JSON.stringify(ids), `each engineer's queue is the three turrets in placement order (${ids.join(', ')})`, `queues ${JSON.stringify([q1, q2])}, sites ${JSON.stringify(ids)}`);

  // ---- the panel lists 3 items per engineer (rows actually laid out on screen)
  await frames(20); // the panel refreshes every 250 ms
  const panel = js(`[...document.querySelectorAll('.queue .u')].map((u) => ({ unit: Number(u.dataset.unit), items: [...u.querySelectorAll('li.item')].filter((li) => li.getBoundingClientRect().height > 0).length, text: u.textContent }))`);
  check(panel.length === 2 && panel.every((p) => p.items === 3), `the panel lists 3 items for each engineer (${panel.map((p) => p.items).join(', ')})`, `panel: ${JSON.stringify(panel)}`);

  // ---- the line and the numbers are drawn (scene graph)
  const q = js('__game.inspectQueue()');
  const paths = q.paths.map((p) => p.points.length).sort();
  const texts = q.labels.map((l) => l.text).sort();
  check(
    q.paths.length === 2 && paths.every((n) => n === 4) && JSON.stringify(texts) === JSON.stringify(['1', '2', '3']) && q.arrows === 6,
    `queue lines drawn: 2 paths of 4 points, labels ${texts.join(' ')}, ${q.arrows} arrowheads`,
    `queue drawing: ${JSON.stringify({ paths, texts, arrows: q.arrows })}`,
  );
  // the labels sit on the three sites, in order
  const onSites = SITES.every(([tx, ty], i) => q.labels.some((l) => l.text === String(i + 1) && Math.abs(l.x - (tx + 1)) < 0.01 && Math.abs(l.z - (ty + 1)) < 0.01));
  check(onSites, 'labels 1, 2, 3 stand on the three sites in placement order', `labels ${JSON.stringify(q.labels)}`);

  // ---- remove item 2 in the panel
  const [t2x, t2y] = SITES[1];
  check(outlineAt(t2x, t2y), 'item 2 is a reserved site drawn as a ghost outline', `no reserved outline at ${t2x},${t2y}`);
  await removeInPanel(e1, 1);
  await until('engineer 1 down to 2 items', `(__game.queues.find((q) => q.id === ${e1})?.orders.length ?? 0) === 2`, 10);
  await frames(10);
  check(siteAt(t2x, t2y) && outlineAt(t2x, t2y), "removed from engineer 1 only: the site and its ghost stay (engineer 2 still holds it)", `after removing it from engineer 1: site ${JSON.stringify(siteAt(t2x, t2y))}, outline ${outlineAt(t2x, t2y)}`);
  await frames(20);
  await removeInPanel(e2, 1);
  await until('item 2 gone', `!__game.list('building').some((b) => b.tx === ${t2x} && b.ty === ${t2y})`, 10);
  await frames(10);
  check(!outlineAt(t2x, t2y), 'removed from both: its ghost disappears', `reserved outline still drawn at ${t2x},${t2y}`);
  check(queueOf(e2).length === 2 && queueOf(e1).length === 2, 'both queues now hold items 1 and 3', `queues ${JSON.stringify([queueOf(e1), queueOf(e2)])}`);

  // ---- an unshifted placement replaces the queue
  // site 1 is the engineers' current item: let build power reach it, so it is a started site
  await until('site 1 started', `__game.list('building').some((b) => b.tx === ${SITES[0][0]} && b.ty === ${SITES[0][1]} && b.state !== 'reserved')`, 60);
  const firstStarted = true;
  press('2');
  await frames(3);
  await gunClick(62, 54);
  await until('the replacing site', `__game.list('building').some((b) => b.tx === 62 && b.ty === 54)`, 10);
  const newId = siteAt(62, 54).id;
  await until('queues replaced', `[${e1}, ${e2}].every((id) => { const o = __game.queues.find((q) => q.id === id)?.orders ?? []; return o.length === 1 && o[0].target === ${newId}; })`, 10).catch(() => null);
  const r1 = queueOf(e1).map((o) => o.target);
  const r2 = queueOf(e2).map((o) => o.target);
  check(JSON.stringify(r1) === `[${newId}]` && JSON.stringify(r2) === `[${newId}]`, `an unshifted placement replaces both queues with the new site (${newId})`, `queues after an unshifted placement: ${JSON.stringify([r1, r2])}`);
  check(js('__game.buildMode') === null, 'an unshifted placement closes build mode', `build mode: ${js('__game.buildMode')}`);
  await frames(10);
  check(!siteAt(...SITES[2]) && !outlineAt(...SITES[2]), 'the replaced reserved site 3 and its ghost are gone', `site 3: ${JSON.stringify(siteAt(...SITES[2]))}`);
  const s1 = siteAt(...SITES[0]);
  check(firstStarted ? s1 && s1.state !== 'reserved' : !s1, `site 1 ${firstStarted ? 'was started: it stays, part-built' : 'was still reserved: it is gone'}`, `site 1 (started before: ${firstStarted}): ${JSON.stringify(s1)}`);

  // ---- item 7: a wall drag is previewed while the mouse moves, and laid where it was previewed
  const tileScreen = (x, y) => screenOfTile(x + 0.5, y + 0.5);
  const DRAG = { from: [56, 55], to: [68, 55] }; // crosses the 2 × 2 turret site at 62,54: 2 tiles skipped
  const runs0 = js('__game.runs.length');
  press('1');
  await frames(3);
  shiftDown();
  const a = tileScreen(...DRAG.from);
  const b = tileScreen(...DRAG.to);
  ab('mouse', 'move', String(Math.round(a.x)), String(Math.round(a.y)));
  ab('mouse', 'down', 'left');
  let mid = null;
  const steps = 8;
  for (let k = 1; k <= steps; k++) {
    ab('mouse', 'move', String(Math.round(a.x + ((b.x - a.x) * k) / steps)), String(Math.round(a.y + ((b.y - a.y) * k) / steps)));
    await frames(2);
    if (k === steps / 2) mid = js('__game.dragPreview');
  }
  await frames(4);
  const last = js('__game.dragPreview');
  if (shotsDir) await shot('drag');
  const keyOf = ([x, y]) => `${x},${y}`;
  const midOk = mid && mid.build.length > 0 && mid.drawn.build.length === mid.build.length;
  check(midOk, `mid-drag (button still down) the preview draws ${mid?.build.length} wall outlines: "${mid?.label}"`, `mid-drag preview: ${JSON.stringify(mid)}`);
  const drawnOk =
    last &&
    last.drawn.build.length === last.build.length &&
    last.build.every(([x, y]) => last.drawn.build.some(([dx, dz]) => Math.abs(dx - (x + 0.5)) < 0.01 && Math.abs(dz - (y + 0.5)) < 0.01)) &&
    last.drawn.skipped.length === last.skipped.length;
  check(
    drawnOk && last.build.length === 11 && JSON.stringify(last.skipped) === '[[62,55],[63,55]]' && /11 tiles · 2 skipped · 1,100 mass · 1,650 energy/.test(last.label),
    `before release: ${last?.build.length} tiles to build and ${last?.skipped.length} skipped (crosses) drawn from the scene; label "${last?.label}"`,
    `preview before release: ${JSON.stringify(last)}`,
  );
  ab('mouse', 'up', 'left');
  shiftUp();
  await until('the run', `__game.runs.length > ${runs0}`, 10).catch(() => null);
  await frames(5);
  const walls = js(`__game.list('building').filter((b) => b.kindName === 'wall' && b.state === 'reserved' && b.ty === 55).map((b) => [b.tx, b.ty])`);
  const want = (last?.build ?? []).map(([x, y]) => keyOf([x, y])).sort();
  check(
    JSON.stringify(walls.map(keyOf).sort()) === JSON.stringify(want) && js('__game.dragPreview') === null,
    `after release the preview is gone and the ${walls.length} reserved wall sites stand on the previewed tiles`,
    `after release: sites ${JSON.stringify(walls)}, previewed ${JSON.stringify(want)}, preview ${JSON.stringify(js('__game.dragPreview'))}`,
  );
  // Esc mid-drag: nothing is queued
  const runs1 = js('__game.runs.length');
  press('1');
  await frames(3);
  const c0 = tileScreen(56, 50);
  const c1 = tileScreen(66, 50);
  ab('mouse', 'move', String(Math.round(c0.x)), String(Math.round(c0.y)));
  ab('mouse', 'down', 'left');
  for (let k = 1; k <= 4; k++) ab('mouse', 'move', String(Math.round(c0.x + ((c1.x - c0.x) * k) / 4)), String(Math.round(c0.y + ((c1.y - c0.y) * k) / 4)));
  await frames(3);
  const before = js('__game.dragPreview')?.build.length ?? 0;
  press('Escape');
  await frames(3);
  ab('mouse', 'up', 'left');
  await sleep(600);
  check(before > 0 && js('__game.runs.length') === runs1 && js('__game.dragPreview') === null && !js(`__game.list('building').some((b) => b.ty === 50 && b.kindName === 'wall')`), `Esc mid-drag (${before} tiles previewed) cancels it: no run queued, the preview is gone`, `Esc mid-drag: previewed ${before}, runs ${runs1} → ${js('__game.runs.length')}, preview ${JSON.stringify(js('__game.dragPreview'))}`);

  errorsNow('queue checks');

  if (shotsDir) {
    // different queues: engineer 1 adds two turrets, engineer 2 one (each selected alone, Shift)
    await selectEngineer(e1, false);
    press('2');
    shiftDown();
    await gunClick(58, 52);
    await gunClick(54, 56);
    shiftUp();
    await selectEngineer(e2, false);
    press('2');
    shiftDown();
    await gunClick(66, 52);
    shiftUp();
    await selectEngineer(e1, false);
    await selectEngineer(e2, true);
    await until('different queues', `__game.queuePanel.length === 2 && __game.queuePanel[0].items.length === __game.queuePanel[1].items.length + 1`, 10);
    js('(__game.control.pause(), true)');
    await until('paused', '__game.paused === true', 10);
    js(`(__game.camera.set({ x: 61, z: 57, distance: 30, yaw: 0, pitch: ${(58 * Math.PI) / 180} }), true)`);
    await frames(30);
    const q2s = js('__game.inspectQueue()');
    note(`shot state: ${q2s.paths.length} paths (${q2s.paths.map((p) => p.points.length).join(', ')} points), labels ${q2s.labels.map((l) => l.text).join(' ')}; panel ${JSON.stringify(js('__game.queuePanel'))}`);
    await shot('lines');
    const rect = js(`(() => { const r = document.querySelector('.queue').getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.x) - 6), y: Math.max(0, Math.floor(r.y) - 6), w: Math.ceil(r.width) + 12, h: Math.ceil(r.height) + 12, dpr: devicePixelRatio }; })()`);
    const full = await shot('panel');
    if (full) {
      const k = rect.dpr;
      execFileSync('sips', ['-c', String(Math.round(rect.h * k)), String(Math.round(rect.w * k)), '--cropOffset', String(Math.round(rect.y * k)), String(Math.round(rect.x * k)), full], { stdio: 'ignore' });
      note(`cropped ${full} to the panel (${rect.w} × ${rect.h} css px)`);
    }
    errorsNow('screenshots');
  }
}

async function main() {
  let server = null;
  if (serve && !args.includes('--no-build')) {
    console.log('building…');
    execFileSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: GAME, stdio: 'inherit' });
  }
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  try {
    if (serve) {
      server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: GAME, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let serverOut = '';
      server.stdout.on('data', (d) => (serverOut += d));
      server.stderr.on('data', (d) => (serverOut += d));
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
    }
    note(`origin: ${ORIGIN}${serve ? " (this tree's build)" : ''}`);
    await run();
  } catch (e) {
    fail(String(e?.message ?? e));
  } finally {
    try {
      spawnSync(AB, ['--session', SESSION, 'keyup', 'Shift'], { timeout: 10_000 });
      spawnSync(AB, ['--session', SESSION, 'close'], { timeout: 30_000 });
    } catch {
      /* already closed */
    }
    if (server)
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        /* already stopped */
      }
  }
  console.log(failures.length ? `check-queue: ${failures.length} FAILED` : 'check-queue: all checks passed');
  process.exit(failures.length ? 1 : 0);
}

await main();
