// W24 run 2a, criteria 2, 6 and 7: the scene graph holds the inventory's models for every kind
// (read from the actual meshes and instanced batches, never from a renderer report), construction
// cuts follow each site's own progress, and the five turret kinds are the W22 kit's kinds.

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BoxGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Scene, type BufferGeometry, type Object3D } from 'three';
import { A, ALIEN_KINDS, BUILDING_KINDS, B, UNIT_KINDS } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_STARTED } from '../src/sim/schema.ts';
import { CAPACITY } from '../src/sim/world.ts';
import { EntityRenderer } from '../src/render/entities.ts';
import { BeltShapes } from '../src/render/beltShapes.ts';
import { routeMarkerGeometries } from '../src/render/geometry.ts';
import { createWorld } from '../src/sim/scenarios.ts';
import { footprintRange } from '../src/render/ground.ts';
import { ICONS } from '../src/render/icons.ts';
import { UNGROUPED, entitiesOf, inspectScene } from '../src/render/inspect.ts';
import { TURRET_KINDS, TURRET_SCALE } from '../src/render/models.ts';
import { GUN, PINION, PINION0, PITCH, STATIC, YAW } from '../src/render/workshop/kit/kit.ts';
import { BUILT } from '../src/render/workshop/w23/mats.ts';
import { camera, draw, everyKind, mobile, renderer, rowOf, snapshotOf, terrain } from './w24r2a-fixtures.ts';

const { r, scene } = renderer();
const fx = everyKind();
const INVENTORY = [...BUILDING_KINDS, ...UNIT_KINDS, ...ALIEN_KINDS];
const W23 = /^w23-(ceramic|gunmetal|bronze|dark|glow)$/;
const W17 = /^[a-zA-Z]+-cut$/;

function inspect(s = fx.snap, root: Object3D = scene) {
  return inspectScene(root, entitiesOf(s, mobile(s.aliens), mobile(s.units)));
}

/** Instanced meshes with instances, by name. */
function live(root: Object3D): InstancedMesh[] {
  const out: InstancedMesh[] = [];
  root.traverse((o) => {
    if (o instanceof InstancedMesh && o.visible && o.count > 0) out.push(o);
  });
  return out;
}

