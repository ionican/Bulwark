// Command validation. Every command from the render thread passes through here before it is
// queued; a rejected command is reported back (never silently dropped). The same checks run
// again when the command is applied, because the state may have changed in between.

import type { Command } from './commands.ts';
import { ALIEN_KINDS, B, BUILDING_KINDS, U, buildingInfo } from './kinds.ts';
import { BF_COMPLETE, BF_UPGRADING } from './schema.ts';
import { BUILD_REQUIRES, RESEARCH, RESEARCH_INDEX, TIER_REQUIRES } from './balance.ts';
import { MAX_ORDERS, type World } from './world.ts';

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const idList = (v: unknown): boolean => Array.isArray(v) && v.every(isInt);

/** Null if the command may be queued, otherwise the reason it is refused. */
export function validateCommand(w: World, cmd: Command): string | null {
  if (!cmd || typeof cmd !== 'object') return 'not a command';
  const problem = check(w, cmd);
  if (problem) return problem;
  // Queued orders: refuse when every unit named already holds a full queue (never drop silently).
  if ('queue' in cmd && cmd.queue && 'ids' in cmd && Array.isArray(cmd.ids) && cmd.ids.length) {
    const full = cmd.ids.every((id) => {
      const s = w.units.slotForId(id);
      return s >= 0 && (w.orders[s]?.length ?? 0) >= MAX_ORDERS;
    });
    if (full) return `order queue full (${MAX_ORDERS} orders per unit)`;
  }
  return null;
}

function check(w: World, cmd: Command): string | null {
  switch (cmd.t) {
    case 'move':
      if (!idList(cmd.ids) || !isNum(cmd.x) || !isNum(cmd.z)) return 'move needs ids and a point';
      return null;
    case 'build':
    case 'place': {
      if (!isInt(cmd.kind) || cmd.kind < 0 || cmd.kind >= BUILDING_KINDS.length) return `unknown building kind ${JSON.stringify(cmd.kind)}`;
      if (!isInt(cmd.tx) || !isInt(cmd.ty)) return 'build needs integer tile coordinates';
      if (cmd.dir !== undefined && (!isInt(cmd.dir) || cmd.dir < 0 || cmd.dir > 3)) return 'dir must be 0..3';
      if (cmd.kind === B.tempTurret) return 'the temporary turret is dropped by an engineer, not built';
      if (cmd.t === 'build') {
        if (!idList(cmd.ids)) return 'build needs unit ids';
        const req = BUILD_REQUIRES[BUILDING_KINDS[cmd.kind]!];
        if (req && !w.researched(req)) return `${buildingInfo(cmd.kind).label} needs research "${RESEARCH[RESEARCH_INDEX[req]!]!.label}"`;
        if (!w.canPlace(cmd.kind, cmd.tx, cmd.ty)) return `${buildingInfo(cmd.kind).label} cannot stand at ${cmd.tx},${cmd.ty}`;
      }
      return null;
    }
    case 'assist':
      if (!idList(cmd.ids) || !isInt(cmd.target)) return 'assist needs ids and a target';
      if (w.buildings.slotForId(cmd.target) < 0) return 'assist target does not exist';
      return null;
    case 'upgrade': {
      if (!idList(cmd.ids) || !isInt(cmd.target)) return 'upgrade needs ids and a target';
      const s = w.buildings.slotForId(cmd.target);
      if (s < 0) return 'upgrade target does not exist';
      return upgradeProblem(w, s);
    }
    case 'reclaim':
      if (!idList(cmd.ids) || !isInt(cmd.wreck)) return 'reclaim needs ids and a wreck';
      if (w.wrecks.slotForId(cmd.wreck) < 0) return 'wreck does not exist';
      return null;
    case 'stop':
      return idList(cmd.ids) ? null : 'stop needs ids';
    case 'dropTurret':
      return isInt(cmd.id) ? null : 'dropTurret needs an engineer id';
    case 'spawn':
      if (!isInt(cmd.kind) || cmd.kind < 0 || cmd.kind >= ALIEN_KINDS.length) return `unknown alien kind ${JSON.stringify(cmd.kind)}`;
      if (!isInt(cmd.entry) || cmd.entry < 0 || cmd.entry >= w.terrain.entries.length) return `unknown entry ${JSON.stringify(cmd.entry)}`;
      if (!isInt(cmd.count) || cmd.count < 1 || cmd.count > 1000) return 'spawn count must be 1..1000';
      return null;
    case 'research': {
      const i = RESEARCH_INDEX[cmd.node as string];
      if (i === undefined) return `unknown research node ${JSON.stringify(cmd.node)}`;
      const node = RESEARCH[i]!;
      if (w.researched(node.id)) return `"${node.label}" is already researched (research cannot be undone or refunded)`;
      if (w.researchQueue.includes(i) || w.researchCurrent === i) return `"${node.label}" is already queued`;
      if (node.requires && !w.researched(node.requires) && !w.researchQueue.includes(RESEARCH_INDEX[node.requires]!) && w.researchCurrent !== RESEARCH_INDEX[node.requires])
        return `"${node.label}" needs "${RESEARCH[RESEARCH_INDEX[node.requires]!]!.label}" first`;
      return null;
    }
    case 'produce': {
      if (!isInt(cmd.id)) return 'produce needs the commander id';
      const s = w.units.slotForId(cmd.id);
      if (s < 0 || w.units.cols.kind[s] !== U.commander) return 'only the commander produces engineers';
      return null;
    }
    case 'callWave':
      return w.nextWave < w.waveTicks.length ? null : 'no waves left to call';
    default:
      return `unknown command ${JSON.stringify((cmd as { t?: unknown }).t)}`;
  }
}

/** Null if building slot s may start its next upgrade now, otherwise why not. */
export function upgradeProblem(w: World, s: number): string | null {
  const c = w.buildings.cols;
  const kind = BUILDING_KINDS[c.kind[s]!]!;
  const info = buildingInfo(c.kind[s]!);
  if (!info.tiers) return `${info.label} has no upgrades`;
  if (!(c.flags[s]! & BF_COMPLETE)) return `${info.label} is not finished`;
  if (c.flags[s]! & BF_UPGRADING) return null;
  const tier = c.tier[s]!;
  if (tier > info.tiers.length) return `${info.label} is already at its top tier`;
  const req = TIER_REQUIRES[kind]?.[tier - 1];
  if (req && !w.researched(req) && !w.debug.allTiers) return `${info.label} tier ${tier + 1} needs research "${RESEARCH[RESEARCH_INDEX[req]!]!.label}"`;
  return null;
}
