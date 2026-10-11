// Ported from look/src/stress/turretLevels.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// The four detail levels of the W20 gun turret as instancing batches: one geometry per moving part
// (base, pinion, yaw = slewing ring + head, cradle, barrel, icon) and material. Built once from
// W20's own model (full), the W21 middle builder, W20's simple level and W20's icon.
//
// Bolts: W20 draws them as one instanced hex bolt per part and material. Here each bolt is placed
// into its part's geometry of the same material (same bolt mesh, same transform), so bolts add no
// draw calls. One visible difference: W20's edge-wear noise is looked up in the bolt's own unit
// space, here in part space, so the chipped pattern on a bolt's chamfer differs (bolts are 0.03
// tiles across).
//
// Emissive slits and the base indicator use their own material whose emissive is multiplied by the
// instance colour, so each turret's slits pulse with its own shots (W20 drives one material's
// emissiveIntensity for its single turret).

import { BufferAttribute, BufferGeometry, Color, MeshStandardMaterial, type Material } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TB, boltMatrix, type BoltSpec } from '../bench/geo.ts';
import type { TurretMats } from '../bench/surface.ts';
import { boltGeometry, triangleCount, type BuiltPart, type TurretModel } from '../bench/turretModel.ts';
import type { TurretRig } from '../bench/turretRig.ts';
import { buildMiddle } from './turretMid.ts';

export type Slot = 'base' | 'pinion' | 'yaw' | 'cradle' | 'barrel' | 'icon';
export const SLOTS: Slot[] = ['base', 'pinion', 'yaw', 'cradle', 'barrel', 'icon'];

export interface Batch {
  slot: Slot;
  /** Material key ('glow' uses the per-instance glow material). */
  key: string;
  geometry: BufferGeometry;
  material: Material;
  castShadow: boolean;
  /** Takes the per-turret glow intensity from the instance colour. */
  glow: boolean;
}

export interface LevelDef {
  name: string;
  batches: Batch[];
  triangles: number;
  slots: Slot[];
}

/** Copies the vertices of one geometry group into a new non-indexed geometry. */
function groupGeometry(g: BufferGeometry, start: number, count: number): BufferGeometry {
  const src = g.index ? g.toNonIndexed() : g;
  const out = new BufferGeometry();
  for (const name of Object.keys(src.attributes)) {
    const a = src.getAttribute(name) as BufferAttribute;
    const s = a.itemSize;
    out.setAttribute(name, new BufferAttribute((a.array as Float32Array).slice(start * s, (start + count) * s), s));
  }
  return out;
}

/** A geometry with material groups → one geometry per material (keyed by material name). */
export function splitByMaterial(g: BufferGeometry, mats: Material | Material[]): Map<string, { geometry: BufferGeometry; material: Material }> {
  const out = new Map<string, { geometry: BufferGeometry; material: Material }>();
  const list = Array.isArray(mats) ? mats : [mats];
  const groups = g.groups.length ? g.groups : [{ start: 0, count: g.index ? g.index.count : g.getAttribute('position').count, materialIndex: 0 }];
  for (const gr of groups) {
    const m = list[gr.materialIndex ?? 0]!;
    const piece = groupGeometry(g, gr.start, gr.count);
    const prev = out.get(m.name);
    out.set(m.name, { geometry: prev ? mergeGeometries([prev.geometry, piece], false)! : piece, material: m });
  }
  return out;
}

let unitBolt: BufferGeometry | null = null;

/** The part's own pieces plus its bolts placed into the geometry of the bolt's material. */
export function partWithBolts(p: BuiltPart, mats: TurretMats): Map<string, { geometry: BufferGeometry; material: Material }> {
  const out = splitByMaterial(p.geometry, p.material);
  unitBolt ??= boltGeometry();
  const byKey = new Map<BoltSpec['key'], BufferGeometry[]>();
  for (const b of p.bolts) {
    const g = unitBolt.clone();
    g.applyMatrix4(boltMatrix(b));
    byKey.set(b.key, [...(byKey.get(b.key) ?? []), g]);
  }
  for (const [key, list] of byKey) {
    const mat = mats[key];
    const prev = out.get(mat.name);
    const merged = mergeGeometries(prev ? [prev.geometry, ...list] : list, false)!;
    out.set(mat.name, { geometry: merged, material: mat });
  }
  return out;
}

