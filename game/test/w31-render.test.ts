// W31 (PLAN-W31 test 14): the belt render clock. One capped game-time delta per frame,
// g = min(raw seconds × speed, 0.04) game-seconds, advances each speed's phase by g × its tiles a
// second (Slow 10/6, Medium 2.5, Fast 10/3), so the phases keep 0.5 : 0.75 : 1 under the cap and
// every speed's step stays under half its chevron period (1, 2 and 3 chevrons a tile). Paused: 0; a
// reset or a rewind: no jump. Each speed's surface material carries its own texture, scrolled by its
// own phase; a belt draws the surface of its own speed, the merger Fast's. The browser half (the
// chevron counts on the drawn textures, the pixels) is scripts/check-belt-speeds.mjs.

import { describe, expect, it } from 'vitest';
import { InstancedMesh, Vector3, type MeshStandardMaterial, type Scene } from 'three';
import { B, U } from '../src/sim/kinds.ts';
import { BeltFlow, EffectClock, type BeltFrame } from '../src/render/anim.ts';
import { CAPACITY, World } from '../src/sim/world.ts';
import { camera, mobile, renderer, snapshotOf, terrain } from './w24r2a-fixtures.ts';
import { setTier } from './w31-fixtures.ts';

const run = (seconds: number, speed = 1): BeltFrame => ({ seconds, speed, paused: false, world: 0 });
/** Tiles a second per tier. */
const TPS = [0, 10 / 6, 2.5, 10 / 3];
/** Chevron period per tier (tiles): one, two and three chevrons a tile. */
const PERIOD = [0, 1, 0.5, 1 / 3];
type Flow = BeltFlow & { phases: number[]; steps: number[]; g: number };
/** A belt clock, with its per-speed phases asserted present. */
function newFlow(): Flow {
  const f = new BeltFlow() as Flow;
  expect(Array.isArray(f.phases) && Array.isArray(f.steps), 'per-speed phases and steps').toBe(true);
  return f;
}

describe('W31 belt phases (test 14)', () => {
  it('0.1 s frames at 1×: the shared delta is capped at 0.04 game-s, so the phases advance 0.0667 / 0.1 / 0.1333 (0.5 : 0.75 : 1)', () => {
    const f = newFlow();
    f.advance(run(0), 0);
    for (let k = 0; k < 5; k++) {
      const before = [...f.phases];
      f.advance(run(0.1), 0);
      expect(f.g).toBeCloseTo(0.04, 12);
      for (const t of [1, 2, 3]) expect(f.phases[t]! - before[t]!, `tier ${t}, frame ${k}`).toBeCloseTo(0.04 * TPS[t]!, 9);
      expect(f.steps.slice(1).map((s) => s / f.steps[3]!)).toEqual([expect.closeTo(0.5, 9), expect.closeTo(0.75, 9), 1]);
    }
    expect(f.steps[1]).toBeCloseTo(0.0667, 4);
    expect(f.steps[2]).toBeCloseTo(0.1, 9);
    expect(f.steps[3]).toBeCloseTo(0.1333, 4);
  });

  it('0.02 s frames at 1× (under the cap): 0.0333 / 0.05 / 0.0667', () => {
    const f = newFlow();
    f.advance(run(0), 0);
    f.advance(run(0.02), 0);
    expect(f.g).toBeCloseTo(0.02, 12);
    expect(f.steps[1]).toBeCloseTo(0.02 * TPS[1]!, 9);
    expect(f.steps[2]).toBeCloseTo(0.05, 9);
    expect(f.steps[3]).toBeCloseTo(0.02 * TPS[3]!, 9);
  });

  it('paused: 0; a rewind (the tick goes back) or a reset (a new world epoch): no jump, then running again', () => {
    const f = newFlow();
    f.advance(run(0), 50);
    f.advance(run(0.02), 50);
    const p = [...f.phases];
    f.advance({ seconds: 0.1, speed: 1, paused: true, world: 0 }, 51);
    expect(f.phases).toEqual(p);
    expect(f.steps.slice(1)).toEqual([0, 0, 0]);
    f.advance(run(0.1), 10);
    expect(f.phases, 'the rewind frame').toEqual(p);
    f.advance(run(0.02), 10);
    expect(f.steps[3]).toBeCloseTo(0.02 * TPS[3]!, 9);
    const q = [...f.phases];
    f.advance({ seconds: 0.1, speed: 1, paused: false, world: 1 }, 10);
    expect(f.phases, 'the reset frame').toEqual(q);
  });

  it('20 and 30 fps at 10×: every speed steps above 0 and below half its chevron period', () => {
    for (const fps of [20, 30]) {
      const f = newFlow();
      f.advance(run(0), 0);
      for (let k = 0; k < 6; k++) {
        f.advance(run(1 / fps, 10), 0);
        for (const t of [1, 2, 3]) {
          expect(f.steps[t], `${fps} fps, tier ${t}`).toBeGreaterThan(0);
          expect(f.steps[t]!, `${fps} fps, tier ${t}`).toBeLessThan(PERIOD[t]! / 2);
        }
      }
    }
  });
});

