// Placement preview on the cursor tile. Validity is shown by shape, not colour: a solid outline and
// a tick when placement is allowed, a dashed outline and a cross when it is not.
//
// W27 (models view): the building is drawn as a wireframe of the full-detail model the renderer
// draws for it placed there (models.ts previewBuilding), pulsing once a second with real time
// (preview.ts); where placement is blocked the pulse stops and the wireframe turns red (in addition
// to the dashed outline and cross, never instead of them). The wireframe is captured again only
// when the kind, tile or direction changes. Greybox view (no model renderer): the simple model,
// see-through, as before.

import { Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, type Scene } from 'three';
import { BUILDING_KINDS, buildingFootprint, isBelt } from '../sim/kinds.ts';
import type { Terrain } from '../sim/terrain.ts';
import { groundHeight as heightAt } from './ground.ts';
import { buildingGeometries, ghostMarkGeometry, ghostOutlineGeometry } from './geometry.ts';
import type { Captured, ModelRenderer } from './models.ts';
import { BLOCKED_OPACITY, WireframePool, pulseOpacity } from './preview.ts';

const BDX = [1, 0, -1, 0];
const BDZ = [0, 1, 0, -1];

export class Ghost {
  private readonly group = new Group();
  /** Greybox view only: the simple model per kind. */
  private readonly simple: Mesh[] = [];
  private readonly wire: WireframePool | null;
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
    private readonly models: ModelRenderer | null = null,
  ) {
    this.terrain = terrain;
    if (models) this.wire = new WireframePool(this.group, 'overlay/preview/wire');
    else {
      this.wire = null;
      const mat = new MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false });
      const geoms = buildingGeometries();
      for (let k = 0; k < BUILDING_KINDS.length; k++) {
        const m = new Mesh(geoms[k]!.simple, mat);
        m.visible = false;
        this.group.add(m);
        this.simple.push(m);
      }
    }
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
    if (this.models && this.wire) {
      const c = this.capturedFor;
      if (c[0] !== kind || c[1] !== tx || c[2] !== ty || c[3] !== dir) {
        c[0] = kind;
        c[1] = tx;
        c[2] = ty;
        c[3] = dir;
        this.models.previewBuilding(kind, tx, ty, dir, this.captured);
        this.wire.begin();
        for (const c of this.captured) this.wire.push(c.geometry, c.matrix);
        this.wire.commit();
      }
      this.wire.group.visible = true;
    } else {
      const m = this.simple[kind]!;
      m.visible = true;
      m.position.set(x, y, z);
      m.rotation.set(0, isBelt(kind) ? Math.atan2(-BDZ[dir]!, BDX[dir]!) : 0, 0);
    }
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

  /** The pulse: call each frame with real time in seconds. Blocked placement holds steady. */
  update(time: number): void {
    if (!this.wire || !this.state) return;
    this.wire.opacity = this.state.ok ? pulseOpacity(time) : BLOCKED_OPACITY;
    this.wire.blocked = !this.state.ok;
  }

  hide(): void {
    this.hideMarks();
    if (this.wire) this.wire.group.visible = false;
    this.state = null;
  }

  private hideMarks(): void {
    for (const m of [...this.simple, ...this.outline, ...this.mark]) m.visible = false;
  }
}
