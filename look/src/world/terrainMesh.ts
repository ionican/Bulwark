// Terrain mesh and material. The grid is denser over the play area and coarser towards the
// horizon (positions are placed by inverting a density curve per axis). The material is a
// MeshStandardMaterial patched in onBeforeCompile, so it keeps three's lights, shadows, fog and
// image-based lighting, with its own surface:
//   steep faces → cliff_side photo, projected on the two vertical planes (no stretching), tinted
//                 by horizontal strata bands that follow world height
//   flats       → sandy_gravel_02 photo, top-projected, two scales mixed against tiling
//   gullies     → rock_face photo (darker), triplanar
//   pools       → turquoise below the water line, a pale mineral rim, wet sand just above it
//   base area   → paler compacted ground

import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, Vector3, type Texture } from 'three';
import type { TextureBank } from '../assets/textures.ts';
import { VISTA, WATER_LEVEL, field } from './heightfield.ts';

function axisSamples(a0: number, a1: number, d0: number, d1: number, outer: number, n: number): Float32Array {
  // density 1 inside [d0, d1], `outer` far outside, smooth ramps of 40 tiles
  const steps = 4000;
  const dens = (x: number) => {
    const t = x < d0 ? Math.min(1, (d0 - x) / 40) : x > d1 ? Math.min(1, (x - d1) / 40) : 0;
    const s = t * t * (3 - 2 * t);
    return 1 + (outer - 1) * s;
  };
  const cum = new Float64Array(steps + 1);
  for (let i = 1; i <= steps; i++) {
    const x = a0 + ((i - 0.5) / steps) * (a1 - a0);
    cum[i] = cum[i - 1]! + dens(x);
  }
  const total = cum[steps]!;
  const out = new Float32Array(n + 1);
  let j = 0;
  for (let k = 0; k <= n; k++) {
    const target = (k / n) * total;
    while (j < steps && cum[j + 1]! < target) j++;
    const f = (target - cum[j]!) / Math.max(1e-9, cum[j + 1]! - cum[j]!);
    out[k] = a0 + ((j + Math.min(1, f)) / steps) * (a1 - a0);
  }
  return out;
}

export interface TerrainBuild {
  mesh: Mesh;
  material: MeshStandardMaterial;
  vertices: number;
  triangles: number;
  buildMs: number;
}

export function buildTerrain(bank: TextureBank, n = 720): TerrainBuild {
  const t0 = performance.now();
  const xs = axisSamples(VISTA.x0, VISTA.x1, 0, 200, 0.24, n);
  const zs = axisSamples(VISTA.z0, VISTA.z1, -70, 135, 0.24, n);
  const s = n + 1;
  const pos = new Float32Array(s * s * 3);
  const mask = new Float32Array(s * s * 3);
  for (let j = 0; j <= n; j++) {
    const z = zs[j]!;
    for (let i = 0; i <= n; i++) {
      const x = xs[i]!;
      const smp = field.sample(x, z);
      const k = j * s + i;
      pos[k * 3] = x;
      pos[k * 3 + 1] = smp.h;
      pos[k * 3 + 2] = z;
      mask[k * 3] = smp.dark;
      mask[k * 3 + 1] = smp.pave;
      mask[k * 3 + 2] = smp.cliff;
    }
  }
  const idx = new Uint32Array(n * n * 6);
  let q = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * s + i;
      const b = a + 1;
      const c = a + s;
      const d = c + 1;
      // split along the shorter height diagonal for cleaner ridges
      const h1 = Math.abs(pos[a * 3 + 1]! - pos[d * 3 + 1]!);
      const h2 = Math.abs(pos[b * 3 + 1]! - pos[c * 3 + 1]!);
      if (h1 <= h2) {
        idx.set([a, c, d, a, d, b], q);
      } else {
        idx.set([a, c, b, b, c, d], q);
      }
      q += 6;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aMask', new BufferAttribute(mask, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.computeBoundingBox();

  const material = terrainMaterial(bank);
  const mesh = new Mesh(g, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return { mesh, material, vertices: s * s, triangles: n * n * 2, buildMs: performance.now() - t0 };
}

function meanLuminance(bank: TextureBank, key: string): number {
  const img = bank.pixels(key);
  let sum = 0;
  let cnt = 0;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4 * 37) {
    // sRGB → linear, then luminance
    const lin = (v: number) => Math.pow(v / 255, 2.2);
    sum += 0.2126 * lin(d[i]!) + 0.7152 * lin(d[i + 1]!) + 0.0722 * lin(d[i + 2]!);
    cnt++;
  }
  return sum / cnt;
}

