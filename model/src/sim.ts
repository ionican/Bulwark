// Deterministic fixed-tick simulation of one map: economy, construction drain, salvage chain and
// abstracted combat. 10 ticks per second; every random choice comes from one seeded RNG.
//
// Combat abstraction (see README): each approach is a 1-D lane measured in metres from the base
// perimeter (dist 0) out to the spawn point. Defences placed on an approach hit aliens on that lane
// within their range. Walls stand at `wallLine`. Aliens that reach dist 0 are inside the base and
// attack their target category. Defences placed at 'core' only hit aliens inside the base.

import { makeRng } from './rng.ts';
import {
  RES,
  zeroRes,
  type AlienKind,
  type BuildingDef,
  type BuildingKind,
  type MapData,
  type Place,
  type Res,
  type ResKey,
  type ResearchId,
  type StorageVariant,
  type WeaponDef,
} from './types.ts';

export const TICKS_PER_SECOND = 10;
export const DT = 1 / TICKS_PER_SECOND;
const EPS = 1e-9;

export type StructKind = BuildingKind | 'temp';

export interface Building {
  id: number;
  kind: StructKind;
  place: Place;
  hp: number;
  maxHp: number;
  tier: number;
  cooldown: number;
  shieldHp: number;
  expires: number;
}

export interface Alien {
  id: number;
  kind: AlienKind;
  approach: string;
  dist: number;
  hp: number;
  /** Building id being attacked inside the base; -1 = the commander; null = none chosen. */
  targetId: number | null;
  dead: boolean;
}

export interface QueueItem {
  id: number;
  type: 'build' | 'upgrade';
  kind: BuildingKind;
  place: Place;
  /** Tier the upgrade raises its target to. */
  tier: number;
  targetId: number | null;
  progress: number;
  priority: number;
}

export interface Strategy {
  name: string;
  description: string;
  /** Share of engineers sent to reclaim salvage while wrecks are on the field and a depot stands. */
  reclaimShare: number;
  /** Called once per game second. Queues builds, upgrades and research on the sim. */
  decide(sim: Sim): void;
}

export interface SimOptions {
  map: MapData;
  strategy?: Strategy | null;
  storage: StorageVariant;
  seed: number;
  /** Hard stop in game seconds. The run is a loss if the wave list is not cleared by then. */
  maxSeconds?: number;
  /** Keep per-tick rows (default true). */
  record?: boolean;
  /** How a shortage slows builds; see step 7. Default 'perResource'. */
  drain?: 'perResource' | 'global';
}

export interface TickRow {
  tick: number;
  time: number;
  wave: number;
  pool: Res;
  income: Res; // per second
  spend: Res; // per second, construction + upkeep
  wasted: Res; // per second, overflow above cap
  cap: Res;
  buildEfficiency: number;
  limiting: ResKey | '';
  buildsActive: number;
  buildsSlowed: number;
  engineers: number;
  reclaimers: number;
  wrecks: number;
  depotSalvage: number;
  parts: number;
  aliens: number;
  threatHp: number;
  defenceDps: number;
  heavyDry: number;
  energyUpkeepRatio: number;
  commanderHp: number;
  defences: number;
}

export type Outcome = 'won' | 'lost' | 'timeout' | 'running';

export interface RunResult {
  outcome: Outcome;
  endTime: number;
  waveReached: number;
  wavesTotal: number;
  commanderHp: number;
  commanderMaxHp: number;
  commanderMinHp: number;
  earned: Res;
  spent: Res;
  wasted: Res;
  startStock: Res;
  meanPool: Res;
  peakPool: Res;
  minEfficiency: number;
  minEfficiencyTime: number;
  minEfficiencyResource: ResKey | '';
  slowedSeconds: Record<ResKey, number>;
  /** Seconds slowed by each resource, bucketed by game minute. */
  slowedByMinute: Record<ResKey, number[]>;
  kills: number;
  salvageFromKills: number;
  reclaimed: number;
  decayed: number;
  partsMade: number;
  partsUsed: number;
  heavyDrySeconds: number;
  reachedBase: Record<AlienKind, number>;
  commanderDamageBy: Record<AlienKind, number>;
  lost: Partial<Record<StructKind, number>>;
  built: Partial<Record<StructKind, number>>;
  researchDone: { id: ResearchId; time: number }[];
}

const CHAIN_STAGES: BuildingKind[] = ['shredder', 'smelter', 'assembler'];

