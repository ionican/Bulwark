#!/usr/bin/env node
// Browser check for W25 (the build queue), with real input: agent-browser's mouse (CDP) and its
// keydown/keyup for Shift (the game reads Shift from the keyboard as well as from the pointer
// event, main.ts shiftHeld, because agent-browser's mouse events carry no modifiers).
//
//   node scripts/check-queue.mjs [--shots <dir>] [--no-build] [--origin <url>]
//
// Builds this tree and serves it with `vite preview` on strict port 8824 (or uses --origin, e.g.
// the dev server), then drives agent-browser (session `w26`, 1440 × 900) in the sandbox:
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
//   - W25b, waiting for resources: free spending off, a real wall drag (no Shift) for both engineers at
//     speed 3; once the mass runs out, every site being built carries an hourglass marker (read from
//     the scene; W28 removed its words and the builder labels), and the resource readout says
//     "▲SHORT · N sites waiting" on the MASS row; free spending back on clears the markers
//   - W28, the construction hover readout: the real mouse over a started, starved wall site shows a
//     panel with its percent and its mass intake; sampled on every snapshot for 8 s, the figure is
//     positive and at most the mass income while the trickle is shared (economy.ts shares it every
//     tick, so a steadily starved site does not drop to 0 here); once its builders are stopped (X)
//     the same site reads 0 mass/s and 0 builders; the panel takes no pointer events; moving off
//     the site hides it; screenshot w28-hover-readout.png
//   - W25b, Stop: the X key on the two engineers removes the run's reserved tiles and the run;
//     its started tiles stay
//   - W25c, the queue overlay benchmark (__game.queueBench: synthetic queues drawn by the live
//     overlay at the game camera, x 64, z 62, distance 50, medium, 1440 × 900): 40 engineers × 64
//     orders must update in ≤ 1 ms CPU per frame unchanged and ≤ 5 ms on a change (medians) and hold
//     60 fps (display-capped; ≥ 58 measured); 256 × 64 must stay within the instance cap and 200
//     labels and never take 100 ms for an update. Both are reported in full.
//   - W26, the idle units column (a fresh sandbox; real mouse, Shift by agent-browser's keydown as
//     above): with the commander and two engineers idle the column shows commander × 1 and
//     engineer × 2; a click selects one engineer and the camera target moves to it (distance and
//     tilt kept); a second click selects the other; Shift + click selects both; with the wall tool
//     open, the clicks place nothing and order nothing (no map state changes); one engineer given a
//     build order: the engineer count drops to 1 on the next snapshot. Screenshot
//     w26-idle-column.png, written on every run (to --shots <dir>, else the vault's Bulwark Art
//     Reference folder)
//   - 0 console errors (a dash shader that fails to compile is one)
// With --shots <dir> it also saves w25-queue-drag.png (mid-drag), gives the two engineers
// different queues and saves w25-queue-lines.png (the two selected engineers' queue lines) and
// w25-queue-panel.png (the panel, cropped), and w25c-queue-bench.png (the 40 × 64 benchmark drawn).
// It always stops the preview server and closes the agent-browser session. Exit 1 on any failure.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ART_REF, screenshot } from './shots.mjs';