const PARS = /* glsl */ `
uniform sampler2D tRockD; uniform sampler2D tRockN; uniform sampler2D tRockA;
uniform sampler2D tSandD; uniform sampler2D tSandN; uniform sampler2D tSandA;
uniform sampler2D tDarkD; uniform sampler2D tDarkN; uniform sampler2D tDarkA;
uniform vec3 uLum; // mean linear luminance of rock, sand, dark photos
uniform float uWater;
uniform float uTime;
uniform float uDetail;
varying vec3 vWPos;
varying vec3 vWNrm;
varying vec3 vMask;

float th(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tvn(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(th(i), th(i + vec2(1, 0)), f.x), mix(th(i + vec2(0, 1)), th(i + vec2(1, 1)), f.x), f.y);
}
float tfbm(vec2 p) { return tvn(p) * 0.55 + tvn(p * 2.03 + 7.1) * 0.3 + tvn(p * 4.1 - 3.3) * 0.15; }
float lumOf(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Horizontal strata colours (linear), banded by world height with a slow wobble.
vec3 strata(float y, vec2 xz) {
  float s = y * 0.55 + 1.6 * (tfbm(xz * 0.012) - 0.5) + 0.35 * (tvn(xz * 0.08) - 0.5);
  float b = fract(s * 0.37);
  vec3 orange = vec3(0.44, 0.12, 0.045);
  vec3 cream  = vec3(0.52, 0.25, 0.115);
  vec3 rust   = vec3(0.27, 0.065, 0.03);
  vec3 salmon = vec3(0.48, 0.17, 0.075);
  vec3 c = mix(orange, cream, smoothstep(0.08, 0.16, b));
  c = mix(c, salmon, smoothstep(0.24, 0.3, b));
  c = mix(c, rust, smoothstep(0.42, 0.47, b));
  c = mix(c, orange, smoothstep(0.58, 0.66, b));
  c = mix(c, cream, smoothstep(0.78, 0.82, b) * (1.0 - smoothstep(0.86, 0.9, b)));
  return c;
}

vec3 unpackN(vec4 t) { return t.xyz * 2.0 - 1.0; }
`;

