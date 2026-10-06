// Simulation worker: owns the World, steps it at a fixed 10 ticks per second and transfers a
// snapshot buffer to the render thread after each step. Commands arrive as messages and are
// stamped with the next tick. Returned buffers are reused, so steady state allocates nothing.

import { encodeSnapshot } from './snapshot.ts';
import { createWorld } from './scenarios.ts';
import { TICK_HZ } from './kinds.ts';
import type { FromWorker, ToWorker } from './protocol.ts';
import type { World } from './world.ts';

const TICK_MS = 1000 / TICK_HZ;
/** After a stall (tab in background, debugger) run at most this many ticks to catch up. */
const MAX_CATCH_UP = 5;

let world: World | null = null;
const spare: ArrayBuffer[] = [];
let nextTickAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function post(msg: FromWorker) {
  self.postMessage(msg, { transfer: [msg.buffer] });
}

function takeBuffer(): ArrayBuffer | undefined {
  return spare.pop();
}

function loop() {
  if (!world) return;
  const now = performance.now();
  let ran = 0;
  let tickMs = 0;
  while (now >= nextTickAt && ran < MAX_CATCH_UP) {
    const t0 = performance.now();
    world.step();
    ran++;
    nextTickAt += TICK_MS;
    tickMs = performance.now() - t0;
  }
  if (now >= nextTickAt) nextTickAt = now + TICK_MS; // dropped ticks: resume from now
  if (ran > 0) {
    const t0 = performance.now();
    const buffer = encodeSnapshot(world, takeBuffer());
    tickMs += performance.now() - t0;
    post({ type: 'snapshot', buffer, tickMs, ticksRun: ran });
  }
  timer = setTimeout(loop, Math.max(0, nextTickAt - performance.now()));
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      if (timer !== null) clearTimeout(timer);
      world = createWorld(msg.seed, msg.scenario);
      // Send the starting state at once so the first frame has something to draw.
      post({ type: 'snapshot', buffer: encodeSnapshot(world), tickMs: 0, ticksRun: 0 });
      nextTickAt = performance.now() + TICK_MS;
      timer = setTimeout(loop, TICK_MS);
      break;
    case 'command':
      world?.enqueue(msg.cmd);
      break;
    case 'recycle':
      if (spare.length < 4) spare.push(msg.buffer);
      break;
  }
};