export class Sim {
  readonly map: MapData;
  readonly strategy: Strategy | null;
  readonly storage: StorageVariant;
  readonly maxSeconds: number;
  readonly record: boolean;
  private rng: () => number;

  tick = 0;
  pool: Res;
  earned = zeroRes();
  spent = zeroRes();
  wasted = zeroRes();

  commanderHp: number;
  buildings: Building[] = [];
  aliens: Alien[] = [];
  queue: QueueItem[] = [];
  researchQueue: ResearchId[] = [];
  researchCurrent: { id: ResearchId; progress: number } | null = null;
  researchDone = new Set<ResearchId>();
  researchLog: { id: ResearchId; time: number }[] = [];

  /** Salvage lying in wrecks on the field. */
  wrecks = 0;
  /** Chain buffers: salvage in the depot, then scrap, alloy and finished advanced parts. */
  depotSalvage = 0;
  scrap = 0;
  alloy = 0;
  parts = 0;

  tempReadyAt = 0;
  outcome: Outcome = 'running';
  endTime = 0;
  waveReached = 0;
  rows: TickRow[] = [];

  // Counters for tests and the summary.
  kills = 0;
  salvageFromKills = 0;
  reclaimed = 0;
  decayed = 0;
  partsMade = 0;
  partsUsed = 0;
  heavyDryTicks = 0;
  commanderMinHp: number;
  /** Aliens of each kind that reached the base (dist 0), and commander damage taken from each kind. */
  reachedBase: Record<AlienKind, number> = { rusher: 0, hunter: 0, breaker: 0, saboteur: 0 };
  commanderDamageBy: Record<AlienKind, number> = { rusher: 0, hunter: 0, breaker: 0, saboteur: 0 };
  lost: Partial<Record<StructKind, number>> = {};
  built: Partial<Record<StructKind, number>> = {};
  private poolSum = zeroRes();
  private peakPool = zeroRes();
  private minEff = 1;
  private minEffTime = 0;
  private minEffRes: ResKey | '' = '';
  private slowedTicks: Record<ResKey, number> = { mass: 0, energy: 0, rare: 0 };
  private slowedByMinute: Record<ResKey, number[]> = { mass: [], energy: [], rare: [] };

  private nextId = 1;
  private pending: { at: number; kind: AlienKind; entry: string; wave: number }[] = [];
  private pendingIdx = 0;
  /** Energy upkeep ratio this tick: 1 = every energy consumer fully supplied, 0 = none. */
  upkeepRatio = 1;
  /** Last tick's worst resource ratio, active build count and slowed build count. */
  lastEfficiency = 1;
  lastActive = 0;
  lastSlowed = 0;
  readonly drain: 'perResource' | 'global';

  constructor(opts: SimOptions) {
    this.map = opts.map;
    this.strategy = opts.strategy ?? null;
    this.storage = opts.storage;
    this.maxSeconds = opts.maxSeconds ?? 70 * 60;
    this.record = opts.record ?? true;
    this.drain = opts.drain ?? 'perResource';
    this.rng = makeRng(opts.seed);
    this.pool = { ...opts.map.startStock };
    this.commanderHp = opts.map.commander.hp;
    this.commanderMinHp = this.commanderHp;
    for (let i = 0; i < opts.map.engineer.startCount; i++) this.addBuilding('engineer', 'base');
    this.built = {};
    for (const w of opts.map.waves) {
      for (const g of w.groups) {
        const interval = opts.map.aliens[g.kind].spawnInterval;
        for (let i = 0; i < g.count; i++) this.pending.push({ at: w.at + i * interval, kind: g.kind, entry: g.entry, wave: w.n });
      }
    }
    // Stable sort keeps file order for equal times.
    this.pending.sort((a, b) => a.at - b.at);
  }

  get time(): number {
    return this.tick * DT;
  }
  get capped(): boolean {
    return this.storage === 'capped';
  }
  get done(): boolean {
    return this.outcome !== 'running';
  }

  // ---------------------------------------------------------------------------------------------
  // Queries used by strategies and tests

