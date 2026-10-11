// The run 2b performance gate's verdict on the workload, one sample per second of the measured
// window (scripts/check-render.mjs MEASURE_JS records them). Pure: tested in test/w24r2b-review-gate.
//
// Each sample: `s` (second), `d` (activity frames in that second: beaming, firing, shots,
// attacking, doorOpening, doorClosing), `cov` (per kind [drawn, in snapshot]), `alive` (aliens),
// `ungrouped` (drawn meshes with no entity group), and `frame`, the frame the sample was inspected
// on: its snapshot `tick`, whether the game was `paused`, the draw `calls` and `triangles` the scene
// pass submitted (renderer.info), and the least it had to submit for the meshes the scene graph
// holds (`floorCalls`, `floorTriangles`: render/inspect.ts submissionFloor).
//
// W24 review (2026-10-09): the workload must be live and drawn. A paused game, a snapshot held
// (tick not advancing between samples), or a scene pass that submitted less than the drawn meshes
// need fails the gate, as well as the coverage and activity rules the gate had before.

/**
 * Problems with a window of samples (empty: the workload passes). `zoomOut`: every entity of every
 * kind must be drawn; otherwise at least 100 aliens, 15 turrets, 10 engineers and the commander,
 * and every kind in `buildingKinds` and `aliens` at least once.
 */
export function judgeSamples(window, { zoomOut, aliens, turrets, buildingKinds, minAlive = 150, doors = true }) {
  const problems = [];
  let prevTick = null;
  for (const x of window) {
    const c = (k) => x.cov[k]?.[0] ?? 0;
    const sum = (ks) => ks.reduce((a, k) => a + c(k), 0);
    if (zoomOut) {
      const short = Object.entries(x.cov).filter(([, [cov, ent]]) => cov < ent).map(([k, [cov, ent]]) => `${k} ${cov}/${ent}`);
      if (short.length) problems.push(`second ${x.s}: workload not visible (not all drawn: ${short.join(', ')})`);
    } else {
      const miss = [];
      if (sum(aliens) < 100) miss.push(`aliens ${sum(aliens)} < 100`);
      if (sum(turrets) < 15) miss.push(`turrets ${sum(turrets)} < 15`);
      if (c('engineer') < 10) miss.push(`engineers ${c('engineer')} < 10`);
      if (c('commander') < 1) miss.push('no commander');
      const kinds = [...buildingKinds, ...aliens].filter((k) => c(k) < 1);
      if (kinds.length) miss.push(`not drawn: ${kinds.join(', ')}`);
      if (miss.length) problems.push(`second ${x.s}: workload not visible (${miss.join('; ')})`);
    }
    if (x.ungrouped.length) problems.push(`second ${x.s}: drawn meshes with no entity group: ${x.ungrouped.join(', ')}`);
    if (x.alive < minAlive) problems.push(`second ${x.s}: ${x.alive} aliens alive (< ${minAlive})`);
    const idle = ['beaming', 'firing', 'attacking', 'shots'].filter((k) => !(x.d[k] > 0));
    if (idle.length) problems.push(`second ${x.s}: scene not active (no visible ${idle.join(', ')})`);
    const f = x.frame;
    if (!f) {
      problems.push(`second ${x.s}: no frame record (tick, pause state, scene-pass submissions)`);
      prevTick = null;
      continue;
    }
    if (f.paused) problems.push(`second ${x.s}: game paused`);
    if (prevTick !== null && !(f.tick > prevTick)) problems.push(`second ${x.s}: simulation not advancing (tick ${f.tick} after ${prevTick})`);
    prevTick = f.tick;
    if (!(f.calls >= f.floorCalls && f.triangles >= f.floorTriangles))
      problems.push(`second ${x.s}: scene pass submitted ${f.calls} draw calls / ${f.triangles} triangles, fewer than the ${f.floorCalls} / ${f.floorTriangles} the drawn meshes need`);
  }
  if (doors) {
    const d = window.reduce((a, x) => [a[0] + x.d.doorOpening, a[1] + x.d.doorClosing], [0, 0]);
    if (!(d[0] > 0 && d[1] > 0)) problems.push(`scene not active: door opening frames ${d[0]}, closing frames ${d[1]} in the window`);
  }
  return problems;
}

// W24 run 3 (criterion 10): the worker timing window's verdict (src/workerWindow.ts report). The
// game camera's window fails a tick-weighted median of 50 ms or more per tick (the 20 Hz budget),
// fewer than 8 ticks per second of window, or any figure missing or not finite.
const WORKER_KEYS = ['medianTickMs', 'maxTickMs', 'encodeMedianMs', 'ticks', 'seconds'];

/** Problems with a worker timing report (empty: it passes). */
export function judgeWorkerWindow(report) {
  if (!report || typeof report !== 'object') return ['no worker timing report'];
  const problems = [];
  for (const k of WORKER_KEYS) if (!Number.isFinite(report[k])) problems.push(`worker window: ${k} missing or not finite (${report[k]})`);
  if (problems.length) return problems;
  if (report.medianTickMs >= 50) problems.push(`worker window: median ${report.medianTickMs.toFixed(2)} ms per tick (≥ 50 ms)`);
  if (report.ticks < 8 * report.seconds) problems.push(`worker window: ${report.ticks} ticks in ${report.seconds.toFixed(1)} s (fewer than 8 per second)`);
  return problems;
}
