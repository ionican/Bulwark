// W24 run 3: the Spawn tab's "Show routes" toggle (default off; Richard asked for no routes in 2a).
// When on, each route in the snapshot's originRoutes (the predicted path from each recent sandbox
// spawn origin, tile cells z × width + x) is drawn as a dashed line just above the ground, with the
// alien kind's icon shape at its origin. Rebuilt only when a route changes (any cell: Codex review 3), checked once per snapshot.

import { BufferGeometry, Float32BufferAttribute, Group, Line, LineDashedMaterial, Mesh, MeshBasicMaterial, type Scene } from 'three';
import type { Snapshot } from '../sim/snapshot.ts';
import type { Terrain } from '../sim/terrain.ts';
import { alienIconGeometries } from './geometry.ts';
import { groundHeight } from './ground.ts';

export class RouteView {
  readonly group = new Group();
  private readonly line = new LineDashedMaterial({ color: '#f4efe6', dashSize: 0.6, gapSize: 0.45, depthTest: false, transparent: true, opacity: 0.9 });
  private readonly iconMat = new MeshBasicMaterial({ vertexColors: true, depthTest: false });
  /** Built on the first update with the routes on (most games never show them). */
  private icons: ReturnType<typeof alienIconGeometries> | null = null;
  /** The routes last drawn (copies): compared in full, every cell, with each new snapshot's. */
  private drawn: Array<{ x: number; z: number; kind: number; category: number; cells: Uint16Array }> = [];
  /** The snapshot the key was last made from: the routes change only with the snapshot. */
  private snap: Snapshot | null = null;

  constructor(
    scene: Scene,
    private readonly terrain: Terrain,
  ) {
    this.group.name = 'overlay/routes';
    this.group.visible = false;
    this.group.renderOrder = 14;
    scene.add(this.group);
  }

  update(s: Snapshot | null, on: boolean): void {
    this.group.visible = on && !!s;
    if (!on || !s || s === this.snap) return;
    this.snap = s;
    const routes = s.originRoutes;
    if (sameRoutes(routes, this.drawn)) return;
    this.drawn = routes.map((r) => ({ x: r.x, z: r.z, kind: r.kind, category: r.category, cells: r.cells.slice() }));
    for (const c of [...this.group.children]) {
      c.removeFromParent();
      if (c instanceof Line) c.geometry.dispose();
    }
    const t = this.terrain;
    for (const r of routes) {
      const pts: number[] = [];
      for (const cell of r.cells) {
        const x = (cell % t.w) + 0.5;
        const z = Math.floor(cell / t.w) + 0.5;
        pts.push(x, groundHeight(t, x, z) + 0.15, z);
      }
      if (pts.length >= 6) {
        const g = new BufferGeometry();
        g.setAttribute('position', new Float32BufferAttribute(pts, 3));
        const line = new Line(g, this.line);
        line.computeLineDistances();
        line.renderOrder = 14;
        line.name = 'overlay/route';
        this.group.add(line);
      }
      this.icons ??= alienIconGeometries();
      const icon = this.icons[r.kind];
      if (icon) {
        const m = new Mesh(icon, this.iconMat);
        const x = r.x + 0.5;
        const z = r.z + 0.5;
        m.position.set(x, groundHeight(t, x, z) + 0.3, z);
        m.scale.setScalar(1.4);
        m.renderOrder = 15;
        m.name = 'overlay/route-origin';
        this.group.add(m);
      }
    }
  }
}

/** True when `a` and `b` are the same routes: origin, kind, category and every cell, in order. */
function sameRoutes(a: Snapshot['originRoutes'], b: Snapshot['originRoutes']): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (p.x !== q.x || p.z !== q.z || p.kind !== q.kind || p.category !== q.category || p.cells.length !== q.cells.length) return false;
    for (let k = 0; k < p.cells.length; k++) if (p.cells[k] !== q.cells[k]) return false;
  }
  return true;
}
