// glTF model source (W18). Loads a generated GLB (GLTFLoader + meshopt decoder), flattens every
// mesh into a ModelDef part and fits it to the W17 model frame: +Y up, barrel along +X, origin at
// the ground centre of the footprint, footprint width equal to the code-built model's.
//
// The image-to-3D models emit one fused mesh, so the turret head cannot turn on its own: the
// first part carries motion 'aim' and every other part follows it, which means the whole model,
// base included, rotates to aim.

import { Box3, BufferAttribute, BufferGeometry, Matrix4, Mesh, Vector3, type Material, type MeshStandardMaterial, type Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { boxMapped } from './kit.ts';
import type { ModelDef, ModelSource, PartDef } from './types.ts';
import type { BuildingKind } from '../world/layout.ts';

export type TurretSourceId = 'code' | 'step1x' | 'trellis';
export type TurretLod = '20k' | '5k';

export interface TurretSourceInfo {
  id: TurretSourceId;
  label: string;
  /** GLB per level of detail, relative to the site base; absent for the code-built model. */
  urls?: Record<TurretLod, string>;
  /** Barrel direction override, radians about +Y; by default the longest horizontal protrusion is the barrel. */
  yaw?: number;
  /**
   * 'ivory': draw the generated geometry with W17's ivory armour material (box-projected UVs)
   * instead of the GLB's own base colour. Used when the generated texture is unusable.
   */
  material?: 'gltf' | 'ivory';
}

const BASE = import.meta.env.BASE_URL;

/** Sources that exist in public/models/turret/. See public/models/turret/README.md. */
export const TURRET_SOURCES: TurretSourceInfo[] = [
  { id: 'code', label: 'W17 code-built' },
  {
    id: 'step1x',
    label: 'Step1X-3D',
    urls: { '20k': `${BASE}models/turret/step1x/turret-20k.glb`, '5k': `${BASE}models/turret/step1x/turret-5k.glb` },
    // Step1X-3D's texture stage produced noise on the Spark (see public/models/turret/README.md);
    // the geometry is shown with W17's ivory armour material instead
    material: 'ivory',
  },
];

export function turretSourceInfo(id: string | null): TurretSourceInfo {
  return TURRET_SOURCES.find((s) => s.id === id) ?? TURRET_SOURCES[0]!;
}

/** Width of the low slice of a set of points (the footprint), and its XZ centre. */
function footprint(points: Vector3[], minY: number, h: number): { width: number; cx: number; cz: number } {
  const lim = minY + 0.15 * h;
  const b = new Box3();
  for (const p of points) if (p.y <= lim) b.expandByPoint(p);
  return { width: Math.max(b.max.x - b.min.x, b.max.z - b.min.z), cx: (b.min.x + b.max.x) / 2, cz: (b.min.z + b.max.z) / 2 };
}

function positionsOf(geoms: Array<{ geometry: BufferGeometry; matrix?: Matrix4 }>): Vector3[] {
  const out: Vector3[] = [];
  for (const { geometry, matrix } of geoms) {
    const pos = geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const v = new Vector3().fromBufferAttribute(pos, i);
      if (matrix) v.applyMatrix4(matrix);
      out.push(v);
    }
  }
  return out;
}

/** Footprint width of a ModelDef at rest (parts placed by their pivots), for scale matching. */
export function footprintWidth(def: ModelDef): number {
  const pts = positionsOf(def.parts.map((p) => ({ geometry: p.geometry, matrix: p.pivot })));
  const b = new Box3().setFromPoints(pts);
  return footprint(pts, b.min.y, b.max.y - b.min.y).width;
}

