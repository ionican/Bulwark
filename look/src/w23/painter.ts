// W23 wall painter: paint walls on the grid with the mouse, joins updating live.
//
//   left-drag            wall tool: a line along the drag's main axis (Factorio's wall drag);
//                        rectangle tool: a rectangle outline
//   shift + left-drag    a filled block (either wall tool)
//   right-drag           erase the rectangle under the drag (any tool)
//   gate tool            hover shows where the gate would go and whether it fits: a solid outline
//                        and a tick when it does, a dashed outline and a cross (with the reason)
//                        when it does not; click places it
//   damage tool          drag a rectangle to set the chosen damage state on its tiles
// The camera keeps the wheel for zoom and the middle button for orbiting while painting.

import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineDashedMaterial, LineSegments, Plane, Raycaster, Vector2, Vector3, type PerspectiveCamera } from 'three';
import { GATE_WIDTH } from './walls/grid.ts';
import type { World } from './world.ts';
import { ICON, type ScreenMarkers } from './icons.ts';

export type PaintTool = 'line' | 'rect' | 'gate' | 'damage';
export const TOOL_NAMES: Record<PaintTool, string> = { line: 'Wall line', rect: 'Wall rectangle', gate: 'Gate', damage: 'Damage brush' };

interface Drag {
  button: 0 | 2;
  shift: boolean;
  a: [number, number];
  b: [number, number];
}

