// W29 (PLAN-W29 items 4, 16–19): what the renderer and the UI show of belts and the core. Mass and
// rare items have their own meshes (shapes, not colours); the core has a model at full and simple
// detail and an icon; a disabled core carries a hazard marker and the word DISABLED; a full
// extractor stops its digging motion; the hover readouts and the resource readout say what they count.

import { describe, expect, it } from 'vitest';
import { InstancedMesh, Scene, Sprite, type BufferGeometry } from 'three';
import type { World } from '../src/sim/world.ts';
import { createWorld } from '../src/sim/scenarios.ts';
import { B, ITEM_MASS, ITEM_RARE } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_IDLE } from '../src/sim/schema.ts';
import { CORE_HP } from '../src/sim/balance.ts';
import { damageBuilding } from '../src/sim/combat.ts';
import { itemGeometries } from '../src/render/geometry.ts';
import { EntityRenderer } from '../src/render/entities.ts';
import { Animator } from '../src/render/anim.ts';
import { entitiesOf, inspectScene } from '../src/render/inspect.ts';
import { economyText, type EconomyReadout } from '../src/ui/hud.ts';
import { CAPACITY } from '../src/sim/world.ts';
import { camera, draw, mobile, renderer, snapshotOf, terrain } from './w24r2a-fixtures.ts';
import { beltLine, slot, steps } from './w29-fixtures.ts';

// the two new modules are loaded per test, so the rest of this file runs (and fails on its
// assertions) before they exist
const coreView = () => import('../src/render/coreView.ts');
const readouts = async () => (await import('../src/render/buildingReadout.ts')).buildingReadout;

const positions = (g: BufferGeometry) => Array.from(g.getAttribute('position').array as ArrayLike<number>);
const sameShape = (a: BufferGeometry, b: BufferGeometry) => {
  const pa = positions(a);
  const pb = positions(b);
  return pa.length === pb.length && pa.every((v, i) => v === pb[i]);
};

/** Map 1 terrain, belts on, the core where map 1 has it, a mass and a rare item on belts beside it. */
function scene(): World {
  const w = createWorld(1, 'sandbox');
  const m = w.placeBuilding(B.belt, 56, 70, true, 0);
  const r = w.placeBuilding(B.belt, 58, 70, true, 0);
  w.buildings.cols.item[slot(w, m)] = ITEM_MASS;
  w.buildings.cols.item[slot(w, r)] = ITEM_RARE;
  return w;
}

describe('W29 items on belts', () => {
  it('mass and rare items have shapes of their own, distinct from each other and from salvage, scrap, alloy and part', () => {
    const g = itemGeometries();
    expect(g.length).toBe(7);
    for (const k of [ITEM_MASS, ITEM_RARE]) for (let o = 1; o < 7; o++) if (o !== k) expect(sameShape(g[k]!, g[o]!), `item ${k} vs ${o}`).toBe(false);
  });

  it('the overlay draws a mass item with the mass mesh and a rare item with the rare mesh (no clamp to the part mesh)', () => {
    const sc = new Scene();
    const e = new EntityRenderer(sc, terrain, CAPACITY);
    const snap = snapshotOf(scene());
    e.update({ camera: camera({ x: 58, z: 68, distance: 14, yaw: 0 }), viewportHeight: 900, yaw: 0, snapshot: snap, aliens: mobile(snap.aliens), units: mobile(snap.units), projectiles: mobile(snap.projectiles), selection: [] });
    const count = (name: string) => {
      let n = 0;
      sc.traverse((o) => {
        if (o instanceof InstancedMesh && o.name === name && o.visible) n += o.count;
      });
      return n;
    };
    expect(count(`overlay/item/${ITEM_MASS}`)).toBe(1);
    expect(count(`overlay/item/${ITEM_RARE}`)).toBe(1);
    expect(count('overlay/item/4')).toBe(0);
  });
});

