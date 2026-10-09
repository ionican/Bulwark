// W25: the selected units' order queues, drawn from the snapshot's queue section (snapshot.ts).
//
// For each selected unit: a line from the unit through each queued target in order, an arrowhead
// at each target pointing along the line, and a numbered label on each target giving its position
// in that unit's queue. Where several selected units share an item (the same building, wall run or
// wreck), one label lists their positions ("1, 3"). Nothing is drawn for unselected units, nor for
// produce orders (they point at the commander itself) or targets that no longer exist.
//
// Colour-blind safe (Richard): order and direction are carried by the numbers and the arrowheads,
// and units are told apart by the dash pattern of their line (long dashes, short dashes, dash-dot,
// by their order among the selected units; the queue panel names it), never by colour. Light cream
// marks with a dark edge, readable on any ground.
//
// W25c (review finding 2): the cost is bounded. It used to expand every selected path into one
// instance per dash every frame, off-screen sections included, with a label per move (256 units ×
// 64 orders: 6.66 M instances, 514 MiB, about 164 ms per update). Now:
//   - dashes are drawn by a shader: each straight leg between two points is cut into pieces of at
//     most PIECE tiles (so the marks follow the ground), and one instance per piece carries the
//     leg's dash pattern; the fragment shader draws the dashes, their dark edge and the gaps;
//   - only the part of each leg inside the camera's view (plus a margin) gets pieces or an arrowhead;
//   - the pieces, arrowheads and labels are rebuilt only when the selection, the selected units'
//     queues or the camera change; each unit's first leg (from the unit to its first target) is a
//     separate small layer, redrawn when a unit moves, so walking builders do not rebuild the rest;
//   - at most QUEUE_MAX_LABELS (200) labels are drawn, those for the earliest queue positions in
//     view, and a "+N more" note at the top centre of the view counts the rest in view;
//   - every instanced mesh has a fixed capacity, together QUEUE_MAX_INSTANCES; legs beyond it are
//     left out, the latest queue positions first.
//
// Scene graph: one thin dark centre line for all paths (`queue/paths`, LineSegments; userData.paths
// lists each unit's points), the dash pieces (`overlay/queue/dash`, `overlay/queue/dash-first`) and
// arrowheads with their edges (`overlay/queue/arrow…`, so the model inspection counts them as
// overlays), a sprite per label (`queue/label`, its text in userData.text) and the note
// (`queue/more`). inspectQueue reads all of it back from the scene (tests, __game.inspectQueue).

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshBasicMaterial,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  Texture,
  Vector3,
  Vector4,
  type Material,
  type Object3D,
  type PerspectiveCamera,
} from 'three';
import { Q_PRODUCE, Q_RECLAIM, Q_RUN } from '../sim/schema.ts';
import type { Terrain } from '../sim/terrain.ts';
import type { Snapshot } from '../sim/snapshot.ts';
import { groundHeight } from './ground.ts';
import { worldPerPixel } from './cameraRig.ts';
import type { MobileView } from './interp.ts';
import type { Pick } from './picking.ts';

export interface QueueFrame {
  camera: PerspectiveCamera;
  viewportHeight: number;
  snapshot: Snapshot;
  /** Interpolated unit positions (the line starts at the drawn unit). */
  units: MobileView;
  selection: readonly Pick[];
}

/** A label's texture and its width ÷ height. */
export type LabelTexture = (text: string) => { texture: Texture; aspect: number };

/** Dash patterns, [on, off, on, off] in screen-scaled tiles (see `scale` below): long, short, dash-dot. */
const DASHES: number[][] = [
  [0.9, 0.45, 0, 0],
  [0.3, 0.3, 0, 0],
  [0.9, 0.3, 0.2, 0.3],
];
/** The dash patterns in words, for the queue panel; the n-th unit in the selection gets DASHES[n % 3]. */
export const DASH_NAMES = ['long dashes', 'short dashes', 'dash-dot'] as const;
/** Line, dash and arrowhead sizes in screen-scaled tiles. */
const DASH_WIDTH = 0.16;
const EDGE = 0.07; // the dark edge round each light mark
const ARROW_LENGTH = 0.75;
const ARROW_HALF_WIDTH = 0.45;
/** On-screen label height (CSS px) and how far above the ground it floats (tiles). */
const LABEL_PX = 22;
const LABEL_LIFT = 1.6;
/** Marks lie this far above the ground (tiles), clear of the dotted site outlines (entities.ts: 0.1). */
const LIFT = 0.22;
/** About 16 px per screen-scaled tile: the marks keep their screen size when zoomed out. */
const PX_PER_UNIT = 16;
const LIGHT = '#f4efe6';
const DARK = '#120f0d';

