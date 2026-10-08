// W23 shared material set: ivory ceramic, gunmetal, bronze, dark and cyan glow — W20's materials
// (src/bench/surface.ts: the same photo textures, recolouring, cracks and chips, and the same edge
// wear on chamfers), re-patched for instanced drawing. Each instance carries three numbers in its
// instance colour, which is data here, not a colour:
//
//   r  glow level        the glow material's emissive is multiplied by it (status lights, the
//                        flow pulse along an extractor's conduit, a gate's moving doors)
//   g  damage state      (+10 on static structures: world-space texture on upward faces) 0 intact; 1 scuffed: scorch mottling and dark crack lines; 2 heavily
//                        damaged: heavier scorch, cracks, and holes burnt through the ivory panels
//                        (fragments discarded where a world-space noise passes a threshold, with a
//                        charred rim) that show the gunmetal frame and dark core behind
//   b  build cut height  world y above which the instance is not drawn (W20's build-up clip, per
//                        instance): fragments above it are discarded, shadows too (custom depth
//                        material), and a cyan band glows just below it (W20's band). 1e4 = built.
//
// The textures repeat a whole number of times per tile (ivory and gunmetal once, bronze twice)
// so that box-projected texture runs on across neighbouring wall tiles without a jump.

import { Color, MeshDepthMaterial, MeshStandardMaterial, type Material, type Texture } from 'three';
import { noiseTexture } from '../assets/composite.ts';
import type { TextureBank } from '../assets/textures.ts';
import { createTurretMats } from '../bench/surface.ts';
import type { MatKey } from '../kit/kit.ts';

export type { MatKey };
export const SHADOW_KEYS = new Set<MatKey>(['ceramic', 'gunmetal', 'bronze']);
/** Instance colour meaning "fully built, intact, glow 1". */
export const BUILT = 1e4;

export interface AssetMats {
  byKey: Record<MatKey, MeshStandardMaterial>;
  depth: MeshDepthMaterial;
  noise: Texture;
  all: Material[];
}

interface WearLook {
  colour: string;
  metal: number;
  rough: number;
  threshold: number;
  lighten: number;
  minRough?: number;
}

const LOOKS: Record<MatKey, WearLook> = {
  ceramic: { colour: '#6f665c', metal: 0, rough: 0.75, threshold: 0.57, lighten: 0.6 },
  gunmetal: { colour: '#858a91', metal: 0.8, rough: 0.55, threshold: 0.6, lighten: 0.3, minRough: 0.5 },
  bronze: { colour: '#c08656', metal: 0.5, rough: 0.7, threshold: 0.55, lighten: 0.15, minRough: 0.58 },
  dark: { colour: '#0c0c0d', metal: 0.3, rough: 0.85, threshold: 2, lighten: 0 },
  glow: { colour: '#0a1416', metal: 0, rough: 0.35, threshold: 2, lighten: 0 },
};

const HOLE_GLSL = /* glsl */ `
  float w23Hole(vec3 p) {
    return texture2D(tWear, p.xz * 0.12 + p.yy * vec2(0.21, -0.17)).r * 0.75 + texture2D(tWear, p.zx * 0.5 + p.yy * vec2(-0.35, 0.4)).r * 0.25;
  }`;

