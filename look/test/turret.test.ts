// Unit tests for the W20 turret fire control (src/bench/aim.ts, brain.ts, recoil.ts).
// Run: npm test  (node:test, TypeScript run directly by node's type stripping).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEG, ELEVATION, TRAVERSE, minTurnTime, shellAt, segPointDist, solveIntercept, stepAxis, wrapPi, type Vec3 } from '../src/bench/aim.ts';
import { GUN, IDLE_DELAY, SCAN_AMPLITUDE, TurretBrain, type BrainTarget } from '../src/bench/brain.ts';
import { RECOIL, Recoil } from '../src/bench/recoil.ts';

const DT = 1 / 60;

/** Deterministic PRNG for the randomised runs. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function target(id: number, pos: Vec3, vel: Vec3 = [0, 0, 0], radius = 0.45): BrainTarget {
  return { id, pos: [...pos] as Vec3, vel: [...vel] as Vec3, alive: true, radius };
}

/** Point at horizontal distance d, bearing `yawDeg` (turret convention), height h. */
function at(d: number, yawDeg: number, h: number): Vec3 {
  const a = yawDeg * DEG;
  return [Math.cos(a) * d, h, -Math.sin(a) * d];
}

test('stationary targets: yaw and pitch within 0.5° inside the time the turn rates allow, and stay there', () => {
  const cases: Array<{ yaw0: number; d: number; bearing: number; h: number }> = [
    { yaw0: 0, d: 12, bearing: 30, h: 0.5 },
    { yaw0: 0, d: 20, bearing: 120, h: 0.5 },
    { yaw0: 0, d: 16, bearing: 179, h: 0.5 },
    { yaw0: 90, d: 18, bearing: -90, h: 0.4 },
    { yaw0: 0, d: 3, bearing: 10, h: 3.2 }, // steep: pitch ≈ 41°
    { yaw0: 0, d: 6, bearing: -40, h: 0.55 }, // below the trunnion: pitch < 0
  ];
  for (const c of cases) {
    const b = new TurretBrain([0, 0, 0]);
    b.yaw.angle = c.yaw0 * DEG;
    const t = target(1, at(c.d, c.bearing, c.h));
    const sol = solveIntercept(b.trunnion, t.pos, [0, 0, 0], GUN.speed, GUN.gravity, GUN.barrelLength)!;
    assert.ok(sol, 'solution exists');
    const allowed = Math.max(minTurnTime(wrapPi(sol.yaw - b.yaw.angle), TRAVERSE), minTurnTime(sol.pitch - b.pitch.angle, ELEVATION));
    let reached = -1;
    for (let i = 0; i < 60 * 8; i++) {
      b.update(DT, [t]);
      const ok = Math.abs(wrapPi(b.yaw.angle - sol.yaw)) < 0.5 * DEG && Math.abs(b.pitch.angle - sol.pitch) < 0.5 * DEG;
      const time = (i + 1) * DT;
      if (ok && reached < 0) reached = time;
      if (reached >= 0 && time > reached + 0.1) assert.ok(ok, `left the target after reaching it (${JSON.stringify(c)})`);
    }
    assert.ok(reached > 0, `never reached ${JSON.stringify(c)}`);
    assert.ok(reached <= allowed + 0.12, `took ${reached.toFixed(3)} s, turn rates allow ${allowed.toFixed(3)} s (${JSON.stringify(c)})`);
    // it cannot be faster than physics allows either (a snapping implementation would be)
    assert.ok(reached >= allowed * 0.9 - 0.02, `too fast: ${reached.toFixed(3)} s < ${allowed.toFixed(3)} s`);
  }
});

test('never exceeds the turn rates or the elevation limits on any tick (randomised, variable dt)', () => {
  const rnd = lcg(7);
  const b = new TurretBrain([0, 0, 0]);
  const targets: BrainTarget[] = [];
  for (let i = 0; i < 6; i++) targets.push(target(i, at(4 + rnd() * 22, rnd() * 360 - 180, rnd() * 6 - 0.5), [rnd() * 8 - 4, 0, rnd() * 8 - 4]));
  // one almost overhead: wants more than +45°
  targets.push(target(99, [0.4, 6, 0.2], [0, 0, 0]));
  let maxYawRate = 0;
  let maxPitchRate = 0;
  for (let i = 0; i < 20000; i++) {
    const dt = 1 / (30 + Math.floor(rnd() * 115));
    for (const t of targets) {
      t.pos[0] += t.vel[0] * dt;
      t.pos[2] += t.vel[2] * dt;
      if (rnd() < 0.002) t.alive = !t.alive;
      if (Math.hypot(t.pos[0], t.pos[2]) > 26) {
        t.vel[0] = -t.vel[0];
        t.vel[2] = -t.vel[2];
      }
    }
    if (i % 3000 === 1500) b.manual = !b.manual;
    b.manualPoint = at(2 + rnd() * 20, rnd() * 360, 0);
    const y0 = b.yaw.angle;
    const p0 = b.pitch.angle;
    b.update(dt, targets);
    const dy = Math.abs(wrapPi(b.yaw.angle - y0));
    const dp = Math.abs(b.pitch.angle - p0);
    maxYawRate = Math.max(maxYawRate, dy / dt);
    maxPitchRate = Math.max(maxPitchRate, dp / dt);
    assert.ok(dy <= TRAVERSE.maxRate * dt + 1e-9, `traverse ${(dy / dt / DEG).toFixed(2)}°/s on tick ${i}`);
    assert.ok(dp <= ELEVATION.maxRate * dt + 1e-9, `elevation ${(dp / dt / DEG).toFixed(2)}°/s on tick ${i}`);
    assert.ok(b.pitch.angle >= ELEVATION.min! - 1e-12 && b.pitch.angle <= ELEVATION.max! + 1e-12, `pitch ${b.pitch.angle / DEG}° out of limits`);
    assert.ok(Math.abs(b.yaw.rate) <= TRAVERSE.maxRate + 1e-9 && Math.abs(b.pitch.rate) <= ELEVATION.maxRate + 1e-9);
  }
  // the run must actually have driven the axes hard, or the test proves nothing
  assert.ok(maxYawRate > 0.95 * TRAVERSE.maxRate, `traverse peaked at ${(maxYawRate / DEG).toFixed(1)}°/s`);
  assert.ok(maxPitchRate > 0.9 * ELEVATION.maxRate, `elevation peaked at ${(maxPitchRate / DEG).toFixed(1)}°/s`);
});

