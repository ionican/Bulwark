// W29 follow-up (Richard, after the W29 screenshots): a belt that turns is drawn as one continuous
// curved piece, a line joining another shows its lane running into the straight tile, and belt items
// sit on the belt's top surface, big enough to read, following the curve on a corner. The shapes come
// from the snapshot alone (directions and neighbours) and are worked out again only when the belts
// change. The browser checks (pixels, the HUD) are in scripts/check-render.mjs and check-belts.mjs.

import { describe, expect, it } from 'vitest';
import { Box3, InstancedMesh, Matrix4, Scene, Vector3, type BufferGeometry } from 'three';
import { createWorld } from '../src/sim/scenarios.ts';
import type { World } from '../src/sim/world.ts';
import { B, ITEM_MASS, ITEM_RARE } from '../src/sim/kinds.ts';
import { CAPACITY } from '../src/sim/world.ts';
import { EntityRenderer } from '../src/render/entities.ts';
import { BeltShapes } from '../src/render/beltShapes.ts';
import { itemGeometries } from '../src/render/geometry.ts';
import { drawnMeshes } from '../src/render/inspect.ts';
import { bakeModel } from '../src/render/w17Batches.ts';
import { standInMaterials } from '../src/render/materials.ts';
import { BUILDING_MAKERS } from '../src/render/workshop/models/procedural/buildings.ts';
import { camera, draw, mobile, renderer, snapshotOf, terrain } from './w24r2a-fixtures.ts';
import { slot } from './w29-fixtures.ts';
import { footprintRange } from '../src/render/ground.ts';

// the new modules are loaded per test, so the file runs (and fails on its assertions) before they exist
type ShapesModule = typeof import('../src/render/beltShapes.ts');
/** The shapes module; before it exists, an assertion failure naming it (not an import error). */
const shapesModule = async (): Promise<ShapesModule> => {
  const m = await import('../src/render/beltShapes.ts').catch(() => null);
  expect(m?.BeltShapes, 'src/render/beltShapes.ts exports BeltShapes').toBeDefined();
  return m!;
};
const beltSurface = async () => ((await import('../src/render/workshop/models/procedural/buildings.ts')) as unknown as { BELT_SURFACE_Y?: number }).BELT_SURFACE_Y;
const beltShapeMakers = async () => ((await import('../src/render/workshop/models/procedural/buildings.ts')) as unknown as { BELT_SHAPE_MAKERS?: Record<string, typeof BUILDING_MAKERS.belt> }).BELT_SHAPE_MAKERS;

/** Belt tiles [x, z, dir] placed complete; throws if a tile is refused. */
function lay(w: World, tiles: Array<[number, number, number]>): number[] {
  return tiles.map(([x, z, d]) => {
    const id = w.placeBuilding(B.belt, x, z, true, d);
    if (id < 0) throw new Error(`belt refused at ${x},${z}`);
    return id;
  });
}

// On map 1 (the sandbox), clear of the core and the deposits:
//   right turn  east along z = 70 (x 50–53), the corner (54,70) turns south, then (54,71), (54,72)
//   left turn   east along z = 80 (x 50–53), the corner (54,80) turns north, then (54,79), (54,78)
//   join        a line east along z = 85 (x 50–56); a line south down x = 53 (z 82–84) runs into (53,85)
const RIGHT: Array<[number, number, number]> = [[50, 70, 0], [51, 70, 0], [52, 70, 0], [53, 70, 0], [54, 70, 1], [54, 71, 1], [54, 72, 1]];
const LEFT: Array<[number, number, number]> = [[50, 80, 0], [51, 80, 0], [52, 80, 0], [53, 80, 0], [54, 80, 3], [54, 79, 3], [54, 78, 3]];
const MAIN: Array<[number, number, number]> = [[50, 85, 0], [51, 85, 0], [52, 85, 0], [53, 85, 0], [54, 85, 0], [55, 85, 0], [56, 85, 0]];
const SIDE: Array<[number, number, number]> = [[53, 82, 1], [53, 83, 1], [53, 84, 1]];

function layout(): { w: World; ids: Record<string, number[]> } {
  const w = createWorld(1, 'sandbox');
  return { w, ids: { right: lay(w, RIGHT), left: lay(w, LEFT), main: lay(w, MAIN), side: lay(w, SIDE) } };
}

const tileOf = (x: number, z: number) => z * terrain.w + x;

