// W24 run 2a, criteria 3 and 4: one ground. The sampler equals the drawn mesh's own triangles
// (interpolated here from the geometry's index and position buffers, not from the sampler's
// formula); screen-ray picks land on the mesh; feet, alien bases and building bases sit on the
// sampled surface; the scenery shares the map's edge vertices; plinths reach the lowest ground.

import { describe, expect, it } from 'vitest';
import { InstancedMesh, Mesh, MeshBasicMaterial, Raycaster, Vector2, type BufferAttribute } from 'three';
import { B } from '../src/sim/kinds.ts';
import { TILE_GROUND, TILE_ROCK } from '../src/sim/terrain.ts';
import { footprintRange, groundHeight } from '../src/render/ground.ts';
import { SCENERY_RINGS, buildGroundGeometry } from '../src/render/groundView.ts';
import { screenToGround } from '../src/render/picking.ts';
import { ENGINEER_LEGS, COMMANDER_LEGS } from '../src/render/workshop/w23/rig/specs.ts';
import { Rand } from '../src/render/workshop/noise.ts';
import { camera, draw, everyKind, renderer, rowOf, snapshotOf, terrain } from './w24r2a-fixtures.ts';

const geo = buildGroundGeometry(terrain);
const pos = geo.geometry.getAttribute('position') as BufferAttribute;
const idx = geo.geometry.getIndex()!;

// map triangles bucketed by the tile their centroid is in (from the buffers, not the sampler)
const buckets = new Map<number, number[]>();
for (let t = 0; t < geo.mapIndices / 3; t++) {
  let cx = 0;
  let cz = 0;
  for (let k = 0; k < 3; k++) {
    const v = idx.getX(t * 3 + k);
    cx += pos.getX(v) / 3;
    cz += pos.getZ(v) / 3;
  }
  const key = Math.floor(cz) * terrain.w + Math.floor(cx);
  const l = buckets.get(key) ?? [];
  l.push(t);
  buckets.set(key, l);
}

/** Height of the mesh at (x, z): barycentric interpolation inside the map triangle containing it. */
function meshHeight(x: number, z: number): number {
  for (const dz of [0, -1, 1])
    for (const dx of [0, -1, 1]) {
      const list = buckets.get((Math.floor(z) + dz) * terrain.w + Math.floor(x) + dx) ?? [];
      for (const t of list) {
        const v = [0, 1, 2].map((k) => idx.getX(t * 3 + k));
        const [ax, az, ay] = [pos.getX(v[0]!), pos.getZ(v[0]!), pos.getY(v[0]!)];
        const [bx, bz, by] = [pos.getX(v[1]!), pos.getZ(v[1]!), pos.getY(v[1]!)];
        const [cx, cz, cy] = [pos.getX(v[2]!), pos.getZ(v[2]!), pos.getY(v[2]!)];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
        const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return l1 * ay + l2 * by + l3 * cy;
      }
    }
  throw new Error(`no triangle under ${x}, ${z}`);
}