export class Painter {
  tool: PaintTool = 'line';
  tier = 1;
  damage = 1;
  enabled = false;
  readonly outline: LineSegments;
  /** Faint tile grid over the paintable area. */
  readonly gridLines: LineSegments;
  readonly dashed: LineSegments;
  /** Text shown under the cursor (tool feedback), and its screen position. */
  hint = '';
  hintAt = new Vector2();
  private drag: Drag | null = null;
  private shiftHeld = false;
  private hover: [number, number] | null = null;
  private ray = new Raycaster();
  private plane = new Plane(new Vector3(0, 1, 0), 0);
  private ndc = new Vector2();
  /** Changes made (for the readout and tests). */
  edits = 0;
  lastGate: { ok: boolean; reason: string } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: PerspectiveCamera,
    private world: () => World,
    private onChange: () => void,
  ) {
    const geo = () => {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(new Float32Array(8 * 3 * 4), 3));
      return g;
    };
    this.outline = new LineSegments(geo(), new LineBasicMaterial({ color: 0xf4efe6, depthTest: false, transparent: true, toneMapped: false }));
    this.dashed = new LineSegments(geo(), new LineDashedMaterial({ color: 0xf4efe6, dashSize: 0.35, gapSize: 0.25, depthTest: false, transparent: true, toneMapped: false }));
    {
      const w = world();
      const pts: number[] = [];
      const y = (x: number, z: number) => w.ground(x, z) + 0.03;
      for (let i = 0; i <= w.grid.w; i++) for (let j = 0; j < w.grid.h; j++) pts.push(w.ox + i, y(w.ox + i, w.oz + j), w.oz + j, w.ox + i, y(w.ox + i, w.oz + j + 1), w.oz + j + 1);
      for (let j = 0; j <= w.grid.h; j++) for (let i = 0; i < w.grid.w; i++) pts.push(w.ox + i, y(w.ox + i, w.oz + j), w.oz + j, w.ox + i + 1, y(w.ox + i + 1, w.oz + j), w.oz + j);
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(pts, 3));
      this.gridLines = new LineSegments(g, new LineBasicMaterial({ color: 0xf4efe6, transparent: true, opacity: 0.22, depthWrite: false, toneMapped: false }));
      this.gridLines.visible = false;
    }
    for (const l of [this.outline, this.dashed]) {
      l.renderOrder = 40;
      l.frustumCulled = false;
      l.visible = false;
    }
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    // shift is also tracked from key events, for input that sets it on the keyboard but not on the
    // pointer event
    window.addEventListener('keydown', (e) => e.key === 'Shift' && (this.shiftHeld = true));
    window.addEventListener('keyup', (e) => e.key === 'Shift' && (this.shiftHeld = false));
    window.addEventListener('blur', () => (this.shiftHeld = false));
    canvas.addEventListener('contextmenu', (e) => {
      if (this.enabled) e.preventDefault();
    });
  }

  /** Grid tile under a client point (null off the grid). */
  tileAt(cx: number, cy: number): [number, number] | null {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const w = this.world();
    this.plane.constant = -(w.tileY[0] ?? 0);
    const p = new Vector3();
    if (!this.ray.ray.intersectPlane(this.plane, p)) return null;
    const [x, z] = w.tileAt(p.x, p.z);
    if (!w.grid.inside(x, z)) return null;
    return [x, z];
  }

  private down(e: PointerEvent): void {
    if (!this.enabled || (e.button !== 0 && e.button !== 2)) return;
    const t = this.tileAt(e.clientX, e.clientY);
    if (!t) return;
    e.preventDefault();
    if (this.tool === 'gate' && e.button === 0) {
      const g = this.world().grid.placeGate(t[0], t[1]);
      this.lastGate = g ? { ok: true, reason: '' } : { ok: false, reason: this.world().grid.checkGate(t[0], t[1]).reason };
      if (g) this.changed();
      return;
    }
    this.drag = { button: e.button as 0 | 2, shift: e.shiftKey || this.shiftHeld, a: t, b: t };
  }

  private move(e: PointerEvent): void {
    if (!this.enabled) return;
    const t = this.tileAt(e.clientX, e.clientY);
    this.hintAt.set(e.clientX, e.clientY);
    this.hover = t;
    if (this.drag && t) this.drag.b = t;
  }

  private up(e: PointerEvent): void {
    if (!this.enabled || !this.drag) return;
    const d = this.drag;
    this.drag = null;
    if ((e.button === 0 ? 0 : 2) !== d.button) return;
    this.apply(d);
  }

  /** Applies a drag (also used by the test hook to replay strokes). */
  apply(d: Drag): void {
    const g = this.world().grid;
    const [ax, az] = d.a;
    const [bx, bz] = d.b;
    let n = 0;
    if (d.button === 2) n = g.eraseRect(ax, az, bx, bz);
    else if (this.tool === 'damage') n = g.damageRect(ax, az, bx, bz, this.damage);
    else if (d.shift) n = g.rect(ax, az, bx, bz, this.tier, true);
    else if (this.tool === 'rect') n = g.rect(ax, az, bx, bz, this.tier, false);
    else n = g.line(ax, az, bx, bz, this.tier);
    if (n) this.changed();
  }

  private changed(): void {
    this.edits++;
    this.onChange();
  }

  /** Writes the preview outline(s) and the hint; pushes the gate tick or cross marker. */
  update(markers: ScreenMarkers): void {
    this.outline.visible = false;
    this.dashed.visible = false;
    this.gridLines.visible = this.enabled;
    this.hint = '';
    if (!this.enabled) return;
    const w = this.world();
    const y = (w.tileY[0] ?? 0) + 0.08;
    const rect = (line: LineSegments, x0: number, z0: number, x1: number, z1: number) => {
      const pos = line.geometry.getAttribute('position') as Float32BufferAttribute;
      const X0 = w.ox + Math.min(x0, x1);
      const X1 = w.ox + Math.max(x0, x1) + 1;
      const Z0 = w.oz + Math.min(z0, z1);
      const Z1 = w.oz + Math.max(z0, z1) + 1;
      const c: Array<[number, number]> = [[X0, Z0], [X1, Z0], [X1, Z1], [X0, Z1]];
      for (let k = 0; k < 4; k++) {
        const [px, pz] = c[k]!;
        const [qx, qz] = c[(k + 1) % 4]!;
        pos.setXYZ(k * 2, px, y, pz);
        pos.setXYZ(k * 2 + 1, qx, y, qz);
      }
      for (let k = 8; k < pos.count; k++) pos.setXYZ(k, c[0]![0], y, c[0]![1]);
      pos.needsUpdate = true;
      line.geometry.computeBoundingSphere();
      if ((line as LineSegments).material instanceof LineDashedMaterial) line.computeLineDistances();
      line.visible = true;
    };
    if (this.drag) {
      const d = this.drag;
      const [ax, az] = d.a;
      let [bx, bz] = d.b;
      const wide = Math.abs(bx - ax) + 1;
      const deep = Math.abs(bz - az) + 1;
      if (d.button === 0 && this.tool === 'line' && !d.shift) {
        // the line follows the drag's main axis
        if (Math.abs(bx - ax) >= Math.abs(bz - az)) bz = az;
        else bx = ax;
        this.hint = `line ${Math.max(Math.abs(bx - ax), Math.abs(bz - az)) + 1} tiles · tier ${this.tier}`;
        rect(this.outline, ax, az, bx, bz);
      } else if (d.button === 2) {
        this.hint = `erase ${wide} × ${deep}`;
        rect(this.dashed, ax, az, bx, bz);
      } else if (this.tool === 'damage') {
        this.hint = `damage state ${this.damage} on ${wide} × ${deep}`;
        rect(this.dashed, ax, az, bx, bz);
      } else {
        this.hint = `${d.shift ? 'block' : 'rectangle'} ${wide} × ${deep} · tier ${this.tier}`;
        rect(this.outline, ax, az, bx, bz);
      }
      return;
    }
    if (this.tool === 'gate' && this.hover) {
      const [hx, hz] = this.hover;
      const c = w.grid.checkGate(hx, hz);
      const half = (GATE_WIDTH - 1) / 2;
      // footprint: the checked block when it fits, else the 3 × 1 run at the cursor
      const ax = c.axis === 'x';
      const lo = c.ok ? c.lo : 0;
      const hi = c.ok ? c.hi : 0;
      const x0 = ax ? hx - half : hx + lo;
      const x1 = ax ? hx + half : hx + hi;
      const z0 = ax ? hz + lo : hz - half;
      const z1 = ax ? hz + hi : hz + half;
      rect(c.ok ? this.outline : this.dashed, x0, z0, x1, z1);
      const mx = w.ox + (x0 + x1) / 2 + 0.5;
      const mz = w.oz + (z0 + z1) / 2 + 0.5;
      markers.push(mx, y + 2.2, mz, c.ok ? ICON.gateOk : ICON.gateNo, 30);
      this.hint = c.ok ? `gate fits: ${GATE_WIDTH} wide × ${hi - lo + 1} deep` : `no gate: ${c.reason}`;
    }
  }
}
