#!/usr/bin/env node
// Browser check for W29 (PLAN-W29 item 20): mined mass travels by belt to the core, with real
// mouse input, in the sandbox.
//
//   node scripts/check-belts.mjs [--shots <dir>] [--no-build]
//
// Builds this tree (or --no-build) and serves it with `vite preview` on strict port 8841, then
// drives agent-browser (session `w29belts`, 1440 × 900) with real mouse clicks and drags and real
// keys (Shift by keydown/keyup, as check-panel.mjs). `__game` is read to check results; it changes
// game state in two places only: the camera pose (a view setting) and the core damaged to 0 by the
// sandbox `damage` debug command (step 6).
//
//   1  the sandbox has one complete core; the nearest mass deposit to it is found, and an L-shaped
//      belt route from that deposit's extractor to the core is chosen on free ground (printed)
//   2  the commander and both engineers selected by clicks; the mass extractor placed from the build
//      bar on the deposit; built at 3×
//   3  the belt laid from the build bar as two drags: the first leg unshifted, the second with Shift
//      held, starting on the cell after the first leg's end, so the corner tile is laid by the
//      outgoing leg and points along it. From __game: a directed chain from a cell whose back faces
//      the extractor to a cell pointing into the core (checked on the sites and again when built)
//   4  tick-aligned, from one snapshot per sample:
//      (a) until the belt is finished no mass is delivered, and the pool's mass changes by the
//          commander's income less the exact cumulative spending
//      (b) mass items are on the belt
//      (c) the core's delivered mass rises, and the pool's change equals delivered mass + commander
//          income − exact cumulative spending
//   5  hover readouts read from the page: the extractor (its buffer against 180) and the core (hp,
//      delivered mass and rare); screenshots w29-belt-laid.png and w29-core-delivering.png
//   6  the core damaged to 0 through `__game.damage`: disabled (flag and readout "DISABLED"),
//      delivery stops while items wait on the belt; screenshot w29-core-disabled.png
//   7  the engineers selected by clicks, the hover says "right-click: repair", a right-click on the
//      core queues a repair; the repair brings it to 4000 hp, re-enables it, and delivery resumes;
//      screenshot w29-core-repaired.png
//   8  (W29b) the corner tile of the L is drawn with a corner model, its neighbours straight
//      (negative control: shapes forced straight fail the check); drawn items stand on the belt
//      surface; a line laid into leg 2 from the side is drawn with a join model where it meets;
//      close-ups w29-belt-corner.png, w29-items-close.png, w29-belt-join.png
//   9  (W29b) at 1440, 1280, 1152 and 1024 px wide, on map 1 and the sandbox: the resource panel,
//      the idle-units column and the debug spawn box do not overlap; screenshot w29-hud.png
// 0 console errors throughout. It always stops its server and closes only its own session.

import { BDX as DX, BDZ as DZ } from '../src/sim/kinds.ts';
import { harness } from './harness.mjs';

const h = harness({ name: 'check-belts', port: 8841, session: 'w29belts' });
const { ORIGIN, fail, note, check, ab, js, sleep, frames, until, R, click, drag, shiftDown, shiftUp, press, clickEl, camera, buildings, units, queueOf, selectedUnitIds, speed, selectUnit, errorsNow, shot, load } = h;

async function hover(p) {
  ab('mouse', 'move', R(p.x + 1), R(p.y));
  await frames(2);
  ab('mouse', 'move', R(p.x), R(p.y));
  await frames(4);
}
/** Screen point of the centre of tile (x, z). */
const tileScreen = (x, z) => js(`__game.worldToScreen(${x + 0.5}, ${z + 0.5})`);
/** The cursor off every building, so no hover readout shows (30 px in from the edge: within 6 px the camera pans). */
const away = () => ab('mouse', 'move', '30', '450');
/** The hover readout once it shows building `id` (thrown after 10 s). */
const hoverReadout = (label, id) => until(label, `(() => { const h = __game.siteHover; return h.visible && h.id === ${id} ? h : null; })()`, 10);
/** Whether tile (x, z) is open ground with no building on it (the buildings as they stand now). */
function freeGround() {
  const occupied = new Set();
  for (const b of buildings()) for (let j = 0; j < b.fh; j++) for (let i = 0; i < b.fw; i++) occupied.add(`${b.tx + i},${b.ty + j}`);
  return (x, z) => !occupied.has(`${x},${z}`) && js(`__game.tileInfo(${x + 0.5}, ${z + 0.5}).type`) === 'ground';
}

