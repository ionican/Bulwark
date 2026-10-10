// Debug readout and selection panel. Plain DOM over the canvas; text only, no colour coding.

import { versionLabel } from '../version.ts';

export interface HudStats {
  fps: number;
  tickMs: number;
  tick: number;
  drawCalls: number;
  triangles: number;
  counts: { buildings: number; aliens: number; units: number };
  /** Objects per detail level: W13's full / simple / icon, or the model view's full / middle / simple / icon. */
  lod: { full: number; middle?: number; simple: number; icon: number; culled: number };
  distance: number;
  renderer: string;
  scenario: string;
  /** The view and its quality, e.g. "models · medium". */
  view: string;
}

const css = `
.hud{position:fixed;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f4efe6;background:rgba(18,15,13,.82);
border:1px solid rgba(244,239,230,.35);border-radius:4px;padding:6px 9px;pointer-events:none;white-space:pre}
.hud.stats{left:8px;top:8px}.hud.sel{left:8px;bottom:8px;max-width:340px;white-space:normal}
.hud.help{left:50%;top:50%;transform:translate(-50%,-50%);font-size:12px;display:none;z-index:8}
.hud.res{right:8px;top:8px;white-space:pre;font-size:11px}
.hud.ver{right:8px;bottom:8px;font-size:11px;padding:3px 7px}
.boxsel{position:fixed;border:1.5px dashed #fff3a0;background:rgba(255,243,160,.08);pointer-events:none;display:none}`;

export class Hud {
  private readonly stats: HTMLDivElement;
  private readonly sel: HTMLDivElement;
  private readonly res: HTMLDivElement;
  private help!: HTMLDivElement;

  toggleHelp(): void {
    this.help.style.display = this.help.style.display === 'block' ? 'none' : 'block';
  }
  readonly box: HTMLDivElement;

  constructor() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.stats = this.div('hud stats');
    this.sel = this.div('hud sel');
    this.sel.style.display = 'none';
    this.res = this.div('hud res');
    const help = this.div('hud help');
    this.help = help;
    help.textContent =
      `Bulwark ${versionLabel()}\n` +
      'Left click: select · Shift + left drag: box select · Right click: move, assist a site, reclaim a wreck · Shift: queue\n' +
      'Build: pick from the bar, click to place, drag to lay a wall run, a belt line or a row of buildings, R rotates belts, Esc/right click cancels\n' +
      'Queue: Shift adds an order to the selected units’ queues, no Shift replaces them; Shift held keeps the build tool, releasing it closes it\n' +
      'Camera: left drag orbits (turn and tilt) · right drag, WASD/arrows, screen edge: pan · wheel: zoom to cursor · middle drag: dolly · Q/E: turn · Home: whole map\n' +
      'Space: pause (orders still work) · Shift+1/2/3: speed · C: call next wave early · Y: research';
    // the build stamp, always shown, so a player can say which build they are playing (version.ts)
    this.div('hud ver').textContent = `Bulwark ${versionLabel()}`;
    this.box = this.div('boxsel');
  }

  private div(cls: string): HTMLDivElement {
    const d = document.createElement('div');
    d.className = cls;
    document.body.appendChild(d);
    return d;
  }

  update(s: HudStats): void {
    this.stats.textContent =
      `BULWARK ${s.view} · ${s.scenario} · H: help\n` +
      `fps ${s.fps.toFixed(0).padStart(4)}   worker tick ${s.tickMs.toFixed(2)} ms   tick ${s.tick}\n` +
      `draw calls ${s.drawCalls}   triangles ${s.triangles}\n` +
      `buildings ${s.counts.buildings}   aliens ${s.counts.aliens}   units ${s.counts.units}\n` +
      `LOD full ${s.lod.full}${s.lod.middle !== undefined ? ` · middle ${s.lod.middle}` : ''} · simple ${s.lod.simple} · icon ${s.lod.icon} · off-screen ${s.lod.culled}\n` +
      `camera distance ${s.distance.toFixed(0)}\n` +
      `${s.renderer.length > 56 ? `${s.renderer.slice(0, 55)}…` : s.renderer}`;
  }

  /** Resource pool, rates and shortages; text only ("SHORT" is a word, not a colour). */
  updateEconomy(e: EconomyReadout): void {
    this.res.textContent = economyText(e);
  }

  showSelection(lines: string[]): void {
    if (!lines.length) {
      this.sel.style.display = 'none';
      return;
    }
    this.sel.style.display = '';
    this.sel.textContent = lines.join(' · ');
  }

  /** CSS px from the viewport bottom to just above the selection panel (W25: the queue panel sits there). */
  aboveSelection(): number {
    return this.sel.style.display === 'none' ? 8 : 8 + this.sel.offsetHeight + 6;
  }
}

export interface EconomyReadout {
  pool: number[];
  income: number[];
  spend: number[];
  short: boolean[];
  /** W25b: sites waiting for each resource (render/waiting.ts); absent or 0: none. */
  waiting?: number[];
  parts: number;
  commanderHp: number;
  commanderMax: number;
  aliens: number;
  kills: number;
  upkeep: number;
  lost: boolean;
  won: boolean;
}

/**
 * The resource readout's text. A short resource is marked "▲SHORT" (a shape and a word, never
 * colour) and, W25b, with how many sites are waiting for it: "▲SHORT · 3 sites waiting".
 */
export function economyText(e: EconomyReadout): string {
  const names = ['MASS  ', 'ENERGY', 'RARE  '];
  const waitNote = (k: number) => {
    const n = e.waiting?.[k] ?? 0;
    return n > 0 ? ` · ${n} site${n === 1 ? '' : 's'} waiting` : '';
  };
  const row = (k: number) =>
    `${names[k]} ${e.pool[k]!.toFixed(k === 2 ? 1 : 0).padStart(7)} +${e.income[k]!.toFixed(1).padStart(5)}/s -${e.spend[k]!.toFixed(1).padStart(5)}/s${e.short[k] ? ` ▲SHORT${waitNote(k)}` : ''}`;
  return (
    `${row(0)}\n${row(1)}\n${row(2)}\n` +
    `PARTS ${e.parts.toFixed(0)}   COMMANDER ${Math.max(0, e.commanderHp).toFixed(0)}/${e.commanderMax}\n` +
    `ALIENS ${e.aliens}   KILLS ${e.kills}` +
    (e.upkeep < 0.999 ? `   ENERGY UPKEEP ${(e.upkeep * 100).toFixed(0)}%` : '') +
    (e.lost ? '\n*** COMMANDER DESTROYED — MAP LOST ***' : '') +
    (e.won ? '\n*** ALL WAVES DESTROYED — MAP WON ***' : '')
  );
}
