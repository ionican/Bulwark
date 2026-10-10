// Frame cost by forced-completion timing (W24 run 2a budgets: terrain and scenery ≤ 5 ms GPU per
// frame, post-processing ≤ 3.5 ms, at the game camera, medium, 1440 × 900).
//
// A block renders one configuration `frames` times back to back; after each render a 1-pixel
// readPixels from the screen waits for the GPU to finish, so the wall-clock time per frame is the
// CPU submit plus the GPU work, with no vsync cap. The configurations are measured in interleaved
// rounds (one block of each per round, after a warm-up) and each figure is the median over the
// rounds, so a GPU clock that ramps up or down during the measurement affects every configuration
// alike. Costs are differences between configurations:
//
//   terrainMs          full frame − the same frame with the ground, scenery and outcrops hidden
//                      (scene pass, shadow pass and ambient occlusion all included)
//   terrainIsolatedMs  ground, scenery and outcrops alone, no post − an empty scene, no post
//   postMs             full frame − the scene drawn straight to the screen without the post stack
//   passMs             full frame − the frame with one post pass switched off; with the last pass
//                      (SMAA, which draws to the screen) off, the pass before it draws to the screen
//                      for the measurement. `remainder` is what the passes do not account for (the
//                      half-float scene target and its copies).
//
// The frame loop is paused while it runs (the caller passes `running`).

import type { PerspectiveCamera } from 'three';
import type { RenderAdapter } from './adapter.ts';
import type { GameView } from './view.ts';

export interface RenderCost {
  frames: number;
  rounds: number;
  fullMs: number;
  noGroundMs: number;
  plainMs: number;
  groundOnlyPlainMs: number;
  emptyPlainMs: number;
  terrainMs: number;
  terrainIsolatedMs: number;
  postMs: number;
  /** Per post pass: full frame − the frame with that pass switched off (name → ms), and the remainder. */
  passMs: Record<string, number>;
  /** Drawing buffer size. */
  buffer: [number, number];
}

interface Config {
  name: string;
  on?: () => void;
  off?: () => void;
  draw: () => void;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

export async function measureRenderCost(adapter: RenderAdapter, view: GameView, camera: PerspectiveCamera, frames: number, running: (on: boolean) => void, rounds = 7): Promise<RenderCost> {
  const r = adapter.renderer;
  const gl = r.getContext();
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const scene = view.scene;
  const withPost = () => adapter.render(1 / 60);
  const plain = () => {
    r.info.reset();
    r.render(scene, camera);
  };
  const ground = [view.ground.ground, view.ground.outcrops];
  const setGround = (on: boolean) => ground.forEach((m) => (m.visible = on));
  const others = scene.children.filter((o) => !ground.includes(o as never) && o.name !== 'sky' && !o.type.endsWith('Light'));
  let saved: boolean[] = [];
  const hideOthers = () => {
    saved = others.map((o) => o.visible);
    others.forEach((o) => (o.visible = false));
  };
  const showOthers = () => others.forEach((o, i) => (o.visible = saved[i]!));
  const configs: Config[] = [
    { name: 'full', draw: withPost },
    { name: 'noGround', on: () => setGround(false), off: () => setGround(true), draw: withPost },
    { name: 'plain', draw: plain },
    { name: 'groundOnlyPlain', on: hideOthers, off: showOthers, draw: plain },
    {
      name: 'emptyPlain',
      on: () => {
        hideOthers();
        setGround(false);
      },
      off: () => {
        setGround(true);
        showOthers();
      },
      draw: plain,
    },
  ];
  const passes = adapter.post?.composer.passes ?? [];
  passes.forEach((p, i) => {
    if (i === 0 || !p.enabled) return; // the render pass is the scene itself
    let stand: (typeof passes)[number] | undefined;
    if (i === passes.length - 1) for (let j = i - 1; j > 0 && !stand; j--) if (passes[j]!.enabled) stand = passes[j];
    configs.push({
      name: `pass:${p.name}`,
      on: () => {
        p.enabled = false;
        if (stand) stand.renderToScreen = true;
      },
      off: () => {
        if (stand) stand.renderToScreen = false;
        p.enabled = true;
      },
      draw: withPost,
    });
  });
  const block = (c: Config): number => {
    c.on?.();
    try {
      c.draw();
      sync();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        c.draw();
        sync();
      }
      return (performance.now() - t0) / frames;
    } finally {
      c.off?.();
    }
  };
  running(true);
  // let the loop see the flag before measuring
  await new Promise((res) => requestAnimationFrame(() => res(null)));
  try {
    // warm-up: about a second of full frames
    const w0 = performance.now();
    while (performance.now() - w0 < 1000) {
      withPost();
      sync();
    }
    const samples = new Map<string, number[]>(configs.map((c) => [c.name, []]));
    for (let k = 0; k < rounds; k++) for (const c of configs) samples.get(c.name)!.push(block(c));
    const m = (name: string) => median(samples.get(name)!);
    const fullMs = m('full');
    const plainMs = m('plain');
    const passMs: Record<string, number> = {};
    let measured = 0;
    for (const c of configs)
      if (c.name.startsWith('pass:')) {
        const ms = fullMs - m(c.name);
        passMs[c.name.slice(5)] = ms;
        measured += ms;
      }
    if (Object.keys(passMs).length) passMs.remainder = fullMs - plainMs - measured;
    return {
      frames,
      rounds,
      fullMs,
      noGroundMs: m('noGround'),
      plainMs,
      groundOnlyPlainMs: m('groundOnlyPlain'),
      emptyPlainMs: m('emptyPlain'),
      terrainMs: fullMs - m('noGround'),
      terrainIsolatedMs: m('groundOnlyPlain') - m('emptyPlain'),
      postMs: fullMs - plainMs,
      passMs,
      buffer: [adapter.canvas.width, adapter.canvas.height],
    };
  } finally {
    running(false);
  }
}
