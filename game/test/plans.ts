// Scripted build plans for the headless full-map tests: W12's `balanced` strategy (model/src/
// strategies.ts) turned into real commands on real tiles. The driver issues each step once its
// minute has come and it is allowed (research done, tiles free), rebuilds anything destroyed, and
// sends spare engineers to reclaim wrecks the way W12's reclaimShare does.

import { World } from '../src/sim/world.ts';
import { B, U, buildingInfo } from '../src/sim/kinds.ts';
import { BF_COMPLETE } from '../src/sim/schema.ts';
import { RESEARCH } from '../src/sim/balance.ts';

type Action =
  | { build: number; at: [number, number]; dir?: number }
  | { upgrade: [number, number] }
  | { research: string }
  | { engineer: true };

export interface PlanStep {
  /** Game minute from which the step may be issued. */
  min: number;
  act: Action;
}

const b = (min: number, kind: number, tx: number, ty: number, dir = 0): PlanStep => ({ min, act: { build: kind, at: [tx, ty], dir } });
const up = (min: number, tx: number, ty: number): PlanStep => ({ min, act: { upgrade: [tx, ty] } });
const r = (min: number, id: string): PlanStep => ({ min, act: { research: id } });
const eng = (min: number): PlanStep => ({ min, act: { engineer: true } });

const walls = (min: number, xs: number[], z: number) => xs.map((x) => b(min, B.wall, x, z));
const wallsZ = (min: number, x: number, zs: number[]) => zs.map((z) => b(min, B.wall, x, z));