/**
 * One snapshot's economy, read in a single evaluation so every figure is from the same tick: the
 * tick, the pool, cumulative spending and delivered counts, the commander's income per second, the
 * belt tiles of the route (complete or not, and their items).
 */
const ECON = (route) => `(() => {
  const g = __game;
  const e = g.economy;
  const tiles = ${JSON.stringify(route.map(([x, z]) => [x, z]))};
  const bs = g.list('building');
  const at = new Map(bs.filter((b) => b.kindName === 'belt').map((b) => [b.tx + ',' + b.ty, b]));
  const on = tiles.map(([x, z]) => at.get(x + ',' + z) ?? null);
  return {
    tick: g.tick,
    mass: g.pool.mass,
    spent: e.spent.mass,
    delivered: e.delivered.mass,
    income: e.commanderIncome.mass,
    laid: on.filter(Boolean).length,
    built: on.filter((b) => b && b.complete).length,
    massItems: on.filter((b) => b && b.item === 5).length,
  };
})()`;

/** pool(t1) − pool(t0) against delivered + commander income − spending over the same ticks. */
function balanceOf(a, b) {
  const ticks = b.tick - a.tick;
  const expect = b.delivered - a.delivered + (a.income * ticks) / 10 - (b.spent - a.spent);
  return { ticks, got: b.mass - a.mass, expect, ok: Math.abs(b.mass - a.mass - expect) < 1e-6 * Math.max(1, Math.abs(b.mass)) };
}

// ---- 1: the core, the deposit and the route --------------------------------------------------------

/**
 * An L-shaped route from the 2 × 2 extractor at (ex, ey) to the 3 × 3 core at (cx, cy): the first
 * leg leaves the extractor straight out of one side (so its first tile's back faces it), the second
 * leg turns at the cell after the first leg's end and runs into one of the core's middle side cells.
 * Every tile free ground with no building. Returns the legs (end tiles, inclusive) and the tiles
 * with their directions, shortest first.
 */
function routes(ex, ey, cx, cy, free) {
  const out = [];
  // horizontal then vertical, into the core's top or bottom side
  for (const zr of [ey, ey + 1])
    for (const c of [cx, cx + 1, cx + 2]) {
      if (c >= ex && c <= ex + 1) continue;
      const sx = c > ex ? 1 : -1;
      const xs = sx > 0 ? ex + 2 : ex - 1;
      const zEnd = zr < cy ? cy - 1 : cy + 3;
      const sz = zEnd > zr ? 1 : -1;
      if (zr >= cy && zr <= cy + 2) continue;
      out.push({ legs: [[[xs, zr], [c - sx, zr]], [[c, zr], [c, zEnd]]], d: [sx > 0 ? 0 : 2, sz > 0 ? 1 : 3] });
    }
  // vertical then horizontal, into the core's left or right side
  for (const xr of [ex, ex + 1])
    for (const c of [cy, cy + 1, cy + 2]) {
      if (c >= ey && c <= ey + 1) continue;
      const sz = c > ey ? 1 : -1;
      const zs = sz > 0 ? ey + 2 : ey - 1;
      const xEnd = xr < cx ? cx - 1 : cx + 3;
      const sx = xEnd > xr ? 1 : -1;
      if (xr >= cx && xr <= cx + 2) continue;
      out.push({ legs: [[[xr, zs], [xr, c - sz]], [[xr, c], [xEnd, c]]], d: [sz > 0 ? 1 : 3, sx > 0 ? 0 : 2] });
    }
  const tilesOf = (r) => {
    const t = [];
    r.legs.forEach(([[x0, z0], [x1, z1]], i) => {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
      for (let k = 0; k <= n; k++) t.push([x0 + Math.sign(x1 - x0) * k, z0 + Math.sign(z1 - z0) * k, r.d[i]]);
    });
    return t;
  };
  return out
    .map((r) => ({ ...r, tiles: tilesOf(r) }))
    // each leg at least 2 tiles long, so a drag lays it with the drag's own direction (a 1-tile drag takes the tool's)
    .filter((r) => r.legs.every(([[x0, z0], [x1, z1]]) => Math.abs(x1 - x0) + Math.abs(z1 - z0) >= 1))
    .filter((r) => r.tiles.every(([x, z]) => free(x, z)))
    .sort((a, b) => a.tiles.length - b.tiles.length);
}

