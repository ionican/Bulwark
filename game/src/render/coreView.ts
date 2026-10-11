// W29: the disabled core's marker. A disabled core (BF_DISABLED, at 0 hp) gets a sprite over its
// footprint: a hazard triangle with "!" and the word DISABLED, light on a dark box with a light
// edge, so the state is carried by a shape and a word, never colour (Richard is colour-blind). The
// marker keeps its size on screen at any zoom (no size attenuation), as the waiting markers do
// (render/waitView.ts). An enabled core has no marker.
//
// Scene graph: one sprite `core/disabled` (userData: id, icon 'hazard', text 'DISABLED').
// inspectCore reads the visible ones back (tests, __game.inspectCore).

import { CanvasTexture, Group, Sprite, SpriteMaterial, Texture, type Object3D, type PerspectiveCamera } from 'three';
import { B } from '../sim/kinds.ts';
import { BF_DISABLED } from '../sim/schema.ts';
import type { Snapshot } from '../sim/snapshot.ts';
import type { Terrain } from '../sim/terrain.ts';
import { groundHeight } from './ground.ts';

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
const LIGHT = '#f4efe6';
const DARK = '#120f0d';

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
    ctx.beginPath();
    ctx.roundRect(3, 3, w - 6, h - 6, h * 0.18);
    ctx.fillStyle = DARK;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = LIGHT;
    ctx.stroke();
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
    ctx.font = `bold ${Math.round(h * 0.42)}px ui-monospace, Menlo, monospace`;
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

  constructor(parent: Object3D, terrain: Terrain, mark: CoreMarkTexture = blankCoreMark) {
    this.terrain = terrain;
    this.mark = mark;
    this.group.name = 'core';
    this.sprite = new Sprite(new SpriteMaterial({ depthTest: false, depthWrite: false, sizeAttenuation: false, toneMapped: false, transparent: true }));
    this.sprite.name = 'core/disabled';
    this.sprite.renderOrder = 19;
    this.sprite.frustumCulled = false;
    this.sprite.visible = false;
    this.group.add(this.sprite);
    parent.add(this.group);
  }

  update(f: CoreFrame): void {
    const b = f.snapshot.buildings;
    const c = b.cols;
    let row = -1;
    for (let r = 0; r < b.count && row < 0; r++) if (c.kind[r] === B.core && c.flags[r]! & BF_DISABLED) row = r;
    const s = this.sprite;
    if (row < 0) {
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
    // sizeAttenuation off: scale × 1/tan(fov/2) is the height in normalised device units (2 = the viewport)
    const f2 = 1 / Math.tan((f.camera.fov * Math.PI) / 180 / 2);
    const height = ((MARK_PX / f.viewportHeight) * 2) / f2;
    s.position.set(x, groundHeight(this.terrain, x, z) + LIFT, z);
    s.scale.set(height * tex.aspect, height, 1);
    s.userData = { id: b.id[row]!, icon: CORE_MARK_ICON, text: CORE_MARK_TEXT };
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