// Layout. Base centre (64, 64), commander at (64.5, 64.5). North aliens come down x ≈ 64 from
// (64, 1); east aliens along z ≈ 64 from (127, 64). A north line at z ≈ 42–53 and an east line at
// x ≈ 79–88 meet rushers, breakers and saboteurs; hunters slip round walls for the commander, so
// a core of guns, area cannons, beams and shields stands round him. Economy and the salvage chain
// sit south of the centre; two guarded rare points north, one east. W12's balanced plan, on tiles.
export const BALANCED: PlanStep[] = [
  // Minute 0: the north rare points first (rare material gates research and every advanced
  // defence), a gun between them, then economy and a first north defence.
  b(0, B.massExtractor, 54, 50),
  b(0, B.massExtractor, 72, 49),
  b(0, B.generator, 58, 66),
  eng(0),
  eng(0),
  eng(0),
  eng(0),
  b(0, B.gun, 60, 46),
  b(0, B.gun, 66, 46),
  b(0, B.massExtractor, 46, 62),
  b(0, B.massExtractor, 80, 60),
  b(0, B.generator, 58, 69),
  b(0, B.generator, 69, 66),
  ...walls(0, [63, 64], 42),
  b(1.5, B.massExtractor, 50, 77),
  b(1.5, B.massExtractor, 74, 78),
  b(1.5, B.generator, 69, 69),
  b(1.5, B.generator, 55, 66),
  eng(2),
  eng(2),
  // Minute 3: research station and core guns; research beam (anti-hunter), shield, heavy, gun T2.
  b(3, B.lab, 66, 70),
  b(3, B.rareExtractor, 55, 26),
  b(3, B.gun, 64, 31),
  b(4, B.rareExtractor, 73, 29),
  r(3, 'beam'),
  r(3, 'extractors'),
  r(3, 'shield'),
  r(3, 'heavy'),
  r(3, 'gunT2'),
  b(3, B.gun, 60, 59),
  b(3, B.gun, 67, 59),
  b(4, B.area, 63, 49),
  b(4, B.generator, 72, 66),
  // Minute 5: the salvage chain along z = 74: depot -> shredder -> smelter -> assembler.
  b(5, B.depot, 48, 74),
  b(5, B.belt, 50, 74),
  b(5, B.belt, 51, 74),
  b(5, B.shredder, 52, 74),
  b(5, B.belt, 54, 74),
  b(5, B.belt, 55, 74),
  b(5, B.smelter, 56, 74),
  b(5, B.belt, 58, 74),
  b(5, B.belt, 59, 74),
  b(5, B.assembler, 60, 74),
  eng(5),
  eng(5),
  b(6, B.massExtractor, 36, 40),
  b(6, B.massExtractor, 92, 84),
  b(6, B.generator, 55, 69),
  b(6, B.generator, 72, 69),
  // The core round the commander: area cannons, beams (prefer hunters), shields.
  b(7, B.area, 59, 62),
  b(7, B.beam, 57, 59),
  b(8, B.area, 68, 62),
  b(8, B.area, 63, 34),
  b(8, B.beam, 70, 59),
  eng(9),
  eng(9),
  b(10, B.generator, 52, 66),
  b(10, B.generator, 75, 66),
  b(10, B.shield, 63, 61),
  b(10, B.heavy, 62, 53),
  // Minute 12: the east line before the east entry opens at wave 7 (18:00).
  ...wallsZ(12, 88, [63, 64, 65]),
  b(12, B.gun, 84, 60),
  b(12, B.gun, 84, 66),
  b(12, B.rareExtractor, 100, 59),
  b(13, B.area, 81, 63),
  r(13, 'fieldEng'),
  r(13, 'areaT2'),
  r(13, 'wallT2'),
  eng(14),
  eng(14),
  b(14, B.gun, 63, 56),
  b(15, B.heavy, 79, 67),
  b(15, B.beam, 80, 57),
  b(16, B.gun, 56, 46),
  b(16, B.shield, 60, 66),
  b(17, B.shield, 67, 66),
  b(18, B.generator, 52, 69),
  b(18, B.generator, 75, 69),
  up(18, 60, 59),
  up(18, 67, 59),
  up(18, 63, 56),
  b(20, B.area, 69, 49),
  b(20, B.area, 56, 55),
  b(20, B.area, 71, 55),
  up(21, 60, 46),
  up(21, 66, 46),
  b(22, B.gun, 84, 70),
  up(22, 84, 60),
  up(22, 84, 66),
  b(23, B.beam, 54, 62),
  b(23, B.beam, 73, 62),
  b(24, B.heavy, 66, 53),
  b(25, B.beam, 58, 50),
  b(26, B.area, 81, 53),
  b(27, B.heavy, 79, 71),
  b(28, B.beam, 80, 75),
  up(29, 59, 62),
  up(29, 68, 62),
  up(30, 56, 55),
  up(30, 71, 55),
  up(31, 63, 49),
  up(31, 69, 49),
  up(32, 81, 63),
  up(32, 81, 53),
  b(33, B.shield, 74, 56),
  b(34, B.beam, 66, 75),
  b(34, B.beam, 77, 70),
  b(36, B.heavy, 57, 52),
  b(37, B.heavy, 76, 63),
  b(38, B.beam, 50, 58),
  b(38, B.beam, 77, 59),
  b(39, B.shredder, 52, 77),
  b(41, B.area, 61, 69),
  b(41, B.area, 77, 66),
  b(44, B.heavy, 70, 52),
  b(46, B.beam, 52, 49),
  b(46, B.beam, 74, 52),
];
// W12 balanced ends with 22 generators: beams and shields draw hard in the late hunter waves.
// Generators are cheap (60 mass, no energy) and the beams and shields run on energy, so they
// come early; insert each where its minute falls in the plan order.
for (const [min, x, z] of [
  [6, 54, 80], [6, 57, 80], [8, 60, 80], [8, 63, 80], [11, 66, 80], [11, 69, 80],
  [16, 54, 83], [16, 57, 83], [20, 60, 83], [20, 63, 83], [24, 66, 83], [24, 69, 83],
  [28, 54, 86], [28, 57, 86], [32, 60, 86], [32, 63, 86],
] as const) {
  const at = BALANCED.findIndex((st) => st.min > min);
  BALANCED.splice(at < 0 ? BALANCED.length : at, 0, b(min, B.generator, x, z));
}
// Replace engineers lost to saboteurs.
for (const min of [20, 20, 26, 26, 32, 32, 38, 38]) BALANCED.push(eng(min));

export interface DriveResult {
  outcome: number;
  endTick: number;
  wave: number;
  commanderHp: number;
  kills: number;
  buildingsLost: number;
  unitsLost: number;
  partsMade: number;
  partsUsed: number;
  skipped: string[];
}

