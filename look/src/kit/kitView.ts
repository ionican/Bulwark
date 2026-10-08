// Kit view: the 40 kinds lined up in an 8 × 5 grid at close range, each named, drawn through the
// current strategy at full detail; and the parts view: every shared part on its own, laid out in
// rows (bases, rings, heads, weapons with mount and gun pulled apart), labelled with its name,
// triangles at full / middle / simple detail and how many kinds use it. Labels are HTML, placed by
// projecting a point under each object every frame.

import { Group, Mesh, Vector3, type Camera, type Material } from 'three';
import { BASES, HEADS, RINGS, WEAPONS } from './parts.ts';
import type { Kit, KitPart, MatKey } from './kit.ts';

export const KIT_COLS = 8;
export const KIT_SPACING = 3.3;
const ROW_SPACING = 4.4;

export interface KitSlot {
  kind: number;
  x: number;
  z: number;
}

/** Grid of the 40 kinds round (cx, cz): rows along x, front row (+z) first in kind order. */
export function kitGrid(kinds: number, cx: number, cz: number): KitSlot[] {
  const rows = Math.ceil(kinds / KIT_COLS);
  return Array.from({ length: kinds }, (_, i) => {
    const c = i % KIT_COLS;
    const r = Math.floor(i / KIT_COLS);
    return { kind: i, x: cx + (c - (KIT_COLS - 1) / 2) * KIT_SPACING, z: cz + (r - (rows - 1) / 2) * ROW_SPACING };
  });
}

interface Label {
  el: HTMLDivElement;
  at: Vector3;
}

export class KitView {
  readonly labels = document.createElement('div');
  readonly parts = new Group();
  private kindLabels: Label[] = [];
  private partLabels: Label[] = [];
  private builtParts = false;
  private v = new Vector3();

  constructor(
    private kit: Kit,
    private mats: Record<MatKey, Material>,
  ) {
    this.labels.id = 'kit-labels';
    document.body.append(this.labels);
    this.parts.name = 'kit-parts';
    this.parts.visible = false;
  }

  private label(text: string, cls: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = `kl ${cls}`;
    el.innerHTML = text;
    el.style.display = 'none';
    this.labels.append(el);
    return el;
  }

  /** Name labels under the kit grid's turrets. */
  setKindLabels(slots: Array<KitSlot & { y: number }>): void {
    for (const l of this.kindLabels) l.el.remove();
    this.kindLabels = slots.map((s) => {
      const k = this.kit.kinds[s.kind]!;
      return { el: this.label(`<b>${k.index + 1}. ${k.name}</b>`, 'kind'), at: new Vector3(s.x, s.y - 0.05, s.z + 1.2) };
    });
  }

  /** Builds the parts layout (once) round (cx, cz) on ground height `h`. */
  buildParts(cx: number, cz: number, h: (x: number, z: number) => number): void {
    if (this.builtParts) return;
    this.builtParts = true;
    const rows: Array<{ z: number; items: Array<{ parts: KitPart[]; y: number[]; dx?: number[]; title: string }> }> = [];
    const find = (id: string) => this.kit.parts.find((p) => p.id === id)!;
    rows.push({
      z: -7.4,
      items: [
        ...BASES.map((b) => ({ parts: [find(`base/${b.id}`)], y: [0], title: b.name })),
        { parts: [find('pinion/w20')], y: [-0.4], title: 'Pinion (W20, with the octagonal base)' },
      ],
    });
    rows.push({ z: -3.0, items: RINGS.map((r) => ({ parts: [find(`ring/${r.id}`)], y: [-r.anchor], title: r.name })) });
    rows.push({ z: 0.9, items: HEADS.map((hd) => ({ parts: [find(`head/${hd.id}`)], y: [-hd.anchor], title: hd.name })) });
    rows.push({
      z: 4.8,
      items: WEAPONS.map((w) => {
        const gun = this.kit.parts.find((p) => p.id === `gun/${w.id}`);
        return { parts: gun ? [find(`mount/${w.id}`), gun] : [find(`mount/${w.id}`)], y: gun ? [0.45, 1.25] : [0.45], dx: gun ? [-0.25, 0.25] : [0], title: w.name };
      }),
    });
    for (const row of rows) {
      const n = row.items.length;
      row.items.forEach((it, i) => {
        const x = cx + (i - (n - 1) / 2) * 3.15;
        const z = cz + row.z;
        const g = h(x, z);
        it.parts.forEach((p, j) => {
          for (const [key, geo] of p.levels[0]) {
            const m = new Mesh(geo, this.mats[key]);
            m.position.set(x + (it.dx?.[j] ?? 0), g + it.y[j]!, z);
            // three-quarter view: turn the part 40° towards the camera's right
            m.rotation.y = -0.7;
            m.castShadow = key !== 'glow' && key !== 'dark';
            m.receiveShadow = true;
            this.parts.add(m);
          }
        });
        const tri = it.parts.map((p) => p.triangles[0].toLocaleString('en-GB')).join(' + ');
        const used = it.parts[0]!.usedBy.length;
        const el = this.label(`<b>${it.title}</b><br>${used} kind${used === 1 ? '' : 's'} · ${tri} tris${it.parts.length > 1 ? '<br>mount low, gun high' : ''}`, 'part');
        this.partLabels.push({ el, at: new Vector3(x, g - 0.05, z + 1.25) });
      });
    }
  }

  show(mode: 'off' | 'kit' | 'parts'): void {
    this.parts.visible = mode === 'parts';
    for (const l of this.kindLabels) l.el.style.display = mode === 'kit' ? 'block' : 'none';
    for (const l of this.partLabels) l.el.style.display = mode === 'parts' ? 'block' : 'none';
  }

  update(camera: Camera, canvas: HTMLCanvasElement, mode: 'off' | 'kit' | 'parts'): void {
    if (mode === 'off') return;
    const r = canvas.getBoundingClientRect();
    for (const l of mode === 'kit' ? this.kindLabels : this.partLabels) {
      const p = this.v.copy(l.at).project(camera);
      const vis = p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
      l.el.style.display = vis ? 'block' : 'none';
      l.el.style.left = `${r.left + ((p.x + 1) / 2) * r.width}px`;
      l.el.style.top = `${r.top + ((1 - p.y) / 2) * r.height}px`;
    }
  }
}
