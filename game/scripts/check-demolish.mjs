#!/usr/bin/env node
// Browser check for W32 (PLAN-W32): engineers demolish buildings for half of what went into them,
// with real mouse input and real keys, in the sandbox.
//
//   node scripts/check-demolish.mjs [--shots <dir>] [--no-build]
//
// Builds this tree (or --no-build) and serves it with `vite preview` on strict port 8844, then
// drives agent-browser (session `w32demo`, 1440 × 900). `__game` is read to check results; it
// changes game state only through the time controls, the camera pose and the sandbox commands
// (unlimited spending and the builders' build rate).
//
//   1  on open ground near the core, the commander and engineers selected by clicks lay a 6-tile
//      wall run, a gun turret and an 8-tile Slow belt line from the build bar (one drag, one click,
//      one drag); built at 3×
//   2  the engineers alone selected by clicks; Delete chooses the demolish tool (the button is on,
//      the hint names the tool); Escape closes it; Backspace chooses it again; hovering the gun
//      reads "Demolish: +<refund> mass, <time> s"; screenshot w32-demolish-tool.png
//   3  unlimited spending off; a click on the gun: one demolish order on it per engineer; the
//      hover reads "Demolishing …%"; screenshot w32-demolishing.png; once the gun is gone the
//      demolishRefund counter rose by exactly half the gun's mass cost, and over the same ticks the
//      pool's mass changed by that refund + deliveries + commander income − exact spending (as
//      check-belts.mjs balanceOf)
//   4  Backspace, then a drag along the belt line: while held the preview is a demolish plan of
//      the 8 belts, the label "Demolish 8 · +<refund> mass +0 rare" and 8 demolish marks drawn;
//      screenshot w32-demolish-preview.png; after release and completion every belt tile is empty
//      ground and demolishRefund rose by the previewed refund
//   5  Delete, then a click on the core: no demolish order, the core stands, the tool stays and the
//      hint reads "The core cannot be demolished."
//   6  0 console errors
// It always stops its server and closes only its own session (never `close --all`).

import { B, buildingFootprint, demolishRefund } from '../src/sim/kinds.ts';
import { harness } from './harness.mjs';

const h = harness({ name: 'check-demolish', port: 8844, session: 'w32demo' });
const { note, check, ab, js, frames, until, R, drag, click, shiftDown, shiftUp, press, clickEl, camera, units, queueOf, speed, selectUnit, selectedUnitIds, errorsNow, shot, load } = h;

const tileScreen = (x, z) => js(`__game.worldToScreen(${x + 0.5}, ${z + 0.5})`);
const away = () => ab('mouse', 'move', '30', '450');
async function hover(p) {
  ab('mouse', 'move', R(p.x + 1), R(p.y));
  await frames(2);
  ab('mouse', 'move', R(p.x), R(p.y));
  await frames(4);
}
const hoverOf = (label, id) => until(label, `(() => { const h = __game.siteHover; return h.visible && h.id === ${id} ? h : null; })()`, 10);
/** "50", "12.5": the readouts' amount rule (buildingReadout.ts amount). */
const amount = (v) => {
  const t = Math.round(v * 10) / 10;
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
};

