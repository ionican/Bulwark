// W28: the construction hover panel. A small light-on-dark box beside the cursor with the lines of
// render/siteReadout.ts (kind, percent or "reserved — not started", intake per resource, builders).
// Text and numbers only, never colour. It never takes pointer events, so clicks and drags pass to
// the map underneath; main.ts shows it over a building site and hides it everywhere else.

const css = `
.site-hover{position:fixed;z-index:7;pointer-events:none;color:#f4efe6;background:rgba(18,15,13,.9);
border:1px solid rgba(244,239,230,.55);border-radius:4px;padding:4px 8px;font:600 12px/1.35 ui-monospace,Menlo,monospace;
white-space:pre;display:none}
.site-hover .t{font-weight:700}`;

/** Offset of the panel's corner from the cursor (CSS px). */
const OFFSET = 16;

export class SiteHover {
  readonly el = document.createElement('div');
  /** The building whose readout is shown, or -1 when hidden. */
  id = -1;
  lines: string[] = [];

  constructor() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.el.className = 'site-hover';
    this.el.setAttribute('role', 'status');
    document.body.appendChild(this.el);
  }

  /** Shows `lines` for building `id` beside the cursor (x, y), kept inside the window. */
  show(id: number, lines: string[], x: number, y: number): void {
    if (this.id !== id || this.lines.join('\n') !== lines.join('\n')) {
      this.el.replaceChildren();
      lines.forEach((text, i) => {
        const d = document.createElement('div');
        if (i === 0) d.className = 't';
        d.textContent = text;
        this.el.appendChild(d);
      });
      this.lines = lines;
    }
    this.id = id;
    this.el.style.display = 'block';
    this.move(x, y);
  }

  /** Follows the cursor; flips to the left of or above it near the window's edges. */
  move(x: number, y: number): void {
    if (this.id < 0) return;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const left = x + OFFSET + w > window.innerWidth ? x - OFFSET - w : x + OFFSET;
    const top = y + OFFSET + h > window.innerHeight ? y - OFFSET - h : y + OFFSET;
    this.el.style.left = `${Math.max(0, left)}px`;
    this.el.style.top = `${Math.max(0, top)}px`;
  }

  hide(): void {
    if (this.id < 0) return;
    this.id = -1;
    this.lines = [];
    this.el.style.display = 'none';
  }
}