function patch(m: MeshStandardMaterial, noise: Texture, key: MatKey): void {
  const look = LOOKS[key];
  const col = new Color(look.colour);
  const panel = key === 'ceramic';
  const glow = key === 'glow';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tWear = { value: noise };
    sh.uniforms.uWearCol = { value: col };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float wear;\nvarying float vWear;\nvarying vec3 vObjP;\nvarying vec3 vWP;\nvarying vec3 vInst;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWear = wear;
        vObjP = position;
        vec4 bwp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          bwp = instanceMatrix * bwp;
        #endif
        vWP = (modelMatrix * bwp).xyz;
        #ifdef USE_INSTANCING_COLOR
          vInst = instanceColor;
        #else
          vInst = vec3(1.0, 0.0, ${BUILT.toFixed(1)});
        #endif
        // damage + 10 marks a static structure whose upward faces take world-space texture
        // coordinates, so decks of pieces turned different ways read as one surface
        if (vInst.y > 9.5) {
          vInst.y -= 10.0;
          vec3 wN = mat3(modelMatrix) * objectNormal;
          #ifdef USE_INSTANCING
            wN = mat3(modelMatrix) * (mat3(instanceMatrix) * objectNormal);
          #endif
          if (normalize(wN).y > 0.9) {
            vec3 wuv = vec3(vWP.xz, 1.0);
            #ifdef USE_MAP
              vMapUv = (mapTransform * wuv).xy;
            #endif
            #ifdef USE_NORMALMAP
              vNormalMapUv = (normalMapTransform * wuv).xy;
            #endif
            #ifdef USE_ROUGHNESSMAP
              vRoughnessMapUv = (roughnessMapTransform * wuv).xy;
            #endif
            #ifdef USE_METALNESSMAP
              vMetalnessMapUv = (metalnessMapTransform * wuv).xy;
            #endif
            #ifdef USE_AOMAP
              vAoMapUv = (aoMapTransform * wuv).xy;
            #endif
          }
        }`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D tWear; uniform vec3 uWearCol;
        varying float vWear; varying vec3 vObjP; varying vec3 vWP; varying vec3 vInst;
        float gEdge = 0.0;
        ${HOLE_GLSL}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        if (vWP.y > vInst.z) discard;
        ${panel ? 'if (vInst.y > 1.5 && w23Hole(vWP) > 0.62) discard;' : ''}`,
      )
      // the instance colour carries data (glow, damage, cut), not a tint
      .replace('#include <color_fragment>', '')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec2 wuv = vObjP.xz + vObjP.yy * vec2(0.71, -0.53);
          float wn = texture2D(tWear, wuv * 1.9).r * 0.65 + texture2D(tWear, wuv * 7.3).r * 0.35;
          gEdge = vWear * smoothstep(${look.threshold.toFixed(3)}, ${(look.threshold + 0.05).toFixed(3)}, wn);
          float thin = vWear * (1.0 - gEdge) * ${look.lighten.toFixed(3)};
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.12 + 0.03, thin);
          diffuseColor.rgb = mix(diffuseColor.rgb, uWearCol * (0.75 + 0.5 * wn), gEdge);
          float dmg = vInst.y;
          if (dmg > 0.5) {
            vec2 duv = vWP.xz * 0.11 + vWP.yy * vec2(0.19, -0.15);
            float n1 = texture2D(tWear, duv).r * 0.7 + texture2D(tWear, duv * 2.7).r * 0.3;
            float n2 = texture2D(tWear, duv * 4.3 + 0.37).r;
            float n3 = texture2D(tWear, duv * 9.1 + 0.61).r;
            float heavy = step(1.5, dmg);
            // soot and scorch: broad, soft patches
            float scorch = smoothstep(0.58, 0.88, n1) * (0.45 + 0.4 * heavy);
            // cracks: thin contour lines of two noise octaves, more of them when heavily damaged
            float crack = max(1.0 - smoothstep(0.0, 0.012 + 0.006 * heavy, abs(n2 - 0.5)), (1.0 - smoothstep(0.0, 0.01, abs(n3 - 0.5))) * smoothstep(0.45, 0.7, n1));
            diffuseColor.rgb *= 1.0 - 0.5 * scorch;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.04, 0.035, 0.03), crack * 0.85);
            ${panel ? 'if (heavy > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.042, 0.036), smoothstep(0.54, 0.62, w23Hole(vWP)));' : ''}
          }
        }`,
      )
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(mix(normal, nonPerturbedNormal, vWear));')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = max(mix(roughnessFactor, ${look.rough.toFixed(3)}, gEdge), ${(look.minRough ?? 0).toFixed(3)});`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, ${look.metal.toFixed(3)}, gEdge);`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        ${glow ? 'totalEmissiveRadiance *= vInst.x * (vInst.y > 1.5 ? 0.25 : 1.0);' : ''}
        if (vInst.z < ${(BUILT * 0.5).toFixed(1)}) {
          float below = vInst.z - vWP.y;
          float band = smoothstep(0.05, 0.0, below) + smoothstep(0.3, 0.0, below) * 0.15;
          totalEmissiveRadiance += vec3(0.25, 0.9, 1.0) * band * 3.5;
        }`,
      );
  };
  m.customProgramCacheKey = () => `w23-${key}`;
}

function depthMaterial(): MeshDepthMaterial {
  const d = new MeshDepthMaterial();
  d.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vW23Y;\nvarying float vW23Cut;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        vec4 bwp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          bwp = instanceMatrix * bwp;
        #endif
        vW23Y = (modelMatrix * bwp).y;
        #ifdef USE_INSTANCING_COLOR
          vW23Cut = instanceColor.b;
        #else
          vW23Cut = ${BUILT.toFixed(1)};
        #endif
      }`,
    );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vW23Y;\nvarying float vW23Cut;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vW23Y > vW23Cut) discard;');
  };
  d.customProgramCacheKey = () => 'w23-depth';
  return d;
}

/** Same image, own repeat (the image is shared on the GPU). */
function rep(t: Texture | null, r: number): Texture | null {
  if (!t) return t;
  const c = t.clone();
  c.repeat.set(r, r);
  c.needsUpdate = true;
  return c;
}

export function createAssetMats(bank: TextureBank): AssetMats {
  const tm = createTurretMats(bank);
  const noise = noiseTexture();
  bank.derived.add(noise);
  const repeat: Record<MatKey, number> = { ceramic: 1, gunmetal: 1, bronze: 2, dark: 1, glow: 1 };
  const src: Record<MatKey, MeshStandardMaterial> = { ceramic: tm.ceramic, gunmetal: tm.gunmetal, bronze: tm.bronze, dark: tm.dark, glow: tm.glow };
  const byKey = {} as Record<MatKey, MeshStandardMaterial>;
  for (const key of Object.keys(src) as MatKey[]) {
    const m = src[key].clone();
    m.name = `w23-${key}`;
    m.clippingPlanes = null;
    m.clipShadows = false;
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'] as const) m[slot] = rep(m[slot], repeat[key]);
    patch(m, noise, key);
    byKey[key] = m;
  }
  byKey.glow.emissiveIntensity = 4.5;
  return { byKey, depth: depthMaterial(), noise, all: Object.values(byKey) };
}
