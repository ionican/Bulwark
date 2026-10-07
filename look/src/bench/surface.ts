// W20 turret surfaces: matte ivory ceramic-composite, worn bronze, gunmetal, dark bore, cyan
// lights. Photo detail comes from CC0 sets (Poly Haven beige_wall_001 for the ceramic grain,
// ambientCG Metal047B for bronze, Poly Haven metal_plate_02 for gunmetal); hairline cracks, chips
// and grime are composed in code here. No image of the concept is used anywhere.
//
// Every material gets the same shader patch:
//   edge wear — faces flagged `wear` = 1 by the geometry kit (the thin chamfer strips) show a
//               per-material worn edge: chipped ceramic over dark composite, bright bare steel on
//               gunmetal, polished bronze on bronze. A noise mask breaks it up along the edge.
//   build     — while the construction animation runs, fragments above the build height are
//               clipped by a clipping plane (so shadows clip too) and a cyan band glows just
//               below the cut.

import { CanvasTexture, Color, LinearMipmapLinearFilter, MeshStandardMaterial, NoColorSpace, Plane, RepeatWrapping, SRGBColorSpace, Vector2, Vector3, type ColorSpace, type Texture } from 'three';
import { noiseTexture } from '../assets/composite.ts';
import type { TextureBank } from '../assets/textures.ts';
import { Rand, smoothstep } from '../noise.ts';

export interface TurretMats {
  ceramic: MeshStandardMaterial;
  gunmetal: MeshStandardMaterial;
  bronze: MeshStandardMaterial;
  dark: MeshStandardMaterial;
  glow: MeshStandardMaterial;
  /** Brass for ejected casings. */
  brass: MeshStandardMaterial;
  all: MeshStandardMaterial[];
}

/** Shared build-animation state: world height of the cut, and the plane that clips above it. */
export const build = {
  uniforms: { uBuildY: { value: 1e4 }, uBuildGlow: { value: 0 } },
  plane: new Plane(new Vector3(0, -1, 0), 1e4),
  set(y: number, glow: number) {
    this.uniforms.uBuildY.value = y;
    this.uniforms.uBuildGlow.value = glow;
    this.plane.constant = y;
  },
};

interface WearLook {
  colour: string;
  metal: number;
  rough: number;
  /** Noise threshold: lower = more of the edge worn. */
  threshold: number;
  /** Fraction of the remaining edge lightened slightly (paint worn thin). */
  lighten: number;
}