/** From __game: the belt tiles form a directed chain from a cell whose back faces the extractor into the core. */
function chainProblems(ext, core) {
  const bs = buildings();
  const belts = new Map(bs.filter((b) => b.kindName === 'belt').map((b) => [`${b.tx},${b.ty}`, b]));
  const ring = [];
  for (let k = 0; k < 2; k++) ring.push([ext.tx + 2, ext.ty + k, 0], [ext.tx - 1, ext.ty + k, 2], [ext.tx + k, ext.ty + 2, 1], [ext.tx + k, ext.ty - 1, 3]);
  const start = ring.find(([x, z, d]) => belts.get(`${x},${z}`)?.dir === d);
  if (!start) return ['no belt whose back faces the extractor'];
  let [x, z] = start;
  const inCore = (px, pz) => px >= core.tx && px < core.tx + 3 && pz >= core.ty && pz < core.ty + 3;
  const seen = new Set();
  for (;;) {
    const b = belts.get(`${x},${z}`);
    if (!b) return [`the chain breaks at ${x},${z}`];
    if (seen.has(`${x},${z}`)) return [`the chain loops at ${x},${z}`];
    seen.add(`${x},${z}`);
    const nx = x + DX[b.dir];
    const nz = z + DZ[b.dir];
    if (inCore(nx, nz)) return [];
    const n = belts.get(`${nx},${nz}`);
    if (n && (n.dir + 2) % 4 === b.dir) return [`${nx},${nz} faces back into ${x},${z}`];
    x = nx;
    z = nz;
  }
}