/** Longest dash piece (tiles): the ground is sampled at each piece's ends. */
const PIECE = 8;
/** Legs and labels within this distance (tiles) outside the view still count as in view. */
const MARGIN = 2;
/** W25c caps (header). */
export const QUEUE_MAX_LABELS = 200;
const DASH_CAP = 16_384;
const ARROW_CAP = 4_096;
const FIRST_DASH_CAP = 2_048;
const FIRST_ARROW_CAP = 256;
/** Every instance the overlay can create, all its instanced meshes together (allocated once). */
export const QUEUE_MAX_INSTANCES = DASH_CAP + 2 * ARROW_CAP + FIRST_DASH_CAP + 2 * FIRST_ARROW_CAP;

/** Flat triangle with its tip at the origin, pointing +x, base at x = -1, half-width 1. */
function arrowGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, -1, 0, 1, -1, 0, -1]), 3));
  g.setIndex([0, 2, 1]);
  return g;
}

/** Flat quad from x 0..1 (along a piece), z -1..1 (across it). */
function pieceGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, -1, 1, 0, -1, 1, 0, 1, 0, 0, 1]), 3));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}

/**
 * The dash shader. Per instance (a piece of a leg): instanceMatrix maps the quad onto the piece
 * (x axis: start to end; z axis: across, the half-width; translation: the start), and iDash holds
 * (distance of the piece's start from the leg's start, the leg's length, the screen-scaled tile,
 * the dash pattern). The pattern restarts at each leg, so every leg starts with a dash, and the
 * dashes stop short of the arrowhead, as the instanced dashes did before W25c.
 */
function dashMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    name: 'queue/dash',
    uniforms: {
      uPat: { value: DASHES.map((p) => new Vector4(p[0], p[1], p[2], p[3])) },
      uLight: { value: new Color(LIGHT) },
      uDark: { value: new Color(DARK) },
      uEdge: { value: EDGE },
      uCore: { value: DASH_WIDTH / 2 },
      uArrow: { value: ARROW_LENGTH },
    },
    vertexShader: /* glsl */ `
      attribute vec4 iDash;
      varying float vAlong;
      varying float vAcross;
      varying vec4 vDash;
      void main() {
        vAlong = iDash.x + position.x * length(instanceMatrix[0].xz);
        vAcross = position.z;
        vDash = iDash;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec4 uPat[3];
      uniform vec3 uLight;
      uniform vec3 uDark;
      uniform float uEdge;
      uniform float uCore;
      uniform float uArrow;
      varying float vAlong;
      varying float vAcross;
      varying vec4 vDash;
      // signed distance from t to the interval [a, b] (negative inside)
      float sdi(float t, float a, float b) { return max(a - t, t - b); }
      void main() {
        float s = vDash.z;
        if (vAlong > vDash.y - uArrow * s) discard;
        vec4 p = uPat[int(vDash.w + 0.5)];
        float period = p.x + p.y + p.z + p.w;
        float t = mod(vAlong / s, period);
        float d = min(sdi(t, 0.0, p.x), sdi(t, period, period + p.x));
        if (p.z > 0.0) d = min(d, sdi(t, p.x + p.y, p.x + p.y + p.z));
        if (d > uEdge) discard;
        bool core = d <= 0.0 && abs(vAcross) * (uCore + uEdge) <= uCore;
        gl_FragColor = vec4(core ? uLight : uDark, 1.0);
        #include <colorspace_fragment>
      }`,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
  });
}

/** Instanced marks with a fixed capacity, refilled from zero when their layer is redrawn. */
class Marks {
  readonly mesh: InstancedMesh;
  /** Per-instance dash data (pieces only). */
  readonly dash: InstancedBufferAttribute | null;
  private n = 0;
  /** Marks left out last time because the capacity was reached. */
  dropped = 0;

