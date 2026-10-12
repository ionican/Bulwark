// Build bar and debug controls (DOM). Labels are text, so nothing depends on colour.
// W31: the bar is a list of entries, not kinds: the belt has three, "Belt — Slow", "Belt — Medium"
// and "Belt — Fast", each its own button (ids beltSlow, beltMedium, beltFast; data-kind "belt" and
// data-tier 1..3). A locked entry is disabled and says "✕ needs <research>" (entryLock).

import { ALIEN_KINDS, ALIEN_INFO, BELT_SPEED_NAMES, BUILDING_INFO, beltLaidWork, type BuildingKind } from '../sim/kinds.ts';
import { BUILD_REQUIRES, RESEARCH, RESEARCH_INDEX, TIER_REQUIRES } from '../sim/balance.ts';

const css = `
.bar{position:fixed;left:50%;bottom:8px;transform:translateX(-50%);display:flex;gap:10px;align-items:flex-end;
font:11px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f4efe6;pointer-events:auto}
.bar .grp{background:rgba(18,15,13,.88);border:1px solid rgba(244,239,230,.35);border-radius:4px;padding:3px 5px;max-width:330px}
.bar .grp h4{margin:0 0 3px;font-size:10px;letter-spacing:.08em;opacity:.7;font-weight:600}
.bar button{font:inherit;color:#f4efe6;background:#2a2420;border:1px solid rgba(244,239,230,.4);border-radius:3px;
padding:2px 5px;margin:1px;cursor:pointer;text-align:left}
.bar button:hover{border-color:#f4efe6}
.bar button.on{outline:2px solid #fff3a0;outline-offset:1px;font-weight:700}
.bar button:disabled{opacity:.4;cursor:default}
.bar button small{font-size:10px;opacity:.7;margin-left:4px}
.dbg{position:fixed;right:8px;top:118px;font:11px ui-monospace,Menlo,monospace;color:#f4efe6;background:rgba(18,15,13,.88);
border:1px dashed rgba(244,239,230,.45);border-radius:4px;padding:4px 6px;pointer-events:auto}
.dbg button{font:inherit;color:#f4efe6;background:#2a2420;border:1px solid rgba(244,239,230,.4);border-radius:3px;padding:2px 5px;margin:1px;cursor:pointer}
.dbg label{display:block;margin-top:3px}`;

export const BUILD_GROUPS: Array<[string, BuildingKind[]]> = [
  ['ECONOMY', ['massExtractor', 'generator', 'rareExtractor', 'lab']],
  ['SALVAGE CHAIN', ['depot', 'belt', 'splitter', 'merger', 'shredder', 'smelter', 'assembler']],
  ['DEFENCE', ['wall', 'gun', 'area', 'beam', 'heavy', 'shield']],
];

/** W31: one build-bar button: a kind, laid at `tier` (belts 1..3; every other kind 1). */
export interface BuildEntry {
  id: string;
  kind: BuildingKind;
  tier: number;
  label: string;
  /** Hotkey shown on the button ('' none). */
  key: string;
}

/** The build-bar entry id of `kind` at `tier`: the kind's name, a belt's "beltSlow" / "beltMedium" / "beltFast". */
export const entryId = (kind: BuildingKind, tier = 1): string => (kind === 'belt' ? `belt${BELT_SPEED_NAMES[tier]}` : kind);

/** BUILD_GROUPS as entries: each kind once, the belt once per speed. */
export const BUILD_ENTRIES: Array<[string, BuildEntry[]]> = BUILD_GROUPS.map(([title, kinds]) => [
  title,
  kinds.flatMap((k): BuildEntry[] => {
    const info = BUILDING_INFO[k];
    if (k !== 'belt') return [{ id: entryId(k), kind: k, tier: 1, label: info.label, key: info.key }];
    return [1, 2, 3].map((tier) => ({ id: entryId(k, tier), kind: k, tier, label: `Belt — ${BELT_SPEED_NAMES[tier]}`, key: info.key }));
  }),
]);

/** The research an entry still needs (its label), or null: a kind's research, or a belt speed's. */
export function entryLock(e: Pick<BuildEntry, 'kind' | 'tier'>, researched: (id: string) => boolean): string | null {
  const req = e.kind === 'belt' ? (e.tier > 1 ? TIER_REQUIRES.belt![e.tier - 2]! : undefined) : BUILD_REQUIRES[e.kind];
  return req && !researched(req) ? RESEARCH[RESEARCH_INDEX[req]!]!.label : null;
}

/** Test-group sizes for the debug spawn buttons (W12 wave 2–5 scale). */
export const TEST_GROUP: Record<string, number> = { rusher: 16, hunter: 4, breaker: 3, saboteur: 6 };

