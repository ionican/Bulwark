// Scripted player strategies. Each is a build-order policy: a list of target counts that switch on
// at a game minute, plus a research order and the share of engineers sent to reclaim salvage.
//
// Once per second the policy compares each switched-on target with what exists plus what is queued,
// and queues the difference. Queue priority is the target's position in the list, so a destroyed
// building is rebuilt at the priority of the line that asked for it. Storage lines marked
// `cappedOnly` are skipped when the run has no storage cap, as a real player would skip them.

import type { Sim, Strategy } from './sim.ts';
import type { BuildingKind, Place, ResearchId } from './types.ts';

export interface PlanEntry {
  /** Game minute from which this target applies. */
  at: number;
  kind: BuildingKind;
  place: Place;
  count: number;
  /** 2 or 3: count of buildings at this place upgraded to at least this tier. */
  tier?: number;
  cappedOnly?: boolean;
}

export interface PlanSpec {
  name: string;
  description: string;
  reclaimShare: number;
  plan: PlanEntry[];
  research: { at: number; id: ResearchId }[];
}

export function planStrategy(spec: PlanSpec): Strategy {
  return {
    name: spec.name,
    description: spec.description,
    reclaimShare: spec.reclaimShare,
    decide(sim: Sim) {
      const now = sim.time / 60;
      for (const r of spec.research) if (r.at <= now) sim.queueResearch(r.id);
      const want = new Map<string, { e: PlanEntry; count: number; priority: number }>();
      spec.plan.forEach((e, i) => {
        if (e.at > now || (e.cappedOnly && !sim.capped)) return;
        const key = `${e.kind}|${e.place}|${e.tier ?? 1}`;
        const w = want.get(key);
        if (w) w.count = Math.max(w.count, e.count);
        else want.set(key, { e, count: e.count, priority: i });
      });
      const ordered = [...want.values()].sort((a, b) => a.priority - b.priority);
      for (const { e, count, priority } of ordered) {
        const tier = e.tier ?? 1;
        if (tier === 1) {
          let have = sim.count(e.kind, e.place) + sim.queued(e.kind, e.place);
          while (have < count && sim.enqueueBuild(e.kind, e.place, priority)) have++;
        } else {
          let have = sim.countTier(e.kind, e.place, tier) + sim.queued(e.kind, e.place, 'upgrade', tier);
          while (have < count && sim.enqueueUpgrade(e.kind, e.place, tier, priority)) have++;
        }
      }
    },
  };
}

const p = (at: number, kind: BuildingKind, place: Place, count: number, extra: Partial<PlanEntry> = {}): PlanEntry => ({ at, kind, place, count, ...extra });

