// Firing effects for the bench: shells in flight (flown on their exact ballistic arc and
// collision-tested against the aliens every frame, drawn as HDR tracer streaks), the muzzle blast
// (forward flash, side flashes and smoke from each port of the brake, a short point-light flash),
// the breech vent puff and ejected brass casings that tumble, bounce and settle. Alien return fire
// is a slow orange bolt that sparks on the turret's armour (cosmetic).

import { BoxGeometry, Color, CylinderGeometry, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicMaterial, PointLight, Quaternion, Vector3, type Material } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PType, type Particles } from '../fx/particles.ts';
import { GRAVITY, segPointDist, shellAt, type Vec3 } from './aim.ts';
import { rangeHeight } from './range.ts';

export interface ShellHit {
  /** Alien id hit, or null for the ground. */
  id: number | null;
  at: Vector3;
}

interface Shell {
  p0: Vec3;
  v0: Vec3;
  age: number;
  prev: Vec3;
  colour: Color;
  len: number;
  width: number;
  gravity: number;
  friendly: boolean;
  /** Enemy bolts end at their aim point after tEnd seconds. */
  tEnd?: number;
  onEnd?: (at: Vector3) => void;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _a = new Vector3();
const _b = new Vector3();
const _d = new Vector3();
const _s = new Vector3();
const X = new Vector3(1, 0, 0);

export class Shells {
  readonly mesh: InstancedMesh;
  private list: Shell[] = [];
  private colours: InstancedBufferAttribute;
  hits = 0;
  misses = 0;

  constructor(cap = 200) {
    const g = new BoxGeometry(1, 1, 1);
    g.translate(-0.5, 0, 0);
    this.mesh = new InstancedMesh(g, new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.colours = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.colours.setUsage(DynamicDrawUsage);
    this.mesh.instanceColor = this.colours;
  }

  get inFlight(): number {
    return this.list.length;
  }

  fire(from: Vec3, vel: Vec3): void {
    this.list.push({ p0: [...from] as Vec3, v0: [...vel] as Vec3, age: 0, prev: [...from] as Vec3, colour: new Color(10, 6.5, 2.8), len: 1.3, width: 0.05, gravity: GRAVITY, friendly: true });
  }

  enemyBolt(from: Vec3, to: Vec3, speed: number, onEnd: (at: Vector3) => void): void {
    const d = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const k = speed / d;
    this.list.push({ p0: [...from] as Vec3, v0: [(to[0] - from[0]) * k, (to[1] - from[1]) * k, (to[2] - from[2]) * k], age: 0, prev: [...from] as Vec3, colour: new Color(9, 2.6, 0.6), len: 0.7, width: 0.09, gravity: 0, friendly: false, tEnd: 1 / k, onEnd });
  }

  /**
   * Advances every shell by dt. `targets` are tested along the segment flown this frame; the
   * first hit (or the ground) ends the shell.
   */
  update(dt: number, targets: Array<{ id: number; pos: Vec3; radius: number }>, onHit: (h: ShellHit, friendly: boolean) => void): void {
    const keep: Shell[] = [];
    let n = 0;
    for (const s of this.list) {
      s.age += dt;
      const p = shellAt(s.p0, s.v0, s.age, s.gravity);
      let ended = false;
      if (s.friendly) {
        for (const t of targets) {
          if (segPointDist(s.prev, p, t.pos) <= t.radius) {
            this.hits++;
            onHit({ id: t.id, at: new Vector3(...p).lerp(new Vector3(...t.pos), 0.4) }, true);
            ended = true;
            break;
          }
        }
      }
      if (!ended && s.tEnd !== undefined && s.age >= s.tEnd) {
        s.onEnd?.(new Vector3(...shellAt(s.p0, s.v0, s.tEnd, 0)));
        ended = true;
      }
      if (!ended && p[1] < rangeHeight(p[0], p[2])) {
        if (s.friendly) this.misses++;
        p[1] = rangeHeight(p[0], p[2]) + 0.05;
        onHit({ id: null, at: new Vector3(...p) }, s.friendly);
        ended = true;
      }
      if (!ended && s.age > 4) ended = true;
      if (ended) continue;
      keep.push(s);
      // streak from the tail (len behind, clipped to the distance flown) to the head
      _b.set(...p);
      _d.set(s.v0[0], s.v0[1] - s.gravity * s.age, s.v0[2]).normalize();
      const flown = Math.min(s.len, Math.hypot(p[0] - s.p0[0], p[1] - s.p0[1], p[2] - s.p0[2]));
      if (flown > 0.02) {
        _q.setFromUnitVectors(X, _d);
        _m.compose(_b, _q, _s.set(flown, s.width, s.width));
        this.mesh.setMatrixAt(n, _m);
        this.colours.setXYZ(n, s.colour.r, s.colour.g, s.colour.b);
        n++;
      }
      s.prev = p;
    }
    this.list = keep;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colours.needsUpdate = true;
  }

  clear(): void {
    this.list.length = 0;
    this.mesh.count = 0;
  }
}

interface Casing {
  p: Vector3;
  v: Vector3;
  q: Quaternion;
  w: Vector3;
  age: number;
  resting: boolean;
}

/** Brass casings: tumble, bounce on the ground with friction, settle, then sink after 8 s. */
export class Casings {
  readonly mesh: InstancedMesh;
  private list: Casing[] = [];
  private cap: number;