describe('criterion 3: one ground', () => {
  it('2,000+ points inside the map, every rock/ground boundary included: sampler = mesh triangles within 1e-4', () => {
    const rnd = new Rand(24);
    const pts: Array<[number, number]> = [];
    // a point on every edge between a rock tile and a non-rock tile, at a random place along it
    for (let z = 0; z < terrain.h; z++)
      for (let x = 0; x < terrain.w; x++) {
        const rock = terrain.tiles[z * terrain.w + x] === TILE_ROCK;
        if (x + 1 < terrain.w && rock !== (terrain.tiles[z * terrain.w + x + 1] === TILE_ROCK)) pts.push([x + 1, z + rnd.next()]);
        if (z + 1 < terrain.h && rock !== (terrain.tiles[(z + 1) * terrain.w + x] === TILE_ROCK)) pts.push([x + rnd.next(), z + 1]);
      }
    const boundary = pts.length;
    expect(boundary).toBeGreaterThan(200);
    while (pts.length < Math.max(2000, boundary + 1000)) pts.push([rnd.range(0, terrain.w), rnd.range(0, terrain.h)]);
    let worst = 0;
    for (const [x, z] of pts) worst = Math.max(worst, Math.abs(groundHeight(terrain, x, z) - meshHeight(x, z)));
    expect(worst).toBeLessThan(1e-4);
  });

  it('screen-ray picks at 200 screen points land within 0.01 tiles of the mesh surface (three.js raycast)', () => {
    const mesh = new Mesh(geo.geometry, new MeshBasicMaterial());
    mesh.updateMatrixWorld();
    const ray = new Raycaster();
    const rnd = new Rand(7);
    const rigs = [
      { x: 64, z: 62, distance: 50, yaw: 0 },
      { x: 40, z: 90, distance: 22, yaw: 0.7 },
      { x: 90, z: 40, distance: 95, yaw: -1.2 },
    ];
    let n = 0;
    let worst = 0;
    for (let i = 0; n < 200 && i < 2000; i++) {
      const cam = camera(rigs[i % rigs.length]!);
      const sx = rnd.range(0, 1440);
      const sy = rnd.range(0, 900);
      const pick = screenToGround(cam, sx, sy, 1440, 900, terrain);
      if (!pick || pick.x < 0.5 || pick.z < 0.5 || pick.x > terrain.w - 0.5 || pick.z > terrain.h - 0.5) continue;
      ray.setFromCamera(new Vector2((sx / 1440) * 2 - 1, -(sy / 900) * 2 + 1), cam);
      const hit = ray.intersectObject(mesh, false)[0];
      expect(hit).toBeDefined();
      const d = Math.hypot(hit!.point.x - pick.x, hit!.point.y - pick.y, hit!.point.z - pick.z);
      worst = Math.max(worst, d);
      expect(Math.abs(pick.y - groundHeight(terrain, pick.x, pick.z))).toBeLessThan(1e-6);
      n++;
    }
    expect(n).toBe(200);
    expect(worst).toBeLessThan(0.01);
  });

  it('feet, alien bases and building bases sit on the sampled surface (read from the drawn batches)', () => {
    const { r } = renderer();
    const f = everyKind();
    draw(r, f.snap, { level: 0 });
    // engineer and commander soles: rig feet, and the boot instances' ankles above them
    for (const id of [f.units.engineer, f.units.commander]) {
      const rig = r.rigOf(id)!;
      expect(rig).not.toBeNull();
      for (const foot of rig.legs.feet) expect(Math.abs(foot.pos.y - groundHeight(terrain, foot.pos.x, foot.pos.z))).toBeLessThan(1e-6);
    }
    const ankle = { 'eng/boot': ENGINEER_LEGS.leg.ankle, 'cmd/foot': COMMANDER_LEGS.leg.ankle } as Record<string, number>;
    let boots = 0;
    r.group.traverse((o) => {
      if (!(o instanceof InstancedMesh) || !o.visible || o.count === 0) return;
      const part = o.userData.part as string | undefined;
      if (!part || !(part in ankle) || o.userData.level !== 0 || !o.name.endsWith('gunmetal')) return;
      const a = o.instanceMatrix.array as Float32Array;
      for (let i = 0; i < o.count; i++) {
        const x = a[i * 16 + 12]!;
        const z = a[i * 16 + 14]!;
        expect(Math.abs(a[i * 16 + 13]! - ankle[part]! - groundHeight(terrain, x, z)), `${part} ${i}`).toBeLessThan(0.02);
        boots++;
      }
    });
    expect(boots).toBeGreaterThanOrEqual(4);
    // aliens: the model's origin on the ground at its position
    r.group.traverse((o) => {
      if (!(o instanceof InstancedMesh) || !o.visible || !o.name.startsWith('w17/') || !['rusher', 'hunter', 'breaker', 'saboteur'].includes(o.userData.model)) return;
      const a = o.instanceMatrix.array as Float32Array;
      for (let i = 0; i < o.count; i++) expect(Math.abs(a[i * 16 + 13]! - groundHeight(terrain, a[i * 16 + 12]!, a[i * 16 + 14]!))).toBeLessThan(1e-5);
    });
    // W17 buildings: origin at the footprint centre, at the highest sampled ground under it
    const s = f.snap;
    for (const k of ['generator', 'lab', 'depot', 'shredder', 'smelter', 'assembler', 'shield'] as const) {
      const row = rowOf(s, f.ids[k]!);
      const c = s.buildings.cols;
      const [tx, ty, fw, fh] = [c.tx[row]!, c.ty[row]!, c.fw[row]!, c.fh[row]!];
      let hi = -Infinity;
      for (let j = 0; j <= fh * 8; j++) for (let i = 0; i <= fw * 8; i++) hi = Math.max(hi, groundHeight(terrain, tx + i / 8, ty + j / 8));
      let found = 0;
      r.group.traverse((o) => {
        if (!(o instanceof InstancedMesh) || !o.visible || o.userData.model !== k) return;
        const a = o.instanceMatrix.array as Float32Array;
        for (let i = 0; i < o.count; i++) {
          if (Math.abs(a[i * 16 + 12]! - (tx + fw / 2)) > 1e-5 || Math.abs(a[i * 16 + 14]! - (ty + fh / 2)) > 1e-5) continue;
          expect(a[i * 16 + 13]).toBeCloseTo(hi, 5);
          found++;
        }
      });
      expect(found, k).toBeGreaterThan(0);
    }
  });
});

