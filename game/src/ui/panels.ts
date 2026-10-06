// M3 interface panels (DOM): next-wave ticker, time controls, research panel, end screen, toasts.
// Everything is labelled in text and alien kinds are drawn as their icon shapes, so nothing
// depends on colour.

import { map1 } from '../../../model/data/map1.ts';
import { ALIEN_INFO, type AlienKind } from '../sim/kinds.ts';
import { BRANCHES, RESEARCH, type ResearchNode } from '../sim/balance.ts';
import { ALIEN_ICONS, type Pt } from '../render/geometry.ts';

const css = `
.pnl{position:fixed;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f4efe6;background:rgba(18,15,13,.9);
border:1px solid rgba(244,239,230,.4);border-radius:4px;padding:6px 9px;pointer-events:auto}
.pnl button{font:inherit;color:#f4efe6;background:#2a2420;border:1px solid rgba(244,239,230,.45);border-radius:3px;padding:2px 7px;margin:1px;cursor:pointer}
.pnl button:hover{border-color:#f4efe6}.pnl button:disabled{opacity:.4;cursor:default}
.pnl button.on{outline:2px solid #fff3a0;outline-offset:1px;font-weight:700}
.ticker{left:50%;top:8px;transform:translateX(-50%);min-width:400px;max-width:560px;text-align:center}
.ticker .t{font-size:15px;font-weight:700;letter-spacing:.04em}
.ticker .grp{display:inline-flex;align-items:center;gap:3px;margin:2px 6px}
.ticker svg{vertical-align:middle}
.ticker .later{opacity:.75;font-size:11px;margin-top:3px}
.timec{left:8px;top:140px}
.research{left:50%;top:50%;transform:translate(-50%,-50%);width:760px;max-height:80vh;overflow:auto;display:none;z-index:5}
.research h3{margin:0 0 4px;font-size:14px}.research h4{margin:8px 0 2px;font-size:12px;letter-spacing:.06em}
.research .node{display:grid;grid-template-columns:24px 1fr auto;gap:6px;align-items:center;border-top:1px dashed rgba(244,239,230,.25);padding:3px 0}
.research .st{font-weight:700;text-align:center}
.end{left:50%;top:40%;transform:translate(-50%,-50%);min-width:420px;text-align:center;z-index:6;display:none;padding:16px 20px}
.end h2{margin:0 0 8px;font-size:22px;letter-spacing:.08em}
.toasts{position:fixed;left:50%;bottom:150px;transform:translateX(-50%);display:flex;flex-direction:column;gap:4px;align-items:center;pointer-events:none;z-index:7}
.toast{font:12px ui-monospace,Menlo,monospace;color:#f4efe6;background:rgba(18,15,13,.92);border:1px solid #f4efe6;border-radius:4px;padding:4px 10px}
.toast.bad{border-style:dashed;border-width:2px}`;

export const fmtTime = (ticks: number) => {
  const s = Math.max(0, Math.floor(ticks / 10));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Inline SVG of an alien kind's icon shape (same outline as the map icon). */
export function alienIconSvg(kind: AlienKind, px = 16): string {
  const spec = ALIEN_ICONS[kind];
  const path = (pts: Pt[]) => `M${pts.map(([x, y]) => `${x.toFixed(2)} ${(-y).toFixed(2)}`).join('L')}Z`;
  const d = path(spec.outer) + (spec.holes ?? []).map(path).join('');
  return `<svg width="${px}" height="${px}" viewBox="-1.3 -1.3 2.6 2.6" aria-label="${ALIEN_INFO[kind].label}"><path d="${d}" fill="#f2a33a" fill-rule="evenodd" stroke="#120f0d" stroke-width="0.22"/></svg>`;
}

function waveLine(i: number): string {
  const wave = map1.waves[i]!;
  const byEntry = new Map<string, string[]>();
  for (const g of wave.groups) {
    const list = byEntry.get(g.entry) ?? [];
    list.push(`<span class="grp">${alienIconSvg(g.kind as AlienKind)} ${g.count} ${ALIEN_INFO[g.kind as AlienKind].label.split(' ').pop()}</span>`);
    byEntry.set(g.entry, list);
  }
  return [...byEntry].map(([entry, parts]) => `<b>${entry.toUpperCase()}:</b> ${parts.join('')}`).join(' &nbsp; ');
}

export interface TickerState {
  tick: number;
  nextWave: number;
  nextWaveTick: number;
  waveCount: number;
  aliens: number;
  preview: number;
}

export class Ticker {
  readonly el: HTMLDivElement;
  private key = '';

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'pnl ticker';
    document.body.appendChild(this.el);
  }

  update(s: TickerState): void {
    let html: string;
    if (s.nextWave >= s.waveCount) {
      html = `<div class="t">ALL ${s.waveCount} WAVES HAVE ARRIVED</div><div>Destroy the remaining ${s.aliens} aliens to win</div>`;
    } else {
      html =
        `<div class="t">WAVE ${s.nextWave + 1} OF ${s.waveCount} IN ${fmtTime(s.nextWaveTick - s.tick)}</div>` +
        `<div>${waveLine(s.nextWave)}</div>` +
        (s.preview > 1 && s.nextWave + 1 < s.waveCount ? `<div class="later">then wave ${s.nextWave + 2}: ${waveLine(s.nextWave + 1)}</div>` : '');
    }
    if (html !== this.key) {
      this.el.innerHTML = html;
      this.key = html;
    }
  }
}