const FRAG = /* glsl */ `
  vec3 nG = normalize(vWNrm);
  vec3 wp = vWPos;
  float slope = 1.0 - nG.y;
  float edgeN = tvn(wp.xz * 0.35) - 0.5;
  float cliffM = vMask.z;
  float rockW = max(smoothstep(0.2, 0.36, slope + edgeN * 0.12), cliffM * smoothstep(0.05, 0.16, slope + edgeN * 0.06));
  float darkW = clamp(vMask.x, 0.0, 1.0);
  float pave = vMask.y;

  // --- rock: cliff photo on the two vertical planes (uvX = zy, uvZ = xy)
  const float RS = 0.15;
  vec3 bw = pow(abs(nG), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
  float wx = bw.x / max(1e-4, bw.x + bw.z); float wz = 1.0 - wx;
  vec2 uvRX = vec2(wp.z, wp.y) * RS; vec2 uvRZ = vec2(wp.x, wp.y) * RS;
  vec3 rockPhoto = texture(tRockD, uvRX).rgb * wx + texture(tRockD, uvRZ).rgb * wz;
  vec4 rockArm = texture(tRockA, uvRX) * wx + texture(tRockA, uvRZ) * wz;
  vec3 rnX = unpackN(texture(tRockN, uvRX)); vec3 rnZ = unpackN(texture(tRockN, uvRZ));
  rnX = vec3(rnX.xy + nG.zy, abs(rnX.z) * nG.x);
  rnZ = vec3(rnZ.xy + nG.xy, abs(rnZ.z) * nG.z);
  vec3 rockNrm = normalize(rnX.zyx * wx + rnZ.xyz * wz + vec3(0.0, nG.y * 0.4, 0.0));
  float rockDetail = clamp(lumOf(rockPhoto) / uLum.x, 0.25, 2.2);
  vec3 rockCol = strata(wp.y, wp.xz) * pow(rockDetail, 1.35);

  // --- sand: top projection, two rotated samples blended by noise against tiling; brightness is
  // high-passed against a coarse mip so the photo's low-frequency gradient cannot band per tile
  const mat2 SR = mat2(0.8, -0.6, 0.6, 0.8);
  vec2 uvS = wp.xz * 0.5;
  vec2 uvSb = SR * wp.xz * 0.37 + vec2(0.31, 0.77);
  float sw = smoothstep(0.3, 0.7, tvn(wp.xz * 0.13));
  vec3 sA = texture(tSandD, uvS).rgb; vec3 sB = texture(tSandD, uvSb).rgb;
  vec3 sAm = textureLod(tSandD, uvS, 7.0).rgb; vec3 sBm = textureLod(tSandD, uvSb, 7.0).rgb;
  vec3 sandPhoto = mix(sA, sB, sw);
  float sandDetail = clamp(mix(lumOf(sA) / max(1e-3, lumOf(sAm)), lumOf(sB) / max(1e-3, lumOf(sBm)), sw), 0.3, 2.2);
  vec4 sandArm = mix(texture(tSandA, uvS), texture(tSandA, uvSb), sw);
  vec3 snA = unpackN(texture(tSandN, uvS));
  vec3 snB = unpackN(texture(tSandN, uvSb));
  snB.xy = transpose(SR) * snB.xy;
  vec3 snT = normalize(mix(snA, snB, sw));
  vec3 sandNrm = normalize(vec3(snT.x + nG.x, abs(snT.z) * nG.y, snT.y + nG.z));
  float m1 = tfbm(wp.xz * 0.045);
  float m2 = tfbm(wp.xz * 0.21 + 3.0);
  float m3 = tvn(wp.xz * 0.9);
  vec3 sandHue = sandPhoto / max(1e-3, lumOf(sandPhoto));
  vec3 sandCol = mix(vec3(0.31, 0.105, 0.045), 0.17 * sandHue * vec3(1.12, 0.82, 0.66), 0.35) * sandDetail;
  sandCol *= mix(0.72, 1.18, m1) * mix(0.88, 1.08, m2) * mix(0.94, 1.04, m3);

  // --- dark rock: triplanar
  const float DS = 0.25;
  vec2 uvDX = wp.zy * DS; vec2 uvDY = wp.xz * DS; vec2 uvDZ = wp.xy * DS;
  vec3 darkPhoto = texture(tDarkD, uvDX).rgb * bw.x + texture(tDarkD, uvDY).rgb * bw.y + texture(tDarkD, uvDZ).rgb * bw.z;
  vec4 darkArm = texture(tDarkA, uvDX) * bw.x + texture(tDarkA, uvDY) * bw.y + texture(tDarkA, uvDZ) * bw.z;
  vec3 dX = unpackN(texture(tDarkN, uvDX)); vec3 dY = unpackN(texture(tDarkN, uvDY)); vec3 dZ = unpackN(texture(tDarkN, uvDZ));
  dX = vec3(dX.xy + nG.zy, abs(dX.z) * nG.x); dY = vec3(dY.xy + nG.xz, abs(dY.z) * nG.y); dZ = vec3(dZ.xy + nG.xy, abs(dZ.z) * nG.z);
  vec3 darkNrm = normalize(dX.zyx * bw.x + dY.xzy * bw.y + dZ.xyz * bw.z);
  float darkDetail = clamp(lumOf(darkPhoto) / uLum.z, 0.3, 2.0);
  vec3 darkCol = vec3(0.2, 0.05, 0.022) * darkDetail;
  // rocky rubble patches on the flats
  float rubble = max(smoothstep(0.58, 0.72, tfbm(wp.xz * 0.11 + 13.0)) * (1.0 - vMask.y * 0.7), cliffM * smoothstep(0.45, 0.6, tfbm(wp.xz * 0.2 - 5.0)));
  vec3 rubbleCol = vec3(0.34, 0.1, 0.045) * darkDetail;

  // --- combine
  vec3 ground = mix(sandCol, rubbleCol, rubble * 0.8);
  ground = mix(ground, darkCol, darkW * 0.8 * (1.0 - rockW));
  vec3 paleGround = vec3(0.56, 0.42, 0.31) * sandDetail * mix(0.85, 1.1, m2) * mix(0.92, 1.06, m3);
  ground = mix(ground, paleGround, pave * 0.75);
  // canyon floor: pale dust and salt flats, paler still towards the pools
  float floorW = smoothstep(-5.6, -7.0, wp.y) * (1.0 - rockW);
  vec3 floorCol = mix(vec3(0.46, 0.2, 0.1), vec3(0.62, 0.45, 0.33), smoothstep(0.3, 0.8, m1 * 0.7 + m2 * 0.3)) * mix(1.0, sandDetail, 0.8);
  floorCol = mix(floorCol, vec3(0.7, 0.58, 0.46), smoothstep(1.2, 0.2, wp.y - uWater) * 0.6);
  ground = mix(ground, floorCol, floorW * 0.85);
  vec3 col = mix(ground, mix(rockCol, darkCol * 1.4, darkW * 0.35), rockW);
  vec3 wN = normalize(mix(mix(sandNrm, darkNrm, max(darkW * 0.8, rubble * 0.8)), rockNrm, rockW));
  float rough = mix(mix(sandArm.g, darkArm.g, darkW), rockArm.g, rockW);
  float occl = mix(mix(sandArm.r, darkArm.r, darkW), rockArm.r, rockW);

  // --- water: wet band above the line, pale mineral rim, turquoise below
  float above = wp.y - uWater;
  float wet = 1.0 - smoothstep(0.0, 0.45, above);
  col *= mix(1.0, 0.62, wet * (1.0 - rockW));
  rough = mix(rough, 0.35, wet);
  float rim = smoothstep(0.08, 0.0, abs(above + 0.08)) * (1.0 - rockW);
  col = mix(col, vec3(0.74, 0.66, 0.53), rim * 0.7);
  float depth = clamp(-above / 1.1, 0.0, 1.0);
  col = mix(col, mix(vec3(0.32, 0.62, 0.56), vec3(0.06, 0.36, 0.38), depth), smoothstep(0.0, 0.12, -above));

  diffuseColor.rgb = col;
  gTerrainN = wN;
  gTerrainRough = clamp(rough * 1.05, 0.25, 1.0);
  gTerrainAO = occl;
`;

