// Draws every instance of one ModelDef: one InstancedMesh per part (each part's geometry groups
// give one draw call per material). Animated parts get their matrices recomputed every frame from
// the per-instance state; static parts only when an instance changes. Works for any ModelSource,
// so swapping code-built models for glTF ones leaves this file untouched.

import { Group, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import type { ModelDef, Motion, PartDef } from '../models/types.ts';

export interface InstanceState {
  /** Instance → world (position, facing, scale). */
  matrix: Matrix4;
  /** Turret yaw relative to the facing, radians. */
  aim: number;
  /** Barrel elevation, radians. */
  elev: number;
  /** Gait phase, radians (advanced by the scene with ground speed). */
  phase: number;
  /** 0..1, decays after each shot. */
  recoil: number;
  /** Per-instance offset for spins and bobs. */
  seed: number;
  visible: boolean;
}

const _m = new Matrix4();
const _p = new Matrix4();
const _mot = new Matrix4();
const _q = new Quaternion();
const _v = new Vector3();
const ZERO = new Matrix4().makeScale(0, 0, 0);
const AX = { x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1) };

function animated(m: Motion): boolean {
  return m.kind !== 'static';
}

export function motionMatrix(motion: Motion, s: InstanceState, t: number, out: Matrix4): Matrix4 {
  switch (motion.kind) {
    case 'static':
      return out.identity();
    case 'aim':
      return out.makeRotationY(s.aim);
    case 'elevate':
      return out.makeRotationZ(s.elev);
    case 'spin':
      return out.makeRotationFromQuaternion(_q.setFromAxisAngle(AX[motion.axis], motion.speed * t + s.seed * 6.283));
    case 'bob':
      return out.makeTranslation(0, motion.amp * Math.sin(6.283 * motion.rate * t + s.seed * 6.283), 0);
    case 'gait': {
      const a = s.phase + motion.phase;
      out.makeRotationZ(motion.swing * Math.sin(a));
      out.setPosition(0, motion.lift * Math.max(0, Math.cos(a)), 0);
      return out;
    }
    case 'recoil':
      return out.makeTranslation(-motion.dist * s.recoil, 0, 0);
  }
}

export class ModelLayer {
  readonly group = new Group();
  readonly states: InstanceState[] = [];
  private meshes: InstancedMesh[] = [];
  private parts: PartDef[];
  private partIndex = new Map<string, number>();
  private dirty = true;
  private anyAnimated: boolean[];

  constructor(
    readonly model: ModelDef,
    readonly capacity: number,
    opts: { castShadow?: boolean; dynamic?: boolean } = {},
  ) {
    this.parts = model.parts;
    this.parts.forEach((p, i) => this.partIndex.set(p.name, i));
    this.anyAnimated = this.parts.map((p) => animated(p.motion) || (p.parent ? animated(this.parts[this.partIndex.get(p.parent)!]!.motion) : false));
    for (const p of this.parts) {
      const mesh = new InstancedMesh(p.geometry, p.material, capacity);
      mesh.name = `${model.name}/${p.name}`;
      mesh.castShadow = opts.castShadow ?? p.castShadow ?? true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      mesh.frustumCulled = !opts.dynamic;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  add(matrix: Matrix4, seed = Math.random()): number {
    if (this.states.length >= this.capacity) throw new Error(`${this.model.name}: capacity ${this.capacity} reached`);
    this.states.push({ matrix: matrix.clone(), aim: 0, elev: 0, phase: seed * 6.283, recoil: 0, seed, visible: true });
    this.dirty = true;
    for (const m of this.meshes) m.count = this.states.length;
    return this.states.length - 1;
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** Model-space matrix of a part (pivot × motion, through its parent). */
  partLocal(pi: number, s: InstanceState, t: number, out: Matrix4): Matrix4 {
    const p = this.parts[pi]!;
    out.copy(p.pivot).multiply(motionMatrix(p.motion, s, t, _mot));
    if (p.parent) {
      const qi = this.partIndex.get(p.parent)!;
      const q = this.parts[qi]!;
      _p.copy(q.pivot).multiply(motionMatrix(q.motion, s, t, _mot));
      out.premultiply(_p);
    }
    return out;
  }

  /** World position of a point given in a part's space. */
  partPoint(index: number, partName: string, local: [number, number, number], t: number, out: Vector3): Vector3 {
    const s = this.states[index]!;
    const pi = this.partIndex.get(partName) ?? 0;
    const m = this.partLocal(pi, s, t, new Matrix4()).premultiply(s.matrix);
    return out.set(local[0], local[1], local[2]).applyMatrix4(m);
  }

  update(t: number): void {
    const full = this.dirty;
    for (let pi = 0; pi < this.parts.length; pi++) {
      if (!full && !this.anyAnimated[pi]) continue;
      const mesh = this.meshes[pi]!;
      for (let i = 0; i < this.states.length; i++) {
        const s = this.states[i]!;
        if (!s.visible) {
          mesh.setMatrixAt(i, ZERO);
          continue;
        }
        this.partLocal(pi, s, t, _m.identity());
        _m.premultiply(s.matrix);
        mesh.setMatrixAt(i, _m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (full && mesh.frustumCulled) mesh.computeBoundingSphere();
    }
    this.dirty = false;
  }
}

export function placeMatrix(x: number, y: number, z: number, yaw: number, scale: [number, number, number] = [1, 1, 1], tilt?: Quaternion): Matrix4 {
  const q = new Quaternion().setFromAxisAngle(AX.y, yaw);
  if (tilt) q.premultiply(tilt);
  return new Matrix4().compose(_v.set(x, y, z).clone(), q, new Vector3(...scale));
}
