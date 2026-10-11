// Benchmark bookkeeping: per-frame samples for one held camera position, summarised into a row,
// and the results table as plain text (what "Copy results" puts on the clipboard). W22 adds the
// drawing strategy and kinds, scene and shadow draw calls measured separately, CPU time split
// into turret instance updates and render submission, and a comparison table over strategies.
//
//   fps avg      frames / seconds held (frame intervals from requestAnimationFrame timestamps)
//   1% low      1000 / the 99th-percentile frame interval (ms)
//   CPU ms       JavaScript time inside the frame callback (simulation, matrices, render
//                submission); not GPU time
//   draw calls, triangles  renderer.info over every pass of the frame (shadow map, scene,
//                post-processing), averaged
//   scene / shadow calls   renderer.info counted inside the render pass less the shadow map, and
//                inside the shadow map (WebGLShadowMap.render wrapped), averaged
//   update ms    JavaScript time writing turret instance data (matrices, glow, icon cells)
//   submit ms    JavaScript time inside the render call (shadow, scene and post passes; includes
//                BatchedMesh's per-object draw lists and WebGL call overhead), not GPU time

export interface Sample {
  interval: number;
  cpu: number;
  calls: number;
  triangles: number;
  levels: number[];
  culled: number;
  aliensDrawn: number;
  aliensAlive: number;
  shells: number;
  particles: number;
  turretDraws: number;
  updates: number;
  sceneCalls?: number;
  shadowCalls?: number;
  updateMs?: number;
  submitMs?: number;
  kindsVisible?: number;
}

export interface Row {
  segment: string;
  seconds: number;
  frames: number;
  fpsAvg: number;
  fpsLow1: number;
  cpuAvg: number;
  cpuP95: number;
  frameMsAvg: number;
  frameMsP99: number;
  calls: number;
  turretDraws: number;
  triangles: number;
  levels: number[];
  culled: number;
  aliensDrawn: number;
  aliensAlive: number;
  shells: number;
  particles: number;
  updates: number;
  sceneCalls: number;
  shadowCalls: number;
  updateMs: number;
  submitMs: number;
  kindsVisible: number;
}

export interface Meta {
  date: string;
  turrets: number;
  aliens: number;
  mode: 'instanced' | 'per-turret meshes';
  quality: string;
  dpr: number;
  /** The pixel ratio was set by ?dpr= rather than the display. */
  dprForced?: boolean;
  canvas: [number, number];
  css: [number, number];
  renderer: string;
  userAgent: string;
  thresholds: readonly number[];
  /** W22: drawing strategy and number of turret kinds in the mix. */
  strategy?: string;
  kinds?: number;
  /** WEBGL_multi_draw present. */
  multiDraw?: boolean;
}

export interface Results {
  meta: Meta;
  rows: Row[];
  text: string;
}

const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const pct = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
};

export function summarise(segment: string, samples: Sample[]): Row {
  const intervals = samples.map((s) => s.interval);
  const seconds = intervals.reduce((x, y) => x + y, 0) / 1000;
  const lv = [0, 1, 2, 3].map((k) => avg(samples.map((s) => s.levels[k] ?? 0)));
  const p99 = pct(intervals, 0.99);
  return {
    segment,
    seconds,
    frames: samples.length,
    fpsAvg: samples.length / Math.max(1e-6, seconds),
    fpsLow1: p99 > 0 ? 1000 / p99 : 0,
    cpuAvg: avg(samples.map((s) => s.cpu)),
    cpuP95: pct(samples.map((s) => s.cpu), 0.95),
    frameMsAvg: avg(intervals),
    frameMsP99: p99,
    calls: avg(samples.map((s) => s.calls)),
    turretDraws: avg(samples.map((s) => s.turretDraws)),
    triangles: avg(samples.map((s) => s.triangles)),
    levels: lv,
    culled: avg(samples.map((s) => s.culled)),
    aliensDrawn: avg(samples.map((s) => s.aliensDrawn)),
    aliensAlive: avg(samples.map((s) => s.aliensAlive)),
    shells: avg(samples.map((s) => s.shells)),
    particles: avg(samples.map((s) => s.particles)),
    updates: avg(samples.map((s) => s.updates)),
    sceneCalls: avg(samples.map((s) => s.sceneCalls ?? 0)),
    shadowCalls: avg(samples.map((s) => s.shadowCalls ?? 0)),
    updateMs: avg(samples.map((s) => s.updateMs ?? 0)),
    submitMs: avg(samples.map((s) => s.submitMs ?? 0)),
    kindsVisible: avg(samples.map((s) => s.kindsVisible ?? 0)),
  };
}

/** Columns shared by the single-run table and the strategy comparison. */
const ROW_COLS: Array<[string, number, (r: Row) => string]> = [
  ['fps avg', 8, (r) => r.fpsAvg.toFixed(1)],
  ['1% low', 7, (r) => r.fpsLow1.toFixed(1)],
  ['CPU ms', 7, (r) => r.cpuAvg.toFixed(2)],
  ['CPU p95', 8, (r) => r.cpuP95.toFixed(2)],
  ['update ms', 10, (r) => r.updateMs.toFixed(2)],
  ['submit ms', 10, (r) => r.submitMs.toFixed(2)],
  ['calls', 6, (r) => r.calls.toFixed(0)],
  ['scene', 6, (r) => r.sceneCalls.toFixed(0)],
  ['shadow', 7, (r) => r.shadowCalls.toFixed(0)],
  ['turret calls', 13, (r) => r.turretDraws.toFixed(0)],
  ['kinds', 6, (r) => r.kindsVisible.toFixed(0)],
  ['triangles', 10, (r) => `${(r.triangles / 1e6).toFixed(2)} M`],
  ['full/mid/simple/icon/off', 25, (r) => `${r.levels.map((v) => v.toFixed(0)).join('/')}/${r.culled.toFixed(0)}`],
  ['aliens drawn', 13, (r) => `${r.aliensDrawn.toFixed(0)}/${r.aliensAlive.toFixed(0)}`],
];

