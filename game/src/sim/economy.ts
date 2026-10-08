// Income, energy upkeep and construction drain.
//
// Construction follows W12's rule (Forged Alliance): a build draws its cost evenly over its
// build time. Each tick every active build asks for cost × (progress it could make); for each
// resource ratio = min(1, pool / total requested); each build then progresses at the WORST ratio
// among the resources it actually draws. A build that does not draw the short resource is not
// slowed. Energy upkeep (beams, shields, machines) draws before construction.
// W24: the first tick build power reaches a site it becomes started (world.ts startSite). With the
// sandbox's unlimited spending on, construction, upgrades, research, engineers and energy upkeep
// progress at full supply and draw nothing; income is unchanged.

import { BF_ACTIVE, BF_COMPLETE, BF_STARTED, BF_STARVED, BF_UPGRADING } from './schema.ts';
import { B, COMMANDER_INCOME, SHIELD, TICK_SECONDS, buildingInfo, type Cost } from './kinds.ts';
import { ENGINEER_BUILD_TIME, ENGINEER_COST, RESEARCH } from './balance.ts';
import { map1 } from '../../../model/data/map1.ts';

const LAB_RATE = map1.labRate;
import type { World } from './world.ts';

const DT = TICK_SECONDS;
const EPS = 1e-9;

export function stepEconomyIncome(w: World): void {
  const b = w.buildings;
  const c = b.cols;
  let m = 0;
  let e = 0;
  let r = 0;
  for (let s = 0; s < b.highWater; s++) {
    if (!b.alive[s] || !(c.flags[s]! & BF_COMPLETE)) continue;
    const kind = c.kind[s]!;
    const inc = buildingInfo(kind).income;
    if (!inc) continue;
    m += kind === B.massExtractor ? inc[0] * w.extractorOutput() : inc[0];
    e += inc[1];
    r += inc[2];
  }
  if (w.commanderSlot() >= 0) {
    m += COMMANDER_INCOME[0];
    e += COMMANDER_INCOME[1];
    r += COMMANDER_INCOME[2];
  }
  w.incomeRate[0] = m;
  w.incomeRate[1] = e;
  w.incomeRate[2] = r;
  w.pool[0] = w.pool[0]! + m * DT;
  w.pool[1] = w.pool[1]! + e * DT;
  w.pool[2] = w.pool[2]! + r * DT;
}

/** Energy consumers this tick: beams with a target, shields while needed, machines with work. */
export function stepUpkeep(w: World): void {
  const b = w.buildings;
  const c = b.cols;
  const aliensOnField = w.aliens.count > 0;
  let demand = 0;
  for (let s = 0; s < b.highWater; s++) {
    if (!b.alive[s]) continue;
    const f = c.flags[s]!;
    c.flags[s] = f & ~(BF_ACTIVE | BF_STARVED);
    if (!(f & BF_COMPLETE)) continue;
    const kind = c.kind[s]!;
    const info = buildingInfo(kind);
    if (kind === B.beam) {
      if (c.target[s]! !== 0) demand += info.weapon!.energyPerSecond * DT;
    } else if (kind === B.shield) {
      if (aliensOnField || c.shield[s]! < SHIELD.capacity) {
        c.flags[s] = c.flags[s]! | BF_ACTIVE;
        demand += SHIELD.energyPerSecond * DT;
      }
    } else if (info.machine) {
      if (c.inBuf[s]! >= info.machine.inputPerOutput && c.outBuf[s]! < 2) {
        c.flags[s] = c.flags[s]! | BF_ACTIVE;
        demand += info.machine.energyPerSecond * DT;
      }
    }
  }
  const u = w.unlimited ? 1 : demand > EPS ? Math.min(1, Math.max(0, w.pool[1]!) / demand) : 1;
  w.upkeep = u;
  const draw = w.unlimited ? 0 : demand * u;
  w.pool[1] = w.pool[1]! - draw;
  w.spendTick[1] = w.spendTick[1]! + draw;
  w.shortMask = u < 1 - EPS ? 2 : 0;
}

const requested = new Float64Array(3);
const ratio = new Float64Array(3);

/** One piece of work this tick: a building site, an upgrade, an engineer in production, research. */
interface Job {
  cost: Cost;
  /** Progress it could make at full supply. */
  p: number;
  done(progress: number, f: number): void;
}

/**
 * Construction drain (W12, Forged Alliance): each job draws cost × progress; for each resource
 * ratio = min(1, pool / total requested); each job then progresses at the worst ratio among the
 * resources it actually draws.
 */
