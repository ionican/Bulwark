// Post-processing with the `postprocessing` library: scene render (half-float), N8AO ambient
// occlusion, then bloom on emissive (luminance above 1) and ACES filmic tone mapping, then SMAA.

import { BloomEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { Color, HalfFloatType, type PerspectiveCamera, type Scene, type WebGLRenderer } from 'three';
import type { Quality } from '../assets/textures.ts';

export class Post {
  readonly composer: EffectComposer;
  readonly ao: N8AOPostPass;
  readonly bloom: BloomEffect;

  constructor(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, w: number, h: number) {
    this.composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: 0 });
    this.composer.addPass(new RenderPass(scene, camera));
    this.ao = new N8AOPostPass(scene, camera, w, h);
    this.ao.configuration.aoRadius = 1.6;
    this.ao.configuration.distanceFalloff = 0.6;
    this.ao.configuration.intensity = 2.2;
    this.ao.configuration.color = new Color(0x1a0d06);
    this.ao.configuration.gammaCorrection = false;
    this.composer.addPass(this.ao);
    this.bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.0, luminanceSmoothing: 0.25, intensity: 0.9, radius: 0.62 });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.composer.addPass(new EffectPass(camera, this.bloom, tone));
    this.composer.addPass(new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH })));
  }

  setQuality(q: Quality): void {
    if (q === 'high') {
      this.ao.setQualityMode('High');
      this.ao.configuration.halfRes = false;
    } else {
      this.ao.setQualityMode('Medium');
      this.ao.configuration.halfRes = true;
      this.ao.configuration.depthAwareUpsampling = true;
    }
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }
}
