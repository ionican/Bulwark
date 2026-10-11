// W23 walk cycles and detail levels: planted feet do not slide (engineer and commander, measured
// on the drawn boot / foot segment), the IK reaches every planted foot, turning on the spot steps
// the feet, and per-asset detail levels switch with hysteresis.
// Run: npm test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { solveTwoBone } from '../src/w23/rig/biped.ts';
import { CSEG, CommanderRig } from '../src/w23/rig/commander.ts';
import { EngineerRig, SEG, VARIANTS } from '../src/w23/rig/engineer.ts';
import { COMMANDER_LEGS, COMMANDER_TURN, COMMANDER_WALK, ENGINEER_LEGS, ENGINEER_RUN, ENGINEER_WALK } from '../src/w23/rig/specs.ts';
import { LevelTracker, THRESHOLDS } from '../src/w23/lod.ts';

const flat = () => 0;
/** Gentle rolling ground (up to ±0.25 tiles), so the IK has to follow the terrain. */
const rolling = (x: number, z: number) => 0.18 * Math.sin(x * 0.35) + 0.08 * Math.cos(z * 0.5 + x * 0.2);

interface Stance {
  start: Vector3;
  maxDrift: number;
  frames: number;
}

/**
 * Walks a rig along a path and records, for each foot, how far its drawn position (the foot
 * segment's matrix translation) moves during each stance.
 */
function walk(opts: {
  rig: EngineerRig | CommanderRig;
  footSegs: [number, number];
  speed: number;
  seconds: number;
  ground: (x: number, z: number) => number;
  path: (s: number) => { x: number; z: number; yaw: number };
  action?: string;
}) {
  const { rig, footSegs, speed, seconds, ground, path } = opts;
  const dt = 1 / 60;
  const p0 = path(0);
  rig.place(p0.x, p0.z, p0.yaw, ground);
  if (opts.action && rig instanceof EngineerRig) rig.setAction(opts.action as never);
  const stances: Stance[][] = [[], []];
  const open: Array<Stance | null> = [null, null];
  let unreached = 0;
  const footTravel = [0, 0];
  const last = [new Vector3(), new Vector3()];
  let s = 0;
  for (let f = 0; f < seconds * 60; f++) {
    s += speed * dt;
    const p = path(s);
    rig.update(dt, p.x, p.z, p.yaw, ground);
    for (let i = 0; i < 2; i++) {
      const foot = rig.legs.feet[i]!;
      const at = new Vector3().setFromMatrixPosition(rig.mats[footSegs[i]!]!);
      if (f > 0) footTravel[i]! += Math.hypot(at.x - last[i]!.x, at.z - last[i]!.z);
      last[i]!.copy(at);
      if (foot.stance) {
        if (!open[i]) open[i] = { start: at.clone(), maxDrift: 0, frames: 0 };
        const st = open[i]!;
        st.maxDrift = Math.max(st.maxDrift, at.distanceTo(st.start));
        st.frames++;
      } else if (open[i]) {
        stances[i]!.push(open[i]!);
        open[i] = null;
      }
    }
    if (!rig.legs.reached) unreached++;
  }
  return { stances, unreached, footTravel, distance: s };
}

const straight = (x0: number, z0: number, yaw: number) => (s: number) => ({ x: x0 + Math.cos(yaw) * s, z: z0 - Math.sin(yaw) * s, yaw });

test('two-bone IK puts the ankle on a reachable target and bends the knee towards the pole', () => {
  const hip = new Vector3(0, 1, 0);
  const knee = new Vector3();
  const ankle = new Vector3();
  const target = new Vector3(0.2, 0.25, 0.05);
  const ok = solveTwoBone(hip, target, 0.45, 0.45, new Vector3(1, 0, 0), knee, ankle);
  assert.equal(ok, true);
  assert.ok(ankle.distanceTo(target) < 1e-9);
  assert.ok(Math.abs(knee.distanceTo(hip) - 0.45) < 1e-9);
  assert.ok(Math.abs(knee.distanceTo(ankle) - 0.45) < 1e-9);
  assert.ok(knee.x > (hip.x + ankle.x) / 2, 'knee forward of the hip–ankle line');
  // out of reach: stretched towards it, reported as not reached
  assert.equal(solveTwoBone(hip, new Vector3(0, -1, 0), 0.45, 0.45, new Vector3(1, 0, 0), knee, ankle), false);
});

for (const [name, mk, segs, speed, ground] of [
  ['engineer, walk, flat', () => new EngineerRig(VARIANTS[0]), [SEG.footL, SEG.footR], ENGINEER_WALK, flat],
  ['engineer, walk, rolling ground', () => new EngineerRig(VARIANTS[1]), [SEG.footL, SEG.footR], ENGINEER_WALK, rolling],
  ['commander, walk, flat', () => new CommanderRig(), [CSEG.footL, CSEG.footR], COMMANDER_WALK, flat],
  ['commander, walk, rolling ground', () => new CommanderRig(), [CSEG.footL, CSEG.footR], COMMANDER_WALK, rolling],
] as const) {
  test(`planted feet drift less than 2 cm through every stance: ${name}`, () => {
    const rig = mk();
    const r = walk({ rig, footSegs: segs as [number, number], speed, seconds: 8, ground, path: straight(10, 10, 0.4), action: 'walk' });
    const stride = rig instanceof EngineerRig ? ENGINEER_LEGS.walk.stride : COMMANDER_LEGS.walk.stride;
    for (let i = 0; i < 2; i++) {
      const st = r.stances[i]!;
      assert.ok(st.length >= Math.floor(r.distance / stride) - 1, `foot ${i}: ${st.length} stances over ${r.distance.toFixed(2)} tiles`);
      const worst = Math.max(...st.map((x) => x.maxDrift));
      // 2 cm = 0.01 tiles
      assert.ok(worst < 0.01, `foot ${i}: worst stance drift ${(worst * 200).toFixed(2)} cm`);
      assert.ok(st.every((x) => x.frames > 3), 'stances last several frames');
      // the feet really walk: each travels about as far as the body
      assert.ok(Math.abs(r.footTravel[i]! - r.distance) < stride, `foot ${i} travelled ${r.footTravel[i]!.toFixed(2)} for ${r.distance.toFixed(2)}`);
    }
    assert.equal(r.unreached, 0, 'every planted foot within reach of the IK');
  });
}

