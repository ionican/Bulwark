// W27: the pulsing wireframe placement preview. The building being placed is drawn as lines over
// the model the renderer draws for it (models.ts previewRun: the same geometry objects at the same
// matrices), so its size reads before it is placed. W27b (Richard, 2026-10-09: "could do with less
// detail in it - perhaps an outline and basic"): the model is the kind's low-detail level
// (models.ts previewLevel), and only its feature edges are drawn (EdgesGeometry, faces meeting at
// more than EDGE_ANGLE), not every triangle edge. The opacity pulses once a second with real time
// (it is interface, not game state: no game clock, so it pulses while paused). Where placement is
// blocked the pulse stops and the opacity holds steady, and the lines turn red (Richard,
// 2026-10-09), so validity is shown by motion and colour as well as by the outline and mark shapes
// (ghost.ts); the colour is additional, never the only cue.

import { BufferAttribute, BufferGeometry, DynamicDrawUsage, EdgesGeometry, Group, LineBasicMaterial, LineSegments, type Object3D } from 'three';

/** Pulse period, seconds. */
export const PULSE_PERIOD = 1;
/** Opacity while placement is blocked (no pulse). */
export const BLOCKED_OPACITY = 0.3;
/** Feature-edge threshold: an edge is drawn where its two faces meet at more than this (degrees). */
export const EDGE_ANGLE = 30;
/**
 * Lower thresholds tried, in order, for a smooth piece (a dome) whose edges at EDGE_ANGLE stop short
 * of its own bounds by more than EDGE_REACH of its largest extent; the first that reaches is kept.
 */
const SMOOTH_ANGLES = [20, 15, 10, 5, 2];
const EDGE_REACH = 0.02;

/** Line colour where placement is allowed, and where it is blocked. */
export const ALLOWED_COLOUR = 0xbff4ff;
export const BLOCKED_COLOUR = 0xff3b30;

/** Line opacity at `time` seconds of real time: 0.2 … 0.8, period PULSE_PERIOD. */
export function pulseOpacity(time: number): number {
  return 0.5 + 0.3 * Math.cos((2 * Math.PI * time) / PULSE_PERIOD);
}

/** Feature edges of each source geometry (segment end points, model space), built once. */
const edgeCache = new WeakMap<BufferGeometry, Float32Array>();

/** How far the segment end points `e` stop short of `g`'s bounds, as a fraction of its largest extent. */
function shortfall(g: BufferGeometry, e: Float32Array): number {
  if (!g.boundingBox) g.computeBoundingBox();
  const b = g.boundingBox!;
  const size = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) || 1;
  if (e.length === 0) return 1;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < e.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, e[i + a]!);
      hi[a] = Math.max(hi[a]!, e[i + a]!);
    }
  const gap = Math.max(lo[0]! - b.min.x, lo[1]! - b.min.y, lo[2]! - b.min.z, b.max.x - hi[0]!, b.max.y - hi[1]!, b.max.z - hi[2]!);
  return gap / size;
}

function edgesAt(g: BufferGeometry, angle: number): Float32Array {
  const eg = new EdgesGeometry(g, angle);
  const e = (eg.attributes.position!.array as Float32Array).slice();
  eg.dispose();
  return e;
}

/**
 * The feature edges of `g` as segment end points (x, y, z each, model space), computed once per
 * geometry: at EDGE_ANGLE, or for a smooth piece the first of SMOOTH_ANGLES whose edges reach the
 * piece's bounds, so the outline keeps the model's size.
 */
export function featureEdges(g: BufferGeometry): Float32Array {
  let e = edgeCache.get(g);
  if (!e) {
    e = edgesAt(g, EDGE_ANGLE);
    for (const angle of SMOOTH_ANGLES) {
      if (shortfall(g, e) <= EDGE_REACH) break;
      e = edgesAt(g, angle);
    }
    edgeCache.set(g, e);
  }
  return e;
}