/** The site: x 0..9 (relative), z 0..8: walls on row 0, the gun at (0, 3) 2 × 2, the belt line on row 7. */
const BOX = { w: 10, h: 9 };
const SITE = `(() => {
  const g = __game;
  const occ = new Set();
  const bs = g.list('building');
  for (const b of bs) for (let j = 0; j < b.fh; j++) for (let i = 0; i < b.fw; i++) occ.add((b.tx + i) + ',' + (b.ty + j));
  const core = bs.find((b) => b.kindName === 'core');
  const us = g.list('unit');
  const cands = [];
  for (let dz = -24; dz <= 24; dz++) for (let dx = -24; dx <= 24; dx++) cands.push([core.tx + dx, core.ty + dz]);
  cands.sort((a, b) => Math.hypot(a[0] - core.tx, a[1] - core.ty) - Math.hypot(b[0] - core.tx, b[1] - core.ty));
  for (const [ax, az] of cands) {
    if (Math.hypot(ax - core.tx, az - core.ty) < 8) continue;
    let good = true;
    for (let z = az - 1; z <= az + ${BOX.h} && good; z++)
      for (let x = ax - 1; x <= ax + ${BOX.w} && good; x++) if (occ.has(x + ',' + z) || g.tileInfo(x + 0.5, z + 0.5).type !== 'ground') good = false;
    if (good && us.some((u) => u.x >= ax - 1 && u.x <= ax + ${BOX.w + 1} && u.z >= az - 1 && u.z <= az + ${BOX.h + 1})) good = false;
    if (good) return { ax, az, core: core.id };
  }
  return null;
})()`;

/**
 * One snapshot's economy, read in a single evaluation so every figure is from the same tick: the
 * tick, the pool, cumulative spending and delivered mass, the commander's income, the demolish
 * counters.
 */
const ECON = `(() => {
  const g = __game;
  const e = g.economy;
  return { tick: g.tick, mass: g.pool.mass, spent: e.spent.mass, delivered: e.delivered.mass, income: e.commanderIncome.mass, demolished: e.demolished, refund: e.demolishRefund.mass, rare: e.demolishRefund.rare };
})()`;

/** pool(t1) − pool(t0) against the demolish refund + delivered + commander income − spending over the same ticks. */
function balanceOf(a, b) {
  const ticks = b.tick - a.tick;
  const expect = b.refund - a.refund + b.delivered - a.delivered + (a.income * ticks) / 10 - (b.spent - a.spent);
  return { ticks, got: b.mass - a.mass, expect, ok: Math.abs(b.mass - a.mass - expect) < 1e-6 * Math.max(1, Math.abs(b.mass)) };
}

/** The Demolish button: on, disabled, its small text, and the Engineers group's hint. */
const BUTTON = `(() => {
  const b = document.querySelector('.bar button[data-action="demolish"]');
  return b ? { on: b.classList.contains('on'), disabled: b.disabled, label: b.childNodes[0]?.textContent ?? '', small: b.querySelector('small')?.textContent ?? '', hint: b.parentElement.lastElementChild.textContent } : null;
})()`;

/** Frames until the screen point of tile (x, z) moves under half a pixel between two samples 4 frames apart. */
async function settle([x, z]) {
  let last = null;
  for (let k = 0; k < 60; k++) {
    await frames(4);
    const p = tileScreen(x, z);
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.5) return;
    last = p;
  }
  throw new Error(`the camera did not settle over ${x},${z}`);
}

const ofKind = (k) => js(`__game.list('building')`).filter((b) => b.kindName === k);

