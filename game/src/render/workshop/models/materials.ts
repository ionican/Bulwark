// Ported from look/src/models/materials.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// Shared PBR materials for buildings, units and aliens. Photographic maps come from the texture
// bank (CC0 downloads); the ivory armour maps are composed in code (assets/composite.ts).
// Geometry UVs are box-projected in tile units (1 UV unit = 1 tile = 2 m), so each texture's
// `repeat` sets its physical scale.

import { CanvasTexture, Color, Vector2, MeshStandardMaterial, NoColorSpace, RepeatWrapping, SRGBColorSpace, type Material, type Texture } from 'three';
import { ivoryPanels, noiseTexture, type PanelMaps } from '../assets/composite.ts';
import type { TextureBank } from '../assets/textures.ts';

export type MatKey =
  | 'ivory'
  | 'trim'
  | 'copper'
  | 'glow'
  | 'glass'
  | 'void'
  | 'pad'
  | 'hull'
  | 'alienGlow'
  | 'crystal'
  | 'ore'
  | 'belt'
  | 'hot'
  | 'rock';

export type Mats = Record<MatKey, MeshStandardMaterial>;

const IVORY: [number, number, number] = [232, 211, 174];

let panels: PanelMaps | null = null;
let wearNoise: CanvasTexture<OffscreenCanvas> | null = null;
let beltTex: CanvasTexture<OffscreenCanvas> | null = null;

function withRepeat(t: Texture, r: number): Texture {
  t.repeat.set(r, r);
  return t;
}

