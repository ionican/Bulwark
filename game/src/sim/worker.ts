// Simulation worker: owns a SimRunner (world + clock + checkpoints), steps it at 10 ticks per
// second times the game speed and transfers a snapshot buffer to the render thread after each
// batch of ticks. Commands arrive as messages, are validated, and are either queued for the next
// tick or reported back as rejected. Returned buffers are reused.

import { encodeSnapshot } from './snapshot.ts';
import { createWorld } from './scenarios.ts';
import { SimRunner } from './runner.ts';
import { SaveVersionError, serializeWorld } from './save.ts';
import { planRun } from './runs.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

let runner: SimRunner | null = null;
const spare: ArrayBuffer[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function post(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, { transfer });
}

function sendSnapshot(tickMs: number, ticksRun: number) {
  if (!runner) return;
  const buffer = encodeSnapshot(runner.world, spare.pop());
  post(
    {
      type: 'snapshot',
      buffer,
      tickMs,
      ticksRun,
      runner: { speed: runner.speed, paused: runner.paused, checkpoints: runner.checkpoints.map((c) => ({ wave: c.wave, tick: c.tick })) },
    },
    [buffer],
  );
}

function loop() {
  if (!runner) return;
  const t0 = performance.now();
  const ran = runner.advance(t0);
  const tickMs = ran > 0 ? (performance.now() - t0) / ran : 0;
  // While paused, keep sending (cheaply, 4 per second) so orders given show up in the HUD.
  if (ran > 0 || runner.paused || runner.world.outcome !== 0) sendSnapshot(tickMs, ran);
  const wait = runner.paused || runner.world.outcome !== 0 ? 250 : runner.delay(performance.now());
  timer = setTimeout(loop, wait);
}

function restart() {
  if (timer !== null) clearTimeout(timer);
  sendSnapshot(0, 0);
  timer = setTimeout(loop, runner!.delay(performance.now()));
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      const world = createWorld(msg.seed, msg.scenario);
      if (msg.rich) world.pool.set([1e6, 1e6, 1e6]);
      runner = new SimRunner(world, performance.now());
      restart();
      break;
    }
    case 'command': {
      if (!runner) return;
      // A wall run reports its plan (tiles to build, tiles skipped) with the acceptance.
      const plan = msg.cmd.t === 'buildRun' ? planRun(runner.world, msg.cmd) : null;
      const problem = runner.submit(msg.cmd);
      if (problem) post({ type: 'rejected', reason: problem, cmd: msg.cmd, ref: msg.ref });
      else if (msg.ref !== undefined) {
        const detail = plan && typeof plan !== 'string' ? { tiles: plan.tiles.length, skipped: plan.skipped, axis: plan.axis, start: plan.start } : undefined;
        post({ type: 'accepted', ref: msg.ref, tick: runner.world.tick, detail });
      }
      break;
    }
    case 'recycle':
      if (spare.length < 4) spare.push(msg.buffer);
      break;
    case 'speed':
      runner?.setSpeed(msg.speed, performance.now());
      break;
    case 'pause':
      runner?.setPaused(msg.paused, performance.now());
      if (runner) sendSnapshot(0, 0);
      break;
    case 'rewind': {
      if (!runner) return;
      const r = runner.rewind();
      if (typeof r === 'string') post({ type: 'notice', message: `Rewind refused: ${r}.` });
      else {
        post({ type: 'notice', message: `Rewound to the start of wave ${r.wave}.` });
        restart();
      }
      break;
    }
    case 'save': {
      if (!runner) return;
      const bytes = serializeWorld(runner.world);
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      post({ type: 'saved', bytes: buf, tick: runner.world.tick }, [buf]);
      break;
    }
    case 'load': {
      if (!runner) return;
      try {
        runner.load(new Uint8Array(msg.bytes));
        post({ type: 'notice', message: `Save loaded (tick ${runner.world.tick}).` });
        restart();
      } catch (e) {
        post({ type: 'error', message: e instanceof SaveVersionError ? e.message : `Could not load the save: ${(e as Error).message}` });
      }
      break;
    }
  }
};
