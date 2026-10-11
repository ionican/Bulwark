#!/usr/bin/env node
// Browser check for W24 run 3: the sandbox panel, the one active map tool, the carried picking and
// order fixes (C1, C2) and the overlay depth test (D1), with real input only.
//
//   node scripts/check-panel.mjs [--shots <dir>] [--no-build]
//
// Builds this tree (or --no-build) and serves it with `vite preview` on strict port 8825, then
// drives agent-browser (session `w3panel`, 1440 × 900) with real mouse clicks, drags and wheel
// (CDP) and real keys (Shift by keydown/keyup: agent-browser's mouse events carry no modifiers;
// main.ts reads Shift from the keyboard as well). `__game` is read only, to check results. Two
// exceptions, both view settings that change no game state: the camera pose (`__game.camera.set`,
// so the fixtures are framed the same on every run) and the D1 diagnostic rendering controls
// (`__game.debugRender.*`: hide one overlay, turn the overlays' depth test off, read pixels).
//
//   1  the panel is shown in the sandbox and absent at / (map 1); the DEBUG spawn box is hidden in
//      the sandbox and shown on map 1; `?greybox=1` loads the models view (renderMode 'models')
//   2  each tab opens by a click and carries "▸"; collapse and expand
//   3  Economy: free spending turned ON by a click → __game.unlimited
//   4  fixture: a clear, flat, rock-free 11 × 9 rectangle at least 12 tiles from the base and every
//      entry (printed); the gun turret placed at its centre by the build bar; depth 1 chosen; the
//      four sides laid by four Shift-held drags with two engineers standing outside; at speed 3
//      every wall tile of the four sides complete
//   5  gate: the gate tool armed by its button, a Shift-held click on the side facing the spawn
//      point → a gate order; still armed, Escape → select (button text idle, tool select); the
//      gate completes
//   6  spawn: rusher, count 8 typed, Place, a click 10 tiles outside the gate side → 8 rushers
//      within 6 tiles of it; within 60 s at speed 3 rushers removed hit points from walls and gates
//      and the gun turret killed; paused, the Stats rows for the gun turret and the rusher equal
//      __game.stats() at the panel's recorded tick
//   7  tune: the gun turret's damage slider dragged by the mouse to 2× → __game.tuning 2 (± one
//      step) and the effective damage label doubles; Space straight after the drag pauses the game
//      once (Codex review 2: the slider gives keyboard focus back); Reset kind → 1
//   8  isolation: a click, a drag and a wheel over the panel change nothing (selection, queues,
//      camera, refusals, commands sent); a wall drag started on the map and released over the panel
//      creates nothing and leaves no preview
//   9  focus: count field focused with spawn armed, Escape disarms; Space just after a panel button
//      click pauses once and does not press the button again
//   10 C1: an engineer straight behind the turret: a click on the turret's centre and one on the
//      hidden engineer select the turret; a half-hidden engineer's visible part selects it; an
//      engineer behind a reserved site and one behind the gate's corridor are selectable
//   11 C2: the commander's reserved turret site; an unshifted build-bar click on exactly that site
//      is accepted (same building id, queue length 1)
//   12 D1: an upgrade frame (a heavy turret being upgraded) and a reserved outline (a heavy turret
//      site), each partly behind a gun turret: the overlay's own pixel contribution (the frame
//      drawn with and without it) is zero inside the occluding turret and non-zero on its
//      unobstructed part; with the overlays' depth test off it is non-zero inside (the negative)
//   13 paint a row (Richard, 10 Oct): the energy generator from the build bar, one real mouse
//      drag over 8 tiles of clear ground: before release the preview shows 4 placed positions
//      (solid outlines) and its label; after release 4 generator sites stand edge to edge and the
//      engineers build them
//   14 screenshots: w24r3-panel-build.png, -spawn.png, -tune.png, -economy.png, -stats.png,
//      w24r3-overlays-occluded.png, w24r3-paint-row.png (to --shots <dir>, else the vault's
//      Bulwark Art Reference)
// 0 console errors throughout. It always stops its server and closes only its own session.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ART_REF, screenshot } from './shots.mjs';

const GAME = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8825;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = 'w3panel';
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const shotsDir = arg('--shots') ?? ART_REF;

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

// ---- real input ------------------------------------------------------------------------------

const R = (v) => String(Math.round(v));
async function click(x, y, button = 'left') {
  ab('mouse', 'move', R(x), R(y));
  ab('mouse', 'down', button);
  ab('mouse', 'up', button);
  await frames(3);
}
/** A press-move-release from a to b in `steps` moves. */
async function drag(a, b, steps = 8, button = 'left') {
  ab('mouse', 'move', R(a.x), R(a.y));
  ab('mouse', 'down', button);
  for (let k = 1; k <= steps; k++) ab('mouse', 'move', R(a.x + ((b.x - a.x) * k) / steps), R(a.y + ((b.y - a.y) * k) / steps));
  await frames(2);
  ab('mouse', 'up', button);
  await frames(3);
}
/**
 * A real wheel event at (x, y). agent-browser 0.37.1's `mouse wheel` dispatches at (0, 0) whatever
 * the mouse position (probed 2026-10-10), so this sends the same CDP input event itself, to this
 * session's page, at the point given.
 */
