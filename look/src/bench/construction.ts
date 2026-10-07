// Construction animation in the Supreme Commander manner: a cyan footprint outline appears, a
// wireframe ghost of the whole turret stands over it, and the solid turret is built from the
// ground up — every turret material is clipped above a rising build height (shadows clip too) and
// glows cyan in a band just below the cut, while sparks fly off the band. When the cut passes the
// top, the lights come on, the head turns to its heading and the gun elevates; then fire control
// takes over.

import { AdditiveBlending, BufferGeometry, Color, Group, LineBasicMaterial, LineLoop, Mesh, MeshBasicMaterial, Plane, Vector3, type InstancedMesh } from 'three';
import { PType, type Particles } from '../fx/particles.ts';
import { build } from './surface.ts';
import type { TurretRig } from './turretRig.ts';

export const BUILD_TIME = 7.5;

export class Construction {
  active = false;
  t = 0;
  readonly ghosts = new Group();
  private ghostPlane = new Plane(new Vector3(0, 1, 0), 0);
  private ghostMat: MeshBasicMaterial;
  private outline: LineLoop;
  private sparkAcc = 0;

  constructor(
    private rig: TurretRig,
    private fx: Particles,
  ) {
    this.ghostMat = new MeshBasicMaterial({ color: new Color(0.2, 0.75, 1.0), wireframe: true, transparent: true, opacity: 0.22, blending: AdditiveBlending, depthWrite: false, clippingPlanes: [this.ghostPlane], toneMapped: false, fog: false });
    // ghost copies share the full level's geometry and sit under the same pivots
    for (const m of rig.fullMeshes) {
      if ((m as InstancedMesh).isInstancedMesh) continue;
      const g = new Mesh(m.geometry, this.ghostMat);
      g.name = `${m.name}-ghost`;
      g.visible = false;
      m.parent!.add(g);
    }
    const pts: Vector3[] = [];
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + (i * Math.PI) / 4;
      pts.push(new Vector3(Math.cos(a) * 1.12, 0.03, -Math.sin(a) * 1.12));
    }
    this.outline = new LineLoop(new BufferGeometry().setFromPoints(pts), new LineBasicMaterial({ color: new Color(0.6, 2.4, 3.2), transparent: true, opacity: 0, toneMapped: false }));
    rig.root.add(this.outline);
  }

  private setGhosts(on: boolean): void {
    this.rig.root.traverse((o) => {
      if (o.name.endsWith('-ghost')) o.visible = on;
    });
  }

  start(): void {
    this.active = true;
    this.t = 0;
    this.setGhosts(true);
    build.set(0, 1);
  }

  stop(): void {
    this.active = false;
    this.setGhosts(false);
    (this.outline.material as LineBasicMaterial).opacity = 0;
    build.set(1e4, 0);
  }

  /** Advances the build; returns the pose override for the power-up stage (null = hands off). */
  update(dt: number, poseNow: { yaw: number; pitch: number }): { yaw: number; pitch: number; lights: number } | null {
    if (!this.active) return null;
    this.t += dt;
    const t = this.t;
    const top = this.rig.model.top + 0.05;
    const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
    (this.outline.material as LineBasicMaterial).opacity = Math.min(1, t / 0.4) * (1 - ease((t - 5.6) / 0.8));
    const u = ease((t - 0.5) / 5.2);
    const y = -0.02 + (top + 0.04) * u;
    build.set(t < 0.5 ? -0.05 : y, 1 - ease((t - 5.6) / 0.6));
    this.ghostPlane.constant = -y;
    (this.ghostMat as MeshBasicMaterial).opacity = 0.22 * (1 - ease((t - 5.5) / 0.6));
    // sparks round the band: radius by height (base, then ring, then head)
    if (t > 0.5 && t < 5.8) {
      this.sparkAcc += dt * 70;
      const rad = y < 0.45 ? 0.95 : y < 0.61 ? 0.54 : 0.6;
      while (this.sparkAcc >= 1) {
        this.sparkAcc--;
        const a = Math.random() * Math.PI * 2;
        const p = new Vector3(Math.cos(a) * rad, y, -Math.sin(a) * rad).applyMatrix4(this.rig.root.matrixWorld);
        const s = 1 + Math.random() * 2;
        this.fx.spawn({ type: PType.Spark, x: p.x, y: p.y, z: p.z, vx: Math.cos(a) * s, vy: Math.random() * 1.5, vz: -Math.sin(a) * s, life: 0.3 + Math.random() * 0.3, s0: 0.05, s1: 0.02, r: 1.6, g: 6, b: 9, a: 1, drag: 1.2 });
      }
    }
    // power-up: lights on, head swings from where it was built to the current heading, gun lifts
    const p = ease((t - 6.0) / 1.4);
    const lights = ease((t - 5.8) / 0.5);
    if (t >= BUILD_TIME) {
      this.stop();
      return null;
    }
    return { yaw: poseNow.yaw * p, pitch: -5 * (Math.PI / 180) * (1 - p) + poseNow.pitch * p, lights };
  }
}
