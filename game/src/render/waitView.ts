// W25b: sites and builders waiting for resources, drawn from the snapshot (render/waiting.ts).
//
// Each waiting site gets a marker over its footprint centre: an hourglass and the words "waiting
// for mass" (or energy, rare, or several) on a dark box with a light edge. Each unit building a
// waiting site gets the same label over its head, smaller. Shape and words carry the state, never
// colour (Richard is colour-blind); the marks are light on dark, readable on any ground. The marks
// keep their size on screen at any zoom (sprites without size attenuation). Where labels would
// overlap on screen (adjacent wall tiles, builders standing together), each later one is lifted by
// whole label heights until it is clear (Sprite.center: a screen-space shift, so the sprite's world
// position stays on its site or unit).
//
// Scene graph: a sprite per marker, `wait/site` (userData: site id, text, icon) and `wait/unit`
// (userData: unit id, text, icon). inspectWaiting reads them back (tests, __game.inspectWaiting).

import { CanvasTexture, Group, Sprite, SpriteMaterial, Texture, Vector3, type Object3D, type PerspectiveCamera } from 'three';

/** Screen rectangles (normalised device units) of the labels placed so far this update. */
type Rect = [number, number, number, number];
const MAX_LIFT_STEPS = 8;
const GAP = 1.08; // a lifted label clears the one below by 8 % of its height
const tmp = new Vector3();
import type { Snapshot } from '../sim/snapshot.ts';
import type { Terrain } from '../sim/terrain.ts';
import { U } from '../sim/kinds.ts';
import { groundHeight } from './ground.ts';
import type { MobileView } from './interp.ts';
import { waitingState, waitingText, type WaitingState } from './waiting.ts';

export interface WaitFrame {
  camera: PerspectiveCamera;
  viewportHeight: number;
  snapshot: Snapshot;
  /** Interpolated unit positions (the label follows the drawn unit). */
  units: MobileView;
}

/** A label's texture and its width ÷ height. */
export type WaitLabelTexture = (text: string) => { texture: Texture; aspect: number };

/** The icon every waiting marker carries (drawn in the label, named in the scene for inspection). */
export const WAIT_ICON = 'hourglass';
/** On-screen heights (CSS px) of site markers and builder labels. */
const SITE_PX = 22;
const UNIT_PX = 17;
/** Height above the ground (tiles): over a wall or turret model, and over each unit kind's head. */
const SITE_LIFT = 2.8;
const UNIT_LIFT: Record<number, number> = { [U.commander]: 4.6, [U.engineer]: 2.3 };
const LIGHT = '#f4efe6';
const DARK = '#120f0d';

/** Browser label: an hourglass and the text, light on a dark box with a light edge (cached per text). */
export function canvasWaitLabel(): WaitLabelTexture {
  const cache = new Map<string, { texture: Texture; aspect: number }>();
  return (text) => {
    let t = cache.get(text);
    if (t) return t;
    const h = 64;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    const font = `700 ${Math.round(h * 0.5)}px ui-monospace, Menlo, monospace`;
    ctx.font = font;
    const icon = h * 0.62; // the hourglass's box
    const pad = h * 0.26;
    const w = Math.ceil(pad + icon + pad * 0.6 + ctx.measureText(text).width + pad);
    c.width = w;
    c.height = h;
    ctx.beginPath();
    ctx.roundRect(3, 3, w - 6, h - 6, h * 0.18);
    ctx.fillStyle = DARK;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = LIGHT;
    ctx.stroke();
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
    ctx.font = font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x0 + iw + pad * 0.6, h / 2 + 2);
    const texture = new CanvasTexture(c);
    t = { texture, aspect: w / h };
    cache.set(text, t);
    return t;
  };
}

/** Node (tests): a blank texture per text, about the aspect a canvas label would have. */
export const blankWaitLabel: WaitLabelTexture = (text) => ({ texture: new Texture(), aspect: 1 + text.length * 0.32 });

export class WaitOverlay {
  readonly group = new Group();
  private readonly terrain: Terrain;
  private readonly label: WaitLabelTexture;
  private readonly sprites: Sprite[] = [];
  /** The last state drawn (main.ts gives the readout its counts from it). */
  state: WaitingState = { short: [], sites: [], builders: [] };

