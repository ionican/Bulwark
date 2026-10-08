// The four ways of drawing a mixed field of kit turrets. Each takes the same calls each frame —
// begin(), push() once per visible turret with its kind, detail level and pose, commit() — and
// draws the same parts at the same transforms (test/kinds.test.ts checks this through drawn()).
//
//   A  naive per kind     each kind has its own instanced batches: per detail level, one batch per
//                         part × material, except that parts on the same pivot at the same offset
//                         share a batch (as W21 merges ring and head); one icon batch per kind.
//                         W21's structure × 40.
//   B  shared parts       one instanced batch per part × material × level, shared by every kind that
//                         uses the part; one icon batch per distinct icon.
//   C  B + merged levels  as B, but at middle and simple detail the static parts of a kind (base,
//                         pinion, ring) are drawn as one merged "plinth" per base × ring pair, and all
//                         icons are one batch with the atlas cell per instance.
//   D  BatchedMesh        one THREE.BatchedMesh per material × level holding every part geometry of
//                         that material and level (and one for the icons), drawn with
//                         WEBGL_multi_draw: one draw call per mesh. Without the extension three.js
//                         issues one draw per instance (WebGLRenderer.renderBufferDirect).
//
// Instanced batches (A–C) refill from zero each frame, like W21. All meshes of one instance group
// share one instance-matrix buffer, so a matrix is written once per group however many materials
// the group has. BatchedMesh keeps one matrix texture per mesh, so D writes a part's matrix once
// per material.