describe('criterion 2: every kind is drawn with its model, read from the scene graph', () => {
  it('full detail: each kind of the inventory has model instances on every one of its entities, no greybox', () => {
    draw(r, fx.snap, { level: 0 });
    const rep = inspect();
    for (const k of INVENTORY) {
      const e = rep[k];
      expect(e, k).toBeDefined();
      expect(e!.entities, k).toBeGreaterThan(0);
      expect(e!.models, `${k}: model instances`).toBeGreaterThan(0);
      expect(e!.covered, `${k}: entities with a model`).toBe(e!.entities);
      expect(e!.greybox, `${k}: greybox instances`).toBe(0);
      for (const m of e!.materials) expect(W23.test(m) || W17.test(m) || m === 'plinth', `${k}: material ${m}`).toBe(true);
      expect(e!.meshes.some((n) => n.startsWith('greybox/')), k).toBe(false);
    }
  });

  it('the families: W23 parts for walls, gates, extractors, turrets and units; W17 models for the rest', () => {
    draw(r, fx.snap, { level: 0 });
    const rep = inspect();
    const w23Kinds = ['wall', 'gate', 'massExtractor', 'rareExtractor', 'gun', 'area', 'beam', 'heavy', 'tempTurret', 'commander', 'engineer'];
    for (const k of w23Kinds) expect(rep[k]!.materials.filter((m) => W23.test(m)).length, k).toBeGreaterThan(0);
    for (const k of ['generator', 'lab', 'depot', 'shredder', 'smelter', 'assembler', 'shield', 'belt', 'splitter', 'merger', ...ALIEN_KINDS]) {
      expect(rep[k]!.meshes.every((n) => n.startsWith('w17/') || n === 'plinth'), `${k}: ${rep[k]!.meshes.join(', ')}`).toBe(true);
    }
    // splitter and merger carry their own markers, so neither is drawn like a belt
    expect(rep.splitter!.meshes.some((n) => n.startsWith('w17/splitterMarker/'))).toBe(true);
    expect(rep.merger!.meshes.some((n) => n.startsWith('w17/mergerMarker/'))).toBe(true);
    expect(rep.belt!.meshes.some((n) => n.includes('Marker'))).toBe(false);
    // the turrets are kit parts, the walls and gates W23 wall parts
    expect(rep.gun!.meshes.some((n) => n.startsWith('kit/'))).toBe(true);
    expect(rep.wall!.meshes.some((n) => n.startsWith('core/'))).toBe(true);
    expect(rep.gate!.meshes.some((n) => n.startsWith('gate/pylon'))).toBe(true);
  });

  it('strategic zoom: each kind has its own icon on every entity', () => {
    draw(r, fx.snap, { level: 3 });
    const rep = inspect();
    const iconOf = new Map<string, Set<string>>();
    for (const k of INVENTORY) {
      expect(rep[k]!.icons, `${k}: icons`).toBeGreaterThan(0);
      expect(rep[k]!.covered, k).toBe(rep[k]!.entities);
      expect(rep[k]!.greybox, k).toBe(0);
      iconOf.set(k, new Set(rep[k]!.meshes.filter((n) => n.startsWith('icon/'))));
    }
    // one icon per kind, never shared between two kinds (the commander also has its ring icon)
    const seen = new Map<string, string>();
    for (const [k, set] of iconOf)
      for (const n of set) {
        if (seen.has(n)) expect.fail(`${k} and ${seen.get(n)} share ${n}`);
        seen.set(n, k);
      }
    expect(new Set(ICONS).size).toBe(ICONS.length);
  });

  it('every drawn model and icon mesh says which entity group it draws (none ungrouped)', () => {
    for (const level of [0, 1, 2, 3]) {
      draw(r, fx.snap, { level });
      expect(inspect()[UNGROUPED]?.meshes ?? [], `level ${level}`).toEqual([]);
    }
  });

  it('the inspection sees greybox when it is there (a greybox/ mesh on a gun), and the overlays add none', () => {
    // W24 run 3 (G): W13's renderer is gone; a mesh named as its batches were stands in for it
    const grey = new Scene();
    const s = fx.snap;
    const c = s.buildings.cols;
    const gun = Array.from({ length: s.buildings.count }, (_, r) => r).find((r) => c.kind[r] === B.gun)!;
    const m = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 1);
    m.name = 'greybox/building/0';
    m.setMatrixAt(0, new Matrix4().makeTranslation(c.tx[gun]! + c.fw[gun]! / 2, 0, c.ty[gun]! + c.fh[gun]! / 2));
    grey.add(m);
    const rep = inspect(s, grey);
    expect(rep.gun!.greybox).toBeGreaterThan(0);
    // the model view's overlays add no greybox
    const overlay = new Scene();
    const o = new EntityRenderer(overlay, terrain, CAPACITY, new BeltShapes(terrain.w, terrain.h));
    o.update({ camera: camera(), viewportHeight: 900, yaw: 0, snapshot: s, aliens: mobile(s.aliens), units: mobile(s.units), projectiles: mobile(s.aliens), selection: [] });
    for (const k of INVENTORY) expect(inspect(s, overlay)[k]?.greybox ?? 0, k).toBe(0);
  });
});