async function wheelAt(x, y, dy) {
  const ws = new WebSocket(ab('get', 'cdp-url').cdpUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP connection failed'));
  });
  let next = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const id = ++next;
      pending.set(id, (d) => (d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result)));
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  try {
    const { targetInfos } = await call('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(ORIGIN));
    if (!page) throw new Error('no page of this origin to send the wheel to');
    const { sessionId } = await call('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: dy }, sessionId);
    await call('Target.detachFromTarget', { sessionId });
  } finally {
    ws.close();
  }
}
const shiftDown = () => ab('keydown', 'Shift');
const shiftUp = () => ab('keyup', 'Shift');
/** A key press with whatever has focus (keydown then keyup). */
function key(k) {
  ab('keydown', k);
  ab('keyup', k);
}
/** A key press with nothing focused. */
function press(k) {
  js('(document.activeElement && document.activeElement !== document.body && document.activeElement.blur(), true)');
  key(k);
}
/** Centre of the first element matching `sel`, checked to be the element actually under that point. */
function centreOf(sel) {
  const r = js(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) return { hidden: true };
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, ok: !!top && (top === e || e.contains(top)), top: top ? top.tagName + '.' + top.className : null };
  })()`);
  if (!r) throw new Error(`no element ${sel}`);
  if (r.hidden) throw new Error(`element ${sel} is not laid out (hidden)`);
  if (!r.ok) throw new Error(`element ${sel} is covered by ${r.top}`);
  return r;
}
async function clickEl(sel) {
  const p = centreOf(sel);
  await click(p.x, p.y);
  return p;
}
const text = (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const toScreen = (x, z) => js(`__game.worldToScreen(${x}, ${z})`);
const toScreenY = (x, y, z) => js(`__game.worldToScreen(${x}, ${z}, ${y})`);
async function clickTile(x, z) {
  const p = toScreen(x, z);
  await click(p.x, p.y);
}
const panel = () => js('__game.sandboxPanel');
const tool = () => js('__game.tool');
const camera = (rig) => js(`(__game.camera.set(${JSON.stringify(rig)}), true)`);
const buildings = () => js(`__game.list('building')`);
const units = () => js(`__game.list('unit')`);
const queueOf = (id) => js(`(__game.queues.find((q) => q.id === ${id})?.orders ?? [])`);

async function pause(on) {
  if (js('__game.paused') !== on) {
    press(' ');
    await until(on ? 'paused' : 'running', `__game.paused === ${on}`, 10);
  }
}
async function speed(n) {
  js('(document.activeElement && document.activeElement !== document.body && document.activeElement.blur(), true)');
  shiftDown();
  key(String(n));
  shiftUp();
  await until(`speed ${n}`, `__game.speed === ${n}`, 10);
}
async function tab(name) {
  await clickEl(`.sbx button[data-tab="${name}"]`);
  await until(`tab ${name}`, `__game.sandboxPanel.tab === ${JSON.stringify(name)}`, 5);
  await frames(15); // the panel redraws at most 4 times a second
}

/** Selects unit `id` by a real click near its screen point (Shift: added). */
async function selectUnit(id, add = false) {
  const tryClicks = async () => {
    for (const [ox, oy] of [[0, -4], [0, 0], [2, -8], [-2, -2]]) {
      const p = js(`__game.screenOf('unit', ${id})`);
      if (add) shiftDown();
      await click(p.x + ox, p.y + oy);
      if (add) shiftUp();
      // units only: since W29 the core is building 0, so building and unit ids overlap from the start
      const sel = js(`__game.selected.filter((s) => s.type === 'unit').map((s) => s.id)`);
      if (sel.includes(id)) return sel;
    }
    return null;
  };
  const sel = await tryClicks();
  if (sel) return sel;
  // hidden from this camera (C1: a building in front takes the click): look straight down on it, then back
  const rig = js('__game.camera.get()');
  const u = units().find((x) => x.id === id);
  if (u) {
    camera({ x: u.x, z: u.z, distance: 18, yaw: rig.yaw, pitch: (80 * Math.PI) / 180 });
    await frames(5);
    const again = await tryClicks();
    camera(rig);
    await frames(5);
    if (again) return again;
  }
  throw new Error(`could not select unit ${id} by clicking it`);
}

function errorsNow(label) {
  const page = ab('errors').errors ?? [];
  const c = ab('console');
  const consoleErrs = (c.messages ?? c.logs ?? []).filter((m) => (m.type ?? m.level) === 'error');
  const game = js('__game.errors');
  check(!page.length && !consoleErrs.length && !game, `${label}: 0 console errors`, `${label}: ${page.length} page errors, ${consoleErrs.length} console errors, __game.errors ${game}: ${JSON.stringify([...page, ...consoleErrs]).slice(0, 600)}`);
}

async function shot(name) {
  const path = await screenshot({ ab, js, frames }, join(shotsDir, name), { settle: 6 });
  check(existsSync(path) && statSync(path).size > 0, `screenshot ${path}`, `screenshot ${path} not written`);
  return path;
}

async function load(path) {
  ab('open', `${ORIGIN}${path}`);
  ab('set', 'viewport', '1440', '900');
  await until(`${path} ready`, 'window.__game?.ready === true', 120);
  await frames(10);
}

// ---- 1: shown in the sandbox only; the greybox switch is gone --------------------------------

async function visibility() {
  await load('/');
  const m1 = js(`({ shown: __game.sandboxPanel.shown, el: !!document.querySelector('.sbx') && getComputedStyle(document.querySelector('.sbx')).display !== 'none', dbg: getComputedStyle(document.querySelector('.dbg')).display !== 'none', scenario: __game.scenario })`);
  check(m1.scenario === 'map1' && !m1.shown && !m1.el && m1.dbg, 'map 1 (/): no sandbox panel; the DEBUG spawn box is shown', `map 1: ${JSON.stringify(m1)}`);
  await load('/?greybox=1');
  const g = js(`({ mode: __game.renderMode, models: !!__game.inspect && Object.values(__game.inspect() ?? {}).some((e) => e.models > 0) })`);
  check(g.mode === 'models' && g.models, '?greybox=1 loads the models view (renderMode models)', `?greybox=1: ${JSON.stringify(g)}`);
  await load('/?sandbox=1');
  ab('errors', '--clear');
  ab('console', '--clear');
  const sb = js(`({ shown: __game.sandboxPanel.shown, el: getComputedStyle(document.querySelector('.sbx')).display !== 'none', dbg: getComputedStyle(document.querySelector('.dbg')).display !== 'none', scenario: __game.scenario })`);
  check(sb.scenario === 'sandbox' && sb.shown && sb.el && !sb.dbg, 'sandbox: the panel is shown; the DEBUG spawn box is hidden', `sandbox: ${JSON.stringify(sb)}`);
  // on the left, under the time controls
  const where = js(`(() => { const p = document.querySelector('.sbx').getBoundingClientRect(); const t = document.querySelector('.timec').getBoundingClientRect(); return { left: p.left, top: p.top, timeBottom: t.bottom }; })()`);
  check(where.left < 20 && where.top >= where.timeBottom, `the panel is on the left under the time controls (${JSON.stringify(where)})`, `panel position ${JSON.stringify(where)}`);
}

// ---- 2: tabs and collapse ----------------------------------------------------------------------

async function tabs() {
  for (const t of ['spawn', 'tune', 'economy', 'stats', 'build']) {
    await tab(t);
    const marks = js(`[...document.querySelectorAll('.sbx button[data-tab]')].map((b) => [b.dataset.tab, b.textContent.trim().startsWith('▸'), getComputedStyle(b).outlineStyle !== 'none' && getComputedStyle(b).outlineStyle !== ''])`);
    const ok = marks.every(([k, arrow, outline]) => (k === t) === arrow && (k === t) === outline);
    check(ok, `tab ${t} opens by a click and alone carries "▸" and an outline`, `tab ${t}: ${JSON.stringify(marks)}`);
  }
  await clickEl('.sbx button[data-sbx="collapse"]');
  await frames(5);
  const c = js(`({ collapsed: __game.sandboxPanel.collapsed, body: getComputedStyle(document.querySelector('.sbx [data-sbx="body"]')).display, label: document.querySelector('.sbx button[data-sbx="collapse"]').textContent.trim(), tabs: getComputedStyle(document.querySelector('.sbx button[data-tab]')).display })`);
  check(c.collapsed && c.body === 'none' && c.label === '+' && c.tabs !== 'none', 'collapse shrinks the panel to its tab row ("+")', `collapsed: ${JSON.stringify(c)}`);
  await clickEl('.sbx button[data-sbx="collapse"]');
  await frames(5);
  const e = js(`({ collapsed: __game.sandboxPanel.collapsed, body: getComputedStyle(document.querySelector('.sbx [data-sbx="body"]')).display, label: document.querySelector('.sbx button[data-sbx="collapse"]').textContent.trim() })`);
  check(!e.collapsed && e.body !== 'none' && e.label === '–', 'expand shows the body again ("–")', `expanded: ${JSON.stringify(e)}`);
}

// ---- 3: free spending ----------------------------------------------------------------------------

async function economy() {
  await tab('economy');
  await clickEl('.sbx button[data-sbx="unlimited"]');
  await until('free spending on', '__game.unlimited === true', 10);
  await frames(15);
  check(/ON/.test(text('.sbx button[data-sbx="unlimited"]')), `free spending turned ON by a click ("${text('.sbx button[data-sbx="unlimited"]')}")`, `free spending button: ${text('.sbx button[data-sbx="unlimited"]')}`);
  // research for the turret upgrade in the D1 fixture
  await clickEl('.sbx button[data-sbx="grant-all"]');
  await until('research granted', `__game.research.done.includes('gunT2')`, 10);
  await shot('w24r3-panel-economy.png');
}

// ---- 4: the enclosure fixture ------------------------------------------------------------------

/**
 * A clear, flat, rock-free 11 × 9 rectangle ≥ 12 tiles from the base and every entry, with a free
 * ring round it, the 12 tiles north of it (the spawn side) and the 16 tiles south of it (the C2 site
 * and the D1 turrets) clear ground too.
 */
function pickRectangle() {
  return js(`(() => {
    const t = __game.terrainInfo;
    const bs = __game.list('building');
    const used = new Set();
    for (const b of bs) for (let j = 0; j < b.fh; j++) for (let i = 0; i < b.fw; i++) used.add((b.ty + j) * t.w + b.tx + i);
    const far = (x, z) => Math.hypot(x - t.base.x, z - t.base.z) >= 12 && t.entries.every((e) => Math.hypot(x - e.x, z - e.z) >= 12);
    // the rectangle, a ring of 3 round it, 12 tiles north of it (the spawn side) and 16 south clear
    for (let r = 14; r < 40; r++)
      for (let a = 0; a < 32; a++) {
        const x0 = Math.round(t.base.x + r * Math.cos((a / 32) * 2 * Math.PI)) - 5;
        const z0 = Math.round(t.base.z + r * Math.sin((a / 32) * 2 * Math.PI)) - 4;
        let ok = true;
        let lo = Infinity, hi = -Infinity;
        for (let z = z0 - 13; z <= z0 + 24 && ok; z++)
          for (let x = x0 - 3; x <= x0 + 13 && ok; x++) {
            if (x < 1 || z < 1 || x >= t.w - 1 || z >= t.h - 1) { ok = false; break; }
            if (__game.tileInfo(x, z).type !== 'ground' || used.has(z * t.w + x)) ok = false;
            const inside = x >= x0 && x <= x0 + 10 && z >= z0 && z <= z0 + 8;
            if (inside) { const h = __game.tileInfo(x, z).height; lo = Math.min(lo, h); hi = Math.max(hi, h); if (!far(x + 0.5, z + 0.5)) ok = false; }
          }
        if (ok && hi - lo < 0.6) return { x0, z0, flat: hi - lo };
      }
    return null;
  })()`);
}

async function fixture() {
  const rect = pickRectangle();
  if (!rect) throw new Error('no clear 11 × 9 rectangle found');
  const { x0, z0 } = rect;
  note(`fixture rectangle: tiles x ${x0}–${x0 + 10}, z ${z0}–${z0 + 8} (height range ${rect.flat.toFixed(2)}); gate side north (z ${z0}), spawn at ${x0 + 5}, ${z0 - 10}`);
  camera({ x: x0 + 5.5, z: z0 + 5, distance: 34, yaw: 0, pitch: (62 * Math.PI) / 180 });
  await frames(10);
  const engs = units().filter((u) => u.kindName === 'engineer').map((u) => u.id);
  if (engs.length < 2) throw new Error(`the sandbox has ${engs.length} engineers`);
  const [e1, e2] = engs;
  await selectUnit(e1);
  await selectUnit(e2, true);
  // the two engineers to just south of the rectangle (outside it)
  await click(...Object.values(toScreen(x0 + 5.5, z0 + 11.5)), 'right');
  await until('engineers outside the rectangle', `[${e1}, ${e2}].every((id) => { const u = __game.list('unit').find((u) => u.id === id); return u && u.z > ${z0 + 9}; })`, 60);
  // the gun turret at the centre, by the build bar
  await clickEl('.bar button[data-kind="gun"]');
  check(tool().name === 'build', 'the build bar picks the gun turret (tool build)', `tool after the gun button: ${JSON.stringify(tool())}`);
  const gx = x0 + 4;
  const gz = z0 + 3;
  await clickTile(gx + 1, gz + 1);
  await until('the gun site', `__game.list('building').some((b) => b.kindName === 'gun' && b.tx === ${gx} && b.ty === ${gz})`, 10);
  const gun = buildings().find((b) => b.kindName === 'gun' && b.tx === gx && b.ty === gz).id;
  // depth 1, then the four sides by four Shift-held drags
  await tab('build');
  await clickEl('.sbx button[data-depth="1"]');
  check(panel().depth === 1 && text('.sbx button[data-depth="1"]').includes('▸'), 'depth 1 chosen (marked "▸")', `depth: ${JSON.stringify(panel())}`);
  press('1');
  await frames(3);
  check(tool().name === 'wall', 'key 1 picks the wall drag tool', `tool: ${JSON.stringify(tool())}`);
  const tileC = (x, z) => toScreen(x + 0.5, z + 0.5);
  const sides = [
    [[x0, z0], [x0 + 10, z0]],
    [[x0, z0 + 8], [x0 + 10, z0 + 8]],
    [[x0, z0 + 1], [x0, z0 + 7]],
    [[x0 + 10, z0 + 1], [x0 + 10, z0 + 7]],
  ];
  shiftDown();
  for (const [a, b] of sides) await drag(tileC(...a), tileC(...b), 10);
  const held = tool().name;
  shiftUp();
  await frames(3);
  check(held === 'wall' && tool().name === 'select', 'the wall tool stays while Shift is held and closes when it is released', `tool while held ${held}, after ${tool().name}`);
  const tiles = [];
  for (let x = x0; x <= x0 + 10; x++) tiles.push([x, z0], [x, z0 + 8]);
  for (let z = z0 + 1; z <= z0 + 7; z++) tiles.push([x0, z], [x0 + 10, z]);
  await until('36 wall sites laid', `${JSON.stringify(tiles)}.every(([x, z]) => __game.list('building').some((b) => b.kindName === 'wall' && b.tx === x && b.ty === z))`, 20);
  note(`four Shift-held drags laid ${tiles.length} wall sites; queues ${JSON.stringify([queueOf(e1).length, queueOf(e2).length])}`);
  await speed(3);
  await until('the turret and every wall tile complete', `__game.list('building').some((b) => b.id === ${gun} && b.complete) && ${JSON.stringify(tiles)}.every(([x, z]) => __game.list('building').some((b) => b.kindName === 'wall' && b.tx === x && b.ty === z && b.complete && b.progress === 1))`, 300);
  check(true, `the turret and all 36 wall tiles of the four sides are complete (no gaps)`, '');
  await shot('w24r3-panel-build.png');
  return { x0, z0, gun, e1, e2, gx, gz };
}

// ---- 5: gate --------------------------------------------------------------------------------------

async function gate(f) {
  await tab('build');
  await clickEl('.sbx button[data-sbx="gate"]');
  const armed = { tool: tool(), button: text('.sbx button[data-sbx="gate"]'), line: text('.sbx [data-sbx="tool"]') };
  check(armed.tool.name === 'gate' && /armed/i.test(armed.button) && /Tool: gate/.test(armed.line), `the gate tool is armed by its button ("${armed.button}"; "${armed.line}")`, `gate armed: ${JSON.stringify(armed)}`);
  shiftDown();
  await clickTile(f.x0 + 5.5, f.z0 + 0.5);
  await until('a gate site', `__game.list('building').some((b) => b.kindName === 'gate')`, 10);
  const still = tool().name;
  press('Escape');
  await frames(3);
  shiftUp();
  const after = { tool: tool(), button: text('.sbx button[data-sbx="gate"]') };
  check(still === 'gate' && after.tool.name === 'select' && !/armed/i.test(after.button), 'a Shift-held click ordered the gate; still armed, Escape returned to select (button idle)', `gate: still ${still}, after Escape ${JSON.stringify(after)}`);
  await until('the gate complete', `__game.list('building').some((b) => b.kindName === 'gate' && b.complete && b.progress === 1)`, 240);
  const g = buildings().find((b) => b.kindName === 'gate');
  check(g.ty === f.z0 && g.fw === 3 && g.tx === f.x0 + 4, `the gate is complete on the north side (${g.tx},${g.ty} ${g.fw} × ${g.fh})`, `gate ${JSON.stringify(g)}`);
  return g;
}

// ---- 6: spawn and stats -------------------------------------------------------------------------

async function spawnAndStats(f) {
  await tab('spawn');
  await clickEl('.sbx button[data-spawn-kind="rusher"]');
  // count 8, typed into the field
  const field = centreOf('.sbx input[data-sbx="count"]');
  await click(field.x, field.y);
  for (let i = 0; i < 3; i++) key('Backspace');
  key('Delete');
  key('8');
  key('Tab');
  await frames(10);
  check(panel().count === 8, `count 8 typed (${panel().count})`, `count after typing 8: ${panel().count}`);
  await clickEl('.sbx button[data-sbx="place"]');
  check(tool().name === 'spawn' && /Tool: spawn rusher × 8/.test(text('.sbx [data-sbx="tool"]')), `Place arms the spawn tool ("${text('.sbx [data-sbx="tool"]')}")`, `spawn armed: ${JSON.stringify(tool())}`);
  const sx = f.x0 + 5.5;
  const sz = f.z0 - 9.5;
  const before = js('__game.alienCounts.rusher');
  await clickTile(sx, sz);
  await until('8 rushers', `__game.alienCounts.rusher >= ${before + 8}`, 10);
  const near = js(`__game.list('alien').filter((a) => a.kindName === 'rusher' && Math.hypot(a.x - ${sx}, a.z - ${sz}) <= 6).length`);
  check(near >= 8 && tool().name === 'select', `8 rushers spawned within 6 tiles of the clicked tile (${near}); the tool returned to select`, `rushers near the click: ${near}, tool ${tool().name}`);
  await shot('w24r3-panel-spawn.png');
  await until('rushers hit the walls or gate and the gun turret killed', `(() => { const s = __game.stats(); return s.aliens.rusher.hpFromWalls > 0 && s.shooters.gun.kills > 0; })()`, 60);
  check(true, 'rushers removed hit points from the walls and gate, and the gun turret killed', '');
  await pause(true);
  await tab('stats');
  await sleep(600);
  const st = js(`(() => {
    const p = __game.sandboxPanel;
    const s = __game.stats();
    const row = (sel) => [...document.querySelectorAll(sel + ' td')].slice(1).map((td) => td.textContent.trim());
    return { tick: p.tick, now: __game.tick, gun: row('.sbx table[data-sbx="shooters"] tr[data-row="gun"]'), rusher: row('.sbx table[data-sbx="aliens"] tr[data-row="rusher"]'), s: { gun: s.shooters.gun, rusher: s.aliens.rusher } };
  })()`);
  const fmt = (v) => (v === 0 ? '–' : Math.round(v).toLocaleString('en-GB'));
  const wantGun = [st.s.gun.shots, st.s.gun.hpRemoved, st.s.gun.kills].map(fmt);
  const r = st.s.rusher;
  const wantRusher = [r.spawned, r.killed, r.hpFromWalls, r.hpFromBuildings, r.hpFromUnits].map(fmt);
  check(
    st.tick === st.now && JSON.stringify(st.gun) === JSON.stringify(wantGun) && JSON.stringify(st.rusher) === JSON.stringify(wantRusher),
    `paused, the Stats rows equal __game.stats() at the panel's tick ${st.tick}: gun ${st.gun.join(' ')}, rusher ${st.rusher.join(' ')}`,
    `stats rows: ${JSON.stringify(st)}`,
  );
  await shot('w24r3-panel-stats.png');
  await pause(false);
}

