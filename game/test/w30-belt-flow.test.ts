// W30 (PLAN-W30): belts show their direction of travel. Every belt surface carries flow UVs (v =
// progress along the flow in tiles, u = across the belt), so the chevron texture scrolled by one
// shared offset runs forward on straights, corners, joins and the merger, and the pattern meets
// itself at every tile edge. A corner's v follows the same angle fraction items use (beltShapes.ts
// itemOnBelt). The splitter, whose items leave left and right only, shows still rubber and a marker
// without a forward arrow. The belt phase advances by min(raw frame seconds × speed × belt speed,
// 0.2) tiles a frame: 0 while paused, no jump on a reset or a rewind. The browser half (the drawn
// texture, rendered motion, the chevrons' orientation) is scripts/check-belt-flow.mjs.

import { describe, expect, it } from 'vitest';
import { InstancedMesh, MeshStandardMaterial, Vector3, type Material, type Scene, type Texture } from 'three';
import { B, BELT_TILES_PER_SECOND } from '../src/sim/kinds.ts';
import { BELT_CORNER_L, BELT_CORNER_R, itemOnBelt } from '../src/render/beltShapes.ts';
import { EffectClock, frameTimes, type BeltFrame } from '../src/render/anim.ts';
import { standInMaterials } from '../src/render/materials.ts';
import { W17_BUILDING_MODEL, type ModelRenderer } from '../src/render/models.ts';
import { bakeModel } from '../src/render/w17Batches.ts';
import { BELT_SHAPE_MAKERS, BUILDING_MAKERS } from '../src/render/workshop/models/procedural/buildings.ts';
import type { Mats } from '../src/render/workshop/models/materials.ts';
import type { ModelDef } from '../src/render/workshop/models/types.ts';
import { camera, everyKind, mobile, renderer, snapshotOf } from './w24r2a-fixtures.ts';
import type { Snapshot } from '../src/sim/snapshot.ts';

type Make = (m: Mats) => ModelDef;
interface Tri {
  p: Vector3[];
  uv: Array<[number, number]>;
}

const makerOf = (name: string): Make => (BELT_SHAPE_MAKERS[name] ?? (BUILDING_MAKERS as Record<string, Make>)[name])!;
/** The straight piece, the corners, the joins, and the merger as the renderer selects it. */
const MERGER = W17_BUILDING_MODEL.get(B.merger)!;
const SHAPES = ['belt', 'beltCornerR', 'beltCornerL', 'beltJoinR', 'beltJoinL', 'beltJoinLR'];

/** The top faces of a model's belt-surface parts (the `belt` material), positions in model space (+x the flow). */
function surfaceTop(make: Make): Tri[] {
  const mats = standInMaterials().w17;
  const baked = bakeModel(make(mats));
  const tris: Tri[] = [];
  for (const piece of baked.pieces) {
    if (piece.material !== mats.belt) continue;
    const pos = piece.geometry.getAttribute('position');
    const uv = piece.geometry.getAttribute('uv');
    for (let i = 0; i + 2 < pos.count; i += 3) {
      const p = [0, 1, 2].map((k) => new Vector3().fromBufferAttribute(pos, i + k));
      const n = new Vector3().subVectors(p[1]!, p[0]!).cross(new Vector3().subVectors(p[2]!, p[0]!)).normalize();
      if (Math.abs(n.y) < 0.99) continue;
      tris.push({ p, uv: [0, 1, 2].map((k) => [uv.getX(i + k), uv.getY(i + k)] as [number, number]) });
    }
  }
  const top = Math.max(...tris.flatMap((t) => t.p.map((q) => q.y)));
  return tris.filter((t) => t.p.every((q) => Math.abs(q.y - top) < 1e-4));
}

