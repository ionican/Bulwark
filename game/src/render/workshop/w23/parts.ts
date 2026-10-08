// Ported from look/src/w23/parts.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// W23 parts: a part is one rigid piece of an asset (a wall face segment, an engineer's forearm, the
// mass extractor's drill drum) built once at full, middle and simple detail, split by material.
// Every asset in the workshop is drawn from these parts through one instanced batch per part ×
// material × level (batches.ts), shared by every object that uses the part.

import { MeshStandardMaterial, type BufferGeometry } from 'three';
import type { TurretMats } from '../bench/surface.ts';
import { triangleCount } from '../bench/turretModel.ts';
import { PB, type Lv } from '../kit/builder.ts';
import type { MatKey, PieceMap } from '../kit/kit.ts';
import { partWithBolts } from '../stress/turretLevels.ts';
import type { AssetKind } from './lod.ts';

export type { MatKey, PieceMap };
export type Build = (p: PB) => void;

export interface PartDef {
  index: number;
  id: string;
  asset: AssetKind;
  levels: [PieceMap, PieceMap, PieceMap];
  /** Triangles at full, middle and simple detail. */
  tris: [number, number, number];
  /** Casts shadows (ivory, gunmetal and bronze batches at full and middle detail). */
  shadow: boolean;
}

let names: TurretMats | null = null;
/** Material stand-ins: the builder only needs each material's name to split pieces by material. */
function nameMats(): TurretMats {
  if (names) return names;
  const m = (name: string) => new MeshStandardMaterial({ name });
  const t = { ceramic: m('ceramic'), gunmetal: m('gunmetal'), bronze: m('bronze'), dark: m('dark'), glow: m('glow'), brass: m('brass') };
  names = { ...t, all: Object.values(t) };
  return names;
}

export function pieceTris(m: PieceMap): number {
  let t = 0;
  for (const g of m.values()) t += triangleCount(g);
  return t;
}

/** Builds one level of a part (empty map when the level has no pieces). */
export function buildLevel(fn: Build, lv: Lv): PieceMap {
  const p = new PB(lv);
  fn(p);
  if (p.count === 0) return new Map();
  const mats = nameMats();
  const { geometry, material } = p.tb.build(mats);
  const out: PieceMap = new Map();
  for (const [k, v] of partWithBolts({ name: 'part', geometry, material, bolts: p.tb.bolts }, mats)) {
    v.geometry.computeBoundingSphere();
    out.set(k as MatKey, v.geometry);
  }
  return out;
}

export class PartSet {
  readonly parts: PartDef[] = [];
  readonly byId = new Map<string, PartDef>();

  add(id: string, asset: AssetKind, fn: Build, opts: { shadow?: boolean; levels?: Partial<Record<Lv, Build>> } = {}): PartDef {
    const levels = ([0, 1, 2] as Lv[]).map((lv) => buildLevel(opts.levels?.[lv] ?? fn, lv)) as [PieceMap, PieceMap, PieceMap];
    const def: PartDef = { index: this.parts.length, id, asset, levels, tris: levels.map(pieceTris) as [number, number, number], shadow: opts.shadow ?? true };
    this.parts.push(def);
    this.byId.set(id, def);
    return def;
  }

  /** A part from ready-made geometry per level (e.g. a merged sub-assembly). */
  addPieces(id: string, asset: AssetKind, levels: [PieceMap, PieceMap, PieceMap], shadow = true): PartDef {
    const def: PartDef = { index: this.parts.length, id, asset, levels, tris: levels.map(pieceTris) as [number, number, number], shadow };
    this.parts.push(def);
    this.byId.set(id, def);
    return def;
  }

  get(id: string): PartDef {
    const p = this.byId.get(id);
    if (!p) throw new Error(`no part ${id}`);
    return p;
  }
}

/** All geometries of a part level merged by material key (for tests: world-space checks). */
export function levelGeometries(p: PartDef, lv: Lv): Array<[MatKey, BufferGeometry]> {
  return [...p.levels[lv].entries()];
}