test('pitch command above +45° holds at +45°', () => {
  const b = new TurretBrain([0, 0, 0]);
  const t = target(1, [2.5, 8, 0]);
  for (let i = 0; i < 600; i++) b.update(DT, [t]);
  assert.ok(Math.abs(b.pitch.angle - 45 * DEG) < 1e-9, `pitch ${b.pitch.angle / DEG}`);
});

test('takes the short way round across ±180°', () => {
  for (const [from, to] of [
    [170, -170],
    [-170, 170],
    [179, -179],
  ] as const) {
    const s = { angle: from * DEG, rate: 0 };
    let travelled = 0;
    let crossedZero = false;
    for (let i = 0; i < 600; i++) {
      const a0 = s.angle;
      stepAxis(s, to * DEG, 0, DT, TRAVERSE);
      travelled += Math.abs(wrapPi(s.angle - a0));
      if (Math.abs(s.angle) < 90 * DEG) crossedZero = true;
    }
    const short = Math.abs(wrapPi((to - from) * DEG));
    assert.ok(Math.abs(wrapPi(s.angle - to * DEG)) < 1e-6, `ended at ${s.angle / DEG}`);
    assert.ok(!crossedZero, `went the long way from ${from}° to ${to}°`);
    assert.ok(Math.abs(travelled - short) < 1e-6, `travelled ${(travelled / DEG).toFixed(3)}°, short way is ${(short / DEG).toFixed(3)}°`);
  }
});

/** Headless engagement: the brain tracks one target moving at constant velocity; every shell is
 *  flown on its exact ballistic arc and checked against the target's sphere each tick. */
function engage(lead: boolean, start: Vec3, vel: Vec3, shotsWanted = 8): { hits: number; shots: number } {
  const b = new TurretBrain([0, 0, 0]);
  b.lead = lead;
  b.yaw.angle = Math.atan2(-start[2], start[0]);
  const t = target(1, start, vel, 0.45);
  const shells: Array<{ p0: Vec3; v0: Vec3; age: number; prev: Vec3; done: boolean }> = [];
  let hits = 0;
  let resolved = 0;
  for (let i = 0; i < 60 * 30 && resolved < shotsWanted; i++) {
    t.pos[0] += vel[0] * DT;
    t.pos[1] += vel[1] * DT;
    t.pos[2] += vel[2] * DT;
    if (b.shots < shotsWanted) for (const s of b.update(DT, [t])) shells.push({ p0: s.from, v0: s.vel, age: 0, prev: [...s.from] as Vec3, done: false });
    for (const s of shells) {
      if (s.done) continue;
      s.age += DT;
      const p = shellAt(s.p0, s.v0, s.age, GUN.gravity);
      if (segPointDist(s.prev, p, t.pos) <= t.radius) {
        hits++;
        s.done = true;
        resolved++;
      } else if (p[1] < -1 || s.age > 2) {
        s.done = true;
        resolved++;
      }
      s.prev = p;
    }
  }
  return { hits, shots: resolved };
}

/** Start point `back` tiles before the closest approach of a straight crossing run. */
function crossing(d: number, bearingDeg: number, _speed: number, back: number): Vec3 {
  const c = at(d, bearingDeg, 0.6);
  const v = crossingVel(bearingDeg, 1);
  return [c[0] + v[0] * back, c[1], c[2] + v[2] * back];
}
function crossingVel(bearingDeg: number, speed: number): Vec3 {
  const a = (bearingDeg + 90) * DEG;
  return [Math.cos(a) * speed, 0, -Math.sin(a) * speed];
}

