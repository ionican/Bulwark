// W29: the disabled core's marker. A disabled core (BF_DISABLED, at 0 hp) gets a sprite over its
// footprint: a hazard triangle with "!" and the word DISABLED, light on a dark box with a light
// edge, so the state is carried by a shape and a word, never colour (Richard is colour-blind). The
// marker keeps its size on screen at any zoom (no size attenuation), as the waiting markers do
// (render/waitView.ts). An enabled core has no marker.
//
// Scene graph: one sprite `core/disabled` (userData: id, icon 'hazard', text 'DISABLED').
// inspectCore reads the visible ones back (tests, __game.inspectCore).

import { CanvasTexture, Group, Sprite, Texture, type Object3D, type PerspectiveCamera } from 'three';
import { BF_DISABLED, G_CORE_ID } from '../sim/schema.ts';
import type { Snapshot } from '../sim/snapshot.ts';
import type { Terrain } from '../sim/terrain.ts';
import { groundHeight } from './ground.ts';
import { rowOf } from './siteReadout.ts';
import { MARK_DARK as DARK, MARK_LIGHT as LIGHT, markBox, markHeight, markSprite } from './waitView.ts';

export interface CoreFrame {
  camera: PerspectiveCamera;
  viewportHeight: number;
  snapshot: Snapshot;
}

export const CORE_MARK_ICON = 'hazard';
export const CORE_MARK_TEXT = 'DISABLED';
/** On-screen height (CSS px) of the marker. */
const MARK_PX = 30;
/** Height above the ground (tiles): over the core model. */
const LIFT = 3.6;

export type CoreMarkTexture = () => { texture: Texture; aspect: number };

/** Browser mark: hazard triangle and DISABLED, light on a dark box with a light edge (drawn once). */
export function canvasCoreMark(): CoreMarkTexture {
  let t: { texture: Texture; aspect: number } | null = null;
  return () => {
    if (t) return t;
    const h = 64;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    ctx.font = `bold ${Math.round(h * 0.42)}px ui-monospace, Menlo, monospace`;
    const textW = ctx.measureText(CORE_MARK_TEXT).width;
    const tri = h * 0.62;
    const pad = h * 0.18;
    const w = Math.ceil(pad + tri + pad * 0.8 + textW + pad);
    c.width = w;
    c.height = h;
    markBox(ctx, w, h);
    // hazard triangle with a dark "!"
    const x0 = pad;
    const y0 = (h - tri) / 2;
    ctx.beginPath();
    ctx.moveTo(x0 + tri / 2, y0);
    ctx.lineTo(x0 + tri, y0 + tri);
    ctx.lineTo(x0, y0 + tri);
    ctx.closePath();
    ctx.fillStyle = LIGHT;
    ctx.fill();
    ctx.fillStyle = DARK;
    ctx.fillRect(x0 + tri / 2 - 3, y0 + tri * 0.3, 6, tri * 0.38);
    ctx.fillRect(x0 + tri / 2 - 3, y0 + tri * 0.76, 6, 6);
    ctx.fillStyle = LIGHT;
    ctx.textBaseline = 'middle';
    ctx.fillText(CORE_MARK_TEXT, x0 + tri + pad * 0.8, h / 2 + 1);
    t = { texture: new CanvasTexture(c), aspect: w / h };
    return t;
  };
}

/** Node (tests): a blank texture with about the canvas mark's aspect. */
const blank = { texture: new Texture(), aspect: 4.4 };
export const blankCoreMark: CoreMarkTexture = () => blank;

export class CoreOverlay {
  readonly group = new Group();
  private readonly terrain: Terrain;
  private readonly mark: CoreMarkTexture;
  private readonly sprite: Sprite;
  /** The snapshot the core's row was found in, and the row (-1: no core). */
  private rowFor: Snapshot | null = null;
  private row = -1;

  constructor(parent: Object3D, terrain: Terrain, mark: CoreMarkTexture = blankCoreMark) {
    this.terrain = terrain;
    this.mark = mark;
    this.group.name = 'core';
    this.sprite = markSprite();
    this.sprite.name = 'core/disabled';
    this.sprite.userData = { id: -1, icon: CORE_MARK_ICON, text: CORE_MARK_TEXT };
    this.sprite.visible = false;
    this.group.add(this.sprite);
    parent.add(this.group);
  }

  update(f: CoreFrame): void {
    const snap = f.snapshot;
    if (snap !== this.rowFor) {
      this.rowFor = snap;
      const id = snap.globals[G_CORE_ID]!;
      this.row = id < 0 ? -1 : rowOf(snap, id);
    }
    const b = snap.buildings;
    const c = b.cols;
    const row = this.row;
    const s = this.sprite;
    if (row < 0 || !(c.flags[row]! & BF_DISABLED)) {
      s.visible = false;
      return;
    }
    const tex = this.mark();
    if (s.material.map !== tex.texture) {
      s.material.map = tex.texture;
      s.material.needsUpdate = true;
    }
    const x = c.tx[row]! + c.fw[row]! / 2;
    const z = c.ty[row]! + c.fh[row]! / 2;
    const height = markHeight(f.camera, f.viewportHeight, MARK_PX);
    s.position.set(x, groundHeight(this.terrain, x, z) + LIFT, z);
    s.scale.set(height * tex.aspect, height, 1);
    s.userData.id = b.id[row]!;
    s.visible = true;
  }
}

/** The visible disabled-core markers, read back from the scene graph. */
export function inspectCore(root: Object3D): Array<{ id: number; icon: string; text: string; x: number; z: number }> {
  const out: Array<{ id: number; icon: string; text: string; x: number; z: number }> = [];
  root.traverseVisible((o) => {
    if (o instanceof Sprite && o.name === 'core/disabled') out.push({ id: o.userData.id, icon: o.userData.icon, text: o.userData.text, x: o.position.x, z: o.position.z });
  });
  return out;
}