describe('W29b belt shapes from the snapshot', () => {
  it('a belt fed only from one side is a corner (right and left turns); fed from behind and a side, a join; otherwise straight', async () => {
    const { BeltShapes, BELT_STRAIGHT, BELT_CORNER_R, BELT_CORNER_L, BELT_JOIN_L, BELT_JOIN_R } = await shapesModule();
    const { w } = layout();
    const s = new BeltShapes(terrain.w, terrain.h);
    s.update(snapshotOf(w));
    expect(s.shapeAt(tileOf(54, 70)), 'right turn').toBe(BELT_CORNER_R);
    expect(s.shapeAt(tileOf(54, 80)), 'left turn').toBe(BELT_CORNER_L);
    expect(s.shapeAt(tileOf(53, 85)), 'join from the left').toBe(BELT_JOIN_L);
    for (const [x, z] of [[52, 70], [54, 71], [53, 80], [54, 79], [52, 85], [54, 85], [53, 83]]) expect(s.shapeAt(tileOf(x!, z!)), `${x},${z}`).toBe(BELT_STRAIGHT);
    // the mirror image of the join: a line running north into the main line from the south
    lay(w, [[55, 88, 3], [55, 87, 3], [55, 86, 3]]);
    s.update(snapshotOf(w));
    expect(s.shapeAt(tileOf(55, 85)), 'join from the right').toBe(BELT_JOIN_R);
  });

  it('a splitter feeds only its left and right (conveyor.ts): a belt in front of it, fed from a side, is a corner', async () => {
    const { BeltShapes, BELT_CORNER_R } = await shapesModule();
    const w = createWorld(1, 'sandbox');
    // into the splitter (61,70) from behind; it faces south, so it puts out west and east, never south
    lay(w, [[60, 70, 0]]);
    expect(w.placeBuilding(B.splitter, 61, 70, true, 1)).toBeGreaterThanOrEqual(0);
    // (61,71) faces south with its back to the splitter's front; (60,71) runs east into its right-hand side
    lay(w, [[61, 71, 1], [60, 71, 0]]);
    const s = new BeltShapes(terrain.w, terrain.h);
    s.update(snapshotOf(w));
    expect(s.shapeAt(tileOf(61, 71))).toBe(BELT_CORNER_R);
  });

  it('splitters and mergers keep their own shape', async () => {
    const { BeltShapes, BELT_STRAIGHT } = await shapesModule();
    const w = createWorld(1, 'sandbox');
    lay(w, [[50, 70, 0], [51, 70, 0]]);
    expect(w.placeBuilding(B.merger, 52, 70, true, 1)).toBeGreaterThanOrEqual(0);
    lay(w, [[60, 70, 0]]);
    expect(w.placeBuilding(B.splitter, 61, 70, true, 1)).toBeGreaterThanOrEqual(0);
    const s = new BeltShapes(terrain.w, terrain.h);
    s.update(snapshotOf(w));
    expect(s.shapeAt(tileOf(52, 70))).toBe(BELT_STRAIGHT);
    expect(s.shapeAt(tileOf(61, 70))).toBe(BELT_STRAIGHT);
  });

  it('the shapes are worked out again only when the belts change', async () => {
    const { BeltShapes } = await shapesModule();
    const { w } = layout();
    const s = new BeltShapes(terrain.w, terrain.h);
    expect(s.update(snapshotOf(w))).toBe(true);
    w.step();
    expect(s.update(snapshotOf(w)), 'a tick with the same belts').toBe(false);
    w.removeBuilding(w.buildings.slotForId(layout().ids.right![3]!));
    expect(s.update(snapshotOf(w)), 'a belt removed').toBe(true);
  });
});