// ---- (a) Balanced: a sensible human plan ------------------------------------------------------
// Open with half the deposits and a small north defence, add the lab and salvage chain before the
// first wall-breakers (10:30), fortify east before it opens (18:00), then grow both lanes with a
// mix of every defence type.
const balancedPlan: PlanEntry[] = [
  p(0, 'massExtractor', 'base', 4),
  p(0, 'generator', 'base', 3),
  p(0, 'gun', 'north', 2),
  p(0, 'wall', 'north', 2),
  p(0, 'engineer', 'base', 4),
  p(1.5, 'massExtractor', 'base', 6),
  p(1.5, 'generator', 'base', 6),
  p(3, 'lab', 'base', 1),
  p(3, 'rareExtractor', 'north', 1),
  p(4, 'storage', 'base', 1, { cappedOnly: true }),
  p(4, 'area', 'north', 1),
  p(5, 'depot', 'base', 1),
  p(5, 'shredder', 'base', 1),
  p(5, 'smelter', 'base', 2),
  p(5, 'assembler', 'base', 1),
  p(6, 'massExtractor', 'base', 8),
  p(6, 'generator', 'base', 10),
  p(7, 'beam', 'north', 1),
  p(8, 'heavy', 'north', 1),
  p(8, 'rareExtractor', 'north', 2),
  p(9, 'engineer', 'base', 6),
  p(10, 'generator', 'base', 14),
  p(10, 'wall', 'north', 2, { tier: 2 }),
  p(12, 'wall', 'east', 2),
  p(12, 'gun', 'east', 2),
  p(12, 'rareExtractor', 'east', 1),
  p(13, 'area', 'east', 1),
  p(14, 'shield', 'core', 1),
  p(15, 'heavy', 'east', 1),
  p(15, 'beam', 'east', 1),
  p(16, 'gun', 'north', 3),
  p(18, 'storage', 'base', 2, { cappedOnly: true }),
  p(18, 'generator', 'base', 18),
  p(18, 'gun', 'north', 3, { tier: 2 }),
  p(20, 'area', 'north', 2),
  p(21, 'wall', 'east', 2, { tier: 2 }),
  p(22, 'gun', 'east', 3),
  p(22, 'gun', 'east', 3, { tier: 2 }),
  p(24, 'heavy', 'north', 2),
  p(25, 'beam', 'north', 2),
  p(26, 'area', 'east', 2),
  p(27, 'heavy', 'east', 2),
  p(28, 'generator', 'base', 20),
  p(28, 'beam', 'east', 2),
  p(30, 'gun', 'core', 2),
  p(30, 'shield', 'north', 1),
  p(31, 'area', 'north', 2, { tier: 2 }),
  p(32, 'area', 'east', 2, { tier: 2 }),
  p(33, 'wall', 'north', 3),
  p(33, 'wall', 'east', 3),
  p(34, 'wall', 'north', 3, { tier: 2 }),
  p(34, 'wall', 'east', 3, { tier: 2 }),
  p(35, 'shield', 'east', 1),
  p(36, 'storage', 'base', 3, { cappedOnly: true }),
  p(36, 'heavy', 'north', 3),
  p(37, 'heavy', 'east', 3),
  p(38, 'beam', 'north', 3),
  p(38, 'beam', 'east', 3),
  p(39, 'shredder', 'base', 2),
  p(39, 'smelter', 'base', 4),
  p(39, 'assembler', 'base', 2),
  p(40, 'generator', 'base', 22),
  p(41, 'area', 'north', 3),
  p(41, 'area', 'east', 3),
  p(42, 'wall', 'north', 3, { tier: 3 }),
  p(42, 'wall', 'east', 3, { tier: 3 }),
  p(44, 'gun', 'core', 4),
  p(44, 'heavy', 'north', 4),
  p(44, 'heavy', 'east', 4),
  p(46, 'beam', 'north', 4),
  p(46, 'beam', 'east', 4),
  p(48, 'area', 'north', 4),
  p(48, 'area', 'east', 4),
];

const balancedResearch: { at: number; id: ResearchId }[] = [
  { at: 3, id: 'beam' },
  { at: 3, id: 'heavy' },
  { at: 3, id: 'wallT2' },
  { at: 10, id: 'shield' },
  { at: 14, id: 'gunT2' },
  { at: 22, id: 'areaT2' },
  { at: 30, id: 'wallT3' },
];

export const balanced = planStrategy({
  name: 'balanced',
  description: 'Half the deposits first, a small north defence, lab and salvage chain by minute 5, east fortified before it opens, every defence type.',
  reclaimShare: 0.4,
  plan: balancedPlan,
  research: balancedResearch,
});

// ---- (b) Greedy economy: every deposit, generator and rare point first; defences late ----------
// Takes all eight deposits, ten generators, all three rare points and the lab in the opening, with
// a single gun turret north, then follows the balanced defence plan from minute 8.
const economyKinds: BuildingKind[] = ['massExtractor', 'generator', 'rareExtractor', 'storage', 'lab', 'engineer', 'depot', 'shredder', 'smelter', 'assembler'];
export const greedy = planStrategy({
  name: 'greedy',
  description: 'All deposits, ten generators, three rare points and six engineers first; one gun turret until minute 8, then the balanced defence plan.',
  reclaimShare: 0.4,
  plan: [
    p(0, 'massExtractor', 'base', 8),
    p(0, 'engineer', 'base', 6),
    p(0, 'generator', 'base', 10),
    p(0, 'gun', 'north', 1),
    p(0, 'lab', 'base', 1),
    p(0, 'rareExtractor', 'north', 2),
    p(0, 'rareExtractor', 'east', 1),
    p(0, 'storage', 'base', 2, { cappedOnly: true }),
    ...balancedPlan.map((e) => (economyKinds.includes(e.kind) ? e : { ...e, at: Math.max(e.at, 8) })),
  ],
  research: balancedResearch,
});

