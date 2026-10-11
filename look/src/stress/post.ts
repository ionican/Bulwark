// W17's post-processing stack (render pass, N8AO, bloom on luminance > 1, ACES filmic, SMAA) with
// switches for the stress quality levels: ambient occlusion can be turned off, and bloom can be
// dropped by switching to a second effect pass that only tone-maps.

import { BloomEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { Color, HalfFloatType, type PerspectiveCamera, type Scene, type WebGLRenderer } from 'three';

export type StressQuality = 'high' | 'medium' | 'low';

export interface QualitySpec {
  shadow: number;
  ao: 'High' | 'Medium' | 'off';
  aoHalfRes: boolean;
  bloom: boolean;
  /** Upper limit on the device pixel ratio. */
  maxDpr: number;
  /** Shadow reach as a multiple of the camera's distance to its target (plus 20 tiles). */
  shadowReach: number;
  terrainShadow: boolean;
}

export const QUALITY: Record<StressQuality, QualitySpec> = {
  high: { shadow: 4096, ao: 'High', aoHalfRes: false, bloom: true, maxDpr: 1.5, shadowReach: 1.6, terrainShadow: true },
  medium: { shadow: 2048, ao: 'Medium', aoHalfRes: true, bloom: true, maxDpr: 1, shadowReach: 1.3, terrainShadow: true },
  low: { shadow: 1024, ao: 'off', aoHalfRes: true, bloom: false, maxDpr: 1, shadowReach: 1.0, terrainShadow: false },
};

export class StressPost {
  readonly composer: EffectComposer;
  readonly ao: N8AOPostPass;
  readonly bloom: BloomEffect;
  private withBloom: EffectPass;
  private toneOnly: EffectPass;

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
    this.withBloom = new EffectPass(camera, this.bloom, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    this.toneOnly = new EffectPass(camera, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    this.toneOnly.enabled = false;
    this.composer.addPass(this.withBloom);
    this.composer.addPass(this.toneOnly);
    this.composer.addPass(new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH })));
  }

  apply(q: QualitySpec): void {
    if (q.ao === 'off') this.ao.enabled = false;
    else {
      this.ao.enabled = true;
      this.ao.setQualityMode(q.ao);
      this.ao.configuration.halfRes = q.aoHalfRes;
      this.ao.configuration.depthAwareUpsampling = true;
    }
    this.withBloom.enabled = q.bloom;
    this.toneOnly.enabled = !q.bloom;
  }

  /** CSS pixel size; the drawing buffer follows the renderer's pixel ratio. */
  setSize(cssW: number, cssH: number): void {
    this.composer.setSize(cssW, cssH, false);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }
}
