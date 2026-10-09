// W27: the pulsing wireframe placement preview. The building being placed is drawn as a wireframe
// of the full-detail model the renderer draws for it (models.ts previewBuilding: the same geometry
// objects at the same matrices), so its size reads before it is placed. The wireframe's opacity
// pulses once a second with real time (it is interface, not game state: no game clock, so it
// pulses while paused). Where placement is blocked the pulse stops and the opacity holds steady,
// and the wireframe turns red (Richard, 2026-10-09), so validity is shown by motion and colour as
// well as by the outline and mark shapes (ghost.ts); the colour is additional, never the only cue.

import { DynamicDrawUsage, Group, InstancedMesh, MeshBasicMaterial, type BufferGeometry, type Object3D } from 'three';

/** Pulse period, seconds. */
export const PULSE_PERIOD = 1;
/** Opacity while placement is blocked (no pulse). */
export const BLOCKED_OPACITY = 0.3;

/** Wireframe colour where placement is allowed, and where it is blocked. */
export const ALLOWED_COLOUR = 0xbff4ff;
export const BLOCKED_COLOUR = 0xff3b30;

/** Wireframe opacity at `time` seconds of real time: 0.2 … 0.8, period PULSE_PERIOD. */
export function pulseOpacity(time: number): number {
  return 0.5 + 0.3 * Math.cos((2 * Math.PI * time) / PULSE_PERIOD);
}

/**
 * Wireframe instances, one instanced mesh per geometry (created the first time a geometry is shown,
 * grown by doubling when a larger preview needs more), all sharing one wireframe material.
 * Filled from zero by `begin` … `push` … `commit`; nothing is allocated when the same preview is
 * drawn again.
 */
export class WireframePool {
  readonly group = new Group();
  readonly material: MeshBasicMaterial;
  private readonly meshes = new Map<BufferGeometry, { mesh: InstancedMesh; n: number }>();

  constructor(
    parent: Object3D,
    private readonly name: string,
  ) {
    this.material = new MeshBasicMaterial({ color: ALLOWED_COLOUR, wireframe: true, transparent: true, opacity: pulseOpacity(0), depthWrite: false, toneMapped: false, fog: false });
    this.group.name = name;
    parent.add(this.group);
  }

  begin(): void {
    for (const e of this.meshes.values()) e.n = 0;
  }

  /** One instance of `geometry` at the 16-float world matrix `m` (from offset o). */
  push(geometry: BufferGeometry, m: ArrayLike<number>, o = 0): void {
    let e = this.meshes.get(geometry);
    if (!e) {
      e = { mesh: this.make(geometry, 16), n: 0 };
      this.meshes.set(geometry, e);
    }
    if (e.n >= e.mesh.instanceMatrix.count) {
      const old = e.mesh;
      e.mesh = this.make(geometry, old.instanceMatrix.count * 2);
      (e.mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
      old.removeFromParent();
      old.dispose();
    }
    const a = e.mesh.instanceMatrix.array as Float32Array;
    const k = e.n++ * 16;
    for (let i = 0; i < 16; i++) a[k + i] = m[o + i]!;
  }

  commit(): void {
    for (const { mesh, n } of this.meshes.values()) {
      mesh.count = n;
      mesh.visible = n > 0;
      if (n > 0) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, n * 16);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Hides every instance. */
  clear(): void {
    this.begin();
    this.commit();
  }

  set opacity(v: number) {
    this.material.opacity = v;
  }

  /** Blocked placement draws the wireframe red; allowed, the usual pale blue. */
  set blocked(v: boolean) {
    this.material.color.setHex(v ? BLOCKED_COLOUR : ALLOWED_COLOUR);
  }

  private make(geometry: BufferGeometry, cap: number): InstancedMesh {
    const m = new InstancedMesh(geometry, this.material, cap);
    m.name = this.name;
    m.instanceMatrix.setUsage(DynamicDrawUsage);
    m.frustumCulled = false;
    m.renderOrder = 15;
    m.castShadow = false;
    m.receiveShadow = false;
    m.count = 0;
    m.visible = false;
    this.group.add(m);
    return m;
  }
}

/**
 * The wireframe previews as drawn (scripts read them back from the scene graph): per mesh name
 * (`overlay/preview/wire`, `overlay/drag/wire`), the visible instances, the distinct geometries,
 * the opacity, the colour (hex), and the ground centre (x, z) of the instances' positions.
 */
export function inspectPreview(root: Object3D): Record<string, { instances: number; geometries: number; opacity: number; colour: number; centre: [number, number] }> {
  const out: Record<string, { instances: number; geometries: number; opacity: number; colour: number; centre: [number, number] }> = {};
  const geos = new Map<string, Set<string>>();
  root.traverseVisible((o) => {
    if (!(o instanceof InstancedMesh) || o.count <= 0 || (o.name !== 'overlay/preview/wire' && o.name !== 'overlay/drag/wire')) return;
    const e = (out[o.name] ??= { instances: 0, geometries: 0, opacity: (o.material as MeshBasicMaterial).opacity, colour: (o.material as MeshBasicMaterial).color.getHex(), centre: [0, 0] });
    const a = o.instanceMatrix.array as Float32Array;
    for (let i = 0; i < o.count; i++) {
      e.centre[0] += a[i * 16 + 12]!;
      e.centre[1] += a[i * 16 + 14]!;
    }
    e.instances += o.count;
    const set = geos.get(o.name) ?? new Set<string>();
    set.add(o.geometry.uuid);
    geos.set(o.name, set);
  });
  for (const [name, e] of Object.entries(out)) {
    e.centre = [e.centre[0] / e.instances, e.centre[1] / e.instances];
    e.geometries = geos.get(name)!.size;
  }
  return out;
}