/** Every top vertex as [x, z, u, v]. */
const verts = (tris: Tri[]) => tris.flatMap((t) => t.p.map((q, k) => [q.x, q.z, t.uv[k]![0], t.uv[k]![1]] as const));
/** Distance between two values mod 1. */
const mod1 = (a: number, b: number) => {
  const d = (((a - b) % 1) + 1) % 1;
  return Math.min(d, 1 - d);
};
/** The flow v at a point of the top surface (x, z), barycentric in the triangle containing it, or null. */
function vAt(tris: Tri[], x: number, z: number): number | null {
  for (const t of tris) {
    const [a, b, c] = t.p as [Vector3, Vector3, Vector3];
    const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(d) < 1e-12) continue;
    const l0 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
    const l1 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
    const l2 = 1 - l0 - l1;
    if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
    return l0 * t.uv[0]![1] + l1 * t.uv[1]![1] + l2 * t.uv[2]![1];
  }
  return null;
}

/** Splits a join's top into the main surface and the side lanes (a lane triangle lies wholly beyond the main rail line). */
function lanes(tris: Tri[]) {
  const maxZ = Math.max(...tris.flatMap((t) => t.p.map((q) => Math.abs(q.z))));
  const main = tris.filter((t) => Math.abs((t.p[0]!.z + t.p[1]!.z + t.p[2]!.z) / 3) < 0.34);
  const lane = tris.filter((t) => !main.includes(t));
  return { main, lane, maxZ };
}

