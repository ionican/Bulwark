// W24 run 2a, criterion 1: render code is snapshot-only. Walks the import graph of every module
// under src/render (value imports only: `import type` and type-only specifiers are erased) and
// checks that the only simulation modules it reaches are the pure data ones — kinds, balance,
// schema, table, terrain, rng — never the world, the systems that step it, the command handling,
// saves or the snapshot encoder. Also checks that render code never imports look/ (the workshop is
// ported, not depended on) and that the two gate helpers the renderer re-derives agree with sim/.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AXIS_X, AXIS_Z, gateDepth } from '../src/sim/gate.ts';
import { GATE_AXIS_Z, gateDepthOf } from '../src/render/wallLayout.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
// W24 run 3: tuning.ts joins the list. Its value imports are kinds.ts and balance.ts only; the D2
// readout (render/siteReadout.ts) reads build power through its unitBuildRate, as the plan requires,
// rather than re-deriving the multipliers.
const PURE_SIM = new Set(['sim/kinds.ts', 'sim/balance.ts', 'sim/schema.ts', 'sim/table.ts', 'sim/terrain.ts', 'sim/rng.ts', 'sim/tuning.ts']);

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Value imports of a module (relative specifiers resolved to absolute paths; bare ones kept). */
export function valueImports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s+from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)|(?:^|\n)\s*import\s+'([^']+)'/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const spec = m[3] ?? m[4] ?? m[5]!;
    const clause = m[2] ?? '';
    if (m[1] && /^type\s/.test(clause)) continue; // import type … / export type …
    if (m[1] && /^\{[\s\S]*\}$/.test(clause.trim())) {
      // { a, type B }: erased if every specifier is a type
      const names = clause.trim().slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
      if (names.length && names.every((n) => n.startsWith('type '))) continue;
    }
    out.push(spec.startsWith('.') ? resolve(dirname(file), spec) : spec);
  }
  return out;
}

describe('criterion 1: render code imports nothing from the simulation that mutates state', () => {
  const roots = filesUnder(join(SRC, 'render'));
  const seen = new Set<string>();
  const reachedFrom = new Map<string, string>();
  const stack = [...roots];
  for (const r of roots) reachedFrom.set(r, '(render)');
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of valueImports(f)) {
      if (!dep.startsWith('/')) continue; // a package
      if (!reachedFrom.has(dep)) reachedFrom.set(dep, f);
      if (dep.endsWith('.ts') && !seen.has(dep)) stack.push(dep);
    }
  }
  const reached = [...seen].map((f) => relative(SRC, f));

  it('walks every render module (the walk itself works)', () => {
    expect(roots.length).toBeGreaterThan(30);
    expect(reached).toContain('render/models.ts');
    expect(reached).toContain('render/workshop/kit/kit.ts');
    expect(reached).toContain('sim/kinds.ts');
  });

  it('reaches only the pure simulation modules', () => {
    const sim = reached.filter((f) => f.startsWith('sim/'));
    const bad = sim.filter((f) => !PURE_SIM.has(f)).map((f) => `${f} (from ${relative(SRC, reachedFrom.get(join(SRC, f))!)})`);
    expect(bad).toEqual([]);
    for (const f of ['sim/world.ts', 'sim/snapshot.ts', 'sim/worker.ts', 'sim/runner.ts', 'sim/save.ts', 'sim/gate.ts', 'sim/sandbox.ts']) expect(reached).not.toContain(f);
  });

  it('nothing in the render graph is outside game/ except the W12 model data', () => {
    const outside = [...seen].map((f) => relative(SRC, f)).filter((f) => f.startsWith('..') && !f.startsWith('../../model/'));
    expect(outside).toEqual([]);
  });

  it('the gate axis and depth the renderer derives agree with the simulation', () => {
    expect(GATE_AXIS_Z).toBe(AXIS_Z);
    expect(AXIS_X).toBe(0);
    for (const [fw, fh] of [[3, 1], [3, 4], [1, 3], [4, 3], [3, 3]] as const)
      for (const dir of [AXIS_X, AXIS_Z]) expect(gateDepthOf(fw, fh, dir)).toBe(gateDepth(fw, fh, dir));
  });
});
