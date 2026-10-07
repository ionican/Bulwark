// The turret as a three.js hierarchy of pivots, at three detail levels, posed from the fire
// control each frame.
//
//   root ─┬─ base (static) + bolts
//         ├─ pinionPivot ── pinion            spins −yaw × 56/12
//         └─ yawPivot ─┬─ ring + head          rotation.y = yaw
//                      └─ cradlePivot ─┬─ cradle        rotation.z = pitch, at the trunnion
//                                      └─ slide ── barrel  position.x = −recoil
//
// Levels follow the game's strategic zoom (game/src/render/geometry.ts, lod.ts): full = the
// code-built model; simple = a few primitives with the same silhouette and the same pivots, so it
// still aims; icon = a flat 2D symbol (dark outline plate, pale fill: round body and a barrel bar),
// drawn on top of everything at a constant screen size, turned to the aim.

import {
  AxesHelper,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Shape,
  ShapeGeometry,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cbox, cyl, prism, tubeX } from '../models/kit.ts';
import { TB, boltMatrix, type BoltSpec } from './geo.ts';
import type { TurretMats } from './surface.ts';
import { boltGeometry, triangleCount, type BuiltPart, type TurretModel } from './turretModel.ts';

export type Lod = 'full' | 'simple' | 'icon';

interface Pivots {
  group: Group;
  yaw: Group;
  cradle: Group;
  slide: Group;
  pinion: Group | null;
  meshes: Mesh[];
  triangles: number;
}

function partMesh(p: BuiltPart, mats: TurretMats, boltGeo: BufferGeometry, into: Object3D, meshes: Mesh[]): number {
  const m = new Mesh(p.geometry, p.material);
  m.name = p.name;
  m.castShadow = true;
  m.receiveShadow = true;
  into.add(m);
  meshes.push(m);
  let tris = triangleCount(p.geometry);
  const byKey = new Map<BoltSpec['key'], BoltSpec[]>();
  for (const b of p.bolts) byKey.set(b.key, [...(byKey.get(b.key) ?? []), b]);
  for (const [key, list] of byKey) {
    const im = new InstancedMesh(boltGeo, key === 'dark' ? mats.dark : mats[key], list.length);
    list.forEach((b, i) => im.setMatrixAt(i, boltMatrix(b)));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.name = `${p.name}/bolts-${key}`;
    im.castShadow = true;
    im.receiveShadow = true;
    into.add(im);
    meshes.push(im);
    tris += triangleCount(boltGeo) * list.length;
  }
  return tris;
}

function fullLevel(model: TurretModel, mats: TurretMats): Pivots {
  const boltGeo = boltGeometry();
  const group = new Group();
  group.name = 'turret-full';
  const meshes: Mesh[] = [];
  let tris = partMesh(model.base, mats, boltGeo, group, meshes);
  const pinion = new Group();
  pinion.name = 'pinionPivot';
  pinion.position.set(...model.pinionAt);
  group.add(pinion);
  tris += partMesh(model.pinion, mats, boltGeo, pinion, meshes);
  const yaw = new Group();
  yaw.name = 'yawPivot';
  group.add(yaw);
  tris += partMesh(model.ring, mats, boltGeo, yaw, meshes);
  tris += partMesh(model.head, mats, boltGeo, yaw, meshes);
  const cradle = new Group();
  cradle.name = 'cradlePivot';
  cradle.position.set(0, model.trunnionY, 0);
  yaw.add(cradle);
  tris += partMesh(model.cradle, mats, boltGeo, cradle, meshes);
  const slide = new Group();
  slide.name = 'recoilSlide';
  cradle.add(slide);
  tris += partMesh(model.barrel, mats, boltGeo, slide, meshes);
  return { group, yaw, cradle, slide, pinion, meshes, triangles: tris };
}