describe('W30 flow UVs on every belt surface', () => {
  it('each belt shape and the merger carries flow UVs, v increasing along the flow (straight: with +x; join lanes: toward the main belt; corners: input edge to front edge)', () => {
    for (const name of [...SHAPES, MERGER]) {
      const tris = surfaceTop(makerOf(name));
      expect(tris.length, `${name}: belt surface top faces`).toBeGreaterThan(0);
      const vs = verts(tris);
      // finish()'s default on a top face is the box projection (u, v) = (x, z)
      const defaults = vs.every(([x, z, u, v]) => Math.abs(u - x) < 1e-6 && Math.abs(v - z) < 1e-6);
      expect(defaults, `${name}: UVs are not the box-projected defaults`).toBe(false);
      for (const [, , u] of vs) expect(u, `${name}: u runs across the belt, 0..1`).toBeGreaterThanOrEqual(-0.01);
      for (const [, , u] of vs) expect(u, `${name}: u runs across the belt, 0..1`).toBeLessThanOrEqual(1.01);
      if (name.startsWith('beltCorner')) {
        const side = name === 'beltCornerR' ? 1 : -1;
        const input = vs.filter(([, z]) => Math.abs(z - 0.5 * side) < 1e-4);
        const front = vs.filter(([x]) => Math.abs(x - 0.5) < 1e-4);
        expect(input.length, `${name}: vertices on the input edge`).toBeGreaterThan(0);
        expect(front.length, `${name}: vertices on the front edge`).toBeGreaterThan(0);
        for (const [, , , v] of input) expect(v, `${name}: v at the input edge`).toBeCloseTo(0, 3);
        for (const [, , , v] of front) expect(v, `${name}: v at the front edge`).toBeCloseTo(1, 3);
        continue;
      }
      const { main, lane } = lanes(tris);
      for (const [x, , , v] of verts(main)) expect(v, `${name}: main surface v = x + ½ at x = ${x}`).toBeCloseTo(x + 0.5, 3);
      const open = name === 'beltJoinR' ? [1] : name === 'beltJoinL' ? [-1] : name === 'beltJoinLR' ? [-1, 1] : [];
      expect(lane.length > 0, `${name}: side lanes`).toBe(open.length > 0);
      for (const side of open) {
        const lv = verts(lane.filter((t) => Math.sign(t.p[0]!.z + t.p[1]!.z + t.p[2]!.z) === side));
        expect(lv.length, `${name}: lane on side ${side}`).toBeGreaterThan(0);
        const outer = lv.filter(([, z]) => Math.abs(Math.abs(z) - 0.5) < 1e-4);
        const inner = lv.filter(([, z]) => Math.abs(Math.abs(z) - 0.5) > 0.05);
        expect(outer.length && inner.length, `${name}: lane vertices at its outer edge and its inner end`).toBeTruthy();
        const vOuter = Math.max(...outer.map((q) => q[3]));
        for (const [, , , v] of inner) expect(v, `${name}: the lane's v rises inward (toward the main belt)`).toBeGreaterThan(vOuter + 0.1);
      }
    }
  });

  it('corners: at sample points across the surface (5 radii × 40 angles) the interpolated v equals itemOnBelt p within 0.02', () => {
    for (const [name, shape] of [
      ['beltCornerR', BELT_CORNER_R],
      ['beltCornerL', BELT_CORNER_L],
    ] as const) {
      const tris = surfaceTop(makerOf(name));
      const at = (p: number) => itemOnBelt(shape, 0, p, { x: 0, z: 0, tx: 0, tz: 0 });
      // the arc's centre: ½ ahead of the input edge's midpoint (direction 0 is +x, the model's flow)
      const p0 = at(0);
      const cx = p0.x + 0.5;
      const cz = p0.z;
      const rs = verts(tris).map(([x, z]) => Math.hypot(x - cx, z - cz));
      const r0 = Math.min(...rs);
      const r1 = Math.max(...rs);
      expect(r1 - r0, `${name}: belt width`).toBeGreaterThan(0.5);
      let worst = 0;
      let samples = 0;
      for (let k = 0; k < 40; k++) {
        const p = (k + 0.5) / 40;
        const c = at(p);
        for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
          const r = r0 + (r1 - r0) * f;
          const x = cx + ((c.x - cx) * r) / 0.5;
          const z = cz + ((c.z - cz) * r) / 0.5;
          const v = vAt(tris, x, z);
          expect(v, `${name}: surface at p ${p.toFixed(3)}, radius ${r.toFixed(3)}`).not.toBeNull();
          worst = Math.max(worst, Math.abs(v! - p));
          samples++;
        }
      }
      expect(samples).toBe(200);
      expect(worst, `${name}: worst |v − p| over the samples`).toBeLessThan(0.02);
    }
  });

  it('seams: every shape’s front edge matches a straight’s back edge (mod 1, within 0.01); a join lane’s outer edge matches a straight’s front edge; a corner’s input edge too', () => {
    const straight = verts(surfaceTop(makerOf('belt')));
    const backs = straight.filter(([x]) => Math.abs(x + 0.5) < 1e-4).map((q) => q[3]);
    const fronts = straight.filter(([x]) => Math.abs(x - 0.5) < 1e-4).map((q) => q[3]);
    expect(backs.length && fronts.length, 'the straight has vertices on both edges').toBeTruthy();
    const back = backs[0]!;
    const front = fronts[0]!;
    for (const v of backs) expect(mod1(v, back), 'v is the same all across the straight’s back edge').toBeLessThan(0.01);
    for (const v of fronts) expect(mod1(v, front), 'v is the same all across the straight’s front edge').toBeLessThan(0.01);
    for (const name of [...SHAPES, MERGER]) {
      const vs = verts(surfaceTop(makerOf(name)));
      const f = vs.filter(([x]) => Math.abs(x - 0.5) < 1e-4);
      expect(f.length, `${name}: front edge vertices`).toBeGreaterThan(0);
      for (const [, z, , v] of f) expect(mod1(v, back), `${name}: front edge at z ${z.toFixed(3)} against the straight's back edge`).toBeLessThan(0.01);
      if (name.startsWith('beltCorner')) {
        const side = name === 'beltCornerR' ? 1 : -1;
        for (const [x, , , v] of vs.filter(([, z]) => Math.abs(z - 0.5 * side) < 1e-4)) expect(mod1(v, front), `${name}: input edge at x ${x.toFixed(3)} against a straight's front edge`).toBeLessThan(0.01);
      }
      if (name.startsWith('beltJoin')) {
        const outer = verts(lanes(surfaceTop(makerOf(name))).lane).filter(([, z]) => Math.abs(Math.abs(z) - 0.5) < 1e-4);
        expect(outer.length, `${name}: lane outer edge vertices`).toBeGreaterThan(0);
        for (const [x, , , v] of outer) expect(mod1(v, front), `${name}: lane outer edge at x ${x.toFixed(3)} against a straight's front edge`).toBeLessThan(0.01);
      }
    }
  });
});