/** Glow material whose emissive is scaled by the instance colour's red channel. */
export function instancedGlow(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ name: 'glow', color: '#0a1416', emissive: new Color('#36e6ff'), emissiveIntensity: 1, roughness: 0.35 });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      // the instance colour carries the slit intensity; it must not tint the dark base colour
      .replace('#include <color_fragment>', '')
      // W22: BatchedMesh carries the per-instance colour as USE_BATCHING_COLOR
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#if defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )\ntotalEmissiveRadiance *= vColor.r;\n#endif');
  };
  m.customProgramCacheKey = () => 'w21-glow';
  return m;
}

/** Materials that cast shadows at full and middle detail (dark and glow pieces are too small). */
const SHADOW_KEYS = new Set(['ceramic', 'gunmetal', 'bronze']);

function levelFrom(name: string, parts: Array<{ slot: Slot; pieces: Map<string, { geometry: BufferGeometry; material: Material }> }>, glow: MeshStandardMaterial, shadows: boolean): LevelDef {
  // merge parts that share a slot (ring + head) per material
  const bySlot = new Map<string, { slot: Slot; key: string; geos: BufferGeometry[]; material: Material }>();
  for (const p of parts)
    for (const [key, v] of p.pieces) {
      const id = `${p.slot}/${key}`;
      const e = bySlot.get(id) ?? { slot: p.slot, key, geos: [], material: v.material };
      e.geos.push(v.geometry);
      bySlot.set(id, e);
    }
  const batches: Batch[] = [];
  let triangles = 0;
  for (const e of bySlot.values()) {
    const geometry = e.geos.length === 1 ? e.geos[0]! : mergeGeometries(e.geos, false)!;
    geometry.computeBoundingSphere();
    triangles += triangleCount(geometry);
    const isGlow = e.key === 'glow';
    batches.push({ slot: e.slot, key: e.key, geometry, material: isGlow ? glow : e.material, castShadow: shadows && SHADOW_KEYS.has(e.key), glow: isGlow });
  }
  const slots = [...new Set(batches.map((b) => b.slot))];
  return { name, batches, triangles, slots };
}

export function tbPieces(b: TB, mats: TurretMats): Map<string, { geometry: BufferGeometry; material: Material }> {
  const { geometry, material } = b.build(mats);
  return splitByMaterial(geometry, material);
}

/**
 * Builds the four levels. `simpleRig` is a W20 TurretRig whose simple level and icon geometries are
 * reused as they are.
 */
export function buildLevels(model: TurretModel, mats: TurretMats, simpleRig: TurretRig): { levels: LevelDef[]; glow: MeshStandardMaterial } {
  const glow = instancedGlow();
  const full = levelFrom(
    'full',
    [
      { slot: 'base', pieces: partWithBolts(model.base, mats) },
      { slot: 'pinion', pieces: partWithBolts(model.pinion, mats) },
      { slot: 'yaw', pieces: partWithBolts(model.ring, mats) },
      { slot: 'yaw', pieces: partWithBolts(model.head, mats) },
      { slot: 'cradle', pieces: partWithBolts(model.cradle, mats) },
      { slot: 'barrel', pieces: partWithBolts(model.barrel, mats) },
    ],
    glow,
    true,
  );
  const mid = buildMiddle();
  const middle = levelFrom(
    'middle',
    [
      { slot: 'base', pieces: tbPieces(mid.base, mats) },
      { slot: 'pinion', pieces: tbPieces(mid.pinion, mats) },
      { slot: 'yaw', pieces: tbPieces(mid.ring, mats) },
      { slot: 'yaw', pieces: tbPieces(mid.head, mats) },
      { slot: 'cradle', pieces: tbPieces(mid.cradle, mats) },
      { slot: 'barrel', pieces: tbPieces(mid.barrel, mats) },
    ],
    glow,
    true,
  );
  // W20 simple level: meshes are base (static), head (yaw pivot) and barrel (recoil slide)
  const sm = simpleRig.levels.simple.meshes;
  const simpleSlots: Slot[] = ['base', 'yaw', 'barrel'];
  const simple = levelFrom(
    'simple',
    sm.map((m, i) => ({ slot: simpleSlots[i]!, pieces: splitByMaterial(m.geometry, m.material) })),
    glow,
    false,
  );
  const iconGeo = simpleRig.icon.geometry;
  const icon: LevelDef = {
    name: 'icon',
    batches: [{ slot: 'icon', key: 'icon', geometry: iconGeo, material: simpleRig.icon.material as Material, castShadow: false, glow: false }],
    triangles: triangleCount(iconGeo),
    slots: ['icon'],
  };
  return { levels: [full, middle, simple, icon], glow };
}
