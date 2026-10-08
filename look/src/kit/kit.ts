// The W22 kit assembled: every part at its three detail levels (one geometry per material), the
// 40 kinds built from them, and each kind's frame (where its parts sit and how they move).
//
// Parts are placed on six pivots, written once per turret per frame (pose.ts):
//   STATIC   T(p)                                     base; ring and pinion below full detail
//   PINION   T(p + pinionAt) · Ry(−yaw · ratio)        W20's pinion at full detail
//   PINION0  T(p + pinionAt)                          W20's pinion below full detail (no spin)
//   YAW      T(p) · Ry(yaw)                            ring at full detail, head
//   PITCH    YAW · T(0, trunnionY, 0) · Rz(pitch)      weapon mount
//   GUN      PITCH · T(−recoil · scale, 0, 0) · Rx(spin)   gun
// and a part is drawn at pivot · T(offset), where the offset lifts a shared part onto the kind's
// own stack (a ring on a taller base, a head on a taller ring).

import type { BufferGeometry, Material, MeshStandardMaterial } from 'three';
import type { TurretMats } from '../bench/surface.ts';
import { triangleCount, type TurretModel } from '../bench/turretModel.ts';
import type { TurretRig } from '../bench/turretRig.ts';
import { buildMiddle } from '../stress/turretMid.ts';
import { instancedGlow, partWithBolts, splitByMaterial, tbPieces } from '../stress/turretLevels.ts';
import { PB, type Lv } from './builder.ts';
import { BASES, HEADS, RINGS, WEAPONS, type BaseId, type Build, type HeadId, type RingId, type WeaponId } from './parts.ts';

export type MatKey = 'ceramic' | 'gunmetal' | 'bronze' | 'dark' | 'glow';
export const MAT_KEYS: MatKey[] = ['ceramic', 'gunmetal', 'bronze', 'dark', 'glow'];
/** Materials whose batches cast shadows at full and middle detail (W21's rule). */
export const SHADOW_MATS = new Set<MatKey>(['ceramic', 'gunmetal', 'bronze']);
export type Family = 'base' | 'pinion' | 'ring' | 'head' | 'mount' | 'gun';
export type PieceMap = Map<MatKey, BufferGeometry>;

export const STATIC = 0;
export const PINION = 1;
export const PINION0 = 2;
export const YAW = 3;
export const PITCH = 4;
export const GUN = 5;
export const PIVOTS = 6;
export const PIVOT_NAMES = ['static', 'pinion', 'pinion0', 'yaw', 'pitch', 'gun'];

export interface KitPart {
  index: number;
  id: string;
  name: string;
  family: Family;
  /** Geometry per material at full, middle and simple detail (a level may be empty). */
  levels: [PieceMap, PieceMap, PieceMap];
  triangles: [number, number, number];
  /** Kinds that use this part. */
  usedBy: number[];
}

export interface Placed {
  part: KitPart;
  /** Pivot at full, middle and simple detail. */
  pivot: [number, number, number];
  /** Offset in the pivot's frame. */
  off: [number, number, number];
}

export interface KindFrame {
  pinionAt: [number, number, number];
  pinionRatio: number;
  trunnionY: number;
  recoilScale: number;
}

export type Outline = 'circle' | 'square' | 'ring' | 'triangle';
export type Glyph = 'bar' | 'twin' | 'stub' | 'rotary' | 'pod' | 'lens' | 'quad';
export interface IconSpec {
  outline: Outline;
  glyph: Glyph;
}

export interface Kind {
  index: number;
  id: string;
  name: string;
  base: BaseId;
  ring: RingId;
  head: HeadId;
  weapon: WeaponId;
  frame: KindFrame;
  placed: Placed[];
  /** Index into Kit.icons (kinds with the same base outline and weapon glyph share an icon). */
  icon: number;
  /** Triangles at full, middle, simple and icon detail. */
  triangles: [number, number, number, number];
  /** Muzzle in cradle space; height of the turret top (tiles). */
  muzzle: [number, number, number];
  top: number;
}

export interface Kit {
  parts: KitPart[];
  kinds: Kind[];
  icons: IconSpec[];
  /** Draw material per key (glow takes the per-instance intensity from the instance colour). */
  mats: Record<MatKey, Material>;
  glow: MeshStandardMaterial;
}

