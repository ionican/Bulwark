// W26: the idle units column (as SupCom), on the right edge below the debug spawn panel. One button
// per unit type that has idle units, commander first, then engineers; each shows the type's W23
// strategic-zoom icon (star / circle with a bar) and the idle count. A type with none is hidden.
// Shape and number carry the meaning, never colour alone. Click: the next idle unit of the type
// (the caller cycles in id order and centres the camera); Shift + click: every idle unit of the
// type. Pointer events on the column never reach the map. The idle set comes from render/idle.ts.

import type { IdleUnits } from '../render/idle.ts';
import { ICON_HALF } from '../render/workshop/kit/icons.ts';
import { drawW23Icon } from '../render/workshop/w23/icons.ts';

export type IdleType = 'commander' | 'engineer';
export const IDLE_TYPES: readonly IdleType[] = ['commander', 'engineer'];

const css = `
.idle{position:fixed;right:8px;display:flex;flex-direction:column;gap:4px;z-index:6;font:600 13px system-ui,sans-serif}
.idle button{display:flex;align-items:center;gap:6px;color:#f4efe6;background:rgba(18,15,13,.88);border:1px solid rgba(244,239,230,.45);
border-radius:4px;padding:3px 8px 3px 4px;cursor:pointer}
.idle button:hover{border-color:#f4efe6}
.idle canvas{width:30px;height:30px}
.idle .n{min-width:2.2em;text-align:left}`;

const LABEL: Record<IdleType, string> = { commander: 'Idle commander', engineer: 'Idle engineers' };

export interface IdleColumnHandlers {
  /** A button was clicked: `all` with Shift held. */
  pick(type: IdleType, all: boolean): void;
}

export class IdleColumn {
  readonly el = document.createElement('div');
  private readonly buttons = new Map<IdleType, { b: HTMLButtonElement; n: HTMLSpanElement }>();
  private shown = '';

  constructor(h: IdleColumnHandlers) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.el.className = 'idle';
    for (const ev of ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu'] as const)
      this.el.addEventListener(ev, (e) => e.stopPropagation());
    for (const type of IDLE_TYPES) {
      const b = document.createElement('button');
      b.dataset.idle = type;
      b.title = `${LABEL[type]}: click selects the next one and centres on it; Shift + click selects them all`;
      b.setAttribute('aria-label', LABEL[type]);
      b.appendChild(iconCanvas(type));
      const n = document.createElement('span');
      n.className = 'n';
      b.appendChild(n);
      b.style.display = 'none';
      b.addEventListener('click', (e) => h.pick(type, e.shiftKey));
      this.el.appendChild(b);
      this.buttons.set(type, { b, n });
    }
    document.body.appendChild(this.el);
    this.place();
  }

  /** Shows the counts of `idle`; a type with none is hidden. */
  update(idle: IdleUnits): void {
    const key = `${idle.commander.length},${idle.engineer.length}`;
    if (key === this.shown) return;
    this.shown = key;
    for (const type of IDLE_TYPES) {
      const { b, n } = this.buttons.get(type)!;
      const count = idle[type].length;
      b.style.display = count > 0 ? '' : 'none';
      n.textContent = `× ${count}`;
      b.dataset.count = String(count);
    }
    this.place();
  }

  /** Below the debug spawn panel (ui/buildbar.ts `.dbg`), or where it would be. */
  private place(): void {
    const dbg = document.querySelector('.dbg');
    const top = dbg ? dbg.getBoundingClientRect().bottom + 8 : 118;
    this.el.style.top = `${Math.round(top)}px`;
  }
}

/** The type's W23 strategic-zoom icon, as at strategic zoom (render/icons.ts draws the same shapes). */
function iconCanvas(type: IdleType): HTMLCanvasElement {
  const px = 60;
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  if (typeof OffscreenCanvas === 'undefined') return cv;
  const off = new OffscreenCanvas(px, px);
  const c = off.getContext('2d')!;
  const s = px / (2 * ICON_HALF);
  c.setTransform(s, 0, 0, s, px / 2, px / 2);
  drawW23Icon(c, type);
  cv.getContext('2d')?.drawImage(off, 0, 0);
  return cv;
}
