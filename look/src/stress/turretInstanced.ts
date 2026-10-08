// Instanced drawing of every turret: for each detail level, one InstancedMesh per part and
// material (see turretLevels.ts). All meshes of one part at one level share one instance-matrix
// buffer, so a turret's part matrix is written once per frame however many materials the part has.
// Batches are refilled from zero each frame (as game/src/render/entities.ts does), so the number of
// draw calls depends on the number of parts × materials × levels, not on the number of turrets.

import { DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, type Group, type Object3D } from 'three';
import { writeYaw, writeTurret, type PartArrays, type TurretFrame } from './turretPose.ts';
import type { LevelDef, Slot } from './turretLevels.ts';

interface LevelRuntime {
  def: LevelDef;
  meshes: InstancedMesh[];
  matrices: Partial<Record<Slot, InstancedBufferAttribute>>;
  arrays: PartArrays & { icon?: Float32Array };
  glow: InstancedBufferAttribute;
  count: number;
}

export class InstancedTurrets {
  readonly levels: LevelRuntime[];
  readonly cap: number;

  constructor(defs: LevelDef[], cap: number, into: Group | Object3D) {
    this.cap = cap;
    this.levels = defs.map((def) => {
      const matrices: Partial<Record<Slot, InstancedBufferAttribute>> = {};
      for (const s of def.slots) {
        const a = new InstancedBufferAttribute(new Float32Array(cap * 16), 16);
        a.setUsage(DynamicDrawUsage);
        matrices[s] = a;
      }
      const glow = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      glow.setUsage(DynamicDrawUsage);
      const meshes = def.batches.map((b) => {
        const m = new InstancedMesh(b.geometry, b.material, cap);
        m.instanceMatrix = matrices[b.slot]!;
        if (b.glow) m.instanceColor = glow;
        m.name = `turret-${def.name}/${b.slot}/${b.key}`;
        m.castShadow = b.castShadow;
        m.receiveShadow = def.name !== 'icon';
        m.frustumCulled = false;
        m.count = 0;
        m.visible = false;
        if (b.slot === 'icon') m.renderOrder = 20;
        into.add(m);
        return m;
      });
      const arrays: PartArrays & { icon?: Float32Array } = {};
      for (const s of def.slots) (arrays as Record<string, Float32Array>)[s] = matrices[s]!.array as Float32Array;
      return { def, meshes, matrices, arrays, glow, count: 0 };
    });
  }

  begin(): void {
    for (const l of this.levels) l.count = 0;
  }

  /** Adds one turret at `level`. `glow` is the slit intensity; `iconScale` the icon's size. */
  push(level: number, f: TurretFrame, x: number, y: number, z: number, yaw: number, pitch: number, recoil: number, glow: number, iconScale: number): void {
    const l = this.levels[level]!;
    const k = l.count;
    if (k >= this.cap) return;
    l.count = k + 1;
    if (l.arrays.icon) {
      writeYaw(l.arrays.icon, k * 16, x, y + 0.4, z, yaw, iconScale);
      return;
    }
    writeTurret(l.arrays, k, f, x, y, z, yaw, pitch, recoil);
    const g = l.glow.array as Float32Array;
    g[k * 3] = glow;
    g[k * 3 + 1] = glow;
    g[k * 3 + 2] = glow;
  }

  commit(): void {
    for (const l of this.levels) {
      const n = l.count;
      for (const m of l.meshes) {
        m.count = n;
        m.visible = n > 0;
      }
      if (n === 0) continue;
      for (const a of Object.values(l.matrices)) {
        a!.clearUpdateRanges();
        a!.addUpdateRange(0, n * 16);
        a!.needsUpdate = true;
      }
      l.glow.clearUpdateRanges();
      l.glow.addUpdateRange(0, n * 3);
      l.glow.needsUpdate = true;
    }
  }

  setVisible(on: boolean): void {
    for (const l of this.levels) for (const m of l.meshes) m.visible = on && l.count > 0;
  }

  /** Draw calls in the colour pass (meshes with at least one instance). */
  get drawCalls(): number {
    let n = 0;
    for (const l of this.levels) if (l.count > 0) n += l.meshes.length;
    return n;
  }

  get counts(): number[] {
    return this.levels.map((l) => l.count);
  }

  get trianglesSubmitted(): number {
    let t = 0;
    for (const l of this.levels) t += l.count * l.def.triangles;
    return t;
  }
}