export interface TimeHandlers {
  pause(): void;
  speed(s: number): void;
  callEarly(): void;
  rewind(): void;
  research(): void;
  exportSave(): void;
  importSave(file: File): void;
}

export class TimeControls {
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly status: HTMLDivElement;

  constructor(h: TimeHandlers) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.className = 'pnl timec';
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    const add = (key: string, label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.ctl = key;
      b.onclick = fn;
      el.appendChild(b);
      this.buttons.set(key, b);
      return b;
    };
    add('pause', 'Pause [Space]', h.pause);
    el.appendChild(document.createElement('br'));
    add('s1', '1× [Shift+1]', () => h.speed(1));
    add('s2', '2× [Shift+2]', () => h.speed(2));
    add('s3', '3× [Shift+3]', () => h.speed(3));
    el.appendChild(document.createElement('br'));
    add('call', 'Call next wave now [C]', h.callEarly);
    el.appendChild(document.createElement('br'));
    add('rewind', 'Rewind to wave start', h.rewind);
    el.appendChild(document.createElement('br'));
    add('research', 'Research [Y]', h.research);
    el.appendChild(document.createElement('br'));
    add('export', 'Export save', h.exportSave);
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.bulwark,application/octet-stream';
    file.style.display = 'none';
    file.dataset.ctl = 'importFile';
    file.onchange = () => {
      if (file.files?.[0]) h.importSave(file.files[0]);
      file.value = '';
    };
    el.appendChild(file);
    add('import', 'Import save', () => file.click());
    this.status = document.createElement('div');
    this.status.style.cssText = 'margin-top:4px;font-size:11px;opacity:.85;max-width:210px';
    el.appendChild(this.status);
    document.body.appendChild(el);
  }

  update(s: { paused: boolean; speed: number; canCall: boolean; checkpoints: number; time: number; bonus: [number, number] }): void {
    this.buttons.get('pause')!.textContent = s.paused ? 'Resume [Space]' : 'Pause [Space]';
    this.buttons.get('pause')!.classList.toggle('on', s.paused);
    for (const n of [1, 2, 3]) this.buttons.get(`s${n}`)!.classList.toggle('on', s.speed === n);
    this.buttons.get('call')!.disabled = !s.canCall;
    this.buttons.get('rewind')!.disabled = s.checkpoints === 0;
    this.status.textContent =
      `${s.paused ? 'PAUSED · ' : ''}game time ${fmtTime(s.time)} · ${s.speed}×` +
      (s.bonus[0] > 0 ? ` · early-call bonus so far ${s.bonus[0].toFixed(0)} M, ${s.bonus[1].toFixed(0)} E` : '');
  }
}

export interface ResearchState {
  done: number;
  queued: number;
  current: number;
  progress: number;
  rate: number;
  pool: number[];
}

export class ResearchPanel {
  readonly el: HTMLDivElement;
  private key = '';
  open = false;