async function run() {
  await load('/?sandbox=1');
  ab('errors', '--clear');
  ab('console', '--clear');

  // 1
  const cores = buildings().filter((b) => b.kindName === 'core');
  check(cores.length === 1 && cores[0].complete && !cores[0].disabled, `the sandbox has one complete core at ${cores[0]?.tx},${cores[0]?.ty} (3 × 3)`, `sandbox cores: ${JSON.stringify(cores)}`);
  const core = cores[0];
  if (!core) throw new Error('no core');
  const econ0 = js('__game.economy');
  check(econ0?.belts === true, 'the sandbox delivers by belt (__game.economy.belts)', `__game.economy: ${JSON.stringify(econ0)}`);
  const deposits = js('__game.terrainInfo.deposits').filter((d) => d.kind === 'mass');
  const cc = [core.tx + 1.5, core.ty + 1.5];
  deposits.sort((a, b) => Math.hypot(a.tx + 1 - cc[0], a.ty + 1 - cc[1]) - Math.hypot(b.tx + 1 - cc[0], b.ty + 1 - cc[1]));
  const dep = deposits[0];
  const free = freeGround();
  const route = routes(dep.tx, dep.ty, core.tx, core.ty, free)[0];
  if (!route) throw new Error(`no L-shaped route on free ground from the deposit at ${dep.tx},${dep.ty} to the core`);
  note(`nearest mass deposit ${dep.tx},${dep.ty}; route: leg 1 ${route.legs[0][0]} → ${route.legs[0][1]} (dir ${route.d[0]}), leg 2 ${route.legs[1][0]} → ${route.legs[1][1]} (dir ${route.d[1]}), ${route.tiles.length} tiles`);
  const midX = (dep.tx + 1 + cc[0]) / 2;
  const midZ = (dep.ty + 1 + cc[1]) / 2;
  // 4 tiles south of the midpoint, so the core sits above the build bar in the screenshots
  camera({ x: midX, z: midZ + 4, distance: 30, yaw: 0 });
  await frames(10);

  // 2
  const us = units();
  const cmdr = us.find((u) => u.kindName === 'commander');
  const engs = us.filter((u) => u.kindName === 'engineer');
  await selectUnit(cmdr.id);
  for (const e of engs) await selectUnit(e.id, true);
  const sel = selectedUnitIds();
  check(sel.length === 1 + engs.length, `the commander and ${engs.length} engineers selected by clicks`, `selected ${JSON.stringify(sel)}`);
  await clickEl('.bar button[data-kind="massExtractor"]');
  const ep = js(`__game.worldToScreen(${dep.tx + 1}, ${dep.ty + 1})`);
  await click(ep.x, ep.y);
  const ext = await until('the extractor site', `__game.list('building').find((b) => b.kindName === 'massExtractor' && b.tx === ${dep.tx} && b.ty === ${dep.ty}) ?? null`, 10);
  check(!!ext, `the mass extractor site placed on ${dep.tx},${dep.ty} by a click`, 'no extractor site');
  await speed(3);
  await until('the extractor built', `__game.list('building').some((b) => b.id === ${ext.id} && b.complete)`, 120);
  press('Escape');

  // 3: the belt, two legs
  const s0 = js(ECON(route.tiles));
  await clickEl('.bar button[data-kind="belt"]');
  const [l1, l2] = route.legs;
  await drag(tileScreen(...l1[0]), tileScreen(...l1[1]), 10);
  shiftDown();
  await drag(tileScreen(...l2[0]), tileScreen(...l2[1]), 10);
  shiftUp();
  await frames(5);
  press('Escape');
  const laid = await until('the belt sites', `(${ECON(route.tiles)}).laid === ${route.tiles.length}`, 15);
  check(!!laid, `both legs laid: ${route.tiles.length} belt sites`, 'belt sites missing');
  const dirs = buildings().filter((b) => b.kindName === 'belt');
  const wrongDir = route.tiles.filter(([x, z, d]) => dirs.find((b) => b.tx === x && b.ty === z)?.dir !== d);
  check(!wrongDir.length, 'every belt tile points along its leg (the corner along the outgoing leg)', `belt tiles with the wrong direction: ${JSON.stringify(wrongDir)}`);
  // Shift appended the second leg: every first-leg tile is still built or queued by a builder
  const queued = new Set([cmdr, ...engs].flatMap((u) => queueOf(u.id).map((o) => o.target)));
  const leg1 = route.tiles.slice(0, Math.abs(l1[1][0] - l1[0][0]) + Math.abs(l1[1][1] - l1[0][1]) + 1);
  const dropped = leg1.filter(([x, z]) => {
    const b = dirs.find((d) => d.tx === x && d.ty === z);
    return !b || (!b.complete && !queued.has(b.id));
  });
  check(!dropped.length, `the second leg appended: all ${leg1.length} first-leg tiles built or still queued`, `first-leg tiles dropped from the queues: ${JSON.stringify(dropped)}`);
  const p1 = chainProblems(ext, core);
  check(!p1.length, 'the belt sites form a directed chain from the extractor into the core', `belt chain (sites): ${p1.join('; ')}`);

  // 4 (a): sampled until the belt is finished
  const before = [];
  for (const t0 = Date.now(); Date.now() - t0 < 180_000; ) {
    const s = js(ECON(route.tiles));
    if (s.built === route.tiles.length) break;
    before.push(s);
    await sleep(400);
  }
  const done = js(ECON(route.tiles));
  check(done.built === route.tiles.length, `the belt finished at tick ${done.tick}`, `belt not finished: ${done.built} of ${route.tiles.length}`);
  const p2 = chainProblems(ext, core);
  check(!p2.length, 'the finished belt is a directed chain from the extractor into the core', `belt chain (built): ${p2.join('; ')}`);
  const badA = before.filter((s) => s.delivered !== 0 || !balanceOf(s0, s).ok);
  check(
    before.length >= 3 && !badA.length,
    `(a) ${before.length} samples from tick ${s0.tick} to ${before[before.length - 1]?.tick} while the belt was being built: no mass delivered, pool change = commander income − spending (last: ${JSON.stringify(before.length ? balanceOf(s0, before[before.length - 1]) : null)})`,
    `(a) before the belt was finished: ${before.length} samples, ${badA.length} wrong: ${JSON.stringify(badA.slice(0, 3).map((s) => ({ tick: s.tick, delivered: s.delivered, ...balanceOf(s0, s) })))}`,
  );
  await shot('w29-belt-laid.png');

  // (b) and (c)
  const sb = await until('mass items on the belt', `(() => { const s = ${ECON(route.tiles)}; return s.massItems > 0 ? s : null; })()`, 60);
  check(sb.massItems > 0, `(b) ${sb.massItems} mass items on the belt at tick ${sb.tick}`, '(b) no mass items on the belt');
  const c1 = await until('the first delivery', `(() => { const s = ${ECON(route.tiles)}; return s.delivered > 0 ? s : null; })()`, 60);
  await sleep(4000);
  const c2 = js(ECON(route.tiles));
  const bal = balanceOf(s0, c2);
  const bal12 = balanceOf(c1, c2);
  check(
    c2.delivered > c1.delivered && bal.ok && bal12.ok,
    `(c) delivered mass ${c1.delivered} at tick ${c1.tick} → ${c2.delivered} at tick ${c2.tick}; pool change ${bal.got.toFixed(3)} = delivered ${c2.delivered} + commander income ${((c2.income * bal.ticks) / 10).toFixed(1)} − spent ${(c2.spent - s0.spent).toFixed(3)} (since tick ${s0.tick})`,
    `(c) delivery: ${JSON.stringify({ c1, c2, bal, bal12 })}`,
  );

  // 5: hover readouts and screenshots
  await hover(js(`__game.worldToScreen(${ext.tx + 1}, ${ext.ty + 1}, __game.terrainInfo.height(${ext.tx + 1}, ${ext.ty + 1}) + 0.6)`));
  const hx = await hoverReadout('the extractor readout', ext.id);
  check(hx.lines[0] === 'Mass extractor' && hx.lines.some((l) => /^buffer \d+ \/ 180 mass$/.test(l)), `extractor hover: ${JSON.stringify(hx.lines)}`, `extractor hover: ${JSON.stringify(hx)}`);
  const coreScreen = () => js(`__game.worldToScreen(${core.tx + 1.5}, ${core.ty + 1.5}, __game.terrainInfo.height(${core.tx + 1.5}, ${core.ty + 1.5}) + 1)`);
  await hover(coreScreen());
  const hc = await hoverReadout('the core readout', core.id);
  check(
    hc.lines[0] === 'Core' && hc.lines.includes('hp 4000 / 4000') && hc.lines.some((l) => /^delivered mass \d+ · rare 0$/.test(l)),
    `core hover: ${JSON.stringify(hc.lines)}`,
    `core hover: ${JSON.stringify(hc)}`,
  );
  away();
  await frames(3);
  await shot('w29-core-delivering.png');

  // 6: disabled
  const dmg = js(`__game.damage(${core.id}, 4000)`);
  check(dmg?.ok, 'the core damaged to 0 by the sandbox damage command', `damage refused: ${JSON.stringify(dmg)}`);
  const dis = await until('the core disabled', `__game.list('building').find((b) => b.id === ${core.id} && b.disabled && b.hp === 0) ?? null`, 10);
  check(!!dis, 'the core is disabled at 0 hp and still on the map', 'core not disabled');
  const d1 = js(ECON(route.tiles));
  await sleep(4000);
  const d2 = js(ECON(route.tiles));
  check(
    d2.tick > d1.tick + 30 && d2.delivered === d1.delivered && d2.massItems > 0 && balanceOf(d1, d2).ok,
    `delivery stopped: delivered ${d1.delivered} at tick ${d1.tick} and ${d2.delivered} at tick ${d2.tick}, ${d2.massItems} items waiting on the belt`,
    `disabled core: ${JSON.stringify({ d1, d2 })}`,
  );
  await hover(coreScreen());
  const hd = await hoverReadout('the disabled readout', core.id);
  check(hd.lines.includes('hp 0 / 4000') && hd.lines.some((l) => /DISABLED/.test(l)), `disabled core hover: ${JSON.stringify(hd.lines)}`, `disabled core hover: ${JSON.stringify(hd)}`);
  away();
  await frames(3);
  await shot('w29-core-disabled.png');

  // 7: repair by right-click with the engineers selected
  press('Escape');
  // the builders selected at the start are still selected; if not, a Shift box round the
  // engineers (they finish the belt standing side by side, so a click can land on the other one)
  if (!engs.every((e) => selectedUnitIds().includes(e.id))) {
    const pts = engs.map((e) => js(`__game.screenOf('unit', ${e.id})`));
    shiftDown();
    await drag({ x: Math.min(...pts.map((p) => p.x)) - 25, y: Math.min(...pts.map((p) => p.y)) - 35 }, { x: Math.max(...pts.map((p) => p.x)) + 25, y: Math.max(...pts.map((p) => p.y)) + 25 }, 10);
    shiftUp();
    await frames(5);
  }
  const selE = selectedUnitIds();
  check(engs.every((e) => selE.includes(e.id)), `the engineers selected (selection ${JSON.stringify(selE)})`, `selected ${JSON.stringify(selE)}, engineers ${JSON.stringify(engs.map((e) => e.id))}`);
  const cp = coreScreen();
  await hover(cp);
  const hr = await hoverReadout('the repair hint', core.id);
  check(hr.lines.includes('right-click: repair'), 'over the disabled core with builders selected the hover says "right-click: repair"', `hover: ${JSON.stringify(hr.lines)}`);
  await click(cp.x, cp.y, 'right');
  const rq = await until('a repair order', `__game.queues.filter((q) => ${JSON.stringify(engs.map((e) => e.id))}.includes(q.id) && q.orders.some((o) => o.kind === 'repair' && o.target === ${core.id})).length`, 10);
  check(rq === engs.length, `a right-click on the core queued a repair for ${rq} engineers`, `repair orders: ${rq}`);
  const back = await until('the core repaired', `__game.list('building').find((b) => b.id === ${core.id} && !b.disabled && b.hp === 4000) ?? null`, 120);
  check(!!back, 'the repair brought the core to 4000 hp and re-enabled it', 'core not repaired');
  const r1 = js(ECON(route.tiles));
  await until('delivery again', `(${ECON(route.tiles)}).delivered > ${r1.delivered}`, 30);
  const r2 = js(ECON(route.tiles));
  check(r2.delivered > d2.delivered, `delivery resumed: delivered ${d2.delivered} → ${r2.delivered} at tick ${r2.tick}`, `no delivery after the repair: ${JSON.stringify({ d2, r2 })}`);
  await shot('w29-core-repaired.png');
  errorsNow('check-belts');
  for (const [name, f] of [['belt look', () => beltLook(route)], ['HUD layout', hudLayout]])
    try {
      await f();
    } catch (e) {
      fail(`${name}: ${e?.message ?? e}`);
    }
}