// ---- 7: tune -----------------------------------------------------------------------------------------

async function tune() {
  await tab('tune');
  await clickEl('.sbx button[data-tune-target="building"]');
  await frames(10);
  const kind = js(`document.querySelector('.sbx select[data-sbx="tune-kind"]').value`);
  if (kind !== 'gun') ab('select', '.sbx select[data-sbx="tune-kind"]', 'gun');
  await frames(10);
  const val = () => Number(js(`document.querySelector('.sbx [data-tune-field="damage"] .val').dataset.value`));
  const before = val();
  const slider = js(`(() => { const e = document.querySelector('.sbx [data-tune-field="damage"] input[type=range]'); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2, w: r.width, pos: Number(e.value) / Number(e.max), target: __game.sandboxPanel.sliderFor(2) }; })()`);
  // Chrome's range thumb is 16 px wide: its centre runs from 8 px to width − 8 px
  const at = (p) => ({ x: slider.x + 8 + p * (slider.w - 16), y: slider.y });
  await drag(at(slider.pos), at(slider.target), 12);
  await until('the damage multiplier applied', `__game.tuning.some((t) => t.target === 'building' && t.kind === 'gun' && t.field === 'damage')`, 10);
  await frames(15);
  const m = js(`__game.tuning.find((t) => t.target === 'building' && t.kind === 'gun' && t.field === 'damage').mult`);
  const after = val();
  check(Math.abs(m - 2) <= 0.1 + 1e-9, `the damage slider dragged to 2× sets ${m}× (± one step)`, `damage multiplier after the drag: ${m}`);
  check(Math.abs(after / before - m) < 1e-6 * m && Math.abs(after - 2 * before) <= 0.1 * before + 1e-9, `the effective damage label doubles: ${before} → ${after} per shot`, `effective damage ${before} → ${after} (mult ${m})`);
  // Codex review 2: the drag leaves no keyboard focus on the slider, so Space at once (no blur, no
  // map click first) pauses the game, once
  const focus0 = js(`document.activeElement?.tagName ?? null`);
  const paused0 = js('__game.paused');
  key(' ');
  await frames(10);
  const paused1 = js('__game.paused');
  check(paused1 === !paused0, `Space straight after the slider drag pauses the game once (focus after the drag: ${focus0})`, `paused ${paused0} → ${paused1}; focus after the drag ${focus0}`);
  await pause(paused0);
  await shot('w24r3-panel-tune.png');
  await clickEl('.sbx button[data-sbx="tune-reset-kind"]');
  await until('the gun turret reset', `!__game.tuning.some((t) => t.kind === 'gun')`, 10);
  check(true, 'Reset kind sets the gun turret back to 1×', '');
}