test('leads a target moving at constant velocity and hits it', () => {
  // crossing at 4.4 tiles/s (a hunter) 12 tiles out at closest approach, and an oblique run at 2.4 tiles/s
  const a = engage(true, crossing(12, 40, 4.4, -10), crossingVel(40, 4.4));
  assert.equal(a.shots, 8);
  assert.equal(a.hits, 8, `lead: ${a.hits}/8 hits on the crossing target`);
  const b = engage(true, at(22, -30, 0.6), [-1.7, 0, 1.7]);
  assert.equal(b.hits, 8, `lead: ${b.hits}/8 hits on the oblique target`);
  // without lead the same crossing target is missed: the lead is doing the work
  const c = engage(false, crossing(12, 40, 4.4, -10), crossingVel(40, 4.4));
  assert.ok(c.hits <= 2, `no lead still hit ${c.hits}/8`);
});

test('ballistic solution lands on a stationary point', () => {
  const o: Vec3 = [0, 0.9, 0];
  for (const p of [at(5, 0, 0), at(24, 60, 0.3), at(10, -120, 2)] as Vec3[]) {
    const s = solveIntercept(o, p, [0, 0, 0], GUN.speed, GUN.gravity, GUN.barrelLength)!;
    const d: Vec3 = [Math.cos(s.pitch) * Math.cos(s.yaw), Math.sin(s.pitch), -Math.cos(s.pitch) * Math.sin(s.yaw)];
    const m: Vec3 = [o[0] + d[0] * GUN.barrelLength, o[1] + d[1] * GUN.barrelLength, o[2] + d[2] * GUN.barrelLength];
    const hit = shellAt(m, [d[0] * GUN.speed, d[1] * GUN.speed, d[2] * GUN.speed], s.time, GUN.gravity);
    assert.ok(Math.hypot(hit[0] - p[0], hit[1] - p[1], hit[2] - p[2]) < 0.02, `missed by ${Math.hypot(hit[0] - p[0], hit[1] - p[1], hit[2] - p[2])}`);
  }
});

test('recoil kicks back, holds its travel limit, and returns to rest', () => {
  const r = new Recoil();
  assert.ok(r.atRest);
  r.fire();
  let peak = 0;
  let ejects = 0;
  let prev = 0;
  let maxJump = 0;
  for (let i = 0; i < 120; i++) {
    if (r.update(DT)) ejects++;
    assert.ok(r.offset >= 0 && r.offset <= RECOIL.travel + 1e-12, `offset ${r.offset}`);
    peak = Math.max(peak, r.offset);
    maxJump = Math.max(maxJump, Math.abs(r.offset - prev));
    prev = r.offset;
  }
  assert.ok(Math.abs(peak - RECOIL.travel) < 1e-9, `peak ${peak}`);
  assert.equal(ejects, 1);
  assert.ok(r.atRest && r.offset === 0, 'back in battery');
  const cycle = RECOIL.kickTime + RECOIL.holdTime + RECOIL.returnTime;
  // at rest within one tick of the cycle length, no sooner
  const r2 = new Recoil();
  r2.fire();
  let t = 0;
  while (!r2.atRest && t < 5) {
    r2.update(DT);
    t += DT;
  }
  assert.ok(t >= cycle - 1e-9 && t <= cycle + DT + 1e-9, `rest after ${t}s, cycle ${cycle}s`);
  // re-firing mid-return continues from the current offset (no jump)
  const r3 = new Recoil();
  r3.fire();
  for (let i = 0; i < 15; i++) r3.update(DT);
  const before = r3.offset;
  r3.fire();
  r3.update(1e-4);
  assert.ok(Math.abs(r3.offset - before) < 0.01, `jumped from ${before} to ${r3.offset}`);
});

test('idle scan starts when no target is in range, and stops when one enters', () => {
  const b = new TurretBrain([0, 0, 0]);
  b.yaw.angle = 30 * DEG;
  const far = target(1, at(GUN.range + 6, 30, 0.5));
  const yaws: number[] = [];
  let t = 0;
  while (t < IDLE_DELAY - 0.1) {
    b.update(DT, [far]);
    t += DT;
  }
  assert.notEqual(b.mode, 'scan', 'scanned before the idle delay');
  assert.equal(b.shots, 0);
  while (t < IDLE_DELAY + 6) {
    b.update(DT, [far]);
    yaws.push(b.yaw.angle);
    t += DT;
  }
  assert.equal(b.mode, 'scan');
  const swing = Math.max(...yaws) - Math.min(...yaws);
  assert.ok(swing > 30 * DEG, `scan swept only ${(swing / DEG).toFixed(1)}°`);
  for (const y of yaws) assert.ok(Math.abs(wrapPi(y - 30 * DEG)) <= SCAN_AMPLITUDE + 0.5 * DEG, 'scan wandered past its amplitude');
  assert.equal(b.shots, 0, 'fired while scanning');
  // target walks into range: back to tracking and firing
  far.pos = at(15, 80, 0.5);
  for (let i = 0; i < 60 * 4; i++) b.update(DT, [far]);
  assert.equal(b.mode, 'track');
  assert.ok(b.shots > 0, 'did not engage');
});