/** Edge wear: chamfer faces (vertex attribute `wear` = 1) show chipped paint over dark metal. */
function addEdgeWear(m: MeshStandardMaterial, noise: Texture, substrate: string, key: string) {
  const sub = new Color(substrate);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tWear = { value: noise };
    sh.uniforms.uSub = { value: sub };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float wear;\nvarying float vWear;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWear = wear;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tWear;\nuniform vec3 uSub;\nvarying float vWear;\nfloat gChip = 0.0;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float wn = texture2D(tWear, vMapUv * 3.1).r * 0.7 + texture2D(tWear, vMapUv * 11.0).r * 0.3;
        gChip = vWear * smoothstep(0.6, 0.66, wn);
        diffuseColor.rgb = mix(diffuseColor.rgb, uSub, gChip);`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.42, gChip);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.8, gChip);');
  };
  m.customProgramCacheKey = () => key;
}

function beltTexture(): CanvasTexture<OffscreenCanvas> {
  const c = new OffscreenCanvas(64, 256);
  const g = c.getContext('2d')!;
  g.fillStyle = '#2b2927';
  g.fillRect(0, 0, 64, 256);
  for (let y = 0; y < 256; y += 16) {
    g.fillStyle = '#3b3835';
    g.fillRect(0, y, 64, 9);
    g.fillStyle = '#1a1918';
    g.fillRect(0, y + 9, 64, 2);
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.flipY = false;
  return t;
}

export function createMaterials(bank: TextureBank): Mats {
  wearNoise = noiseTexture();
  bank.derived.add(wearNoise);
  panels = ivoryPanels(bank.pixels('Metal016/diff'), bank.pixels('Metal016/nor'), bank.pixels('Metal016/rough'), IVORY, bank.anisotropy);
  for (const t of [panels.colour, panels.normal, panels.orm]) {
    withRepeat(t, 0.42);
    bank.derived.add(t);
  }
  beltTex = beltTexture();
  beltTex.repeat.set(1, 1);
  bank.derived.add(beltTex);

  const mp = (k: string) => withRepeat(bank.tex(`metal_plate_02/${k}`), 0.55);
  const cu = (k: string) => withRepeat(bank.tex(`Metal047B/${k}`), 1.4);
  const cp = (k: string) => withRepeat(bank.tex(`concrete_panels/${k}`), 0.2);

  const ivory = new MeshStandardMaterial({
    name: 'ivory',
    map: panels.colour,
    normalMap: panels.normal,
    roughnessMap: panels.orm,
    metalnessMap: panels.orm,
    aoMap: panels.orm,
    aoMapIntensity: 0.8,
    roughness: 1,
    metalness: 1,
  });
  addEdgeWear(ivory, wearNoise, '#857a6c', 'ivory-wear');

  const trim = new MeshStandardMaterial({
    name: 'trim',
    map: mp('diff'),
    color: new Color('#d4d4da'),
    normalMap: mp('nor'),
    roughnessMap: mp('arm'),
    metalnessMap: mp('arm'),
    aoMap: mp('arm'),
    roughness: 0.95,
    metalness: 0.75,
  });
  const copper = new MeshStandardMaterial({
    name: 'copper',
    map: cu('diff'),
    color: new Color().setRGB(1.6, 1.0, 0.68),
    normalMap: cu('nor'),
    roughnessMap: cu('rough'),
    roughness: 0.75,
    metalness: 1,
  });
  const glow = new MeshStandardMaterial({ name: 'glow', color: '#0a1416', emissive: new Color('#36e6ff'), emissiveIntensity: 6, roughness: 0.4 });
  const glass = new MeshStandardMaterial({ name: 'glass', color: '#121a20', roughness: 0.12, metalness: 0.6 });
  const voidM = new MeshStandardMaterial({ name: 'void', color: '#0b0b0c', roughness: 0.9, metalness: 0 });
  const pad = new MeshStandardMaterial({
    name: 'pad',
    map: cp('diff'),
    color: new Color('#cdbca4'),
    normalMap: cp('nor'),
    normalScale: new Vector2(0.35, 0.35),
    roughnessMap: cp('arm'),
    aoMap: cp('arm'),
    roughness: 1,
    metalness: 0,
  });
  const hull = new MeshStandardMaterial({
    name: 'hull',
    map: mp('diff'),
    color: new Color('#4a4b50'),
    normalMap: mp('nor'),
    roughnessMap: mp('arm'),
    metalnessMap: mp('arm'),
    aoMap: mp('arm'),
    roughness: 0.85,
    metalness: 1,
  });
  addEdgeWear(hull, wearNoise, '#8a7f72', 'hull-wear');
  const alienGlow = new MeshStandardMaterial({ name: 'alienGlow', color: '#140805', emissive: new Color('#ff5a14'), emissiveIntensity: 7, roughness: 0.5 });
  const hot = new MeshStandardMaterial({ name: 'hot', color: '#2a1408', emissive: new Color('#ff7a2a'), emissiveIntensity: 3.5, roughness: 0.6 });
  const crystal = new MeshStandardMaterial({ name: 'crystal', color: '#e8f6ff', emissive: new Color('#8fd6ff'), emissiveIntensity: 0.35, roughness: 0.1, metalness: 0.05, flatShading: true });
  const ore = new MeshStandardMaterial({
    name: 'ore',
    map: withRepeat(bank.tex('rock_face/diff'), 0.5),
    color: new Color('#8a5a44'),
    normalMap: bank.tex('rock_face/nor'),
    roughnessMap: bank.tex('rock_face/arm'),
    roughness: 0.7,
    metalness: 0.45,
  });
  const rock = new MeshStandardMaterial({
    name: 'rock',
    map: bank.tex('cliff_side/diff'),
    color: new Color('#e0a080'),
    normalMap: bank.tex('cliff_side/nor'),
    roughnessMap: bank.tex('cliff_side/arm'),
    aoMap: bank.tex('cliff_side/arm'),
    roughness: 1,
    metalness: 0,
  });
  const belt = new MeshStandardMaterial({ name: 'belt', map: beltTex, roughness: 0.8, metalness: 0.1 });
  for (const t of [panels.normal]) t.colorSpace = NoColorSpace;
  return { ivory, trim, copper, glow, glass, void: voidM, pad, hull, alienGlow, crystal, ore, belt, hot, rock };
}

/** Rebuild the code-composed maps after a texture-quality change (same Texture objects). */
export function rebuildComposites(bank: TextureBank): void {
  if (!panels) return;
  panels = ivoryPanels(bank.pixels('Metal016/diff'), bank.pixels('Metal016/nor'), bank.pixels('Metal016/rough'), IVORY, bank.anisotropy, panels);
}

export function beltTextureRef(): Texture | null {
  return beltTex;
}

export type { Material };