  def(kind: BuildingKind): BuildingDef {
    return this.map.buildings[kind];
  }
  count(kind: StructKind, place?: Place): number {
    let n = 0;
    for (const b of this.buildings) if (b.kind === kind && (place === undefined || b.place === place)) n++;
    return n;
  }
  countTier(kind: BuildingKind, place: Place, minTier: number): number {
    let n = 0;
    for (const b of this.buildings) if (b.kind === kind && b.place === place && b.tier >= minTier) n++;
    return n;
  }
  queued(kind: BuildingKind, place?: Place, type: 'build' | 'upgrade' = 'build', tier?: number): number {
    let n = 0;
    for (const q of this.queue)
      if (q.type === type && q.kind === kind && (place === undefined || q.place === place) && (tier === undefined || q.tier === tier)) n++;
    return n;
  }
  get engineerCount(): number {
    return this.count('engineer');
  }
  caps(): Res {
    if (!this.capped) return { mass: Infinity, energy: Infinity, rare: Infinity };
    const c = { ...this.map.baseStorage };
    for (const b of this.buildings) {
      const s = b.kind === 'temp' ? undefined : this.map.buildings[b.kind].storage;
      if (s) for (const r of RES) c[r] += s[r] ?? 0;
    }
    return c;
  }
  /** Limit on how many of a kind may exist at a place (deposits and rare points). */
  limit(kind: BuildingKind, place: Place): number {
    if (kind === 'massExtractor') return this.map.massDeposits;
    if (kind === 'rareExtractor') return this.map.rarePoints[place] ?? 0;
    return Infinity;
  }
  researched(id: ResearchId | undefined): boolean {
    return id === undefined || this.researchDone.has(id);
  }

  // ---------------------------------------------------------------------------------------------
  // Commands

  /** Queue a new building. Returns false if research, a deposit limit or placement forbids it. */
  enqueueBuild(kind: BuildingKind, place: Place, priority = 0): boolean {
    const d = this.def(kind);
    if (!this.researched(d.requires)) return false;
    if (kind === 'rareExtractor' && !this.map.approaches.includes(place)) return false;
    if (this.count(kind, kind === 'massExtractor' ? undefined : place) + this.queued(kind, kind === 'massExtractor' ? undefined : place) >= this.limit(kind, place)) return false;
    this.queue.push({ id: this.nextId++, type: 'build', kind, place, tier: 1, targetId: null, progress: 0, priority });
    return true;
  }

  /** Queue an engineer upgrade of one existing building at `place` to `tier`. */
  enqueueUpgrade(kind: BuildingKind, place: Place, tier: number, priority = 0): boolean {
    const t = this.def(kind).tiers?.[tier - 2];
    if (!t || !this.researched(t.requires)) return false;
    const targeted = new Set(this.queue.filter((q) => q.type === 'upgrade').map((q) => q.targetId));
    const target = this.buildings.find((b) => b.kind === kind && b.place === place && b.tier === tier - 1 && !targeted.has(b.id));
    if (!target) return false;
    this.queue.push({ id: this.nextId++, type: 'upgrade', kind, place, tier, targetId: target.id, progress: 0, priority });
    return true;
  }

  queueResearch(id: ResearchId): void {
    if (this.researchDone.has(id) || this.researchQueue.includes(id) || this.researchCurrent?.id === id) return;
    this.researchQueue.push(id);
  }

  /** Place a finished building immediately (tests and scenario set-up). */
  addBuilding(kind: BuildingKind, place: Place, tier = 1): Building {
    const d = this.def(kind);
    const mult = tier > 1 ? d.tiers![tier - 2].hpMult : 1;
    const b: Building = { id: this.nextId++, kind, place, hp: d.hp * mult, maxHp: d.hp * mult, tier, cooldown: 0, shieldHp: 0, expires: Infinity };
    this.buildings.push(b);
    this.built[kind] = (this.built[kind] ?? 0) + 1;
    return b;
  }

  /** Put an alien on an approach at `dist` metres (tests and wave spawns). */
  spawnAlien(kind: AlienKind, approach: string, dist?: number): Alien {
    const a: Alien = {
      id: this.nextId++,
      kind,
      approach,
      dist: dist ?? this.map.approachLength + this.rng() * 5,
      hp: this.map.aliens[kind].hp,
      targetId: null,
      dead: false,
    };
    this.aliens.push(a);
    return a;
  }

  // ---------------------------------------------------------------------------------------------
  // The tick

  run(): RunResult {
    while (!this.done) this.step();
    return this.result();
  }