describe('W31 per-speed surfaces through the renderer (test 14)', () => {
  /** Belts at (40, 66), (42, 66), (44, 66) at tiers 1, 2, 3 and a merger at (46, 66), complete. */
  function fixture() {
    const w = new World(1, terrain, { waves: false, belts: true });
    const ids: number[] = [];
    [1, 2, 3].forEach((t, k) => {
      const id = w.placeBuilding(B.belt, 40 + 2 * k, 66, true, 0);
      setTier(w, id, t);
      ids.push(id);
    });
    w.placeBuilding(B.merger, 46, 66, true, 0);
    w.spawnUnit(U.engineer, 30.5, 90.5);
    return { w, ids };
  }
  /** Materials of the instanced meshes with an instance at world (x, z). */
  function materialsAt(scene: Scene, x: number, z: number): MeshStandardMaterial[] {
    scene.updateMatrixWorld(true);
    const out: MeshStandardMaterial[] = [];
    const m = new Vector3();
    scene.traverseVisible((o) => {
      if (!(o instanceof InstancedMesh) || o.count <= 0 || !o.name.startsWith('w17/')) return;
      const a = o.instanceMatrix.array as Float32Array;
      for (let i = 0; i < o.count; i++) {
        m.set(a[i * 16 + 12]!, a[i * 16 + 13]!, a[i * 16 + 14]!).applyMatrix4(o.matrixWorld);
        if (Math.abs(m.x - x) < 0.05 && Math.abs(m.z - z) < 0.05) {
          out.push(o.material as MeshStandardMaterial);
          return;
        }
      }
    });
    return out;
  }

  it('each belt draws the surface material of its own speed (rails and body shared), the merger Fast’s; each speed’s texture offset is −(its phase mod 1)', () => {
    const { r, scene } = renderer();
    const { w } = fixture();
    const snap = snapshotOf(w);
    r.forcedLevel = 0;
    r.cull = false;
    const mats = r.materials.w17 as unknown as Record<string, MeshStandardMaterial>;
    const surface = [null, mats.beltSlow, mats.beltMedium, mats.belt];
    expect(surface.slice(1).every((m) => m && m.map), 'a surface material with a texture per speed').toBe(true);
    expect(new Set(surface.slice(1).map((m) => m!.map)).size, 'three textures').toBe(3);
    const frame = (belt: BeltFrame) => {
      const time = new EffectClock().advance(Math.min(0.1, belt.seconds), belt.speed, belt.paused, snap.tick, belt.world);
      r.update({ camera: camera({ x: 43, z: 66, distance: 20, yaw: 0 }), viewportHeight: 900, yaw: 0, snapshot: snap, aliens: mobile(snap.aliens), units: mobile(snap.units), dt: 0.1, time, belt });
    };
    frame(run(0));
    for (let k = 0; k < 7; k++) frame(run(0.1));
    const flow = (r as unknown as { beltFlow: Flow }).beltFlow;
    for (const t of [1, 2, 3]) {
      const ph = flow.phases[t]!;
      expect(surface[t]!.map!.offset.y, `tier ${t} offset`).toBeCloseTo(-(ph - Math.floor(ph)), 9);
    }
    for (const [t, x] of [
      [1, 40],
      [2, 42],
      [3, 44],
      [3, 46],
    ] as const) {
      const at = materialsAt(scene, x + 0.5, 66.5);
      const surf = at.filter((m) => surface.includes(m));
      expect(surf, `the surface at ${x}: ${at.map((m) => m.name).join(', ')}`).toEqual([surface[t]]);
      expect(at.length, `rails and body drawn at ${x} too`).toBeGreaterThan(1);
    }
  });

  it('a mixed-speed straight costs at most two extra draw calls over one speed', () => {
    const { r } = renderer();
    const draws = (tiers: number[]) => {
      const w = new World(1, terrain, { waves: false, belts: true });
      tiers.forEach((t, k) => setTier(w, w.placeBuilding(B.belt, 40 + 2 * k, 66, true, 0), t));
      const s = snapshotOf(w);
      r.forcedLevel = 0;
      r.cull = false;
      r.update({ camera: camera(), viewportHeight: 900, yaw: 0, snapshot: s, aliens: mobile(s.aliens), units: mobile(s.units) });
      return (r as unknown as { w17: { drawCalls: number } }).w17.drawCalls;
    };
    const one = draws([1, 1, 1]);
    const mixed = draws([1, 2, 3]);
    expect(mixed - one).toBe(2);
    expect(CAPACITY.buildings).toBeGreaterThan(0);
  });
});