/**
 * The preview's lines: one LineSegments per pool, its vertex buffer holding every captured piece's
 * feature edges in world space. Filled by `fill` when the previewed plan changes (ghost.ts and
 * dragPreview.ts cache the plan), never per frame; the buffer grows by doubling and is kept. Each
 * frame only the material's opacity and colour change. `userData`: `sources` (the uuid of each
 * piece's source geometry), `pieces` and `centre` (mean ground position of the pieces), read by
 * `inspectPreview` and the tests.
 */
export class WireframePool {
  readonly group = new Group();
  readonly material: LineBasicMaterial;
  readonly lines: LineSegments;
  private positions = new Float32Array(3 * 1024);

  constructor(
    parent: Object3D,
    name: string,
  ) {
    this.material = new LineBasicMaterial({ color: ALLOWED_COLOUR, transparent: true, opacity: pulseOpacity(0), depthWrite: false, toneMapped: false, fog: false });
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.lines = new LineSegments(g, this.material);
    this.lines.name = name;
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 15;
    this.lines.visible = false;
    this.lines.userData = { sources: [], pieces: 0, centre: [0, 0] };
    this.group.name = name;
    this.group.add(this.lines);
    parent.add(this.group);
  }

  /** Exactly the captured pieces (models.ts previewRun), replacing what was there. */
  fill(captured: ReadonlyArray<{ geometry: BufferGeometry; matrix: ArrayLike<number> }>): void {
    let n = 0;
    for (const c of captured) n += featureEdges(c.geometry).length;
    if (n > this.positions.length) {
      let cap = this.positions.length;
      while (cap < n) cap *= 2;
      this.positions = new Float32Array(cap);
      this.lines.geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
    }
    const out = this.positions;
    const sources: string[] = [];
    let k = 0;
    let cx = 0;
    let cz = 0;
    for (const { geometry, matrix: m } of captured) {
      const e = featureEdges(geometry);
      for (let i = 0; i < e.length; i += 3) {
        const x = e[i]!;
        const y = e[i + 1]!;
        const z = e[i + 2]!;
        out[k++] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
        out[k++] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
        out[k++] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      }
      sources.push(geometry.uuid);
      cx += m[12]!;
      cz += m[14]!;
    }
    const attr = this.lines.geometry.attributes.position as BufferAttribute;
    attr.clearUpdateRanges();
    if (k > 0) attr.addUpdateRange(0, k);
    attr.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, k / 3);
    this.lines.visible = k > 0;
    const p = captured.length;
    this.lines.userData = { sources, pieces: p, centre: p ? [cx / p, cz / p] : [0, 0] };
  }

  /** Hides the lines. */
  clear(): void {
    this.fill([]);
  }

  set opacity(v: number) {
    this.material.opacity = v;
  }

  /** Blocked placement draws the lines red; allowed, the usual pale blue. */
  set blocked(v: boolean) {
    this.material.color.setHex(v ? BLOCKED_COLOUR : ALLOWED_COLOUR);
  }
}

/**
 * The wireframe previews as drawn (scripts read them back from the scene graph): per pool name
 * (`overlay/preview/wire`, `overlay/drag/wire`), the pieces drawn (`instances`), the distinct source
 * geometries, the line vertices drawn, the opacity, the colour (hex), and the ground centre (x, z)
 * of the pieces' positions.
 */
export function inspectPreview(root: Object3D): Record<string, { instances: number; geometries: number; vertices: number; opacity: number; colour: number; centre: [number, number] }> {
  const out: Record<string, { instances: number; geometries: number; vertices: number; opacity: number; colour: number; centre: [number, number] }> = {};
  root.traverseVisible((o) => {
    if (!(o instanceof LineSegments) || (o.name !== 'overlay/preview/wire' && o.name !== 'overlay/drag/wire')) return;
    const u = o.userData as { sources: string[]; pieces: number; centre: [number, number] };
    if (!u.pieces) return;
    const m = o.material as LineBasicMaterial;
    out[o.name] = { instances: u.pieces, geometries: new Set(u.sources).size, vertices: o.geometry.drawRange.count, opacity: m.opacity, colour: m.color.getHex(), centre: [u.centre[0], u.centre[1]] };
  });
  return out;
}