  step(): void {
    if (this.done) return;
    const time = this.time;
    const m = this.map;
    const spendTick = zeroRes();

    // 1. Wave spawns due this tick.
    while (this.pendingIdx < this.pending.length && this.pending[this.pendingIdx].at <= time + EPS) {
      const p = this.pending[this.pendingIdx++];
      this.spawnAlien(p.kind, p.entry);
      this.waveReached = Math.max(this.waveReached, p.wave);
    }

    // 2. Player decisions, once per game second.
    if (this.strategy && this.tick % TICKS_PER_SECOND === 0) this.strategy.decide(this);

    // 3. Income into the pool.
    const income = { ...m.commander.income };
    for (const b of this.buildings) {
      if (b.kind === 'temp') continue;
      const inc = m.buildings[b.kind].income;
      if (inc) for (const r of RES) income[r] += inc[r] ?? 0;
    }
    for (const r of RES) {
      this.pool[r] += income[r] * DT;
      this.earned[r] += income[r] * DT;
    }

    // 4. Energy upkeep: beams with a target, shields while active, chain machines with input.
    //    All energy consumers share one supply ratio, and they draw before construction.
    const aliveAliens = this.aliens.length;
    let demand = 0;
    const beamActive = new Set<number>();
    const shieldActive = new Set<number>();
    for (const b of this.buildings) {
      if (b.kind === 'beam') {
        const w = m.buildings.beam.weapon!;
        if (this.findTarget(b.place, w) !== null) {
          beamActive.add(b.id);
          demand += w.energyPerSecond * DT;
        }
      } else if (b.kind === 'shield') {
        const s = m.buildings.shield.shield!;
        if (aliveAliens > 0 || b.shieldHp < s.capacity) {
          shieldActive.add(b.id);
          demand += s.energyPerSecond * DT;
        }
      }
    }
    const chainPossible = this.chainPossible();
    for (let s = 0; s < 3; s++) {
      const md = m.buildings[CHAIN_STAGES[s]].machine!;
      const n = this.count(CHAIN_STAGES[s]);
      const cap = (n * DT) / md.seconds;
      if (cap > 0) demand += n * md.energyPerSecond * DT * (chainPossible[s] / cap);
    }
    const u = demand > EPS ? Math.min(1, Math.max(0, this.pool.energy) / demand) : 1;
    this.upkeepRatio = u;
    this.pool.energy -= demand * u;
    this.spent.energy += demand * u;
    spendTick.energy += demand * u;

    // 5. Salvage chain, at the upkeep ratio.
    this.runChain(chainPossible, u);

    // 6. Reclaim: engineers assigned to salvage pull from wrecks into the depot.
    const eng = this.engineerCount;
    const hasDepot = this.count('depot') > 0;
    const share = this.strategy?.reclaimShare ?? 0;
    const reclaimers = hasDepot && this.wrecks > 0.01 ? Math.min(eng, Math.round(share * eng)) : 0;
    const take = Math.min(this.wrecks, reclaimers * m.engineer.reclaimRate * DT);
    this.wrecks -= take;
    this.depotSalvage += take;
    this.reclaimed += take;

    // 7. Construction drain (Forged Alliance): every active build and the current research draw
    //    cost/time × build rate per tick. For each resource, ratio = min(1, pool / requested).
    //    'perResource' (default): each build progresses at the lowest ratio among the resources it
    //    draws, so every build drawing a short resource slows by the same factor and builds that do
    //    not draw it are unaffected. 'global': the lowest ratio of any resource slows every build.
    const builders = (this.commanderHp > 0 ? 1 : 0) + (eng - reclaimers);
    const bpTotal = (this.commanderHp > 0 ? m.commander.buildRate : 0) + (eng - reclaimers) * m.engineer.buildRate;
    this.queue = this.queue.filter((q) => q.type === 'build' || this.buildings.some((b) => b.id === q.targetId));
    this.queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
    const active = this.queue.slice(0, Math.min(this.queue.length, builders));
    const bpEach = active.length > 0 ? bpTotal / active.length : 0;
    const req: { p: number; cost: Res; apply: (p: number) => void }[] = [];
    for (const q of active) {
      const d = this.def(q.kind);
      const cost = q.type === 'build' ? d.cost : d.tiers![q.tier - 2].upgradeCost;
      const t = q.type === 'build' ? d.buildTime : d.tiers![q.tier - 2].upgradeTime;
      const p = Math.min(1 - q.progress, (bpEach * DT) / t);
      req.push({ p, cost, apply: (x) => (q.progress += x) });
    }
    if (this.count('lab') > 0 && !this.researchCurrent && this.researchQueue.length > 0)
      this.researchCurrent = { id: this.researchQueue.shift()!, progress: 0 };
    const rc = this.count('lab') > 0 ? this.researchCurrent : null;
    if (rc) {
      const rd = m.research[rc.id];
      const p = Math.min(1 - rc.progress, (m.labRate * DT) / rd.seconds);
      req.push({ p, cost: rd.cost, apply: (x) => (rc.progress += x) });
    }
    const requested = zeroRes();
    for (const r of req) for (const k of RES) requested[k] += r.cost[k] * r.p;
    const ratio = { mass: 1, energy: 1, rare: 1 };
    let worst = 1;
    let limiting: ResKey | '' = '';
    for (const k of RES) {
      if (requested[k] > EPS) ratio[k] = Math.min(1, Math.max(0, this.pool[k]) / requested[k]);
      if (ratio[k] < worst - EPS) {
        worst = ratio[k];
        limiting = k;
      }
    }
    let slowed = 0;
    for (const r of req) {
      let f = 1;
      for (const k of RES) if (this.drain === 'global' || r.cost[k] > 0) f = Math.min(f, ratio[k]);
      if (f < 0.999) slowed++;
      r.apply(r.p * f);
      for (const k of RES) {
        const draw = r.cost[k] * r.p * f;
        this.pool[k] -= draw;
        this.spent[k] += draw;
        spendTick[k] += draw;
      }
    }
    for (const k of RES) if (this.pool[k] < 0 && this.pool[k] > -1e-9) this.pool[k] = 0;
    this.lastEfficiency = req.length > 0 ? worst : 1;
    this.lastActive = req.length;
    this.lastSlowed = slowed;
    if (slowed > 0 && limiting) {
      this.slowedTicks[limiting]++;
      const minute = Math.floor(time / 60);
      const arr = this.slowedByMinute[limiting];
      while (arr.length <= minute) arr.push(0);
      arr[minute] += DT;
    }
    if (slowed > 0 && worst < this.minEff) {
      this.minEff = worst;
      this.minEffTime = time;
      this.minEffRes = limiting;
    }
    // Completions.
    for (const q of active) {
      if (q.progress < 1 - 1e-9) continue;
      this.queue.splice(this.queue.indexOf(q), 1);
      if (q.type === 'build') this.addBuilding(q.kind, q.place);
      else {
        const b = this.buildings.find((x) => x.id === q.targetId);
        if (b) {
          const t = this.def(q.kind).tiers![q.tier - 2];
          const prevMult = b.tier > 1 ? this.def(q.kind).tiers![b.tier - 2].hpMult : 1;
          const newMax = this.def(q.kind).hp * t.hpMult;
          b.hp += newMax - this.def(q.kind).hp * prevMult;
          b.maxHp = newMax;
          b.tier = q.tier;
        }
      }
    }
    if (rc && rc.progress >= 1 - 1e-9) {
      this.researchDone.add(rc.id);
      this.researchLog.push({ id: rc.id, time });
      this.researchCurrent = null;
    }

    // 8. Engineers' drop turret: free, on a cooldown, on the approach with most aliens within 40 m.
    this.buildings = this.buildings.filter((b) => b.kind !== 'temp' || b.expires > time);
    if (eng > 0 && time >= this.tempReadyAt) {
      let best: string | null = null;
      let bestN = 0;
      for (const ap of m.approaches) {
        const n = this.aliens.filter((a) => a.approach === ap && a.dist <= 40).length;
        if (n > bestN) {
          bestN = n;
          best = ap;
        }
      }
      if (best) {
        const tt = m.tempTurret;
        this.buildings.push({ id: this.nextId++, kind: 'temp', place: best, hp: tt.hp, maxHp: tt.hp, tier: 1, cooldown: 0, shieldHp: 0, expires: time + tt.lifetime });
        this.built.temp = (this.built.temp ?? 0) + 1;
        this.tempReadyAt = time + tt.cooldown;
      }
    }

    // 9. Defences fire.
    let dealt = 0;
    let heavyDry = 0;
    const firers: { b: Building | null; cd: number; place: Place; w: WeaponDef; mult: number; rate: number }[] = [];
    for (const b of this.buildings) {
      const w = b.kind === 'temp' ? m.tempTurret.weapon : m.buildings[b.kind].weapon;
      if (!w) continue;
      const tiers = b.kind === 'temp' ? undefined : m.buildings[b.kind].tiers;
      const mult = b.tier > 1 && tiers ? tiers[b.tier - 2].damageMult : 1;
      // Energy weapons fire at the upkeep ratio; free-to-run weapons always at full rate.
      const rate = w.energyPerSecond > 0 ? (beamActive.has(b.id) ? u : 0) : 1;
      firers.push({ b, cd: b.cooldown, place: b.place, w, mult, rate });
    }
    if (this.commanderHp > 0) firers.push({ b: null, cd: this.commanderCooldown, place: 'core', w: m.commander.weapon, mult: 1, rate: 1 });
    for (const f of firers) {
      if (f.rate <= 0) continue; // an energy weapon with no energy does nothing
      f.cd -= DT * f.rate;
      let guard = 0;
      while (f.cd <= EPS && guard++ < 20) {
        const target = this.findTarget(f.place, f.w);
        if (!target) {
          f.cd = 0;
          break;
        }
        if (f.w.partsPerShot > 0) {
          // Heavy cannon: holds fire when the parts stock cannot cover a shot.
          if (this.parts + EPS < f.w.partsPerShot) {
            heavyDry++;
            f.cd = 0;
            break;
          }
          this.parts -= f.w.partsPerShot;
          this.partsUsed += f.w.partsPerShot;
        }
        dealt += this.hit(target, f.w.damage * f.mult);
        if (f.w.splashTargets > 0) {
          const near = this.aliens
            .filter((a) => !a.dead && a !== target && this.inReach(f.place, a, Infinity) && Math.abs(a.dist - target.dist) <= f.w.splashRadius)
            .sort((a, b) => Math.abs(a.dist - target.dist) - Math.abs(b.dist - target.dist) || a.id - b.id)
            .slice(0, f.w.splashTargets);
          for (const a of near) dealt += this.hit(a, f.w.damage * f.mult * f.w.splashFactor);
        }
        f.cd += 1 / f.w.shotsPerSecond;
      }
      if (f.b) f.b.cooldown = f.cd;
      else this.commanderCooldown = f.cd;
    }
    if (heavyDry > 0) this.heavyDryTicks++;
    // Remove the dead; their wrecks are the only source of salvage.
    const killed = this.aliens.filter((a) => a.dead);
    for (const a of killed) {
      const s = m.aliens[a.kind].salvage;
      this.wrecks += s;
      this.salvageFromKills += s;
      this.kills++;
    }
    if (killed.length) this.aliens = this.aliens.filter((a) => !a.dead);

    // 10. Aliens move or attack.
    for (const a of this.aliens) {
      this.alienAct(a);
      if (this.commanderHp <= 0) break;
    }
    const destroyed = this.buildings.filter((b) => b.hp <= 0);
    if (destroyed.length) {
      for (const b of destroyed) this.lost[b.kind] = (this.lost[b.kind] ?? 0) + 1;
      this.buildings = this.buildings.filter((b) => b.hp > 0);
    }
    if (this.count('depot') === 0) this.depotSalvage = 0;

    // 11. Shields recharge at the upkeep ratio.
    for (const b of this.buildings) {
      if (b.kind !== 'shield' || !shieldActive.has(b.id)) continue;
      const s = m.buildings.shield.shield!;
      b.shieldHp = Math.min(s.capacity, b.shieldHp + s.regenPerSecond * DT * u);
    }

    // 12. Wrecks decay.
    const dec = this.wrecks * m.wreckDecayPerSecond * DT;
    this.wrecks -= dec;
    this.decayed += dec;

    // 13. Storage cap: overflow above the cap is wasted (capped variant only).
    const cap = this.caps();
    const wastedTick = zeroRes();
    for (const k of RES) {
      if (this.pool[k] > cap[k]) {
        wastedTick[k] = this.pool[k] - cap[k];
        this.wasted[k] += wastedTick[k];
        this.pool[k] = cap[k];
      }
      this.poolSum[k] += this.pool[k];
      if (this.pool[k] > this.peakPool[k]) this.peakPool[k] = this.pool[k];
    }

    this.commanderMinHp = Math.min(this.commanderMinHp, Math.max(0, this.commanderHp));

    if (this.record) {
      let threat = 0;
      for (const a of this.aliens) threat += a.hp;
      let defences = 0;
      for (const b of this.buildings) if (b.kind !== 'temp' && (m.buildings[b.kind].role === 'defence' || m.buildings[b.kind].role === 'wall')) defences++;
      const perS = (r: Res): Res => ({ mass: r.mass / DT, energy: r.energy / DT, rare: r.rare / DT });
      this.rows.push({
        tick: this.tick,
        time,
        wave: this.waveReached,
        pool: { ...this.pool },
        income,
        spend: perS(spendTick),
        wasted: perS(wastedTick),
        cap,
        buildEfficiency: this.lastEfficiency,
        limiting: this.lastSlowed > 0 ? limiting : '',
        buildsActive: this.lastActive,
        buildsSlowed: this.lastSlowed,
        engineers: this.engineerCount,
        reclaimers,
        wrecks: this.wrecks,
        depotSalvage: this.depotSalvage,
        parts: this.parts,
        aliens: this.aliens.length,
        threatHp: threat,
        defenceDps: dealt / DT,
        heavyDry,
        energyUpkeepRatio: u,
        commanderHp: Math.max(0, this.commanderHp),
        defences,
      });
    }

    // 14. End conditions.
    if (this.commanderHp <= 0) {
      this.outcome = 'lost';
      this.endTime = time;
    } else if (this.pendingIdx >= this.pending.length && this.aliens.length === 0 && this.pending.length > 0) {
      this.outcome = 'won';
      this.endTime = time;
    } else if (time >= this.maxSeconds) {
      this.outcome = 'timeout';
      this.endTime = time;
    }
    this.tick++;
  }

