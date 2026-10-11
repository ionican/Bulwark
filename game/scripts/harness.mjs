// The browser harness check-panel.mjs and check-belts.mjs share (W29 simplify): result reporting,
// agent-browser on one named session, real mouse and key input, a few `__game` reads, screenshots,
// and `main()`, which builds this tree (unless --no-build), serves it with `vite preview` on the
// script's strict port, runs the checks, and always stops its own server and closes only its own
// session (never `close --all`).
//
//   const h = harness({ name: 'check-belts', port: 8841, session: 'w29belts' });
//   await h.main(run);
//
// Each script keeps its own port and session name; helpers only one script uses stay in it.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ART_REF, screenshot } from './shots.mjs';

const GAME = fileURLToPath(new URL('..', import.meta.url));

/** agent-browser on PATH, else the newest under ~/.nvm (an nvm switch can drop it from PATH). */
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

/** The harness for one check script: `name` labels the summary line, `port` and `session` are its own. */
export function harness({ name, port, session }) {
  const ORIGIN = `http://127.0.0.1:${port}`;
  const args = process.argv.slice(2);
  const arg = (a) => (args.includes(a) ? args[args.indexOf(a) + 1] : null);
  const shotsDir = arg('--shots') ?? ART_REF;

  const failures = [];
  const fail = (msg) => {
    failures.push(msg);
    console.log(`FAIL ${msg}`);
  };
  const note = (msg) => console.log(msg);
  const check = (ok, pass, failMsg) => (ok ? note(`ok   ${pass}`) : fail(failMsg));

  const AB = agentBrowser();
  function ab(...a) {
    const r = spawnSync(AB, ['--session', session, '--json', ...a], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 240_000 });
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

  /** Polls `code` in the page every 300 ms until it is truthy (returned) or `seconds` pass (thrown). */
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
  const camera = (rig) => js(`(__game.camera.set(${JSON.stringify(rig)}), true)`);
  const buildings = () => js(`__game.list('building')`);
  const units = () => js(`__game.list('unit')`);
  const queueOf = (id) => js(`(__game.queues.find((q) => q.id === ${id})?.orders ?? [])`);
  /** Ids of the selected units (unit and building ids are separate counters: __game.selectedIds). */
  const selectedUnitIds = () => js(`__game.selectedIds('unit')`);

  async function speed(n) {
    js('(document.activeElement && document.activeElement !== document.body && document.activeElement.blur(), true)');
    shiftDown();
    key(String(n));
    shiftUp();
    await until(`speed ${n}`, `__game.speed === ${n}`, 10);
  }

  /** Selects unit `id` by a real click near its screen point (`add`: Shift held, added to the selection). */
  async function selectUnit(id, add = false) {
    const tryClicks = async () => {
      for (const [ox, oy] of [[0, -4], [0, 0], [2, -8], [-2, -2]]) {
        const p = js(`__game.screenOf('unit', ${id})`);
        if (!p) continue;
        if (add) shiftDown();
        await click(p.x + ox, p.y + oy);
        if (add) shiftUp();
        const sel = selectedUnitIds();
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

  async function shot(file) {
    const path = await screenshot({ ab, js, frames }, join(shotsDir, file), { settle: 6 });
    check(existsSync(path) && statSync(path).size > 0, `screenshot ${path}`, `screenshot ${path} not written`);
    return path;
  }

  async function load(path) {
    ab('open', `${ORIGIN}${path}`);
    ab('set', 'viewport', '1440', '900');
    await until(`${path} ready`, 'window.__game?.ready === true', 120);
    await frames(10);
  }

  /** Builds (unless --no-build), serves this tree on the port, runs `run`, then cleans up and exits 0 or 1. */
  async function main(run) {
    let server = null;
    if (!args.includes('--no-build')) {
      console.log('building…');
      execFileSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: GAME, stdio: 'inherit' });
    }
    mkdirSync(shotsDir, { recursive: true });
    try {
      server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: GAME, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
        if (Date.now() - t0 > 30_000) throw new Error(`vite preview did not start on ${port}: ${serverOut}`);
        await sleep(250);
      }
      note(`origin: ${ORIGIN} (this tree's build)`);
      await run();
    } catch (e) {
      fail(String(e?.message ?? e));
    } finally {
      try {
        spawnSync(AB, ['--session', session, 'keyup', 'Shift'], { timeout: 10_000 });
        spawnSync(AB, ['--session', session, 'close'], { timeout: 30_000 });
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
    console.log(failures.length ? `${name}: ${failures.length} FAILED` : `${name}: all checks passed`);
    process.exit(failures.length ? 1 : 0);
  }

  return {
    GAME,
    ORIGIN,
    args,
    arg,
    shotsDir,
    failures,
    fail,
    note,
    check,
    ab,
    js,
    sleep,
    frames,
    until,
    R,
    click,
    drag,
    shiftDown,
    shiftUp,
    key,
    press,
    centreOf,
    clickEl,
    camera,
    buildings,
    units,
    queueOf,
    selectedUnitIds,
    speed,
    selectUnit,
    errorsNow,
    shot,
    load,
    main,
  };
}
