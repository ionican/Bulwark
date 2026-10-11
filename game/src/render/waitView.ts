// W25b: sites waiting for resources, drawn from the snapshot (render/waiting.ts).
//
// Each waiting site gets a marker over its footprint centre: an hourglass on a dark box with a
// light edge. Shape carries the state, never colour (Richard is colour-blind); the mark is light on
// dark, readable on any ground. The marks keep their size on screen at any zoom (sprites without
// size attenuation). Where marks would overlap on screen (adjacent wall tiles), each later one is
// lifted by whole mark heights until it is clear (Sprite.center: a screen-space shift, so the
// sprite's world position stays on its site). W28 removed the "waiting for <resource>" words and
// the builder labels; hovering a site shows its figures (render/siteReadout.ts, ui/siteHover.ts).
//
// Scene graph: a sprite per marker, `wait/site` (userData: site id, icon). inspectWaiting reads
// them back (tests, __game.inspectWaiting).

import { CanvasTexture, Group, Sprite, SpriteMaterial, Texture, Vector3, type Object3D, type PerspectiveCamera } from 'three';
import type { Snapshot } from '../sim/snapshot.ts';
import type { Terrain } from '../sim/terrain.ts';
import { groundHeight } from './ground.ts';
import { waitingState, type WaitingState } from './waiting.ts';

/** Screen rectangles (normalised device units) of the marks placed so far this update. */
type Rect = [number, number, number, number];
const MAX_LIFT_STEPS = 8;
const GAP = 1.08; // a lifted mark clears the one below by 8 % of its height
const tmp = new Vector3();

export interface WaitFrame {
  camera: PerspectiveCamera;
  viewportHeight: number;
  snapshot: Snapshot;
}

/** The marker's texture and its width ÷ height. */
export type WaitMarkTexture = () => { texture: Texture; aspect: number };

/** The icon every waiting marker carries (drawn in the mark, named in the scene for inspection). */
export const WAIT_ICON = 'hourglass';
/** On-screen height (CSS px) of a site marker. */
const SITE_PX = 22;
/** Height above the ground (tiles): over a wall or turret model. */
const SITE_LIFT = 2.8;
const LIGHT = '#f4efe6';
const DARK = '#120f0d';

/**
 * The screen-sized marker style the waiting markers and the disabled-core marker share (shape and
 * word, light on dark, never colour alone): the dark box with a light edge filling a w × h canvas.
 */
export function markBox(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.beginPath();
  ctx.roundRect(3, 3, w - 6, h - 6, h * 0.18);
  ctx.fillStyle = DARK;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = LIGHT;
  ctx.stroke();
}
export const MARK_LIGHT = LIGHT;
export const MARK_DARK = DARK;

/** A marker sprite: drawn over everything, the same size on screen at any zoom (no size attenuation). */
export function markSprite(): Sprite {
  const s = new Sprite(new SpriteMaterial({ depthTest: false, depthWrite: false, sizeAttenuation: false, toneMapped: false, transparent: true }));
  s.renderOrder = 19;
  s.frustumCulled = false;
  return s;
}

/** A marker sprite's scale for a height of `px` CSS px: with size attenuation off, scale × 1/tan(fov/2) is the height in normalised device units (2 = the viewport). */
export function markHeight(camera: PerspectiveCamera, viewportHeight: number, px: number): number {
  const f2 = 1 / Math.tan((camera.fov * Math.PI) / 180 / 2);
  return ((px / viewportHeight) * 2) / f2;
}

/** Browser mark: an hourglass, light on a dark box with a light edge (drawn once). */
export function canvasWaitMark(): WaitMarkTexture {
  let t: { texture: Texture; aspect: number } | null = null;
  return () => {
    if (t) return t;
    const h = 64;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    const icon = h * 0.62; // the hourglass's box
    const pad = h * 0.26;
    const w = Math.ceil(pad + icon * 0.7 + pad);
    c.width = w;
    c.height = h;
    markBox(ctx, w, h);
    // hourglass: top and bottom bars, two triangles meeting at the waist, sand in the lower one
    const x0 = pad;
    const y0 = (h - icon) / 2;
    const iw = icon * 0.7;
    const cx = x0 + iw / 2;
    ctx.fillStyle = LIGHT;
    ctx.strokeStyle = LIGHT;
    ctx.lineWidth = 3;
    ctx.fillRect(x0, y0, iw, 4);
    ctx.fillRect(x0, y0 + icon - 4, iw, 4);
    ctx.beginPath();
    ctx.moveTo(x0 + 3, y0 + 4);
    ctx.lineTo(x0 + iw - 3, y0 + 4);
    ctx.lineTo(cx, y0 + icon / 2);
    ctx.closePath();
    ctx.moveTo(cx, y0 + icon / 2);
    ctx.lineTo(x0 + iw - 3, y0 + icon - 4);
    ctx.lineTo(x0 + 3, y0 + icon - 4);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, y0 + icon * 0.68);
    ctx.lineTo(x0 + iw - 6, y0 + icon - 5);
    ctx.lineTo(x0 + 6, y0 + icon - 5);
    ctx.closePath();
    ctx.fill();
    t = { texture: new CanvasTexture(c), aspect: w / h };
    return t;
  };
}

