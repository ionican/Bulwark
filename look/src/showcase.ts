// Turret showcase (?turret=1): the gun turret alone on a sand plane under the same sun, image-based
// light and post stack as the vista, framed like look/reference/02-gun-turret.png.
//
// W18: with no `turretSource` parameter it renders every available source (code-built and each
// generated GLB) in turn with the same lighting, camera and aim, copies each frame into a tile, and
// lays the tiles out beside the reference image. `?turret=1&turretSource=<id>` shows one source
// live, as W17 did.

import { BufferAttribute, Mesh, PlaneGeometry, Scene, type WebGLRenderer } from 'three';
import { terrainMaterial } from './world/terrainMesh.ts';
import type { TextureBank } from './assets/textures.ts';
import { createMaterials } from './models/materials.ts';
import { proceduralSource } from './models/procedural/index.ts';
import { footprintWidth, loadGltfModel, turretSourceInfo, TURRET_SOURCES, type TurretLod } from './models/gltf.ts';
import type { ModelDef } from './models/types.ts';
import { CameraRig } from './render/camera.ts';
import { Lighting } from './render/lighting.ts';
import { Post } from './render/post.ts';
import { ModelLayer, placeMatrix } from './scene/modelLayer.ts';

const REFERENCE_URL = new URL('../reference/02-gun-turret.png', import.meta.url).href;
const AIM = (-66 * Math.PI) / 180;

function triangles(def: ModelDef): number {
  let n = 0;
  for (const p of def.parts) n += (p.geometry.index ? p.geometry.index.count : p.geometry.getAttribute('position').count) / 3;
  return n;
}

export async function showcase(renderer: WebGLRenderer, bank: TextureBank, canvas: HTMLCanvasElement, onReady: () => void): Promise<void> {
  const scene = new Scene();
  const lighting = new Lighting(scene, renderer);
  await lighting.loadEnvironment(bank.hdrUrl, 0.55);
  lighting.setShadowSize(2048);
  const mats = createMaterials(bank);
  // flat ground with the terrain material, fully on the pale 'base area' blend
  const plane = new PlaneGeometry(80, 80, 1, 1).rotateX(-Math.PI / 2);
  const n = plane.getAttribute('position').count;
  plane.setAttribute('aMask', new BufferAttribute(new Float32Array(n * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  const ground = new Mesh(plane, terrainMaterial(bank));
  ground.receiveShadow = true;
  scene.add(ground);

  const params = new URLSearchParams(location.search);
  const lod: TurretLod = params.get('turretLod') === '5k' ? '5k' : '20k';
  const codeGun = proceduralSource(mats).building('gun');
  const codeFootprint = footprintWidth(codeGun);
  const models = async (id: string) => {
    const info = turretSourceInfo(id);
    if (!info.urls) return { info, def: codeGun, note: `${Math.round(triangles(codeGun)).toLocaleString('en-GB')} triangles · code-built, no GLB` };
    const g = await loadGltfModel(`gun:${info.id}`, info.urls[lod], codeFootprint, { yaw: info.yaw, anisotropy: bank.anisotropy });
    return { info, def: g.def, note: `${Math.round(g.triangles).toLocaleString('en-GB')} triangles · ${g.textureSize}² texture · ${(g.bytes / 1048576).toFixed(2)} MB GLB (${lod} level)` };
  };

  const single = params.get('turretSource');
  const sources = single ? [turretSourceInfo(single)] : TURRET_SOURCES;
  const loaded = await Promise.all(sources.map((s) => models(s.id)));

  const rig = new CameraRig(canvas, canvas.width / canvas.height);
  rig.camera.fov = 30;
  rig.apply({ target: [0.15, 0.62, 0], distance: 5.2, elevation: 21, azimuth: -32 });
  const place = (def: ModelDef) => {
    const layer = new ModelLayer(def, 1);
    layer.add(placeMatrix(0, 0, 0, 0));
    layer.states[0]!.aim = AIM;
    layer.update(0);
    return layer;
  };
  const step = () => {
    rig.update(0.016);
    lighting.update(rig.camera, 40);
    lighting.fog.near = 30;
    lighting.fog.far = 80;
  };

  if (single) {
    const layer = place(loaded[0]!.def);
    scene.add(layer.group);
    const post = new Post(renderer, scene, rig.camera, canvas.width, canvas.height);
    (window as unknown as { __dbg: unknown }).__dbg = { lighting, scene, ground, layer, post };
    post.setQuality('high');
    let frames = 0;
    const loop = () => {
      requestAnimationFrame(loop);
      step();
      post.render(0.016);
      if (++frames === 5) onReady();
    };
    await renderer.compileAsync(scene, rig.camera);
    loop();
    return;
  }

  // ---- comparison: render each source into a 1280 × 720 tile under identical conditions
  const W = 1280;
  const H = 720;
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  rig.camera.aspect = W / H;
  rig.camera.updateProjectionMatrix();
  const post = new Post(renderer, scene, rig.camera, W, H);
  post.setQuality('high');
  const grid = document.createElement('div');
  grid.id = 'compare';
  const tile = (title: string, note: string, el: HTMLElement) => {
    const f = document.createElement('figure');
    const cap = document.createElement('figcaption');
    cap.innerHTML = `<b>${title}</b><span>${note}</span>`;
    f.append(el, cap);
    grid.append(f);
  };
  for (const m of loaded) {
    const layer = place(m.def);
    scene.add(layer.group);
    await renderer.compileAsync(scene, rig.camera);
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    await new Promise<void>((resolve) => {
      let frames = 0;
      const loop = () => {
        step();
        post.render(0.016);
        if (++frames < 12) return void requestAnimationFrame(loop);
        out.getContext('2d')!.drawImage(renderer.domElement, 0, 0, W, H);
        resolve();
      };
      requestAnimationFrame(loop);
    });
    scene.remove(layer.group);
    tile(m.info.label, m.note, out);
  }
  const img = new Image();
  img.src = REFERENCE_URL;
  img.alt = 'Concept image look/reference/02-gun-turret.png';
  await img.decode();
  tile('Reference', '02-gun-turret.png · 910 × 512 concept image', img);
  canvas.style.display = 'none';
  document.body.append(grid);
  const style = document.createElement('style');
  style.textContent = `#compare { position: fixed; inset: 0; display: grid; grid-template-columns: repeat(2, 1fr); align-content: center; gap: 6px; padding: 6px; background: #1a1410; overflow: auto; }
    #compare figure { margin: 0; position: relative; }
    #compare canvas, #compare img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; }
    #compare figcaption { position: absolute; left: 0; top: 0; padding: 4px 8px; background: rgba(16, 20, 26, 0.82); display: flex; gap: 10px; align-items: baseline; font-size: 12px; }
    #compare figcaption b { font-size: 13px; }`;
  document.head.append(style);
  (window as unknown as { __dbg: unknown }).__dbg = { lighting, scene, ground, post, sources: loaded.map((m) => ({ id: m.info.id, note: m.note, muzzle: m.def.muzzle, height: m.def.height })) };
  onReady();
}