/** Instanced meshes drawing an instance whose origin is at world (x, z). */
function meshesAt(scene: Scene, x: number, z: number): InstancedMesh[] {
  scene.updateMatrixWorld(true);
  const out: InstancedMesh[] = [];
  const m = new Vector3();
  scene.traverseVisible((o) => {
    if (!(o instanceof InstancedMesh) || o.count <= 0) return;
    const a = o.instanceMatrix.array as Float32Array;
    for (let i = 0; i < o.count; i++) {
      m.set(a[i * 16 + 12]!, a[i * 16 + 13]!, a[i * 16 + 14]!).applyMatrix4(o.matrixWorld);
      if (Math.abs(m.x - x) < 0.05 && Math.abs(m.z - z) < 0.05) {
        out.push(o);
        return;
      }
    }
  });
  return out;
}

const mapOf = (m: Material | Material[]): Texture | null => (Array.isArray(m) ? null : ((m as MeshStandardMaterial).map ?? null));

describe('W30 the splitter', () => {
  it('a rendered splitter (through the renderer’s model selection) draws its surface without the scrolling material, and its marker has no forward output arrow', () => {
    const { r, scene } = renderer();
    const fx = everyKind();
    r.forcedLevel = 0;
    r.cull = false;
    r.update({ camera: camera(), viewportHeight: 900, yaw: 0, snapshot: fx.snap, aliens: mobile(fx.snap.aliens), units: mobile(fx.snap.units) });
    const scrolling = r.materials.w17.belt;
    // KIND_SPOTS: the splitter at (56, 66), facing +z (direction 1)
    const at = meshesAt(scene, 56.5, 66.5);
    const body = at.filter((m) => !m.name.includes('Marker'));
    const marker = at.find((m) => m.name.startsWith('w17/splitterMarker/') && m.name.includes('ivory'));
    expect(body.length, 'the splitter body is drawn').toBeGreaterThan(0);
    for (const m of body) {
      expect(m.material === scrolling, `${m.name}: not the scrolling belt material`).toBe(false);
      const map = mapOf(m.material);
      expect(map !== null && map === scrolling.map, `${m.name}: not the scrolling texture`).toBe(false);
    }
    expect(body.some((m) => !Array.isArray(m.material) && m.material.name.startsWith('belt')), `a belt surface at the splitter (${body.map((m) => m.name).join(', ')})`).toBe(true);
    expect(marker, 'the splitter marker is drawn').toBeDefined();
    // marker geometry is in model space (+x the belt's flow): no arrow plate ahead of the hub
    const pos = marker!.geometry.getAttribute('position');
    let ahead = -Infinity;
    let sideways = 0;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getZ(i)) < 0.12) ahead = Math.max(ahead, pos.getX(i));
      sideways = Math.max(sideways, Math.abs(pos.getZ(i)));
    }
    expect(ahead, 'the marker reaches no further forward than the hub (no forward output arrow)').toBeLessThan(0.3);
    expect(sideways, 'the marker still has its left and right output arrows').toBeGreaterThan(0.4);
  });
});

