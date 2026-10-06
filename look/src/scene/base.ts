// Places map 1's base: buildings (one ModelLayer per kind), foundation pads, energy conduits,
// belt items, the shield dome, commander and engineers. Owns turret aiming and firing.
// Everything mesh-related comes from the ModelSource, so a glTF source drops in here unchanged.

import {
  AdditiveBlending,
  BackSide,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { Builder, cbox, tubeX } from '../models/kit.ts';
import type { Mats } from '../models/materials.ts';
import type { ModelSource } from '../models/types.ts';
import type { Particles } from '../fx/particles.ts';
import type { Tracers } from '../fx/tracers.ts';
import { heightAt } from '../world/heightfield.ts';
import { buildings, centreOf, conduits, sizeOf, units } from '../world/layout.ts';
import { ModelLayer, placeMatrix } from './modelLayer.ts';

export interface Target {
  pos: Vector3;
  alive: boolean;
  hit(damage: number, at: Vector3): void;
}

interface Turret {
  kind: 'gun' | 'area' | 'beam' | 'heavy';
  layer: ModelLayer;
  index: number;
  pos: Vector3;
  facing: number;
  range: number;
  interval: number;
  cool: number;
  aimWorld: number;
  target: Target | null;
  burst: number;
}

const IDENT_Q = new Quaternion();
const RANGE = { gun: 24, area: 34, beam: 20, heavy: 44 } as const;
const INTERVAL = { gun: 0.22, area: 2.4, beam: 1.8, heavy: 3.8 } as const;

export class BaseScene {
  readonly group = new Group();
  readonly layers = new Map<string, ModelLayer>();
  readonly turrets: Turret[] = [];
  private beltItems: InstancedMesh;
  private dome: Mesh;
  private chimneys: Vector3[] = [];
  private engineerHome: Array<{ x: number; z: number; r: number }> = [];

  constructor(
    src: ModelSource,
    mats: Mats,
    private fx: Particles,
    private tracers: Tracers,
  ) {
    // ---- buildings
    const byKind = new Map<string, typeof buildings>();
    const keyOf = (b: (typeof buildings)[number]) => (b.kind === 'wall' && (b.tier ?? 1) >= 3 ? 'wall:3' : b.kind);
    for (const b of buildings) byKind.set(keyOf(b), [...(byKind.get(keyOf(b)) ?? []), b]);
    for (const [key, list] of byKind) {
      const kind = list[0]!.kind;
      const model = src.building(kind, list[0]!.tier);
      const layer = new ModelLayer(model, list.length);
      this.layers.set(key, layer);
      this.group.add(layer.group);
      for (const b of list) {
        const c = centreOf(b);
        const y = heightAt(c.x, c.z) + (kind === 'wall' || kind === 'belt' ? 0 : 0.06);
        const diag = key === 'wall' && Math.abs(b.rot + Math.PI / 4) < 0.01;
        const i = layer.add(placeMatrix(c.x, y, c.z, b.rot, diag ? [1.42, 1, 1] : [1, 1, 1]));
        if (kind === 'gun' || kind === 'area' || kind === 'beam' || kind === 'heavy') {
          const facing = b.rot;
          this.turrets.push({ kind, layer, index: i, pos: new Vector3(c.x, y, c.z), facing, range: RANGE[kind], interval: INTERVAL[kind], cool: Math.random() * INTERVAL[kind], aimWorld: facing, target: null, burst: 0 });
          layer.states[i]!.aim = 0;
        }
        if (kind === 'smelter') for (const z of [-0.35, 0.35]) this.chimneys.push(new Vector3(c.x - 0.35, y + 2.4, c.z + z));
      }
    }
    // ---- foundation pads (scene-owned so model sources need not provide them)
    const padList = buildings.filter((b) => b.kind !== 'wall' && b.kind !== 'belt');
    const pads = new InstancedMesh(new Builder(mats).add('pad', cbox(1, 0.14, 1, 0.03, 0.08)).build().geometry, mats.pad, padList.length);
    padList.forEach((b, i) => {
      const c = centreOf(b);
      const s = sizeOf(b.kind) + 0.35;
      pads.setMatrixAt(i, new Matrix4().compose(new Vector3(c.x, heightAt(c.x, c.z) - 0.08, c.z), IDENT_Q, new Vector3(s, 1, s)));
    });
    pads.receiveShadow = true;
    pads.castShadow = true;
    pads.computeBoundingSphere();
    this.group.add(pads);
    // ---- conduits
    this.group.add(this.buildConduits(mats));
    // ---- belt items
    this.beltItems = new InstancedMesh(new Builder(mats).add('copper', cbox(0.28, 0.2, 0.3, 0.03)).build().geometry, mats.copper, 24);
    this.beltItems.castShadow = true;
    this.beltItems.receiveShadow = true;
    this.beltItems.frustumCulled = false;
    this.group.add(this.beltItems);
    // ---- units
    const cmd = new ModelLayer(src.unit('commander'), 1);
    const eng = new ModelLayer(src.unit('engineer'), units.length, { dynamic: true });
    this.layers.set('commander', cmd);
    this.layers.set('engineer', eng);
    this.group.add(cmd.group, eng.group);
    for (const u of units) {
      const y = heightAt(u.x, u.z);
      if (u.kind === 'commander') cmd.add(placeMatrix(u.x, y, u.z, u.rot));
      else {
        eng.add(placeMatrix(u.x, y, u.z, u.rot));
        this.engineerHome.push({ x: u.x, z: u.z, r: u.rot });
      }
    }
    // ---- shield dome
    const sh = buildings.find((b) => b.kind === 'shield')!;
    const sc = centreOf(sh);
    this.dome = shieldDome();
    this.dome.position.set(sc.x, heightAt(sc.x, sc.z), sc.z);
    this.group.add(this.dome);
    for (const p of this.chimneys) fx.addEmitter('chimney', p, 0.7);
  }

  private buildConduits(mats: Mats): Mesh {
    const b = new Builder(mats);
    for (const line of conduits) {
      for (let i = 0; i + 1 < line.length; i++) {
        const [x0, z0] = line[i]!;
        const [x1, z1] = line[i + 1]!;
        const dx = x1 - x0;
        const dz = z1 - z0;
        const len = Math.hypot(dx, dz);
        if (len < 0.05) continue;
        let hmax = -Infinity;
        for (let k = 0; k <= 8; k++) hmax = Math.max(hmax, heightAt(x0 + (dx * k) / 8, z0 + (dz * k) / 8));
        const y = hmax + 0.32;
        const ry = Math.atan2(-dz, dx);
        b.add('ivory', tubeX(0.1, len, 12), { x: x0, y, z: z0, ry }, { wear: false });
        b.add('glow', cbox(len, 0.025, 0.05, 0, 0), { x: x0 + dx / 2, y: y + 0.088, z: z0 + dz / 2, ry });
        // support brackets every ~1.6 tiles
        const n = Math.max(1, Math.floor(len / 1.6));
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          const px = x0 + dx * t;
          const pz = z0 + dz * t;
          const gy = heightAt(px, pz);
          b.add('trim', cbox(0.07, y - gy, 0.07, 0.01, 0.01), { x: px, y: gy, z: pz, ry });
          b.add('copper', tubeX(0.12, 0.08, 12), { x: px - (dx / len) * 0.04, y, z: pz - (dz / len) * 0.04, ry });
        }
      }
    }
    const { geometry, material } = b.build();
    const m = new Mesh(geometry, material);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'conduits';
    return m;
  }

  update(t: number, dt: number, targets: Target[]): void {
    // engineers drift round their spot
    const eng = this.layers.get('engineer')!;
    this.engineerHome.forEach((h, i) => {
      const a = t * 0.25 + i * 1.7;
      const x = h.x + Math.cos(a) * 0.8;
      const z = h.z + Math.sin(a) * 0.8;
      eng.states[i]!.matrix.copy(placeMatrix(x, heightAt(x, z), z, -a - Math.PI / 2));
    });
    eng.markDirty();
    // belt items
    const m = new Matrix4();
    for (let i = 0; i < 24; i++) {
      const x = 58 + ((t * 0.9 + i * 0.6) % 14.2);
      const inMachine = (x > 59.7 && x < 62.3) || (x > 63.7 && x < 66.3) || (x > 67.7 && x < 70.3) || x > 71.9;
      const y = heightAt(x, 82.5) + 0.33;
      const k = inMachine ? 0 : 1;
      m.compose(new Vector3(x, y, 82.5), IDENT_Q, new Vector3(k, k, k));
      this.beltItems.setMatrixAt(i, m);
    }
    this.beltItems.instanceMatrix.needsUpdate = true;
    (this.dome.material as ShaderMaterial).uniforms.uTime!.value = t;
    this.turretsUpdate(t, dt, targets);
    for (const l of this.layers.values()) l.update(t);
  }

  private turretsUpdate(t: number, dt: number, targets: Target[]): void {
    const tmp = new Vector3();
    for (const tu of this.turrets) {
      const st = tu.layer.states[tu.index]!;
      st.recoil = Math.max(0, st.recoil - dt * 3);
      if (!tu.target || !tu.target.alive || tu.target.pos.distanceTo(tu.pos) > tu.range) {
        tu.target = null;
        let best = tu.range;
        for (const a of targets) {
          if (!a.alive) continue;
          const d = a.pos.distanceTo(tu.pos);
          if (d < best) {
            best = d;
            tu.target = a;
          }
        }
      }
      tu.cool -= dt;
      if (!tu.target) continue;
      const tp = tu.target.pos;
      const want = Math.atan2(-(tp.z - tu.pos.z), tp.x - tu.pos.x);
      let diff = want - tu.aimWorld;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const slew = (tu.kind === 'heavy' ? 0.9 : 2.2) * dt;
      tu.aimWorld += Math.max(-slew, Math.min(slew, diff));
      st.aim = tu.aimWorld - tu.facing;
      if (Math.abs(diff) > 0.12 || tu.cool > 0) continue;
      tu.cool = tu.interval;
      const model = tu.layer.model;
      const headName = model.parts.find((p) => p.motion.kind === 'aim')?.name ?? 'base';
      const muzzle = tu.layer.partPoint(tu.index, headName, model.muzzle ?? [0.5, 0.5, 0], t, new Vector3());
      const dir = tmp.subVectors(tp, muzzle).normalize().clone();
      const target = tu.target;
      const aim = tp.clone().add(new Vector3((Math.random() - 0.5) * 0.4, 0.35, (Math.random() - 0.5) * 0.4));
      st.recoil = 1;
      if (tu.kind === 'gun') {
        this.fx.muzzle(muzzle.x, muzzle.y, muzzle.z, dir);
        this.tracers.fire({ from: muzzle, to: aim, dur: muzzle.distanceTo(aim) / 70, arc: 0, len: 1.6, width: 0.07, colour: new Color(9, 6, 2.5), beam: false, onHit: () => target.hit(1, aim) });
      } else if (tu.kind === 'heavy') {
        this.fx.muzzle(muzzle.x, muzzle.y, muzzle.z, dir, true);
        this.tracers.fire({ from: muzzle, to: aim, dur: muzzle.distanceTo(aim) / 50, arc: 0, len: 2.6, width: 0.16, colour: new Color(10, 5, 2), beam: false, onHit: () => {
          target.hit(8, aim);
          this.fx.explosion(aim.x, aim.y - 0.3, aim.z, 0.8);
        } });
      } else if (tu.kind === 'area') {
        this.fx.muzzle(muzzle.x, muzzle.y, muzzle.z, dir, true);
        const d = muzzle.distanceTo(aim);
        this.tracers.fire({ from: muzzle, to: aim, dur: d / 20, arc: d * 0.28, len: 0.7, width: 0.18, colour: new Color(8, 4, 1.6), beam: false, onHit: () => {
          this.fx.explosion(aim.x, aim.y - 0.3, aim.z, 1.1);
          for (const a of targets) if (a.alive && a.pos.distanceTo(aim) < 2.5) a.hit(3, a.pos);
        } });
      } else {
        this.tracers.fire({ from: muzzle, to: aim, dur: 0.7, arc: 0, len: 0, width: 0.12, colour: new Color(1.5, 7, 9), beam: true, onHit: () => target.hit(4, aim) });
        this.fx.sparks(aim.x, aim.y, aim.z, 10, 5);
      }
    }
  }
}