const GAME = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8824;
const SESSION = 'w26';
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const shotsDir = arg('--shots');
const ORIGIN = arg('--origin') ?? `http://127.0.0.1:${PORT}`;
const serve = !arg('--origin');
/** W26's screenshot is written on every run: to --shots, else the vault's art reference folder. */
// W26 and W28 screenshots go to the art reference folder unless --shots names another
const artShots = shotsDir ?? ART_REF;

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
  const path = await screenshot({ ab, js, frames }, join(shotsDir, `w25-queue-${name}.png`), { settle: 6 });
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

  // ---- W25b: starved sites show that they wait, and Stop (X) clears the unstarted tiles
  if (js('__game.paused')) js('(__game.control.pause(), true)'); // the screenshots pause the game
  await until('running', '__game.paused === false', 10);
  await selectEngineer(e1, false);
  await selectEngineer(e2, true);
  await until('free spending off', '__game.setUnlimited(false).then((r) => r.ok)', 10);
  js('(__game.control.speed(3), true)');
  const runsW = js('__game.runs.map((r) => r.id)');
  press('1');
  await frames(3);
  // no Shift: the run replaces their queues, so it is what they build (and what Stop clears)
  {
    const a = tileScreen(52, 48);
    const b = tileScreen(70, 48);
    ab('mouse', 'move', String(Math.round(a.x)), String(Math.round(a.y)));
    ab('mouse', 'down', 'left');
    for (let k = 1; k <= 6; k++) {
      ab('mouse', 'move', String(Math.round(a.x + ((b.x - a.x) * k) / 6)), String(Math.round(a.y + ((b.y - a.y) * k) / 6)));
      await frames(2);
    }
    ab('mouse', 'up', 'left');
  }
  const waitRun = await until('the wall run', `__game.runs.find((r) => !${JSON.stringify(runsW)}.includes(r.id))?.id ?? null`, 10);
  await until('mass short and a site waiting', `__game.pool.short.includes('mass') && (__game.waiting?.sites.length ?? 0) > 0`, 120);
  await frames(10);
  const ws = js('__game.waiting');
  const drawn = js('__game.inspectWaiting()');
  const markOk =
    drawn.sites.length === ws.sites.length &&
    drawn.sites.every((m) => m.icon === 'hourglass' && !('text' in m) && ws.sites.some((s) => s.id === m.site && Math.abs(s.x - m.x) < 1e-3 && Math.abs(s.z - m.z) < 1e-3)) &&
    !('builders' in drawn);
  check(markOk, `mass ran out: ${drawn.sites.length} site(s) carry an hourglass marker with no words, no builder labels (scene)`, `waiting markers: state ${JSON.stringify(ws)}, scene ${JSON.stringify(drawn)}`);
  await frames(20); // the readout refreshes every 250 ms
  const massRow = js('__game.resourceReadout').split('\n')[0];
  check(/^MASS .*▲SHORT · \d+ sites? waiting$/.test(massRow), `the readout marks mass: "${massRow.trim()}"`, `resource readout MASS row: "${massRow}"`);
  if (shotsDir) {
    const sites = ws.sites;
    js(`(__game.camera.set({ x: ${sites[0].x}, z: ${sites[0].z + 3}, distance: 22, yaw: 0, pitch: ${(55 * Math.PI) / 180} }), true)`);
    await frames(15);
    await shot('waiting');
  }
  await checkHoverReadout(ws.sites);
  await until('free spending on', '__game.setUnlimited(true).then((r) => r.ok)', 10);
  await frames(10);
  const cleared = js('__game.inspectWaiting()');
  check(cleared.sites.length === 0, 'free spending back on: the waiting markers are gone', `markers after free spending on: ${JSON.stringify(cleared)}`);
  // Stop (the X key) on both engineers: the run's reserved tiles and the run go, started tiles stay
  const wallsBefore = js(`__game.list('building').filter((b) => b.kindName === 'wall' && b.ty === 48).map((b) => ({ id: b.id, state: b.state }))`);
  press('x');
  await until('the run gone', `!__game.runs.some((r) => r.id === ${waitRun})`, 10).catch(() => null);
  await frames(5);
  const wallsAfter = js(`__game.list('building').filter((b) => b.kindName === 'wall' && b.ty === 48).map((b) => ({ id: b.id, state: b.state }))`);
  const startedBefore = wallsBefore.filter((b) => b.state !== 'reserved').map((b) => b.id);
  const reservedBefore = wallsBefore.filter((b) => b.state === 'reserved').map((b) => b.id);
  check(
    reservedBefore.length > 0 && startedBefore.length > 0 && !js('__game.runs').some((r) => r.id === waitRun) && startedBefore.every((id) => wallsAfter.some((b) => b.id === id)) && wallsAfter.every((b) => b.state !== 'reserved'),
    `X (Stop): ${reservedBefore.length} reserved tiles and the run removed, ${startedBefore.length} started tile(s) stay`,
    `after X: before ${JSON.stringify(wallsBefore)}, after ${JSON.stringify(wallsAfter)}, runs ${JSON.stringify(js('__game.runs'))}`,
  );
  const stoppedSite = startedBefore.find((id) => js(`__game.list('building').find((b) => b.id === ${id})?.state`) === 'started');
  if (stoppedSite === undefined) fail('W28: no started wall tile left to hover after Stop');
  else await checkHoverStopped(stoppedSite);
  js('(__game.control.speed(1), true)');

  errorsNow('W25b checks');

  // ---- W25c: queue overlay benchmark
  js(`(__game.camera.set({ x: 64, z: 62, distance: 50, yaw: 0 }), true)`);
  await frames(20);
  const fmt = (r) =>
    `unchanged ${r.still.updateMs.median.toFixed(3)} ms median / ${r.still.updateMs.p95.toFixed(3)} p95 / ${r.still.updateMs.max.toFixed(3)} max, ${r.still.fps.toFixed(1)} fps, frame CPU ${r.still.frameCpuMs.toFixed(2)} ms; ` +
    `changing every frame ${r.changing.updateMs.median.toFixed(3)} ms median / ${r.changing.updateMs.p95.toFixed(3)} p95 / ${r.changing.updateMs.max.toFixed(3)} max, ${r.changing.fps.toFixed(1)} fps, frame CPU ${r.changing.frameCpuMs.toFixed(2)} ms; ` +
    `drawn: ${r.drawn.instances} instances (cap ${r.maxInstances}), ${r.drawn.paths} paths, ${r.drawn.arrows} arrowheads, ${r.drawn.labels} labels, note ${JSON.stringify(r.drawn.more)}`;
  const b40 = js('__game.queueBench(40, 64, 180, true)');
  note(`queue overlay 40 × 64 (game camera, ${js('__game.quality')}): ${fmt(b40)}`);
  if (shotsDir) {
    const path = join(shotsDir, 'w25c-queue-bench.png');
    ab('screenshot', path);
    note(`screenshot ${path}`);
  }
  js('(__game.queueBenchEnd(), true)');
  check(b40.still.updateMs.median <= 1, `40 × 64: unchanged update ${b40.still.updateMs.median.toFixed(3)} ms ≤ 1 ms`, `40 × 64: unchanged update ${b40.still.updateMs.median.toFixed(3)} ms > 1 ms`);
  check(b40.changing.updateMs.median <= 5, `40 × 64: update on a change ${b40.changing.updateMs.median.toFixed(3)} ms ≤ 5 ms`, `40 × 64: update on a change ${b40.changing.updateMs.median.toFixed(3)} ms > 5 ms`);
  check(b40.still.fps >= 58 && b40.changing.fps >= 58, `40 × 64: holds 60 fps (${b40.still.fps.toFixed(1)} unchanged, ${b40.changing.fps.toFixed(1)} changing)`, `40 × 64: ${b40.still.fps.toFixed(1)} fps unchanged, ${b40.changing.fps.toFixed(1)} changing (< 58)`);
  check(
    b40.drawn.instances > 0 && b40.drawn.instances <= b40.maxInstances && b40.drawn.labels <= 200 && /^\+\d+ more$/.test(b40.drawn.more ?? '') && b40.drawn.paths === 40,
    `40 × 64: 40 paths drawn, ${b40.drawn.labels} labels and the note "${b40.drawn.more}", ${b40.drawn.instances} instances within the cap`,
    `40 × 64 drawing: ${JSON.stringify(b40.drawn)}`,
  );
  const b256 = js('__game.queueBench(256, 64, 60)');
  note(`queue overlay 256 × 64 (worst case): ${fmt(b256)}`);
  check(
    b256.drawn.instances <= b256.maxInstances && b256.drawn.labels <= 200 && b256.changing.updateMs.max < 100 && b256.still.updateMs.max < 100,
    `256 × 64: within the caps (${b256.drawn.instances} instances, ${b256.drawn.labels} labels), slowest update ${Math.max(b256.changing.updateMs.max, b256.still.updateMs.max).toFixed(1)} ms`,
    `256 × 64: ${JSON.stringify(b256)}`,
  );
  errorsNow('W25c queue overlay benchmark');
}