describe('criterion 6: construction cuts follow each site’s progress', () => {
  for (const [name, kind, spots, meshPrefix] of [
    ['generator (W17)', B.generator, [[40, 80], [48, 80]], 'w17/generator/'],
    ['gun turret (kit)', B.gun, [[40, 84], [48, 84]], 'kit/'],
    ['wall (W23)', B.wall, [[40, 88], [48, 88]], 'core/'],
  ] as const) {
    it(`${name}: two sites at 0.25 and 0.75 in one frame show different cut heights, base + height × progress`, () => {
      const f = everyKind();
      const ids = spots.map(([x, y]) => f.world.placeBuilding(kind, x, y, false));
      const s = snapshotOf(f.world);
      const prog = [0.25, 0.75];
      ids.forEach((id, i) => {
        const row = rowOf(s, id);
        s.buildings.cols.flags[row] = BF_STARTED;
        s.buildings.cols.progress[row] = prog[i]!;
      });
      draw(r, s, { level: 0 });
      const cuts: number[][] = [[], []];
      for (const m of live(r.group)) {
        if (!m.name.startsWith(meshPrefix) || !m.instanceColor) continue;
        const a = m.instanceMatrix.array as Float32Array;
        const c = m.instanceColor.array as Float32Array;
        for (let i = 0; i < m.count; i++) {
          const x = a[i * 16 + 12]!;
          const z = a[i * 16 + 14]!;
          spots.forEach(([tx, ty], k) => {
            if (x > tx - 0.5 && x < tx + 3 && z > ty - 0.5 && z < ty + 3) cuts[k]!.push(c[i * 3 + 2]!);
          });
        }
      }
      expect(cuts[0]!.length).toBeGreaterThan(0);
      expect(cuts[1]!.length).toBeGreaterThan(0);
      const c0 = new Set(cuts[0]!.map((v) => v.toFixed(4)));
      const c1 = new Set(cuts[1]!.map((v) => v.toFixed(4)));
      expect(c0.size).toBe(1);
      expect(c1.size).toBe(1);
      const [fw] = kind === B.wall ? [1] : kind === B.gun ? [2] : [2];
      const top0 = footprintRange(terrain, spots[0]![0], spots[0]![1], fw, fw).top;
      const top1 = footprintRange(terrain, spots[1]![0], spots[1]![1], fw, fw).top;
      // the same kind: equal heights above base, so cut − base scales with progress (1 : 3)
      const h0 = cuts[0]![0]! - top0;
      const h1 = cuts[1]![0]! - top1;
      expect(h0).toBeGreaterThan(0);
      expect(h1 / h0).toBeCloseTo(3, 4);
      expect(cuts[0]![0]).not.toBeCloseTo(cuts[1]![0]!, 2);
      // complete buildings are not cut
      draw(r, f.snap, { level: 0 });
      for (const m of live(r.group)) if (m.instanceColor && m.name.startsWith(meshPrefix)) for (let i = 0; i < m.count; i++) expect((m.instanceColor.array as Float32Array)[i * 3 + 2]).toBe(BUILT);
    });
  }

  it('a reserved site is a dotted outline only: no model instance on its tiles', () => {
    const f = everyKind();
    const id = f.world.placeBuilding(B.gun, 40, 84, false);
    const s = snapshotOf(f.world);
    expect(s.buildings.cols.flags[rowOf(s, id)]! & (BF_STARTED | BF_COMPLETE)).toBe(0);
    draw(r, s, { level: 0 });
    const rep = inspectScene(scene, [{ group: 'building', kindName: 'site', id, x: 41, z: 85, hx: 1, hz: 1 }]);
    expect(rep.site!.meshes).toEqual(['reserved-outline']);
  });
});

