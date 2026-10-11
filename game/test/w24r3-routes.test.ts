// Codex review 3 (W24 run 3): the Spawn tab's "Show routes" lines are rebuilt whenever a route
// changes, including a reroute of the same length to the same end tile (a wall added part way
// along). Codex's probe: rusher origin (4.5, 5.5), a wall at (12, 13), then a wall at (5, 6).
// Routes are still checked only when a new snapshot arrives.

import { describe, expect, it } from 'vitest';
import { Line, Scene } from 'three';
import { A } from '../src/sim/kinds.ts';
import type { Snapshot } from '../src/sim/snapshot.ts';
import { flatTerrain } from '../src/sim/terrain.ts';
import { RouteView } from '../src/render/routeView.ts';

const W = 20;
const cell = (x: number, z: number) => z * W + x;
/** A snapshot carrying only the routes RouteView reads. */
const snap = (cells: number[]) => ({ originRoutes: [{ x: 4, z: 5, kind: A.rusher, category: 0, cells: Uint16Array.from(cells) }] }) as unknown as Snapshot;
const linePoints = (v: RouteView) => {
  const out: number[][] = [];
  v.group.traverse((o) => {
    if (o instanceof Line) out.push(Array.from(o.geometry.getAttribute('position').array as Float32Array));
  });
  return out;
};

describe('Codex review 3: an equal-length reroute redraws the route', () => {
  it('same length, same end tile, a different middle: the line follows the new cells', () => {
    const v = new RouteView(new Scene(), flatTerrain(W, W));
    const before = [cell(4, 5), cell(5, 5), cell(5, 6), cell(6, 6), cell(6, 7)];
    const after = [cell(4, 5), cell(4, 6), cell(5, 6), cell(5, 7), cell(6, 7)];
    v.update(snap(before), true);
    const a = linePoints(v);
    expect(a.length).toBe(1);
    v.update(snap(after), true);
    const b = linePoints(v);
    expect(b.length).toBe(1);
    expect(b[0], 'the line was rebuilt from the new cells').not.toEqual(a[0]);
    // x of the second point: cell (4, 6) → 4.5
    expect(b[0]![3]).toBe(4.5);
  });

  it('the same snapshot again keeps the same line object (checked once per snapshot)', () => {
    const v = new RouteView(new Scene(), flatTerrain(W, W));
    const s = snap([cell(4, 5), cell(5, 5), cell(6, 5)]);
    v.update(s, true);
    const first = v.group.children.find((o) => o instanceof Line);
    v.update(s, true);
    expect(v.group.children.find((o) => o instanceof Line)).toBe(first);
    // an equal route in a new snapshot is not rebuilt either
    v.update(snap([cell(4, 5), cell(5, 5), cell(6, 5)]), true);
    expect(v.group.children.find((o) => o instanceof Line)).toBe(first);
  });
});