test('engineer run: planted feet still hold', () => {
  const rig = new EngineerRig(VARIANTS[2]);
  const r = walk({ rig, footSegs: [SEG.footL, SEG.footR], speed: ENGINEER_RUN, seconds: 5, ground: flat, path: straight(0, 0, -1.1), action: 'run' });
  for (let i = 0; i < 2; i++) {
    const worst = Math.max(...r.stances[i]!.map((x) => x.maxDrift));
    assert.ok(worst < 0.01, `run, foot ${i}: ${(worst * 200).toFixed(2)} cm`);
  }
});

test('walking round a curve, starting and stopping: planted feet hold', () => {
  const rig = new EngineerRig(VARIANTS[3]);
  // a quarter circle of radius 4 tiles, with stops (speed 0) half way
  const R = 4;
  const r = walk({
    rig,
    footSegs: [SEG.footL, SEG.footR],
    speed: ENGINEER_WALK,
    seconds: 10,
    ground: flat,
    path: (s) => {
      const u = s < 3 ? s : s < 4 ? 3 : s - 1;
      const a = u / R;
      return { x: R * Math.sin(a), z: -R + R * Math.cos(a), yaw: -a };
    },
  });
  for (let i = 0; i < 2; i++) {
    const worst = Math.max(...r.stances[i]!.map((x) => x.maxDrift));
    assert.ok(worst < 0.01, `curve, foot ${i}: ${(worst * 200).toFixed(2)} cm`);
  }
});

test('the commander turns on the spot by stepping: feet re-plant round, none slides', () => {
  const rig = new CommanderRig();
  const dt = 1 / 60;
  rig.place(20, 20, 0, flat);
  const drift = [0, 0];
  const start = [new Vector3(), new Vector3()];
  const was = [true, true];
  let steps = 0;
  let yaw = 0;
  for (let f = 0; f < 4 * 60; f++) {
    yaw += COMMANDER_TURN * dt;
    rig.update(dt, 20, 20, yaw, flat);
    for (let i = 0; i < 2; i++) {
      const ft = rig.legs.feet[i]!;
      const at = new Vector3().setFromMatrixPosition(rig.mats[i === 0 ? CSEG.footL : CSEG.footR]!);
      if (ft.stance && !was[i]) start[i]!.copy(at);
      if (!ft.stance && was[i]) steps++;
      if (ft.stance && was[i] && f > 0) drift[i] = Math.max(drift[i]!, at.distanceTo(start[i]!));
      if (f === 0) start[i]!.copy(at);
      was[i] = ft.stance;
    }
  }
  assert.ok(steps >= 4, `${steps} steps while turning ${(yaw * 57.3).toFixed(0)}°`);
  for (let i = 0; i < 2; i++) assert.ok(drift[i]! < 0.01, `turning, foot ${i}: ${(drift[i]! * 200).toFixed(2)} cm`);
  // the feet follow the body round: once it stops, the last foot down is turned with it
  for (let f = 0; f < 120; f++) rig.update(dt, 20, 20, yaw, flat);
  const lag = rig.legs.feet.map((ft) => Math.abs(Math.atan2(Math.sin(ft.yaw - yaw), Math.cos(ft.yaw - yaw))));
  assert.ok(Math.min(...lag) < 0.6, `foot headings lag the body by ${lag.map((l) => (l * 57.3).toFixed(0)).join(' / ')}°`);
});

test('detail levels switch with hysteresis (no flicker at a threshold)', () => {
  for (const kind of ['wall', 'engineer', 'commander'] as const) {
    const th = THRESHOLDS[kind];
    const tr = new LevelTracker(kind, 4);
    assert.equal(tr.level(0, th[0]! - 1), 0, `${kind}: new object inside the first threshold is full`);
    // just past the threshold (inside the band): stays full
    assert.equal(tr.level(0, th[0]! * 1.05), 0, `${kind}: +5 % stays full`);
    assert.equal(tr.level(0, th[0]! * 1.09), 1, `${kind}: +9 % drops to middle`);
    // back just inside: stays middle until −8 %
    assert.equal(tr.level(0, th[0]! * 0.95), 1, `${kind}: −5 % stays middle`);
    assert.equal(tr.level(0, th[0]! * 0.91), 0, `${kind}: −9 % back to full`);
    // jitter round a threshold never flips
    let flips = 0;
    let prev = tr.level(1, th[1]! * 1.2);
    for (let k = 0; k < 200; k++) {
      const l = tr.level(1, th[1]! * (1 + 0.06 * Math.sin(k)));
      if (l !== prev) flips++;
      prev = l;
    }
    assert.ok(flips <= 1, `${kind}: ${flips} flips under ±6 % jitter`);
    assert.equal(tr.level(2, th[2]! * 2), 3, `${kind}: far away is the icon`);
    assert.equal(tr.level(3, 5, 2), 2, 'forced level for the detail-level view');
  }
});
