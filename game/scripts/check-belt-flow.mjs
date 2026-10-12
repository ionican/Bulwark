#!/usr/bin/env node
// Browser check for W30 (PLAN-W30): belts show their direction of travel, in the sandbox.
//
//   node scripts/check-belt-flow.mjs [--shots <dir>] [--no-build]
//
// Builds this tree (or --no-build) and serves it with `vite preview` on strict port 8842, then
// drives agent-browser (session `w30flow`, 1440 × 900). The belts are laid with real mouse clicks
// and drags, as check-belts.mjs does; `__game` is read to check results, and changes game state
// only through the time controls (pause, speed), the camera pose, one splitter placed by the
// sandbox `place` debug command (for its close-up), and the two negative controls.
//
//   1  on free ground near the core: an L of belt (4 tiles east, then 6 south, the corner the first
//      tile of the second leg) and a 3-tile line running into the second leg from its east side,
//      laid by drags with the builders selected by clicks, built at 3×; the builders sent off the
//      site by a right-click (so nothing but the belts moves in the sampled pixels); the corner, the
//      join and a straight are drawn with the corner, join and straight models
//   2  __game.beltFlow(), sampled every frame at 1×: the drawn straight, corner and join meshes share
//      the renderer's scrolling texture; each frame its offset moves in the −v sense by exactly
//      min(frame seconds × speed, 0.04) × 10/6 tiles (W31 Slow; W30: min(… × 4, 0.2)), the frame
//      time from the frame timestamps; paused, the phase and the offset do not move
//   3  rendered motion: the canvas pixels over a straight tile and over the corner tile (a plain
//      render, __game.debugRender.capture) differ between two running samples and are identical
//      between two paused samples (W31: each rectangle spans a whole tile along the belt, the Slow
//      chevron period, so a chevron is always inside it)
//   4  the same at 10×, on consecutive frames: every step is above 0 and at most 0.067 tile, the
//      offset's forward move per frame is under half the 1-tile Slow chevron period (so the pattern
//      cannot look still or reversed), and consecutive frames' pixels differ
//   5  chevron orientation, from the texture's canvas as drawn: one chevron per tile (Slow), and along the
//      centre column each chevron's leading edge is at higher v than the same chevron's arm near the
//      belt's edge (the tip points the way the belt runs)
//   6  negative controls: with debugRender.beltFlowFrozen the running checks of 2 and 3 fail; with
//      debugRender.beltFlowReversed the direction check of 2 fails. The script asserts it catches both
//   7  a splitter's surface does not scroll; close-ups w30-belt-straight.png, w30-belt-corner.png,
//      w30-belt-join.png, w30-splitter.png; 0 console errors throughout
// It always stops its server and closes only its own session.
//
// W31: belts have three speeds; the bar's Slow entry lays these, so the checks read the Slow surface
// (__game.beltFlow(…, 1)): one capped game-time delta a frame, g = min(frame seconds × speed, 0.04),
// moves the Slow phase g × 10/6 tiles (at most 0.067), and every speed's step is g × its tiles a
// second (checked each frame); the Slow texture has one chevron a tile (a 1-tile period).
// scripts/check-belt-speeds.mjs checks the three speeds side by side.

import { harness } from './harness.mjs';

const h = harness({ name: 'check-belt-flow', port: 8842, session: 'w30flow' });
const { note, check, ab, js, frames, until, click, drag, shiftDown, shiftUp, press, clickEl, camera, buildings, units, speed, selectUnit, selectedUnitIds, errorsNow, shot, load } = h;

/** W31: tiles a second per belt speed (index = tier), the cap on the frame's shared game-time delta (anim.ts BELT_FLOW_MAX_G). */
const TPS = [0, 10 / 6, 2.5, 10 / 3];
const MAX_G = 0.04;
/** The Slow belt's speed, its largest step a frame and its chevron period (tiles): one chevron a tile. */
const TILES_PER_SECOND = TPS[1];
const MAX_STEP = MAX_G * TILES_PER_SECOND;
const PERIOD = 1;
const CHEVRONS = 1;
/** Top of the belt surface above the tile's base (buildings.ts BELT_SURFACE_Y). */
const SURFACE_Y = 0.25;