describe('W29 the core drawn', () => {
  it('has a model at full and simple detail and an icon at the strategic zoom', () => {
    const { r, scene: sc } = renderer();
    const w = createWorld(1, 'sandbox');
    const snap = snapshotOf(w);
    for (const [level, field] of [[0, 'models'], [2, 'models'], [3, 'icons']] as const) {
      draw(r, snap, { level });
      const rep = inspectScene(sc, entitiesOf(snap, mobile(snap.aliens), mobile(snap.units)));
      expect(rep.core?.[field], `level ${level}`).toBeGreaterThan(0);
    }
  });

  it('a disabled core carries a hazard marker with the word DISABLED; an enabled one none', async () => {
    const { CoreOverlay, inspectCore } = await coreView();
    const w = createWorld(1, 'sandbox');
    const sc = new Scene();
    const o = new CoreOverlay(sc, terrain);
    const cam = camera({ x: 62, z: 64, distance: 30, yaw: 0 });
    o.update({ camera: cam, viewportHeight: 900, snapshot: snapshotOf(w) });
    expect(inspectCore(sc)).toEqual([]);
    damageBuilding(w, w.buildings.slotForId(w.coreId), CORE_HP);
    o.update({ camera: cam, viewportHeight: 900, snapshot: snapshotOf(w) });
    const marks = inspectCore(sc);
    expect(marks.length).toBe(1);
    expect(marks[0]).toMatchObject({ icon: 'hazard', text: 'DISABLED', id: w.coreId });
    let sprites = 0;
    sc.traverse((s) => {
      if (s instanceof Sprite && s.visible) sprites++;
    });
    expect(sprites).toBe(1);
  });
});

describe('W29 extractor motion', () => {
  it('a complete extractor runs while digging and stops when its buffer is full (BF_IDLE)', () => {
    const a = new Animator(8);
    a.begin(1, { t: 0.1, dt: 0.1, reset: false });
    a.motion(0, B.massExtractor, BF_COMPLETE, 0);
    expect(a.working).toBe(true);
    a.motion(1, B.massExtractor, BF_COMPLETE | BF_IDLE, 0);
    expect(a.working).toBe(false);
    a.motion(2, B.generator, BF_COMPLETE, 0);
    expect(a.working).toBe(true);
  });

  it('the simulation sets BF_IDLE on a full extractor only', () => {
    const { w, extractor } = beltLine(10, { belt: false });
    steps(w, 100);
    expect(w.buildings.cols.flags[slot(w, extractor)]! & BF_IDLE).toBe(0);
    steps(w, 1800);
    expect(w.buildings.cols.flags[slot(w, extractor)]! & BF_IDLE).not.toBe(0);
  });
});

describe('W29 hover readouts and the resource readout', () => {
  it('an extractor shows its buffer against its cap, and "full — not digging" when full', async () => {
    const buildingReadout = await readouts();
    const { w, extractor } = beltLine(10, { belt: false });
    steps(w, 100);
    let lines = buildingReadout(snapshotOf(w), extractor, false)!.lines;
    expect(lines[0]).toBe('Mass extractor');
    expect(lines).toContain('buffer 10 / 180 mass');
    expect(lines.join('\n')).not.toMatch(/not digging/);
    steps(w, 1800);
    lines = buildingReadout(snapshotOf(w), extractor, false)!.lines;
    expect(lines).toContain('buffer 180 / 180 mass');
    expect(lines).toContain('full — not digging');
  });

  it('the core shows hp, delivered mass and rare, and "disabled" at 0 hp', async () => {
    const buildingReadout = await readouts();
    const { w, core } = beltLine(10);
    steps(w, 100);
    let lines = buildingReadout(snapshotOf(w), core, false)!.lines;
    expect(lines[0]).toBe('Core');
    expect(lines).toContain(`hp 4000 / 4000`);
    expect(lines).toContain(`delivered mass ${w.delivered[0]} · rare 0`);
    damageBuilding(w, slot(w, core), CORE_HP);
    lines = buildingReadout(snapshotOf(w), core, false)!.lines;
    expect(lines).toContain('hp 0 / 4000');
    expect(lines.join('\n')).toMatch(/DISABLED/);
  });

  it('a damaged building with builders selected says right-click repairs it; undamaged, no readout', async () => {
    const buildingReadout = await readouts();
    const w = createWorld(1, 'sandbox');
    const gun = w.placeBuilding(B.gun, 48, 56, true);
    expect(buildingReadout(snapshotOf(w), gun, true)).toBeNull();
    w.buildings.cols.hp[slot(w, gun)] = 100;
    const lines = buildingReadout(snapshotOf(w), gun, true)!.lines;
    expect(lines).toContain(`hp 100 / ${w.buildings.cols.maxHp[slot(w, gun)]}`);
    expect(lines).toContain('right-click: repair');
    expect(buildingReadout(snapshotOf(w), gun, false)!.lines).not.toContain('right-click: repair');
  });

  it('the resource readout says the mass and rare rates count delivered resources when belts are on', () => {
    const e: EconomyReadout = { pool: [600, 2000, 20], income: [2, 10, 0.25], spend: [0, 0, 0], short: [false, false, false], parts: 0, commanderHp: 6000, commanderMax: 6000, aliens: 0, kills: 0, upkeep: 1, lost: false, won: false };
    expect(economyText(e)).not.toMatch(/delivered/);
    expect(economyText({ ...e, delivered: true })).toMatch(/mass and rare income: delivered at the core/);
  });
});
