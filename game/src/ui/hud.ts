// Debug readout and selection panel. Plain DOM over the canvas; text only, no colour coding.

export interface HudStats {
  fps: number;
  tickMs: number;
  tick: number;
  drawCalls: number;
  triangles: number;
  counts: { buildings: number; aliens: number; units: number };
  lod: { full: number; simple: number; icon: number; culled: number };
  distance: number;
  renderer: string;
  scenario: string;
}

const css = `
.hud{position:fixed;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f4efe6;background:rgba(18,15,13,.82);
border:1px solid rgba(244,239,230,.35);border-radius:4px;padding:6px 9px;pointer-events:none;white-space:pre}
.hud.stats{left:8px;top:8px}.hud.sel{right:8px;top:8px;max-width:360px;white-space:normal}
.hud.help{left:8px;bottom:8px;opacity:.85}
.boxsel{position:fixed;border:1.5px dashed #fff3a0;background:rgba(255,243,160,.08);pointer-events:none;display:none}`;

export class Hud {
  private readonly stats: HTMLDivElement;
  private readonly sel: HTMLDivElement;
  readonly box: HTMLDivElement;

  constructor() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.stats = this.div('hud stats');
    this.sel = this.div('hud sel');
    this.sel.style.display = 'none';
    const help = this.div('hud help');
    help.textContent =
      'Left click / drag: select · Right click: move selected units · Right drag or Q/E: rotate\n' +
      'Wheel: zoom to cursor · Middle drag, WASD/arrows or screen edge: pan · Home: whole map';
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
      `BULWARK greybox · ${s.scenario}\n` +
      `fps ${s.fps.toFixed(0).padStart(4)}   worker tick ${s.tickMs.toFixed(2)} ms   tick ${s.tick}\n` +
      `draw calls ${s.drawCalls}   triangles ${s.triangles}\n` +
      `buildings ${s.counts.buildings}   aliens ${s.counts.aliens}   units ${s.counts.units}\n` +
      `LOD full ${s.lod.full} · simple ${s.lod.simple} · icon ${s.lod.icon} · off-screen ${s.lod.culled}\n` +
      `camera distance ${s.distance.toFixed(0)}\n` +
      `${s.renderer}`;
  }

  showSelection(lines: string[]): void {
    if (!lines.length) {
      this.sel.style.display = 'none';
      return;
    }
    this.sel.style.display = '';
    this.sel.textContent = lines.join(' · ');
  }
}
