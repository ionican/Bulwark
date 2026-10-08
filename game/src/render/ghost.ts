// Placement preview: the building's simple model, see-through, on the cursor tile, with a solid
// outline and a tick when placement is allowed, or a dashed outline and a cross when it is not.
// Validity is shown by shape (outline style and mark), not by colour.

import { Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, type Scene } from 'three';
import { BUILDING_KINDS, buildingFootprint, isBelt } from '../sim/kinds.ts';
import type { Terrain } from '../sim/terrain.ts';
import { groundHeight as heightAt } from './ground.ts';
import { buildingGeometries, ghostMarkGeometry, ghostOutlineGeometry } from './geometry.ts';

const BDX = [1, 0, -1, 0];
const BDZ = [0, 1, 0, -1];

export class Ghost {
  private readonly group = new Group();
  private readonly models: Mesh[];
  private readonly outline: [Mesh, Mesh];
  private readonly mark: [Mesh, Mesh];
  private readonly terrain: Terrain;
  /** Last shown state, for tests and the HUD. */
  state: { kind: number; tx: number; ty: number; dir: number; ok: boolean } | null = null;

  constructor(scene: Scene, terrain: Terrain) {
    this.terrain = terrain;
    const mat = new MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false });
    const geoms = buildingGeometries();
    this.models = BUILDING_KINDS.map((_, k) => {
      const m = new Mesh(geoms[k]!.simple, mat);
      m.visible = false;
      this.group.add(m);
      return m;
    });
    const flat = new MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false });
    this.outline = [new Mesh(ghostOutlineGeometry(false), flat), new Mesh(ghostOutlineGeometry(true), flat)];
    this.mark = [new Mesh(ghostMarkGeometry(false), flat), new Mesh(ghostMarkGeometry(true), flat)];
    for (const m of [...this.outline, ...this.mark]) {
      m.renderOrder = 16;
      m.visible = false;
      this.group.add(m);
    }
    scene.add(this.group);
  }

  show(kind: number, tx: number, ty: number, dir: number, ok: boolean, wpp: number, yaw: number): void {
    this.hide();
    const [fw, fh] = buildingFootprint(kind);
    const x = tx + fw / 2;
    const z = ty + fh / 2;
    const y = heightAt(this.terrain, x, z);
    const m = this.models[kind]!;
    m.visible = true;
    m.position.set(x, y, z);
    m.rotation.set(0, isBelt(kind) ? Math.atan2(-BDZ[dir]!, BDX[dir]!) : 0, 0);
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
  }

  hide(): void {
    for (const m of this.group.children) m.visible = false;
    this.state = null;
  }
}