const NOTES = [
  'CPU ms = JavaScript time per frame (simulation, matrices, render submission), average and 95th percentile; not GPU time.',
  'update ms = JavaScript time writing turret instance data; submit ms = JavaScript time inside the render call (all passes).',
  'calls, triangles = renderer.info over all passes (shadow map, scene, post-processing), averaged; scene = draw calls in the render pass less the shadow map; shadow = draw calls in the shadow map.',
  'turret calls = turret batches drawn in the scene pass (a BatchedMesh multi-draw counts once); kinds = turret kinds with a turret in view.',
  'full/mid/simple/icon/off = turrets at each detail level, and outside the view (not drawn); aliens drawn = in view / alive.',
];

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

export function formatResults(meta: Meta, rows: Row[]): string {
  const head = [
    `W22 turret stress benchmark · ${meta.date}`,
    `${meta.turrets} turrets (${meta.mode}${meta.strategy ? `, ${meta.strategy}` : ''}) · ${meta.kinds ?? 1} kind${(meta.kinds ?? 1) > 1 ? 's' : ''} · ${meta.aliens} aliens · quality ${meta.quality} · device pixel ratio ${meta.dpr}${meta.dprForced ? ' (display ratio set by ?dpr=)' : ''} · canvas ${meta.canvas[0]}×${meta.canvas[1]} px (${meta.css[0]}×${meta.css[1]} CSS)`,
    `GPU: ${meta.renderer}${meta.multiDraw === undefined ? '' : ` · WEBGL_multi_draw ${meta.multiDraw ? 'available' : 'not available'}`}`,
    `Detail thresholds (tiles from the camera): full < ${meta.thresholds[0]} · middle < ${meta.thresholds[1]} · simple < ${meta.thresholds[2]} · icon beyond (±8 % hysteresis)`,
    '',
  ];
  const cols: Array<[string, number, (r: Row) => string]> = [
    ['segment', 11, (r) => r.segment],
    ...ROW_COLS,
    ['fps avg', 8, (r) => r.fpsAvg.toFixed(1)],
    ['1% low', 7, (r) => r.fpsLow1.toFixed(1)],
    ['CPU ms', 7, (r) => r.cpuAvg.toFixed(2)],
    ['shells', 7, (r) => r.shells.toFixed(0)],
    ['particles', 10, (r) => r.particles.toFixed(0)],
  ];
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? pad(c, cols[i]![1]) : lpad(c, cols[i]![1]))).join(' ');
  const out = [...head, line(cols.map((c) => c[0])), ...rows.map((r) => line(cols.map((c) => c[2](r))))];
  out.push(
    '',
    'fps avg = frames / seconds held (10 s per segment, camera still, combat running); 1% low = 1000 / 99th-percentile frame interval.',
    ...NOTES,
    `Browser: ${meta.userAgent}`,
  );
  return out.join('\n');
}

/** One table over several strategy runs at the same count and quality (Run all strategies). */
export function formatComparison(runs: Array<{ meta: Meta; rows: Row[] }>): string {
  const m = runs[0]!.meta;
  const head = [
    `W22 strategy comparison · ${m.date}`,
    `${m.turrets} turrets · ${m.kinds ?? 1} kind${(m.kinds ?? 1) > 1 ? 's' : ''} · ${m.aliens} aliens · quality ${m.quality} · device pixel ratio ${m.dpr}${m.dprForced ? ' (display ratio set by ?dpr=)' : ''} · canvas ${m.canvas[0]}×${m.canvas[1]} px (${m.css[0]}×${m.css[1]} CSS)`,
    `GPU: ${m.renderer}${m.multiDraw === undefined ? '' : ` · WEBGL_multi_draw ${m.multiDraw ? 'available' : 'not available'}`}`,
    `Detail thresholds (tiles from the camera): full < ${m.thresholds[0]} · middle < ${m.thresholds[1]} · simple < ${m.thresholds[2]} · icon beyond (±8 % hysteresis)`,
    '',
  ];
  const cols: Array<[string, number, (r: Row & { strategy: string }) => string]> = [
    ['strategy', 26, (r) => r.strategy],
    ['segment', 11, (r) => r.segment],
    ...ROW_COLS,
  ];
  const line = (cells: string[]) => cells.map((c, i) => (i <= 1 ? pad(c, cols[i]![1]) : lpad(c, cols[i]![1]))).join(' ');
  const out = [...head, line(cols.map((c) => c[0]))];
  const segs = runs[0]!.rows.map((r) => r.segment);
  // grouped by camera position, strategies one under another
  segs.forEach((seg, k) => {
    for (const run of runs) {
      const r = run.rows[k];
      if (r) out.push(line(cols.map((c) => c[2]({ ...r, strategy: run.meta.strategy ?? run.meta.mode }))));
    }
    if (k < segs.length - 1) out.push('');
  });
  out.push('', 'fps avg = frames / seconds held (10 s per segment, camera still, combat running); 1% low = 1000 / 99th-percentile frame interval.', ...NOTES, `Browser: ${m.userAgent}`);
  return out.join('\n');
}
