// Command validation. Every command from the render thread passes through here before it is
// queued; a rejected command is reported back (never silently dropped). The same checks run
// again when the command is applied, because the state may have changed in between.
// W31: a belt's tier is its speed. `build` and `place` take a tier for belts only (integer 1..3;
// `allTiers` lifts only the research check, never this). A build at a speed whose research is not
// done is refused naming it. Tier is part of reserved-site identity (queue.ts header). The
// drag-upgrade command's plan (planBeltUpgrades) is made here and reused when it applies.

import { SANDBOX_COMMANDS, type Command } from './commands.ts';
import { ALIEN_KINDS, B, BELT_TOP_TIER, BUILDING_KINDS, U, beltUpgradeSkip, buildingInfo, isBeltTier, tierName } from './kinds.ts';
import { BF_COMPLETE, BF_UPGRADING, isReserved } from './schema.ts';
import { BUILD_REQUIRES, MAX_RUN_DEPTH, RESEARCH, RESEARCH_INDEX, SPAWN_AT_MAX, tierRequires } from './balance.ts';
import { MAX_ORDERS, type World } from './world.ts';
import { newSites, planRun, runById, runCapacityProblem } from './runs.ts';
import { planGate } from './gate.ts';
import { spawnPlaces } from './sandbox.ts';
import { dequeueIndex, heldReservedSite, replacementProblem, worldSiteSource } from './queue.ts';
import { TUNE_TARGETS, tuneFieldProblem, tuneProblem, type TuneTarget } from './tuning.ts';
import { map1 } from '../../../model/data/map1.ts';

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const idList = (v: unknown): boolean => Array.isArray(v) && v.every(isInt);
const tile = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && isInt(v[0]) && isInt(v[1]);

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
  if (SANDBOX_COMMANDS.has(cmd.t) && w.scenario !== 'sandbox') return `${cmd.t} is a sandbox command (this game is ${w.scenario})`;
  switch (cmd.t) {
    case 'move':
      if (!idList(cmd.ids) || !isNum(cmd.x) || !isNum(cmd.z)) return 'move needs ids and a point';
      return null;
    case 'build':
    case 'place': {
      if (!isInt(cmd.kind) || cmd.kind < 0 || cmd.kind >= BUILDING_KINDS.length) return `unknown building kind ${JSON.stringify(cmd.kind)}`;
      if (!isInt(cmd.tx) || !isInt(cmd.ty)) return 'build needs integer tile coordinates';
      if (cmd.dir !== undefined && (!isInt(cmd.dir) || cmd.dir < 0 || cmd.dir > 3)) return 'dir must be 0..3';
      const placedBy = buildingInfo(cmd.kind).placedBy;
      if (placedBy) return placedBy;
      if (cmd.tier !== undefined) {
        if (cmd.kind !== B.belt) return `only belts take a tier (${buildingInfo(cmd.kind).label} got tier ${JSON.stringify(cmd.tier)})`;
        if (!isBeltTier(cmd.tier)) return `belt tier must be an integer 1..${BELT_TOP_TIER} (got ${JSON.stringify(cmd.tier)})`;
      }
      const tier = cmd.tier ?? 1;
      if (cmd.t === 'build') {
        if (!idList(cmd.ids)) return 'build needs unit ids';
        const req = BUILD_REQUIRES[BUILDING_KINDS[cmd.kind]!];
        if (req && !w.researched(req)) return `${buildingInfo(cmd.kind).label} needs research "${RESEARCH[RESEARCH_INDEX[req]!]!.label}"`;
        const tierReq = tierRequires('belt', tier);
        if (tierReq && !w.researched(tierReq) && !w.debug.allTiers) return `${tierName(B.belt, tier)} belts need research "${RESEARCH[RESEARCH_INDEX[tierReq]!]!.label}"`;
        // run 3 C2: an unshifted build on the issuers' own reserved site of exactly this kind, anchor
        // and direction; W31: at another belt speed, the issuers' own site is replaced (queue.ts)
        if (!w.canPlace(cmd.kind, cmd.tx, cmd.ty) && heldReservedSite(worldSiteSource(w), cmd.ids, cmd.kind, cmd.tx, cmd.ty, cmd.dir ?? 0, cmd.queue ?? false) < 0)
          return otherSpeedSite(w, cmd.kind, cmd.tx, cmd.ty, tier) ?? `${buildingInfo(cmd.kind).label} cannot stand at ${cmd.tx},${cmd.ty}`;
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
    case 'upgradeBelts': {
      const plan = planBeltUpgrades(w, cmd);
      w.validated = { cmd, result: plan }; // the apply step and the runner's report reuse it
      return typeof plan === 'string' ? plan : null;
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
    case 'buildRun': {
      if (!idList(cmd.ids)) return 'buildRun needs unit ids';
      if (!tile(cmd.from) || !tile(cmd.to)) return 'buildRun needs integer tiles from: [tx, ty] and to: [tx, ty]';
      if (!isInt(cmd.depth) || cmd.depth < 1 || cmd.depth > MAX_RUN_DEPTH) return `run depth must be 1..${MAX_RUN_DEPTH}`;
      const plan = planRun(w, cmd);
      w.validated = { cmd, result: plan }; // the apply step and the worker reuse it
      if (typeof plan === 'string') return plan;
      if (plan.tiles.length === 0) return `nothing to build: all ${plan.skipped.total} tiles skipped (rock ${plan.skipped.rock}, wall ${plan.skipped.wall}, blocked ${plan.skipped.blocked})`;
      const full = runCapacityProblem(w, newSites(plan));
      // run 3 C3: without Shift, what the replaced orders release counts (queue.ts replacementProblem)
      return full && !cmd.queue ? replacementProblem(w, cmd, plan) : full;
    }
    case 'cancelRun':
      if (!isInt(cmd.run)) return 'cancelRun needs a run id';
      return runById(w, cmd.run) ? null : `no run ${cmd.run}`;
    case 'dequeue': {
      if (!isInt(cmd.id)) return 'dequeue needs a unit id';
      const s = w.units.slotForId(cmd.id);
      if (s < 0) return `unit ${cmd.id} does not exist`;
      if (!isInt(cmd.order) || cmd.order < 1) return `dequeue needs an order id, an integer 1 or more (got ${JSON.stringify(cmd.order)})`;
      if (dequeueIndex(w, s, cmd.order) >= 0) return null;
      // Ids come from one counter (world.ts nextOrderId): below it, the order existed once.
      return cmd.order < w.nextOrderId ? `order ${cmd.order} is no longer in unit ${cmd.id}'s queue (completed or removed)` : `no order ${cmd.order}`;
    }
    case 'clearQueue': {
      if (!idList(cmd.ids) || !cmd.ids.length) return 'clearQueue needs unit ids';
      const missing = cmd.ids.find((id) => w.units.slotForId(id) < 0);
      return missing === undefined ? null : `unit ${missing} does not exist`;
    }
    case 'gate': {
      if (!idList(cmd.ids)) return 'gate needs unit ids';
      if (!isInt(cmd.tx) || !isInt(cmd.ty)) return 'gate needs integer tile coordinates';
      if (cmd.axis !== undefined && cmd.axis !== 'x' && cmd.axis !== 'z') return "gate axis must be 'x' or 'z'";
      const g = planGate(w, cmd.tx, cmd.ty, cmd.axis);
      return g.ok ? null : `gate at ${cmd.tx},${cmd.ty} refused: ${g.reason}`;
    }
    case 'spawnAt': {
      if (!isInt(cmd.kind) || cmd.kind < 0 || cmd.kind >= ALIEN_KINDS.length) return `unknown alien kind ${JSON.stringify(cmd.kind)}`;
      if (!isNum(cmd.x) || !isNum(cmd.z)) return 'spawnAt needs a point x, z';
      if (!isInt(cmd.count) || cmd.count < 1 || cmd.count > SPAWN_AT_MAX) return `spawnAt count must be 1..${SPAWN_AT_MAX}`;
      const p = spawnPlaces(w, cmd.kind, cmd.x, cmd.z, cmd.count);
      w.validated = { cmd, result: p };
      return typeof p === 'string' ? p : null;
    }
    case 'tune':
      return tuneProblem(cmd.target, cmd.kind, cmd.field, cmd.mult);
    case 'tuneReset':
      if (cmd.target === undefined) return cmd.kind === undefined ? null : 'tuneReset with a kind needs a target';
      if (!TUNE_TARGETS.includes(cmd.target as TuneTarget)) return `tune target must be one of ${TUNE_TARGETS.join(', ')}`;
      return cmd.kind === undefined ? null : tuneFieldProblem(cmd.target, cmd.kind, 'hp');
    case 'setUnlimited':
      return typeof cmd.on === 'boolean' ? null : 'setUnlimited needs on: true or false';
    case 'grantResearch':
      if (cmd.all === true) return null;
      if (RESEARCH_INDEX[cmd.node as string] === undefined) return `unknown research node ${JSON.stringify(cmd.node)}`;
      return null;
    case 'startWave': {
      if (!isInt(cmd.index) || cmd.index < 0 || cmd.index >= map1.waves.length) return `wave index must be 0..${map1.waves.length - 1}`;
      const n = map1.waves[cmd.index]!.groups.reduce((sum, g) => sum + g.count, 0);
      const used = w.aliens.count + w.pendingSpawns;
      if (used + n > w.aliens.capacity) return `the alien table would overflow (${w.aliens.count} aliens + ${w.pendingSpawns} waiting to spawn + ${n} in wave ${cmd.index} > ${w.aliens.capacity})`;
      return null;
    }
    case 'repair': {
      if (!idList(cmd.ids) || !isInt(cmd.target)) return 'repair needs ids and a target';
      const s = w.buildings.slotForId(cmd.target);
      if (s < 0) return 'repair target does not exist';
      return repairProblem(w, s);
    }
    case 'damage': {
      if (!isInt(cmd.target) || !isNum(cmd.amount) || cmd.amount <= 0) return 'damage needs a building id and a positive amount';
      return w.buildings.slotForId(cmd.target) < 0 ? 'damage target does not exist' : null;
    }
    case 'fillBuffers':
    case 'clearAliens':
    case 'clearWrecks':
    case 'resetStats':
      return null;
    case 'resetSandbox':
      return cmd.full === undefined || typeof cmd.full === 'boolean' ? null : 'full must be true or false';
    default:
      return `unknown command ${JSON.stringify((cmd as { t?: unknown }).t)}`;
  }
}

/** Null if building slot s may be repaired now (complete and below its maximum hit points), otherwise why not. */
export function repairProblem(w: World, s: number): string | null {
  const c = w.buildings.cols;
  const info = buildingInfo(c.kind[s]!);
  if (!(c.flags[s]! & BF_COMPLETE)) return `${info.label} is not finished`;
  if (c.hp[s]! >= c.maxHp[s]!) return `${info.label} is not damaged`;
  return null;
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
  const belt = c.kind[s] === B.belt;
  if (tier > info.tiers.length) return belt ? `${info.label} is already Fast, its top tier` : `${info.label} is already at its top tier`;
  const req = tierRequires(kind, tier + 1);
  if (req && !w.researched(req) && !w.debug.allTiers)
    return `${info.label} ${belt ? 'to ' : ''}${tierName(c.kind[s]!, tier + 1)} needs research "${RESEARCH[RESEARCH_INDEX[req]!]!.label}"`;
  return null;
}

/**
 * W31: "a Slow belt site is already planned here" when (tx, ty) holds a reserved belt site at a
 * speed other than `tier` that the build may not replace; null otherwise.
 */
function otherSpeedSite(w: World, kind: number, tx: number, ty: number, tier: number): string | null {
  if (kind !== B.belt || tx < 0 || ty < 0 || tx >= w.terrain.w || ty >= w.terrain.h) return null;
  const s = w.occupancy[ty * w.terrain.w + tx]! - 1;
  const c = w.buildings.cols;
  if (s < 0 || c.kind[s] !== B.belt || !isReserved(c.flags[s]!) || c.tier[s] === tier) return null;
  return `a ${tierName(B.belt, c.tier[s]!)} belt site is already planned here`;
}

/** Why each skipped drag-upgrade target was left out (W31; the runner reports the counts). */
export interface BeltUpgradeSkips {
  duplicate: number;
  gone: number;
  notBelt: number;
  changed: number;
  upgrading: number;
  top: number;
  locked: number;
}

/** The belts a drag-upgrade command will upgrade, in drag order, and what it skips. */
export interface BeltUpgradePlan {
  /** Building ids to upgrade one speed step. */
  ids: number[];
  toMedium: number;
  toFast: number;
  skipped: BeltUpgradeSkips;
}

/**
 * W31: plans an `upgradeBelts` command on this state, or says why it is refused. Targets are taken
 * in order; one is skipped (and counted) when it repeats an earlier id, is gone, is not a complete
 * belt (a splitter, a merger, a site), is no longer at its `expectedTier`, is already upgrading, is
 * at Fast, or its next speed's research is not done (`allTiers` lifts that). Refused: when every
 * target is skipped (the command would change nothing, so an unshifted one does not clear the
 * queues), and when the upgrades would not all fit any live unit's queue (MAX_ORDERS, counting its
 * current orders only with `queue`), so no upgrade flag is set for part of a batch.
 */
export function planBeltUpgrades(w: World, cmd: Extract<Command, { t: 'upgradeBelts' }>): BeltUpgradePlan | string {
  if (!idList(cmd.ids) || !cmd.ids.length) return 'upgradeBelts needs unit ids';
  const targets = cmd.targets as unknown;
  if (!Array.isArray(targets) || !targets.length) return 'upgradeBelts needs targets';
  if (!targets.every((t) => t && typeof t === 'object' && isInt((t as { id?: unknown }).id) && isInt((t as { expectedTier?: unknown }).expectedTier)))
    return 'upgradeBelts targets must be { id, expectedTier } with integers';
  const plan: BeltUpgradePlan = { ids: [], toMedium: 0, toFast: 0, skipped: { duplicate: 0, gone: 0, notBelt: 0, changed: 0, upgrading: 0, top: 0, locked: 0 } };
  const k = plan.skipped;
  const c = w.buildings.cols;
  const seen = new Set<number>();
  const researched = (id: string) => w.researched(id) || w.debug.allTiers;
  for (const { id, expectedTier } of targets as Array<{ id: number; expectedTier: number }>) {
    if (seen.has(id)) {
      k.duplicate++;
      continue;
    }
    seen.add(id);
    const s = w.buildings.slotForId(id);
    if (s < 0) {
      k.gone++;
      continue;
    }
    // kinds.ts beltUpgradeSkip, the rule the drag preview applies too; `changed` is checked in between
    const why = beltUpgradeSkip(c.kind[s]!, c.flags[s]!, c.tier[s]!, researched);
    if (why === 'notBelt') k.notBelt++;
    else if (c.tier[s] !== expectedTier) k.changed++;
    else if (why) k[why]++;
    else {
      plan.ids.push(id);
      if (c.tier[s] === 1) plan.toMedium++;
      else plan.toFast++;
    }
  }
  const n = targets.length;
  if (!plan.ids.length)
    return `nothing to upgrade: all ${n} target${n === 1 ? '' : 's'} skipped (duplicate ${k.duplicate}, gone ${k.gone}, not a belt ${k.notBelt}, changed ${k.changed}, upgrading ${k.upgrading}, already Fast ${k.top}, locked ${k.locked})`;
  for (const uid of cmd.ids) {
    const u = w.units.slotForId(uid);
    if (u < 0) continue;
    const base = cmd.queue ? (w.orders[u]?.length ?? 0) : 0;
    if (base + plan.ids.length > MAX_ORDERS) return `order queue full: unit ${uid} would hold ${base + plan.ids.length} orders (${MAX_ORDERS} per unit); upgrade fewer belts`;
  }
  return plan;
}