/** The 40 kinds: id, name, base, ring, head, weapon. Kind 0 is W20's turret. */
export const KIND_TABLE: Array<[string, string, BaseId, RingId, HeadId, WeaponId]> = [
  ['bastion', 'Bastion (W20)', 'octagon', 'toothed', 'cheek', 'long'],
  ['warden', 'Warden', 'octagon', 'toothed', 'cheek', 'twin'],
  ['breaker', 'Breaker', 'octagon', 'toothed', 'cheek', 'howitzer'],
  ['gatekeeper', 'Gatekeeper', 'octagon', 'collar', 'dome', 'long'],
  ['sentinel', 'Sentinel', 'octagon', 'collar', 'dome', 'rotary'],
  ['lantern', 'Lantern', 'octagon', 'turntable', 'emitter', 'beam'],
  ['hailstorm', 'Hailstorm', 'octagon', 'turntable', 'box', 'flak'],
  ['quiver', 'Quiver', 'octagon', 'toothed', 'yoke', 'missiles'],
  ['anvil', 'Anvil', 'octagon', 'collar', 'deck', 'howitzer'],
  ['lookout', 'Lookout', 'octagon', 'turntable', 'mast', 'twin'],
  ['redoubt', 'Redoubt', 'bunker', 'toothed', 'box', 'twin'],
  ['howler', 'Howler', 'bunker', 'collar', 'box', 'howitzer'],
  ['rampart', 'Rampart', 'bunker', 'turntable', 'deck', 'long'],
  ['thresher', 'Thresher', 'bunker', 'toothed', 'cheek', 'rotary'],
  ['picket', 'Picket', 'bunker', 'collar', 'mast', 'flak'],
  ['volley', 'Volley', 'bunker', 'turntable', 'yoke', 'missiles'],
  ['bulwark', 'Bulwark', 'bunker', 'toothed', 'dome', 'twin'],
  ['prism', 'Prism', 'bunker', 'collar', 'emitter', 'beam'],
  ['stockade', 'Stockade', 'bunker', 'turntable', 'cheek', 'flak'],
  ['sapper', 'Sapper', 'bunker', 'toothed', 'deck', 'howitzer'],
  ['cairn', 'Cairn', 'drum', 'collar', 'dome', 'beam'],
  ['barrow', 'Barrow', 'drum', 'turntable', 'deck', 'howitzer'],
  ['ringwall', 'Ringwall', 'drum', 'toothed', 'box', 'long'],
  ['spindle', 'Spindle', 'drum', 'collar', 'emitter', 'rotary'],
  ['kestrel', 'Kestrel', 'drum', 'turntable', 'mast', 'rotary'],
  ['hive', 'Hive', 'drum', 'toothed', 'yoke', 'missiles'],
  ['palisade', 'Palisade', 'drum', 'collar', 'cheek', 'beam'],
  ['bramble', 'Bramble', 'drum', 'turntable', 'box', 'rotary'],
  ['hearth', 'Hearth', 'drum', 'toothed', 'dome', 'howitzer'],
  ['moat', 'Moat', 'drum', 'collar', 'deck', 'twin'],
  ['spire', 'Spire', 'pylon', 'turntable', 'emitter', 'long'],
  ['eyrie', 'Eyrie', 'pylon', 'toothed', 'mast', 'beam'],
  ['belfry', 'Belfry', 'pylon', 'collar', 'dome', 'flak'],
  ['watchtower', 'Watchtower', 'pylon', 'turntable', 'mast', 'flak'],
  ['heron', 'Heron', 'pylon', 'toothed', 'cheek', 'long'],
  ['skylance', 'Skylance', 'pylon', 'collar', 'yoke', 'beam'],
  ['gantry', 'Gantry', 'pylon', 'turntable', 'box', 'twin'],
  ['steeple', 'Steeple', 'pylon', 'toothed', 'yoke', 'rotary'],
  ['aerie', 'Aerie', 'pylon', 'collar', 'mast', 'twin'],
  ['crowsnest', "Crow's Nest", 'pylon', 'turntable', 'dome', 'rotary'],
];

