// `npm run model`: runs every strategy under both storage variants, writes per-tick CSVs,
// summary.md and report.html to model/out/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { map1 } from '../data/map1.ts';
import { rowsToCsv } from './csv.ts';
import { buildReport, type ReportRun } from './report.ts';
import { Sim } from './sim.ts';
import { STRATEGIES, balanced } from './strategies.ts';
import { buildSummary, mmss, outcomeCell, type RunRecord, type SensitivityRow } from './summary.ts';
import type { MapData, StorageVariant } from './types.ts';

export const SEED = 20261006;
const VARIANTS: StorageVariant[] = ['uncapped', 'capped'];
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');

/** One-number changes for the sensitivity table. Each returns a modified copy of the map. */
const SENSITIVITY: { label: string; apply: (m: MapData) => void }[] = [
  { label: 'wall-breaker HP −20% (1,200)', apply: (m) => (m.aliens.breaker.hp *= 0.8) },
  { label: 'wall-breaker HP +20% (1,800)', apply: (m) => (m.aliens.breaker.hp *= 1.2) },
  { label: 'wall-breaker armour 20 (from 25)', apply: (m) => (m.aliens.breaker.armour = 20) },
  { label: 'wall-breaker armour 30', apply: (m) => (m.aliens.breaker.armour = 30) },
  { label: 'hunter speed −15% (11 m/s)', apply: (m) => (m.aliens.hunter.speed *= 0.85) },
  { label: 'hunter speed +15% (15 m/s)', apply: (m) => (m.aliens.hunter.speed *= 1.15) },
  { label: 'waves 12–20 counts −15%', apply: (m) => scaleLateWaves(m, 0.85) },
  { label: 'waves 12–20 counts +15%', apply: (m) => scaleLateWaves(m, 1.15) },
  { label: 'mass per extractor 0.8 (from 1)', apply: (m) => (m.buildings.massExtractor.income = { mass: 0.8 }) },
  { label: 'mass per extractor 1.2', apply: (m) => (m.buildings.massExtractor.income = { mass: 1.2 }) },
  { label: 'energy per generator 4 (from 5)', apply: (m) => (m.buildings.generator.income = { energy: 4 }) },
  { label: 'energy per generator 6', apply: (m) => (m.buildings.generator.income = { energy: 6 }) },
  { label: 'rare per point 0.08 (from 0.1)', apply: (m) => (m.buildings.rareExtractor.income = { rare: 0.08 }) },
  { label: 'engineer reclaim rate 2/s (from 3)', apply: (m) => (m.engineer.reclaimRate = 2) },
  { label: 'heavy cannon 2 parts per shot (from 1)', apply: (m) => (m.buildings.heavy.weapon!.partsPerShot = 2) },
  { label: 'storage buildings add half as much', apply: (m) => (m.buildings.storage.storage = { mass: 300, energy: 1500, rare: 30 }) },
];

function scaleLateWaves(m: MapData, f: number): void {
  for (const w of m.waves) if (w.n >= 12) for (const g of w.groups) g.count = Math.round(g.count * f);
}

function main(): void {
  mkdirSync(outDir, { recursive: true });
  const runs: RunRecord[] = [];
  const reportRuns: ReportRun[] = [];
  console.log(`W12 model: ${map1.name}, seed ${SEED}`);
  for (const s of STRATEGIES) {
    for (const v of VARIANTS) {
      const sim = new Sim({ map: map1, strategy: s, storage: v, seed: SEED });
      const result = sim.run();
      const file = join(outDir, `${s.name}-${v}.csv`);
      writeFileSync(file, rowsToCsv(sim.rows));
      runs.push({ strategy: s.name, description: s.description, variant: v, result });
      reportRuns.push({ strategy: s.name, description: s.description, variant: v, rows: sim.rows, result });
      console.log(`  ${s.name.padEnd(10)} ${v.padEnd(8)} ${outcomeCell(result).padEnd(28)} ${sim.rows.length} rows -> out/${s.name}-${v}.csv`);
    }
  }

  const drainComparison = VARIANTS.map((v) => ({
    strategy: balanced.name,
    variant: v,
    perResource: runs.find((r) => r.strategy === balanced.name && r.variant === v)!.result,
    global: new Sim({ map: map1, strategy: balanced, storage: v, seed: SEED, record: false, drain: 'global' }).run(),
  }));

  const names = STRATEGIES.map((s) => s.name);
  const baseline: Record<string, string> = {};
  for (const s of STRATEGIES) baseline[s.name] = outcomeCell(runs.find((r) => r.strategy === s.name && r.variant === 'uncapped')!.result);
  const rows: SensitivityRow[] = SENSITIVITY.map((c) => {
    const m: MapData = structuredClone(map1);
    c.apply(m);
    const outcomes: Record<string, string> = {};
    for (const s of STRATEGIES) outcomes[s.name] = outcomeCell(new Sim({ map: m, strategy: s, storage: 'uncapped', seed: SEED, record: false }).run());
    return { label: c.label, outcomes };
  });
  console.log(`  sensitivity: ${rows.length} changes × ${names.length} strategies`);

  writeFileSync(join(outDir, 'summary.md'), buildSummary({ mapName: map1.name, seed: SEED, runs, drainComparison, sensitivity: { strategies: names, baseline, rows } }));
  writeFileSync(join(outDir, 'report.html'), buildReport(map1.name, map1.waves, reportRuns));
  console.log(`  wrote out/summary.md and out/report.html (longest run ${mmss(Math.max(...runs.map((r) => r.result.endTime)))})`);
}

main();