describe('criterion 4: edges and foundations', () => {
  it('the scenery shares the map edge vertices: no gap or crack, edge heights equal', () => {
    const s = terrain.w + 1;
    const edge = new Set(geo.edge);
    expect(geo.edge.length).toBe(4 * terrain.w);
    // every perimeter vertex of the map grid is a ring-0 vertex, at its map height
    for (let z = 0; z <= terrain.h; z++)
      for (let x = 0; x <= terrain.w; x++) {
        if (x !== 0 && z !== 0 && x !== terrain.w && z !== terrain.h) continue;
        expect(edge.has(z * s + x)).toBe(true);
        expect(pos.getY(z * s + x)).toBe(terrain.heights[z * s + x]);
        expect(pos.getY(z * s + x)).toBeCloseTo(groundHeight(terrain, x, z), 6);
      }
    // every segment of the perimeter is an edge of a scenery triangle (the seam is closed)
    const segs = new Set<string>();
    const rings = SCENERY_RINGS.length - 1;
    for (let t = geo.mapIndices / 3; t < idx.count / 3; t++) {
      const v = [0, 1, 2].map((k) => idx.getX(t * 3 + k));
      for (let k = 0; k < 3; k++) {
        const a = v[k]!;
        const b = v[(k + 1) % 3]!;
        if (edge.has(a) && edge.has(b)) segs.add(a < b ? `${a}-${b}` : `${b}-${a}`);
      }
    }
    expect(segs.size).toBe(geo.edge.length);
    expect(pos.count).toBe(geo.mapVertices + rings * geo.edge.length);
  });

  it('a 4 × 4 building on the steepest buildable slope: plinth from its base down to the lowest ground under it', () => {
    // steepest 4 × 4 footprint of plain ground tiles on map 1
    let best = { tx: 0, ty: 0, drop: -1 };
    for (let ty = 0; ty + 4 <= terrain.h; ty++)
      for (let tx = 0; tx + 4 <= terrain.w; tx++) {
        let ok = true;
        for (let j = 0; j < 4 && ok; j++) for (let i = 0; i < 4 && ok; i++) ok = terrain.tiles[(ty + j) * terrain.w + tx + i] === TILE_GROUND;
        if (!ok) continue;
        const { top, bottom } = footprintRange(terrain, tx, ty, 4, 4);
        if (top - bottom > best.drop) best = { tx, ty, drop: top - bottom };
      }
    expect(best.drop).toBeGreaterThan(0.5);
    const f = everyKind();
    const id = f.world.placeBuilding(B.generator, best.tx, best.ty, true);
    expect(id).toBeGreaterThanOrEqual(0);
    const s = snapshotOf(f.world);
    const row = rowOf(s, id);
    s.buildings.cols.fw[row] = 4;
    s.buildings.cols.fh[row] = 4;
    const { r } = renderer();
    draw(r, s, { level: 0 });
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j <= 32; j++)
      for (let i = 0; i <= 32; i++) {
        const h = groundHeight(terrain, best.tx + i / 8, best.ty + j / 8);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    let plinths = 0;
    r.group.traverse((o) => {
      if (!(o instanceof InstancedMesh) || o.name !== 'plinth') return;
      const a = o.instanceMatrix.array as Float32Array;
      for (let i = 0; i < o.count; i++) {
        if (Math.abs(a[i * 16 + 12]! - (best.tx + 2)) > 1e-5 || Math.abs(a[i * 16 + 14]! - (best.ty + 2)) > 1e-5) continue;
        plinths++;
        // unit box from y = 0 down to y = −1, scaled by the matrix: top and bottom in world
        const top = a[i * 16 + 13]!;
        const bottom = top - a[i * 16 + 5]!;
        expect(a[i * 16]).toBeCloseTo(4, 6);
        expect(a[i * 16 + 10]).toBeCloseTo(4, 6);
        expect(top).toBeGreaterThanOrEqual(hi);
        expect(bottom).toBeLessThanOrEqual(lo);
      }
    });
    expect(plinths).toBe(1);
  });
});
