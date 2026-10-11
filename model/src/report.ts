// Builds model/out/report.html: one self-contained page of inline SVG line charts.
// Series are told apart by line style, marker shape and a direct label at the line end,
// never by colour: every line is near-black on white.
import type { RunResult, TickRow } from './sim.ts';
import type { StorageVariant, Wave } from './types.ts';
import { mmss, outcomeCell } from './summary.ts';

export interface ReportRun {
  strategy: string;
  description: string;
  variant: StorageVariant;
  rows: TickRow[];
  result: RunResult;
}

interface Series {
  label: string;
  points: [number, number][];
  dash: string;
  marker: 'circle' | 'triangle';
  lost?: number;
}

const W = 440;
const H = 180;
const PAD = { l: 52, r: 118, t: 32, b: 30 };
const INK = '#1a1a1a';
const GRID = '#d9d9d9';
const SAMPLE_TICKS = 50; // one point per 5 s of game time

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtAxis = (v: number) => (v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v >= 10 ? `${Math.round(v)}` : `${Number(v.toFixed(1))}`);

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function markerPath(kind: 'circle' | 'triangle', x: number, y: number): string {
  if (kind === 'circle') return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="#fff" stroke="${INK}" stroke-width="1.4"/>`;
  return `<path d="M${x.toFixed(1)},${(y - 4).toFixed(1)} L${(x + 3.8).toFixed(1)},${(y + 3).toFixed(1)} L${(x - 3.8).toFixed(1)},${(y + 3).toFixed(1)} Z" fill="${INK}"/>`;
}

function chart(title: string, series: Series[], tMax: number, waves?: Wave[], yFixedMax?: number): string {
  const yMaxRaw = yFixedMax ?? Math.max(1, ...series.flatMap((s) => s.points.map((p) => p[1])));
  const yMax = yFixedMax ?? niceMax(yMaxRaw);
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (t: number) => PAD.l + (t / tMax) * iw;
  const y = (v: number) => PAD.t + ih - (Math.min(v, yMax) / yMax) * ih;
  const o: string[] = [];
  o.push(`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">`);
  o.push(`<text x="${PAD.l}" y="13" font-size="12" font-weight="600" fill="${INK}">${esc(title)}</text>`);
  for (const f of [0, 0.5, 1]) {
    const yy = y(yMax * f);
    o.push(`<line x1="${PAD.l}" x2="${PAD.l + iw}" y1="${yy}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`);
    o.push(`<text x="${PAD.l - 6}" y="${yy + 4}" font-size="10" text-anchor="end" fill="${INK}">${fmtAxis(yMax * f)}</text>`);
  }
  for (let m = 0; m * 60 <= tMax; m += 10) {
    const xx = x(m * 60);
    o.push(`<line x1="${xx}" x2="${xx}" y1="${PAD.t + ih}" y2="${PAD.t + ih + 4}" stroke="${INK}"/>`);
    o.push(`<text x="${xx}" y="${PAD.t + ih + 15}" font-size="10" text-anchor="middle" fill="${INK}">${m}</text>`);
  }
  o.push(`<text x="${PAD.l + iw}" y="${H - 2}" font-size="9" text-anchor="end" fill="${INK}">game minute</text>`);
  if (waves) {
    for (const w of waves) {
      const xx = x(w.at);
      o.push(`<line x1="${xx}" x2="${xx}" y1="${PAD.t}" y2="${PAD.t + 5}" stroke="${INK}" stroke-width="1"/>`);
      if (w.n % 2 === 1 || w.n === 20) o.push(`<text x="${xx}" y="${PAD.t - 4}" font-size="8" text-anchor="middle" fill="${INK}">w${w.n}</text>`);
    }
  }
  const ends: { y: number; s: Series; last: [number, number] }[] = [];
  for (const s of series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
    o.push(`<path d="${d}" fill="none" stroke="${INK}" stroke-width="1.5" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/>`);
    // A marker every 5 game minutes, offset by series so the two shapes do not sit on top of each other.
    const offset = s.marker === 'circle' ? 0 : 150;
    for (const p of s.points) if ((Math.round(p[0]) - offset) % 300 === 0 && p[0] > 0) o.push(markerPath(s.marker, x(p[0]), y(p[1])));
    const last = s.points[s.points.length - 1];
    ends.push({ y: y(last[1]), s, last });
    if (s.lost !== undefined) {
      const lx = x(last[0]);
      const ly = y(last[1]);
      o.push(`<path d="M${lx - 5},${ly - 5} L${lx + 5},${ly + 5} M${lx - 5},${ly + 5} L${lx + 5},${ly - 5}" stroke="${INK}" stroke-width="2.2"/>`);
    }
  }
  // Direct labels at the right edge, nudged apart if they would overlap.
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
  for (const e of ends) {
    const label = e.s.lost !== undefined ? `${e.s.label}, lost ${mmss(e.s.lost)}` : e.s.label;
    o.push(`<text x="${PAD.l + iw + 12}" y="${e.y + 3}" font-size="9.5" fill="${INK}">${esc(label)}</text>`);
  }
  o.push('</svg>');
  return o.join('');
}