  constructor(material: Material, cap = 40) {
    this.cap = cap;
    const body = new CylinderGeometry(0.032, 0.035, 0.2, 10);
    const rim = new CylinderGeometry(0.04, 0.04, 0.012, 10);
    rim.translate(0, -0.1, 0);
    const g = mergeGeometries([body.toNonIndexed(), rim.toNonIndexed()], false)!;
    g.rotateZ(Math.PI / 2);
    this.mesh = new InstancedMesh(g, material, cap);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
  }

  get count(): number {
    return this.list.length;
  }

  eject(at: Vector3, outward: Vector3, barrelDir: Vector3): void {
    if (this.list.length >= this.cap) this.list.shift();
    const v = outward.clone().multiplyScalar(1.1 + Math.random() * 0.5).addScaledVector(barrelDir, -0.4);
    v.y += 1.3 + Math.random() * 0.4;
    const q = new Quaternion().setFromUnitVectors(X, barrelDir.clone().normalize());
    const w = new Vector3((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 18);
    this.list.push({ p: at.clone(), v, q, w, age: 0, resting: false });
  }

  update(dt: number): void {
    const dq = new Quaternion();
    for (const c of this.list) {
      c.age += dt;
      if (!c.resting) {
        c.v.y -= GRAVITY * dt;
        c.p.addScaledVector(c.v, dt);
        const wl = c.w.length();
        if (wl > 1e-4) {
          dq.setFromAxisAngle(_a.copy(c.w).divideScalar(wl), wl * dt);
          c.q.premultiply(dq);
        }
        const g = rangeHeight(c.p.x, c.p.z) + 0.035;
        if (c.p.y < g) {
          c.p.y = g;
          if (Math.abs(c.v.y) < 0.6) {
            c.resting = Math.hypot(c.v.x, c.v.z) < 0.3;
            c.v.y = 0;
          } else c.v.y = -c.v.y * 0.32;
          c.v.x *= 0.55;
          c.v.z *= 0.55;
          c.w.multiplyScalar(0.5);
          if (c.resting) {
            // lie on its side
            const yaw = Math.atan2(-_d.set(1, 0, 0).applyQuaternion(c.q).z, _d.x);
            c.q.setFromAxisAngle(new Vector3(0, 1, 0), yaw);
          }
        }
      }
    }
    this.list = this.list.filter((c) => c.age < 10);
    let n = 0;
    for (const c of this.list) {
      const sink = Math.max(0, c.age - 8) * 0.05;
      _m.compose(_b.copy(c.p).setY(c.p.y - sink), c.q, _s.set(1, 1, 1));
      this.mesh.setMatrixAt(n++, _m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.list.length = 0;
    this.mesh.count = 0;
  }
}

/** Muzzle blast at the brake: flashes out of each side port and the muzzle, smoke from the same. */
export function muzzleBlast(fx: Particles, muzzle: Vector3, dir: Vector3, side: Vector3, ports: Vector3[], rnd: () => number): void {
  const r = (a: number, b: number) => a + (b - a) * rnd();
  // forward cone of flash: three overlapping sprites stepping out along the bore
  const steps: Array<[number, number, number]> = [
    [0.12, 0.55, 0.07],
    [0.38, 0.45, 0.06],
    [0.7, 0.3, 0.05],
  ];
  for (const [d, s, life] of steps) fx.spawn({ type: PType.Flash, x: muzzle.x + dir.x * d, y: muzzle.y + dir.y * d, z: muzzle.z + dir.z * d, life, s0: s, s1: s * 1.4, r: 9, g: 5.6, b: 2.4, a: 1, drag: 0 });
  for (let i = 0; i < 6; i++) {
    const s = r(4, 9);
    fx.spawn({ type: PType.Spark, x: muzzle.x, y: muzzle.y, z: muzzle.z, vx: dir.x * s + r(-1, 1), vy: dir.y * s + r(-0.5, 1), vz: dir.z * s + r(-1, 1), life: r(0.1, 0.25), s0: 0.05, s1: 0.02, r: 9, g: 6, b: 2.5, a: 1, drag: 1 });
  }
  // side ports: a flash jet and a puff of smoke on each side
  for (const p of ports) {
    for (const sg of [-1, 1]) {
      const sx = side.x * sg;
      const sy = side.y * sg;
      const sz = side.z * sg;
      fx.spawn({ type: PType.Flash, x: p.x + sx * 0.12, y: p.y + sy * 0.12, z: p.z + sz * 0.12, vx: sx * 4, vy: sy * 4, vz: sz * 4, life: 0.06, s0: 0.2, s1: 0.32, r: 8, g: 4.6, b: 1.9, a: 1, drag: 0 });
      fx.spawn({ type: PType.Smoke, x: p.x + sx * 0.15, y: p.y + sy * 0.15, z: p.z + sz * 0.15, vx: sx * r(2, 3.2) + dir.x * 0.6, vy: sy * 2 + r(0.2, 0.6), vz: sz * r(2, 3.2) + dir.z * 0.6, life: r(1.2, 2), s0: 0.14, s1: r(0.7, 1.0), r: 0.55, g: 0.51, b: 0.47, a: 0.55, drag: 2.6, buoy: 0.35 });
    }
  }
  // forward smoke ring
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const ox = side.x * Math.cos(a) * 0.4;
    const oz = side.z * Math.cos(a) * 0.4;
    fx.spawn({ type: PType.Smoke, x: muzzle.x + dir.x * 0.2, y: muzzle.y + dir.y * 0.2 + Math.sin(a) * 0.05, z: muzzle.z + dir.z * 0.2, vx: dir.x * r(2.5, 4) + ox, vy: dir.y * 3 + Math.sin(a) * 0.4 + 0.3, vz: dir.z * r(2.5, 4) + oz, life: r(1.4, 2.2), s0: 0.18, s1: r(0.9, 1.3), r: 0.58, g: 0.54, b: 0.5, a: 0.5, drag: 2.2, buoy: 0.3 });
  }
}

/** Breech vent: a puff of hot gas and smoke out of the ejection port. */
export function breechVent(fx: Particles, at: Vector3, outward: Vector3): void {
  fx.spawn({ type: PType.Fire, x: at.x, y: at.y, z: at.z, vx: outward.x * 1.5, vy: 0.6, vz: outward.z * 1.5, life: 0.12, s0: 0.12, s1: 0.22, r: 4, g: 1.8, b: 0.6, a: 0.8, drag: 3 });
  for (let i = 0; i < 3; i++) fx.spawn({ type: PType.Smoke, x: at.x, y: at.y, z: at.z, vx: outward.x * (1 + i * 0.4), vy: 0.7 + i * 0.2, vz: outward.z * (1 + i * 0.4), life: 1.4, s0: 0.1, s1: 0.55, r: 0.6, g: 0.57, b: 0.54, a: 0.45, drag: 2.4, buoy: 0.4 });
}

/** A point light at the muzzle that flashes with each shot (kept in the scene so the shader's light count never changes). */
export function muzzleLight(): PointLight {
  const l = new PointLight(new Color(1, 0.62, 0.3), 0, 9, 2);
  l.castShadow = false;
  return l;
}