  constructor(parent: Object3D, terrain: Terrain, label: WaitLabelTexture = blankWaitLabel) {
    this.terrain = terrain;
    this.label = label;
    this.group.name = 'wait';
    parent.add(this.group);
  }

  private spriteFor(i: number): Sprite {
    let s = this.sprites[i];
    if (!s) {
      s = new Sprite(new SpriteMaterial({ depthTest: false, depthWrite: false, sizeAttenuation: false, toneMapped: false, transparent: true }));
      s.renderOrder = 19;
      s.frustumCulled = false;
      this.group.add(s);
      this.sprites[i] = s;
    }
    return s;
  }

  private place(i: number, name: string, text: string, x: number, y: number, z: number, height: number, data: Record<string, number>, cam: PerspectiveCamera, ndcPerUnit: number, placed: Rect[]): void {
    const s = this.spriteFor(i);
    const tex = this.label(text);
    if (s.material.map !== tex.texture) {
      s.material.map = tex.texture;
      s.material.needsUpdate = true;
    }
    s.name = name;
    s.userData = { ...data, text, icon: WAIT_ICON };
    s.position.set(x, y, z);
    s.scale.set(height * tex.aspect, height, 1);
    s.visible = true;
    // lift clear of the labels already placed (screen space)
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
    // sizeAttenuation off: scale × 1/tan(fov/2) is the height in normalised device units (2 = the viewport)
    const f2 = 1 / Math.tan(((f.camera.fov * Math.PI) / 180) / 2);
    const px = (p: number) => ((p / f.viewportHeight) * 2) / f2;
    const cam = f.camera;
    cam.updateMatrixWorld();
    const placed: Rect[] = [];
    let n = 0;
    for (const s of ws.sites) this.place(n++, 'wait/site', waitingText(s.short), s.x, groundHeight(t, s.x, s.z) + SITE_LIFT, s.z, px(SITE_PX), { site: s.id }, cam, f2, placed);
    const u = f.units;
    const snapUnits = f.snapshot.units;
    for (const b of ws.builders) {
      let r = indexOf(u.id, u.count, b.id);
      let x: number;
      let z: number;
      let kind: number;
      if (r >= 0) {
        x = u.x[r]!;
        z = u.z[r]!;
        kind = u.kind[r]!;
      } else {
        r = indexOf(snapUnits.id, snapUnits.count, b.id);
        if (r < 0) continue;
        x = snapUnits.cols.x[r]!;
        z = snapUnits.cols.z[r]!;
        kind = snapUnits.cols.kind[r]!;
      }
      this.place(n++, 'wait/unit', waitingText(b.short), x, groundHeight(t, x, z) + (UNIT_LIFT[kind] ?? 2.3), z, px(UNIT_PX), { unit: b.id, site: b.site }, cam, f2, placed);
    }
    for (let i = n; i < this.sprites.length; i++) this.sprites[i]!.visible = false;
  }
}

function indexOf(ids: ArrayLike<number>, count: number, id: number): number {
  for (let r = 0; r < count; r++) if (ids[r] === id) return r;
  return -1;
}

export interface WaitInspection {
  sites: Array<{ site: number; text: string; icon: string; x: number; z: number }>;
  builders: Array<{ unit: number; site: number; text: string; icon: string; x: number; z: number }>;
}

/** Reads the waiting markers back from the scene graph (what is submitted, not a renderer report). */
export function inspectWaiting(root: Object3D): WaitInspection {
  const out: WaitInspection = { sites: [], builders: [] };
  const v = new Vector3();
  root.updateMatrixWorld(true);
  root.traverseVisible((o) => {
    if (!(o instanceof Sprite)) return;
    if (o.name === 'wait/site') {
      o.getWorldPosition(v);
      out.sites.push({ site: Number(o.userData.site), text: String(o.userData.text), icon: String(o.userData.icon), x: v.x, z: v.z });
    } else if (o.name === 'wait/unit') {
      o.getWorldPosition(v);
      out.builders.push({ unit: Number(o.userData.unit), site: Number(o.userData.site), text: String(o.userData.text), icon: String(o.userData.icon), x: v.x, z: v.z });
    }
  });
  return out;
}
