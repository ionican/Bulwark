// Build bar and debug controls (DOM). Labels are text, so nothing depends on colour.

import { ALIEN_KINDS, ALIEN_INFO, BUILDING_INFO, type BuildingKind } from '../sim/kinds.ts';

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
.dbg{position:fixed;right:8px;top:56px;font:11px ui-monospace,Menlo,monospace;color:#f4efe6;background:rgba(18,15,13,.88);
border:1px dashed rgba(244,239,230,.45);border-radius:4px;padding:4px 6px;pointer-events:auto}
.dbg button{font:inherit;color:#f4efe6;background:#2a2420;border:1px solid rgba(244,239,230,.4);border-radius:3px;padding:2px 5px;margin:1px;cursor:pointer}
.dbg label{display:block;margin-top:3px}`;

export const BUILD_GROUPS: Array<[string, BuildingKind[]]> = [
  ['ECONOMY', ['massExtractor', 'generator', 'rareExtractor']],
  ['SALVAGE CHAIN', ['depot', 'belt', 'splitter', 'merger', 'shredder', 'smelter', 'assembler']],
  ['DEFENCE', ['wall', 'gun', 'area', 'beam', 'heavy', 'shield']],
];

/** Test-group sizes for the debug spawn buttons (W12 wave 2–5 scale). */
export const TEST_GROUP: Record<string, number> = { rusher: 16, hunter: 4, breaker: 3, saboteur: 6 };

const cost = (k: BuildingKind) => {
  const [m, e, r] = BUILDING_INFO[k].cost;
  return `${m}M ${e}E${r ? ` ${r}R` : ''}`;
};

export interface BuildBarHandlers {
  build(kind: BuildingKind): void;
  upgrade(): void;
  dropTurret(): void;
  stop(): void;
  spawn(kind: number, entry: number): void;
}

export class BuildBar {
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly hint: HTMLDivElement;

  constructor(h: BuildBarHandlers, entries: string[]) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    for (const [title, kinds] of BUILD_GROUPS) {
      const g = this.group(bar, title);
      for (const k of kinds) {
        const info = BUILDING_INFO[k];
        const b = this.button(g, `${info.label} [${info.key.toUpperCase()}]`, cost(k), () => h.build(k));
        b.dataset.kind = k;
        this.buttons.set(k, b);
      }
    }
    const act = this.group(bar, 'ENGINEERS');
    this.buttons.set('upgrade', this.button(act, 'Upgrade wall [U]', 'click a wall', () => h.upgrade()));
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

  /** Enables the bar for builders; marks the active tool. */
  update(canBuild: boolean, hasEngineers: boolean, active: string | null, hint: string) {
    for (const [k, b] of this.buttons) {
      b.disabled = k === 'upgrade' || k === 'turret' ? !hasEngineers : !canBuild;
      b.classList.toggle('on', k === active);
    }
    this.hint.textContent = hint;
  }
}