// ---- (c) Turtle: walls and gun turrets only ------------------------------------------------------
// Never builds the salvage chain, heavy cannons, area cannons, beams or shields. Researches wall and
// gun tiers. Puts the saving into more walls, more guns and an inner ring of core guns.
export const turtle = planStrategy({
  name: 'turtle',
  description: 'Walls and gun turrets only, upgraded through wall and gun tiers; no salvage chain, heavy cannon, area cannon, beam or shield.',
  reclaimShare: 0,
  plan: [
    p(0, 'massExtractor', 'base', 4),
    p(0, 'generator', 'base', 2),
    p(0, 'wall', 'north', 3),
    p(0, 'gun', 'north', 3),
    p(0, 'engineer', 'base', 4),
    p(2, 'massExtractor', 'base', 6),
    p(2, 'generator', 'base', 4),
    p(3, 'lab', 'base', 1),
    p(3, 'rareExtractor', 'north', 1),
    p(4, 'storage', 'base', 1, { cappedOnly: true }),
    p(5, 'gun', 'north', 4),
    p(6, 'massExtractor', 'base', 8),
    p(6, 'generator', 'base', 6),
    p(6, 'gun', 'core', 2),
    p(8, 'wall', 'north', 3, { tier: 2 }),
    p(8, 'rareExtractor', 'north', 2),
    p(10, 'gun', 'north', 5),
    p(12, 'wall', 'east', 3),
    p(12, 'gun', 'east', 4),
    p(12, 'rareExtractor', 'east', 1),
    p(14, 'gun', 'north', 5, { tier: 2 }),
    p(16, 'wall', 'east', 3, { tier: 2 }),
    p(18, 'storage', 'base', 2, { cappedOnly: true }),
    p(18, 'gun', 'east', 5),
    p(18, 'gun', 'east', 5, { tier: 2 }),
    p(20, 'gun', 'core', 4),
    p(22, 'wall', 'north', 4),
    p(22, 'wall', 'east', 4),
    p(24, 'gun', 'north', 7),
    p(24, 'gun', 'east', 7),
    p(26, 'wall', 'north', 4, { tier: 2 }),
    p(26, 'wall', 'east', 4, { tier: 2 }),
    p(28, 'gun', 'north', 7, { tier: 2 }),
    p(28, 'gun', 'east', 7, { tier: 2 }),
    p(30, 'wall', 'north', 4, { tier: 3 }),
    p(30, 'wall', 'east', 4, { tier: 3 }),
    p(32, 'gun', 'core', 6),
    p(32, 'gun', 'core', 6, { tier: 2 }),
    p(36, 'storage', 'base', 3, { cappedOnly: true }),
    p(36, 'gun', 'north', 9),
    p(36, 'gun', 'east', 9),
    p(38, 'gun', 'north', 9, { tier: 2 }),
    p(38, 'gun', 'east', 9, { tier: 2 }),
    p(40, 'wall', 'north', 6),
    p(40, 'wall', 'east', 6),
    p(42, 'wall', 'north', 6, { tier: 3 }),
    p(42, 'wall', 'east', 6, { tier: 3 }),
    p(44, 'gun', 'north', 11),
    p(44, 'gun', 'east', 11),
    p(46, 'gun', 'north', 11, { tier: 2 }),
    p(46, 'gun', 'east', 11, { tier: 2 }),
    p(46, 'gun', 'core', 8),
  ],
  research: [
    { at: 3, id: 'wallT2' },
    { at: 3, id: 'gunT2' },
    { at: 20, id: 'wallT3' },
  ],
});

// ---- (d) No salvage: the balanced plan, but engineers never reclaim -------------------------
// The chain and heavy cannons still get built; with no salvage reaching the depot the cannons never
// receive a part.
export const noSalvage = planStrategy({
  name: 'no-salvage',
  description: 'The balanced plan with engineers never reclaiming, so the chain gets no input and heavy cannons get no parts.',
  reclaimShare: 0,
  plan: balancedPlan,
  research: balancedResearch,
});

export const STRATEGIES: Strategy[] = [balanced, greedy, turtle, noSalvage];
