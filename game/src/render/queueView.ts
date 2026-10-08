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
// by their order among the selected units; the queue panel names it), never by colour. Light cream marks with a dark edge, readable on any ground.
//
// Scene graph: a thin dark centre line per unit (`queue/path/<unit id>`, a Line whose positions are
// the path's points in order), instanced dash and arrowhead quads over it (`overlay/queue/…`, so the
// model inspection counts them as overlays), and a sprite per label (`queue/label`, its text in
// userData.text). inspectQueue reads all of it back from the scene (tests, __game.inspectQueue).

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  MeshBasicMaterial,
  Sprite,
  SpriteMaterial,
  Texture,
  Vector3,
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

/** The most orders a unit holds (world.ts MAX_ORDERS), plus the unit itself: points per path. */
const MAX_POINTS = 64 + 1;
/** Dash patterns, [on, off, on, off…] in screen-scaled tiles (see `unit` in update): long, short, dash-dot. */
const DASHES: number[][] = [
  [0.9, 0.45],
  [0.3, 0.3],
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

/** Flat quad from x 0..1, z -0.5..0.5 (a dash, stretched along x). */
function quadGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, -0.5, 1, 0, -0.5, 1, 0, 0.5, 0, 0, 0.5]), 3));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}

/** Flat triangle with its tip at the origin, pointing +x, base at x = -1, half-width 1. */
function arrowGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, -1, 0, 1, -1, 0, -1]), 3));
  g.setIndex([0, 2, 1]);
  return g;
}

/**
 * Instanced flat marks, filled from zero each frame, doubling when full (a long queue of long
 * segments needs many dashes).
 */
class Marks {
  mesh: InstancedMesh;
  private n = 0;

  constructor(
    private readonly parent: Object3D,
    private readonly geometry: BufferGeometry,
    private readonly material: MeshBasicMaterial,
    readonly name: string,
    private readonly order: number,
  ) {
    this.mesh = this.make(256);
  }

  private make(capacity: number): InstancedMesh {
    const m = new InstancedMesh(this.geometry, this.material, capacity);
    m.name = this.name;
    m.frustumCulled = false;
    m.renderOrder = this.order;
    m.count = 0;
    m.visible = false;
    this.parent.add(m);
    return m;
  }

  reset() {
    this.n = 0;
  }

  /** A mark from (x, z) along the unit direction (dx, dz): length `sx` along it, width `sz` across. */
  push(x: number, y: number, z: number, dx: number, dz: number, sx: number, sz: number) {
    if (this.n >= this.mesh.instanceMatrix.count) {
      const old = this.mesh;
      this.mesh = this.make(old.instanceMatrix.count * 2);
      (this.mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
      old.removeFromParent();
      old.dispose();
    }
    // translate · rotateY · scale, with local +x onto (dx, dz) (entities.ts writeM, c = dx, s = -dz)
    const a = this.mesh.instanceMatrix.array as Float32Array;
    const o = this.n * 16;
    a[o] = dx * sx;
    a[o + 1] = 0;
    a[o + 2] = dz * sx;
    a[o + 3] = 0;
    a[o + 4] = 0;
    a[o + 5] = 1;
    a[o + 6] = 0;
    a[o + 7] = 0;
    a[o + 8] = -dz * sz;
    a[o + 9] = 0;
    a[o + 10] = dx * sz;
    a[o + 11] = 0;
    a[o + 12] = x;
    a[o + 13] = y;
    a[o + 14] = z;
    a[o + 15] = 1;
    this.n++;
  }

  commit() {
    const m = this.mesh;
    m.count = this.n;
    m.visible = this.n > 0;
    if (this.n > 0) {
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, this.n * 16);
      m.instanceMatrix.needsUpdate = true;
    }
  }

  get count() {
    return this.n;
  }
}

/** Browser label: the text in bold on a dark rounded box with a light edge (cached per text). */
export function canvasLabel(): LabelTexture {
  const cache = new Map<string, { texture: Texture; aspect: number }>();
  return (text) => {
    let t = cache.get(text);
    if (t) return t;
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
    return t;
  };
}

/** Node (tests): a blank texture per text, the aspect a canvas label would roughly have. */
export const blankLabel: LabelTexture = (text) => ({ texture: new Texture(), aspect: Math.max(1, 0.4 + text.length * 0.42) });

interface PathPoint {
  x: number;
  z: number;
}

export class QueueOverlay {
  readonly group = new Group();
  private readonly terrain: Terrain;
  private readonly label: LabelTexture;
  private readonly lines: Line[] = [];
  private readonly lineMaterial = new LineBasicMaterial({ color: DARK, depthTest: false, depthWrite: false, toneMapped: false });
  private readonly sprites: Sprite[] = [];
  private readonly dashEdge: Marks;
  private readonly dash: Marks;
  private readonly arrowEdge: Marks;
  private readonly arrow: Marks;

