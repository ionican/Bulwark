// Per-tick CSV writer. Fixed column order and fixed number formatting, so the same run is the same bytes.
import type { TickRow } from './sim.ts';

const n = (x: number): string => (Number.isFinite(x) ? String(Number(x.toFixed(3))) : 'inf');

export const CSV_COLUMNS = [
  'tick', 'time_s', 'wave',
  'pool_mass', 'pool_energy', 'pool_rare',
  'income_mass', 'income_energy', 'income_rare',
  'spend_mass', 'spend_energy', 'spend_rare',
  'wasted_mass', 'wasted_energy', 'wasted_rare',
  'cap_mass', 'cap_energy', 'cap_rare',
  'build_efficiency', 'limiting_resource', 'builds_active', 'builds_slowed',
  'engineers', 'reclaiming_engineers', 'wreck_salvage', 'depot_salvage', 'advanced_parts',
  'aliens_on_field', 'threat_hp', 'defence_damage_per_s', 'heavy_cannons_dry', 'energy_upkeep_ratio',
  'commander_hp', 'defences_standing',
] as const;

export function rowsToCsv(rows: TickRow[]): string {
  const out: string[] = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    out.push(
      [
        r.tick, n(r.time), r.wave,
        n(r.pool.mass), n(r.pool.energy), n(r.pool.rare),
        n(r.income.mass), n(r.income.energy), n(r.income.rare),
        n(r.spend.mass), n(r.spend.energy), n(r.spend.rare),
        n(r.wasted.mass), n(r.wasted.energy), n(r.wasted.rare),
        n(r.cap.mass), n(r.cap.energy), n(r.cap.rare),
        n(r.buildEfficiency), r.limiting, r.buildsActive, r.buildsSlowed,
        r.engineers, r.reclaimers, n(r.wrecks), n(r.depotSalvage), n(r.parts),
        r.aliens, n(r.threatHp), n(r.defenceDps), r.heavyDry, n(r.energyUpkeepRatio),
        n(r.commanderHp), r.defences,
      ].join(','),
    );
  }
  return out.join('\n') + '\n';
}
