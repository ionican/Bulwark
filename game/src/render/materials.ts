// Material sets for the model renderer (W24 run 2a):
//
//   asset   W23's instanced W20 materials (ivory ceramic, gunmetal, bronze, dark, cyan glow) with
//           per-instance glow, damage and build cut (workshop/w23/mats.ts): walls, gates,
//           extractors and deposits, the W22 kit turrets, engineers and the commander.
//   w17     W17's building and alien materials (workshop/models/materials.ts), each cloned and
//           patched here with the same per-instance data and build cut as W23's, so a W17
//           building under construction is cut by its snapshot progress exactly like a wall.
//   depth   W23's depth material (shadows cut at the same height), shared by every batch.
//   plinth  foundations under buildings on slopes: W17's concrete pad material.
//   outline reserved sites (no build power yet): unlit, drawn over the scene.
//
// In the browser the textures come from the CC0 bank (public/assets); tests use name-only
// stand-ins, so the same renderer code runs in Node with the same names on its meshes.

import { Color, MeshBasicMaterial, MeshDepthMaterial, MeshStandardMaterial, Texture, type Material, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from 'three';
import type { TextureBank } from './workshop/assets/textures.ts';
import { createMaterials, type MatKey as W17Key, type Mats } from './workshop/models/materials.ts';
import { BUILT, createAssetMats, type AssetMats, type MatKey } from './workshop/w23/mats.ts';

export interface RenderMaterials {
  asset: AssetMats;
  w17: Mats;
  depth: MeshDepthMaterial;
  plinth: Material;
  outline: Material;
}

const CUT_PARS = /* glsl */ `
varying float vCutWY;
varying vec3 vCutData;`;

/**
 * Clone of a W17 material with W23's per-instance data: instance colour = (glow, damage, cut).
 * Fragments above the cut are discarded, a cyan band glows just below it (W20's build band), the
 * emissive is scaled by the glow level, and the instance colour is not used as a tint. Any patch the
 * source material already has (W17's edge wear) runs first.
 */
export function cutMaterial(src: MeshStandardMaterial): MeshStandardMaterial {
  const m = src.clone();
  m.name = `${src.name}-cut`;
  const prev = src.onBeforeCompile;
  const prevKey = src.customProgramCacheKey();
  m.onBeforeCompile = (sh: WebGLProgramParametersWithUniforms, r: WebGLRenderer) => {
    prev.call(src, sh, r);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>${CUT_PARS}`).replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        vec4 cwp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cwp = instanceMatrix * cwp;
        #endif
        vCutWY = (modelMatrix * cwp).y;
        #ifdef USE_INSTANCING_COLOR
          vCutData = instanceColor;
        #else
          vCutData = vec3(1.0, 0.0, ${BUILT.toFixed(1)});
        #endif
      }`,
    );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>${CUT_PARS}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vCutWY > vCutData.z) discard;')
      .replace('#include <color_fragment>', '')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance *= vCutData.x;
        if (vCutData.z < ${(BUILT * 0.5).toFixed(1)}) {
          float below = vCutData.z - vCutWY;
          float band = smoothstep(0.05, 0.0, below) + smoothstep(0.3, 0.0, below) * 0.15;
          totalEmissiveRadiance += vec3(0.25, 0.9, 1.0) * band * 3.5;
        }`,
      );
  };
  m.customProgramCacheKey = () => `${prevKey}|cut`;
  return m;
}

function cutMats(src: Mats): Mats {
  const out = {} as Mats;
  for (const k of Object.keys(src) as W17Key[]) out[k] = cutMaterial(src[k]);
  return out;
}

function outlineMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({ name: 'reserved-outline', vertexColors: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
}

/** The browser set, from the loaded texture bank. */
export function createRenderMaterials(bank: TextureBank): RenderMaterials {
  const asset = createAssetMats(bank);
  const w17src = createMaterials(bank);
  const w17 = cutMats(w17src);
  const plinth = cutMaterial(w17src.pad);
  plinth.name = 'plinth';
  plinth.color = new Color('#a89a88');
  return { asset, w17, depth: asset.depth, plinth, outline: outlineMaterial() };
}

const W17_KEYS: W17Key[] = ['ivory', 'trim', 'copper', 'glow', 'glass', 'void', 'pad', 'hull', 'alienGlow', 'crystal', 'ore', 'belt', 'hot', 'rock'];
const ASSET_KEYS: MatKey[] = ['ceramic', 'gunmetal', 'bronze', 'dark', 'glow'];

/** Name-only stand-ins (Node tests): the same material names, no textures or shader patches. */
export function standInMaterials(): RenderMaterials {
  const byKey = {} as Record<MatKey, MeshStandardMaterial>;
  for (const k of ASSET_KEYS) byKey[k] = new MeshStandardMaterial({ name: `w23-${k}` });
  const depth = new MeshDepthMaterial();
  const asset: AssetMats = { byKey, depth, noise: new Texture(), all: Object.values(byKey) };
  const w17 = {} as Mats;
  for (const k of W17_KEYS) w17[k] = new MeshStandardMaterial({ name: `${k}-cut` });
  return { asset, w17, depth, plinth: new MeshStandardMaterial({ name: 'plinth' }), outline: outlineMaterial() };
}