  private commanderCooldown = 0;

  /** Items each chain stage could make this tick before the energy ratio is applied. */
  private chainPossible(): number[] {
    const m = this.map;
    const inputs = [this.depotSalvage, this.scrap, this.alloy];
    return CHAIN_STAGES.map((k, s) => {
      const md = m.buildings[k].machine!;
      const cap = (this.count(k) * DT) / md.seconds;
      return Math.max(0, Math.min(cap, inputs[s] / md.inputPerOutput, m.beltItemsPerSecond * DT));
    });
  }

  private runChain(possible: number[], u: number): void {
    const m = this.map;
    for (let s = 0; s < 3; s++) {
      const md = m.buildings[CHAIN_STAGES[s]].machine!;
      const inputNow = s === 0 ? this.depotSalvage : s === 1 ? this.scrap : this.alloy;
      const out = Math.min(possible[s] * u, inputNow / md.inputPerOutput);
      if (out <= 0) continue;
      const used = out * md.inputPerOutput;
      if (s === 0) {
        this.depotSalvage -= used;
        this.scrap += out;
      } else if (s === 1) {
        this.scrap -= used;
        this.alloy += out;
      } else {
        this.alloy -= used;
        this.parts += out;
        this.partsMade += out;
      }
    }
  }

  private inReach(place: Place, a: Alien, range: number): boolean {
    if (place === 'core') return a.dist <= 0;
    return a.approach === place && a.dist <= range;
  }