function sample(rows: TickRow[], pick: (r: TickRow) => number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < rows.length; i += SAMPLE_TICKS) pts.push([rows[i].time, pick(rows[i])]);
  if (rows.length && (rows.length - 1) % SAMPLE_TICKS !== 0) pts.push([rows[rows.length - 1].time, pick(rows[rows.length - 1])]);
  return pts;
}

export function buildReport(mapName: string, waves: Wave[], runs: ReportRun[]): string {
  const strategies = [...new Set(runs.map((r) => r.strategy))];
  const tMax = Math.ceil(Math.max(...runs.map((r) => r.result.endTime)) / 600) * 600;
  const style = (v: StorageVariant) => (v === 'uncapped' ? { dash: '', marker: 'circle' as const } : { dash: '6 4', marker: 'triangle' as const });
  const series = (rs: ReportRun[], pick: (r: TickRow) => number): Series[] =>
    rs.map((r) => ({
      label: r.variant,
      points: sample(r.rows, pick),
      ...style(r.variant),
      lost: r.result.outcome === 'lost' ? r.result.endTime : undefined,
    }));

  const sections = strategies.map((s) => {
    const rs = runs.filter((r) => r.strategy === s);
    const desc = rs[0].description;
    const outcomes = rs.map((r) => `<li><strong>${r.variant}</strong>: ${esc(outcomeCell(r.result))}</li>`).join('');
    const charts = [
      chart('Mass in pool', series(rs, (r) => r.pool.mass), tMax),
      chart('Energy in pool', series(rs, (r) => r.pool.energy), tMax),
      chart('Rare material in pool', series(rs, (r) => r.pool.rare), tMax),
      chart('Threat on field (alien HP)', series(rs, (r) => r.threatHp), tMax, waves),
      chart('Commander HP', series(rs, (r) => r.commanderHp), tMax, undefined, rs[0].result.commanderMaxHp),
      chart('Advanced parts in stock', series(rs, (r) => r.parts), tMax),
    ].join('\n');
    return `<section><h2>${esc(s)}</h2><p>${esc(desc)}</p><ul>${outcomes}</ul><div class="grid">${charts}</div></section>`;
  });

  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><title>Bulwark W12 economy model</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:24px;color:${INK};background:#fff;max-width:1300px}
h1{font-size:20px;margin:0 0 8px} h2{font-size:16px;margin:28px 0 4px;border-top:1px solid ${GRID};padding-top:12px}
p,li{font-size:13px;line-height:1.45} .grid{display:flex;flex-wrap:wrap;gap:8px 16px}
.key{display:flex;gap:24px;align-items:center;font-size:13px;margin:8px 0 4px} .key svg{vertical-align:middle}
</style></head><body>
<h1>Bulwark W12: economy and wave pacing, ${esc(mapName)}</h1>
<p>Pool resources, threat on the field, commander HP and advanced-part stock over game time for each strategy, under both storage variants. Small ticks marked w1, w3 … on the threat chart are wave starts. A cross marks the moment the commander died. Generated by <code>npm run model</code>.</p>
<div class="key">
<span><svg width="60" height="14"><line x1="2" x2="58" y1="7" y2="7" stroke="${INK}" stroke-width="1.5"/>${markerPath('circle', 30, 7)}</svg> uncapped: solid line, open circles</span>
<span><svg width="60" height="14"><line x1="2" x2="58" y1="7" y2="7" stroke="${INK}" stroke-width="1.5" stroke-dasharray="6 4"/>${markerPath('triangle', 30, 8)}</svg> capped: dashed line, filled triangles</span>
<span><svg width="16" height="14"><path d="M3,2 L13,12 M3,12 L13,2" stroke="${INK}" stroke-width="2.2"/></svg> commander killed</span>
</div>
${sections.join('\n')}
</body></html>
`;
}