// ---- 8: input isolation --------------------------------------------------------------------------

const worldState = () =>
  js(`JSON.stringify({ sel: __game.selected.map((s) => s.id), q: __game.queues.map((q) => [q.id, q.orders.map((o) => o.oid)]), cam: __game.camera.get(), rej: __game.rejected.length, sent: __game.commandsSent, b: __game.list('building').length })`);

async function isolation(f) {
  await tab('economy');
  await selectUnit(f.e1);
  const box = js(`(() => { const r = document.querySelector('.sbx').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const mid = { x: box.x + box.w / 2, y: box.y + box.h - 20 };
  // first, the same wheel over the map zooms: the event reaches the page where it is sent
  const probe = { x: box.x + box.w + 200, y: mid.y };
  const d0 = js('__game.camera.get().distance');
  await wheelAt(probe.x, probe.y, 200);
  await frames(5);
  const d1 = js('__game.camera.get().distance');
  check(d1 > d0, `a wheel sent over the map zooms (distance ${d0.toFixed(1)} → ${d1.toFixed(1)}), so the wheel over the panel below is a real test`, `the wheel over the map did not zoom (${d0} → ${d1})`);
  await frames(10);
  const base = worldState();
  // a click on the panel's own background, a drag across it, a wheel over it
  const bg = js(`(() => { const e = document.elementFromPoint(${mid.x}, ${mid.y}); return e ? e.tagName + '.' + e.className : null; })()`);
  await click(mid.x, mid.y);
  await drag(mid, { x: mid.x - 60, y: mid.y - 120 }, 6);
  ab('mouse', 'move', R(mid.x), R(mid.y));
  await wheelAt(mid.x, mid.y, 400);
  await wheelAt(mid.x, mid.y, -200);
  await frames(20);
  const after = worldState();
  check(after === base, `a click, a drag and a wheel over the panel (on ${bg}) change nothing on the map`, `isolation: before ${base} after ${after}`);
  // a wall drag started on the map, released over the panel: nothing laid, no preview left
  press('1');
  await frames(3);
  const start = toScreen(f.x0 + 5.5, f.z0 + 15.5);
  const before2 = worldState();
  await drag(start, { x: box.x + box.w / 2, y: box.y + box.h / 2 }, 12);
  await frames(10);
  const after2 = worldState();
  const preview = js('__game.dragPreview');
  check(after2 === before2 && preview === null, 'a wall drag from the map released over the panel creates nothing and leaves no preview', `map-to-panel drag: before ${before2} after ${after2}, preview ${JSON.stringify(preview)}`);
  press('Escape');
  await frames(3);
}

// ---- 9: focus ------------------------------------------------------------------------------------

async function focus() {
  await tab('spawn');
  await clickEl('.sbx button[data-sbx="place"]');
  const field = centreOf('.sbx input[data-sbx="count"]');
  await click(field.x, field.y);
  const focused = js(`document.activeElement?.dataset?.sbx ?? null`);
  key('Escape');
  await frames(3);
  check(focused === 'count' && tool().name === 'select', 'with the count field focused and spawn armed, Escape disarms', `focus ${focused}, tool ${tool().name}`);
  // a panel button clicked, then Space: the game pauses once, the button is not pressed again
  const routes0 = panel().routes;
  const paused0 = js('__game.paused');
  await clickEl('.sbx button[data-sbx="routes"]');
  const routes1 = panel().routes;
  key(' ');
  await frames(10);
  const paused1 = js('__game.paused');
  const routes2 = panel().routes;
  check(routes1 === !routes0 && routes2 === routes1 && paused1 === !paused0, 'Space just after a panel button click pauses once and does not press the button', `routes ${routes0} → ${routes1} → ${routes2}; paused ${paused0} → ${paused1}`);
  if (routes2) await clickEl('.sbx button[data-sbx="routes"]');
  await pause(false);
}

// ---- 10: C1 picking -----------------------------------------------------------------------------

async function moveUnitTo(id, x, z) {
  await selectUnit(id);
  const p = toScreen(x, z);
  await click(p.x, p.y, 'right');
  await until(`unit ${id} at ${x}, ${z}`, `(() => { const u = __game.list('unit').find((u) => u.id === ${id}); return u && Math.hypot(u.x - ${x}, u.z - ${z}) < 0.35 && !__game.queues.find((q) => q.id === ${id})?.orders.length; })()`, 60)
}

async function picking(f, gateB) {
  const cx = f.gx + 1;
  const cz = f.gz + 1;
  // the engineers: one straight behind the turret (from a camera to its south), one half beside it
  camera({ x: cx, z: cz + 4, distance: 16, yaw: 0, pitch: (35 * Math.PI) / 180 });
  await frames(10);
  await moveUnitTo(f.e1, cx, cz - 2.1);
  await moveUnitTo(f.e2, cx + 1.45, cz - 2.1);
  await frames(10);
  const top = js(`__game.terrainInfo.footprintTop(${f.gx}, ${f.gz}, 2, 2)`);
  const centre = toScreenY(cx, top + 1, cz);
  await click(centre.x, centre.y);
  const s1 = js('__game.selected.map((s) => s.type + ":" + s.id)');
  const e1 = toScreenY(cx, js(`__game.terrainInfo.height(${cx}, ${cz - 2.1})`) + 0.5, cz - 2.1);
  await click(e1.x, e1.y);
  const s2 = js('__game.selected.map((s) => s.type + ":" + s.id)');
  const e2 = toScreenY(cx + 1.85, js(`__game.terrainInfo.height(${cx + 1.45}, ${cz - 2.1})`) + 0.5, cz - 2.1);
  await click(e2.x, e2.y);
  const s3 = js('__game.selected.map((s) => s.type + ":" + s.id)');
  check(JSON.stringify(s1) === `["building:${f.gun}"]`, 'a click on the turret centre selects the turret', `turret centre click selected ${JSON.stringify(s1)}`);
  check(JSON.stringify(s2) === `["building:${f.gun}"]`, 'a click on the engineer hidden straight behind it selects the turret (its volume comes first)', `hidden engineer click selected ${JSON.stringify(s2)}`);
  check(JSON.stringify(s3) === `["unit:${f.e2}"]`, 'a click on the visible part of the half-hidden engineer selects it', `visible part click selected ${JSON.stringify(s3)}`);
  // behind the gate's corridor, seen from outside (north)
  const gx = gateB.tx + 1.5;
  await moveUnitTo(f.e1, gx, f.z0 + 1.6);
  camera({ x: gx, z: f.z0 - 3, distance: 14, yaw: Math.PI, pitch: (30 * Math.PI) / 180 });
  await frames(15);
  const ec = toScreenY(gx, js(`__game.terrainInfo.height(${gx}, ${f.z0 + 1.6})`) + 0.5, f.z0 + 1.6);
  await click(ec.x, ec.y);
  const s4 = js('__game.selected.map((s) => s.type + ":" + s.id)');
  check(JSON.stringify(s4) === `["unit:${f.e1}"]`, 'an engineer behind the gate’s corridor is selectable (the corridor has no volume)', `corridor click selected ${JSON.stringify(s4)}`);
}

// ---- 10 (reserved site) and 11: C2 ----------------------------------------------------------------

async function reservedAndC2(f) {
  // a spot south of the rectangle; e2 stands just north of it (between it and the enclosure)
  const tx = f.x0 + 4;
  const tz = f.z0 + 13;
  await moveUnitTo(f.e2, tx + 1, tz - 0.8);
  // the commander (at the base, far off) reserves a gun turret there by the build bar
  const cmdr = units().find((u) => u.kindName === 'commander').id;
  camera({ x: tx + 1, z: tz + 5, distance: 16, yaw: 0, pitch: (35 * Math.PI) / 180 });
  await frames(10);
  await pause(true);
  await selectUnit(cmdr);
  camera({ x: tx + 1, z: tz + 5, distance: 16, yaw: 0, pitch: (35 * Math.PI) / 180 });
  await frames(5);
  await clickEl('.bar button[data-kind="gun"]');
  await clickTile(tx + 1, tz + 1);
  await pause(false);
  await until('the reserved site', `__game.list('building').some((b) => b.kindName === 'gun' && b.tx === ${tx} && b.ty === ${tz})`, 10);
  await pause(true);
  const site = buildings().find((b) => b.kindName === 'gun' && b.tx === tx && b.ty === tz);
  check(site.state === 'reserved', `the commander reserved a gun turret site at ${tx},${tz} (id ${site.id})`, `site ${JSON.stringify(site)}`);
  // the engineer just behind the reserved site (from the camera) is selectable
  camera({ x: tx + 1, z: tz + 6, distance: 14, yaw: 0, pitch: (30 * Math.PI) / 180 });
  await frames(10);
  const e = toScreenY(tx + 1, js(`__game.terrainInfo.height(${tx + 1}, ${tz - 0.8})`) + 0.5, tz - 0.8);
  await click(e.x, e.y);
  const s = js('__game.selected.map((s) => s.type + ":" + s.id)');
  check(JSON.stringify(s) === `["unit:${f.e2}"]`, 'an engineer behind a reserved site is selectable (a reserved site has no volume)', `click behind the reserved site selected ${JSON.stringify(s)}`);
  // C2: the commander's own reserved site, an unshifted build-bar click on exactly it
  await selectUnit(cmdr);
  camera({ x: tx + 1, z: tz + 5, distance: 16, yaw: 0, pitch: (35 * Math.PI) / 180 });
  await frames(5);
  await clickEl('.bar button[data-kind="gun"]');
  // the preview over exactly that site, before the click
  const at = toScreen(tx + 1, tz + 1);
  ab('mouse', 'move', R(at.x), R(at.y));
  await frames(5);
  const ghost = js('__game.ghost');
  const oid0 = queueOf(cmdr)[0]?.oid;
  const rej = js('__game.rejected.length');
  const sent = js('__game.commandsSent');
  await clickTile(tx + 1, tz + 1);
  await pause(false);
  // applied at its tick: a new order replaced the old one (or a refusal came back)
  await until('the order applied', `__game.commandsSent > ${sent} && ((__game.queues.find((q) => q.id === ${cmdr})?.orders[0]?.oid ?? -1) !== ${oid0 ?? -1} || __game.rejected.length > ${rej})`, 10);
  await pause(true);
  const q = queueOf(cmdr);
  const still = buildings().find((b) => b.kindName === 'gun' && b.tx === tx && b.ty === tz);
  check(
    q.length === 1 && q[0].target === site.id && q[0].oid !== oid0 && still?.id === site.id && js('__game.rejected.length') === rej && ghost?.ok === true && ghost.tx === tx && ghost.ty === tz,
    `C2: an unshifted build-bar click on the commander's own reserved site is accepted (preview allowed; a new order ${oid0} → ${q[0]?.oid} on the same id ${site.id}; queue length 1)`,
    `C2: queue ${JSON.stringify(q)}, site ${JSON.stringify(still)}, refusals ${JSON.stringify(js('__game.rejected').slice(-2))}, ghost ${JSON.stringify(ghost)}`,
  );
  await pause(false);
  return { cmdr };
}