export function stepConstruction(w: World): void {
  const b = w.buildings;
  const c = b.cols;
  requested.fill(0);
  const jobs: Job[] = [];
  for (let s = 0; s < b.highWater; s++) {
    if (!b.alive[s]) continue;
    const site = !(c.flags[s]! & BF_COMPLETE) || (c.flags[s]! & BF_UPGRADING) !== 0;
    if (!site) continue;
    c.builders[s] = w.builderCount[s]!;
    const bp = w.buildPower[s]!;
    if (bp <= 0) {
      c.eff[s] = 255;
      continue;
    }
    if (!(c.flags[s]! & BF_STARTED)) w.startSite(s);
    const { cost, time } = w.workOf(s);
    const p = Math.min(1 - c.progress[s]!, (bp * DT) / time);
    if (p <= 0) continue;
    jobs.push({
      cost,
      p,
      done: (done, f) => {
        c.eff[s] = Math.round(f * 255);
        c.progress[s] = c.progress[s]! + done;
        const upgrading = (c.flags[s]! & BF_UPGRADING) !== 0;
        if (!upgrading) c.hp[s] = Math.min(c.maxHp[s]!, c.hp[s]! + c.maxHp[s]! * 0.9 * done);
        if (c.progress[s]! >= 1 - 1e-9) complete(w, s, upgrading);
      },
    });
  }
  w.buildPower.fill(0);
  w.builderCount.fill(0);
  // Engineers in production (the commander's 'produce' orders).
  for (const job of w.produceJobs) {
    const order = job.order;
    const p = Math.min(1 - order.progress, (job.bp * DT) / ENGINEER_BUILD_TIME);
    if (p > 0) jobs.push({ cost: ENGINEER_COST, p, done: (done) => (order.progress += done) });
  }
  w.produceJobs.length = 0;
  // Research: complete stations make RP at W12's labRate; the node drains its cost over its RP.
  let stations = 0;
  for (let s = 0; s < b.highWater; s++) if (b.alive[s] && c.kind[s] === B.lab && c.flags[s]! & BF_COMPLETE) stations++;
  w.researchRate = stations * LAB_RATE;
  if (w.researchCurrent < 0 && w.researchQueue.length) {
    w.researchCurrent = w.researchQueue.shift()!;
    w.researchProgress = 0;
  }
  if (w.researchCurrent >= 0 && stations > 0) {
    const node = RESEARCH[w.researchCurrent]!;
    const p = Math.min(1 - w.researchProgress, (w.researchRate * DT) / node.seconds);
    if (p > 0)
      jobs.push({
        cost: node.cost,
        p,
        done: (done, f) => {
          w.researchProgress += done;
          w.researchEff = f;
          if (w.researchProgress >= 1 - 1e-9) {
            w.researchDone |= 1 << w.researchCurrent;
            w.researchCurrent = -1;
            w.researchProgress = 0;
          }
        },
      });
  }
  for (const j of jobs) for (let k = 0; k < 3; k++) requested[k] = requested[k]! + j.cost[k]! * j.p;
  // Supply ratio per resource (all 1 with unlimited spending, which draws nothing).
  let worst = 1;
  for (let k = 0; k < 3; k++) {
    ratio[k] = w.unlimited ? 1 : requested[k]! > EPS ? Math.min(1, Math.max(0, w.pool[k]!) / requested[k]!) : 1;
    if (ratio[k]! < 1 - EPS) w.shortMask |= 1 << k;
    if (ratio[k]! < worst) worst = ratio[k]!;
  }
  w.buildEff = jobs.length ? worst : 1;
  // Each job progresses at its worst ratio among the resources it draws.
  for (const j of jobs) {
    let f = 1;
    for (let k = 0; k < 3; k++) if (j.cost[k]! > 0 && ratio[k]! < f) f = ratio[k]!;
    const done = j.p * f;
    for (let k = 0; k < 3 && !w.unlimited; k++) {
      const draw = j.cost[k]! * done;
      w.pool[k] = w.pool[k]! - draw;
      w.spendTick[k] = w.spendTick[k]! + draw;
    }
    for (let k = 0; k < 3; k++) if (w.pool[k]! < 0 && w.pool[k]! > -1e-9) w.pool[k] = 0;
    j.done(done, f);
  }
}

function complete(w: World, s: number, upgrading: boolean): void {
  const c = w.buildings.cols;
  c.progress[s] = 1;
  if (upgrading) {
    const newMax = w.maxHpAt(s, c.tier[s]! + 1);
    c.hp[s] = c.hp[s]! + (newMax - c.maxHp[s]!);
    c.maxHp[s] = newMax;
    c.tier[s] = c.tier[s]! + 1;
    c.flags[s] = c.flags[s]! & ~BF_UPGRADING;
  } else {
    c.flags[s] = c.flags[s]! | BF_COMPLETE;
    if (c.hp[s]! > c.maxHp[s]! * 0.99) c.hp[s] = c.maxHp[s]!;
  }
  w.structureChanged();
}