  constructor(parent: Object3D, geometry: BufferGeometry, material: Material, name: string, order: number, readonly capacity: number, pieces: boolean) {
    this.dash = pieces ? new InstancedBufferAttribute(new Float32Array(capacity * 4), 4) : null;
    if (this.dash) geometry.setAttribute('iDash', this.dash);
    const m = new InstancedMesh(geometry, material, capacity);
    m.name = name;
    m.frustumCulled = false;
    m.renderOrder = order;
    m.count = 0;
    m.visible = false;
    parent.add(m);
    this.mesh = m;
  }

  reset() {
    this.n = 0;
    this.dropped = 0;
  }

  get full() {
    return this.n >= this.capacity;
  }

  /** An arrowhead (or any flat mark) at (x, y, z) along the unit direction (dx, dz): length `sx`, width `sz`. */
  push(x: number, y: number, z: number, dx: number, dz: number, sx: number, sz: number): boolean {
    if (this.full) {
      this.dropped++;
      return false;
    }
    // translate · rotateY · scale, with local +x onto (dx, dz) (entities.ts writeM, c = dx, s = -dz)
    this.write(dx * sx, 0, dz * sx, -dz * sz, dx * sz, x, y, z);
    this.n++;
    return true;
  }

  /** A dash piece from a to b: `along0` from the leg's start, `leg` its length, `scale` the screen-scaled tile, `pattern`. */
  piece(ax: number, ay: number, az: number, bx: number, by: number, bz: number, dx: number, dz: number, along0: number, leg: number, scale: number, pattern: number): boolean {
    if (this.full) {
      this.dropped++;
      return false;
    }
    const hw = (DASH_WIDTH / 2 + EDGE) * scale;
    this.write(bx - ax, by - ay, bz - az, -dz * hw, dx * hw, ax, ay, az);
    const d = this.dash!.array as Float32Array;
    const o = this.n * 4;
    d[o] = along0;
    d[o + 1] = leg;
    d[o + 2] = scale;
    d[o + 3] = pattern;
    this.n++;
    return true;
  }

  /** Column-major: x axis (c0x, c0y, c0z), y axis up, z axis (c2x, 0, c2z), translation (tx, ty, tz). */
  private write(c0x: number, c0y: number, c0z: number, c2x: number, c2z: number, tx: number, ty: number, tz: number) {
    const a = this.mesh.instanceMatrix.array as Float32Array;
    const o = this.n * 16;
    a[o] = c0x;
    a[o + 1] = c0y;
    a[o + 2] = c0z;
    a[o + 3] = 0;
    a[o + 4] = 0;
    a[o + 5] = 1;
    a[o + 6] = 0;
    a[o + 7] = 0;
    a[o + 8] = c2x;
    a[o + 9] = 0;
    a[o + 10] = c2z;
    a[o + 11] = 0;
    a[o + 12] = tx;
    a[o + 13] = ty;
    a[o + 14] = tz;
    a[o + 15] = 1;
  }

  commit() {
    const m = this.mesh;
    m.count = this.n;
    m.visible = this.n > 0;
    if (this.n > 0) {
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, this.n * 16);
      m.instanceMatrix.needsUpdate = true;
      if (this.dash) {
        this.dash.clearUpdateRanges();
        this.dash.addUpdateRange(0, this.n * 4);
        this.dash.needsUpdate = true;
      }
    }
  }

  get count() {
    return this.n;
  }
}

/** The texts kept by canvasLabel; older ones are disposed (a "+N more" count can take many values). */
const LABEL_CACHE = 512;

/** Browser label: the text in bold on a dark rounded box with a light edge (cached per text, least recently used out). */
export function canvasLabel(): LabelTexture {
  const cache = new Map<string, { texture: Texture; aspect: number }>();
  return (text) => {
    let t = cache.get(text);
    if (t) {
      cache.delete(text);
      cache.set(text, t);
      return t;
    }
    const h = 64;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    const font = `700 ${Math.round(h * 0.62)}px ui-monospace, Menlo, monospace`;
    ctx.font = font;
    const w = Math.max(h, Math.ceil(ctx.measureText(text).width + h * 0.6));
    c.width = w;
    c.height = h;
    ctx.font = font;
    const r = h * 0.28;
    ctx.beginPath();
    ctx.roundRect(3, 3, w - 6, h - 6, r);
    ctx.fillStyle = DARK;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = LIGHT;
    ctx.stroke();
    ctx.fillStyle = LIGHT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 2);
    const texture = new CanvasTexture(c);
    t = { texture, aspect: w / h };
    cache.set(text, t);
    // at most QUEUE_MAX_LABELS + 1 texts are on screen at once, well under the cache size
    if (cache.size > LABEL_CACHE) {
      const [oldest, entry] = cache.entries().next().value!;
      cache.delete(oldest);
      entry.texture.dispose();
    }
    return t;
  };
}