const tileScreen = (x, z) => js(`__game.worldToScreen(${x + 0.5}, ${z + 0.5})`);
const modelsAt = (x, z) => js(`__game.beltModelAt(${x}, ${z})`);
const away = () => ab('mouse', 'move', '30', '450');
const mod = (a, m) => ((a % m) + m) % m;

/**
 * A free site near the core, found in the page: the box from (x0 − 1, z0 − 1) to (x0 + 8, z0 + 6)
 * is open ground with no building and no unit on it.
 */
const SITE = `(() => {
  const g = __game;
  const occ = new Set();
  const bs = g.list('building');
  for (const b of bs) for (let j = 0; j < b.fh; j++) for (let i = 0; i < b.fw; i++) occ.add((b.tx + i) + ',' + (b.ty + j));
  const ok = (x, z) => !occ.has(x + ',' + z) && g.tileInfo(x + 0.5, z + 0.5).type === 'ground';
  const core = bs.find((b) => b.kindName === 'core');
  const us = g.list('unit');
  for (let r = 5; r < 40; r++)
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x0 = core.tx + dx;
        const z0 = core.ty + dz;
        let good = true;
        for (let z = z0 - 1; z <= z0 + 6 && good; z++) for (let x = x0 - 1; x <= x0 + 8 && good; x++) if (!ok(x, z)) good = false;
        if (good && us.some((u) => u.x >= x0 - 1 && u.x <= x0 + 9 && u.z >= z0 - 1 && u.z <= z0 + 7)) good = false;
        if (good) return { x0, z0 };
      }
  return null;
})()`;

/** `n` frames of __game.beltFlow() (no texture), each with its frame timestamp, speed and pause state. */
const FLOW = (n) => `(async () => {
  const out = [];
  await new Promise((res) => {
    let k = 0;
    const f = (now) => {
      const s = __game.beltFlow(false, 1);
      out.push({ now, g: s.g, steps: s.steps, phase: s.phase, step: s.step, straight: s.straight && s.straight.offsetY, corner: s.corner && s.corner.offsetY, join: s.join && s.join.offsetY, shared: s.shared, speed: __game.speed, paused: __game.paused });
      if (++k >= ${n}) res(); else requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  return out;
})()`;

/** Mean and largest per-pixel luminance difference of each rectangle between two plain renders `gap` frames apart. */
const PIX = (rects, gap) => `(async () => {
  const rects = ${JSON.stringify(rects)};
  const cap = () => rects.map((r) => __game.debugRender.capture(r));
  const a = cap();
  await new Promise((res) => { let k = 0; const f = () => (++k >= ${gap} ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const b = cap();
  return a.map((x, i) => {
    let sum = 0, max = 0;
    for (let j = 0; j < x.data.length; j++) { const d = Math.abs(x.data[j] - b[i].data[j]); sum += d; if (d > max) max = d; }
    return { n: x.data.length, mean: sum / Math.max(1, x.data.length), max };
  });
})()`;

/**
 * The running-flow check on frame samples: every frame (after the first) a shared texture drawn on
 * the straight and the corner (and the join), a Slow step of exactly min(frame seconds × speed, 0.04)
 * × 10/6, above 0, every speed's step g × its tiles a second (W31), and the offset moved forward (−v)
 * by the Slow step mod 1. Returns the problems found.
 */