describe('W30 belt phase', () => {
  const runner = { speed: 1, paused: false, world: 0 };
  /** The straight belt mesh's texture offset (the shared scrolling texture, as drawn). */
  const offsetY = (scene: Scene): number => {
    let y = NaN;
    scene.traverseVisible((o) => {
      if (o instanceof InstancedMesh && o.name === 'w17/belt/belt-cut' && o.count > 0) y = mapOf(o.material)?.offset.y ?? NaN;
    });
    return y;
  };
  /** One renderer frame with the belt's frame input; returns how far the drawn pattern moved forward (tiles, mod 1). */
  const frame = (r: ModelRenderer, scene: Scene, snap: Snapshot, belt: BeltFrame, dt = Math.min(0.1, belt.seconds)): number => {
    const before = offsetY(scene);
    const time = new EffectClock().advance(dt, belt.speed, belt.paused, snap.tick, belt.world);
    r.update({ camera: camera(), viewportHeight: 900, yaw: 0, snapshot: snap, aliens: mobile(snap.aliens), units: mobile(snap.units), dt, time, belt });
    const after = offsetY(scene);
    // offset.y = −(phase mod 1): forward motion lowers it
    return (((before - after) % 1) + 1) % 1;
  };
  const setup = () => {
    const { r, scene } = renderer();
    r.forcedLevel = 0;
    r.cull = false;
    const fx = everyKind();
    const early = fx.snap;
    for (let k = 0; k < 3; k++) fx.world.step();
    const snap = snapshotOf(fx.world);
    // a priming frame: the shared renderer may have seen other snapshots
    frame(r, scene, snap, { seconds: 0, ...runner });
    frame(r, scene, snap, { seconds: 0, ...runner });
    return { r, scene, snap, early };
  };

  it('advances min(frame seconds × speed × 4, 0.2) tiles a frame through the drawn texture; 0 while paused; no jump on a reset or a rewind', async () => {
    const { r, scene, snap, early } = setup();
    expect(BELT_TILES_PER_SECOND).toBe(4);
    // 60 fps at 1×: 1/15 tile a frame (non-integral: a stationary or reversed phase fails)
    for (let k = 0; k < 5; k++) expect(frame(r, scene, snap, { seconds: 1 / 60, ...runner }), `60 fps frame ${k}`).toBeCloseTo(1 / 15, 6);
    // 0.1 s frames at 1×: 0.4 tile uncapped, capped at 0.2
    for (let k = 0; k < 4; k++) expect(frame(r, scene, snap, { seconds: 0.1, ...runner }), `0.1 s frame ${k}`).toBeCloseTo(0.2, 6);
    // the phase the renderer keeps moves the same way
    const flow = (r as unknown as { beltFlow: { phase: number; step: number } }).beltFlow;
    const ph = flow.phase;
    frame(r, scene, snap, { seconds: 1 / 60, ...runner });
    expect(flow.phase - ph, 'the renderer’s phase').toBeCloseTo(1 / 15, 6);
    // 20 fps and 30 fps at 10×: every frame moves forward, at most 0.2 tile (under half the 0.5-tile chevron period)
    for (const fps of [20, 30])
      for (let k = 0; k < 6; k++) {
        const d = frame(r, scene, snap, { seconds: 1 / fps, speed: 10, paused: false, world: 0 });
        expect(d, `${fps} fps at 10×, frame ${k}`).toBeGreaterThan(0);
        expect(d, `${fps} fps at 10×, frame ${k}`).toBeLessThanOrEqual(0.2 + 1e-9);
      }
    // paused
    for (let k = 0; k < 3; k++) expect(frame(r, scene, snap, { seconds: 1 / 60, speed: 1, paused: true, world: 0 }), `paused frame ${k}`).toBe(0);
    // a rewind (the tick goes back) and a reset (a new world epoch): no jump, then running again
    expect(frame(r, scene, early, { seconds: 0.1, ...runner }), 'the rewind frame').toBe(0);
    expect(frame(r, scene, early, { seconds: 1 / 60, ...runner }), 'the frame after the rewind').toBeCloseTo(1 / 15, 6);
    expect(frame(r, scene, early, { seconds: 0.1, speed: 1, paused: false, world: 1 }), 'the reset frame').toBe(0);
    expect(frame(r, scene, early, { seconds: 1 / 60, speed: 1, paused: false, world: 1 }), 'the frame after the reset').toBeCloseTo(1 / 15, 6);
  });

  it('main.ts’s frame path: a single 200 ms raw frame advances 0.2 at 1× (the cap) and at ¼× (0.1 with the 0.1 s-capped dt)', () => {
    const { r, scene, snap } = setup();
    const t = frameTimes(1200, 1000, runner);
    expect(t.dt, 'main.ts’s own dt stays capped at 0.1 s').toBeCloseTo(0.1, 9);
    expect(t.belt.seconds, 'the belt gets the raw frame time').toBeCloseTo(0.2, 9);
    expect(frame(r, scene, snap, t.belt, t.dt), '200 ms at 1×').toBeCloseTo(0.2, 6);
    const q = frameTimes(1200, 1000, { ...runner, speed: 0.25 });
    expect(frame(r, scene, snap, q.belt, q.dt), '200 ms at ¼×').toBeCloseTo(0.2, 6);
  });
});