function simpleLevel(model: TurretModel, mats: TurretMats): Pivots {
  const group = new Group();
  group.name = 'turret-simple';
  const meshes: Mesh[] = [];
  const mk = (b: TB, into: Object3D) => {
    const { geometry, material } = b.build(mats);
    const m = new Mesh(geometry, material);
    m.castShadow = m.receiveShadow = true;
    into.add(m);
    meshes.push(m);
    return triangleCount(geometry);
  };
  const base = new TB();
  base.add('gunmetal', prism(8, 1.0, 0.08, 0), {}, 'none');
  base.add('ceramic', prism(8, 0.9, 0.36, 0), { y: 0.08 }, 'none');
  base.add('gunmetal', cyl(0.62, 0.62, 0.14, 12), { y: 0.44 }, 'none');
  const yaw = new Group();
  const head = new TB();
  head.add('ceramic', cbox(0.9, 0.6, 1.0, 0, 0), { x: -0.12, y: 0.58 }, 'none');
  const cradle = new Group();
  cradle.position.set(0, model.trunnionY, 0);
  const slide = new Group();
  const barrel = new TB();
  barrel.add('gunmetal', tubeX(0.1, 0.6, 8), { x: 0 }, 'none');
  barrel.add('ceramic', tubeX(0.07, 0.6, 8), { x: 0.6 }, 'none');
  barrel.add('gunmetal', tubeX(0.1, 0.3, 8), { x: 1.19 }, 'none');
  let tris = mk(base, group);
  group.add(yaw);
  tris += mk(head, yaw);
  yaw.add(cradle);
  cradle.add(slide);
  tris += mk(barrel, slide);
  return { group, yaw, cradle, slide, pinion: null, meshes, triangles: tris };
}

/** The game's gun icon: round body offset back, barrel bar forward (icon +y = turret +X). */
function iconGeometry(): BufferGeometry {
  const circle = (r: number, cx: number, cy: number, n = 20) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * Math.PI * 2), cy + r * Math.sin((i / n) * Math.PI * 2)] as [number, number]);
  const rect = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const grow = (pts: Array<[number, number]>, d: number) => {
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return pts.map(([x, y]) => {
      const l = Math.hypot(x - cx, y - cy) || 1;
      return [x + ((x - cx) / l) * d, y + ((y - cy) / l) * d] as [number, number];
    });
  };
  const shape = (pts: Array<[number, number]>) => {
    const s = new Shape();
    pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
    s.closePath();
    return s;
  };
  const body = circle(0.65, 0, -0.25, 16);
  const bar = rect(-0.14, 0.2, 0.14, 1);
  const parts: BufferGeometry[] = [];
  const add = (pts: Array<[number, number]>, y: number, hex: string) => {
    const g = new ShapeGeometry(shape(pts)).toNonIndexed();
    // icon (x, y) → turret (x = y, z = x), lying on the ground plane
    const p = g.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const ix = p.getX(i);
      const iy = p.getY(i);
      p.setXYZ(i, iy, y, ix);
    }
    const c = new Color(hex);
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new BufferAttribute(col, 3));
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    parts.push(g);
  };
  add(grow(body, 0.16), 0, '#120f0d');
  add(grow(bar, 0.16), 0, '#120f0d');
  add(body, 0.01, '#ece6da');
  add(bar, 0.02, '#ece6da');
  return mergeGeometries(parts, false)!;
}

export class TurretRig {
  readonly root = new Group();
  readonly levels: Record<Exclude<Lod, 'icon'>, Pivots>;
  readonly icon: Mesh;
  readonly model: TurretModel;
  lod: Lod = 'full';
  /** Icon size: screen-constant (game) or fixed world radius (LOD line-up). */
  iconFixed = false;
  private helpers: AxesHelper[] = [];
  private wireMats = new Map<Material, MeshBasicMaterial>();
  private solidMats = new Map<Mesh, Material | Material[]>();