function patch(m: MeshStandardMaterial, noise: Texture, look: WearLook, key: string): void {
  const col = new Color(look.colour);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tWear = { value: noise };
    sh.uniforms.uWearCol = { value: col };
    sh.uniforms.uBuildY = build.uniforms.uBuildY;
    sh.uniforms.uBuildGlow = build.uniforms.uBuildGlow;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float wear;\nvarying float vWear;\nvarying float vBuildY;\nvarying vec3 vObjP;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWear = wear;
        vObjP = position;
        vec4 bwp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          bwp = instanceMatrix * bwp;
        #endif
        vBuildY = (modelMatrix * bwp).y;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D tWear; uniform vec3 uWearCol; uniform float uBuildY; uniform float uBuildGlow;
        varying float vWear; varying float vBuildY; varying vec3 vObjP;
        float gEdge = 0.0;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          // noise in object space, so the worn pattern stays put on moving parts and needs no UVs
          vec2 wuv = vObjP.xz + vObjP.yy * vec2(0.71, -0.53);
          float wn = texture2D(tWear, wuv * 1.9).r * 0.65 + texture2D(tWear, wuv * 7.3).r * 0.35;
          gEdge = vWear * smoothstep(${look.threshold.toFixed(3)}, ${(look.threshold + 0.05).toFixed(3)}, wn);
          float thin = vWear * (1.0 - gEdge) * ${look.lighten.toFixed(3)};
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.12 + 0.03, thin);
          diffuseColor.rgb = mix(diffuseColor.rgb, uWearCol * (0.75 + 0.5 * wn), gEdge);
        }`,
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, ${look.rough.toFixed(3)}, gEdge);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, ${look.metal.toFixed(3)}, gEdge);`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float below = uBuildY - vBuildY;
          float band = uBuildGlow * (smoothstep(0.05, 0.0, below) * 1.0 + smoothstep(0.3, 0.0, below) * 0.15);
          totalEmissiveRadiance += vec3(0.25, 0.9, 1.0) * band * 3.5;
        }`,
      );
  };
  m.customProgramCacheKey = () => `w20-${key}`;
  m.clippingPlanes = [build.plane];
  m.clipShadows = true;
}

/** Separable box blur of a square, tiling (wrap-around) float image. */
function boxBlur(src: Float32Array, S: number, r: number): Float32Array {
  const tmp = new Float32Array(S * S);
  const out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[y * S + ((k + S) % S)]!;
    for (let x = 0; x < S; x++) {
      tmp[y * S + x] = acc / (2 * r + 1);
      acc += src[y * S + ((x + r + 1) % S)]! - src[y * S + ((x - r + S) % S)]!;
    }
  }
  for (let x = 0; x < S; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[((k + S) % S) * S + x]!;
    for (let y = 0; y < S; y++) {
      out[y * S + x] = acc / (2 * r + 1);
      acc += tmp[((y + r + 1) % S) * S + x]! - tmp[((y - r + S) % S) * S + x]!;
    }
  }
  return out;
}

/**
 * Recolours a photo: its luminance, high-passed against a blurred copy and scaled by `amount`,
 * modulates a flat target colour (sRGB 0..255). Keeps the photo's scratches and grain, drops its
 * own hue and its low-frequency blotches (rust patches on the gunmetal photo, polish on the copper).
 */
function recolour(bank: TextureBank, key: string, rgb: [number, number, number], amount: number): CanvasTexture<OffscreenCanvas> {
  const img = bank.pixels(key);
  const S = img.width;
  const L = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) L[i] = img.data[i * 4]! * 0.3 + img.data[i * 4 + 1]! * 0.59 + img.data[i * 4 + 2]! * 0.11;
  const Lb = boxBlur(L, S, Math.max(2, Math.round(S / 40)));
  const out = new ImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const k = 1 + amount * Math.max(-0.6, Math.min(0.6, L[i]! / Math.max(1, Lb[i]!) - 1));
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = Math.max(0, Math.min(255, rgb[c]! * k));
    out.data[i * 4 + 3] = 255;
  }
  return toTexture(out, SRGBColorSpace, bank.anisotropy);
}

function toTexture(img: ImageData, colour: ColorSpace, anisotropy: number): CanvasTexture<OffscreenCanvas> {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.colorSpace = colour;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.flipY = false;
  t.anisotropy = anisotropy;
  return t;
}

/** sRGB 0..255 of the ivory paint, read off the concept's lit faces by eye. */
const IVORY: [number, number, number] = [218, 206, 182];

/**
 * Ceramic composite maps from the beige_wall_001 photo: its luminance (high-passed against a
 * blurred copy so it carries grain, not gradients) modulates the ivory; hairline cracks with
 * branches, small chips showing a darker composite under a pale rim, and faint grime mottling are
 * drawn here and folded into colour, normal and AO/roughness/metal.
 */
export function ceramicMaps(bank: TextureBank): { colour: Texture; normal: Texture; orm: Texture } {
  const diff = bank.pixels('beige_wall_001/diff');
  const nor = bank.pixels('beige_wall_001/nor');
  const arm = bank.pixels('beige_wall_001/arm');
  const S = diff.width;
  const px = S / 1024;
  const rnd = new Rand(0x20c3a);
  // luminance and a box-blurred copy (radius 24 px) for the high-pass
  const L = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) L[i] = diff.data[i * 4]! * 0.3 + diff.data[i * 4 + 1]! * 0.59 + diff.data[i * 4 + 2]! * 0.11;
  const blur = (src: Float32Array, r: number) => boxBlur(src, S, r);
  const Lb = blur(L, Math.round(24 * px));
  // grime: low-frequency mottling from a heavily blurred random field
  const R0 = new Float32Array(S * S).map(() => rnd.next());
  const G1 = blur(blur(R0, Math.round(40 * px)), Math.round(40 * px));
  let gmin = Infinity;
  let gmax = -Infinity;
  for (const v of G1) {
    gmin = Math.min(gmin, v);
    gmax = Math.max(gmax, v);
  }

  // cracks (R) and chips (G) drawn as canvas strokes and fills
  const mc = new OffscreenCanvas(S, S);
  const g = mc.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = '#f00';
  const crack = (x: number, y: number, a: number, steps: number, w: number, depth: number) => {
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < steps; k++) {
      a += rnd.range(-0.55, 0.55);
      const l = rnd.range(5, 12) * px;
      x += Math.cos(a) * l;
      y += Math.sin(a) * l;
      g.lineTo(x, y);
      if (depth < 2 && rnd.next() < 0.07) {
        g.stroke();
        crack(x, y, a + rnd.range(-1.3, 1.3) * (rnd.next() < 0.5 ? -1 : 1), 3 + rnd.int(10), w * 0.7, depth + 1);
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(x, y);
      }
    }
    g.stroke();
  };
  for (let i = 0; i < 11; i++) crack(rnd.range(0, S), rnd.range(0, S), rnd.range(0, Math.PI * 2), 14 + rnd.int(30), rnd.range(0.8, 1.5) * px, 0);
  // chips: irregular blotches, a few clustered
  g.fillStyle = '#0f0';
  for (let i = 0; i < 26; i++) {
    const cx = rnd.range(0, S);
    const cy = rnd.range(0, S);
    const n = 1 + rnd.int(3);
    for (let j = 0; j < n; j++) {
      const x = cx + rnd.range(-14, 14) * px;
      const y = cy + rnd.range(-14, 14) * px;
      const r = rnd.range(2, 7) * px;
      g.beginPath();
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        const rr = r * rnd.range(0.5, 1.3);
        g.lineTo(x + Math.cos(a) * rr * 1.3, y + Math.sin(a) * rr);
      }
      g.closePath();
      g.fill();
    }
  }
  const mask = g.getImageData(0, 0, S, S).data;
  // chip rim: the chip mask dilated by 2 px minus the chip itself
  const chipM = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) chipM[i] = mask[i * 4 + 1]! / 255;
  const chipB = blur(chipM, Math.max(1, Math.round(2 * px)));
  const crackM = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) crackM[i] = mask[i * 4]! / 255;
  const crackB = blur(crackM, Math.max(1, Math.round(1.5 * px)));

  const col = new ImageData(S, S);
  const nrm = new ImageData(S, S);
  const orm = new ImageData(S, S);
  const sub = [118, 110, 100];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const o = i * 4;
      const hp = L[i]! / Math.max(1, Lb[i]!);
      const detail = 0.94 + 0.5 * Math.max(-0.25, Math.min(0.25, hp - 1));
      const grime = smoothstep(0.35, 0.85, (G1[i]! - gmin) / (gmax - gmin));
      const ck = crackM[i]!;
      const ch = chipM[i]!;
      const rim = Math.max(0, Math.min(1, chipB[i]! * 2.2 - ch));
      const k = detail * (1 - 0.1 * grime) * (1 - 0.42 * ck) * (1 + 0.06 * rim);
      for (let c = 0; c < 3; c++) {
        let v = IVORY[c]! * k;
        v = v * (1 - ch) + sub[c]! * detail * ch;
        col.data[o + c] = Math.max(0, Math.min(255, v));
      }
      col.data[o + 3] = 255;
      // normal: photo grain + crack groove + chip wall (gradients of the blurred masks)
      const at = (a: Float32Array, dx: number, dy: number) => a[((y + dy + S) % S) * S + ((x + dx + S) % S)]!;
      const gx = (at(crackB, 1, 0) - at(crackB, -1, 0)) * 1.1 + (at(chipB, 1, 0) - at(chipB, -1, 0)) * 1.6;
      const gy = (at(crackB, 0, 1) - at(crackB, 0, -1)) * 1.1 + (at(chipB, 0, 1) - at(chipB, 0, -1)) * 1.6;
      let nx = ((nor.data[o]! / 255) * 2 - 1) * 0.9 + gx;
      let ny = ((nor.data[o + 1]! / 255) * 2 - 1) * 0.9 + gy;
      let nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      nrm.data[o] = (nx * 0.5 + 0.5) * 255;
      nrm.data[o + 1] = (ny * 0.5 + 0.5) * 255;
      nrm.data[o + 2] = (nz * 0.5 + 0.5) * 255;
      nrm.data[o + 3] = 255;
      const ao = (0.85 + 0.15 * (arm.data[o]! / 255)) * (1 - 0.5 * ck);
      const rough = 0.8 + 0.12 * (arm.data[o + 1]! / 255) + 0.05 * grime - 0.12 * ch;
      orm.data[o] = ao * 255;
      orm.data[o + 1] = Math.min(1, rough) * 255;
      orm.data[o + 2] = 0;
      orm.data[o + 3] = 255;
    }
  }
  return { colour: toTexture(col, SRGBColorSpace, bank.anisotropy), normal: toTexture(nrm, NoColorSpace, bank.anisotropy), orm: toTexture(orm, NoColorSpace, bank.anisotropy) };
}

function rep<T extends Texture>(t: T, r: number): T {
  const c = t.clone();
  c.repeat.set(r, r);
  c.wrapS = c.wrapT = RepeatWrapping;
  c.needsUpdate = true;
  return c as T;
}

export function createTurretMats(bank: TextureBank): TurretMats {
  const noise = noiseTexture();
  bank.derived.add(noise);
  const cm = ceramicMaps(bank);
  for (const t of [cm.colour, cm.normal, cm.orm]) {
    t.repeat.set(0.6, 0.6);
    bank.derived.add(t);
  }
  const ceramic = new MeshStandardMaterial({
    name: 'ceramic',
    map: cm.colour,
    normalMap: cm.normal,
    normalScale: new Vector2(0.8, 0.8),
    roughnessMap: cm.orm,
    metalnessMap: cm.orm,
    aoMap: cm.orm,
    aoMapIntensity: 0.7,
    roughness: 1,
    metalness: 0,
  });
  patch(ceramic, noise, { colour: '#6f665c', metal: 0, rough: 0.75, threshold: 0.57, lighten: 0.6 }, 'ceramic');

  const mp = (k: string, r: number) => rep(bank.tex(`metal_plate_02/${k}`), r);
  const gunTex = recolour(bank, 'metal_plate_02/diff', [96, 99, 106], 0.9);
  const bronzeTex = recolour(bank, 'Metal047B/diff', [178, 116, 66], 0.75);
  bank.derived.add(gunTex);
  bank.derived.add(bronzeTex);
  const gunmetal = new MeshStandardMaterial({
    name: 'gunmetal',
    // the photo is dark, warm and rust-spotted (mean sRGB 84, 73, 62): keep its grain, recolour it
    map: rep(gunTex, 0.9),
    normalMap: mp('nor', 0.9),
    normalScale: new Vector2(0.45, 0.45),
    roughnessMap: mp('arm', 0.9),
    aoMap: mp('arm', 0.9),
    roughness: 0.62,
    metalness: 0.5,
  });
  patch(gunmetal, noise, { colour: '#858a91', metal: 0.8, rough: 0.52, threshold: 0.6, lighten: 0.3 }, 'gunmetal');

  const cu = (k: string, r: number) => rep(bank.tex(`Metal047B/${k}`), r);
  const bronze = new MeshStandardMaterial({
    name: 'bronze',
    map: rep(bronzeTex, 1.6),
    normalMap: cu('nor', 1.6),
    normalScale: new Vector2(0.7, 0.7),
    roughnessMap: cu('rough', 1.6),
    // the photo's roughness is low (polished copper); scale it up to worn, weathered bronze
    roughness: 1.45,
    metalness: 1,
  });
  patch(bronze, noise, { colour: '#e0a46c', metal: 1, rough: 0.48, threshold: 0.55, lighten: 0.3 }, 'bronze');

  const dark = new MeshStandardMaterial({ name: 'dark', color: '#0c0c0d', roughness: 0.85, metalness: 0.3 });
  patch(dark, noise, { colour: '#0c0c0d', metal: 0.3, rough: 0.85, threshold: 2, lighten: 0 }, 'dark');
  const glow = new MeshStandardMaterial({ name: 'glow', color: '#0a1416', emissive: new Color('#36e6ff'), emissiveIntensity: 5, roughness: 0.35 });
  patch(glow, noise, { colour: '#0a1416', metal: 0, rough: 0.35, threshold: 2, lighten: 0 }, 'glow');
  const brass = new MeshStandardMaterial({ name: 'brass', map: cu('diff', 3), color: new Color().setRGB(1.6, 1.25, 0.6), roughness: 0.38, metalness: 1 });
  patch(brass, noise, { colour: '#ffd890', metal: 1, rough: 0.25, threshold: 2, lighten: 0 }, 'brass');
  return { ceramic, gunmetal, bronze, dark, glow, brass, all: [ceramic, gunmetal, bronze, dark, glow, brass] };
}
