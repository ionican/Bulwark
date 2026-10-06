// Turret showcase (?turret=1): the code-built gun turret alone on a sand plane under the same
// sun, image-based light and post stack as the vista, framed like look/reference/02-gun-turret.png
// for a side-by-side comparison.

import { BufferAttribute, Mesh, PlaneGeometry, Scene, type WebGLRenderer } from 'three';
import { terrainMaterial } from './world/terrainMesh.ts';
import type { TextureBank } from './assets/textures.ts';
import { createMaterials } from './models/materials.ts';
import { proceduralSource } from './models/procedural/index.ts';
import { CameraRig } from './render/camera.ts';
import { Lighting } from './render/lighting.ts';
import { Post } from './render/post.ts';
import { ModelLayer, placeMatrix } from './scene/modelLayer.ts';

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
  const src = proceduralSource(mats);
  const layer = new ModelLayer(src.building('gun'), 1);
  layer.add(placeMatrix(0, 0, 0, 0));
  layer.states[0]!.aim = (-66 * Math.PI) / 180;
  layer.update(0);
  scene.add(layer.group);
  const rig = new CameraRig(canvas, canvas.width / canvas.height);
  rig.camera.fov = 30;
  rig.apply({ target: [0.15, 0.62, 0], distance: 5.2, elevation: 21, azimuth: -32 });
  const post = new Post(renderer, scene, rig.camera, canvas.width, canvas.height);
  (window as unknown as { __dbg: unknown }).__dbg = { lighting, scene, ground, layer, post };
  post.setQuality('high');
  let frames = 0;
  const loop = () => {
    requestAnimationFrame(loop);
    rig.update(0.016);
    lighting.update(rig.camera, 40);
    lighting.fog.near = 30;
    lighting.fog.far = 80;
    post.render(0.016);
    if (++frames === 5) onReady();
  };
  await renderer.compileAsync(scene, rig.camera);
  loop();
}
