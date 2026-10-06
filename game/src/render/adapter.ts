// Renderer adapter. The only module that names a concrete three.js renderer. Everything else uses
// standard materials (Lambert, Basic) that both WebGLRenderer and WebGPURenderer support, so a later
// switch to WebGPU changes this file only.

import { WebGLRenderer, type Camera, type Scene } from 'three';

export interface RenderAdapter {
  readonly canvas: HTMLCanvasElement;
  setSize(width: number, height: number): void;
  render(scene: Scene, camera: Camera): void;
  /** Draw calls issued by the last render(). */
  drawCalls(): number;
  triangles(): number;
  /** Backend and GPU string, e.g. "WebGL2 / ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, ...)". */
  describe(): string;
}

export function createRenderer(): RenderAdapter {
  const r = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  r.domElement.className = 'view';
  const gl = r.getContext();
  let gpu = String(gl.getParameter(gl.RENDERER));
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) gpu = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
  const backend = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? 'WebGL2' : 'WebGL1';
  return {
    canvas: r.domElement,
    setSize: (w, h) => r.setSize(w, h, false),
    render: (scene, camera) => r.render(scene, camera),
    drawCalls: () => r.info.render.calls,
    triangles: () => r.info.render.triangles,
    describe: () => `${backend} / ${gpu}`,
  };
}
