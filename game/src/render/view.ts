// The game's scene for each render mode (W24 run 2a).
//
//   models   (default) W17 lighting and haze (workshop/render/lighting.ts: low warm sun with one
//            shadow map fitted near the camera, the Poly Haven HDRI as image-based light, sky dome),
//            W17's terrain material on the game's own ground (groundView.ts), the model renderer
//            (models.ts) and W13's overlays (entities.ts, models off); W21's post stack in the adapter.
//   greybox  (`?greybox=1`) W13's renderer as it was: Lambert lights, the canvas-textured ground,
//            greybox models. Kept for comparison until the look is signed off; removed in run 3.

import { AmbientLight, Color, DirectionalLight, HemisphereLight, Scene, type PerspectiveCamera } from 'three';
import type { Terrain } from '../sim/terrain.ts';
import type { RenderAdapter } from './adapter.ts';
import { EntityRenderer, type Capacity, type FrameInput } from './entities.ts';
import { PaveMap, buildGroundMeshes, type GroundMeshes } from './groundView.ts';
import { buildIconAtlas } from './icons.ts';
import { createRenderMaterials } from './materials.ts';
import { ModelRenderer } from './models.ts';
import { buildTerrainView, type TerrainView } from './terrainView.ts';
import { TextureBank } from './workshop/assets/textures.ts';
import { Lighting } from './workshop/render/lighting.ts';
import { terrainMaterial } from './workshop/world/terrainMaterial.ts';
import { BF_COMPLETE } from '../sim/schema.ts';

export interface GameView {
  readonly scene: Scene;
  readonly entities: EntityRenderer;
  readonly models: ModelRenderer | null;
  readonly terrainView: TerrainView;
  readonly ground: GroundMeshes | null;
  readonly pave: PaveMap | null;
  readonly lighting: Lighting | null;
  /** Per-frame updates before the adapter renders. `distance` is the camera rig's distance. */
  update(f: FrameInput, distance: number, wppAt: (x: number, y: number, z: number) => number, overview: boolean): void;
}

export async function createView(
  adapter: RenderAdapter,
  terrain: Terrain,
  camera: PerspectiveCamera,
  capacity: Capacity,
  progress: (text: string) => void,
): Promise<GameView> {
  const scene = new Scene();
  if (adapter.mode === 'greybox') {
    scene.background = new Color('#1d1916');
    scene.add(new HemisphereLight('#ffe9d2', '#3a2a20', 1.9));
    scene.add(new AmbientLight('#ffffff', 0.25));
    const sun = new DirectionalLight('#fff0dc', 2.2);
    sun.position.set(-40, 90, -30);
    scene.add(sun);
    const terrainView = buildTerrainView(terrain);
    scene.add(terrainView.group);
    const entities = new EntityRenderer(scene, terrain, capacity, { models: true });
    adapter.attach(scene, camera);
    return {
      scene,
      entities,
      models: null,
      terrainView,
      ground: null,
      pave: null,
      lighting: null,
      update(f, _d, wppAt, overview) {
        entities.update(f);
        terrainView.update(wppAt, overview, f.yaw);
      },
    };
  }

  const r = adapter.renderer;
  const bank = new TextureBank();
  bank.anisotropy = Math.min(16, r.capabilities.getMaxAnisotropy());
  await bank.load((d, n) => progress(`Loading textures… ${d}/${n}`));
  const lighting = new Lighting(scene, r);
  await lighting.loadEnvironment(bank.hdrUrl, 0.55);
  progress('Building the ground and models…');
  await new Promise((res) => setTimeout(res, 0));
  const mats = createRenderMaterials(bank);
  const pave = new PaveMap(terrain.w, terrain.h);
  const ground = buildGroundMeshes(terrain, terrainMaterial(bank, pave.texture, terrain.w, terrain.h));
  scene.add(ground.ground, ground.outcrops);
  const models = new ModelRenderer(terrain, mats, capacity, (icons) => {
    const atlas = buildIconAtlas(icons, bank.anisotropy);
    bank.derived.add(atlas);
    return atlas;
  });
  scene.add(models.group);
  const entities = new EntityRenderer(scene, terrain, capacity, { models: false });
  const terrainView = buildTerrainView(terrain, { ground: false });
  scene.add(terrainView.group);
  adapter.attach(scene, camera);
  adapter.onQuality((_q, spec) => {
    lighting.setShadowSize(spec.shadow);
    // the playable ground is gently rolling: only the outcrops and scenery relief cast shadows
    ground.ground.castShadow = false;
    ground.outcrops.castShadow = spec.terrainShadow;
  });
  let paveTick = -1;
  return {
    scene,
    entities,
    models,
    terrainView,
    ground,
    pave,
    lighting,
    update(f, distance, wppAt, overview) {
      const spec = adapter.spec;
      lighting.update(camera, Math.max(8, distance), Math.min(camera.far, distance * spec.shadowReach + 20));
      const s = f.snapshot;
      if (s.tick !== paveTick) {
        paveTick = s.tick;
        const c = s.buildings.cols;
        pave.update(s.buildings.count, c.tx, c.ty, c.fw, c.fh, (row) => (c.flags[row]! & BF_COMPLETE) !== 0);
      }
      models.update(f);
      entities.update(f);
      terrainView.update(wppAt, overview, f.yaw);
    },
  };
}