/** The belt models drawn at tile (x, z) (w17/<model> meshes with an instance at the tile centre). */
const modelsAt = (x, z) => js(`__game.beltModelAt(${x}, ${z})`);

/**
 * W29b, step 8: how the belt looks. The L-shaped belt's corner tile (the first of leg 2) is drawn
 * with a corner model and the straight tiles with the straight one (negative control: shapes forced
 * straight, the corner check fails); a line laid into leg 2 from the side is drawn with a join model
 * where it meets; the items stand on the belt surface. Close-ups at the game camera:
 * w29-belt-corner.png, w29-items-close.png, w29-belt-join.png.
 */
async function beltLook(route) {
  const [cx, cz] = route.legs[1][0];
  const d2 = route.d[1];
  const step = (x, z, d, n = 1) => [x + DX[d] * n, z + DZ[d] * n];
  js('__game.fillBuffers()');
  await until('items along the belt', `__game.beltItems.mass >= 8`, 60);
  // a line from the side into leg 2, 3–7 tiles past the corner, on whichever side is free
  const ground = freeGround();
  let join = null;
  for (let k = 3; k <= 7 && !join; k++) {
    const at = step(cx, cz, d2, k);
    for (const side of [(d2 + 1) % 4, (d2 + 3) % 4]) {
      const tiles = [3, 2, 1].map((n) => [...step(at[0], at[1], side, n), (side + 2) % 4]);
      if (tiles.every(([x, z]) => ground(x, z))) {
        join = { at, tiles, side };
        break;
      }
    }
  }
  if (!join) throw new Error('no free side line to join leg 2');
  const refused = js(`(async () => { const out = []; for (const [x, z, d] of ${JSON.stringify(join.tiles)}) { const r = await __game.place('belt', x, z, d); if (!r.ok) out.push(x + ',' + z + ': ' + r.reason); } return out; })()`);
  if (refused.length) throw new Error(`the joining line refused: ${refused.join('; ')}`);
  await until('the joining line built', `__game.list('building').some((b) => b.kindName === 'belt' && b.tx === ${join.tiles[2][0]} && b.ty === ${join.tiles[2][1]} && b.complete)`, 20);

  // the close-ups at the game camera (they need nothing but the view)
  away();
  camera({ x: cx + 0.5, z: cz + 2, distance: 14, yaw: 0 });
  await frames(8);
  await shot('w29-belt-corner.png');
  camera({ x: cx + 0.5, z: cz + 1.5, distance: 8, yaw: 0 });
  await frames(8);
  await shot('w29-items-close.png');
  camera({ x: join.at[0] + 0.5, z: join.at[1] + 2, distance: 14, yaw: 0 });
  await frames(8);
  await shot('w29-belt-join.png');

  // the corner (fed from the side, nothing behind) and its straight neighbours
  const before = route.legs[0][1];
  const after = step(cx, cz, d2);
  // the corner's feeder is on the right of its flow when the right-hand side ((d + 1) mod 4) points back up leg 1
  const want = (d2 + 1) % 4 === (route.d[0] + 2) % 4 ? 'beltCornerR' : 'beltCornerL';
  const shapes = () => ({ corner: modelsAt(cx, cz), before: modelsAt(...before), after: modelsAt(...after) });
  const cornerOk = (s) => JSON.stringify(s.corner) === JSON.stringify([want]) && JSON.stringify(s.before) === '["belt"]' && JSON.stringify(s.after) === '["belt"]';
  camera({ x: cx + 0.5, z: cz + 2, distance: 14, yaw: 0 });
  await frames(6);
  const s1 = shapes();
  check(cornerOk(s1), `W29b: the corner ${cx},${cz} is drawn with ${want}, its neighbours ${before} and ${after} with the straight belt`, `W29b corner shapes: ${JSON.stringify(s1)} (wanted ${want})`);
  js('__game.beltShapesStraight(true)');
  await frames(4);
  const s0 = shapes();
  js('__game.beltShapesStraight(false)');
  await frames(4);
  check(!cornerOk(s0), `W29b negative control: with the shapes forced straight the corner check fails (corner drawn ${JSON.stringify(s0.corner)})`, `W29b negative control: forced straight still passes: ${JSON.stringify(s0)}`);
  // items on the surface, in world units
  const hs = js('__game.itemHeights()');
  const bad = hs.filter((h) => !(h.bottom >= h.surface - 0.02 && h.top > h.surface + 0.15));
  check(hs.length > 0 && bad.length === 0, `W29b: ${hs.length} drawn items stand on the belt surface (bottom ≥ surface − 0.02, top > surface + 0.15; e.g. ${JSON.stringify(hs[0])})`, `W29b items not on the surface: ${JSON.stringify(bad.slice(0, 4))} of ${hs.length}`);
  // the join: the side line meets leg 2 on its right when the line runs in from the right-hand side
  const jw = join.side === (d2 + 1) % 4 ? 'beltJoinR' : 'beltJoinL';
  camera({ x: join.at[0] + 0.5, z: join.at[1] + 2, distance: 14, yaw: 0 });
  await frames(6);
  const jm = modelsAt(...join.at);
  check(JSON.stringify(jm) === JSON.stringify([jw]), `W29b: the line laid from ${join.tiles[0][0]},${join.tiles[0][1]} joins leg 2 at ${join.at}, drawn with ${jw}`, `W29b join at ${join.at}: drawn ${JSON.stringify(jm)} (wanted ${jw})`);
  errorsNow('W29b belt look');
}

