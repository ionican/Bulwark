#!/usr/bin/env node
// Browser check for W31 (PLAN-W31): three belt speeds, Slow, Medium and Fast, in the sandbox.
//
//   node scripts/check-belt-speeds.mjs [--shots <dir>] [--no-build]
//
// Builds this tree (or --no-build) and serves it with `vite preview` on strict port 8843, then
// drives agent-browser (session `w31speed`, 1440 × 900). The belts are laid with real mouse clicks
// and drags from the build bar, as check-belt-flow.mjs does. `__game` is read to check results; it
// changes game state only through the time controls, the camera pose, the sandbox commands
// (unlimited resources, builders' build rate, granting research, filling extractor buffers) and the
// debug `place` command for the merger and the extractor.
//
//   1  the build bar has three belt entries (beltSlow, beltMedium, beltFast); with no research
//      Medium and Fast are disabled and say "✕ needs Medium belts" / "✕ needs Fast belts"; `B`
//      picks Slow; after each research is granted its entry is enabled and `B` picks it
//   2  near a mass deposit, one belt line per speed laid by drags from its bar entry: each line
//      runs 8 tiles straight out of the deposit's extractor, then turns (a corner), and a 2-tile
//      side line runs into its second leg (a join); the Fast line runs through a merger (placed
//      by `place`) into its second leg; built at 3×
//   3  per speed, from the drawn meshes: its straight, corner and join tiles draw its own surface
//      material, the merger Fast's (__game.beltSurfaceAt); the texture attached to each speed's
//      surface has 1, 2 and 3 chevrons a tile down its centre column, each pointing the way the
//      belt runs; every frame the three phases step g × 10/6, 2.5 and 10/3 (0.5 : 0.75 : 1) and
//      each speed's offset moves by its step; paused, nothing moves
//   4  crossing durations, from snapshots: the extractor placed and its buffer filled; the tick each
//      of the 8 straight tiles of each line first holds an item; the lead item's time from the
//      first tile to the eighth: Medium / Fast = 4/3 and Slow / Fast = 2, each within 5%
//   5  the upgrade tool (U) dragged along the Slow line with the real mouse: while held, the
//      preview label reads "8 to Medium · 8 mass"; after the engineers finish, every tile of the
//      Slow line reads "Conveyor belt · Medium (2.5 tiles/s)" in the hover readout
//   6  0 console errors; screenshots w31-build-menu.png, w31-belt-slow.png, w31-belt-medium.png,
//      w31-belt-fast.png, w31-upgrade-drag.png
// It always stops its server and closes only its own session (never `close --all`).

import { harness } from './harness.mjs';

const h = harness({ name: 'check-belt-speeds', port: 8843, session: 'w31speed' });
const { note, check, ab, js, frames, until, R, drag, click, shiftDown, shiftUp, press, clickEl, camera, units, speed, selectUnit, selectedUnitIds, errorsNow, shot, load } = h;

const NAMES = ['', 'Slow', 'Medium', 'Fast'];
const SUFFIX = ['', 'slow', 'medium', 'fast'];
const MATERIAL = ['', 'beltSlow', 'beltMedium', 'belt'];
/** Tiles a second and ticks a tile per speed (index = tier). */
const TPS = [0, 10 / 6, 2.5, 10 / 3];
const TICKS = [0, 6, 4, 3];
/** Top of the belt surface above the tile's base (buildings.ts BELT_SURFACE_Y). */
const SURFACE_Y = 0.25;

const tileScreen = (x, z) => js(`__game.worldToScreen(${x + 0.5}, ${z + 0.5})`);
const surfaceScreen = (x, z) => js(`__game.worldToScreen(${x + 0.5}, ${z + 0.5}, __game.terrainInfo.height(${x + 0.5}, ${z + 0.5}) + ${SURFACE_Y})`);
const away = () => ab('mouse', 'move', '30', '450');
const mod = (a, m) => ((a % m) + m) % m;

/** The site box round extractor anchor (ex, ez): x ex − 1 .. ex + 16, z ez − 12 .. ez + 13. */
const BOX = { x0: -1, x1: 16, z0: -12, z1: 13 };

/**
 * A mass deposit near the core with the site box round it open ground, no building and no unit on
 * it (the deposit's own 2 × 2 excepted), found in the page.
 */
