// Frame cost by forced-completion timing (W24 run 2a budgets: terrain and scenery ≤ 5 ms GPU per
// frame, post-processing ≤ 3.5 ms, at the game camera, medium, 1440 × 900).
//
// Each configuration is rendered `frames` times back to back; after each render a 1-pixel
// readPixels waits for the GPU to finish, so the wall-clock time per frame is the CPU submit plus
// the GPU work, with no vsync cap. Costs are differences between configurations:
//
//   terrainMs          full frame − the same frame with the ground, scenery and outcrops hidden
//                      (scene pass, shadow pass and ambient occlusion all included)
//   terrainIsolatedMs  ground, scenery and outcrops alone, no post − an empty scene, no post
//   postMs             full frame − the scene drawn straight to the screen without the post stack
//
// The frame loop is paused while it runs (the caller passes `running`).

import type { PerspectiveCamera } from 'three';
import type { RenderAdapter } from './adapter.ts';
import type { GameView } from './view.ts';

export interface RenderCost {
  frames: number;
  fullMs: number;
  noGroundMs: number;
  plainMs: number;
  groundOnlyPlainMs: number;
  emptyPlainMs: number;
  terrainMs: number;
  terrainIsolatedMs: number;
  postMs: number;
  /** Drawing buffer size. */
  buffer: [number, number];
}

export async function measureRenderCost(adapter: RenderAdapter, view: GameView, camera: PerspectiveCamera, frames: number, running: (on: boolean) => void): Promise<RenderCost> {
  const r = adapter.renderer;
  const gl = r.getContext();
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const scene = view.scene;
  const time = (draw: () => void): number => {
    for (let i = 0; i < 3; i++) draw();
    sync();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      draw();
      sync();
    }
    return (performance.now() - t0) / frames;
  };
  const withPost = () => adapter.render(1 / 60);
  const plain = () => {
    r.info.reset();
    r.render(scene, camera);
  };
  const ground = view.ground ? [view.ground.ground, view.ground.outcrops] : [];
  const setGround = (on: boolean) => ground.forEach((m) => (m.visible = on));
  const others = scene.children.filter((o) => !ground.includes(o as never) && o.name !== 'sky' && !o.type.endsWith('Light'));
  running(true);
  // let the loop see the flag before measuring
  await new Promise((res) => requestAnimationFrame(() => res(null)));
  try {
    const fullMs = time(withPost);
    setGround(false);
    const noGroundMs = time(withPost);
    setGround(true);
    const plainMs = time(plain);
    const vis = others.map((o) => o.visible);
    others.forEach((o) => (o.visible = false));
    const groundOnlyPlainMs = time(plain);
    setGround(false);
    const emptyPlainMs = time(plain);
    setGround(true);
    others.forEach((o, i) => (o.visible = vis[i]!));
    return {
      frames,
      fullMs,
      noGroundMs,
      plainMs,
      groundOnlyPlainMs,
      emptyPlainMs,
      terrainMs: fullMs - noGroundMs,
      terrainIsolatedMs: groundOnlyPlainMs - emptyPlainMs,
      postMs: fullMs - plainMs,
      buffer: [adapter.canvas.width, adapter.canvas.height],
    };
  } finally {
    running(false);
  }
}