  constructor(model: TurretModel, mats: TurretMats, readonly only?: Lod) {
    this.model = model;
    this.levels = { full: fullLevel(model, mats), simple: simpleLevel(model, mats) };
    this.root.add(this.levels.full.group, this.levels.simple.group);
    const iconMat = new MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, side: DoubleSide, fog: false, toneMapped: false });
    this.icon = new Mesh(iconGeometry(), iconMat);
    this.icon.renderOrder = 20;
    this.icon.frustumCulled = false;
    this.root.add(this.icon);
    this.setLod(only ?? 'full');
  }

  get triangles(): Record<Lod, number> {
    return { full: this.levels.full.triangles, simple: this.levels.simple.triangles, icon: triangleCount(this.icon.geometry) };
  }

  setLod(l: Lod): void {
    this.lod = l;
    this.levels.full.group.visible = l === 'full';
    this.levels.simple.group.visible = l === 'simple';
    this.icon.visible = l === 'icon';
  }

  /** Yaw, pitch (rad) and recoil offset (tiles) for every level. */
  setPose(yaw: number, pitch: number, recoil: number): void {
    for (const p of Object.values(this.levels)) {
      p.yaw.rotation.y = yaw;
      p.cradle.rotation.z = pitch;
      p.slide.position.x = -recoil;
      if (p.pinion) p.pinion.rotation.y = -yaw * this.model.pinionRatio;
    }
    this.icon.rotation.y = yaw;
  }

  /** Keeps the icon a constant size on screen (game rule: max(footprint, 9 px)). */
  updateIcon(worldPerPixelAtTurret: number): void {
    const s = this.iconFixed ? 1 : Math.max(1, 9 * worldPerPixelAtTurret);
    this.icon.scale.setScalar(s);
    this.icon.position.y = 0.4;
  }

  /**
   * Wireframe view. The lit materials cannot simply be switched to wireframe: their normal maps
   * build a tangent frame from screen-space derivatives, which are degenerate on lines and give
   * NaN that the bloom then spreads over the whole frame. So each mesh swaps to an unlit
   * wireframe material in its material's base colour.
   */
  setWireframe(on: boolean): void {
    const tint: Record<string, string> = { ceramic: '#efe4cc', gunmetal: '#8c94a0', bronze: '#d4925a', dark: '#4a4a4a', glow: '#5ff0ff', brass: '#e8c070' };
    const wire = (m: Material) => {
      let w = this.wireMats.get(m);
      if (!w) {
        w = new MeshBasicMaterial({ color: tint[m.name] ?? '#cccccc', wireframe: true, fog: false });
        this.wireMats.set(m, w);
      }
      return w;
    };
    for (const p of Object.values(this.levels))
      for (const mesh of p.meshes) {
        if (on) {
          if (!this.solidMats.has(mesh)) this.solidMats.set(mesh, mesh.material);
          const orig = this.solidMats.get(mesh)!;
          mesh.material = Array.isArray(orig) ? orig.map(wire) : wire(orig);
        } else if (this.solidMats.has(mesh)) mesh.material = this.solidMats.get(mesh)!;
      }
  }

  setPivots(on: boolean): void {
    if (on && this.helpers.length === 0) {
      const f = this.levels.full;
      const s = this.levels.simple;
      for (const g of [f.yaw, f.cradle, f.slide, f.pinion!, s.yaw, s.cradle, s.slide]) {
        const h = new AxesHelper(g === f.slide || g === s.slide ? 0.45 : 0.75);
        (h.material as Material).depthTest = false;
        h.renderOrder = 30;
        g.add(h);
        this.helpers.push(h);
      }
    }
    for (const h of this.helpers) h.visible = on;
  }

  /** World position of a point in barrel space (cradle frame, recoil included). */
  barrelPoint(local: [number, number, number], out: Vector3): Vector3 {
    const lvl = this.lod === 'simple' ? this.levels.simple : this.levels.full;
    lvl.slide.updateWorldMatrix(true, false);
    return out.set(...local).applyMatrix4(lvl.slide.matrixWorld);
  }

  /** World direction of a barrel-space vector. */
  barrelDir(local: [number, number, number], out: Vector3): Vector3 {
    const lvl = this.lod === 'simple' ? this.levels.simple : this.levels.full;
    lvl.slide.updateWorldMatrix(true, false);
    return out.set(...local).transformDirection(lvl.slide.matrixWorld);
  }

  muzzleWorld(out: Vector3): Vector3 {
    return this.barrelPoint(this.model.muzzle, out);
  }

  get fullMeshes(): Mesh[] {
    return this.levels.full.meshes;
  }

  get pivotGroups(): { yaw: Group; cradle: Group; slide: Group } {
    return this.levels.full;
  }
}