  constructor(parent: Object3D, terrain: Terrain, label: LabelTexture = blankLabel) {
    this.terrain = terrain;
    this.label = label;
    this.group.name = 'queue';
    parent.add(this.group);
    const quad = quadGeometry();
    const tri = arrowGeometry();
    const dark = new MeshBasicMaterial({ color: DARK, depthTest: false, depthWrite: false, toneMapped: false });
    const light = new MeshBasicMaterial({ color: LIGHT, depthTest: false, depthWrite: false, toneMapped: false });
    // render orders above the W13 overlays (markers 15) and the ghost (16)
    this.dashEdge = new Marks(this.group, quad, dark, 'overlay/queue/dash-edge', 17);
    this.dash = new Marks(this.group, quad, light, 'overlay/queue/dash', 18);
    this.arrowEdge = new Marks(this.group, tri, dark, 'overlay/queue/arrow-edge', 17);
    this.arrow = new Marks(this.group, tri, light, 'overlay/queue/arrow', 18);
  }

  private lineFor(i: number): Line {
    let l = this.lines[i];
    if (!l) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(MAX_POINTS * 3), 3));
      l = new Line(g, this.lineMaterial);
      l.frustumCulled = false;
      l.renderOrder = 16;
      this.group.add(l);
      this.lines[i] = l;
    }
    return l;
  }

  private spriteFor(i: number): Sprite {
    let s = this.sprites[i];
    if (!s) {
      s = new Sprite(new SpriteMaterial({ depthTest: false, depthWrite: false, sizeAttenuation: false, toneMapped: false, transparent: true }));
      s.name = 'queue/label';
      s.renderOrder = 19;
      s.frustumCulled = false;
      this.group.add(s);
      this.sprites[i] = s;
    }
    return s;
  }

  update(f: QueueFrame): void {
    const { snapshot: snap, camera } = f;
    const q = snap.queues;
    const t = this.terrain;
    for (const m of [this.dashEdge, this.dash, this.arrowEdge, this.arrow]) m.reset();
    let nLines = 0;
    let nLabels = 0;
    /** Labels by item: position, and the queue positions (1-based) of the selected units holding it. */
    const labels = new Map<string, { x: number; z: number; positions: number[] }>();
    const cam = camera.position;
    const pathPoints: PathPoint[] = [];
    let nth = -1; // the unit's place among the selected units: its dash pattern
    for (const p of f.selection) {
      if (p.type !== 'unit') continue;
      nth++;
      const row = indexOf(snap.units.id, snap.units.count, p.id);
      if (row < 0) continue;
      const v = indexOf(f.units.id, f.units.count, p.id);
      pathPoints.length = 0;
      pathPoints.push(v >= 0 ? { x: f.units.x[v]!, z: f.units.z[v]! } : { x: snap.units.cols.x[row]!, z: snap.units.cols.z[row]! });
      for (let i = q.first[row]!, k = 0, end = i + q.count[row]!; i < end; i++, k++) {
        const kind = q.kind[i]!;
        const x = q.x[i]!;
        const z = q.z[i]!;
        if (kind === Q_PRODUCE || x < 0 || z < 0) continue;
        pathPoints.push({ x, z });
        const key = kind === Q_RUN ? `r${q.run[i]}` : q.target[i]! >= 0 ? `${kind === Q_RECLAIM ? 'w' : 'b'}${q.target[i]}` : `m${p.id}:${k}`;
        const l = labels.get(key) ?? { x, z, positions: [] };
        if (!l.positions.includes(k + 1)) l.positions.push(k + 1);
        labels.set(key, l);
      }
      if (pathPoints.length < 2) continue;
      // Screen-scaled tile: the marks keep about the same size on screen at any zoom.
      const p0 = pathPoints[0]!;
      const y0 = groundHeight(t, p0.x, p0.z);
      const dist = Math.hypot(p0.x - cam.x, y0 - cam.y, p0.z - cam.z);
      const unit = Math.max(1, worldPerPixel(camera, dist, f.viewportHeight) * PX_PER_UNIT);
      const line = this.lineFor(nLines++);
      line.name = `queue/path/${p.id}`;
      line.visible = true;
      const pos = line.geometry.getAttribute('position') as BufferAttribute;
      const n = Math.min(MAX_POINTS, pathPoints.length);
      for (let i = 0; i < n; i++) {
        const pt = pathPoints[i]!;
        pos.setXYZ(i, pt.x, groundHeight(t, pt.x, pt.z) + LIFT, pt.z);
      }
      pos.needsUpdate = true;
      line.geometry.setDrawRange(0, n);
      line.geometry.computeBoundingSphere();
      this.drawDashes(pathPoints, n, DASHES[nth % DASHES.length]!, unit);
    }
    for (let i = nLines; i < this.lines.length; i++) this.lines[i]!.visible = false;
    // Labels: one per item; screen-sized (sizeAttenuation off: scale × 1/tan(fov/2) is the height
    // in normalised device units, 2 = the viewport).
    const f2 = 1 / Math.tan(((camera.fov * Math.PI) / 180) / 2);
    const h = ((LABEL_PX / f.viewportHeight) * 2) / f2;
    for (const l of labels.values()) {
      const text = l.positions.sort((a, b) => a - b).join(', ');
      const s = this.spriteFor(nLabels++);
      const tex = this.label(text);
      if (s.material.map !== tex.texture) {
        s.material.map = tex.texture;
        s.material.needsUpdate = true;
      }
      s.userData.text = text;
      s.position.set(l.x, groundHeight(t, l.x, l.z) + LABEL_LIFT, l.z);
      s.scale.set(h * tex.aspect, h, 1);
      s.visible = true;
    }
    for (let i = nLabels; i < this.sprites.length; i++) this.sprites[i]!.visible = false;
    for (const m of [this.dashEdge, this.dash, this.arrowEdge, this.arrow]) m.commit();
  }

  /**
   * Dashes along the path in `pattern` (restarting at each segment, so every segment starts with a
   * dash), and an arrowhead at the end of each segment.
   */
  private drawDashes(pts: PathPoint[], n: number, pattern: number[], unit: number): void {
    const t = this.terrain;
    const e = EDGE * unit;
    for (let i = 1; i < n; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-3) continue;
      const dx = (b.x - a.x) / len;
      const dz = (b.z - a.z) / len;
      // Dashes stop short of the arrowhead. Each pass either finishes the segment or the current
      // pattern element (at least 0.2 screen-scaled tiles), so the loop ends.
      const stop = Math.max(0, len - ARROW_LENGTH * unit);
      let k = 0;
      let rem = pattern[0]! * unit;
      let d = 0;
      while (d < stop) {
        const step = Math.min(rem, stop - d);
        if (k % 2 === 0) {
          const x = a.x + dx * d;
          const z = a.z + dz * d;
          const y = groundHeight(t, x + dx * step * 0.5, z + dz * step * 0.5) + LIFT;
          this.dashEdge.push(x - dx * e, y, z - dz * e, dx, dz, step + 2 * e, (DASH_WIDTH + 2 * EDGE) * unit);
          this.dash.push(x, y + 0.01, z, dx, dz, step, DASH_WIDTH * unit);
        }
        d += step;
        rem -= step;
        if (rem <= 1e-6) {
          k = (k + 1) % pattern.length;
          rem = pattern[k]! * unit;
        }
      }
      const y = groundHeight(t, b.x, b.z) + LIFT;
      this.arrowEdge.push(b.x + dx * e * 1.6, y, b.z + dz * e * 1.6, dx, dz, (ARROW_LENGTH + 2.4 * EDGE) * unit, (ARROW_HALF_WIDTH + 1.6 * EDGE) * unit);
      this.arrow.push(b.x, y + 0.01, b.z, dx, dz, ARROW_LENGTH * unit, ARROW_HALF_WIDTH * unit);
    }
  }

  /** Arrowheads drawn last update (one per segment). */
  get arrows(): number {
    return this.arrow.count;
  }
}