/** Screen rectangles (CSS px) of the resource panel, the idle-units column and the debug spawn box, where shown. */
const HUD_RECTS = `(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e || getComputedStyle(e).display === 'none' || !e.children.length && !e.textContent) return null; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 ? { x0: b.left, y0: b.top, x1: b.right, y1: b.bottom } : null; };
  return { res: r('.hud.res'), idle: r('.idle'), dbg: r('.dbg') };
})()`;
const overlaps = (a, b) => !!a && !!b && a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * W29b, step 9: the HUD's right-hand column at 1440, 1280, 1152 and 1024 px wide, map 1 (the debug
 * spawn box shown) and the sandbox: the resource panel, the idle-units column and the debug box do
 * not overlap (bounding rectangles). Screenshot w29-hud.png (map 1 at 1024 px).
 */
async function hudLayout() {
  for (const page of ['/', '/?sandbox=1'])
    for (const width of [1440, 1280, 1152, 1024]) {
      ab('open', `${ORIGIN}${page}`);
      ab('set', 'viewport', String(width), '900');
      await until(`${page} ready`, 'window.__game?.ready === true', 120);
      await until('the idle column shown', `(${HUD_RECTS}).idle !== null`, 20);
      // a few seconds of snapshots: the column is placed again on each one (W26 idleColumn.place)
      await sleep(2500);
      await frames(10);
      const R = js(HUD_RECTS);
      const pairs = [['res', 'idle'], ['res', 'dbg'], ['idle', 'dbg']].filter(([a, b]) => overlaps(R[a], R[b]));
      const fmt = (b) => (b ? `${Math.round(b.x0)},${Math.round(b.y0)}–${Math.round(b.x1)},${Math.round(b.y1)}` : 'hidden');
      check(pairs.length === 0 && R.res && R.idle, `W29b HUD ${page} at ${width} px: no overlap (resources ${fmt(R.res)}, idle ${fmt(R.idle)}, debug ${fmt(R.dbg)})`, `W29b HUD ${page} at ${width} px: ${pairs.map((p) => p.join(' over ')).join('; ') || 'a panel missing'} (resources ${fmt(R.res)}, idle ${fmt(R.idle)}, debug ${fmt(R.dbg)})`);
      if (page === '/' && width === 1024) await shot('w29-hud.png');
    }
  ab('set', 'viewport', '1440', '900');
  errorsNow('W29b HUD');
}

await h.main(run);