const SITE = `(() => {
  const g = __game;
  const occ = new Set();
  const bs = g.list('building');
  for (const b of bs) for (let j = 0; j < b.fh; j++) for (let i = 0; i < b.fw; i++) occ.add((b.tx + i) + ',' + (b.ty + j));
  const core = bs.find((b) => b.kindName === 'core');
  const us = g.list('unit');
  const deps = g.terrainInfo.deposits.filter((d) => d.kind === 'mass').sort((a, b) => Math.hypot(a.tx - core.tx, a.ty - core.ty) - Math.hypot(b.tx - core.tx, b.ty - core.ty));
  for (const d of deps) {
    let good = true;
    for (let z = d.ty + ${BOX.z0}; z <= d.ty + ${BOX.z1} && good; z++)
      for (let x = d.tx + ${BOX.x0}; x <= d.tx + ${BOX.x1} && good; x++) {
        const dep = x >= d.tx && x < d.tx + 2 && z >= d.ty && z < d.ty + 2;
        if (occ.has(x + ',' + z) || (!dep && g.tileInfo(x + 0.5, z + 0.5).type !== 'ground')) good = false;
      }
    if (good && us.some((u) => u.x >= d.tx + ${BOX.x0} && u.x <= d.tx + ${BOX.x1 + 1} && u.z >= d.ty + ${BOX.z0} && u.z <= d.ty + ${BOX.z1 + 1})) good = false;
    if (good) return { ex: d.tx, ez: d.ty };
  }
  return null;
})()`;

/**
 * The three lines round extractor anchor (ex, ez) (dir 0 east, 1 south, 2 west, 3 north): each its
 * drags in order, its 8 measured straight tiles (out of the extractor), and a straight, corner and
 * join tile to inspect.
 */
function layout(ex, ez) {
  const line = (a, b, dir) => {
    const out = [];
    const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    for (let k = 0; k <= n; k++) out.push([a[0] + Math.sign(b[0] - a[0]) * k, a[1] + Math.sign(b[1] - a[1]) * k, dir]);
    return out;
  };
  const lines = [
    {
      tier: 1,
      drags: [[[ex, ez - 1], [ex, ez - 8], 3], [[ex, ez - 9], [ex + 4, ez - 9], 0], [[ex + 2, ez - 11], [ex + 2, ez - 10], 1]],
      straight: [ex, ez - 4],
      corner: [ex, ez - 9],
      join: [ex + 2, ez - 9],
    },
    {
      tier: 2,
      drags: [[[ex + 1, ez + 2], [ex + 1, ez + 9], 1], [[ex + 1, ez + 10], [ex + 5, ez + 10], 0], [[ex + 3, ez + 12], [ex + 3, ez + 11], 3]],
      straight: [ex + 1, ez + 5],
      corner: [ex + 1, ez + 10],
      join: [ex + 3, ez + 10],
    },
    {
      tier: 3,
      drags: [[[ex + 2, ez], [ex + 9, ez], 0], [[ex + 11, ez], [ex + 12, ez], 0], [[ex + 13, ez], [ex + 13, ez + 4], 1], [[ex + 15, ez + 2], [ex + 14, ez + 2], 2]],
      straight: [ex + 5, ez],
      corner: [ex + 13, ez],
      join: [ex + 13, ez + 2],
    },
  ];
  for (const l of lines) {
    l.tiles = l.drags.flatMap(([a, b, d]) => line(a, b, d));
    l.measured = line(...l.drags[0]).map(([x, z]) => [x, z]);
  }
  return { lines, merger: [ex + 10, ez] };
}

/** Each belt entry of the bar: entry id, tier, disabled, its small text. */
const BAR = `[...document.querySelectorAll('.bar button[data-kind="belt"]')].map((b) => ({ entry: b.dataset.entry, tier: Number(b.dataset.tier), disabled: b.disabled, small: b.querySelector('small')?.textContent ?? '', label: b.childNodes[0]?.textContent ?? '' }))`;

/** `n` frames of every speed's belt clock (no texture): frame time, g, phases, steps, the straights' offsets. */
const FLOWS = (n) => `(async () => {
  const out = [];
  await new Promise((res) => {
    let k = 0;
    const f = (now) => {
      const r = [1, 2, 3].map((t) => __game.beltFlow(false, t));
      out.push({ now, g: r[0].g, speed: __game.speed, paused: __game.paused, phases: r.map((x) => x.phase), steps: r.map((x) => x.step), offsets: r.map((x) => x.straight && x.straight.offsetY) });
      if (++k >= ${n}) res(); else requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  return out;
})()`;