function indexOf(ids: Uint32Array, count: number, id: number): number {
  for (let r = 0; r < count; r++) if (ids[r] === id) return r;
  return -1;
}

export interface QueueInspection {
  /** Per visible queue line: the unit and its points (x, z) in order. */
  paths: Array<{ unit: number; points: Array<[number, number]> }>;
  /** Visible labels: text and ground position. */
  labels: Array<{ text: string; x: number; z: number }>;
  /** Arrowhead instances submitted. */
  arrows: number;
}

/** Reads the queue drawing back from the scene graph (what is submitted, not a renderer report). */
export function inspectQueue(root: Object3D): QueueInspection {
  const out: QueueInspection = { paths: [], labels: [], arrows: 0 };
  const v = new Vector3();
  root.updateMatrixWorld(true);
  root.traverseVisible((o) => {
    if (o instanceof Line && o.name.startsWith('queue/path/')) {
      const pos = o.geometry.getAttribute('position') as BufferAttribute;
      const n = Math.min(o.geometry.drawRange.count, pos.count);
      const points: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        points.push([v.x, v.z]);
      }
      out.paths.push({ unit: Number(o.name.slice('queue/path/'.length)), points });
    } else if (o instanceof Sprite && o.name === 'queue/label') {
      o.getWorldPosition(v);
      out.labels.push({ text: String(o.userData.text), x: v.x, z: v.z });
    } else if (o instanceof InstancedMesh && o.name === 'overlay/queue/arrow') out.arrows += o.count;
  });
  return out;
}