/** W26: the idle units column, in a fresh sandbox. */
/**
 * W28: hover a started, starved site with the real mouse. The panel's figures change once per
 * snapshot; they are sampled in the page on every snapshot for 8 s (game speed 3).
 */
async function checkHoverReadout(sites) {
  const rig = js('__game.camera.get()');
  const site = sites[0];
  js(`(__game.camera.set({ x: ${site.x}, z: ${site.z + 3}, distance: 22, yaw: 0, pitch: ${(55 * Math.PI) / 180} }), true)`);
  await frames(15);
  const p = js(`__game.screenOf('building', ${site.id})`);
  ab('mouse', 'move', String(Math.round(p.x) - 3), String(Math.round(p.y) - 3));
  ab('mouse', 'move', String(Math.round(p.x)), String(Math.round(p.y)));
  await frames(10);
  const first = js('__game.siteHover');
  check(
    first.visible && first.id === site.id && first.lines.some((l) => /^\d+% complete$/.test(l)) && first.lines.some((l) => / mass\/s$|^mass\/s: /.test(l)),
    `W28: hovering site ${site.id} shows the panel: ${first.lines.join(' | ')}`,
    `W28: hover panel over site ${site.id}: ${JSON.stringify(first)}`,
  );
  const panel = js(`(() => { const e = [...document.querySelectorAll('.site-hover')][0]; const r = e.getBoundingClientRect(); return { pe: getComputedStyle(e).pointerEvents, under: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.tagName ?? null }; })()`);
  check(panel.pe === 'none' && panel.under === 'CANVAS', 'W28: the panel takes no pointer events (the canvas is under its centre)', `W28: panel pointer events ${JSON.stringify(panel)}`);
  const samples = js(`new Promise((res) => {
    const out = [];
    let last = -1;
    const t0 = performance.now();
    const f = () => {
      const h = __game.siteHover;
      if (h.tick !== last) { last = h.tick; out.push({ tick: h.tick, visible: h.visible, id: h.id, mass: h.intake.mass ?? null, note: h.note, line: h.lines.find((l) => /mass/.test(l)) ?? null }); }
      if (performance.now() - t0 > 8000) res(out); else requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  })`);
  const income = js('__game.pool.income.mass');
  const shown = samples.filter((s) => s.visible && s.id === site.id && s.mass !== null);
  const masses = shown.map((s) => s.mass);
  const counts = {};
  for (const s of samples) counts[s.line ?? s.note] = (counts[s.line ?? s.note] ?? 0) + 1;
  note(`W28: ${samples.length} snapshots sampled at speed 3 (mass income ${income}/s): ${Object.entries(counts).map(([k, n]) => `${k} × ${n}`).join(', ')}`);
  check(
    shown.length >= samples.length - 2 && shown.length > 20 && masses.every((m) => m > 0 && m <= income + 1e-3),
    `W28: starved, the mass intake is shown on ${shown.length} of ${samples.length} snapshots, ${Math.min(...masses).toFixed(3)}–${Math.max(...masses).toFixed(3)} mass/s (> 0, ≤ the ${income} mass/s income); ${masses.filter((m) => m === 0).length} read 0`,
    `W28: mass intake over ${samples.length} snapshots: ${JSON.stringify(samples.slice(0, 12))}`,
  );
  const path = await screenshot({ ab, js, frames }, join(artShots, 'w28-hover-readout.png'), { settle: 2 });
  note(`screenshot ${path}`);
  // off the site: the nearest tile south of it that no building covers
  const off = js(`(() => {
    const bs = __game.list('building');
    const tx = Math.floor(${site.x});
    for (let tz = Math.floor(${site.z}) + 2; tz < Math.floor(${site.z}) + 10; tz++)
      if (!bs.some((b) => tx >= b.tx && tx < b.tx + b.fw && tz >= b.ty && tz < b.ty + b.fh)) return __game.worldToScreen(tx + 0.5, tz + 0.5);
    return null;
  })()`);
  ab('mouse', 'move', String(Math.round(off.x)), String(Math.round(off.y)));
  await frames(10);
  const after = js('__game.siteHover');
  check(!after.visible && after.id === -1, 'W28: moving off the site hides the panel', `W28: panel after moving off: ${JSON.stringify(after)}`);
  js(`(__game.camera.set(${JSON.stringify(rig)}), true)`);
}