  /** Nearest alien in reach, preferring the weapon's favoured kind. */
  private findTarget(place: Place, w: WeaponDef): Alien | null {
    let best: Alien | null = null;
    let bestPref = false;
    for (const a of this.aliens) {
      if (a.dead || !this.inReach(place, a, w.range)) continue;
      const pref = w.prefer !== undefined && a.kind === w.prefer;
      if (best === null || (pref && !bestPref) || (pref === bestPref && (a.dist < best.dist || (a.dist === best.dist && a.id < best.id)))) {
        best = a;
        bestPref = pref;
      }
    }
    return best;
  }

  /** One shot: flat armour reduction, at least 10% of the shot gets through. */
  private hit(a: Alien, damage: number): number {
    const armour = this.map.aliens[a.kind].armour;
    const dmg = Math.max(damage - armour, damage * 0.1);
    const applied = Math.min(dmg, a.hp);
    a.hp -= dmg;
    if (a.hp <= 0) a.dead = true;
    return applied;
  }

  private alienAct(a: Alien): void {
    const m = this.map;
    const d = m.aliens[a.kind];
    const wall = this.buildings.find((b) => b.kind === 'wall' && b.place === a.approach && b.hp > 0) ?? null;
    if (a.dist > 0) {
      const rareHere =
        d.target === 'economy' ? this.buildings.find((b) => b.kind === 'rareExtractor' && b.place === a.approach && b.hp > 0) ?? null : null;
      if (rareHere && a.dist <= m.rarePointDist + EPS) {
        this.damageBuilding(rareHere, d.dps * DT);
        return;
      }
      if (!d.bypassWalls && wall && a.dist <= m.wallLine + EPS) {
        this.damageBuilding(wall, d.dps * d.structureMult * DT);
        return;
      }
      const slow = d.bypassWalls && wall && a.dist <= m.wallLine + m.detourZone ? m.detourFactor : 1;
      let nd = a.dist - d.speed * slow * DT;
      if (!d.bypassWalls && wall && nd < m.wallLine) nd = m.wallLine;
      if (rareHere && a.dist > m.rarePointDist && nd < m.rarePointDist) nd = m.rarePointDist;
      a.dist = Math.max(0, nd);
      if (a.dist === 0) this.reachedBase[a.kind]++;
      return;
    }
    // Inside the base: attack the target category, falling back to the commander.
    if (a.targetId !== null && a.targetId !== -1 && !this.buildings.some((b) => b.id === a.targetId && b.hp > 0)) a.targetId = null;
    if (a.targetId === null) a.targetId = this.chooseTarget(a);
    if (a.targetId === -1) {
      this.commanderDamageBy[a.kind] += this.damageCommander(d.dps * DT);
      return;
    }
    const b = this.buildings.find((x) => x.id === a.targetId)!;
    const isStructure = b.kind === 'temp' || m.buildings[b.kind].role === 'defence' || m.buildings[b.kind].role === 'wall';
    this.damageBuilding(b, d.dps * (isStructure ? d.structureMult : 1) * DT);
  }