// ---- 12: D1 ---------------------------------------------------------------------------------------

/** Mean absolute luminance difference of two captures, inside rect `r` (CSS px) — the overlay's own contribution. */
function contribution(name, r) {
  return js(`(() => {
    const d = __game.debugRender;
    d.hideOverlay(${JSON.stringify(name)}, false);
    const a = d.capture(${JSON.stringify(r)});
    d.hideOverlay(${JSON.stringify(name)}, true);
    const b = d.capture(${JSON.stringify(r)});
    d.hideOverlay(${JSON.stringify(name)}, false);
    let sum = 0, max = 0, n = 0;
    for (let i = 0; i < a.data.length; i++) { const v = Math.abs(a.data[i] - b.data[i]); sum += v; max = Math.max(max, v); if (v > 8) n++; }
    return { mean: sum / Math.max(1, a.data.length), max, over: n, px: a.data.length };
  })()`);
}

async function overlays(f) {
  // Two occluding gun turrets O1, O2 (2 × 2) south of the rectangle. Behind O1 (north) a heavy
  // turret (3 × 3) that will be upgraded (its frame); behind O2 a reserved heavy turret site (its
  // outline). Each occluder stands one tile east of the heavy footprint's west edge, so it covers
  // the middle of the frame or outline on screen and a side of it is unobstructed.
  const oz = f.z0 + 21;
  const h1 = f.x0; // heavy turret, tiles x0..x0+2, oz-3..oz-1 (just behind O1)
  const h2 = f.x0 + 7; // reserved heavy site
  const occ1 = h1 + 1;
  const occ2 = h2 + 1;
  const hz = oz - 3;
  const engs = [f.e1, f.e2];
  await selectUnit(engs[0]);
  await selectUnit(engs[1], true);
  camera({ x: f.x0 + 5, z: oz, distance: 26, yaw: 0, pitch: (60 * Math.PI) / 180 });
  await frames(10);
  await clickEl('.bar button[data-kind="gun"]');
  shiftDown();
  for (const x of [occ1, occ2]) await clickTile(x + 1, oz + 1);
  shiftUp();
  // queued behind the guns (Shift), so it does not replace their orders
  await clickEl('.bar button[data-kind="heavy"]');
  shiftDown();
  await clickTile(h1 + 1.5, hz + 1.5);
  shiftUp();
  await until(
    'the two guns and the heavy turret complete',
    `[['gun', ${occ1}, ${oz}], ['gun', ${occ2}, ${oz}], ['heavy', ${h1}, ${hz}]].every(([k, x, z]) => __game.list('building').some((b) => b.kindName === k && b.tx === x && b.ty === z && b.complete))`,
    300,
  );
  const up = buildings().find((b) => b.kindName === 'heavy' && b.tx === h1 && b.ty === hz);
  // the upgrade: U, then a click on the heavy turret (an engineer selected)
  await selectUnit(engs[0]);
  press('u');
  check(tool().name === 'upgrade', 'U arms the upgrade tool', `tool ${JSON.stringify(tool())}`);
  await clickTile(h1 + 1.5, hz + 1.5);
  await until('the upgrade under way', `__game.buildQueue.some((b) => b.id === ${up.id} && b.upgrading)`, 20);
  await pause(true);
  // the reserved heavy site behind O2, by the commander
  const cmdr = units().find((u) => u.kindName === 'commander').id;
  await selectUnit(cmdr);
  camera({ x: f.x0 + 5, z: oz, distance: 26, yaw: 0, pitch: (60 * Math.PI) / 180 });
  await frames(5);
  // first a move away (south-east), then the site queued behind it: the site stays reserved while it walks
  const far = toScreen(f.x0 + 13.5, oz + 3.5);
  await click(far.x, far.y, 'right');
  await clickEl('.bar button[data-kind="heavy"]');
  shiftDown();
  await clickTile(h2 + 1.5, hz + 1.5);
  shiftUp();
  await pause(false);
  try {
    await until('the reserved site behind O2', `__game.list('building').some((b) => b.kindName === 'heavy' && b.tx === ${h2} && b.ty === ${hz} && b.state === 'reserved')`, 10);
  } catch (e) {
    const why = js(`({ sel: __game.selected.map((s) => s.type + ':' + s.id), queue: __game.queues.find((q) => q.id === ${cmdr})?.orders ?? null, rejected: __game.rejected.slice(-3).map((r) => r.reason), ghost: __game.ghost, tool: __game.tool })`);
    throw new Error(`${e.message}: ${JSON.stringify(why)}`);
  }
  await pause(true);
  // deselect (frames and outlines only; no selection markers)
  await click(...Object.values(toScreen(f.x0 + 20.5, oz + 8.5)));
  const pose = { x: f.x0 + 5, z: oz + 1, distance: 11, yaw: 0, pitch: (24 * Math.PI) / 180 };
  camera(pose);
  await frames(30);
  const o1 = buildings().find((b) => b.kindName === 'gun' && b.tx === occ1 && b.ty === oz).id;
  const o2 = buildings().find((b) => b.kindName === 'gun' && b.tx === occ2 && b.ty === oz).id;
  const frameDrawn = js(`__game.debugRender.drawn('construction-frame')`);
  const outlineDrawn = js(`__game.debugRender.drawn('reserved-outline')`);
  check(frameDrawn > 0 && outlineDrawn > 0, `a real upgrade frame (${frameDrawn}) and a real reserved outline (${outlineDrawn}) are drawn`, `drawn: frame ${frameDrawn}, outline ${outlineDrawn}`);
  for (const [name, occ] of [['construction-frame', o1], ['reserved-outline', o2]]) {
    // inside: the middle of the occluding turret's body on screen, where it covers the overlay;
    // outside: the overlay's part beside the occluder's screen rectangle (unobstructed), on whichever
    // side perspective leaves the wider strip
    const box = js(`__game.debugRender.screenBox(${occ})`);
    const sb = js(`__game.debugRender.overlayScreenBox(${JSON.stringify(name)})`);
    const inside = {
      x0: Math.max(sb.x0, box.x0 + (box.x1 - box.x0) * 0.3),
      x1: Math.min(sb.x1, box.x0 + (box.x1 - box.x0) * 0.7),
      y0: Math.max(sb.y0, box.y0 + (box.y1 - box.y0) * 0.35),
      y1: Math.min(sb.y1, box.y0 + (box.y1 - box.y0) * 0.8),
    };
    const west = { x0: sb.x0, x1: Math.min(sb.x1, box.x0 - 2), y0: sb.y0, y1: sb.y1 };
    const east = { x0: Math.max(sb.x0, box.x1 + 2), x1: sb.x1, y0: sb.y0, y1: sb.y1 };
    const outside = west.x1 - west.x0 >= east.x1 - east.x0 ? west : east;
    if (!(inside.x1 > inside.x0 && inside.y1 > inside.y0 && outside.x1 > outside.x0))
      throw new Error(`D1 ${name}: the occluder does not partly cover the overlay on screen (occluder ${JSON.stringify(box)}, overlay ${JSON.stringify(sb)})`);
    const inOn = contribution(name, inside);
    const outOn = contribution(name, outside);
    js('__game.debugRender.overlayDepthTest(false)');
    const inOff = contribution(name, inside);
    js('__game.debugRender.overlayDepthTest(true)');
    note(`D1 ${name}: inside the occluding turret ${JSON.stringify(inside)} contribution depth on ${JSON.stringify(inOn)}, depth off ${JSON.stringify(inOff)}; outside ${JSON.stringify(outside)} ${JSON.stringify(outOn)}`);
    check(inOn.mean < 0.5 && inOn.over === 0, `D1 ${name}: zero contribution inside the occluding turret (mean ${inOn.mean.toFixed(3)}, max ${inOn.max})`, `D1 ${name}: drawn through the turret: ${JSON.stringify(inOn)}`);
    check(outOn.over > 0, `D1 ${name}: non-zero contribution where unobstructed (${outOn.over} px)`, `D1 ${name}: no contribution outside the turret: ${JSON.stringify(outOn)}`);
    check(inOff.over > 0, `D1 ${name}: negative — with depth testing off it shows through the turret (${inOff.over} px)`, `D1 ${name}: depth test off still shows nothing inside: ${JSON.stringify(inOff)}`);
  }
  await shot('w24r3-overlays-occluded.png');
  await pause(false);
}