  constructor(private readonly onPick: (id: string) => void) {
    this.el = document.createElement('div');
    this.el.className = 'pnl research';
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.dataset.node) this.onPick(t.dataset.node);
      if (t.dataset.close) this.toggle(false);
    });
    document.body.appendChild(this.el);
  }

  toggle(on = !this.open): void {
    this.open = on;
    this.el.style.display = on ? 'block' : 'none';
    this.key = '';
  }

  private status(n: ResearchNode, i: number, s: ResearchState): [string, string, string] {
    const bit = 1 << i;
    if (s.done & bit) return ['✓', 'DONE', ''];
    if (s.current === i) return ['►', `RESEARCHING ${(s.progress * 100).toFixed(0)}%`, ''];
    if (s.queued & bit) return ['…', 'QUEUED', ''];
    if (n.requires) {
      const ri = RESEARCH.findIndex((r) => r.id === n.requires);
      if (!(s.done & (1 << ri)) && s.current !== ri && !(s.queued & (1 << ri))) return ['✕', `LOCKED: needs ${RESEARCH[ri]!.label}`, ''];
    }
    return ['○', '', `<button data-node="${n.id}">Research</button>`];
  }

  update(s: ResearchState): void {
    if (!this.open) return;
    let html = `<h3>RESEARCH <button data-close="1" style="float:right">Close [Y]</button></h3>`;
    html += `<div>${s.rate > 0 ? `Stations make ${s.rate.toFixed(0)} RP/s. ` : '<b>No research station: build one (Research station [L]).</b> '}Research cannot be undone. One node runs at a time; its cost is drawn while it runs.</div>`;
    for (const [branch, title] of BRANCHES) {
      html += `<h4>${title.toUpperCase()}</h4>`;
      RESEARCH.forEach((n, i) => {
        if (n.branch !== branch) return;
        const [icon, label, button] = this.status(n, i, s);
        const [m, e, r] = n.cost;
        html += `<div class="node"><span class="st">${icon}</span><span><b>${n.label}</b> — ${n.effect}<br><small>${m} M · ${e} E · ${r} R · ${n.seconds} RP${label ? ` · <b>${label}</b>` : ''}</small></span><span>${button}</span></div>`;
      });
    }
    if (html !== this.key) {
      this.el.innerHTML = html;
      this.key = html;
    }
  }
}

export interface EndState {
  outcome: number;
  endTick: number;
  wave: number;
  waveCount: number;
  kills: number;
  buildingsLost: number;
  unitsLost: number;
  canRewind: boolean;
  rewindWave: number;
}

export class EndScreen {
  readonly el: HTMLDivElement;
  private key = '';

  constructor(private readonly h: { rewind(): void; exportSave(): void; restart(): void }) {
    this.el = document.createElement('div');
    this.el.className = 'pnl end';
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).dataset.end;
      if (a === 'rewind') this.h.rewind();
      if (a === 'export') this.h.exportSave();
      if (a === 'restart') this.h.restart();
    });
    document.body.appendChild(this.el);
  }

  update(s: EndState): void {
    if (s.outcome === 0) {
      this.el.style.display = 'none';
      this.key = '';
      return;
    }
    const won = s.outcome === 2;
    const html =
      `<h2>${won ? '★ MAP WON ★' : '✕ COMMANDER DESTROYED ✕'}</h2>` +
      `<div>${won ? `All ${s.waveCount} waves destroyed.` : `The map is lost (wave ${s.wave} of ${s.waveCount} had arrived).`}</div>` +
      `<div style="margin:8px 0">Time ${fmtTime(s.endTick)} · wave ${s.wave} of ${s.waveCount} · ${s.kills} aliens destroyed · ${s.buildingsLost} buildings and ${s.unitsLost} units lost</div>` +
      (s.canRewind ? `<button data-end="rewind">Rewind to the start of wave ${s.rewindWave}</button>` : '') +
      `<button data-end="export">Export save</button><button data-end="restart">Restart map</button>`;
    if (html !== this.key) {
      this.el.innerHTML = html;
      this.key = html;
    }
    this.el.style.display = 'block';
  }
}

export class Toasts {
  private readonly el: HTMLDivElement;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'toasts';
    document.body.appendChild(this.el);
  }

  show(text: string, bad = false): void {
    const t = document.createElement('div');
    t.className = `toast${bad ? ' bad' : ''}`;
    t.textContent = (bad ? '✕ ' : '') + text;
    this.el.appendChild(t);
    setTimeout(() => t.remove(), bad ? 6000 : 3500);
    while (this.el.children.length > 4) this.el.firstChild!.remove();
  }
}