/** A kind's cost as the bar shows it: "0.5M 0E" for a belt tile (fractions as they are, never rounded); W31: a belt at `tier` costs its laid cost. */
export const costLabel = (k: BuildingKind, tier = 1) => {
  const [m, e, r] = k === 'belt' ? beltLaidWork(tier).cost : BUILDING_INFO[k].cost;
  return `${m}M ${e}E${r ? ` ${r}R` : ''}`;
};

export interface BuildBarHandlers {
  build(kind: BuildingKind, tier: number): void;
  upgrade(): void;
  produce(): void;
  dropTurret(): void;
  stop(): void;
  spawn(kind: number, entry: number): void;
}

export class BuildBar {
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly entries = new Map<string, BuildEntry>();
  private readonly hint: HTMLDivElement;

  constructor(h: BuildBarHandlers, entries: string[]) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    for (const [title, entries] of BUILD_ENTRIES) {
      const g = this.group(bar, title);
      for (const e of entries) {
        const cost = costLabel(e.kind, e.tier);
        const b = this.button(g, `${e.label}${e.key ? ` [${e.key.toUpperCase()}]` : ''}`, cost, () => h.build(e.kind, e.tier));
        b.dataset.kind = e.kind;
        if (e.kind === 'belt') b.dataset.tier = String(e.tier);
        b.dataset.entry = e.id;
        b.dataset.cost = cost;
        this.buttons.set(e.id, b);
        this.entries.set(e.id, e);
      }
    }
    const act = this.group(bar, 'ENGINEERS');
    this.buttons.set('upgrade', this.button(act, 'Upgrade [U]', 'click a wall, turret or belt', () => h.upgrade()));
    this.buttons.set('produce', this.button(act, 'Produce engineer', 'commander: 60M 200E', () => h.produce()));
    this.buttons.set('turret', this.button(act, 'Drop turret [T]', '75 s cooldown', () => h.dropTurret()));
    this.buttons.set('stop', this.button(act, 'Stop [X]', 'clear orders', () => h.stop()));
    this.hint = document.createElement('div');
    this.hint.style.cssText = 'font-size:11px;opacity:.85;max-width:200px;margin-top:3px;min-height:14px';
    act.appendChild(this.hint);
    document.body.appendChild(bar);

    const dbg = document.createElement('div');
    dbg.className = 'dbg';
    dbg.addEventListener('pointerdown', (e) => e.stopPropagation());
    dbg.innerHTML = '<b>DEBUG</b> spawn a test group';
    entries.forEach((name, ei) => {
      const row = document.createElement('div');
      row.textContent = `${name}: `;
      ALIEN_KINDS.forEach((k, ki) => {
        const b = document.createElement('button');
        b.textContent = `${TEST_GROUP[k]} ${ALIEN_INFO[k].label.split(' ').pop()}`;
        b.dataset.spawn = `${k}:${ei}`;
        b.onclick = () => h.spawn(ki, ei);
        row.appendChild(b);
      });
      dbg.appendChild(row);
    });
    document.body.appendChild(dbg);
  }

  private group(parent: HTMLElement, title: string) {
    const g = document.createElement('div');
    g.className = 'grp';
    const t = document.createElement('h4');
    t.textContent = title;
    g.appendChild(t);
    parent.appendChild(g);
    return g;
  }

  private button(parent: HTMLElement, label: string, sub: string, onClick: () => void) {
    const b = document.createElement('button');
    b.innerHTML = `${label}<small>${sub}</small>`;
    b.onclick = onClick;
    parent.appendChild(b);
    return b;
  }

  /** Enables the bar for builders; marks the active tool (an entry id or 'upgrade'); marks entries still locked by research. */
  update(canBuild: boolean, hasEngineers: boolean, hasCommander: boolean, active: string | null, hint: string, locked: (entry: BuildEntry) => string | null) {
    for (const [k, b] of this.buttons) {
      const e = this.entries.get(k);
      const lock = e ? locked(e) : null;
      b.disabled = k === 'upgrade' || k === 'turret' ? !hasEngineers : k === 'produce' ? !hasCommander : !canBuild || lock !== null;
      b.classList.toggle('on', k === active);
      b.title = lock ? `Locked: needs research "${lock}"` : '';
      const small = b.querySelector('small');
      if (small && lock && !small.textContent!.startsWith('✕')) small.textContent = `✕ needs ${lock}`;
      if (small && !lock && small.textContent!.startsWith('✕')) small.textContent = b.dataset.cost ?? '';
    }
    this.hint.textContent = hint;
  }
}