function flowProblems(s) {
  const bad = [];
  for (let k = 1; k < s.length; k++) {
    const p = s[k - 1];
    const c = s[k];
    if (!c.shared || c.straight === null || c.corner === null) bad.push(`frame ${k}: straight and corner do not share the scrolling texture (${JSON.stringify(c)})`);
    else if (c.straight !== c.corner || (c.join !== null && c.join !== c.straight)) bad.push(`frame ${k}: offsets differ: straight ${c.straight}, corner ${c.corner}, join ${c.join}`);
    const want = Math.min(((c.now - p.now) / 1000) * c.speed, MAX_G) * TILES_PER_SECOND;
    const ratio = c.steps.map((st, i) => st - c.g * TPS[i + 1]);
    if (ratio.some((d) => Math.abs(d) > 1e-9)) bad.push(`frame ${k}: steps ${c.steps.map((x) => x.toFixed(4)).join(' / ')} are not g ${c.g} × 10/6, 2.5, 10/3`);
    if (!(c.step > 0)) bad.push(`frame ${k}: step ${c.step} (not forward)`);
    if (Math.abs(c.step - want) > 1e-6) bad.push(`frame ${k}: step ${c.step.toFixed(4)}, want ${want.toFixed(4)} (${(c.now - p.now).toFixed(1)} ms at ${c.speed}×)`);
    const moved = mod(p.straight - c.straight, 1);
    if (Math.min(Math.abs(moved - mod(want, 1)), 1 - Math.abs(moved - mod(want, 1))) > 1e-6) bad.push(`frame ${k}: the offset moved ${moved.toFixed(4)} in the −v sense, want ${want.toFixed(4)}`);
  }
  return bad;
}

/** Paused: no frame moves the phase or the offset. */
function stillProblems(s) {
  const bad = [];
  for (let k = 1; k < s.length; k++) {
    const p = s[k - 1];
    const c = s[k];
    if (c.step !== 0 || c.phase !== p.phase || c.straight !== p.straight || c.corner !== p.corner) bad.push(`frame ${k}: step ${c.step}, phase ${p.phase} → ${c.phase}, offset ${p.straight} → ${c.straight}`);
  }
  return bad;
}

/** Screen rectangle (CSS px) round world point (x, z) on the belt surface, ±rx tiles along x and ±rz along z. */
function rectAt(x, z, rx, rz = rx) {
  const y = js(`__game.terrainInfo.height(${x}, ${z})`) + SURFACE_Y;
  const pts = [[-rx, -rz], [rx, -rz], [rx, rz], [-rx, rz]].map(([dx, dz]) => js(`__game.worldToScreen(${x + dx}, ${z + dz}, ${y})`));
  return { x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) };
}

/** Rendered motion over the straight and the corner: differ between two running samples `gap` frames apart. */
function motionProblems(rects, gap) {
  const d = js(PIX(rects, gap));
  const names = ['straight', 'corner'];
  return {
    d,
    bad: d.flatMap((x, i) => (x.n > 50 && x.mean > 0.3 && x.max >= 4 ? [] : [`${names[i]}: ${x.n} px, mean difference ${x.mean.toFixed(3)}, largest ${x.max.toFixed(1)}`])),
  };
}

async function setPaused(want) {
  if (js('__game.paused') !== want) js('(__game.control.pause(), true)');
  await until(`paused ${want}`, `__game.paused === ${want}`, 10);
  await frames(6);
}