/** W28: a started site whose builders were stopped reads 0 mass/s and 0 builders on the next snapshots. */
async function checkHoverStopped(id) {
  const rig = js('__game.camera.get()');
  const b = js(`__game.list('building').find((b) => b.id === ${id})`);
  js(`(__game.camera.set({ x: ${b.tx + 0.5}, z: ${b.ty + 3.5}, distance: 22, yaw: 0, pitch: ${(55 * Math.PI) / 180} }), true)`);
  await frames(15);
  const p = js(`__game.screenOf('building', ${id})`);
  ab('mouse', 'move', String(Math.round(p.x) - 3), String(Math.round(p.y) - 3));
  ab('mouse', 'move', String(Math.round(p.x)), String(Math.round(p.y)));
  await frames(20);
  const h = js('__game.siteHover');
  check(
    h.visible && h.id === id && h.intake.mass === 0 && h.lines.includes('0 mass/s') && h.lines.includes('0 builders'),
    `W28: after Stop, site ${id} reads ${h.lines.join(' | ')}`,
    `W28: hover panel over stopped site ${id}: ${JSON.stringify(h)}`,
  );
  // off the site again, the camera back where it was
  const off = js(`__game.worldToScreen(${b.tx + 0.5}, ${b.ty + 6.5})`);
  ab('mouse', 'move', String(Math.round(off.x)), String(Math.round(off.y)));
  js(`(__game.camera.set(${JSON.stringify(rig)}), true)`);
  await frames(3);
}

