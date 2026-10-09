// Ported from look/src/fx/particles.ts for W24 run 2b (game/src/render/workshop/README: copies, adapted only where noted).
// Camera-facing particle sprites for smoke, dust, fire, sparks and muzzle flashes.
// Two instanced quads: smoke/dust (alpha-blended, sorted back to front, lit by the sun colour)
// and glow (additive HDR, so it feeds the bloom). The puff atlas is generated in code.
// Fog uses the same formula as the scene (render/fog.ts) so plumes fade into the haze.

import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Texture,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type Camera,
} from 'three';
import { Rand } from '../noise.ts';
import { FOG_GLSL } from '../render/fog.ts';

// Adapted (W24 run 2b): a const object instead of a `const enum`, so the game's bundler and
// vitest need no cross-module enum inlining.
export const PType = { Smoke: 0, Dust: 1, Fire: 2, Spark: 3, Flash: 4, Ember: 5 } as const;
export type PType = (typeof PType)[keyof typeof PType];

function puffAtlas(): Texture {
  // Adapted (W24 run 2b): outside a browser (the Node tests) there is no OffscreenCanvas or
  // ImageData; the particles then sample a blank texture (their buffers, which the tests read, are
  // unchanged).
  if (typeof OffscreenCanvas === 'undefined' || typeof ImageData === 'undefined') return new Texture();
  const S = 512;
  const cell = 128;
  const img = new ImageData(S, S);
  const rnd = new Rand(9);
  const grid = 16;
  const g = Array.from({ length: grid * grid * 16 }, () => rnd.next());
  const vn = (x: number, y: number, k: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const at = (i: number, j: number) => g[(k * grid * grid + ((j % grid) + grid) % grid * grid + (((i % grid) + grid) % grid)) % g.length]!;
    const a = at(ix, iy);
    const b = at(ix + 1, iy);
    const c = at(ix, iy + 1);
    const d = at(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  for (let f = 0; f < 16; f++) {
    const ox = (f % 4) * cell;
    const oy = Math.floor(f / 4) * cell;
    const dens = new Float32Array(cell * cell);
    for (let y = 0; y < cell; y++)
      for (let x = 0; x < cell; x++) {
        const u = x / cell - 0.5;
        const v = y / cell - 0.5;
        const r = Math.hypot(u, v) * 2;
        let n = 0;
        let amp = 0.5;
        let fr = 4;
        for (let o = 0; o < 4; o++) {
          n += amp * vn(u * fr + f * 3.1, v * fr + f * 1.7, f);
          amp *= 0.5;
          fr *= 2;
        }
        const edge = 1 - Math.min(1, r * (0.75 + 0.5 * n));
        dens[y * cell + x] = Math.max(0, edge) ** 1.4 * (0.55 + 0.6 * n);
      }
    for (let y = 0; y < cell; y++)
      for (let x = 0; x < cell; x++) {
        const d = dens[y * cell + x]!;
        // lit from upper left: compare with a sample towards the light
        const lx = Math.max(0, x - 6);
        const ly = Math.max(0, y - 6);
        const toward = dens[ly * cell + lx]!;
        const lit = Math.max(0, Math.min(1, 0.6 + (d - toward) * 2.5 + 0.25));
        const o = ((oy + y) * S + ox + x) * 4;
        img.data[o] = lit * 255;
        img.data[o + 1] = d * 255;
        img.data[o + 2] = 0;
        img.data[o + 3] = Math.min(1, d * 1.6) * 255;
      }
  }
  const c = new OffscreenCanvas(S, S);
  c.getContext('2d')!.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  return t;
}

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iCol;
attribute vec4 iPar; // size, rotation, frame (-1 = round dot), stretch
attribute vec3 iVel;
varying vec2 vUv;
varying vec4 vCol;
varying float vFrame;
varying float vFogDepth;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  vec2 c = position.xy;
  if (iPar.w > 0.0) {
    vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
    vec2 d = normalize(vv.xy + vec2(1e-5, 0.0));
    vec2 nn = vec2(-d.y, d.x);
    mv.xy += d * c.x * iPar.x * (1.0 + iPar.w) + nn * c.y * iPar.x * 0.35;
  } else {
    float r = iPar.y;
    mat2 R = mat2(cos(r), sin(r), -sin(r), cos(r));
    mv.xy += R * c * iPar.x;
  }
  gl_Position = projectionMatrix * mv;
  vUv = position.xy + 0.5;
  vCol = iCol;
  vFrame = iPar.z;
  vFogDepth = -mv.z;
}
`;

const FRAG_SMOKE = /* glsl */ `
uniform sampler2D tAtlas;
uniform vec3 uSun;
uniform vec3 uAmb;
uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
varying vec2 vUv; varying vec4 vCol; varying float vFrame; varying float vFogDepth;
${FOG_GLSL}
void main() {
  float f = floor(vFrame + 0.5);
  vec2 cell = vec2(mod(f, 4.0), floor(f / 4.0));
  vec4 t = texture2D(tAtlas, (cell + vUv) / 4.0);
  float a = t.a * vCol.a;
  if (a < 0.003) discard;
  vec3 col = vCol.rgb * (uAmb + uSun * t.r);
  float ff = lookFog(vFogDepth, fogNear, fogFar);
  col = mix(col, fogColor, ff);
  gl_FragColor = vec4(col, a);
}
`;

const FRAG_GLOW = /* glsl */ `
uniform sampler2D tAtlas;
uniform float fogNear; uniform float fogFar;
varying vec2 vUv; varying vec4 vCol; varying float vFrame; varying float vFogDepth;
${FOG_GLSL}
void main() {
  float a;
  if (vFrame < 0.0) {
    float r = length(vUv - 0.5) * 2.0;
    a = pow(max(0.0, 1.0 - r), 2.0);
  } else {
    float f = floor(vFrame + 0.5);
    vec2 cell = vec2(mod(f, 4.0), floor(f / 4.0));
    vec4 t = texture2D(tAtlas, (cell + vUv) / 4.0);
    a = t.g * t.g * 1.6;
  }
  a *= vCol.a;
  if (a < 0.002) discard;
  float ff = lookFog(vFogDepth, fogNear, fogFar);
  gl_FragColor = vec4(vCol.rgb * a * (1.0 - ff), 1.0);
}
`;

class Pool {
  n = 0;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly size: Float32Array; // start, end
  readonly rot: Float32Array; // angle, spin
  readonly type: Uint8Array;
  readonly frame: Float32Array;
  readonly col: Float32Array; // rgb + alpha peak
  readonly drag: Float32Array;
  readonly buoy: Float32Array;
  constructor(readonly cap: number) {
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.age = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.size = new Float32Array(cap * 2);
    this.rot = new Float32Array(cap * 2);
    this.type = new Uint8Array(cap);
    this.frame = new Float32Array(cap);
    this.col = new Float32Array(cap * 4);
    this.drag = new Float32Array(cap);
    this.buoy = new Float32Array(cap);
  }
  kill(i: number) {
    const j = --this.n;
    if (i === j) return;
    this.pos.copyWithin(i * 3, j * 3, j * 3 + 3);
    this.vel.copyWithin(i * 3, j * 3, j * 3 + 3);
    this.age[i] = this.age[j]!;
    this.life[i] = this.life[j]!;
    this.size.copyWithin(i * 2, j * 2, j * 2 + 2);
    this.rot.copyWithin(i * 2, j * 2, j * 2 + 2);
    this.type[i] = this.type[j]!;
    this.frame[i] = this.frame[j]!;
    this.col.copyWithin(i * 4, j * 4, j * 4 + 4);
    this.drag[i] = this.drag[j]!;
    this.buoy[i] = this.buoy[j]!;
  }
}

interface Emitter {
  pos: Vector3;
  kind: 'plume' | 'fire' | 'dust' | 'chimney';
  rate: number;
  acc: number;
  scale: number;
  follow?: () => Vector3 | null;
  active: boolean;
}

export interface ParticleSpec {
  type: PType;
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  s0: number;
  s1: number;
  r: number;
  g: number;
  b: number;
  a: number;
  drag?: number;
  buoy?: number;
  spin?: number;
}

export class Particles {
  readonly smokeMesh: Mesh;
  readonly glowMesh: Mesh;
  readonly atlas: Texture;
  private smoke: Pool;
  private glow: Pool;
  private emitters: Emitter[] = [];
  private rnd = new Rand(321);
  private order: Uint32Array;
  private depth: Float32Array;
  private wind = new Vector3(0.9, 0, -0.35);
  readonly smokeUniforms: { uSun: { value: Color }; uAmb: { value: Color } };

  /** Pool sizes: particles beyond a cap are not spawned (W17 and W20 use 5000 each). */
  constructor(caps: { smoke?: number; glow?: number } = {}) {
    this.smoke = new Pool(caps.smoke ?? 5000);
    this.glow = new Pool(caps.glow ?? 5000);
    const most = Math.max(this.smoke.cap, this.glow.cap);
    this.order = new Uint32Array(most);
    this.depth = new Float32Array(most);
    this.atlas = puffAtlas();
    const mk = (pool: Pool, frag: string, additive: boolean, uniforms: Record<string, { value: unknown }>) => {
      const quad = new PlaneGeometry(1, 1);
      const g = new InstancedBufferGeometry();
      g.index = quad.index;
      g.setAttribute('position', quad.getAttribute('position'));
      const attr = (name: string, n: number) => {
        const a = new InstancedBufferAttribute(new Float32Array(pool.cap * n), n);
        a.setUsage(DynamicDrawUsage);
        g.setAttribute(name, a);
      };
      attr('iPos', 3);
      attr('iCol', 4);
      attr('iPar', 4);
      attr('iVel', 3);
      g.instanceCount = 0;
      const mat = new ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: frag,
        uniforms: UniformsUtils.merge([UniformsLib.fog, uniforms]),
        transparent: true,
        depthWrite: false,
        blending: additive ? AdditiveBlending : NormalBlending,
        fog: true,
      });
      (mat.uniforms.tAtlas as { value: Texture }).value = this.atlas;
      const mesh = new Mesh(g, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = additive ? 11 : 10;
      return mesh;
    };
    this.smokeMesh = mk(this.smoke, FRAG_SMOKE, false, { tAtlas: { value: null }, uSun: { value: new Color(1, 0.8, 0.6) }, uAmb: { value: new Color(0.35, 0.3, 0.28) } });
    this.glowMesh = mk(this.glow, FRAG_GLOW, true, { tAtlas: { value: null } });
    const u = (this.smokeMesh.material as ShaderMaterial).uniforms;
    this.smokeUniforms = { uSun: u.uSun as { value: Color }, uAmb: u.uAmb as { value: Color } };
  }

  get count(): number {
    return this.smoke.n + this.glow.n;
  }

  /** Adapted (W24 run 2b): drops every particle and emitter (a world reset), and empties the meshes. */
  clear(): void {
    this.smoke.n = 0;
    this.glow.n = 0;
    this.emitters = [];
    (this.smokeMesh.geometry as InstancedBufferGeometry).instanceCount = 0;
    (this.glowMesh.geometry as InstancedBufferGeometry).instanceCount = 0;
  }

  /** Live and maximum particles per pool, and the number of persistent emitters. */
  get usage(): { smoke: number; smokeCap: number; glow: number; glowCap: number; emitters: number } {
    return { smoke: this.smoke.n, smokeCap: this.smoke.cap, glow: this.glow.n, glowCap: this.glow.cap, emitters: this.emitters.length };
  }

  spawn(p: ParticleSpec): void {
    const pool = p.type === PType.Smoke || p.type === PType.Dust ? this.smoke : this.glow;
    if (pool.n >= pool.cap) return;
    const i = pool.n++;
    pool.pos[i * 3] = p.x;
    pool.pos[i * 3 + 1] = p.y;
    pool.pos[i * 3 + 2] = p.z;
    pool.vel[i * 3] = p.vx ?? 0;
    pool.vel[i * 3 + 1] = p.vy ?? 0;
    pool.vel[i * 3 + 2] = p.vz ?? 0;
    pool.age[i] = 0;
    pool.life[i] = p.life;
    pool.size[i * 2] = p.s0;
    pool.size[i * 2 + 1] = p.s1;
    pool.rot[i * 2] = this.rnd.range(0, 6.283);
    pool.rot[i * 2 + 1] = p.spin ?? this.rnd.range(-0.4, 0.4);
    pool.type[i] = p.type;
    pool.frame[i] = p.type === PType.Spark || p.type === PType.Ember ? -1 : this.rnd.int(16);
    pool.col[i * 4] = p.r;
    pool.col[i * 4 + 1] = p.g;
    pool.col[i * 4 + 2] = p.b;
    pool.col[i * 4 + 3] = p.a;
    pool.drag[i] = p.drag ?? 0.5;
    pool.buoy[i] = p.buoy ?? 0;
  }

  /** Persistent emitter; returns it so the caller can move or stop it. */
  addEmitter(kind: Emitter['kind'], pos: Vector3, scale = 1, follow?: () => Vector3 | null): Emitter {
    const rate = kind === 'plume' ? 9 : kind === 'fire' ? 22 : kind === 'chimney' ? 4 : 5;
    const e: Emitter = { pos: pos.clone(), kind, rate: rate * Math.min(2, scale), acc: 0, scale, follow, active: true };
    this.emitters.push(e);
    return e;
  }

  removeEmitter(e: Emitter): void {
    e.active = false;
    this.emitters = this.emitters.filter((x) => x !== e);
  }

  sparks(x: number, y: number, z: number, n: number, speed = 6, dir?: Vector3): void {
    const r = this.rnd;
    for (let i = 0; i < n; i++) {
      let vx = r.range(-1, 1);
      let vy = r.range(0.2, 1.3);
      let vz = r.range(-1, 1);
      if (dir) {
        vx += dir.x * 1.2;
        vy += dir.y;
        vz += dir.z * 1.2;
      }
      const s = speed * r.range(0.4, 1.1);
      this.spawn({ type: PType.Spark, x, y, z, vx: vx * s, vy: vy * s, vz: vz * s, life: r.range(0.25, 0.7), s0: 0.09, s1: 0.04, r: 9, g: 5.5, b: 2.2, a: 1, drag: 0.6 });
    }
    this.spawn({ type: PType.Flash, x, y, z, life: 0.09, s0: 0.9, s1: 1.4, r: 6, g: 4, b: 2, a: 1, drag: 0 });
  }

  explosion(x: number, y: number, z: number, scale = 1): void {
    const r = this.rnd;
    this.spawn({ type: PType.Flash, x, y: y + 0.4 * scale, z, life: 0.16, s0: 2.5 * scale, s1: 4.5 * scale, r: 8, g: 5, b: 2.4, a: 1, drag: 0 });
    for (let i = 0; i < 14 * scale; i++) {
      this.spawn({
        type: PType.Fire,
        x: x + r.range(-0.4, 0.4) * scale,
        y: y + r.range(0.1, 0.8) * scale,
        z: z + r.range(-0.4, 0.4) * scale,
        vx: r.range(-2, 2) * scale,
        vy: r.range(0.8, 3.5) * scale,
        vz: r.range(-2, 2) * scale,
        life: r.range(0.35, 0.8),
        s0: 0.8 * scale,
        s1: 2.0 * scale,
        r: 5,
        g: 2.2,
        b: 0.7,
        a: 1,
        drag: 2.5,
        buoy: 1.5,
      });
    }
    for (let i = 0; i < 10 * scale; i++) {
      this.spawn({
        type: PType.Smoke,
        x: x + r.range(-0.5, 0.5) * scale,
        y: y + r.range(0.3, 1.2) * scale,
        z: z + r.range(-0.5, 0.5) * scale,
        vx: r.range(-1, 1),
        vy: r.range(0.6, 1.8),
        vz: r.range(-1, 1),
        life: r.range(2.5, 4.5),
        s0: 1.2 * scale,
        s1: 4.5 * scale,
        r: 0.16,
        g: 0.14,
        b: 0.13,
        a: 0.85,
        drag: 1.2,
        buoy: 0.5,
      });
    }
    this.sparks(x, y + 0.3, z, 18 * scale, 9);
    for (let i = 0; i < 8; i++) this.spawn({ type: PType.Dust, x: x + r.range(-1, 1) * scale, y: y + 0.2, z: z + r.range(-1, 1) * scale, vx: r.range(-2.5, 2.5), vy: r.range(0.2, 0.8), vz: r.range(-2.5, 2.5), life: r.range(2, 3.5), s0: 1.0 * scale, s1: 3.5 * scale, r: 0.62, g: 0.36, b: 0.22, a: 0.55, drag: 1.5 });
  }

  muzzle(x: number, y: number, z: number, dir: Vector3, big = false): void {
    const k = big ? 2.2 : 1;
    this.spawn({ type: PType.Flash, x: x + dir.x * 0.15 * k, y: y + dir.y * 0.15 * k, z: z + dir.z * 0.15 * k, life: 0.06, s0: 0.55 * k, s1: 0.9 * k, r: 8, g: 5.2, b: 2.6, a: 1, drag: 0 });
    if (big) for (let i = 0; i < 4; i++) this.spawn({ type: PType.Smoke, x, y, z, vx: dir.x * 3 + this.rnd.range(-0.5, 0.5), vy: 0.6, vz: dir.z * 3 + this.rnd.range(-0.5, 0.5), life: 1.6, s0: 0.5, s1: 2.2, r: 0.5, g: 0.45, b: 0.4, a: 0.5, drag: 2 });
  }

  update(dt: number, camera: Camera): void {
    this.emit(dt);
    this.advance(dt);
    this.draw(camera);
  }

  /**
   * Adapted (W24 review, 2026-10-09): ages, moves and expires the live particles by `dt`, without
   * spawning or uploading. render/effects.ts calls it at the start of a frame, before the frame's
   * spawns, and `emit` + `draw` at its end, so a particle is drawn at least once even when one
   * frame's step is longer than its life (a 0.06 s muzzle flash at 10x game speed).
   */
  advance(dt: number): void {
    this.step(this.smoke, dt);
    this.step(this.glow, dt);
  }

  /** Uploads the live particles (sorted for the camera). */
  draw(camera: Camera): void {
    this.upload(this.smoke, this.smokeMesh, camera, true);
    this.upload(this.glow, this.glowMesh, camera, false);
  }

  /** The emitters spawn their particles for `dt`. */
  emit(dt: number): void {
    const r = this.rnd;
    for (const e of this.emitters) {
      if (e.follow) {
        const p = e.follow();
        if (!p) continue;
        e.pos.copy(p);
      }
      e.acc += e.rate * dt;
      while (e.acc >= 1) {
        e.acc -= 1;
        const s = e.scale;
        const { x, y, z } = e.pos;
        if (e.kind === 'plume' || e.kind === 'chimney') {
          const dark = e.kind === 'plume';
          const c = dark ? r.range(0.07, 0.13) : r.range(0.38, 0.48);
          this.spawn({ type: PType.Smoke, x: x + r.range(-0.3, 0.3) * s, y, z: z + r.range(-0.3, 0.3) * s, vx: r.range(-0.25, 0.25), vy: r.range(2.2, 3.2) * Math.sqrt(s), vz: r.range(-0.25, 0.25), life: r.range(6, 9) * (dark ? 1 : 0.7), s0: 0.9 * s, s1: (dark ? 4.2 : 3.0) * s, r: c * 1.05, g: c * 0.95, b: c * 0.9, a: dark ? 0.85 : 0.45, drag: 0.25, buoy: 0.1 });
        } else if (e.kind === 'fire') {
          this.spawn({ type: PType.Fire, x: x + r.range(-0.35, 0.35) * s, y: y + r.range(0, 0.2), z: z + r.range(-0.35, 0.35) * s, vx: r.range(-0.3, 0.3), vy: r.range(1.2, 2.6) * s, vz: r.range(-0.3, 0.3), life: r.range(0.4, 0.9), s0: 0.9 * s, s1: 0.25 * s, r: 5.5, g: 2.1, b: 0.55, a: 1, drag: 1, buoy: 1 });
          if (r.next() < 0.25) this.spawn({ type: PType.Ember, x, y: y + 0.3, z, vx: r.range(-1, 1), vy: r.range(2, 4), vz: r.range(-1, 1), life: r.range(0.8, 1.6), s0: 0.06, s1: 0.03, r: 8, g: 3.5, b: 1, a: 1, drag: 0.8 });
        } else {
          this.spawn({ type: PType.Dust, x: x + r.range(-0.6, 0.6), y: y + 0.1, z: z + r.range(-0.6, 0.6), vx: r.range(-0.6, 0.6), vy: r.range(0.2, 0.6), vz: r.range(-0.6, 0.6), life: r.range(1.5, 2.6), s0: 0.6 * s, s1: 2.2 * s, r: 0.6, g: 0.37, b: 0.23, a: 0.4, drag: 1.2 });
        }
      }
    }
  }

  private step(p: Pool, dt: number): void {
    const wx = this.wind.x;
    const wz = this.wind.z;
    for (let i = p.n - 1; i >= 0; i--) {
      p.age[i]! += dt;
      if (p.age[i]! >= p.life[i]!) {
        p.kill(i);
        continue;
      }
      const t = p.type[i]!;
      const drag = Math.exp(-p.drag[i]! * dt);
      const k = i * 3;
      let vx = p.vel[k]!;
      let vy = p.vel[k + 1]!;
      let vz = p.vel[k + 2]!;
      if (t === PType.Spark || t === PType.Ember) vy -= (t === PType.Spark ? 9.8 : 3) * dt;
      else {
        vy += p.buoy[i]! * dt;
        if (t === PType.Smoke || t === PType.Dust) {
          const age = p.age[i]! / p.life[i]!;
          vx += (wx * age - vx * 0.0) * dt * 0.6;
          vz += (wz * age) * dt * 0.6;
        }
      }
      vx *= drag;
      vy *= drag;
      vz *= drag;
      p.vel[k] = vx;
      p.vel[k + 1] = vy;
      p.vel[k + 2] = vz;
      p.pos[k]! += vx * dt;
      p.pos[k + 1]! += vy * dt;
      p.pos[k + 2]! += vz * dt;
      p.rot[i * 2]! += p.rot[i * 2 + 1]! * dt;
    }
  }

  private upload(p: Pool, mesh: Mesh, camera: Camera, sort: boolean): void {
    const g = mesh.geometry as InstancedBufferGeometry;
    const aPos = g.getAttribute('iPos') as InstancedBufferAttribute;
    const aCol = g.getAttribute('iCol') as InstancedBufferAttribute;
    const aPar = g.getAttribute('iPar') as InstancedBufferAttribute;
    const aVel = g.getAttribute('iVel') as InstancedBufferAttribute;
    const n = p.n;
    for (let i = 0; i < n; i++) this.order[i] = i;
    if (sort) {
      const m = camera.matrixWorldInverse.elements;
      for (let i = 0; i < n; i++) {
        const k = i * 3;
        this.depth[i] = m[2]! * p.pos[k]! + m[6]! * p.pos[k + 1]! + m[10]! * p.pos[k + 2]! + m[14]!;
      }
      const ord = this.order.subarray(0, n);
      const dep = this.depth;
      ord.sort((a, b) => dep[a]! - dep[b]!);
    }
    const P = aPos.array as Float32Array;
    const C = aCol.array as Float32Array;
    const Q = aPar.array as Float32Array;
    const V = aVel.array as Float32Array;
    for (let o = 0; o < n; o++) {
      const i = this.order[o]!;
      const age = p.age[i]! / p.life[i]!;
      const t = p.type[i]!;
      P[o * 3] = p.pos[i * 3]!;
      P[o * 3 + 1] = p.pos[i * 3 + 1]!;
      P[o * 3 + 2] = p.pos[i * 3 + 2]!;
      let alpha: number;
      let cr = p.col[i * 4]!;
      let cg = p.col[i * 4 + 1]!;
      let cb = p.col[i * 4 + 2]!;
      if (t === PType.Fire) {
        // yellow → orange → dark red
        cg *= 1 - 0.65 * age;
        cb *= 1 - 0.9 * age;
        alpha = Math.min(1, age * 8) * (1 - age);
      } else if (t === PType.Smoke || t === PType.Dust) alpha = Math.min(1, age * 5) * (1 - age) ** 1.3;
      else alpha = 1 - age;
      C[o * 4] = cr;
      C[o * 4 + 1] = cg;
      C[o * 4 + 2] = cb;
      C[o * 4 + 3] = alpha * p.col[i * 4 + 3]!;
      const size = p.size[i * 2]! + (p.size[i * 2 + 1]! - p.size[i * 2]!) * (t === PType.Smoke || t === PType.Dust ? Math.sqrt(age) : age);
      Q[o * 4] = size;
      Q[o * 4 + 1] = p.rot[i * 2]!;
      Q[o * 4 + 2] = p.frame[i]!;
      Q[o * 4 + 3] = t === PType.Spark ? 2.5 : 0;
      V[o * 3] = p.vel[i * 3]!;
      V[o * 3 + 1] = p.vel[i * 3 + 1]!;
      V[o * 3 + 2] = p.vel[i * 3 + 2]!;
    }
    g.instanceCount = n;
    for (const a of [aPos, aCol, aPar, aVel]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }
}