export function terrainMaterial(bank: TextureBank): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ roughness: 1, metalness: 0, name: 'terrain' });
  const lum = new Vector3(meanLuminance(bank, 'cliff_side/diff'), meanLuminance(bank, 'sandy_gravel_02/diff'), meanLuminance(bank, 'rock_face/diff'));
  const tex = (k: string): Texture => bank.tex(k);
  const uniforms = {
    tRockD: { value: tex('cliff_side/diff') },
    tRockN: { value: tex('cliff_side/nor') },
    tRockA: { value: tex('cliff_side/arm') },
    tSandD: { value: tex('sandy_gravel_02/diff') },
    tSandN: { value: tex('sandy_gravel_02/nor') },
    tSandA: { value: tex('sandy_gravel_02/arm') },
    tDarkD: { value: tex('rock_face/diff') },
    tDarkN: { value: tex('rock_face/nor') },
    tDarkA: { value: tex('rock_face/arm') },
    uLum: { value: lum },
    uWater: { value: WATER_LEVEL },
    uTime: { value: 0 },
    uDetail: { value: 1 },
  };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aMask;\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\nvarying vec3 vMask;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * objectNormal);\nvMask = aMask;',
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS + '\nvec3 gTerrainN; float gTerrainRough; float gTerrainAO;')
      .replace('#include <map_fragment>', FRAG)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gTerrainRough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize(mat3(viewMatrix) * gTerrainN);')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= mix(1.0, gTerrainAO, 0.8);\nreflectedLight.indirectSpecular *= mix(1.0, gTerrainAO, 0.8);');
  };
  m.customProgramCacheKey = () => 'terrain-v1';
  return m;
}
