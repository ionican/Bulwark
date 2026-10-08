// W25: the selected units' order queues (DOM), above the selection panel. One unit selected: its
// queue, one item per row. Several: each unit's queue, compact, its items on one wrapping line.
// Each item has a remove control (the simulation's dequeue command) and each unit a "Clear" control
// (clearQueue). Text only: a unit's line style is named in words ("long dashes") so it can be
// matched to the queue line on the map without colour.
//
// The rows are rebuilt only when the queues' items change (not when a progress figure changes),
// so a button is never replaced between the press and the release of a click.

const css = `
.queue{left:8px;bottom:44px;max-width:320px;max-height:42vh;overflow:auto;font-size:11px}
.queue .u{margin:2px 0 4px}.queue .u + .u{border-top:1px dashed rgba(244,239,230,.3);padding-top:4px}
.queue .head{display:flex;gap:6px;align-items:center;font-weight:700}
.queue .head .style{font-weight:400;opacity:.8}
.queue .items{margin:2px 0 0;padding:0;list-style:none}
.queue .items li{display:flex;gap:4px;align-items:center}
.queue.compact .items li{display:inline-flex;margin-right:6px}
.queue .n{font-weight:700;min-width:1.6em;text-align:right}
.queue button.rm{padding:0 5px;line-height:1.3}
.queue .empty{opacity:.7}`;

export interface QueuePanelItem {
  /** What the item is, e.g. "Build Gun turret (reserved)". */
  text: string;
  /** Identity for the remove control (the snapshot's kind and the item id; see commands.ts dequeue). */
  kind: number;
  item: number;
}

export interface QueuePanelUnit {
  id: number;
  /** e.g. "Engineer 1". */
  name: string;
  /** The line style on the map, in words. */
  lineStyle: string;
  items: QueuePanelItem[];
}

export interface QueuePanelHandlers {
  remove(unit: number, index: number, expect: { kind: number; target: number }): void;
  clear(unit: number): void;
}

export class QueuePanel {
  readonly el: HTMLDivElement;
  private structure = '';
  private units: QueuePanelUnit[] = [];

  constructor(private readonly handlers: QueuePanelHandlers) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.el = document.createElement('div');
    this.el.className = 'pnl queue';
    this.el.setAttribute('aria-label', 'Order queues');
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      const unit = Number(b.dataset.unit);
      if (b.classList.contains('clear')) this.handlers.clear(unit);
      else if (b.classList.contains('rm')) {
        const index = Number(b.dataset.index);
        this.handlers.remove(unit, index, { kind: Number(b.dataset.kind), target: Number(b.dataset.item) });
      }
    });
  }

  /** `bottom`: CSS px from the viewport bottom (above the selection panel). */
  update(units: QueuePanelUnit[], bottom: number): void {
    this.units = units;
    this.el.style.display = units.length ? '' : 'none';
    this.el.style.bottom = `${bottom}px`;
    if (!units.length) {
      this.structure = '';
      this.el.textContent = '';
      return;
    }
    const structure = JSON.stringify(units.map((u) => [u.id, u.name, u.lineStyle, u.items.map((i) => [i.kind, i.item])]));
    if (structure !== this.structure) {
      this.structure = structure;
      this.rebuild();
    } else {
      // same items: refresh the descriptions in place
      const texts = this.el.querySelectorAll<HTMLElement>('.t');
      let k = 0;
      for (const u of units) for (const i of u.items) if (texts[k]) texts[k++]!.textContent = i.text;
    }
  }

  private rebuild(): void {
    const compact = this.units.length > 1;
    this.el.classList.toggle('compact', compact);
    this.el.textContent = '';
    for (const u of this.units) {
      const box = document.createElement('div');
      box.className = 'u';
      box.dataset.unit = String(u.id);
      const head = document.createElement('div');
      head.className = 'head';
      head.innerHTML = `<span></span><span class="style"></span>`;
      head.children[0]!.textContent = `${u.name}: ${u.items.length ? `${u.items.length} order${u.items.length === 1 ? '' : 's'}` : 'no orders'}`;
      head.children[1]!.textContent = u.items.length ? `(line: ${u.lineStyle})` : '';
      if (u.items.length) head.appendChild(this.button('clear', 'Clear', `Clear ${u.name}'s queue`, u.id));
      box.appendChild(head);
      const list = document.createElement('ol');
      list.className = 'items';
      u.items.forEach((item, index) => {
        const li = document.createElement('li');
        li.className = 'item';
        const n = document.createElement('span');
        n.className = 'n';
        n.textContent = `${index + 1}.`;
        const t = document.createElement('span');
        t.className = 't';
        t.textContent = item.text;
        const rm = this.button('rm', '×', `Remove item ${index + 1} (${item.text}) from ${u.name}'s queue`, u.id);
        rm.dataset.index = String(index);
        rm.dataset.kind = String(item.kind);
        rm.dataset.item = String(item.item);
        li.append(n, t, rm);
        list.appendChild(li);
      });
      box.appendChild(list);
      this.el.appendChild(box);
    }
  }

  private button(cls: string, text: string, label: string, unit: number): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = text;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.dataset.unit = String(unit);
    return b;
  }
}