/** Node (tests): a blank texture per text, the aspect a canvas label would roughly have. */
export const blankLabel: LabelTexture = (text) => ({ texture: new Texture(), aspect: Math.max(1, 0.4 + text.length * 0.42) });

/** One selected unit's path: its queued targets (lifted ground points) after the unit itself. */
interface Path {
  unit: number;
  pattern: number;
  /** Targets in queue order: x, z and the lifted ground height y. */
  x: number[];
  z: number[];
  y: number[];
  /** Where the unit was drawn when its first leg was last written. */
  sx: number;
  sz: number;
  /** First vertex of this path in the centre line. */
  line: number;
}

interface Label {
  x: number;
  y: number;
  z: number;
  text: string;
}

const _m = new Matrix4();
const _v = new Vector3();
const _frustum = new Frustum();

export class QueueOverlay {
  readonly group = new Group();
  private readonly terrain: Terrain;
  private readonly label: LabelTexture;
  private readonly line: LineSegments;
  private readonly sprites: Sprite[] = [];
  private readonly more: Sprite;
  private readonly dash: Marks;
  private readonly arrowEdge: Marks;
  private readonly arrow: Marks;
  private readonly firstDash: Marks;
  private readonly firstArrowEdge: Marks;
  private readonly firstArrow: Marks;

  // ---- the cache (header): what the drawing was made from
  private paths: Path[] = [];
  /** Labels in drawing priority: earliest queue position first. */
  private labels: Label[] = [];
  private snap: Snapshot | null = null;
  private selIds: number[] = [];
  private sig = new Float64Array(0);
  private sigLen = 0;
  private readonly camKey = new Float64Array(33);
  private rowsOf: Uint32Array | null = null;
  private readonly rowOf = new Map<number, number>();
  /** Labels in view but left out by the cap, last time the labels were placed. */
  hiddenLabels = 0;