// ---- 13: paint a row --------------------------------------------------------------------------------

/** A clear ground strip for 4 generators (8 × 2 tiles) with a 2-tile free ring, near the base. */
function pickRowStrip() {
  return js(`(() => {
    const t = __game.terrainInfo;
    const used = new Set();
    for (const b of __game.list('building')) for (let j = 0; j < b.fh; j++) for (let i = 0; i < b.fw; i++) used.add((b.ty + j) * t.w + b.tx + i);
    for (let r = 10; r < 50; r++)
      for (let a = 0; a < 48; a++) {
        const x0 = Math.round(t.base.x + r * Math.cos((a / 48) * 2 * Math.PI)) - 4;
        const z0 = Math.round(t.base.z + r * Math.sin((a / 48) * 2 * Math.PI)) - 1;
        let ok = true;
        for (let z = z0 - 2; z <= z0 + 3 && ok; z++)
          for (let x = x0 - 2; x <= x0 + 9 && ok; x++)
            if (x < 1 || z < 1 || x >= t.w - 1 || z >= t.h - 1 || __game.tileInfo(x, z).type !== 'ground' || used.has(z * t.w + x)) ok = false;
        if (ok) return { x0, z0 };
      }
    return null;
  })()`);
}

async function paintRow(f) {
  const strip = pickRowStrip();
  if (!strip) throw new Error('no clear 8 × 2 strip for the generator row');
  const { x0, z0 } = strip;
  const want = [0, 2, 4, 6].map((i) => [x0 + i, z0]);
  note(`paint-row strip: anchors ${JSON.stringify(want)}`);
  // the engineers alive now (the fixture's pair may have been lost to the rushers; two often stand
  // on one spot, where a click takes only the nearer), selected by a real Shift + drag box round the
  // first of them (paused, no tool armed, so the box selects and nothing moves meanwhile)
  key('Escape');
  await pause(true);
  const engs = units().filter((u) => u.kindName === 'engineer');
  if (!engs.length) throw new Error('no engineer left to build the row');
  camera({ x: engs[0].x, z: engs[0].z, distance: 22, yaw: 0, pitch: (70 * Math.PI) / 180 });
  await frames(5);
  const c = js(`__game.screenOf('unit', ${engs[0].id})`);
  shiftDown();
  await drag({ x: c.x - 60, y: c.y - 60 }, { x: c.x + 60, y: c.y + 60 }, 6);
  shiftUp();
  await frames(3);
  const chosen = js('__game.selected').filter((x) => x.type === 'unit' && x.kindName === 'engineer').map((x) => x.id);
  check(chosen.length > 0, `a box selects the engineers there (${chosen.join(', ')})`, `selected ${JSON.stringify(js('__game.selected'))}`);
  await pause(false);
  camera({ x: x0 + 4, z: z0 + 1, distance: 30, yaw: 0, pitch: (60 * Math.PI) / 180 });
  await frames(10);
  await clickEl('.bar button[data-kind="generator"]');
  check(tool().name === 'build' && tool().kind === 'generator', 'the build bar picks the energy generator', `tool: ${JSON.stringify(tool())}`);
  // a real press, moves and (later) release: the cursor on the first and last footprints' centres
  const a = toScreen(x0 + 1, z0 + 1);
  const b = toScreen(x0 + 7, z0 + 1);
  ab('mouse', 'move', R(a.x), R(a.y));
  ab('mouse', 'down', 'left');
  for (let k = 1; k <= 10; k++) ab('mouse', 'move', R(a.x + ((b.x - a.x) * k) / 10), R(a.y + ((b.y - a.y) * k) / 10));
  await frames(10);
  const pv = js('__game.dragPreview');
  const builds = pv ? pv.build.map(([x, z]) => [x, z]) : null;
  check(
    !!pv && pv.kind === 'generator' && JSON.stringify(builds) === JSON.stringify(want) && pv.skipped.length === 0 && pv.drawn.build.length === 4 && /× 4/.test(pv.label ?? ''),
    `before release the preview shows 4 generator ghosts edge to edge (label "${pv?.label}")`,
    `preview ${JSON.stringify(pv)}; wanted ${JSON.stringify(want)}`,
  );
  await shot('w24r3-paint-row.png');
  ab('mouse', 'up', 'left');
  await frames(3);
  await until('4 generator sites', `${JSON.stringify(want)}.every(([x, z]) => __game.list('building').some((b) => b.kindName === 'generator' && b.tx === x && b.ty === z))`, 10);
  check(js('__game.dragPreview') === null && tool().name === 'select', 'after release: 4 generator sites, no preview left, the tool closed (no Shift)', `tool ${JSON.stringify(tool())}`);
  await speed(3);
  await until('the 4 generators built', `${JSON.stringify(want)}.every(([x, z]) => __game.list('building').some((b) => b.kindName === 'generator' && b.tx === x && b.ty === z && b.complete))`, 240);
  check(true, 'the engineers built all 4 generators of the row', '');
  await speed(1);
}

async function run() {
  await visibility();
  await tabs();
  await economy();
  const f = await fixture();
  const g = await gate(f);
  await spawnAndStats(f);
  await tune();
  await isolation(f);
  await focus();
  await picking(f, g);
  await reservedAndC2(f);
  await overlays(f);
  await paintRow(f);
  errorsNow('check-panel');
}

async function main() {
  let server = null;
  if (!args.includes('--no-build')) {
    console.log('building…');
    execFileSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: GAME, stdio: 'inherit' });
  }
  mkdirSync(shotsDir, { recursive: true });
  try {
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
    note(`origin: ${ORIGIN} (this tree's build)`);
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
  console.log(failures.length ? `check-panel: ${failures.length} FAILED` : 'check-panel: all checks passed');
  process.exit(failures.length ? 1 : 0);
}

await main();
