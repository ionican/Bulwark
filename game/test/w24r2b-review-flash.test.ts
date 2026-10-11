// W24 run 2b, the post-build adversarial review (2026-10-09), finding 2 of 3.
//
// A muzzle flash spawned in a frame whose effect-clock step exceeds its life (10× at 60 Hz: 0.1 s >
// FLASH_LIFE 0.08) was aged and removed before its first upload. Existing flashes and particles now
// age at the start of the frame, before the frame's spawns, so a new one is drawn at least once.

import { describe, expect, it } from 'vitest';
import { A, B } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_FIRING, BF_STARTED } from '../src/sim/schema.ts';
import { World } from '../src/sim/world.ts';
import { MAX_STEP } from '../src/render/anim.ts';
import { drawAt, fx, nextEpoch, particles, renderer, rowIn, snapAt, terrain } from './w24r2b-fixtures.ts';

const ON = BF_COMPLETE | BF_STARTED;

describe('finding 2: a new muzzle flash is drawn at least once at any game speed', () => {
  for (const speed of [1, 3, 10]) {
    it(`${speed}×, 60 Hz frames: a firing snapshot gives a drawn flash and its glow`, () => {
      const dt = Math.min(MAX_STEP, speed / 60);
      const { r, scene } = renderer();
      const w = new World(1, terrain, { waves: false });
      const id = w.placeBuilding(B.gun, 66, 56, true);
      const alien = w.spawnAlien(A.rusher, 76.5, 50.5);
      const at = (tick: number, flags: number) => {
        const s = snapAt(w, tick);
        const row = rowIn(s.buildings, id);
        s.buildings.cols.flags[row] = flags;
        s.buildings.cols.target[row] = alien + 1;
        return s;
      };
      const E = nextEpoch();
      drawAt(r, at(10, ON), { t: 0, dt: 0, world: E });
      drawAt(r, at(10 + speed, ON | BF_FIRING), { t: dt, dt, world: E });
      expect(fx(scene, 'overlay/fx/flash').length, 'flash instances drawn').toBeGreaterThanOrEqual(1);
      expect(particles(scene, 'glow').length, 'muzzle glow particles drawn').toBeGreaterThan(0);
      expect(r.activityNow.firing && r.activityNow.flash).toBe(true);
    });
  }
});