  constructor(parent: Object3D, terrain: Terrain, label: LabelTexture = blankLabel) {
    this.terrain = terrain;
    this.label = label;
    this.group.name = 'queue';
    parent.add(this.group);
    const dashMat = dashMaterial();
    const tri = arrowGeometry();
    const dark = new MeshBasicMaterial({ color: DARK, depthTest: false, depthWrite: false, toneMapped: false });
    const light = new MeshBasicMaterial({ color: LIGHT, depthTest: false, depthWrite: false, toneMapped: false });
    // render orders above the W13 overlays (markers 15) and the ghost (16)
    this.dash = new Marks(this.group, pieceGeometry(), dashMat, 'overlay/queue/dash', 18, DASH_CAP, true);
    this.arrowEdge = new Marks(this.group, tri, dark, 'overlay/queue/arrow-edge', 17, ARROW_CAP, false);
    this.arrow = new Marks(this.group, tri, light, 'overlay/queue/arrow', 18, ARROW_CAP, false);
    this.firstDash = new Marks(this.group, pieceGeometry(), dashMat, 'overlay/queue/dash-first', 18, FIRST_DASH_CAP, true);
    this.firstArrowEdge = new Marks(this.group, tri, dark, 'overlay/queue/arrow-edge-first', 17, FIRST_ARROW_CAP, false);
    this.firstArrow = new Marks(this.group, tri, light, 'overlay/queue/arrow-first', 18, FIRST_ARROW_CAP, false);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(0), 3));
    this.line = new LineSegments(g, new LineBasicMaterial({ color: DARK, depthTest: false, depthWrite: false, toneMapped: false }));
    this.line.name = 'queue/paths';
    this.line.frustumCulled = false;
    this.line.renderOrder = 16;
    this.line.visible = false;
    this.line.userData.paths = [];
    this.group.add(this.line);
    this.more = this.sprite('queue/more');
  }

  private sprite(name: string): Sprite {
    const s = new Sprite(new SpriteMaterial({ depthTest: false, depthWrite: false, sizeAttenuation: false, toneMapped: false, transparent: true }));
    s.name = name;
    s.renderOrder = 19;
    s.frustumCulled = false;
    s.visible = false;
    this.group.add(s);
    return s;
  }

  private spriteFor(i: number): Sprite {
    return (this.sprites[i] ??= this.sprite('queue/label'));
  }

  update(f: QueueFrame): void {
    const camera = f.camera;
    // 1. the selection and the selected units' queues: rebuild the paths when either changed
    let selChanged = false;
    let k = 0;
    for (const p of f.selection) {
      if (p.type !== 'unit') continue;
      if (this.selIds[k] !== p.id) selChanged = true;
      this.selIds[k++] = p.id;
    }
    if (this.selIds.length !== k) selChanged = true;
    this.selIds.length = k;
    let rebuilt = false;
    if (selChanged || f.snapshot !== this.snap) {
      this.snap = f.snapshot;
      if (this.signature(f.snapshot) || selChanged) {
        this.rebuild(f);
        rebuilt = true;
      }
    }
    // 2. the camera
    const ck = this.camKey;
    const e1 = camera.matrixWorld.elements;
    const e2 = camera.projectionMatrix.elements;
    let camChanged = ck[32] !== f.viewportHeight;
    for (let i = 0; i < 16 && !camChanged; i++) camChanged = ck[i] !== e1[i] || ck[16 + i] !== e2[i];
    if (camChanged) {
      for (let i = 0; i < 16; i++) {
        ck[i] = e1[i]!;
        ck[16 + i] = e2[i]!;
      }
      ck[32] = f.viewportHeight;
    }
    if (rebuilt || camChanged) {
      _frustum.setFromProjectionMatrix(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      this.drawLegs(camera, f.viewportHeight);
    }
    // 3. the units: each first leg starts at the drawn unit
    if (this.moveStarts(f, rebuilt) || rebuilt || camChanged) {
      if (!(rebuilt || camChanged)) _frustum.setFromProjectionMatrix(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      this.drawFirstLegs(camera, f.viewportHeight);
    }
  }

  /** Writes the selected units' queues into `sig`; true if they differ from the last call's. */
  private signature(snap: Snapshot): boolean {
    const q = snap.queues;
    let n = 1 + this.selIds.length * 2;
    const rows: number[] = [];
    for (const id of this.selIds) {
      const row = indexOf(snap.units.id, snap.units.count, id);
      rows.push(row);
      if (row >= 0) n += q.count[row]! * 5;
    }
    if (this.sig.length < n) {
      const grown = new Float64Array(Math.max(n, this.sig.length * 2));
      grown.set(this.sig.subarray(0, this.sigLen));
      this.sig = grown;
    }
    const s = this.sig;
    let changed = n !== this.sigLen;
    let o = 0;
    const put = (v: number) => {
      if (s[o] !== v) {
        changed = true;
        s[o] = v;
      }
      o++;
    };
    put(this.selIds.length);
    this.selIds.forEach((id, i) => {
      const row = rows[i]!;
      put(id);
      put(row < 0 ? -1 : q.count[row]!);
      if (row < 0) return;
      for (let j = q.first[row]!, end = j + q.count[row]!; j < end; j++) {
        put(q.kind[j]!);
        put(q.target[j]!);
        put(q.run[j]!);
        put(q.x[j]!);
        put(q.z[j]!);
      }
    });
    this.sigLen = n;
    return changed;
  }

  /** The paths, labels and centre line from the snapshot's queues for the selection. */
  private rebuild(f: QueueFrame): void {
    const snap = f.snapshot;
    const q = snap.queues;
    const t = this.terrain;
    const paths: Path[] = [];
    const byKey = new Map<string, { x: number; z: number; positions: number[]; rank: number; order: number }>();
    let nth = -1;
    for (const id of this.selIds) {
      nth++;
      const row = indexOf(snap.units.id, snap.units.count, id);
      if (row < 0) continue;
      const p: Path = { unit: id, pattern: nth % DASHES.length, x: [], z: [], y: [], sx: NaN, sz: NaN, line: 0 };
      for (let i = q.first[row]!, k = 0, end = i + q.count[row]!; i < end; i++, k++) {
        const kind = q.kind[i]!;
        const x = q.x[i]!;
        const z = q.z[i]!;
        if (kind === Q_PRODUCE || x < 0 || z < 0) continue;
        p.x.push(x);
        p.z.push(z);
        p.y.push(groundHeight(t, x, z) + LIFT);
        const key = kind === Q_RUN ? `r${q.run[i]}` : q.target[i]! >= 0 ? `${kind === Q_RECLAIM ? 'w' : 'b'}${q.target[i]}` : `m${id}:${k}`;
        let l = byKey.get(key);
        if (!l) byKey.set(key, (l = { x, z, positions: [], rank: k + 1, order: byKey.size }));
        if (!l.positions.includes(k + 1)) l.positions.push(k + 1);
        l.rank = Math.min(l.rank, k + 1);
      }
      if (p.x.length) paths.push(p);
    }
    this.paths = paths;
    this.labels = [...byKey.values()]
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .map((l) => ({ x: l.x, z: l.z, y: groundHeight(t, l.x, l.z) + LABEL_LIFT, text: l.positions.sort((a, b) => a - b).join(', ') }));
    // centre line: segment pairs, unit → target 1 → … (the first vertex follows the unit, moveStarts)
    let verts = 0;
    for (const p of paths) verts += p.x.length * 2;
    let pos = this.line.geometry.getAttribute('position') as BufferAttribute;
    if (pos.count < verts) {
      pos = new BufferAttribute(new Float32Array(Math.max(verts, pos.count * 2) * 3), 3);
      this.line.geometry.setAttribute('position', pos);
    }
    const a = pos.array as Float32Array;
    let v = 0;
    const index: Array<{ unit: number; first: number; points: number }> = [];
    for (const p of paths) {
      p.line = v;
      index.push({ unit: p.unit, first: v, points: p.x.length + 1 });
      for (let i = 0; i < p.x.length; i++) {
        // pair (previous point, target i); the unit's own point is written by moveStarts
        if (i > 0) a.set([p.x[i - 1]!, p.y[i - 1]!, p.z[i - 1]!], v * 3);
        a.set([p.x[i]!, p.y[i]!, p.z[i]!], (v + 1) * 3);
        v += 2;
      }
      p.sx = NaN; // the first leg is written afresh
    }
    pos.clearUpdateRanges();
    pos.needsUpdate = true;
    this.line.geometry.setDrawRange(0, v);
    this.line.visible = v > 0;
    this.line.userData.paths = index;
  }

  /** Moves each path's first point to its drawn unit; true if any moved. `whole`: the line is uploaded whole anyway. */
  private moveStarts(f: QueueFrame, whole: boolean): boolean {
    if (!this.paths.length) return false;
    const u = f.units;
    if (this.rowsOf !== u.id) {
      this.rowsOf = u.id;
      this.rowOf.clear();
      for (let r = 0; r < u.count; r++) this.rowOf.set(u.id[r]!, r);
    }
    const pos = this.line.geometry.getAttribute('position') as BufferAttribute;
    const a = pos.array as Float32Array;
    let moved = false;
    for (const p of this.paths) {
      const r = this.rowOf.get(p.unit);
      let x: number;
      let z: number;
      if (r !== undefined && r < u.count) {
        x = u.x[r]!;
        z = u.z[r]!;
      } else {
        const sr = indexOf(f.snapshot.units.id, f.snapshot.units.count, p.unit);
        if (sr < 0) continue;
        x = f.snapshot.units.cols.x[sr]!;
        z = f.snapshot.units.cols.z[sr]!;
      }
      if (x === p.sx && z === p.sz) continue;
      p.sx = x;
      p.sz = z;
      a[p.line * 3] = x;
      a[p.line * 3 + 1] = groundHeight(this.terrain, x, z) + LIFT;
      a[p.line * 3 + 2] = z;
      if (!whole) pos.addUpdateRange(p.line * 3, 3); // three.js clears the ranges once uploaded
      moved = true;
    }
    if (moved) pos.needsUpdate = true;
    return moved;
  }

  /** Every leg after the first, their arrowheads and the labels, for the view (`_frustum` is set). */
  private drawLegs(camera: PerspectiveCamera, vh: number): void {
    for (const m of [this.dash, this.arrowEdge, this.arrow]) m.reset();
    let longest = 0;
    for (const p of this.paths) longest = Math.max(longest, p.x.length);
    // queue position by queue position, so the cap leaves out the latest legs first
    for (let i = 1; i < longest; i++) {
      for (const p of this.paths) {
        if (i >= p.x.length) continue;
        this.leg(camera, vh, this.dash, this.arrowEdge, this.arrow, p.pattern, p.x[i - 1]!, p.y[i - 1]!, p.z[i - 1]!, p.x[i]!, p.y[i]!, p.z[i]!);
      }
    }
    for (const m of [this.dash, this.arrowEdge, this.arrow]) m.commit();
    this.placeLabels(camera, vh);
  }

  /** Each unit's first leg, from where it is drawn now. */
  private drawFirstLegs(camera: PerspectiveCamera, vh: number): void {
    for (const m of [this.firstDash, this.firstArrowEdge, this.firstArrow]) m.reset();
    for (const p of this.paths) {
      if (Number.isNaN(p.sx)) continue;
      const sy = groundHeight(this.terrain, p.sx, p.sz) + LIFT;
      this.leg(camera, vh, this.firstDash, this.firstArrowEdge, this.firstArrow, p.pattern, p.sx, sy, p.sz, p.x[0]!, p.y[0]!, p.z[0]!);
    }
    for (const m of [this.firstDash, this.firstArrowEdge, this.firstArrow]) m.commit();
  }

  /**
   * One leg from a to b: the part inside the view (plus MARGIN) cut into pieces of at most PIECE
   * tiles on the ground, and the arrowhead at b if b is in view. The screen-scaled tile is worked out
   * at the leg's start.
   */
  private leg(camera: PerspectiveCamera, vh: number, dash: Marks, edge: Marks, arrow: Marks, pattern: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) return;
    // clip the straight leg to the view: t0..t1 of 0..1
    let t0 = 0;
    let t1 = 1;
    for (const pl of _frustum.planes) {
      const da = pl.normal.x * ax + pl.normal.y * ay + pl.normal.z * az + pl.constant + MARGIN;
      const db = pl.normal.x * bx + pl.normal.y * by + pl.normal.z * bz + pl.constant + MARGIN;
      if (da < 0 && db < 0) return;
      if (da < 0) t0 = Math.max(t0, da / (da - db));
      else if (db < 0) t1 = Math.min(t1, da / (da - db));
    }
    if (t0 >= t1) return;
    const c = camera.position;
    const scale = Math.max(1, worldPerPixel(camera, Math.hypot(ax - c.x, ay - c.y, az - c.z), vh) * PX_PER_UNIT);
    const dx = (bx - ax) / len;
    const dz = (bz - az) / len;
    const t = this.terrain;
    const s0 = t0 * len;
    const s1 = Math.min(t1 * len, len - ARROW_LENGTH * scale);
    if (s1 > s0) {
      const n = Math.ceil((s1 - s0) / PIECE);
      let px = ax + dx * s0;
      let pz = az + dz * s0;
      let py = groundHeight(t, px, pz) + LIFT;
      for (let i = 1; i <= n; i++) {
        const s = s0 + ((s1 - s0) * i) / n;
        const qx = ax + dx * s;
        const qz = az + dz * s;
        const qy = groundHeight(t, qx, qz) + LIFT;
        if (!dash.piece(px, py, pz, qx, qy, qz, dx, dz, s0 + ((s1 - s0) * (i - 1)) / n, len, scale, pattern)) break;
        px = qx;
        py = qy;
        pz = qz;
      }
    }
    if (t1 >= 1) {
      const e = EDGE * scale;
      edge.push(bx + dx * e * 1.6, by, bz + dz * e * 1.6, dx, dz, (ARROW_LENGTH + 2.4 * EDGE) * scale, (ARROW_HALF_WIDTH + 1.6 * EDGE) * scale);
      arrow.push(bx, by + 0.01, bz, dx, dz, ARROW_LENGTH * scale, ARROW_HALF_WIDTH * scale);
    }
  }

  /** Labels in view, earliest queue position first, at most QUEUE_MAX_LABELS; the note counts the rest. */
  private placeLabels(camera: PerspectiveCamera, vh: number): void {
    // screen-sized (sizeAttenuation off: scale × 1/tan(fov/2) is the height in normalised device
    // units, 2 = the viewport)
    const f2 = 1 / Math.tan(((camera.fov * Math.PI) / 180) / 2);
    const h = ((LABEL_PX / vh) * 2) / f2;
    let shown = 0;
    let hidden = 0;
    for (const l of this.labels) {
      if (!_frustum.containsPoint(_v.set(l.x, l.y, l.z))) continue;
      if (shown >= QUEUE_MAX_LABELS) {
        hidden++;
        continue;
      }
      this.show(this.spriteFor(shown++), l.text, l.x, l.y, l.z, h);
    }
    for (let i = shown; i < this.sprites.length; i++) this.sprites[i]!.visible = false;
    this.hiddenLabels = hidden;
    if (hidden > 0) {
      // top centre of the view, under the sandbox banner and clear of the bottom panels, in front of the camera
      _v.set(0, 0.78, 0.5).unproject(camera);
      this.show(this.more, `+${hidden} more`, _v.x, _v.y, _v.z, h);
    } else this.more.visible = false;
  }

  private show(s: Sprite, text: string, x: number, y: number, z: number, h: number): void {
    if (s.userData.text !== text || !s.material.map) {
      const tex = this.label(text);
      s.material.map = tex.texture;
      s.material.needsUpdate = true;
      s.userData.text = text;
      s.userData.aspect = tex.aspect;
    }
    s.position.set(x, y, z);
    s.scale.set(h * (s.userData.aspect as number), h, 1);
    s.visible = true;
  }

  /** Dash pieces and arrowheads left out by the caps when the layers were last drawn. */
  get dropped(): number {
    return this.dash.dropped + this.arrow.dropped + this.firstDash.dropped + this.firstArrow.dropped;
  }

  /** Arrowheads drawn last update (one per leg end in view). */
  get arrows(): number {
    return this.arrow.count + this.firstArrow.count;
  }
}

