// Bench controls panel (right) and readout (left). Every control is a button with its key in
// brackets; toggles show their state as text and a leading dot, never by colour alone.

import '../ui/style.css';
import './bench.css';

export interface Control {
  id: string;
  label: string;
  key?: string;
  /** Toggle buttons report their state; plain buttons leave it undefined. */
  state?: () => boolean;
  run: () => void;
}

export class BenchUi {
  readonly panel = document.createElement('div');
  readonly readout = document.createElement('div');
  private buttons: Array<{ el: HTMLButtonElement; c: Control }> = [];

  constructor(groups: Array<{ title: string; controls: Control[] }>) {
    this.panel.id = 'bench-panel';
    this.panel.className = 'panel';
    for (const g of groups) {
      const h = document.createElement('div');
      h.className = 'grp';
      h.textContent = g.title;
      this.panel.append(h);
      const row = document.createElement('div');
      row.className = 'btns';
      for (const c of g.controls) {
        const b = document.createElement('button');
        b.className = 'tg';
        b.dataset.id = c.id;
        b.innerHTML = c.key ? `${c.label} <kbd>${c.key}</kbd>` : c.label;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          c.run();
          this.refresh();
        });
        row.append(b);
        this.buttons.push({ el: b, c });
      }
      this.panel.append(row);
    }
    this.readout.id = 'bench-readout';
    this.readout.className = 'panel';
    document.body.append(this.panel, this.readout);
    this.refresh();
  }

  refresh(): void {
    for (const { el, c } of this.buttons) if (c.state) el.setAttribute('aria-pressed', String(c.state()));
  }

  setReadout(rows: Array<[string, string]>, foot: string): void {
    this.readout.innerHTML = rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${v}</span></div>`).join('') + `<div class="foot">${foot}</div>`;
  }
}