/** Plays `plan` until the run ends or `maxTicks`. `reclaim`: spare engineers salvage wrecks. */
export function drive(w: World, plan: PlanStep[], opts: { maxTicks?: number; reclaim?: boolean; log?: (s: string) => void } = {}): DriveResult {
  const maxTicks = opts.maxTicks ?? 40000;
  const issued = new Array<boolean>(plan.length).fill(false);
  const builtAt = new Map<number, string>(); // plan index -> placed (for rebuilds)
  const skipped: string[] = [];
  const builders = new Set<number>();
  const salvagers = new Set<number>();
  const assign = () => {
    for (const set of [builders, salvagers]) for (const id of [...set]) if (w.units.slotForId(id) < 0) set.delete(id);
    for (let s = 0; s < w.units.highWater; s++) {
      if (!w.units.alive[s]) continue;
      const id = w.units.id(s);
      if (builders.has(id) || salvagers.has(id)) continue;
      // The commander stays in the core producing engineers (hunters hunt him). The first four
      // engineers build; after that 40% salvage (W12 reclaimShare 0.4).
      if (w.units.cols.kind[s] === U.commander) continue;
      if (builders.size < 4 || salvagers.size >= 0.4 * (builders.size + salvagers.size)) builders.add(id);
      else salvagers.add(id);
    }
  };
  /** Builders for a site: the two engineers with the shortest order queues. */
  const queueLen = (id: number) => w.orders[w.units.slotForId(id)]?.length ?? 0;
  const buildersFor = (_tx: number, _ty: number): number[] => {
    const engs = [...builders].sort((a, c) => queueLen(a) - queueLen(c) || a - c);
    return engs.length ? engs.slice(0, 2) : [w.commanderId];
  };
  /** Idle engineers help the oldest unfinished site. */
  const helpIdle = () => {
    let site = -1;
    for (let s = 0; s < w.buildings.highWater && site < 0; s++)
      if (w.buildings.alive[s] && !(w.buildings.cols.flags[s]! & BF_COMPLETE)) site = s;
    if (site < 0) return;
    const idle = [...builders, ...salvagers].filter((id) => queueLen(id) === 0);
    if (idle.length) w.submit({ t: 'assist', ids: idle, target: w.buildings.id(site) });
  };
  const occAt = (x: number, z: number) => w.occupancy[z * w.terrain.w + x]! - 1;
  while (w.outcome === 0 && w.tick < maxTicks) {
    if (w.tick % 10 === 0) {
      assign();
      const minute = w.tick / 600;
      plan.forEach((step, i) => {
        if (step.min > minute) return;
        const a = step.act;
        if ('build' in a) {
          const [tx, ty] = a.at;
          if (issued[i]) {
            // Rebuild if it was destroyed (and the tiles are free again).
            if (occAt(tx, ty) < 0 && w.canPlace(a.build, tx, ty) && !w.queue.some((q) => q.cmd.t === 'build' && q.cmd.tx === tx && q.cmd.ty === ty)) {
              if (w.submit({ t: 'build', ids: buildersFor(tx, ty), kind: a.build, tx, ty, dir: a.dir ?? 0, queue: true }) === null) builtAt.set(i, 'rebuilt');
            }
            return;
          }
          // A player waits for the rare material rather than parking the builders on a starved site.
          if (buildingInfo(a.build).cost[2] > w.pool[2]!) return;
          const why = w.submit({ t: 'build', ids: buildersFor(tx, ty), kind: a.build, tx, ty, dir: a.dir ?? 0, queue: true });
          if (why === null) issued[i] = true;
          else if (!/needs research|queue full/.test(why)) {
            issued[i] = true;
            skipped.push(`${buildingInfo(a.build).label} at ${tx},${ty}: ${why}`);
          }
        } else if (issued[i]) return;
        else if ('upgrade' in a) {
          const s = occAt(a.upgrade[0], a.upgrade[1]);
          if (s < 0 || !(w.buildings.cols.flags[s]! & BF_COMPLETE)) return;
          const tiers = buildingInfo(w.buildings.cols.kind[s]!).tiers;
          const next = tiers?.[w.buildings.cols.tier[s]! - 1];
          if (next && next.cost[2] > w.pool[2]!) return;
          const why = w.submit({ t: 'upgrade', ids: buildersFor(a.upgrade[0], a.upgrade[1]), target: w.buildings.id(s), queue: true });
          if (why === null) issued[i] = true;
        } else if ('research' in a) {
          // Start a node only when its rare material is in hand, so it does not starve builds.
          const node = RESEARCH.find((n) => n.id === a.research)!;
          if (node.cost[2] > w.pool[2]! || w.researchCurrent >= 0 || w.researchQueue.length) return;
          const why = w.submit({ t: 'research', node: a.research });
          if (why === null || /already/.test(why)) issued[i] = true;
        } else {
          if (w.commanderSlot() >= 0 && w.submit({ t: 'produce', id: w.commanderId }) === null) issued[i] = true;
        }
      });
      if (w.tick % 50 === 0) helpIdle();
      if (opts.reclaim !== false && w.tick % 50 === 0) {
        for (const id of salvagers) {
          const s = w.units.slotForId(id);
          if (s < 0 || (w.orders[s]?.length ?? 0) > 0) continue;
          const wr = safeWreck(w);
          if (wr >= 0) w.submit({ t: 'reclaim', ids: [id], wreck: w.wrecks.id(wr) });
        }
      }
      if (opts.log && w.tick === w.lastWaveTick + 10)
        opts.log(`  wave ${w.nextWave} started ${(w.lastWaveTick / 600).toFixed(1)}m cmdr=${w.commanderSlot() >= 0 ? w.units.cols.hp[w.commanderSlot()]!.toFixed(0) : 0} b=${w.buildings.count} units=${w.units.count} lostB=${w.buildingsLost}`);
      if (opts.log && w.tick % 6000 === 0)
        opts.log(`t=${(w.tick / 600).toFixed(0)}m wave=${w.nextWave} cmdr=${w.commanderSlot() >= 0 ? w.units.cols.hp[w.commanderSlot()]!.toFixed(0) : 0} b=${w.buildings.count} u=${w.units.count} pool=${Array.from(w.pool).map((x) => x.toFixed(0))} parts=${w.parts.toFixed(0)} made=${w.partsMade.toFixed(0)} kills=${w.kills} res=${w.researchDone.toString(2)}`);
    }
    w.step();
  }
  return {
    outcome: w.outcome,
    endTick: w.endTick,
    wave: w.nextWave,
    commanderHp: w.commanderSlot() >= 0 ? w.units.cols.hp[w.commanderSlot()]! : 0,
    kills: w.kills,
    buildingsLost: w.buildingsLost,
    unitsLost: w.unitsLost,
    partsMade: w.partsMade,
    partsUsed: w.partsUsed,
    skipped,
  };
}

/** The wreck nearest the base with no alien within 15 tiles of it, or -1. */
function safeWreck(w: World): number {
  const { x: bx, z: bz } = w.terrain.base;
  let best = -1;
  let bestD = 45 * 45;
  for (let s = 0; s < w.wrecks.highWater; s++) {
    if (!w.wrecks.alive[s]) continue;
    const x = w.wrecks.cols.x[s]!;
    const z = w.wrecks.cols.z[s]!;
    const d = (x - bx) ** 2 + (z - bz) ** 2;
    if (d >= bestD) continue;
    let danger = false;
    for (let a = 0; a < w.aliens.highWater && !danger; a++) {
      if (!w.aliens.alive[a]) continue;
      if ((w.aliens.cols.x[a]! - x) ** 2 + (w.aliens.cols.z[a]! - z) ** 2 < 225) danger = true;
    }
    if (!danger) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** Economy only: no defences at all. */
export const NO_DEFENCE: PlanStep[] = BALANCED.filter((s) => {
  const a = s.act;
  if (!('build' in a)) return !('upgrade' in a);
  const role = buildingInfo(a.build).role;
  return role === 'economy' || role === 'chain' || role === 'floor';
});