describe('W29b corner and join models', () => {
  const surfaceBox = (name: string, make: typeof BUILDING_MAKERS.belt) => {
    const baked = bakeModel(make(standInMaterials().w17));
    const piece = baked.pieces.find((p) => p.material.name === 'belt-cut');
    if (!piece) throw new Error(`${name}: no belt surface piece`);
    return new Box3().setFromBufferAttribute(piece.geometry.getAttribute('position') as never);
  };

  it('a corner piece sweeps the belt surface from the side edge round to the front edge; the straight piece runs back to front', async () => {
    const makers = await beltShapeMakers();
    expect(makers).toBeDefined();
    const straight = surfaceBox('belt', BUILDING_MAKERS.belt);
    expect(straight.min.x).toBeCloseTo(-0.5, 2);
    expect(straight.max.x).toBeCloseTo(0.5, 2);
    // right turn: fed from the model's +z side (the right of the flow), out along +x
    const r = surfaceBox('beltCornerR', makers!.beltCornerR!);
    expect(r.max.z).toBeCloseTo(0.5, 2);
    expect(r.max.x).toBeCloseTo(0.5, 2);
    expect(r.min.x).toBeGreaterThan(-0.4);
    const l = surfaceBox('beltCornerL', makers!.beltCornerL!);
    expect(l.min.z).toBeCloseTo(-0.5, 2);
    expect(l.max.x).toBeCloseTo(0.5, 2);
    expect(l.min.x).toBeGreaterThan(-0.4);
    // a join: the straight run plus the side lane reaching the side edge
    const j = surfaceBox('beltJoinL', makers!.beltJoinL!);
    expect(j.min.x).toBeCloseTo(-0.5, 2);
    expect(j.max.x).toBeCloseTo(0.5, 2);
    expect(j.min.z).toBeCloseTo(-0.5, 2);
  });

  it('the renderer draws the corner tiles with the corner models, the join with the join model, the rest straight', () => {
    const { r, scene } = renderer();
    const { w } = layout();
    draw(r, snapshotOf(w), { level: 0 });
    const at = (x: number, z: number) => {
      const out = new Set<string>();
      for (const d of drawnMeshes(scene)) {
        if (!d.name.startsWith('w17/belt')) continue;
        for (let i = 0; i < d.count; i++) if (Math.abs(d.worlds[i * 16 + 12]! - (x + 0.5)) < 0.05 && Math.abs(d.worlds[i * 16 + 14]! - (z + 0.5)) < 0.05) out.add(d.name.split('/')[1]!);
      }
      return [...out];
    };
    expect(at(54, 70)).toEqual(['beltCornerR']);
    expect(at(54, 80)).toEqual(['beltCornerL']);
    expect(at(53, 85)).toEqual(['beltJoinL']);
    expect(at(52, 70)).toEqual(['belt']);
    expect(at(54, 71)).toEqual(['belt']);
  });
});