/** Running: every frame each speed steps g × its tiles a second (the three 0.5 : 0.75 : 1) and its offset moves by that step in the −v sense. */
function flowProblems(s) {
  const bad = [];
  for (let k = 1; k < s.length; k++) {
    const p = s[k - 1];
    const c = s[k];
    if (c.offsets.some((o) => o === null)) bad.push(`frame ${k}: a speed's straight is not drawn (${JSON.stringify(c.offsets)})`);
    if (!(c.g > 0)) bad.push(`frame ${k}: g ${c.g} (not running)`);
    c.steps.forEach((st, i) => {
      if (Math.abs(st - c.g * TPS[i + 1]) > 1e-9) bad.push(`frame ${k}: ${NAMES[i + 1]} step ${st} is not g ${c.g} × ${TPS[i + 1].toFixed(3)}`);
      const moved = mod(p.offsets[i] - c.offsets[i], 1);
      const want = mod(st, 1);
      if (Math.min(Math.abs(moved - want), 1 - Math.abs(moved - want)) > 1e-6) bad.push(`frame ${k}: ${NAMES[i + 1]} offset moved ${moved.toFixed(4)}, want ${want.toFixed(4)}`);
    });
    const r = c.steps.map((st) => st / c.steps[2]);
    if (Math.abs(r[0] - 0.5) > 1e-9 || Math.abs(r[1] - 0.75) > 1e-9) bad.push(`frame ${k}: step ratio ${r.map((x) => x.toFixed(4)).join(' : ')}`);
  }
  return bad;
}

/** Paused: no speed's phase, step or offset moves. */
function stillProblems(s) {
  const bad = [];
  for (let k = 1; k < s.length; k++) {
    const p = s[k - 1];
    const c = s[k];
    if (c.steps.some((x) => x !== 0) || c.phases.some((x, i) => x !== p.phases[i]) || c.offsets.some((x, i) => x !== p.offsets[i])) bad.push(`frame ${k}: steps ${c.steps}, phases ${p.phases} → ${c.phases}`);
  }
  return bad;
}

/**
 * Chevrons from the luminance columns of a texture as drawn (row r is v = r / h): band starts in the
 * centre column, and each centre band's lead over the nearest band near the edge (the tip points +v,
 * the way the belt runs, by less than half a period).
 */
function chevrons(t) {
  if (!t || !t.centre?.length || !t.edge?.length) return { n: -1, ok: false, msg: `no texture read: ${JSON.stringify(t)?.slice(0, 200)}` };
  const all = [...t.centre, ...t.edge];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const cut = lo + (hi - lo) * 0.75;
  const starts = (col) => col.flatMap((v, r) => (v > cut && col[(r - 1 + col.length) % col.length] <= cut ? [r] : []));
  const c = starts(t.centre);
  const e = starts(t.edge);
  const H = t.h;
  const period = H / Math.max(1, c.length);
  const lead = c.map((r) => (e.length ? e.map((s) => ((r - s + H + H / 2) % H) - H / 2).reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a)) : NaN));
  const ok = c.length === e.length && lead.every((d) => d > 0 && d < period / 2);
  return { n: c.length, ok, msg: `${c.length} chevrons a tile (centre rows ${c.join(', ')} of ${H}; edge rows ${e.join(', ')}; tips ${lead.join(', ')} rows ahead)` };
}

async function setPaused(want) {
  if (js('__game.paused') !== want) js('(__game.control.pause(), true)');
  await until(`paused ${want}`, `__game.paused === ${want}`, 10);
  await frames(6);
}

/** The commander and every engineer selected by clicks. */
async function selectBuilders() {
  const us = units();
  const cmdr = us.find((u) => u.kindName === 'commander');
  const engs = us.filter((u) => u.kindName === 'engineer');
  await selectUnit(cmdr.id);
  for (const e of engs) await selectUnit(e.id, true);
  return 1 + engs.length;
}