const OUTLINE: Record<BaseId, Outline> = { octagon: 'circle', bunker: 'square', drum: 'ring', pylon: 'triangle' };
const GLYPH: Record<WeaponId, Glyph> = { long: 'bar', twin: 'twin', howitzer: 'stub', rotary: 'rotary', missiles: 'pod', beam: 'lens', flak: 'quad' };

export function pieceTriangles(m: PieceMap): number {
  let t = 0;
  for (const g of m.values()) t += triangleCount(g);
  return t;
}

function toPieceMap(m: Map<string, { geometry: BufferGeometry }>): PieceMap {
  const out: PieceMap = new Map();
  for (const [k, v] of m) out.set(k as MatKey, v.geometry);
  return out;
}

function built(fn: Build, lv: Lv, mats: TurretMats, name: string): PieceMap {
  const p = new PB(lv);
  fn(p);
  if (p.count === 0) return new Map();
  const { geometry, material } = p.tb.build(mats);
  return toPieceMap(partWithBolts({ name, geometry, material, bolts: p.tb.bolts }, mats));
}

const tiny = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v);

/**
 * Builds the kit. `model` and `simpleRig` are W20's (src/bench): W20's parts come from them and
 * from W21's middle builder, the same calls W21's buildLevels makes.
 */
export function buildKit(mats: TurretMats, model: TurretModel, simpleRig: TurretRig): Kit {
  const parts: KitPart[] = [];
  const add = (id: string, name: string, family: Family, levels: [PieceMap, PieceMap, PieceMap]): KitPart => {
    const p: KitPart = { index: parts.length, id, name, family, levels, triangles: levels.map(pieceTriangles) as [number, number, number], usedBy: [] };
    parts.push(p);
    return p;
  };
  const make = (id: string, name: string, family: Family, fn: Build) => add(id, name, family, [0, 1, 2].map((lv) => built(fn, lv as Lv, mats, id)) as [PieceMap, PieceMap, PieceMap]);

  // W20's parts, from the same calls as W21's buildLevels
  const mid = buildMiddle();
  const sm = simpleRig.levels.simple.meshes;
  const simplePiece = (i: number) => toPieceMap(splitByMaterial(sm[i]!.geometry, sm[i]!.material));
  const none: PieceMap = new Map();
  const w20 = {
    base: add('base/octagon', BASES[0]!.name, 'base', [toPieceMap(partWithBolts(model.base, mats)), toPieceMap(tbPieces(mid.base, mats)), simplePiece(0)]),
    pinion: add('pinion/w20', 'Pinion (W20)', 'pinion', [toPieceMap(partWithBolts(model.pinion, mats)), toPieceMap(tbPieces(mid.pinion, mats)), none]),
    ring: add('ring/toothed', RINGS[0]!.name, 'ring', [toPieceMap(partWithBolts(model.ring, mats)), toPieceMap(tbPieces(mid.ring, mats)), none]),
    head: add('head/cheek', HEADS[0]!.name, 'head', [toPieceMap(partWithBolts(model.head, mats)), toPieceMap(tbPieces(mid.head, mats)), simplePiece(1)]),
    mount: add('mount/long', 'Cradle (W20)', 'mount', [toPieceMap(partWithBolts(model.cradle, mats)), toPieceMap(tbPieces(mid.cradle, mats)), none]),
    gun: add('gun/long', 'Long barrel with muzzle brake (W20)', 'gun', [toPieceMap(partWithBolts(model.barrel, mats)), toPieceMap(tbPieces(mid.barrel, mats)), simplePiece(2)]),
  };

  const baseOf = new Map<BaseId, KitPart>([['octagon', w20.base]]);
  const ringOf = new Map<RingId, KitPart>([['toothed', w20.ring]]);
  const headOf = new Map<HeadId, KitPart>([['cheek', w20.head]]);
  const mountOf = new Map<WeaponId, KitPart>([['long', w20.mount]]);
  const gunOf = new Map<WeaponId, KitPart>([['long', w20.gun]]);
  for (const b of BASES) if (b.build) baseOf.set(b.id, make(`base/${b.id}`, b.name, 'base', b.build));
  for (const r of RINGS) if (r.build) ringOf.set(r.id, make(`ring/${r.id}`, r.name, 'ring', r.build));
  for (const h of HEADS) if (h.build) headOf.set(h.id, make(`head/${h.id}`, h.name, 'head', h.build));
  for (const w of WEAPONS) {
    if (w.mount) mountOf.set(w.id, make(`mount/${w.id}`, `${w.name}: mount`, 'mount', w.mount));
    if (w.gun) gunOf.set(w.id, make(`gun/${w.id}`, `${w.name}: gun`, 'gun', w.gun));
  }

  const icons: IconSpec[] = [];
  const iconKey = new Map<string, number>();
  const kinds: Kind[] = KIND_TABLE.map(([id, name, b, r, h, w], index) => {
    const bs = BASES.find((x) => x.id === b)!;
    const rs = RINGS.find((x) => x.id === r)!;
    const hs = HEADS.find((x) => x.id === h)!;
    const ws = WEAPONS.find((x) => x.id === w)!;
    const ringDy = tiny(bs.top - rs.anchor);
    const headDy = tiny(bs.top + rs.height - hs.anchor);
    const frame: KindFrame = {
      pinionAt: model.pinionAt,
      pinionRatio: model.pinionRatio,
      trunnionY: headDy + hs.trunnion,
      recoilScale: ws.motion === 'recoil' ? ws.recoilScale : 0,
    };
    const placed: Placed[] = [{ part: baseOf.get(b)!, pivot: [STATIC, STATIC, STATIC], off: [0, 0, 0] }];
    if (b === 'octagon') placed.push({ part: w20.pinion, pivot: [PINION, PINION0, PINION0], off: [0, 0, 0] });
    placed.push({ part: ringOf.get(r)!, pivot: [YAW, STATIC, STATIC], off: [0, ringDy, 0] });
    placed.push({ part: headOf.get(h)!, pivot: [YAW, YAW, YAW], off: [0, headDy, 0] });
    placed.push({ part: mountOf.get(w)!, pivot: [PITCH, PITCH, PITCH], off: [0, 0, 0] });
    const gun = gunOf.get(w);
    if (gun) placed.push({ part: gun, pivot: [GUN, GUN, GUN], off: [0, 0, 0] });
    for (const pl of placed) if (!pl.part.usedBy.includes(index)) pl.part.usedBy.push(index);
    const spec: IconSpec = { outline: OUTLINE[b], glyph: GLYPH[w] };
    const key = `${spec.outline}/${spec.glyph}`;
    if (!iconKey.has(key)) {
      iconKey.set(key, icons.length);
      icons.push(spec);
    }
    const tri = [0, 1, 2].map((lv) => placed.reduce((s, pl) => s + pl.part.triangles[lv]!, 0));
    // turret top: the head's highest point above the ground
    let top = 0;
    const hp = headOf.get(h)!.levels[1];
    for (const g of hp.values()) {
      g.computeBoundingBox();
      top = Math.max(top, g.boundingBox!.max.y + headDy);
    }
    return { index, id, name, base: b, ring: r, head: h, weapon: w, frame, placed, icon: iconKey.get(key)!, triangles: [tri[0]!, tri[1]!, tri[2]!, 2], muzzle: ws.muzzle, top };
  });

  const glow = instancedGlow();
  const m: Record<MatKey, Material> = { ceramic: mats.ceramic, gunmetal: mats.gunmetal, bronze: mats.bronze, dark: mats.dark, glow };
  return { parts, kinds, icons, mats: m, glow };
}

/**
 * Kind of each turret: `kinds` = 1 gives every turret W20's kind; otherwise each run of
 * `kinds` turrets holds every kind once, in a shuffled order (seeded per run), so any count is
 * spread evenly and neighbours differ.
 */
export function assignKinds(n: number, kinds: number, seed = 22): Uint8Array {
  const out = new Uint8Array(n);
  if (kinds <= 1) return out;
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const perm = Array.from({ length: kinds }, (_, i) => i);
  for (let i = 0; i < n; i++) {
    const k = i % kinds;
    if (k === 0)
      for (let j = kinds - 1; j > 0; j--) {
        const r = Math.floor(rnd() * (j + 1));
        [perm[j], perm[r]] = [perm[r]!, perm[j]!];
      }
    out[i] = perm[k]!;
  }
  return out;
}