  private chooseTarget(a: Alien): number {
    const m = this.map;
    const d = m.aliens[a.kind];
    const isDefence = (b: Building) => b.hp > 0 && (b.kind === 'temp' || m.buildings[b.kind].role === 'defence');
    const economy = () =>
      this.buildings.filter((b) => b.hp > 0 && b.place === 'base' && b.kind !== 'temp' && ['economy', 'chain', 'unit'].includes(m.buildings[b.kind].role));
    if (d.target === 'defences') {
      // Lane turrets, then core turrets, then the base's economy buildings; the commander last.
      const onLane = this.buildings.find((b) => isDefence(b) && b.place === a.approach);
      if (onLane) return onLane.id;
      const core = this.buildings.find((b) => isDefence(b) && b.place === 'core');
      if (core) return core.id;
      const eco = economy();
      if (eco.length) return eco[0].id;
      return -1;
    }
    if (d.target === 'economy') {
      const cands = economy();
      if (cands.length) return cands[Math.floor(this.rng() * cands.length)].id;
      return -1;
    }
    return -1;
  }

  /** Shields at `place` absorb projectile damage first, scaled by the energy upkeep ratio. */
  private absorb(place: Place, dmg: number): number {
    if (this.upkeepRatio <= 0) return dmg;
    for (const s of this.buildings) {
      if (dmg <= 0) break;
      if (s.kind !== 'shield' || s.place !== place || s.hp <= 0 || s.shieldHp <= 0) continue;
      const can = Math.min(dmg * this.upkeepRatio, s.shieldHp);
      s.shieldHp -= can;
      dmg -= can;
    }
    return dmg;
  }