describe('criterion 7: the turrets are the W22 kit kinds, assembled by the kit', () => {
  it('each mapped kind has exactly the W22 kit kind’s parts, pivots, offsets and frame (look/src/kit)', async () => {
    // look/ is the source of truth; imported at run time so the game's typecheck does not need look/
    const look = fileURLToPath(new URL('../../look/src/', import.meta.url));
    const { buildKit } = await import(/* @vite-ignore */ `${look}kit/kit.ts`);
    const { buildTurret } = await import(/* @vite-ignore */ `${look}bench/turretModel.ts`);
    const { TurretRig } = await import(/* @vite-ignore */ `${look}bench/turretRig.ts`);
    const m = (name: string) => new MeshStandardMaterial({ name });
    const t = { ceramic: m('ceramic'), gunmetal: m('gunmetal'), bronze: m('bronze'), dark: m('dark'), glow: m('glow'), brass: m('brass') };
    const mats = { ...t, all: Object.values(t) };
    const model = buildTurret(mats);
    const theirs = buildKit(mats, model, new TurretRig(model, mats, 'simple'));
    expect(TURRET_KINDS.get(B.gun)).toBe('bastion');
    expect(TURRET_KINDS.get(B.area)).toBe('anvil');
    expect(TURRET_KINDS.get(B.beam)).toBe('lantern');
    expect(TURRET_KINDS.get(B.heavy)).toBe('rampart');
    expect(TURRET_KINDS.get(B.tempTurret)).toBe('lookout');
    type P = { part: { id: string; triangles: number[] }; pivot: number[]; off: number[] };
    const sig = (k: { placed: P[] }) => k.placed.map((p) => ({ id: p.part.id, pivot: p.pivot, off: p.off, tris: p.part.triangles }));
    for (const [game, id] of TURRET_KINDS) {
      const ours = r.kitKinds.get(game)!;
      const ref = theirs.kinds.find((k: { id: string }) => k.id === id);
      expect(ours.id).toBe(id);
      expect(sig(ours as unknown as { placed: P[] })).toEqual(sig(ref));
      expect(ours.frame).toEqual(ref.frame);
      expect(ours.triangles).toEqual(ref.triangles);
    }
  }, 60_000);

  for (const [game, id] of TURRET_KINDS) {
    it(`${id} (game ${BUILDING_KINDS[game]}): the submitted batches are its parts; base on the footprint centre; yaw moves only yaw-driven parts`, () => {
      const f = everyKind();
      const s0 = snapshotOf(f.world);
      // keep only this turret and one alien to aim at
      const row = rowOf(s0, f.ids[BUILDING_KINDS[game]!]!);
      const tx = s0.buildings.cols.tx[row]!;
      const ty = s0.buildings.cols.ty[row]!;
      const fw = s0.buildings.cols.fw[row]!;
      const only = (s: typeof s0, target: number) => {
        for (const k of Object.keys(s.buildings.cols) as Array<keyof typeof s.buildings.cols>) {
          const col = s.buildings.cols[k] as unknown as { [i: number]: number };
          col[0] = col[row]!;
        }
        s.buildings.id[0] = s.buildings.id[row]!;
        s.buildings.count = 1;
        s.buildings.cols.target[0] = target;
        return s;
      };
      const kind = r.kitKinds.get(game)!;
      // aim first at the rusher (north-west of every turret), then at the breaker (south)
      const first = f.aliens.rusher!;
      const alien = f.aliens.breaker!;
      for (const lv of [0, 1, 2]) {
        draw(r, only(snapshotOf(f.world), first + 1), { level: lv });
        const before = new Map<string, Float32Array>();
        for (const m of live(r.group)) if (m.name.startsWith('kit/')) before.set(m.userData.part as string, (m.instanceMatrix.array as Float32Array).slice(0, 16));
        const want = kind.placed.filter((p) => p.part.levels[lv]!.size > 0).map((p) => `kit/${p.part.id}`);
        expect([...before.keys()].sort(), `level ${lv}`).toEqual([...new Set(want)].sort());
        for (const m of live(r.group)) if (m.name.startsWith('kit/')) expect(m.count).toBe(1);
        // the base (static pivot) stands on the footprint centre at the footprint's base height
        const base = kind.placed.find((p) => p.pivot[lv] === STATIC)!;
        const bm = before.get(`kit/${base.part.id}`)!;
        const top = footprintRange(terrain, tx, ty, fw, fw).top;
        expect(bm[12]).toBeCloseTo(tx + fw / 2, 5);
        expect(bm[14]).toBeCloseTo(ty + fw / 2, 5);
        expect(bm[13]).toBeCloseTo(top + base.off[1] * (TURRET_SCALE.get(game) ?? 1), 5);
        // aim at the breaker instead: static parts keep their matrices, yaw-driven parts turn
        draw(r, only(snapshotOf(f.world), alien + 1), { level: lv });
        for (const m of live(r.group)) {
          if (!m.name.startsWith('kit/')) continue;
          const pid = m.userData.part as string;
          const pl = kind.placed.find((p) => `kit/${p.part.id}` === pid)!;
          const after = (m.instanceMatrix.array as Float32Array).slice(0, 16);
          const moved = after.some((v, i) => Math.abs(v - before.get(pid)![i]!) > 1e-6);
          const pivot = pl.pivot[lv]!;
          if (pivot === STATIC || pivot === PINION0) expect(moved, `${pid} level ${lv}`).toBe(false);
          else {
            expect([PINION, YAW, PITCH, GUN]).toContain(pivot);
            expect(moved, `${pid} level ${lv}`).toBe(true);
          }
        }
      }
    });
  }
});

describe('Richard: no alien routes are drawn (the simulation still computes them)', () => {
  it('the view puts no route geometry in the scene, with entry and spawn-origin routes in the snapshot', () => {
    const w = createWorld(1, 'sandbox');
    w.step();
    w.enqueue({ t: 'spawnAt', kind: A.rusher, x: 60.5, z: 30.5, count: 3 });
    for (let i = 0; i < 3; i++) w.step();
    const s = snapshotOf(w);
    expect(s.routes.length).toBeGreaterThan(0);
    expect(s.originRoutes.length).toBeGreaterThan(0);
    const markers = routeMarkerGeometries().map((g) => (g.getAttribute('position').array as Float32Array).join(','));
    const isRoute = (g: BufferGeometry) => markers.includes((g.getAttribute('position').array as Float32Array).join(','));
    const scenes: Object3D[] = [];
    const sc = new Scene();
    const e = new EntityRenderer(sc, terrain, CAPACITY, new BeltShapes(terrain.w, terrain.h));
    e.update({ camera: camera({ x: 64, z: 64, distance: 200, yaw: 0 }), viewportHeight: 900, yaw: 0, snapshot: s, aliens: mobile(s.aliens), units: mobile(s.units), projectiles: mobile(s.aliens), selection: [] });
    scenes.push(sc);
    draw(r, s, { level: 0 });
    scenes.push(scene);
    let meshes = 0;
    for (const sc of scenes)
      sc.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        meshes++;
        expect(isRoute(o.geometry), o.name).toBe(false);
        expect(o.name.toLowerCase()).not.toContain('route');
      });
    expect(meshes).toBeGreaterThan(50);
  });
});