function indexOf(ids: Uint32Array, count: number, id: number): number {
  for (let r = 0; r < count; r++) if (ids[r] === id) return r;
  return -1;
}

export interface QueueInspection {
  /** Per drawn path: the unit and its points (x, z) in order, the unit first. */
  paths: Array<{ unit: number; points: Array<[number, number]> }>;
  /** Visible labels: text and ground position. */
  labels: Array<{ text: string; x: number; z: number }>;
  /** Arrowhead instances submitted. */
  arrows: number;
  /** The "+N more" note, or null. */
  more: string | null;
  /** Instances submitted by every instanced mesh of the overlay. */
  instances: number;
}

/** Reads the queue drawing back from the scene graph (what is submitted, not a renderer report). */
export function inspectQueue(root: Object3D): QueueInspection {
  const out: QueueInspection = { paths: [], labels: [], arrows: 0, more: null, instances: 0 };
  const v = new Vector3();
  root.updateMatrixWorld(true);
  root.traverseVisible((o) => {
    if (o instanceof LineSegments && o.name === 'queue/paths') {
      const pos = o.geometry.getAttribute('position') as BufferAttribute;
      for (const p of o.userData.paths as Array<{ unit: number; first: number; points: number }>) {
        const points: Array<[number, number]> = [];
        // segment pairs: the first vertex of each pair, then the last pair's second vertex
        for (let i = 0; i < p.points; i++) {
          v.fromBufferAttribute(pos, i < p.points - 1 ? p.first + 2 * i : p.first + 2 * (i - 1) + 1).applyMatrix4(o.matrixWorld);
          points.push([v.x, v.z]);
        }
        out.paths.push({ unit: p.unit, points });
      }
    } else if (o instanceof Sprite && o.name === 'queue/label') {
      o.getWorldPosition(v);
      out.labels.push({ text: String(o.userData.text), x: v.x, z: v.z });
    } else if (o instanceof Sprite && o.name === 'queue/more') out.more = String(o.userData.text);
    else if (o instanceof InstancedMesh && o.name.startsWith('overlay/queue/')) {
      out.instances += o.count;
      if (o.name === 'overlay/queue/arrow' || o.name === 'overlay/queue/arrow-first') out.arrows += o.count;
    }
  });
  return out;
}
