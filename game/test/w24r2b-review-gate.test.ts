// W24 run 2b, the post-build adversarial review (2026-10-09), finding 1 of 3.
//
// The performance gate accepted a frozen or undrawn workload. The gate's verdict now lives in
// scripts/benchGate.mjs (judgeSamples): every 1 s sample must come from a running game whose
// snapshot tick advanced since the previous sample, and the scene pass must have submitted at least
// the draw calls and triangles the drawn meshes need (render/inspect.ts submissionFloor). A mesh
// whose materials are all hidden is not drawn (inspect.ts drawnMeshes), so hidden model materials
// leave the workload uncovered. The activity flags count effects committed for drawing this frame,
// not the states that asked for them.

import { describe, expect, it } from 'vitest';
import { Mesh, type Material } from 'three';
import { A, B } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_FIRING, BF_STARTED } from '../src/sim/schema.ts';
import { World } from '../src/sim/world.ts';
import { entitiesOf, inspectScene, submissionFloor } from '../src/render/inspect.ts';
import { judgeSamples } from '../scripts/benchGate.mjs';
import { draw } from './w24r2a-fixtures.ts';
import { drawAt, everyKind, fx, mobile, nextEpoch, renderer, rowIn, snapAt, terrain } from './w24r2b-fixtures.ts';

const ON = BF_COMPLETE | BF_STARTED;
const MODEL_GROUPS = new Set(['building', 'unit', 'alien', 'wreck']);

/** Hides (or shows again) every material of every mesh that draws an entity (not overlays). */
function hideModelMaterials(root: Mesh['parent'], hide: boolean): number {
  let n = 0;
  root!.traverse((o) => {
    if (!(o instanceof Mesh) || !MODEL_GROUPS.has(o.userData.group)) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material]) as Material[]) m.visible = !hide;
    n++;
  });
  return n;
}

describe('finding 1: the gate needs a running, advancing, drawn workload', () => {
  /** A sample that passes every per-second rule (zoomed-out pose: every kind fully drawn). */
  const sample = (s: number, tick: number, over: Record<string, unknown> = {}) => ({
    s,
    d: { beaming: 30, firing: 30, shots: 60, attacking: 60, doorOpening: 5, doorClosing: 5 },
    cov: { gun: [4, 4], rusher: [37, 37], engineer: [12, 12], commander: [1, 1] },
    alive: 160,
    ungrouped: [],
    frame: { tick, paused: false, calls: 600, triangles: 900000, floorCalls: 300, floorTriangles: 400000 },
    ...over,
  });
  const opts = { zoomOut: true, aliens: ['rusher'], turrets: ['gun'], buildingKinds: ['gun'] };
  const frame = (tick: number, f: Record<string, unknown>) => ({ frame: { ...sample(0, tick).frame, ...f } });

  it('a running window with the tick advancing every second passes', () => {
    expect(judgeSamples([1, 2, 3, 4].map((s) => sample(s, 100 + s * 10)), opts)).toEqual([]);
  });

  it('a pause mid-window fails: paused samples, and the tick not advancing', () => {
    const w = [sample(1, 110), sample(2, 120), sample(3, 120, frame(120, { paused: true })), sample(4, 120, frame(120, { paused: true }))];
    const p = judgeSamples(w, opts);
    expect(p.some((x: string) => /second 3: .*paused/.test(x)), p.join(' | ')).toBe(true);
    expect(p.some((x: string) => /second 4: .*not advancing/.test(x)), p.join(' | ')).toBe(true);
  });

  it('a held snapshot fails even when the game reports running (tick unchanged)', () => {
    const p = judgeSamples([sample(1, 110), sample(2, 110)], opts);
    expect(p.some((x: string) => /second 2: .*not advancing \(tick 110 after 110\)/.test(x)), p.join(' | ')).toBe(true);
  });

  it('a scene pass that submitted fewer draw calls or triangles than the drawn meshes need fails', () => {
    const p = judgeSamples([sample(1, 110), sample(2, 120, frame(120, { calls: 12, triangles: 2000 }))], opts);
    expect(p.some((x: string) => /second 2: scene pass submitted 12 draw calls/.test(x)), p.join(' | ')).toBe(true);
    const missing = judgeSamples([sample(1, 110), { ...sample(2, 120), frame: undefined }], opts);
    expect(missing.some((x: string) => /second 2: no frame record/.test(x)), missing.join(' | ')).toBe(true);
  });

  it('hidden model materials: nothing is drawn on any entity, and the submission floor drops', () => {
    const { r, scene } = renderer();
    const f = everyKind();
    draw(r, f.snap);
    const rep = () => inspectScene(scene, entitiesOf(f.snap, mobile(f.snap.aliens), mobile(f.snap.units)));
    const before = rep();
    expect(before.gun!.covered).toBe(before.gun!.entities);
    // hidden: no entity counts as drawn
    expect(hideModelMaterials(scene, true)).toBeGreaterThan(10);
    try {
      const after = rep();
      const drawnOn = Object.entries(after).filter(([, k]) => k.covered > 0).map(([n, k]) => `${n} ${k.covered}/${k.entities}`);
      expect(drawnOn, 'kinds still counted as drawn').toEqual([]);
    } finally {
      hideModelMaterials(scene, false);
    }
    // and the draw calls and triangles the scene pass must submit drop with them
    const floor0 = submissionFloor(scene);
    expect(floor0.calls).toBeGreaterThan(0);
    hideModelMaterials(scene, true);
    try {
      const floor1 = submissionFloor(scene);
      expect(floor1.calls).toBeLessThan(floor0.calls);
      expect(floor1.triangles).toBeLessThan(floor0.triangles);
    } finally {
      hideModelMaterials(scene, false);
    }
  });

  it('the activity flags follow the effects committed this frame: a flash still drawn counts, one not drawn does not', () => {
    const { r, scene } = renderer();
    const w = new World(1, terrain, { waves: false });
    const id = w.placeBuilding(B.gun, 66, 56, true);
    const alien = w.spawnAlien(A.rusher, 76.5, 50.5);
    const at = (tick: number, flags: number) => {
      const s = snapAt(w, tick);
      const row = rowIn(s.buildings, id);
      s.buildings.cols.flags[row] = flags;
      s.buildings.cols.target[row] = alien + 1;
      return s;
    };
    const E = nextEpoch();
    drawAt(r, at(10, ON), { t: 0, dt: 0, world: E });
    let t = 0;
    const frames: Array<[number, boolean]> = [];
    const fire = at(11, ON | BF_FIRING);
    for (let k = 0; k < 8; k++) {
      drawAt(r, fire, { t: (t += 0.016), dt: 0.016, world: E });
      frames.push([fx(scene, 'overlay/fx/flash').length, r.activityNow.flash]);
    }
    expect(frames[0]![0], 'the flash is drawn').toBe(1);
    for (const [n, flag] of frames) expect(flag, `flash instances ${n}`).toBe(n > 0);
    expect(frames.some(([n]) => n === 0), 'the flash expires within 8 frames').toBe(true);
  });
});