/** The builders sent off the site box by a right-click on open ground west of it. */
async function clearSite(ex, ez) {
  const off = js(`(() => { const occ = new Set(); for (const b of __game.list('building')) for (let j = 0; j < b.fh; j++) for (let i = 0; i < b.fw; i++) occ.add((b.tx + i) + ',' + (b.ty + j)); for (let d = 3; d < 20; d++) for (const [x, z] of [[${ex + BOX.x0} - d, ${ez}], [${ex + BOX.x0} - d, ${ez} - 6], [${ex + BOX.x0} - d, ${ez} + 6]]) if (!occ.has(x + ',' + z) && __game.tileInfo(x + 0.5, z + 0.5).type === 'ground') return [x, z]; return null; })()`);
  if (!off) throw new Error('no open ground west of the site to send the builders to');
  camera({ x: (ex + off[0]) / 2, z: ez + 2, distance: 40, yaw: 0 });
  await frames(8);
  const want = js(`__game.list('unit').filter((u) => u.kindName === 'commander' || u.kindName === 'engineer').length`);
  if (selectedUnitIds().length < want) await selectBuilders();
  const p = tileScreen(...off);
  await click(p.x, p.y, 'right');
  const inBox = `(u) => u.x >= ${ex + BOX.x0 - 0.5} && u.x <= ${ex + BOX.x1 + 1.5} && u.z >= ${ez + BOX.z0 - 0.5} && u.z <= ${ez + BOX.z1 + 1.5}`;
  const cleared = await until('the builders off the site', `!__game.list('unit').some(${inBox})`, 90).catch(() => false);
  check(!!cleared, `the builders sent off the site by a right-click on ${off}`, `units still on the site: ${JSON.stringify(units().map((u) => [u.kindName, u.x.toFixed(1), u.z.toFixed(1)]))}`);
  away();
}

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
  if (!site) throw new Error('no mass deposit with an open 18 × 26 site round it');
  const { ex, ez } = site;
  const { lines, merger } = layout(ex, ez);
  note(`site: mass deposit at ${ex},${ez}; Slow line north, Medium south, Fast east through a merger at ${merger}`);

  // 1: the build bar and B
  camera({ x: ex + 6, z: ez + 1, distance: 44, yaw: 0 });
  await frames(10);
  const nBuilders = await selectBuilders();
  await frames(4);
  const bar0 = js(BAR);
  check(
    JSON.stringify(bar0.map((b) => [b.entry, b.tier, b.disabled, b.small.startsWith('✕') ? b.small : ''])) ===
      JSON.stringify([
        ['beltSlow', 1, false, ''],
        ['beltMedium', 2, true, '✕ needs Medium belts'],
        ['beltFast', 3, true, '✕ needs Fast belts'],
      ]),
    `build bar: three belt entries (${bar0.map((b) => `${b.entry} "${b.label.trim()}"${b.disabled ? ` disabled, "${b.small}"` : ' enabled'}`).join('; ')})`,
    `build bar belt entries: ${JSON.stringify(bar0)}`,
  );
  await shot('w31-build-menu.png');
  const pressB = async () => {
    press('b');
    await frames(3);
    const t = js('__game.tool');
    press('Escape');
    await frames(3);
    return t;
  };
  const picks = [await pressB()];
  for (const node of ['beltMedium', 'beltFast']) {
    const r = js(`__game.grantResearch(${JSON.stringify(node)})`);
    if (!r?.ok) throw new Error(`grantResearch ${node}: ${JSON.stringify(r)}`);
    await until(`${node} researched in the bar`, `(${BAR}).filter((b) => !b.disabled).length === ${node === 'beltMedium' ? 2 : 3}`, 10);
    picks.push(await pressB());
  }
  check(
    JSON.stringify(picks.map((t) => [t.kind, t.tier])) === JSON.stringify([['belt', 1], ['belt', 2], ['belt', 3]]),
    `B picks Slow, then Medium after "Medium belts", then Fast after "Fast belts" (tool labels: ${picks.map((t) => JSON.stringify(t.label)).join(', ')})`,
    `B picks: ${JSON.stringify(picks)}`,
  );
  const bar1 = js(BAR);
  check(bar1.every((b) => !b.disabled && !b.small.startsWith('✕')), 'with both researched every belt entry is enabled', `bar after research: ${JSON.stringify(bar1)}`);

  // 2: the lines, by drags from the bar (the first drag replaces the builders' orders, the rest are queued with Shift)
  const placed = js(`(async () => await __game.place('merger', ${merger[0]}, ${merger[1]}, 0))()`);
  if (!placed?.ok) throw new Error(`the merger refused: ${JSON.stringify(placed)}`);
  if (selectedUnitIds().length < nBuilders) await selectBuilders();
  let first = true;
  for (const l of lines) {
    const centre = l.tiles.reduce((a, [x, z]) => [a[0] + x / l.tiles.length, a[1] + z / l.tiles.length], [0, 0]);
    camera({ x: centre[0] + 0.5, z: centre[1] + 1.5, distance: 30, yaw: 0 });
    await frames(8);
    await clickEl(`.bar button[data-entry="belt${NAMES[l.tier]}"]`);
    const tool = js('__game.tool');
    if (tool.kind !== 'belt' || tool.tier !== l.tier) throw new Error(`the ${NAMES[l.tier]} entry chose ${JSON.stringify(tool)}`);
    for (const [a, b] of l.drags) {
      if (!first) shiftDown();
      await drag(tileScreen(...a), tileScreen(...b), 10);
      if (!first) shiftUp();
      first = false;
      await frames(3);
    }
  }
  press('Escape');
  await frames(3);
  const all = lines.flatMap((l) => l.tiles.map(([x, z, d]) => [x, z, d, l.tier]));
  await until('the belt sites', `__game.list('building').filter((b) => b.kindName === 'belt').length >= ${all.length}`, 20);
  const at = () => new Map(js(`__game.list('building')`).filter((b) => b.kindName === 'belt').map((b) => [`${b.tx},${b.ty}`, b]));
  const sites = at();
  const wrong = all.filter(([x, z, d, t]) => sites.get(`${x},${z}`)?.dir !== d || sites.get(`${x},${z}`)?.tier !== t);
  check(!wrong.length, `${all.length} belt sites laid by drags (${lines.map((l) => `${NAMES[l.tier]} ${l.tiles.length}`).join(', ')}), each at its entry's speed and pointing along its leg`, `belt sites missing, wrongly turned or at the wrong speed: ${JSON.stringify(wrong.map(([x, z, d, t]) => [x, z, d, t, sites.get(`${x},${z}`) ? [sites.get(`${x},${z}`).dir, sites.get(`${x},${z}`).tier] : null]))}`);
  await speed(3);
  const tiles = JSON.stringify(all.map(([x, z]) => [x, z]));
  await until('the belts built', `(() => { const m = new Map(__game.list('building').filter((b) => b.kindName === 'belt').map((b) => [b.tx + ',' + b.ty, b])); return ${tiles}.every(([x, z]) => m.get(x + ',' + z)?.complete); })()`, 300);
  await speed(1);
  await clearSite(ex, ez);

  // 3: per-speed render from the drawn meshes
  camera({ x: ex + 6, z: ez + 1, distance: 40, yaw: 0 });
  await frames(10);
  const surfaceProblems = [];
  for (const l of lines)
    for (const role of ['straight', 'corner', 'join']) {
      const got = js(`__game.beltSurfaceAt(${l[role][0]}, ${l[role][1]})`);
      const want = `${SUFFIX[l.tier]}:${MATERIAL[l.tier]}-cut`;
      if (got.length !== 1 || got[0] !== want) surfaceProblems.push(`${NAMES[l.tier]} ${role} ${l[role]}: ${JSON.stringify(got)}, want ${want}`);
    }
  const mergerSurface = js(`__game.beltSurfaceAt(${merger[0]}, ${merger[1]})`);
  if (mergerSurface.length !== 1 || mergerSurface[0] !== 'fast:belt-cut') surfaceProblems.push(`merger: ${JSON.stringify(mergerSurface)}, want fast:belt-cut`);
  const shapes = lines.map((l) => ({ corner: js(`__game.beltModelAt(${l.corner[0]}, ${l.corner[1]})`), join: js(`__game.beltModelAt(${l.join[0]}, ${l.join[1]})`), straight: js(`__game.beltModelAt(${l.straight[0]}, ${l.straight[1]})`) }));
  shapes.forEach((s, i) => {
    if (!s.corner.some((m) => m.startsWith('beltCorner')) || !s.join.some((m) => m.startsWith('beltJoin')) || !s.straight.includes('belt')) surfaceProblems.push(`${NAMES[lines[i].tier]} shapes ${JSON.stringify(s)}`);
  });
  const flows = [1, 2, 3].map((t) => js(`__game.beltFlow(true, ${t})`));
  flows.forEach((f, i) => {
    if (!f.shared || f.corner === null || f.join === null || f.material !== `${MATERIAL[i + 1]}-cut`) surfaceProblems.push(`${NAMES[i + 1]} beltFlow: material ${f.material}, shared ${f.shared}, straight ${JSON.stringify(f.straight)}, corner ${JSON.stringify(f.corner)}, join ${JSON.stringify(f.join)}`);
  });
  check(!surfaceProblems.length, `each speed's straight, corner and join draw its own surface (${lines.map((l) => `${NAMES[l.tier]} ${SUFFIX[l.tier]}:${MATERIAL[l.tier]}-cut`).join(', ')}), one scrolling texture a speed; the merger draws Fast's (${mergerSurface})`, `per-speed surfaces: ${surfaceProblems.join('; ')}`);
  const chev = flows.map((f) => chevrons(f.texture));
  check(
    chev.map((c) => c.n).join(',') === '1,2,3' && chev.every((c) => c.ok),
    `chevrons on the textures as drawn: ${chev.map((c, i) => `${NAMES[i + 1]} ${c.msg}`).join('; ')}`,
    `chevrons: ${chev.map((c, i) => `${NAMES[i + 1]} ${c.msg}${c.ok ? '' : ' (orientation wrong)'}`).join('; ')}`,
  );
  await setPaused(false);
  const run1 = js(FLOWS(40));
  const p1 = flowProblems(run1);
  const adv = [0, 1, 2].map((i) => run1[run1.length - 1].phases[i] - run1[0].phases[i]);
  check(
    !p1.length,
    `running at 1×: over ${run1.length - 1} frames each speed steps g × 10/6, 2.5, 10/3 and its offset moves by that step; phases advanced ${adv.map((a) => a.toFixed(3)).join(' / ')} (${adv.map((a) => (a / adv[2]).toFixed(3)).join(' : ')})`,
    `running flow: ${p1.slice(0, 4).join('; ')} (${p1.length} problems)`,
  );
  await setPaused(true);
  const still = js(FLOWS(20));
  const ps = stillProblems(still);
  check(!ps.length && still.length === 20, `paused: no speed's phase or offset moves over ${still.length - 1} frames`, `paused flow: ${ps.slice(0, 4).join('; ')}`);
  await setPaused(false);

  // close-ups of each speed's corner and join
  for (const l of lines) {
    camera({ x: (l.corner[0] + l.join[0]) / 2 + 0.5, z: (l.corner[1] + l.join[1]) / 2 + 1.5, distance: 9, yaw: 0 });
    await frames(8);
    await shot(`w31-belt-${SUFFIX[l.tier]}.png`);
  }

  // 4: crossing durations from snapshots: the sampler starts before the extractor is placed
  camera({ x: ex + 6, z: ez + 1, distance: 40, yaw: 0 });
  await frames(6);
  const measured = Object.fromEntries(lines.map((l) => [l.tier, l.measured]));
  const cross = js(`(async () => {
    const tiles = ${JSON.stringify(measured)};
    const first = {};
    for (const k in tiles) first[k] = tiles[k].map(() => -1);
    let last = -1, maxGap = 0, samples = 0;
    let done = false;
    const sample = () => {
      const tick = __game.tick;
      if (tick !== last) {
        if (last >= 0) maxGap = Math.max(maxGap, tick - last);
        last = tick;
        samples++;
        const at = new Map(__game.list('building').filter((b) => b.kindName === 'belt').map((b) => [b.tx + ',' + b.ty, b]));
        for (const k in tiles) tiles[k].forEach(([x, z], i) => { if (first[k][i] < 0 && at.get(x + ',' + z)?.item > 0) first[k][i] = tick; });
      }
    };
    const loop = () => { sample(); if (!done) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const r = [await __game.place('massExtractor', ${ex}, ${ez}, 0), await __game.fillBuffers()];
    const t0 = performance.now();
    while (performance.now() - t0 < 15000 && Object.values(first).some((f) => f[f.length - 1] < 0)) await new Promise((res) => setTimeout(res, 100));
    await new Promise((res) => setTimeout(res, 200));
    done = true;
    return { refused: r.filter((x) => !x.ok).map((x) => x.reason), first, maxGap, samples };
  })()`);
  if (cross.refused.length) throw new Error(`extractor or fillBuffers refused: ${cross.refused.join('; ')}`);
  const dur = [1, 2, 3].map((t) => {
    const f = cross.first[t];
    return f[0] >= 0 && f[7] >= 0 ? f[7] - f[0] : NaN;
  });
  const mf = dur[1] / dur[2];
  const sf = dur[0] / dur[2];
  check(
    Math.abs(mf / (4 / 3) - 1) <= 0.05 && Math.abs(sf / 2 - 1) <= 0.05,
    `crossing durations over 7 tiles (first to eighth tile, lead item, from ${cross.samples} snapshots, largest tick gap ${cross.maxGap}): Slow ${dur[0]}, Medium ${dur[1]}, Fast ${dur[2]} ticks (want ${TICKS.slice(1).map((t) => 7 * t).join(', ')}); Medium / Fast ${mf.toFixed(3)} (4/3), Slow / Fast ${sf.toFixed(3)} (2)`,
    `crossing durations: Slow ${dur[0]}, Medium ${dur[1]}, Fast ${dur[2]} ticks; Medium / Fast ${mf}, Slow / Fast ${sf}; first-arrival ticks ${JSON.stringify(cross.first)}; largest tick gap ${cross.maxGap}`,
  );

  // 5: the upgrade tool dragged along the Slow line (Shift held: the tool stays for the next drag)
  const slow = lines[0];
  camera({ x: ex + 2.5, z: ez - 4, distance: 30, yaw: 0 });
  await frames(8);
  await selectBuilders();
  press('u');
  await frames(3);
  const ut = js('__game.tool');
  if (ut.name !== 'upgrade') throw new Error(`U chose ${JSON.stringify(ut)}`);
  shiftDown();
  const [[a0, b0]] = slow.drags;
  const pa = tileScreen(...a0);
  const pb = tileScreen(...b0);
  ab('mouse', 'move', R(pa.x), R(pa.y));
  ab('mouse', 'down', 'left');
  for (let k = 1; k <= 10; k++) ab('mouse', 'move', R(pa.x + ((pb.x - pa.x) * k) / 10), R(pa.y + ((pb.y - pa.y) * k) / 10));
  await frames(4);
  const preview = js('__game.dragPreview');
  await shot('w31-upgrade-drag.png');
  ab('mouse', 'up', 'left');
  await frames(3);
  check(
    preview?.kind === 'upgrade' && preview.label === '8 to Medium · 8 mass' && preview.toMedium === 8 && preview.build.length === 8,
    `upgrade drag along the Slow line's first leg: the preview reads "${preview?.label}" over ${preview?.build.length} tiles`,
    `upgrade drag preview: ${JSON.stringify(preview)}`,
  );
  for (const [a, b] of slow.drags.slice(1)) await drag(tileScreen(...a), tileScreen(...b), 8);
  shiftUp();
  await frames(3);
  press('Escape');
  const slowTiles = JSON.stringify(slow.tiles.map(([x, z]) => [x, z]));
  await speed(3);
  await until('the Slow line upgraded', `(() => { const m = new Map(__game.list('building').filter((b) => b.kindName === 'belt').map((b) => [b.tx + ',' + b.ty, b])); return ${slowTiles}.every(([x, z]) => m.get(x + ',' + z)?.tier === 2 && m.get(x + ',' + z)?.state === 'complete'); })()`, 240).catch(() => null);
  await speed(1);
  await clearSite(ex, ez);
  camera({ x: ex + 2.5, z: ez - 5, distance: 24, yaw: 0 });
  await frames(10);
  const reads = [];
  for (const [x, z] of slow.tiles) {
    const p = surfaceScreen(x, z);
    ab('mouse', 'move', R(p.x + 1), R(p.y));
    await frames(2);
    ab('mouse', 'move', R(p.x), R(p.y));
    await frames(4);
    const hv = await until(`the hover readout at ${x},${z}`, `(() => { const h = __game.siteHover; const b = __game.list('building').find((b) => b.tx === ${x} && b.ty === ${z}); return h.visible && b && h.id === b.id ? h : null; })()`, 10).catch(() => null);
    reads.push([x, z, hv?.lines[0] ?? null]);
  }
  away();
  const notMedium = reads.filter(([, , l]) => l !== 'Conveyor belt · Medium (2.5 tiles/s)');
  check(!notMedium.length, `after the upgrade every one of the Slow line's ${reads.length} tiles reads "Conveyor belt · Medium (2.5 tiles/s)" in the hover readout`, `hover readouts not Medium: ${JSON.stringify(notMedium)}`);
  errorsNow('check-belt-speeds');
}

await h.main(run);
