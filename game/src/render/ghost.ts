// Placement preview on the cursor tile. Validity is shown by shape, not colour: a solid outline and
// a tick when placement is allowed, a dashed outline and a cross when it is not.
//
// W27 (models view): the building is drawn as a wireframe of the full-detail model the renderer
// draws for it placed there (models.ts previewRun), pulsing once a second with real time
// (preview.ts); where placement is blocked the pulse stops and the wireframe turns red (in addition
// to the dashed outline and cross, never instead of them). The wireframe is captured again only
// when the kind, tile or direction changes.

import { Group, Mesh, MeshBasicMaterial, type Scene } from 'three';
import { buildingFootprint } from '../sim/kinds.ts';
import type { Terrain } from '../sim/terrain.ts';
import { groundHeight as heightAt } from './ground.ts';
import { ghostMarkGeometry, ghostOutlineGeometry } from './geometry.ts';
import type { Captured, ModelRenderer } from './models.ts';
import { BLOCKED_OPACITY, WireframePool, pulseOpacity } from './preview.ts';

export class Ghost {
  private readonly group = new Group();
  private readonly wire: WireframePool;
  private readonly outline: [Mesh, Mesh];
  private readonly mark: [Mesh, Mesh];
  private readonly terrain: Terrain;
  private readonly captured: Captured[] = [];
  /** Kind, tile and direction of the captured wireframe (captured again only when one changes). */
  private readonly capturedFor = [-1, 0, 0, 0];
  /** Last shown state, for tests and the HUD. */
  state: { kind: number; tx: number; ty: number; dir: number; ok: boolean } | null = null;

  constructor(
    scene: Scene,
    terrain: Terrain,
    private readonly models: ModelRenderer,
  ) {
    this.terrain = terrain;
    this.wire = new WireframePool(this.group, 'overlay/preview/wire');
    const flat = new MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false });
    this.outline = [new Mesh(ghostOutlineGeometry(false), flat), new Mesh(ghostOutlineGeometry(true), flat)];
    this.outline[0].name = 'overlay/preview/outline-dashed';
    this.outline[1].name = 'overlay/preview/outline-solid';
    this.mark = [new Mesh(ghostMarkGeometry(false), flat), new Mesh(ghostMarkGeometry(true), flat)];
    this.mark[0].name = 'overlay/preview/cross';
    this.mark[1].name = 'overlay/preview/tick';
    for (const m of [...this.outline, ...this.mark]) {
      m.renderOrder = 16;
      m.visible = false;
      this.group.add(m);
    }
    scene.add(this.group);
  }

  /**
   * Shows the preview of `kind` anchored at (tx, ty) facing `dir`; `ok` = placement allowed; `wpp`
   * world units per pixel at the cursor (mark size); `yaw` the camera yaw (the mark faces the
   * screen); `time` real time in seconds (the pulse).
   */
  show(kind: number, tx: number, ty: number, dir: number, ok: boolean, wpp: number, yaw: number, time = 0): void {
    this.hideMarks();
    const [fw, fh] = buildingFootprint(kind);
    const x = tx + fw / 2;
    const z = ty + fh / 2;
    const y = heightAt(this.terrain, x, z);
    const c = this.capturedFor;
    if (c[0] !== kind || c[1] !== tx || c[2] !== ty || c[3] !== dir) {
      c[0] = kind;
      c[1] = tx;
      c[2] = ty;
      c[3] = dir;
      this.wire.fill(this.models.previewRun(kind, [[tx, ty, dir]], this.captured));
    }
    this.wire.group.visible = true;
    const o = this.outline[ok ? 1 : 0];
    o.visible = true;
    o.position.set(x, y + 0.1, z);
    o.scale.set(fw / 2, 1, fh / 2);
    const mk = this.mark[ok ? 1 : 0];
    mk.visible = true;
    const s = Math.max(0.5, 10 * wpp);
    mk.position.set(x, y + 2.5, z);
    mk.scale.set(s, 1, s);
    mk.rotation.set(0, yaw, 0);
    this.state = { kind, tx, ty, dir, ok };
    this.update(time);
  }

  /** The pulse at real time `time` (seconds); blocked placement holds steady and turns red. */
  update(time: number): void {
    if (!this.state) return;
    this.wire.opacity = this.state.ok ? pulseOpacity(time) : BLOCKED_OPACITY;
    this.wire.blocked = !this.state.ok;
  }

  hide(): void {
    this.hideMarks();
    this.wire.group.visible = false;
    this.state = null;
  }

  private hideMarks(): void {
    for (let i = 0; i < 2; i++) this.outline[i]!.visible = this.mark[i]!.visible = false;
  }
}