/** Node (tests): a blank texture with about the aspect the canvas mark has. */
const blank = { texture: new Texture(), aspect: 0.95 };
export const blankWaitMark: WaitMarkTexture = () => blank;

export class WaitOverlay {
  readonly group = new Group();
  private readonly terrain: Terrain;
  private readonly mark: WaitMarkTexture;
  private readonly sprites: Sprite[] = [];
  /** The last state drawn (main.ts gives the readout its counts from it). */
  state: WaitingState = { short: [], sites: [], builders: [] };

  constructor(parent: Object3D, terrain: Terrain, mark: WaitMarkTexture = blankWaitMark) {
    this.terrain = terrain;
    this.mark = mark;
    this.group.name = 'wait';
    parent.add(this.group);
  }

  private spriteFor(i: number): Sprite {
    let s = this.sprites[i];
    if (!s) {
      s = markSprite();
      this.group.add(s);
      this.sprites[i] = s;
    }
    return s;
  }

  private place(i: number, x: number, y: number, z: number, height: number, data: Record<string, number>, cam: PerspectiveCamera, ndcPerUnit: number, placed: Rect[]): void {
    const s = this.spriteFor(i);
    const tex = this.mark();
    if (s.material.map !== tex.texture) {
      s.material.map = tex.texture;
      s.material.needsUpdate = true;
    }
    s.name = 'wait/site';
    s.userData = { ...data, icon: WAIT_ICON };
    s.position.set(x, y, z);
    s.scale.set(height * tex.aspect, height, 1);
    s.visible = true;
    // lift clear of the marks already placed (screen space)
    tmp.set(x, y, z).project(cam);
    const h = height * ndcPerUnit;
    const w = (height * tex.aspect * ndcPerUnit) / cam.aspect;
    let k = 0;
    const at = (n: number): Rect => [tmp.x - w / 2, tmp.y - h / 2 + n * h * GAP, tmp.x + w / 2, tmp.y + h / 2 + n * h * GAP];
    const hits = (r: Rect) => placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]);
    while (k < MAX_LIFT_STEPS && hits(at(k))) k++;
    placed.push(at(k));
    s.center.set(0.5, 0.5 - k * GAP);
  }

  update(f: WaitFrame): void {
    const ws = waitingState(f.snapshot);
    this.state = ws;
    const t = this.terrain;
    const px = (p: number) => markHeight(f.camera, f.viewportHeight, p);
    const f2 = 1 / Math.tan((f.camera.fov * Math.PI) / 180 / 2); // normalised device units per unit of sprite scale
    const cam = f.camera;
    cam.updateMatrixWorld();
    const placed: Rect[] = [];
    let n = 0;
    for (const s of ws.sites) this.place(n++, s.x, groundHeight(t, s.x, s.z) + SITE_LIFT, s.z, px(SITE_PX), { site: s.id }, cam, f2, placed);
    for (let i = n; i < this.sprites.length; i++) this.sprites[i]!.visible = false;
  }
}

export interface WaitInspection {
  sites: Array<{ site: number; icon: string; x: number; z: number }>;
}

/** Reads the waiting markers back from the scene graph (what is submitted, not a renderer report). */
export function inspectWaiting(root: Object3D): WaitInspection {
  const out: WaitInspection = { sites: [] };
  const v = new Vector3();
  root.updateMatrixWorld(true);
  root.traverseVisible((o) => {
    if (!(o instanceof Sprite)) return;
    if (o.name === 'wait/site') {
      o.getWorldPosition(v);
      out.sites.push({ site: Number(o.userData.site), icon: String(o.userData.icon), x: v.x, z: v.z });
    }
  });
  return out;
}