  private damageBuilding(b: Building, dmg: number): void {
    const role = b.kind === 'temp' ? 'defence' : this.map.buildings[b.kind].role;
    if (role !== 'wall') {
      // Rare extractors sit out on their approach, beyond any shield.
      const cover = this.map.approaches.includes(b.place) ? (role === 'defence' ? b.place : null) : 'core';
      if (cover) dmg = this.absorb(cover, dmg);
    }
    b.hp -= dmg;
  }

  private damageCommander(dmg: number): number {
    const taken = this.absorb('core', dmg);
    this.commanderHp -= taken;
    return taken;
  }

  result(): RunResult {
    const ticks = Math.max(1, this.tick);
    const meanPool = zeroRes();
    for (const k of RES) meanPool[k] = this.poolSum[k] / ticks;
    return {
      outcome: this.outcome,
      endTime: this.endTime,
      waveReached: this.waveReached,
      wavesTotal: this.map.waves.length,
      commanderHp: Math.max(0, this.commanderHp),
      commanderMaxHp: this.map.commander.hp,
      commanderMinHp: this.commanderMinHp,
      earned: { ...this.earned },
      spent: { ...this.spent },
      wasted: { ...this.wasted },
      startStock: { ...this.map.startStock },
      meanPool,
      peakPool: { ...this.peakPool },
      minEfficiency: this.minEff,
      minEfficiencyTime: this.minEffTime,
      minEfficiencyResource: this.minEffRes,
      slowedSeconds: { mass: this.slowedTicks.mass * DT, energy: this.slowedTicks.energy * DT, rare: this.slowedTicks.rare * DT },
      slowedByMinute: this.slowedByMinute,
      kills: this.kills,
      salvageFromKills: this.salvageFromKills,
      reclaimed: this.reclaimed,
      decayed: this.decayed,
      partsMade: this.partsMade,
      partsUsed: this.partsUsed,
      heavyDrySeconds: this.heavyDryTicks * DT,
      reachedBase: { ...this.reachedBase },
      commanderDamageBy: { ...this.commanderDamageBy },
      lost: { ...this.lost },
      built: { ...this.built },
      researchDone: [...this.researchLog],
    };
  }
}