export interface LoadedGltf {
  def: ModelDef;
  triangles: number;
  bytes: number;
  textureSize: number;
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

export async function loadGltfModel(name: string, url: string, targetFootprint: number, opts: { yaw?: number; anisotropy?: number; override?: Material } = {}): Promise<LoadedGltf> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const gltf = await loader.parseAsync(buf, url.slice(0, url.lastIndexOf('/') + 1));
  gltf.scene.updateMatrixWorld(true);
  const meshes: Array<{ geometry: BufferGeometry; material: Material | Material[] }> = [];
  gltf.scene.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.clone();
    // meshopt/quantised GLBs store positions and normals as normalised integers; transforming
    // those in place would clamp to [-1, 1], so dequantise to float first
    for (const name of ['position', 'normal']) {
      const a = g.getAttribute(name);
      if (!a || (a.array instanceof Float32Array && !(a as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute)) continue;
      const f = new Float32Array(a.count * 3);
      for (let i = 0; i < a.count; i++) {
        f[i * 3] = a.getX(i);
        f[i * 3 + 1] = a.getY(i);
        f[i * 3 + 2] = a.getZ(i);
      }
      g.setAttribute(name, new BufferAttribute(f, 3));
    }
    g.applyMatrix4(m.matrixWorld);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    meshes.push({ geometry: g, material: m.material });
  });
  if (!meshes.length) throw new Error(`${url}: no meshes`);

  // 1. footprint centre to the origin, ground at y = 0
  let pts = positionsOf(meshes);
  let box = new Box3().setFromPoints(pts);
  const h0 = box.max.y - box.min.y;
  const fp0 = footprint(pts, box.min.y, h0);
  const fit = new Matrix4().makeTranslation(-fp0.cx, -box.min.y, -fp0.cz);
  // 2. barrel to +X: above the base (upper 60 % of the height), the point farthest from the
  // vertical axis is the muzzle end
  let yaw = opts.yaw;
  if (yaw === undefined) {
    let best = 0;
    let dir = 0;
    const above = box.min.y + 0.4 * h0;
    for (const p of pts) {
      if (p.y < above) continue;
      const x = p.x - fp0.cx;
      const z = p.z - fp0.cz;
      const d = x * x + z * z;
      if (d > best) {
        best = d;
        dir = Math.atan2(-z, x);
      }
    }
    yaw = -dir;
  }
  fit.premultiply(new Matrix4().makeRotationY(yaw));
  // 3. scale so the footprint matches the code-built model's
  const s = targetFootprint / fp0.width;
  fit.premultiply(new Matrix4().makeScale(s, s, s));
  for (const m of meshes) {
    m.geometry.applyMatrix4(fit);
    if (opts.override) {
      m.geometry = boxMapped(m.geometry);
      m.material = opts.override;
    }
  }

  pts = positionsOf(meshes);
  box = new Box3().setFromPoints(pts);
  // muzzle: centre of the vertices within 3% of the barrel tip
  const tipX = box.max.x;
  const near = pts.filter((p) => p.x > tipX - 0.03 * (box.max.x - box.min.x));
  const muzzle: [number, number, number] = [tipX, near.reduce((a, p) => a + p.y, 0) / near.length, near.reduce((a, p) => a + p.z, 0) / near.length];
  let radius = 0;
  for (const p of pts) radius = Math.max(radius, Math.hypot(p.x, p.z));

  let triangles = 0;
  let textureSize = 0;
  const parts: PartDef[] = meshes.map((m, i) => {
    m.geometry.computeBoundingSphere();
    triangles += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const sm = mat as MeshStandardMaterial;
      if (opts.override) continue;
      for (const t of [sm.map, sm.normalMap, sm.roughnessMap, sm.metalnessMap, sm.emissiveMap] as Array<Texture | null>) {
        if (!t) continue;
        if (opts.anisotropy) t.anisotropy = opts.anisotropy;
        const img = t.image as { width?: number } | undefined;
        textureSize = Math.max(textureSize, img?.width ?? 0);
      }
    }
    return {
      name: i === 0 ? 'head' : `mesh${i}`,
      geometry: m.geometry,
      material: m.material,
      pivot: new Matrix4(),
      motion: i === 0 ? { kind: 'aim' } : { kind: 'static' },
      parent: i === 0 ? undefined : 'head',
      castShadow: true,
    };
  });
  return { def: { name, parts, radius, height: box.max.y, muzzle }, triangles, bytes: buf.byteLength, textureSize };
}

/** `base` with the gun turret replaced by `gun`. Everything else still comes from `base`. */
export function withGun(base: ModelSource, gun: ModelDef, label: string): ModelSource {
  return {
    name: `${base.name} + ${label} gun turret`,
    building: (k: BuildingKind, tier?: number) => (k === 'gun' ? gun : base.building(k, tier)),
    unit: (k) => base.unit(k),
    alien: (k) => base.alien(k),
  };
}