async function run() {
  await load('/?sandbox=1');
  ab('errors', '--clear');
  ab('console', '--clear');

  // 1: the site, the belts by drags
  const site = js(SITE);
  if (!site) throw new Error('no free 10 × 8 site near the core');
  const { x0, z0 } = site;
  const leg1 = [[x0, z0], [x0 + 3, z0]];
  const leg2 = [[x0 + 4, z0], [x0 + 4, z0 + 5]];
  const side = [[x0 + 7, z0 + 3], [x0 + 5, z0 + 3]];
  const corner = [x0 + 4, z0];
  const join = [x0 + 4, z0 + 3];
  const straight = [x0 + 1, z0];
  const want = [
    ...[0, 1, 2, 3].map((k) => [x0 + k, z0, 0]),
    ...[0, 1, 2, 3, 4, 5].map((k) => [x0 + 4, z0 + k, 1]),
    ...[5, 6, 7].map((k) => [x0 + k, z0 + 3, 2]),
  ];
  note(`site ${x0},${z0}: leg 1 ${leg1.join(' → ')} east, leg 2 ${leg2.join(' → ')} south (corner ${corner}), a line ${side.join(' → ')} west into ${join}`);
  camera({ x: x0 + 4, z: z0 + 5, distance: 24, yaw: 0 });
  await frames(10);
  const us = units();
  const cmdr = us.find((u) => u.kindName === 'commander');
  const engs = us.filter((u) => u.kindName === 'engineer');
  await selectUnit(cmdr.id);
  for (const e of engs) await selectUnit(e.id, true);
  await clickEl('.bar button[data-kind="belt"][data-tier="1"]');
  await drag(tileScreen(...leg1[0]), tileScreen(...leg1[1]), 10);
  shiftDown();
  await drag(tileScreen(...leg2[0]), tileScreen(...leg2[1]), 10);
  await drag(tileScreen(...side[0]), tileScreen(...side[1]), 10);
  shiftUp();
  await frames(5);
  press('Escape');
  const at = () => new Map(buildings().filter((b) => b.kindName === 'belt').map((b) => [`${b.tx},${b.ty}`, b]));
  await until('the belt sites', `__game.list('building').filter((b) => b.kindName === 'belt').length >= ${want.length}`, 15);
  const sites = at();
  const wrong = want.filter(([x, z, d]) => sites.get(`${x},${z}`)?.dir !== d);
  check(!wrong.length, `${want.length} belt sites laid by drags, each pointing along its leg`, `belt sites missing or wrongly turned: ${JSON.stringify(wrong)}`);
  await speed(3);
  const tiles = JSON.stringify(want.map(([x, z]) => [x, z]));
  await until('the belts built', `(() => { const m = new Map(__game.list('building').filter((b) => b.kindName === 'belt').map((b) => [b.tx + ',' + b.ty, b])); return ${tiles}.every(([x, z]) => m.get(x + ',' + z)?.complete); })()`, 240);
  await speed(1);
  // a splitter for its close-up, clear of the belts (its sides at z0 + 4 and z0 + 6 are free)
  const sp = [x0 + 1, z0 + 5];
  const placed = js(`(async () => await __game.place('splitter', ${sp[0]}, ${sp[1]}, 0))()`);
  if (!placed?.ok) throw new Error(`the splitter refused: ${JSON.stringify(placed)}`);
  await until('the splitter built', `__game.list('building').some((b) => b.kindName === 'splitter' && b.tx === ${sp[0]} && b.ty === ${sp[1]} && b.complete)`, 30);
  // the builders off the site: a right-click on open ground 4 tiles west of it
  const off = js(`(() => { const occ = new Set(); for (const b of __game.list('building')) for (let j = 0; j < b.fh; j++) for (let i = 0; i < b.fw; i++) occ.add((b.tx + i) + ',' + (b.ty + j)); for (let d = 4; d < 12; d++) for (const [x, z] of [[${x0} - d, ${z0} + 3], [${x0} + 4, ${z0} + 6 + d], [${x0} + 8 + d, ${z0} + 1]]) if (!occ.has(x + ',' + z) && __game.tileInfo(x + 0.5, z + 0.5).type === 'ground') return [x, z]; return null; })()`);
  if (!off) throw new Error('no open ground to send the builders to');
  camera({ x: (x0 + 4 + off[0]) / 2, z: (z0 + 3 + off[1]) / 2 + 2, distance: 30, yaw: 0 });
  await frames(8);
  if (selectedUnitIds().length < 1 + engs.length) {
    await selectUnit(cmdr.id);
    for (const e of engs) await selectUnit(e.id, true);
  }
  const op = tileScreen(...off);
  await click(op.x, op.y, 'right');
  const clear = `__game.list('unit').every((u) => u.x < ${x0 - 1.5} || u.x > ${x0 + 9.5} || u.z < ${z0 - 1.5} || u.z > ${z0 + 7.5})`;
  const cleared = await until('the builders off the site', clear, 60).catch(() => false);
  check(!!cleared, `the builders sent off the site by a right-click on ${off}`, `units still on the site: ${JSON.stringify(units().map((u) => [u.kindName, u.x.toFixed(1), u.z.toFixed(1)]))}`);
  away();
  camera({ x: x0 + 3.5, z: z0 + 4.5, distance: 13, yaw: 0 });
  await frames(10);
  const shapes = { corner: modelsAt(...corner), join: modelsAt(...join), straight: modelsAt(...straight) };
  check(
    JSON.stringify(shapes) === JSON.stringify({ corner: ['beltCornerR'], join: ['beltJoinL'], straight: ['belt'] }),
    `the corner ${corner} drawn beltCornerR, the join ${join} beltJoinL, ${straight} straight`,
    `drawn shapes: ${JSON.stringify(shapes)}`,
  );

  // 2: the drawn texture's offset, every frame at 1×
  await setPaused(false);
  const run1 = js(FLOW(40));
  const p1 = flowProblems(run1);
  const moved1 = run1[run1.length - 1].phase - run1[0].phase;
  check(!p1.length, `1×: straight, corner and join share the Slow scrolling texture; over ${run1.length - 1} frames each step = min(frame s × speed, 0.04) × 10/6, the three speeds' steps g × 10/6, 2.5, 10/3, and the offset moved forward by it (phase +${moved1.toFixed(3)})`, `1× flow: ${p1.slice(0, 4).join('; ')} (${p1.length} problems)`);
  await setPaused(true);
  const still = js(FLOW(20));
  const ps = stillProblems(still);
  check(!ps.length && still.length === 20, `paused: phase and offset still over ${still.length - 1} frames (phase ${still[0].phase.toFixed(4)})`, `paused flow: ${ps.slice(0, 4).join('; ')}`);

  // 3: rendered motion
  // W31: the Slow texture has one chevron a tile, so a small patch can hold no chevron for most of a
  // tile's travel; each rectangle spans a whole tile along the belt (the straight runs along x) so a
  // chevron is always inside it
  const rects = [rectAt(straight[0] + 0.5, straight[1] + 0.5, 0.5, 0.18), rectAt(corner[0] + 0.5, corner[1] + 0.5, 0.42)];
  note(`pixel rectangles: straight ${JSON.stringify(rects[0])}, corner ${JSON.stringify(rects[1])}`);
  const still2 = js(PIX(rects, 4));
  check(still2.every((x) => x.n > 50 && x.max === 0), `paused: the pixels over the straight and the corner are identical 4 frames apart (${still2.map((x) => `${x.n} px`).join(', ')})`, `paused pixels changed: ${JSON.stringify(still2)}`);
  await setPaused(false);
  const m1 = motionProblems(rects, 4);
  check(!m1.bad.length, `1×: the pixels over the straight and the corner change while running (mean differences ${m1.d.map((x) => x.mean.toFixed(2)).join(', ')})`, `1× rendered motion: ${m1.bad.join('; ')}`);

  // 4: 10×, consecutive frames
  js('(__game.control.speed(10), true)');
  await until('speed 10', '__game.speed === 10', 10);
  await frames(5);
  const run10 = js(FLOW(30));
  const p10 = flowProblems(run10);
  const apparent = run10.slice(1).map((c, k) => mod(run10[k].straight - c.straight, PERIOD));
  const alias = apparent.filter((a) => !(a > 1e-6 && a < PERIOD / 2));
  check(
    !p10.length && !alias.length,
    `10×: every frame steps above 0 and at most ${MAX_STEP.toFixed(3)} (largest ${Math.max(...run10.slice(1).map((c) => c.step)).toFixed(3)}), the pattern moves forward ${Math.min(...apparent).toFixed(3)}–${Math.max(...apparent).toFixed(3)} tile a frame (under half the ${PERIOD}-tile period)`,
    `10× flow: ${[...p10.slice(0, 3), ...alias.slice(0, 3).map((a) => `apparent move ${a.toFixed(3)}`)].join('; ')}`,
  );
  const m10 = motionProblems(rects, 1);
  check(!m10.bad.length, `10×: the pixels over the straight and the corner change from one frame to the next (mean differences ${m10.d.map((x) => x.mean.toFixed(2)).join(', ')})`, `10× rendered motion: ${m10.bad.join('; ')}`);
  js('(__game.control.speed(1), true)');
  await until('speed 1', '__game.speed === 1', 10);

  // 5: chevron orientation from the texture as drawn
  const tex = js('__game.beltFlow(true, 1).texture');
  const orient = orientation(tex);
  check(orient.ok, `chevrons: ${orient.msg}`, `chevron orientation: ${orient.msg}`);

  // 6: negative controls
  js('__game.debugRender.beltFlowFrozen(true)');
  await frames(4);
  const fz = flowProblems(js(FLOW(20)));
  const fzPix = motionProblems(rects, 4);
  js('__game.debugRender.beltFlowFrozen(false)');
  check(fz.length > 0 && fzPix.bad.length === 2, `negative control: with the phase frozen the 1× flow check fails (${fz.length} problems, e.g. ${fz[0]}) and so does the rendered-motion check on both tiles`, `negative control (frozen) not caught: flow problems ${fz.length}, motion ${JSON.stringify(fzPix)}`);
  js('__game.debugRender.beltFlowReversed(true)');
  await frames(4);
  const rv = flowProblems(js(FLOW(20)));
  js('__game.debugRender.beltFlowReversed(false)');
  const rvDir = rv.filter((m) => /moved|not forward/.test(m));
  check(rvDir.length > 0, `negative control: with the phase reversed the direction check fails (${rvDir.length} problems, e.g. ${rvDir[0]})`, `negative control (reversed) not caught: ${JSON.stringify(rv.slice(0, 3))}`);
  await frames(4);
  const back = flowProblems(js(FLOW(15)));
  check(!back.length, 'after the controls the flow check passes again', `after the controls: ${back.slice(0, 3).join('; ')}`);

  // 7: the splitter and the close-ups
  camera({ x: sp[0] + 0.5, z: sp[1] + 0.8, distance: 7, yaw: 0 });
  await frames(8);
  const sf = js('__game.beltFlow(false, 1)');
  check(sf.splitterScrolls === false, 'the splitter is drawn and its surface does not scroll', `splitter: ${JSON.stringify(sf.splitterScrolls)}`);
  await shot('w30-splitter.png');
  camera({ x: straight[0] + 1, z: straight[1] + 0.8, distance: 7, yaw: 0 });
  await frames(8);
  await shot('w30-belt-straight.png');
  camera({ x: corner[0], z: corner[1] + 1, distance: 7, yaw: 0 });
  await frames(8);
  await shot('w30-belt-corner.png');
  camera({ x: join[0] + 1.5, z: join[1] + 0.8, distance: 7, yaw: 0 });
  await frames(8);
  await shot('w30-belt-join.png');
  errorsNow('check-belt-flow');
}