describe('W29b belt items on the belt', () => {
  const sizes = () => itemGeometries().map((g) => new Box3().setFromBufferAttribute(g.getAttribute('position') as never));

  it('mass and rare items are big enough to read: the ingot at least 0.4 tiles long, the crystal at least 0.4 tiles tall', () => {
    const b = sizes();
    const mass = b[ITEM_MASS]!.getSize(new Vector3());
    const rare = b[ITEM_RARE]!.getSize(new Vector3());
    expect(Math.max(mass.x, mass.z)).toBeGreaterThanOrEqual(0.4);
    expect(rare.y).toBeGreaterThanOrEqual(0.4);
    // and they still fit between the rails (inner width 0.62)
    for (const k of [1, 2, 3, 4, ITEM_MASS, ITEM_RARE]) expect(Math.min(b[k]!.getSize(new Vector3()).x, b[k]!.getSize(new Vector3()).z), `item ${k}`).toBeLessThanOrEqual(0.6);
  });

  /** World boxes of the drawn items of kind `item` (instance matrix × geometry box). */
  function drawnBoxes(w: World, item: number, at = { x: 54, z: 72 }): Box3[] {
    const sc = new Scene();
    const snap = snapshotOf(w);
    const belts = new BeltShapes(terrain.w, terrain.h);
    belts.update(snap); // view.ts: the models' instance, updated before the overlays
    const e = new EntityRenderer(sc, terrain, CAPACITY, belts);
    e.update({ camera: camera({ x: at.x, z: at.z, distance: 14, yaw: 0 }), viewportHeight: 900, yaw: 0, snapshot: snap, aliens: mobile(snap.aliens), units: mobile(snap.units), projectiles: mobile(snap.projectiles), selection: [] });
    const out: Box3[] = [];
    sc.traverse((o) => {
      if (!(o instanceof InstancedMesh) || o.name !== `overlay/item/${item}` || !o.visible) return;
      const g = o.geometry as BufferGeometry;
      g.computeBoundingBox();
      const m = new Matrix4();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        out.push(g.boundingBox!.clone().applyMatrix4(m));
      }
    });
    return out;
  }

  it('items sit on the belt surface: the bottom on it, the top well above it, on straight and corner tiles', async () => {
    const surface = await beltSurface();
    expect(typeof surface, 'BELT_SURFACE_Y exported by the belt model').toBe('number');
    expect(surface).toBeGreaterThan(0.2);
    const { w, ids } = layout();
    const c = w.buildings.cols;
    for (const [id, item] of [[ids.right![1]!, ITEM_MASS], [ids.right![4]!, ITEM_RARE]] as const) {
      c.item[slot(w, id)] = item;
      c.itemPos[slot(w, id)] = 0.5;
    }
    for (const [item, x, z] of [[ITEM_MASS, 51, 70], [ITEM_RARE, 54, 70]] as const) {
      const boxes = drawnBoxes(w, item);
      expect(boxes.length, `item ${item} drawn`).toBe(1);
      const bx = boxes[0]!;
      const base = groundTop(x, z) + surface!;
      expect(bx.min.y, `item ${item} bottom on the surface`).toBeGreaterThanOrEqual(base - 0.02);
      expect(bx.min.y, `item ${item} bottom not floating`).toBeLessThanOrEqual(base + 0.05);
      expect(bx.max.y, `item ${item} top above the surface`).toBeGreaterThan(base + 0.15);
    }
  });

  it('on a corner tile an item follows the curve (half way: on the arc round the inner corner, not the straight centre line)', () => {
    const { w, ids } = layout();
    const c = w.buildings.cols;
    c.item[slot(w, ids.right![4]!)] = ITEM_MASS;
    c.itemPos[slot(w, ids.right![4]!)] = 0.5;
    const [b] = drawnBoxes(w, ITEM_MASS);
    const centre = b!.getCenter(new Vector3());
    // the corner (54,70) takes from the west edge (54.0, 70.5) and gives at the south edge (54.5, 71.0):
    // the arc's centre is the south-west corner (54, 71), radius 0.5; half way is 45° round it
    expect(centre.x).toBeCloseTo(54 + 0.5 * Math.SQRT1_2, 1);
    expect(centre.z).toBeCloseTo(71 - 0.5 * Math.SQRT1_2, 1);
  });

  // Codex adversarial review (W29): a building that puts items on a belt (conveyor.ts output():
  // an extractor with belts on, a depot, a machine) feeds the perimeter belt whose back faces it,
  // so the shapes count it. Map 1's mass deposit at (54,50): the extractor covers 54–55 × 50–51.
  //   (56,50) runs east with its back to the extractor; (56,49) runs south into its left side
  function extractorLayout(): { w: World; ext: number; belt: number } {
    const w = createWorld(1, 'sandbox');
    const ext = w.placeBuilding(B.massExtractor, 54, 50, true);
    expect(ext).toBeGreaterThanOrEqual(0);
    const [belt] = lay(w, [[56, 50, 0], [57, 50, 0], [56, 49, 1]]);
    return { w, ext, belt: belt! };
  }

  it('a belt fed from behind by an extractor and from a side by a belt is a join, not a corner', async () => {
    const { BeltShapes, BELT_JOIN_L } = await shapesModule();
    const { w } = extractorLayout();
    const s = new BeltShapes(terrain.w, terrain.h);
    s.update(snapshotOf(w));
    expect(s.shapeAt(tileOf(56, 50))).toBe(BELT_JOIN_L);
  });

  it('an item the extractor puts on the belt is drawn entering from the extractor\'s side (the west edge), not the feeder\'s', () => {
    const { w, ext, belt } = extractorLayout();
    w.buildings.cols.stock[slot(w, ext)] = 1;
    for (let t = 0; t < 5 && w.buildings.cols.item[slot(w, belt)] === 0; t++) w.step();
    const c = w.buildings.cols;
    expect(c.item[slot(w, belt)], 'the extractor put an item on (56,50)').toBe(ITEM_MASS);
    c.itemPos[slot(w, belt)] = 0;
    const [b] = drawnBoxes(w, ITEM_MASS, { x: 56, z: 50 });
    const centre = b!.getCenter(new Vector3());
    expect(centre.x, 'on the west edge').toBeCloseTo(56, 1);
    expect(centre.z, 'on the centre line').toBeCloseTo(50.5, 1);
  });
});

/** The top of a 1 × 1 footprint at tile (x, z): what the belt model stands on. */
function groundTop(x: number, z: number): number {
  return footprintRange(terrain, x, z, 1, 1).top;
}
