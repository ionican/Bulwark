// W24 run 3 (criterion 3): the one active map tool. Select by default; build (one building kind),
// wall (the wall drag, chosen as the wall kind from the build bar or the panel), upgrade, gate and
// spawn. Choosing a tool ends the previous one. A left action without Shift returns to select; with
// Shift the tool stays until Shift is released after a Shift-held action. Belts stay open after a
// placement either way, as they did before run 3. Escape and right click cancel any tool but select
// (right click in select is an order or a pan, so it is not consumed). A world change returns to
// select. Gate and spawn are sandbox-only: `allowed` says which tools the current scenario permits.
// W31: the build tool also carries a belt speed (`tier`, 1 Slow .. 3 Fast; 1 for every other kind),
// and B picks the fastest belt speed researched (fastestBeltTier). The upgrade tool also takes a
// drag along belts (main.ts: one upgradeBelts command per drag).
// Pure: main.ts owns the input and calls these; the panel names the tool from toolLabel().

import type { Command } from './sim/commands.ts';
import { SPAWN_AT_MAX, tierRequires } from './sim/balance.ts';
import { B, BELT_TOP_TIER, isBelt } from './sim/kinds.ts';

export type ToolName = 'select' | 'build' | 'wall' | 'upgrade' | 'gate' | 'spawn';

export class Tools {
  name: ToolName = 'select';
  /** The building kind for build and wall; -1 otherwise. */
  kind = -1;
  /** W31: the belt speed the build tool lays (1 Slow, 2 Medium, 3 Fast); 1 for any other kind. */
  tier = 1;
  /** An action was taken with Shift held since the tool was chosen. */
  shiftActed = false;

  constructor(private readonly allowed: (name: ToolName) => boolean) {}

  /** Makes `name` the active tool. Refused (false) when the scenario does not allow it. */
  choose(name: ToolName, kind = -1, tier = 1): boolean {
    if (name === 'build' && kind === B.wall) name = 'wall';
    if (name === 'wall') kind = B.wall;
    if (name !== 'select' && !this.allowed(name)) return false;
    this.name = name;
    this.kind = name === 'build' || name === 'wall' ? kind : -1;
    this.tier = name === 'build' && kind === B.belt ? tier : 1;
    this.shiftActed = false;
    return true;
  }

  /**
   * A tool that needs builders (build, wall or upgrade), chosen by the build bar or a key: armed when
   * `builders` are selected; without them the shortcut cannot arm, and the map returns to select
   * whatever tool was active, so an armed gate or spawn tool does not act on the next click.
   */
  chooseForBuilders(name: 'build' | 'wall' | 'upgrade', builders: boolean, kind = -1, tier = 1): boolean {
    if (!builders) {
      this.reset();
      return false;
    }
    return this.choose(name, kind, tier);
  }

  /** A left action with the tool (a placement, a gate, a spawn, an upgrade order). */
  acted(shift: boolean): void {
    if (this.name === 'select') return;
    if (shift) this.shiftActed = true;
    else if (!this.keepsOpen()) this.reset();
  }

  shiftReleased(): void {
    if (this.shiftActed && !this.keepsOpen()) this.reset();
    this.shiftActed = false;
  }

  /** True when a tool was cancelled (the key is consumed). */
  escape(): boolean {
    return this.cancel();
  }

  /** True when a tool was cancelled; false in select, where right click orders or pans. */
  rightClick(): boolean {
    return this.cancel();
  }

  worldChanged(): void {
    this.reset();
  }

  /** Drops the tool if the scenario no longer allows it (a map 1 save loaded with gate armed). */
  check(): void {
    if (this.name !== 'select' && !this.allowed(this.name)) this.reset();
  }

  private keepsOpen(): boolean {
    return this.name === 'build' && isBelt(this.kind);
  }

  private cancel(): boolean {
    if (this.name === 'select') return false;
    this.reset();
    return true;
  }

  private reset(): void {
    this.name = 'select';
    this.kind = -1;
    this.tier = 1;
    this.shiftActed = false;
  }
}

/** W31: the fastest belt speed whose research is done (`researched` takes a research id): B selects it. */
export function fastestBeltTier(researched: (id: string) => boolean): number {
  let tier = 1;
  while (tier < BELT_TOP_TIER && researched(tierRequires('belt', tier + 1)!)) tier++;
  return tier;
}

/** The panel's words for the active tool (colour is never the only sign of it). */
export function toolLabel(t: Tools, o: { spawnName?: string; count?: number; depth?: number; kindName?: string }): string {
  switch (t.name) {
    case 'select':
      return 'Tool: select — click to select, right click to order';
    case 'build':
      return `Tool: build${o.kindName ? ` ${o.kindName}` : ''} — click the map`;
    case 'wall':
      return `Tool: wall run, depth ${o.depth ?? 1} — drag on the map`;
    case 'upgrade':
      return 'Tool: upgrade — click a wall, turret or belt; drag along belts';
    case 'gate':
      return 'Tool: gate — click a finished wall';
    case 'spawn':
      return `Tool: spawn ${o.spawnName ?? ''} × ${o.count ?? 1} — click the map`;
  }
}

/** A gate on the wall run through tile (tx, ty). No axis: the simulation's predicate picks it. */
type Cmd<T extends Command['t']> = Extract<Command, { t: T }>;

export function gateCommand(ids: number[], tx: number, ty: number, queue: boolean): Cmd<'gate'> {
  return { t: 'gate', ids, tx, ty, queue };
}

/** `v` rounded to a whole number in lo..hi (not finite: lo). */
export function clampInt(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo;
}

/** Clamps a typed or stepped alien count to a whole number 1..SPAWN_AT_MAX (NaN: 1). */
export const clampSpawnCount = (n: number): number => clampInt(n, 1, SPAWN_AT_MAX);

export function spawnAtCommand(kind: number, x: number, z: number, count: number): Cmd<'spawnAt'> {
  return { t: 'spawnAt', kind, x, z, count: clampSpawnCount(count) };
}

export function runCommand(ids: number[], from: [number, number], to: [number, number], depth: number, queue: boolean): Cmd<'buildRun'> {
  return { t: 'buildRun', ids, from, to, depth, queue };
}
