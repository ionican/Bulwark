// Renderer adapter: the only module that creates the WebGLRenderer. W24 run 2a gives it an explicit
// lifecycle (PLAN "Render adapter"):
//
//   create      the renderer, sRGB output; three's own tone mapping off (the post stack tone-maps)
//   attach      scene and camera; in model mode builds W21's StressPost stack on them (render pass,
//               N8AO ambient occlusion, bloom on luminance above 1, ACES filmic, SMAA)
//   quality     'medium' (default: device pixel ratio capped at 1, 2048² shadow map, half-resolution
//               ambient occlusion) or 'high' (W21's QUALITY table, workshop/stress/post.ts)
//   resize      drawing buffer and composer to the CSS size × the capped pixel ratio
//   render      one frame; CPU milliseconds per pass recorded in `timing` (the composer's passes
//               are wrapped once, so each pass's own render call is timed)
//
// `?greybox=1` (W13's renderer, kept for comparison until the look is signed off) uses the same
// adapter in greybox mode: no composer, three's renderer draws the scene directly.

import { NoToneMapping, SRGBColorSpace, WebGLRenderer, type Camera, type PerspectiveCamera, type Scene } from 'three';
import { QUALITY, StressPost, type QualitySpec } from './workshop/stress/post.ts';

export type Quality = 'medium' | 'high';
export type RenderMode = 'models' | 'greybox';

export interface PassTiming {
  /** CPU ms per pass in the last frame, by pass name (composer passes, or 'scene' in greybox). */
  passes: Record<string, number>;
  /** CPU ms of the whole render call. */
  renderMs: number;
  /**
   * Draw calls and triangles each pass submitted in the last frame (renderer.info deltas around the
   * pass; the scene pass includes its shadow maps). The run 2b gate compares the scene pass with
   * what the scene graph says must be drawn (render/inspect.ts submissionFloor).
   */
  submitted: Record<string, { calls: number; triangles: number }>;
}

export interface RenderAdapter {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGLRenderer;
  readonly mode: RenderMode;
  readonly quality: Quality;
  readonly spec: QualitySpec;
  readonly timing: PassTiming;
  /** The post stack (model mode, after attach), or null. */
  readonly post: StressPost | null;
  attach(scene: Scene, camera: PerspectiveCamera): void;
  setSize(width: number, height: number): void;
  setQuality(q: Quality): void;
  /** Called with each new quality (lighting and shadow casters follow it). */
  onQuality(fn: (q: Quality, spec: QualitySpec) => void): void;
  render(dt: number): void;
  /** Draw calls and triangles of the last frame, every pass included (shadow, scene, post). */
  drawCalls(): number;
  triangles(): number;
  /** Backend and GPU string, e.g. "WebGL2 / ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, ...)". */
  describe(): string;
}

export function createRenderer(mode: RenderMode, quality: Quality = 'medium'): RenderAdapter {
  const r = new WebGLRenderer({ antialias: mode === 'greybox', powerPreference: 'high-performance', stencil: false, depth: true });
  r.outputColorSpace = SRGBColorSpace;
  r.toneMapping = NoToneMapping;
  r.info.autoReset = false;
  r.domElement.className = 'view';
  const gl = r.getContext();
  let gpu = String(gl.getParameter(gl.RENDERER));
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) gpu = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
  const backend = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? 'WebGL2' : 'WebGL1';

  let scene: Scene | null = null;
  let camera: Camera | null = null;
  let post: StressPost | null = null;
  let q: Quality = quality;
  let cssW = 1;
  let cssH = 1;
  const listeners: Array<(q: Quality, spec: QualitySpec) => void> = [];
  const timing: PassTiming = { passes: {}, renderMs: 0, submitted: {} };
  const dpr = () => Math.min(window.devicePixelRatio || 1, mode === 'greybox' ? 2 : QUALITY[q].maxDpr);

  const applyQuality = () => {
    const spec = QUALITY[q];
    r.setPixelRatio(dpr());
    r.setSize(cssW, cssH, false);
    if (post) {
      post.apply(spec);
      post.setSize(cssW, cssH);
    }
    for (const fn of listeners) fn(q, spec);
  };

  const adapter: RenderAdapter = {
    canvas: r.domElement,
    renderer: r,
    mode,
    get quality() {
      return q;
    },
    get spec() {
      return QUALITY[q];
    },
    timing,
    get post() {
      return post;
    },
    attach(s, c) {
      scene = s;
      camera = c;
      if (mode === 'models') {
        post = new StressPost(r, s, c, Math.max(1, cssW), Math.max(1, cssH));
        // W21's order (stress/post.ts): scene, ambient occlusion, bloom + tone map, tone map only
        // (when bloom is off), SMAA. Named, and each pass's own render call timed (CPU).
        const names = ['scene', 'ambient-occlusion', 'bloom+tonemap', 'tonemap-only', 'smaa'];
        post.composer.passes.forEach((p, i) => (p.name = names[i] ?? p.name));
        for (const pass of post.composer.passes) {
          const name = pass.name;
          const inner = pass.render.bind(pass);
          pass.render = (...args: Parameters<typeof pass.render>) => {
            const t0 = performance.now();
            const c0 = r.info.render.calls;
            const tr0 = r.info.render.triangles;
            inner(...args);
            timing.passes[name] = (timing.passes[name] ?? 0) + performance.now() - t0;
            timing.submitted[name] = { calls: r.info.render.calls - c0, triangles: r.info.render.triangles - tr0 };
          };
        }
        applyQuality();
      }
    },
    setSize(w, h) {
      cssW = w;
      cssH = h;
      applyQuality();
    },
    setQuality(next) {
      q = next;
      applyQuality();
    },
    onQuality(fn) {
      listeners.push(fn);
      fn(q, QUALITY[q]);
    },
    render(dt) {
      if (!scene || !camera) return;
      r.info.reset();
      for (const k of Object.keys(timing.passes)) timing.passes[k] = 0;
      timing.submitted = {};
      const t0 = performance.now();
      if (post) post.render(dt);
      else {
        r.render(scene, camera);
        timing.passes.scene = performance.now() - t0;
        timing.submitted.scene = { calls: r.info.render.calls, triangles: r.info.render.triangles };
      }
      timing.renderMs = performance.now() - t0;
    },
    drawCalls: () => r.info.render.calls,
    triangles: () => r.info.render.triangles,
    describe: () => `${backend} / ${gpu}`,
  };
  return adapter;
}