async function runW26() {
  const started = Date.now();
  ab('open', `${ORIGIN}/?sandbox=1`);
  ab('set', 'viewport', '1440', '900');
  await until('the sandbox ready', 'window.__game?.ready === true', 120);
  ab('errors', '--clear');
  ab('console', '--clear');
  await until('the idle column', `(() => { const c = __game.idleColumn; return c.find((b) => b.type === 'commander')?.count === 1 && c.find((b) => b.type === 'engineer')?.count === 2; })()`, 30).catch(() => null);
  const col = js('__game.idleColumn');
  const idle = js('__game.idle');
  check(
    col[0]?.type === 'commander' && col[0].shown && col[0].count === 1 && col[1]?.type === 'engineer' && col[1].shown && col[1].count === 2,
    'W26: the column shows commander × 1 then engineer × 2',
    `W26: the column shows ${JSON.stringify(col)} (idle ${JSON.stringify(idle)})`,
  );
  const button = (type) =>
    js(`(() => {
      const b = document.querySelector('.idle button[data-idle="${type}"]');
      if (!b || b.style.display === 'none') return null;
      const r = b.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit: !!hit && b.contains(hit) };
    })()`);
  const eb = button('engineer');
  if (!eb || !eb.hit) throw new Error(`W26: the engineer button is missing or covered: ${JSON.stringify(eb)}`);
  const mapState = () => JSON.stringify({ buildings: js('__game.list("building").length'), queue: js('__game.buildQueue.length'), runs: js('__game.runs.length'), orders: js('__game.queues.map((q) => q.orders.length)') });
  const rig0 = js('__game.camera.get()');
  const unitAt = (id) => js(`(() => { const u = __game.list('unit').find((u) => u.id === ${id}); return u ? { x: u.x, z: u.z } : null; })()`);
  await click(eb.x, eb.y);
  await frames(5);
  const s1 = js('__game.selected.map((s) => s.id)');
  const rig1 = js('__game.camera.get()');
  // map state the next clicks must not change, with the wall tool open (it needs a builder
  // selected, so after the first click; a click reaching the map would now place a wall)
  press('1');
  await frames(5);
  const before = mapState();
  const u1 = s1.length === 1 ? unitAt(s1[0]) : null;
  check(
    s1.length === 1 && idle.engineer.includes(s1[0]) && u1 && Math.hypot(rig1.x - u1.x, rig1.z - u1.z) < 0.6 && rig1.distance === rig0.distance && rig1.pitch === rig0.pitch,
    `W26: a click selects engineer ${s1[0]} and centres the camera on it (target ${rig1.x.toFixed(1)}, ${rig1.z.toFixed(1)}; distance and tilt kept)`,
    `W26: first click: selected ${JSON.stringify(s1)}, camera ${JSON.stringify(rig0)} → ${JSON.stringify(rig1)}, unit at ${JSON.stringify(u1)}`,
  );
  await click(eb.x, eb.y);
  await frames(5);
  const s2 = js('__game.selected.map((s) => s.id)');
  const rig2 = js('__game.camera.get()');
  const u2 = s2.length === 1 ? unitAt(s2[0]) : null;
  check(
    s2.length === 1 && idle.engineer.includes(s2[0]) && s2[0] !== s1[0] && u2 && Math.hypot(rig2.x - u2.x, rig2.z - u2.z) < 0.6,
    `W26: a second click selects the other engineer (${s2[0]}) and centres on it`,
    `W26: second click: selected ${JSON.stringify(s2)} after ${JSON.stringify(s1)}, camera ${JSON.stringify(rig2)}, unit at ${JSON.stringify(u2)}`,
  );
  shiftDown();
  await click(eb.x, eb.y);
  shiftUp();
  await frames(5);
  const s3 = js('__game.selected.map((s) => s.id)').sort((a, b) => a - b);
  check(JSON.stringify(s3) === JSON.stringify([...idle.engineer].sort((a, b) => a - b)), `W26: Shift + click selects both idle engineers (${s3.join(', ')})`, `W26: Shift + click selected ${JSON.stringify(s3)}, idle ${JSON.stringify(idle.engineer)}`);
  const after = mapState();
  check(after === before && js('__game.buildMode') === 'wall', 'W26: clicks on the column change no map state (wall tool open: nothing placed, nothing ordered)', `W26: map state ${before} → ${after}, build mode ${js('__game.buildMode')}`);
  press('Escape');
  await frames(3);
  // the screenshot (the column on screen, the game running)
  const shotPath = await screenshot({ ab, js, frames }, join(artShots, 'w26-idle-column.png'), { settle: 1 });
  note(`screenshot ${shotPath}`);
  // one engineer gets an order: the count drops on the next snapshot
  const busy = idle.engineer[0];
  const order = js(`__game.buildRun([60, 70], [63, 70], 1, { ids: [${busy}] })`);
  await until('the engineer count to drop', `__game.idleColumn.find((b) => b.type === 'engineer')?.count === 1`, 10).catch(() => null);
  const col2 = js('__game.idleColumn');
  check(
    order.ok && col2.find((b) => b.type === 'engineer')?.count === 1 && !js('__game.idle').engineer.includes(busy),
    `W26: engineer ${busy} given a build order leaves the column (engineer × 1)`,
    `W26: after the order ${JSON.stringify(order)}: column ${JSON.stringify(col2)}`,
  );
  check(existsSync(shotPath) && statSync(shotPath).size > 0 && statSync(shotPath).mtimeMs >= started, `W26: ${shotPath} written`, `W26: screenshot ${shotPath} not written`);
  errorsNow('W26 idle column');
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
    await runW26();
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