import {
  BatchedMesh,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  type BufferGeometry,
  type DataTexture,
  type Material,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { writeYaw } from '../stress/turretPose.ts';
import { cellOffset, iconMaterial, iconQuad } from './icons.ts';
import { MAT_KEYS, PINION0, PIVOTS, SHADOW_MATS, STATIC, type Kind, type Kit, type KitPart, type MatKey, type PieceMap } from './kit.ts';
import { writePart, writePivots } from './pose.ts';

export type StrategyId = 'A' | 'B' | 'C' | 'D';
export const STRATEGIES: StrategyId[] = ['A', 'B', 'C', 'D'];
export const STRATEGY_NAMES: Record<StrategyId, string> = {
  A: 'A naive per kind',
  B: 'B shared parts',
  C: 'C shared + merged levels',
  D: 'D BatchedMesh',
};
const ICON = 3;

/** One drawn part instance, for checks: which turret, part and material, and the part's matrix. */
export interface DrawnEntry {
  turret: number;
  part: string;
  mat: string;
  level: number;
  m: Float32Array;
  /** Icon atlas cell offset (icons only). */
  iconUv?: [number, number];
}

export interface KitRenderer {
  readonly id: StrategyId;
  readonly group: Group;
  begin(): void;
  push(turret: number, kind: Kind, level: number, x: number, y: number, z: number, yaw: number, pitch: number, recoil: number, spin: number, glow: number, iconScale: number): void;
  commit(): void;
  /** Quality low: only full-detail turrets cast shadows. */
  setMiddleShadows(on: boolean): void;
  /** Batches drawn in the scene pass this frame (a multi-draw counts once) and in the shadow pass. */
  readonly drawCalls: number;
  readonly shadowCalls: number;
  /** Batches built (objects in the scene graph). */
  readonly batches: number;
  drawn(): DrawnEntry[];
  /** Makes every batch drawable with one instance (for compiling programs up front). */
  primeForCompile(on: boolean): void;
}

interface Member {
  part: KitPart;
  off: [number, number, number];
}

/** Instanced meshes (one per material) sharing one instance-matrix and glow buffer. */
class IGroup {
  readonly meshes: InstancedMesh[] = [];
  readonly keys: MatKey[] = [];
  matrix: InstancedBufferAttribute;
  glow: InstancedBufferAttribute | null = null;
  iconUv: InstancedBufferAttribute | null = null;
  owners: Int32Array;
  count = 0;
  cap: number;

  constructor(
    readonly name: string,
    readonly level: number,
    readonly members: Member[],
    pieces: Array<[MatKey, BufferGeometry, Material]>,
    into: Group,
    opts: { cap?: number; shadows?: boolean; icon?: boolean; iconUv?: boolean; glowMat?: Material } = {},
  ) {
    this.cap = opts.cap ?? 16;
    this.matrix = new InstancedBufferAttribute(new Float32Array(this.cap * 16), 16);
    this.matrix.setUsage(DynamicDrawUsage);
    this.owners = new Int32Array(this.cap);
    if (pieces.some(([k]) => k === 'glow')) {
      this.glow = new InstancedBufferAttribute(new Float32Array(this.cap * 3), 3);
      this.glow.setUsage(DynamicDrawUsage);
    }
    if (opts.iconUv) {
      this.iconUv = new InstancedBufferAttribute(new Float32Array(this.cap * 2), 2);
      this.iconUv.setUsage(DynamicDrawUsage);
    }
    for (const [key, geo, mat] of pieces) {
      if (this.iconUv) geo.setAttribute('iconUv', this.iconUv);
      const m = new InstancedMesh(geo, mat, this.cap);
      m.instanceMatrix = this.matrix;
      if (key === 'glow') m.instanceColor = this.glow;
      m.name = `${name}/${key}`;
      m.castShadow = !!opts.shadows && SHADOW_MATS.has(key);
      m.userData.castShadow = m.castShadow;
      m.receiveShadow = !opts.icon;
      m.frustumCulled = false;
      m.count = 0;
      m.visible = false;
      if (opts.icon) m.renderOrder = 20;
      into.add(m);
      this.meshes.push(m);
      this.keys.push(key);
    }
  }

  private grow(): void {
    const cap = this.cap * 2;
    const re = (a: InstancedBufferAttribute, n: number) => {
      const b = new InstancedBufferAttribute(new Float32Array(cap * n), n);
      (b.array as Float32Array).set(a.array as Float32Array);
      b.setUsage(DynamicDrawUsage);
      return b;
    };
    this.matrix = re(this.matrix, 16);
    if (this.glow) this.glow = re(this.glow, 3);
    if (this.iconUv) this.iconUv = re(this.iconUv, 2);
    const o = new Int32Array(cap);
    o.set(this.owners);
    this.owners = o;
    this.meshes.forEach((m, i) => {
      m.instanceMatrix = this.matrix;
      if (this.keys[i] === 'glow') m.instanceColor = this.glow;
      if (this.iconUv) m.geometry.setAttribute('iconUv', this.iconUv);
    });
    this.cap = cap;
  }

  /** Next instance slot (offset into the matrix array). */
  slot(turret: number, glow: number): number {
    if (this.count >= this.cap) this.grow();
    const k = this.count++;
    this.owners[k] = turret;
    if (this.glow) {
      const g = this.glow.array as Float32Array;
      g[k * 3] = g[k * 3 + 1] = g[k * 3 + 2] = glow;
    }
    return k * 16;
  }

  commit(): void {
    const n = this.count;
    for (const m of this.meshes) {
      m.count = n;
      m.visible = n > 0;
    }
    if (n === 0) return;
    for (const a of [this.matrix, this.glow, this.iconUv]) {
      if (!a) continue;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }

  get drawCalls(): number {
    return this.count > 0 ? this.meshes.length : 0;
  }

  get shadowCalls(): number {
    if (this.count === 0) return 0;
    let n = 0;
    for (const m of this.meshes) if (m.castShadow) n++;
    return n;
  }

  readback(level: number, out: DrawnEntry[]): void {
    const a = this.matrix.array as Float32Array;
    const tmp = new Float32Array(16);
    for (let k = 0; k < this.count; k++) {
      for (const mem of this.members) {
        writePart(tmp, 0, a.subarray(k * 16, k * 16 + 16), 0, mem.off);
        for (const key of this.keys) if (mem.part.levels[level]!.has(key)) out.push({ turret: this.owners[k]!, part: mem.part.id, mat: key, level, m: tmp.slice() });
      }
    }
  }
}

/** Base class for the instanced strategies (A, B, C). */
abstract class Instanced implements KitRenderer {
  abstract readonly id: StrategyId;
  readonly group = new Group();
  protected groups: IGroup[] = [];
  protected iconGroups: IGroup[] = [];
  protected pivots = new Float32Array(PIVOTS * 16);

  constructor(protected kit: Kit) {}

  abstract push(turret: number, kind: Kind, level: number, x: number, y: number, z: number, yaw: number, pitch: number, recoil: number, spin: number, glow: number, iconScale: number): void;

  protected newGroup(name: string, level: number, members: Member[], pieces: Array<[MatKey, BufferGeometry]>, cap?: number): IGroup {
    const g = new IGroup(
      name,
      level,
      members,
      pieces.map(([k, geo]) => [k, geo, this.kit.mats[k]]),
      this.group,
      { cap, shadows: level <= 1 },
    );
    this.groups.push(g);
    return g;
  }

  protected newIconGroup(name: string, cell: number | null, atlas: Texture, cap?: number): IGroup {
    const g = new IGroup(name, ICON, [], [['ceramic', iconQuad(cell), iconMaterial(atlas, cell === null)]], this.group, { cap, icon: true, iconUv: cell === null });
    this.iconGroups.push(g);
    return g;
  }

  begin(): void {
    for (const g of this.groups) g.count = 0;
    for (const g of this.iconGroups) g.count = 0;
  }

  protected pushIcon(g: IGroup, turret: number, kind: Kind, x: number, y: number, z: number, yaw: number, iconScale: number): void {
    const o = g.slot(turret, 0);
    writeYaw(g.matrix.array as Float32Array, o, x, y + 0.4, z, yaw, iconScale);
    if (g.iconUv) {
      const [u, v] = cellOffset(kind.icon);
      const a = g.iconUv.array as Float32Array;
      a[(o / 16) * 2] = u;
      a[(o / 16) * 2 + 1] = v;
    }
  }

  commit(): void {
    for (const g of this.groups) g.commit();
    for (const g of this.iconGroups) g.commit();
  }

  setMiddleShadows(on: boolean): void {
    for (const g of this.groups) if (g.level === 1) for (const m of g.meshes) m.castShadow = on && m.userData.castShadow;
  }

  get drawCalls(): number {
    let n = 0;
    for (const g of this.groups) n += g.drawCalls;
    for (const g of this.iconGroups) n += g.drawCalls;
    return n;
  }

  get shadowCalls(): number {
    let n = 0;
    for (const g of this.groups) n += g.shadowCalls;
    return n;
  }

  get batches(): number {
    let n = 0;
    for (const g of this.groups) n += g.meshes.length;
    return n + this.iconGroups.length;
  }

  drawn(): DrawnEntry[] {
    const out: DrawnEntry[] = [];
    for (const g of this.groups) g.readback(g.level, out);
    for (const g of this.iconGroups) {
      const a = g.matrix.array as Float32Array;
      for (let k = 0; k < g.count; k++) {
        const uv: [number, number] = g.iconUv ? [(g.iconUv.array as Float32Array)[k * 2]!, (g.iconUv.array as Float32Array)[k * 2 + 1]!] : bakedCell(g.meshes[0]!.geometry);
        out.push({ turret: g.owners[k]!, part: 'icon', mat: 'icon', level: ICON, m: a.slice(k * 16, k * 16 + 16), iconUv: uv });
      }
    }
    return out;
  }

  primeForCompile(on: boolean): void {
    for (const g of [...this.groups, ...this.iconGroups])
      for (const m of g.meshes) {
        m.count = on ? 1 : 0;
        m.visible = on;
      }
  }
}

/** Cell offset baked into an icon quad (its smallest UV). */
function bakedCell(g: BufferGeometry): [number, number] {
  const uv = g.getAttribute('uv').array as Float32Array;
  let u = Infinity;
  let v = Infinity;
  for (let i = 0; i < uv.length; i += 2) {
    u = Math.min(u, uv[i]!);
    v = Math.min(v, uv[i + 1]!);
  }
  return [u, v];
}

const isZero = (o: readonly number[]) => o[0] === 0 && o[1] === 0 && o[2] === 0;

/** Geometry placed by an offset (shared when the offset is zero). */
function placedGeo(g: BufferGeometry, off: readonly [number, number, number]): BufferGeometry {
  return isZero(off) ? g : g.clone().translate(off[0], off[1], off[2]);
}

/** Merges per-material pieces of several placed parts, in order, per material key. */
function mergePieces(list: Array<{ pieces: PieceMap; off: [number, number, number] }>): Array<[MatKey, BufferGeometry]> {
  const by = new Map<MatKey, BufferGeometry[]>();
  for (const { pieces, off } of list)
    for (const [key, g] of pieces) {
      const l = by.get(key) ?? [];
      l.push(placedGeo(g, off));
      by.set(key, l);
    }
  return [...by].map(([k, l]) => [k, l.length === 1 ? l[0]! : mergeGeometries(l, false)!] as [MatKey, BufferGeometry]);
}

// ---- A ----------------------------------------------------------------------------------------------

export class NaivePerKind extends Instanced {
  readonly id = 'A';
  /** Per kind, per level: the kind's groups (one per pivot and offset). */
  private perKind: Array<Array<Array<{ pivot: number; off: [number, number, number]; g: IGroup }>>> = [];
  private icons: IGroup[] = [];

  constructor(kit: Kit, atlas: Texture) {
    super(kit);
    for (const kind of kit.kinds) {
      const levels: Array<Array<{ pivot: number; off: [number, number, number]; g: IGroup }>> = [];
      for (let lv = 0; lv < 3; lv++) {
        // group the kind's parts by pivot and offset, in placing order (W21's levelFrom order);
        // the offset goes into the instance matrix, so geometry stays in part space
        const by = new Map<string, { pivot: number; off: [number, number, number]; list: Array<{ part: KitPart; pieces: PieceMap; off: [number, number, number] }> }>();
        for (const pl of kind.placed) {
          const pieces = pl.part.levels[lv]!;
          if (pieces.size === 0) continue;
          const key = `${pl.pivot[lv]}|${pl.off.join(',')}`;
          const e = by.get(key) ?? { pivot: pl.pivot[lv]!, off: pl.off, list: [] };
          e.list.push({ part: pl.part, pieces, off: [0, 0, 0] });
          by.set(key, e);
        }
        levels.push(
          [...by.values()].map(({ pivot, off, list }) => ({
            pivot,
            off,
            g: this.newGroup(
              `A/${kind.id}/${lv}/${pivot}`,
              lv,
              list.map((l) => ({ part: l.part, off: l.off })),
              mergePieces(list),
            ),
          })),
        );
      }
      this.perKind.push(levels);
      this.icons.push(this.newIconGroup(`A/${kind.id}/icon`, kind.icon, atlas));
    }
  }

  /** The geometry of a kind's batch (for the W21 comparison test). */
  batchGeometry(kind: number, level: number, pivot: number, key: MatKey): BufferGeometry | undefined {
    const e = this.perKind[kind]![level]!.find((x) => x.pivot === pivot && x.off.every((v) => v === 0));
    if (!e) return undefined;
    const i = e.g.keys.indexOf(key);
    return i < 0 ? undefined : e.g.meshes[i]!.geometry;
  }

  push(turret: number, kind: Kind, level: number, x: number, y: number, z: number, yaw: number, pitch: number, recoil: number, spin: number, glow: number, iconScale: number): void {
    if (level === ICON) return this.pushIcon(this.icons[kind.index]!, turret, kind, x, y, z, yaw, iconScale);
    writePivots(this.pivots, kind.frame, x, y, z, yaw, pitch, recoil, spin);
    for (const { pivot, off, g } of this.perKind[kind.index]![level]!) {
      // slot() may grow the buffers, so take the array after it
      const o = g.slot(turret, glow);
      writePart(g.matrix.array as Float32Array, o, this.pivots, pivot, off);
    }
  }
}

// ---- B and C ----------------------------------------------------------------------------------------

interface PartSlot {
  g: IGroup;
  pivot: number;
  off: [number, number, number];
}

export class SharedParts extends Instanced {
  readonly id: StrategyId;
  private perKind: PartSlot[][][] = [];
  private iconOf: IGroup[] = [];
  private oneIcon: IGroup | null = null;

  constructor(kit: Kit, atlas: Texture, merged: boolean) {
    super(kit);
    this.id = merged ? 'C' : 'B';
    const partGroups = new Map<string, IGroup>();
    const partGroup = (p: KitPart, lv: number) => {
      const key = `${p.id}@${lv}`;
      let g = partGroups.get(key);
      if (!g) {
        g = this.newGroup(`${this.id}/${p.id}/${lv}`, lv, [{ part: p, off: [0, 0, 0] }], [...p.levels[lv]!]);
        partGroups.set(key, g);
      }
      return g;
    };
    const plinths = new Map<string, IGroup>();
    for (const kind of kit.kinds) {
      const levels: PartSlot[][] = [];
      for (let lv = 0; lv < 3; lv++) {
        const slots: PartSlot[] = [];
        const still = merged && lv >= 1 ? kind.placed.filter((pl) => pl.pivot[lv] === STATIC || pl.pivot[lv] === PINION0) : [];
        for (const pl of kind.placed) {
          if (still.includes(pl) || pl.part.levels[lv]!.size === 0) continue;
          slots.push({ g: partGroup(pl.part, lv), pivot: pl.pivot[lv]!, off: pl.off });
        }
        if (still.length) {
          // static parts of the kind merged: base + pinion + ring, offsets baked (relative to STATIC)
          const key = `${kind.base}/${kind.ring}@${lv}`;
          let g = plinths.get(key);
          if (!g) {
            const list = still
              .filter((pl) => pl.part.levels[lv]!.size > 0)
              .map((pl) => ({ part: pl.part, pieces: pl.part.levels[lv]!, off: (pl.pivot[lv] === PINION0 ? addOff(kind.frame.pinionAt, pl.off) : pl.off) as [number, number, number] }));
            g = this.newGroup(
              `C/plinth/${key}`,
              lv,
              list.map((l) => ({ part: l.part, off: l.off })),
              mergePieces(list),
            );
            plinths.set(key, g);
          }
          slots.unshift({ g, pivot: STATIC, off: [0, 0, 0] });
        }
        levels.push(slots);
      }
      this.perKind.push(levels);
    }
    if (merged) this.oneIcon = this.newIconGroup('C/icons', null, atlas);
    else {
      const byIcon = kit.icons.map((_, i) => this.newIconGroup(`B/icon/${i}`, i, atlas));
      this.iconOf = kit.kinds.map((k) => byIcon[k.icon]!);
    }
  }

  push(turret: number, kind: Kind, level: number, x: number, y: number, z: number, yaw: number, pitch: number, recoil: number, spin: number, glow: number, iconScale: number): void {
    if (level === ICON) return this.pushIcon(this.oneIcon ?? this.iconOf[kind.index]!, turret, kind, x, y, z, yaw, iconScale);
    writePivots(this.pivots, kind.frame, x, y, z, yaw, pitch, recoil, spin);
    for (const s of this.perKind[kind.index]![level]!) {
      const o = s.g.slot(turret, glow);
      writePart(s.g.matrix.array as Float32Array, o, this.pivots, s.pivot, s.off);
    }
  }
}

function addOff(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
}

// ---- D ----------------------------------------------------------------------------------------------

interface BatchState {
  mesh: BatchedMesh;
  level: number;
  key: MatKey | 'icon';
  count: number;
  prevCount: number;
  /** Geometry id per instance slot as last set, and the turret drawn in it. */
  geo: Int32Array;
  owners: Int32Array;
  matrices: Float32Array;
  colours: Float32Array | null;
  /** Part per geometry id. */
  parts: string[];
}

interface DTarget {
  b: BatchState;
  geoId: number;
}

export class Batched implements KitRenderer {
  readonly id = 'D';
  readonly group = new Group();
  private states: BatchState[] = [];
  private perKind: Array<Array<Array<{ pivot: number; off: [number, number, number]; targets: DTarget[] }>>> = [];
  private icons: BatchState;
  private pivots = new Float32Array(PIVOTS * 16);
  private part = new Float32Array(16);
  /** WEBGL_multi_draw present (else three.js issues one draw per instance). */
  multiDraw = true;

  constructor(kit: Kit, atlas: Texture, maxTurrets: number) {
    const byLevelMat = new Map<string, BatchState>();
    for (let lv = 0; lv < 3; lv++)
      for (const key of MAT_KEYS) {
        const parts = kit.parts.filter((p) => p.levels[lv]!.has(key));
        if (!parts.length) continue;
        // instances: at most every turret × the most parts of this material any kind has
        let most = 0;
        for (const k of kit.kinds) most = Math.max(most, k.placed.filter((pl) => pl.part.levels[lv]!.has(key)).length);
        const geos = parts.map((p) => p.levels[lv]!.get(key)!);
        const verts = geos.reduce((s, g) => s + g.getAttribute('position').count, 0);
        const st = this.newState(lv, key, maxTurrets * most, verts, kit.mats[key], lv <= 1 && SHADOW_MATS.has(key));
        for (const [i, g] of geos.entries()) {
          st.mesh.addGeometry(g);
          st.parts.push(parts[i]!.id);
        }
        byLevelMat.set(`${lv}/${key}`, st);
      }
    // icons: one quad per distinct icon, cell baked into its UVs
    const quads = kit.icons.map((_, i) => iconQuad(i));
    this.icons = this.newState(ICON, 'icon', maxTurrets, quads.length * 6, iconMaterial(atlas, false), false);
    for (const [i, q] of quads.entries()) {
      this.icons.mesh.addGeometry(q);
      this.icons.parts.push(`icon/${i}`);
    }
    this.icons.mesh.renderOrder = 20;
    this.icons.mesh.receiveShadow = false;

    for (const kind of kit.kinds) {
      const levels: Array<Array<{ pivot: number; off: [number, number, number]; targets: DTarget[] }>> = [];
      for (let lv = 0; lv < 3; lv++)
        levels.push(
          kind.placed
            .filter((pl) => pl.part.levels[lv]!.size > 0)
            .map((pl) => ({
              pivot: pl.pivot[lv]!,
              off: pl.off,
              targets: [...pl.part.levels[lv]!.keys()].map((key) => {
                const b = byLevelMat.get(`${lv}/${key}`)!;
                return { b, geoId: b.parts.indexOf(pl.part.id) };
              }),
            })),
        );
      this.perKind.push(levels);
    }
  }

  private newState(level: number, key: MatKey | 'icon', cap: number, verts: number, mat: Material, shadows: boolean): BatchState {
    const mesh = new BatchedMesh(cap, verts, 0, mat);
    mesh.name = `D/${level}/${key}`;
    mesh.perObjectFrustumCulled = false;
    mesh.sortObjects = false;
    mesh.frustumCulled = false;
    mesh.castShadow = shadows;
    mesh.userData.castShadow = shadows;
    mesh.receiveShadow = key !== 'icon';
    mesh.visible = false;
    this.group.add(mesh);
    const st: BatchState = {
      mesh,
      level,
      key,
      count: 0,
      prevCount: 0,
      geo: new Int32Array(cap).fill(-1),
      owners: new Int32Array(cap),
      // three.js keeps instance matrices (and colours) in data textures; written in place here
      matrices: (mesh as unknown as { _matricesTexture: DataTexture })._matricesTexture.image.data as Float32Array,
      colours: null,
      parts: [],
    };
    if (key === 'glow') {
      // per-instance colour (the glow intensity): the texture exists before the first instance
      (mesh as unknown as { _initColorsTexture(): void })._initColorsTexture();
      st.colours = (mesh as unknown as { _colorsTexture: DataTexture })._colorsTexture.image.data as Float32Array;
    }
    this.states.push(st);
    return st;
  }

  begin(): void {
    for (const s of this.states) s.count = 0;
  }

  private slot(b: BatchState, geoId: number, turret: number): number {
    const k = b.count++;
    if (b.geo[k] === -1) {
      b.mesh.addInstance(geoId);
      b.geo[k] = geoId;
    } else if (b.geo[k] !== geoId) {
      b.mesh.setGeometryIdAt(k, geoId);
      b.geo[k] = geoId;
    }
    if (k >= b.prevCount) b.mesh.setVisibleAt(k, true);
    b.owners[k] = turret;
    return k;
  }

  push(turret: number, kind: Kind, level: number, x: number, y: number, z: number, yaw: number, pitch: number, recoil: number, spin: number, glow: number, iconScale: number): void {
    if (level === ICON) {
      const k = this.slot(this.icons, kind.icon, turret);
      writeYaw(this.icons.matrices, k * 16, x, y + 0.4, z, yaw, iconScale);
      return;
    }
    writePivots(this.pivots, kind.frame, x, y, z, yaw, pitch, recoil, spin);
    for (const e of this.perKind[kind.index]![level]!) {
      writePart(this.part, 0, this.pivots, e.pivot, e.off);
      for (const t of e.targets) {
        const k = this.slot(t.b, t.geoId, turret);
        t.b.matrices.set(this.part, k * 16);
        if (t.b.colours) {
          const c = t.b.colours;
          c[k * 4] = c[k * 4 + 1] = c[k * 4 + 2] = glow;
          c[k * 4 + 3] = 1;
        }
      }
    }
  }

  commit(): void {
    for (const s of this.states) {
      for (let k = s.count; k < s.prevCount; k++) s.mesh.setVisibleAt(k, false);
      s.prevCount = s.count;
      s.mesh.visible = s.count > 0;
      if (s.count === 0) continue;
      markRows((s.mesh as unknown as { _matricesTexture: DataTexture })._matricesTexture, s.count * 16);
      if (s.colours) markRows((s.mesh as unknown as { _colorsTexture: DataTexture })._colorsTexture, s.count * 4);
    }
  }

  setMiddleShadows(on: boolean): void {
    for (const s of this.states) if (s.level === 1) s.mesh.castShadow = on && s.mesh.userData.castShadow;
  }

  get drawCalls(): number {
    let n = 0;
    for (const s of this.states) if (s.count > 0) n += this.multiDraw ? 1 : s.count;
    return n;
  }

  get shadowCalls(): number {
    let n = 0;
    for (const s of this.states) if (s.count > 0 && s.mesh.castShadow) n += this.multiDraw ? 1 : s.count;
    return n;
  }

  get batches(): number {
    return this.states.length;
  }

  drawn(): DrawnEntry[] {
    const out: DrawnEntry[] = [];
    for (const s of this.states)
      for (let k = 0; k < s.count; k++) {
        const m = s.matrices.slice(k * 16, k * 16 + 16);
        if (s.key === 'icon') out.push({ turret: s.owners[k]!, part: 'icon', mat: 'icon', level: ICON, m, iconUv: cellOffset(s.geo[k]!) });
        else out.push({ turret: s.owners[k]!, part: s.parts[s.geo[k]!]!, mat: s.key, level: s.level, m });
      }
    return out;
  }

  /** Visible instance slots of a mesh (for checks). */
  visibleSlots(): Array<{ name: string; visible: number; count: number }> {
    return this.states.map((s) => {
      let v = 0;
      for (let k = 0; k < s.mesh.instanceCount; k++) if (s.mesh.getVisibleAt(k)) v++;
      return { name: s.mesh.name, visible: v, count: s.count };
    });
  }

  primeForCompile(on: boolean): void {
    for (const s of this.states) {
      if (on && s.mesh.instanceCount === 0) {
        s.mesh.addInstance(0);
        s.geo[0] = 0;
        s.mesh.setVisibleAt(0, false);
      }
      s.mesh.visible = on || s.count > 0;
    }
  }
}

/** Marks the rows of a data texture that hold the first `floats` values for upload. */
function markRows(t: DataTexture, floats: number): void {
  const rowFloats = t.image.width * 4;
  const rows = Math.ceil(floats / rowFloats);
  t.needsUpdate = true;
  // few rows: upload just those (one texSubImage2D each); many: the whole texture in one call
  t.clearUpdateRanges();
  if (rows <= 8) for (let r = 0; r < rows; r++) t.addUpdateRange(r * rowFloats, rowFloats);
}

export function createStrategies(kit: Kit, atlas: Texture, maxTurrets: number): Record<StrategyId, KitRenderer> {
  return {
    A: new NaivePerKind(kit, atlas),
    B: new SharedParts(kit, atlas, false),
    C: new SharedParts(kit, atlas, true),
    D: new Batched(kit, atlas, maxTurrets),
  };
}