function shieldDome(): Mesh {
  const m = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: BackSide,
    uniforms: { uTime: { value: 0 }, uCol: { value: new Color(0.25, 0.85, 1.0) } },
    vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vP = position; vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - wp.xyz);
      gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */ `uniform float uTime; uniform vec3 uCol; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      float hexDist(vec2 p){ p = abs(p); return max(dot(p, normalize(vec2(1.0,1.732))), p.x); }
      void main(){
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
        vec2 uv = vec2(atan(vP.z, vP.x) * 4.0, vP.y * 0.9);
        vec2 r = vec2(1.0, 1.732); vec2 h = r * 0.5;
        vec2 a = mod(uv, r) - h; vec2 b = mod(uv - h, r) - h;
        vec2 g = dot(a,a) < dot(b,b) ? a : b;
        float edge = smoothstep(0.42, 0.5, hexDist(g));
        float sweep = 0.5 + 0.5 * sin(vP.y * 1.3 - uTime * 1.6);
        float base = smoothstep(0.0, 1.2, vP.y);
        float i = (0.05 + f * 0.55 + edge * 0.12 * (0.4 + sweep)) * base;
        gl_FragColor = vec4(uCol * i, 1.0);
      }`,
  });
  const g = new SphereGeometry(8, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2);
  const mesh = new Mesh(g, m);
  mesh.renderOrder = 12;
  mesh.name = 'shieldDome';
  return mesh;
}