async function run() {
  await load('/?sandbox=1');
  ab('errors', '--clear');
  ab('console', '--clear');
  const setup = js(`(async () => {
    const g = __game;
    const r = [await g.setUnlimited(true), await g.tune('unit', 'commander', 'buildRate', 10), await g.tune('unit', 'engineer', 'buildRate', 10)];
    return r.filter((x) => !x.ok).map((x) => x.reason);
  })()`);
  if (setup.length) throw new Error(`sandbox setup refused: ${setup.join('; ')}`);
  const site = js(SITE);
  if (!site) throw new Error('no open 12 × 11 site near the core');
  const { ax, az } = site;
  const walls = [[ax, az], [ax + 5, az]];
  const gunAt = [ax, az + 3];
  const belts = [[ax, az + 7], [ax + 7, az + 7]];
  note(`site: anchor ${ax},${az}; walls ${walls[0]}..${walls[1]}, gun at ${gunAt}, belt line ${belts[0]}..${belts[1]}`);

  // 1: build with the mouse (the first drag replaces the builders' orders, the rest are queued with Shift)
  const centre = [ax + 4.5, az + 4.5];
  camera({ x: centre[0], z: centre[1] + 4, distance: 32, yaw: 0 });
  await settle([centre[0], centre[1] + 4]);
  const us = units();
  const cmdr = us.find((u) => u.kindName === 'commander');
  const engs = us.filter((u) => u.kindName === 'engineer');
  if (!engs.length) throw new Error('the sandbox has no engineer');
  await selectUnit(cmdr.id);
  for (const e of engs) await selectUnit(e.id, true);
  await clickEl('.bar button[data-entry="wall"]');
  await drag(tileScreen(...walls[0]), tileScreen(...walls[1]), 8);
  await frames(3);
  await clickEl('.bar button[data-entry="gun"]');
  shiftDown();
  const [gfw, gfh] = buildingFootprint(B.gun);
  const gp = js(`__game.worldToScreen(${gunAt[0] + gfw / 2}, ${gunAt[1] + gfh / 2})`);
  await click(gp.x, gp.y);
  shiftUp();
  await frames(3);
  await clickEl('.bar button[data-entry="beltSlow"]');
  shiftDown();
  await drag(tileScreen(...belts[0]), tileScreen(...belts[1]), 10);
  shiftUp();
  await frames(3);
  press('Escape');
  await frames(3);
  await speed(3);
  const beltTiles = Array.from({ length: 8 }, (_, k) => [ax + k, az + 7]);
  const wallTiles = Array.from({ length: 6 }, (_, k) => [ax + k, az]);
  const done = `(() => { const m = new Map(__game.list('building').map((b) => [b.tx + ',' + b.ty, b])); return ${JSON.stringify([...beltTiles, ...wallTiles, gunAt])}.every(([x, z]) => m.get(x + ',' + z)?.complete); })()`;
  await until('the wall run, gun and belt line built', done, 240);
  await speed(1);
  const gun = ofKind('gun').find((b) => b.tx === gunAt[0] && b.ty === gunAt[1]);
  const beltIds = beltTiles.map(([x, z]) => ofKind('belt').find((b) => b.tx === x && b.ty === z)?.id);
  check(!!gun && beltIds.every((id) => id !== undefined) && ofKind('wall').filter((b) => b.ty === az && b.tx >= ax && b.tx <= ax + 5 && b.complete).length === 6, `built with the mouse: 6 walls, a gun at ${gunAt}, 8 Slow belts`, `built: gun ${JSON.stringify(gun)}, belts ${JSON.stringify(beltIds)}`);
  if (!gun) return;

  // 2: the engineers alone; Delete, Escape, Backspace
  await selectUnit(engs[0].id);
  for (const e of engs.slice(1)) await selectUnit(e.id, true);
  const sel = selectedUnitIds();
  check(sel.length === engs.length && engs.every((e) => sel.includes(e.id)), `the ${engs.length} engineers selected by clicks`, `selection ${JSON.stringify(sel)}, engineers ${JSON.stringify(engs.map((e) => e.id))}`);
  press('Delete');
  // the bar is redrawn once per snapshot
  await until('the Demolish button on', `(${BUTTON})?.on === true`, 10).catch(() => null);
  const t1 = js('__game.tool');
  const b1 = js(BUTTON);
  check(t1.name === 'demolish' && b1?.on && !b1.disabled && /demolish/i.test(b1.hint), `Delete: the demolish tool ("${t1.label}"); the button "${b1?.label}" is on; hint "${b1?.hint}"`, `after Delete: tool ${JSON.stringify(t1)}, button ${JSON.stringify(b1)}`);
  press('Escape');
  await frames(3);
  const t2 = js('__game.tool');
  press('Backspace');
  await until('the Demolish button on again', `(${BUTTON})?.on === true`, 10).catch(() => null);
  const t3 = js('__game.tool');
  const b3 = js(BUTTON);
  check(t2.name === 'select' && t3.name === 'demolish' && b3?.on, 'Escape closes the tool; Backspace chooses it again (the button on)', `Escape → ${t2.name}, Backspace → ${t3.name}, button ${JSON.stringify(b3)}`);
  const gunScreen = () => js(`__game.screenOf('building', ${gun.id})`);
  await hover(gunScreen());
  const want = demolishRefund(B.gun, 1, gfw, gfh, 0)[0];
  const hv1 = await hoverOf('the gun hover with the tool', gun.id).catch(() => null);
  check(
    !!hv1 && new RegExp(`^Demolish: \\+${amount(want).replace('.', '\\.')} mass, [0-9.]+ s$`).test(hv1.lines[1] ?? ''),
    `hover with the tool: ${JSON.stringify(hv1?.lines)}`,
    `the gun's hover with the tool: ${JSON.stringify(hv1)} (want "Demolish: +${amount(want)} mass, … s")`,
  );
  await shot('w32-demolish-tool.png');

  // 3: the gun by a click; the economy balanced over the same ticks, unlimited spending off
  const off = js(`(async () => [await __game.setUnlimited(false), await __game.tune('unit', 'engineer', 'buildRate', 1)].filter((x) => !x.ok).map((x) => x.reason))()`);
  if (off.length) throw new Error(`setUnlimited(false) or tune refused: ${off.join('; ')}`);
  await frames(6);
  const a = js(ECON);
  await click(...Object.values(gunScreen()));
  const orders = await until(
    'a demolish order per engineer',
    `(() => { const q = ${JSON.stringify(engs.map((e) => e.id))}.map((id) => (__game.queues.find((x) => x.id === id)?.orders ?? []).filter((o) => o.kind === 'demolish')); return q.every((o) => o.length === 1 && o[0].target === ${gun.id}) ? q : null; })()`,
    10,
  ).catch(() => null);
  check(!!orders, `the click on the gun: one demolish order on it per engineer ("${orders?.[0]?.[0]?.text}")`, `queues after the click: ${JSON.stringify(engs.map((e) => queueOf(e.id)))}`);
  await until('the gun being demolished', `(__game.list('building').find((b) => b.id === ${gun.id})?.demolish ?? 0) > 0.05`, 60).catch(() => null);
  await hover(gunScreen());
  const hv2 = await until('the "Demolishing" readout', `(() => { const h = __game.siteHover; return h.visible && h.id === ${gun.id} && /^Demolishing \\d+% · \\+/.test(h.lines[1] ?? '') ? h : null; })()`, 10).catch(() => null);
  check(!!hv2, `hover while demolished: ${JSON.stringify(hv2?.lines)}`, `the gun's hover while demolished: ${JSON.stringify(js('__game.siteHover'))}`);
  await shot('w32-demolishing.png');
  away();
  await until('the gun gone', `!__game.list('building').some((b) => b.id === ${gun.id})`, 120);
  const b = js(ECON);
  const bal = balanceOf(a, b);
  check(
    Math.abs(b.refund - a.refund - want) < 1e-9 && b.demolished - a.demolished === 1 && bal.ok,
    `the gun demolished: demolishRefund +${b.refund - a.refund} mass (half its ${2 * want} mass cost), demolished +${b.demolished - a.demolished}; over ${bal.ticks} ticks the pool's mass changed ${bal.got.toFixed(4)} = refund + delivered + income − spent ${bal.expect.toFixed(4)}`,
    `the gun's demolition: refund ${b.refund - a.refund} (want ${want}), demolished ${b.demolished - a.demolished}; pool change ${bal.got} vs ${bal.expect} over ${bal.ticks} ticks (${JSON.stringify({ a, b })})`,
  );

  // 4: a drag along the belt line
  js(`(async () => await __game.tune('unit', 'engineer', 'buildRate', 10))()`);
  camera({ x: ax + 4, z: az + 9, distance: 26, yaw: 0 });
  await settle([ax + 4, az + 9]);
  press('Backspace');
  await frames(3);
  const pa = tileScreen(...belts[0]);
  const pb = tileScreen(...belts[1]);
  ab('mouse', 'move', R(pa.x), R(pa.y));
  ab('mouse', 'down', 'left');
  for (let k = 1; k <= 10; k++) ab('mouse', 'move', R(pa.x + ((pb.x - pa.x) * k) / 10), R(pa.y + ((pb.y - pa.y) * k) / 10));
  await frames(4);
  const preview = js('__game.dragPreview');
  await shot('w32-demolish-preview.png');
  ab('mouse', 'up', 'left');
  await frames(3);
  const beltRefund = demolishRefund(B.belt, 1, 1, 1, 0)[0] * 8;
  check(
    preview?.kind === 'demolish' &&
      preview.count === 8 &&
      JSON.stringify(preview.targets) === JSON.stringify(beltIds) &&
      Math.abs(preview.refund.mass - beltRefund) < 1e-6 &&
      preview.label === `Demolish 8 · +${amount(preview.refund.mass)} mass +0 rare` &&
      preview.drawn.demolish.length === 8,
    `the drag preview: "${preview?.label}", ${preview?.count} belts in drag order, refund ${preview?.refund.mass} mass, ${preview?.drawn.demolish.length} demolish marks drawn`,
    `the demolish drag preview: ${JSON.stringify(preview)} (want 8 targets ${JSON.stringify(beltIds)}, refund ${beltRefund})`,
  );
  const c0 = js(ECON);
  await speed(3);
  await until('the belt line demolished', `!__game.list('building').some((b) => ${JSON.stringify(beltIds)}.includes(b.id))`, 120).catch(() => null);
  await speed(1);
  const c1 = js(ECON);
  const left = js(`__game.list('building')`).filter((bd) => bd.ty === az + 7 && bd.tx >= ax && bd.tx <= ax + 7);
  check(
    !left.length && Math.abs(c1.refund - c0.refund - (preview?.refund.mass ?? NaN)) < 1e-6 && c1.rare - c0.rare === (preview?.refund.rare ?? NaN) && c1.demolished - c0.demolished === 8,
    `after release: every belt tile is empty ground; demolishRefund +${(c1.refund - c0.refund).toFixed(4)} mass +${c1.rare - c0.rare} rare (the preview's ${preview?.refund.mass} mass), demolished +${c1.demolished - c0.demolished}`,
    `after the belt drag: buildings left on the line ${JSON.stringify(left)}, refund ${c1.refund - c0.refund} (preview ${preview?.refund.mass}), rare ${c1.rare - c0.rare}, demolished ${c1.demolished - c0.demolished}`,
  );

  // 5: the core
  const core = ofKind('core')[0];
  camera({ x: core.tx + 1.5, z: core.ty + 5, distance: 26, yaw: 0 });
  await settle([core.tx + 1.5, core.ty + 5]);
  press('Delete');
  await frames(3);
  await click(...Object.values(js(`__game.screenOf('building', ${core.id})`)));
  await until('the hint for the core', `(${BUTTON})?.hint === 'The core cannot be demolished.'`, 10).catch(() => null);
  await frames(8);
  const t5 = js('__game.tool');
  const b5 = js(BUTTON);
  const coreOrders = engs.flatMap((e) => queueOf(e.id)).filter((o) => o.kind === 'demolish');
  const coreLeft = js(`__game.list('building').find((b) => b.id === ${core.id})`);
  check(
    t5.name === 'demolish' && b5?.hint === 'The core cannot be demolished.' && !coreOrders.length && !!coreLeft && !(coreLeft.demolish > 0),
    `a click on the core: no demolish order, the core stands, the tool stays and the hint reads "${b5?.hint}"`,
    `after clicking the core: tool ${t5.name}, hint ${JSON.stringify(b5?.hint)}, demolish orders ${JSON.stringify(coreOrders)}, core ${JSON.stringify(coreLeft)}`,
  );
  press('Escape');
  errorsNow('check-demolish');
}

await h.main(run);