/**
 * Chevrons from the texture's luminance columns (row r is v = r / h): cleat rows are the brighter
 * bands. CHEVRONS bands per tile down the centre column (W31 Slow: one; W30's belt had two); each
 * band in the centre column starts after (at higher v than) the nearest band in the column near the
 * belt's edge, by less than a quarter tile.
 */
function orientation(t) {
  if (!t || !t.centre?.length || !t.edge?.length) return { ok: false, msg: `no texture read: ${JSON.stringify(t)?.slice(0, 200)}` };
  const all = [...t.centre, ...t.edge];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const cut = lo + (hi - lo) * 0.75;
  const starts = (col) => col.flatMap((v, r) => (v > cut && col[(r - 1 + col.length) % col.length] <= cut ? [r] : []));
  const c = starts(t.centre);
  const e = starts(t.edge);
  if (c.length !== CHEVRONS || e.length !== CHEVRONS) return { ok: false, msg: `bands: centre ${JSON.stringify(c)}, edge ${JSON.stringify(e)} (want ${CHEVRONS} each)` };
  const H = t.h;
  const lead = c.map((r) => {
    const d = e.map((s) => ((r - s + H + H / 2) % H) - H / 2);
    return d.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
  });
  const ok = lead.every((d) => d > 0 && d < H / 4);
  return { ok, msg: `${c.length} chevrons a tile (rows ${c.join(', ')} of ${H}); each tip ${lead.map((d) => `${d} rows (${(d / H).toFixed(3)} tile)`).join(' and ')} further along +v than its arm near the edge` };
}

await h.main(run);
