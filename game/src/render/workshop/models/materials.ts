// Ported from look/src/models/materials.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// Shared PBR materials for buildings, units and aliens. Photographic maps come from the texture
// bank (CC0 downloads); the ivory armour maps are composed in code (assets/composite.ts).
// Geometry UVs are box-projected in tile units (1 UV unit = 1 tile = 2 m), so each texture's
// `repeat` sets its physical scale.
// W30: belt surfaces carry flow UVs instead (kit.ts UvMap; v = progress along the flow in tiles,
// u = across the belt, 0..1). The chevron textures draw forward-pointing chevrons, tips toward +v;
// the renderer scrolls each (models.ts, anim.ts BeltFlow). `beltStill` is the same rubber without
// chevrons on its own texture, which nothing scrolls (the splitter).
// W31: one texture and material per belt speed, told apart by chevron count (never colour alone):
// `beltSlow` one chevron a tile, `beltMedium` two, `belt` (Fast, and the material every belt model
// is built with) three. One texture repeat is still one tile of travel.

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
  | 'beltSlow'
  | 'beltMedium'
  | 'beltStill'
  | 'hot'
  | 'rock';

export type Mats = Record<MatKey, MeshStandardMaterial>;

const IVORY: [number, number, number] = [232, 211, 174];

let panels: PanelMaps | null = null;
let wearNoise: CanvasTexture<OffscreenCanvas> | null = null;

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

/**
 * Belt rubber (and its colours: the base, the raised cleat, the cleat's dark leading edge). W30
 * review: the rubber is lighter than the W17 stripes' #2b2927 and the chevron lighter than their
 * #3b3835. On the darker rubber an item's shading changed fewer pixels (check-render's rare-item
 * check fell from 57–66 to 35–48 px against its threshold of 40); this pair restores 62–71 and
 * doubles the chevron's contrast with the rubber.
 */
const RUBBER = '#33302d';
const CLEAT = '#5a554e';
const CLEAT_EDGE = '#1a1918';
/** Canvas size: u across (64 px), v along the flow (256 px = one tile, two chevrons). */
const BELT_W = 64;
const BELT_H = 256;

/**
 * W30: one tile of belt, v down the canvas (flipY off: canvas row 0 is v = 0). W31: `chevrons` of
 * them (1 Slow, 2 Medium, 3 Fast), evenly spaced, each a V whose arms start at the belt's edges and
 * whose tip, on the centre line, is DEPTH further along +v: the tip points the way the belt runs.
 * Drawn again one canvas height either side so a chevron crossing the tile edge wraps.
 */
function beltTexture(chevrons: number): CanvasTexture<OffscreenCanvas> {
  const c = new OffscreenCanvas(BELT_W, BELT_H);
  const g = c.getContext('2d')!;
  g.fillStyle = RUBBER;
  g.fillRect(0, 0, BELT_W, BELT_H);
  const PERIOD = BELT_H / chevrons;
  const DEPTH = 40;
  const T = 22;
  const EDGE = 4;
  const vee = (y0: number, t: number) => {
    g.beginPath();
    g.moveTo(0, y0);
    g.lineTo(BELT_W / 2, y0 + DEPTH);
    g.lineTo(BELT_W, y0);
    g.lineTo(BELT_W, y0 + t);
    g.lineTo(BELT_W / 2, y0 + DEPTH + t);
    g.lineTo(0, y0 + t);
    g.closePath();
    g.fill();
  };
  for (const wrap of [-BELT_H, 0, BELT_H])
    for (let k = 0; k < chevrons; k++) {
      const y0 = wrap + k * PERIOD + 20;
      g.fillStyle = CLEAT;
      vee(y0, T);
      g.fillStyle = CLEAT_EDGE;
      vee(y0 + T, EDGE);
    }
  return canvasTexture(c);
}

function canvasTexture(c: OffscreenCanvas): CanvasTexture<OffscreenCanvas> {
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
  // W31: Slow, Medium, Fast (1, 2, 3 chevrons a tile)
  const chevrons = (n: number): Texture => {
    const t = beltTexture(n);
    t.repeat.set(1, 1);
    // W30: the chevrons are seen at a grazing angle from the game camera
    t.anisotropy = bank.anisotropy;
    bank.derived.add(t);
    return t;
  };
  const [slowTex, mediumTex, fastTex] = [chevrons(1), chevrons(2), chevrons(3)];

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
  const belt = new MeshStandardMaterial({ name: 'belt', map: fastTex, roughness: 0.8, metalness: 0.1 });
  const beltSlow = new MeshStandardMaterial({ name: 'beltSlow', map: slowTex, roughness: 0.8, metalness: 0.1 });
  const beltMedium = new MeshStandardMaterial({ name: 'beltMedium', map: mediumTex, roughness: 0.8, metalness: 0.1 });
  const beltStill = new MeshStandardMaterial({ name: 'beltStill', color: RUBBER, roughness: 0.8, metalness: 0.1 });
  for (const t of [panels.normal]) t.colorSpace = NoColorSpace;
  return { ivory, trim, copper, glow, glass, void: voidM, pad, hull, alienGlow, crystal, ore, belt, beltSlow, beltMedium, beltStill, hot, rock };
}

/** Rebuild the code-composed maps after a texture-quality change (same Texture objects). */
export function rebuildComposites(bank: TextureBank): void {
  if (!panels) return;
  panels = ivoryPanels(bank.pixels('Metal016/diff'), bank.pixels('Metal016/nor'), bank.pixels('Metal016/rough'), IVORY, bank.anisotropy, panels);
}

export type { Material };
