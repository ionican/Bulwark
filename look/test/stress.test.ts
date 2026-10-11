// Unit tests for the W21 turret stress test (src/stress/): the typed-array fire control against
// W20's per-object TurretBrain and Recoil, the instanced part matrices against W20's object
// hierarchy, detail-level hysteresis, and the effect pools' caps.
// Run: npm test (node:test; TypeScript through node's --experimental-transform-types).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstancedMesh, Matrix4, MeshStandardMaterial, Vector3, type BufferAttribute, type BufferGeometry, type Mesh } from 'three';
import { DEG } from '../src/bench/aim.ts';
import { TurretBrain, type BrainTarget } from '../src/bench/brain.ts';
import { Recoil } from '../src/bench/recoil.ts';
import type { TurretMats } from '../src/bench/surface.ts';
import { buildTurret } from '../src/bench/turretModel.ts';
import { TurretRig } from '../src/bench/turretRig.ts';
import { AlienGrid, MODE_NAMES, TurretBank, alienView, type ShotRecord } from '../src/stress/fireControl.ts';
import { HYSTERESIS, LEVEL_NEW, STRESS_THRESHOLDS, chooseLevel } from '../src/stress/lod.ts';
import { writeTurret, writeYaw } from '../src/stress/turretPose.ts';
import { buildLevels, type LevelDef } from '../src/stress/turretLevels.ts';
import { CASING_CAP, CasingPool, LIGHT_CAP, LightPool, SHELL_CAP, ShellPool } from '../src/stress/effects.ts';
import { WRECK_CAP, Wrecks } from '../src/stress/aliens.ts';

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---- fire control --------------------------------------------------------------------------------

interface Mover {
  slot: number;
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  alive: boolean;
  legLeft: number;
}

/**
 * A deterministic engagement: 7 turrets, 24 aliens walking legs of constant velocity (direction
 * changes every 1–3 s), some destroyed and their slots reused with new ids, lead switched off for
 * a while. Both implementations get the same inputs every tick; `dts` cycles through the step
 * sizes (the stress page updates distant turrets every 2nd or 4th frame with the summed dt).
 */
function engagement(dts: number[], useGrid: boolean, ticks: number) {
  const rnd = lcg(91);
  const turretPos: Array<[number, number, number]> = [
    [0, 0, 0],
    [5, 0.2, -3],
    [-6, 0, 4],
    [12, -0.1, 8],
    [-14, 0.3, -10],
    [2, 0, 15],
    [20, 0, -18],
  ];
  const brains = turretPos.map((p, i) => {
    const b = new TurretBrain(p);
    b.yaw.angle = (i * 47 - 120) * DEG;
    return b;
  });
  const recoils = turretPos.map(() => new Recoil());
  const bank = new TurretBank(turretPos.length);
  turretPos.forEach((p, i) => bank.init(i, p[0], p[1], p[2], brains[i]!.yaw.angle));
  bank.n = turretPos.length;
  const view = alienView(32);
  const grid = new AlienGrid(32);
  let nextId = 1;
  const movers: Mover[] = [];
  const spawn = (slot: number) => {
    const a = rnd() * Math.PI * 2;
    const r = 18 + rnd() * 26;
    const m: Mover = { slot, id: nextId++, x: Math.cos(a) * r, y: rnd() * 1.5 - 0.5, z: Math.sin(a) * r, vx: 0, vz: 0, alive: true, legLeft: 0 };
    movers[slot] = m;
  };
  for (let s = 0; s < 24; s++) spawn(s);
  const res = { shot: null as ShotRecord | null, eject: false };
  let shots = 0;
  let compared = 0;
  let tracked = 0;
  let scanned = 0;
  for (let k = 0; k < ticks; k++) {
    const dt = dts[k % dts.length]!;
    // aliens: new leg every 1–3 s, towards the middle with some sideways drift
    for (const m of movers) {
      if (!m.alive) continue;
      m.legLeft -= dt;
      if (m.legLeft <= 0) {
        const speed = 0.9 + rnd() * 3.5;
        const toward = Math.atan2(-m.z, -m.x) + (rnd() - 0.5) * 2.2;
        m.vx = Math.cos(toward) * speed;
        m.vz = Math.sin(toward) * speed;
        m.legLeft = 1 + rnd() * 2;
      }
      m.x += m.vx * dt;
      m.z += m.vz * dt;
    }
    // occasional destruction and respawn in the same slot with a new id
    if (k % 37 === 11) {
      const m = movers[Math.floor(rnd() * movers.length)]!;
      m.alive = false;
    }
    if (k % 53 === 29 && (k < 1400 || k > 1700)) {
      const dead = movers.find((m) => !m.alive);
      if (dead) spawn(dead.slot);
    }
    // a lull: every alien gone for 5 s (idle, then the scan), then a fresh wave from all sides
    if (k === 1400) for (const m of movers) m.alive = false;
    if (k === 1700) for (const m of movers) spawn(m.slot);
    for (const m of movers) {
      view.id[m.slot] = m.id;
      view.alive[m.slot] = m.alive ? 1 : 0;
      view.ax[m.slot] = m.x;
      view.ay[m.slot] = m.y;
      view.az[m.slot] = m.z;
      view.vx[m.slot] = m.vx;
      view.vy[m.slot] = 0;
      view.vz[m.slot] = m.vz;
      view.radius[m.slot] = 0.45;
    }
    grid.build(view);
    const lead = !(k > 600 && k < 900);
    bank.lead = lead;
    // W20 sees the alive aliens in slot order, fresh objects every tick (as targets.brainTargets())
    const list: BrainTarget[] = movers.filter((m) => m.alive).sort((a, b) => a.slot - b.slot).map((m) => ({ id: m.id, pos: [m.x, m.y, m.z], vel: [m.vx, 0, m.vz], alive: true, radius: 0.45 }));
    for (let i = 0; i < brains.length; i++) {
      const b = brains[i]!;
      b.lead = lead;
      const out = b.update(dt, list);
      const eject = recoils[i]!.update(dt);
      for (const _ of out) recoils[i]!.fire();
      bank.update(i, dt, view, useGrid ? grid : null, res);
      const where = `tick ${k}, turret ${i}`;
      assert.equal(bank.yaw[i], b.yaw.angle, `yaw ${where}`);
      assert.equal(bank.yawRate[i], b.yaw.rate, `yaw rate ${where}`);
      assert.equal(bank.pitch[i], b.pitch.angle, `pitch ${where}`);
      assert.equal(bank.pitchRate[i], b.pitch.rate, `pitch rate ${where}`);
      assert.equal(bank.wantYaw[i], b.wantYaw, `wanted yaw ${where}`);
      assert.equal(bank.wantPitch[i], b.wantPitch, `wanted pitch ${where}`);
      assert.equal(MODE_NAMES[bank.mode[i]!], b.mode, `mode ${where}`);
      assert.equal(bank.tgtSlot[i]! >= 0 ? bank.tgtId[i] : null, b.target ? b.target.id : null, `target ${where}`);
      assert.equal(bank.cooldown[i], b.cooldown, `cooldown ${where}`);
      assert.equal(res.shot ? 1 : 0, out.length, `fired ${where}`);
      if (res.shot) {
        assert.deepEqual(res.shot.from, out[0]!.from, `muzzle ${where}`);
        assert.deepEqual(res.shot.vel, out[0]!.vel, `shell velocity ${where}`);
        assert.equal(res.shot.targetId, out[0]!.targetId ?? -1, `shot target ${where}`);
        assert.equal(res.shot.time, out[0]!.time, `flight time ${where}`);
        shots++;
      }
      assert.equal(res.eject, eject, `casing ejected ${where}`);
      assert.equal(bank.rOff[i], recoils[i]!.offset, `recoil ${where}`);
      assert.equal(bank.pulse(i), recoils[i]!.pulse, `slit pulse ${where}`);
      if (b.mode === 'track') tracked++;
      if (b.mode === 'scan') scanned++;
      compared++;
    }
  }
  return { shots, compared, tracked, scanned };
}

test('typed-array fire control matches W20 TurretBrain + Recoil exactly over a deterministic engagement (grid search)', () => {
  const r = engagement([1 / 60], true, 2400);
  // the run must actually exercise tracking, firing and scanning, or the comparison proves little
  assert.ok(r.shots > 100, `only ${r.shots} shots`);
  assert.ok(r.tracked > 1000, `only ${r.tracked} tracking ticks`);
  assert.ok(r.scanned > 50, `only ${r.scanned} scanning ticks`);
});

test('fire control matches with uneven steps (2nd- and 4th-frame updates) and without the grid', () => {
  const a = engagement([1 / 60, 1 / 30, 1 / 15, 1 / 60, 0.05], true, 1500);
  const b = engagement([1 / 60, 1 / 30, 1 / 15, 1 / 60, 0.05], false, 1500);
  assert.ok(a.shots > 50 && a.shots === b.shots, `grid ${a.shots} shots, linear scan ${b.shots}`);
});

// ---- part matrices ---------------------------------------------------------------------------------

function dummyMats(): TurretMats {
  const m = (name: string) => new MeshStandardMaterial({ name });
  const t = { ceramic: m('ceramic'), gunmetal: m('gunmetal'), bronze: m('bronze'), dark: m('dark'), glow: m('glow'), brass: m('brass') };
  return { ...t, all: Object.values(t) };
}

const mats = dummyMats();
const model = buildTurret(mats);
const frame = { pinionAt: model.pinionAt, pinionRatio: model.pinionRatio, trunnionY: model.trunnionY };

function maxDiff(a: ArrayLike<number>, ao: number, b: ArrayLike<number>): number {
  let d = 0;
  for (let k = 0; k < 16; k++) d = Math.max(d, Math.abs(a[ao + k]! - b[k]!));
  return d;
}

test('per-instance part matrices equal W20 hierarchy world matrices for random yaw/pitch/recoil (1e-4)', () => {
  const rig = new TurretRig(model, mats);
  const rnd = lcg(7);
  const out = { base: new Float32Array(16), pinion: new Float32Array(16), yaw: new Float32Array(16), cradle: new Float32Array(16), barrel: new Float32Array(16) };
  const icon = new Float32Array(16);
  for (let k = 0; k < 500; k++) {
    const x = (rnd() - 0.5) * 200;
    const y = (rnd() - 0.5) * 4;
    const z = (rnd() - 0.5) * 200;
    const yaw = (rnd() - 0.5) * 4 * Math.PI;
    const pitch = (-5 + rnd() * 50) * DEG;
    const recoil = rnd() * 0.16;
    rig.root.position.set(x, y, z);
    rig.setPose(yaw, pitch, recoil);
    const wpp = rnd() * 0.5;
    rig.updateIcon(wpp);
    rig.root.updateMatrixWorld(true);
    writeTurret(out, 0, frame, x, y, z, yaw, pitch, recoil);
    for (const lvl of [rig.levels.full, rig.levels.simple]) {
      const pairs: Array<[string, Float32Array, Matrix4]> = [
        ['base', out.base, lvl.group.matrixWorld],
        ['yaw', out.yaw, lvl.yaw.matrixWorld],
        ['cradle', out.cradle, lvl.cradle.matrixWorld],
        ['barrel', out.barrel, lvl.slide.matrixWorld],
      ];
      if (lvl.pinion) pairs.push(['pinion', out.pinion, lvl.pinion.matrixWorld]);
      for (const [name, a, m] of pairs) {
        const d = maxDiff(a, 0, m.elements);
        assert.ok(d < 1e-4, `${name}: ${d.toExponential(2)} at yaw ${(yaw / DEG).toFixed(1)}°, pitch ${(pitch / DEG).toFixed(1)}°, recoil ${recoil.toFixed(3)}`);
      }
    }
    writeYaw(icon, 0, x, y + 0.4, z, yaw, Math.max(1, 9 * wpp));
    assert.ok(maxDiff(icon, 0, rig.icon.matrixWorld.elements) < 1e-4, 'icon');
  }
});

/** World-space vertex count and centroid of W20's full level as posed (bolts through their instances). */
function w20Vertices(rig: TurretRig): { n: number; c: Vector3 } {
  const c = new Vector3();
  const v = new Vector3();
  const mi = new Matrix4();
  let n = 0;
  for (const mesh of rig.levels.full.meshes as Mesh[]) {
    const p = mesh.geometry.getAttribute('position') as BufferAttribute;
    const inst = mesh instanceof InstancedMesh ? mesh.count : 1;
    for (let k = 0; k < inst; k++) {
      if (mesh instanceof InstancedMesh) mesh.getMatrixAt(k, mi);
      else mi.identity();
      mi.premultiply(mesh.matrixWorld);
      for (let i = 0; i < p.count; i++) {
        c.add(v.fromBufferAttribute(p, i).applyMatrix4(mi));
        n++;
      }
    }
  }
  return { n, c: c.divideScalar(n) };
}

function levelVertices(level: LevelDef, mats16: Record<string, Float32Array>): { n: number; c: Vector3 } {
  const c = new Vector3();
  const v = new Vector3();
  const m = new Matrix4();
  let n = 0;
  for (const b of level.batches) {
    m.fromArray(mats16[b.slot]!);
    const p = (b.geometry as BufferGeometry).getAttribute('position') as BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      c.add(v.fromBufferAttribute(p, i).applyMatrix4(m));
      n++;
    }
  }
  return { n, c: c.divideScalar(n) };
}

test('full instanced level holds every W20 vertex (bolts included) in the same place; middle level is 2,000–4,000 triangles', () => {
  const simpleRig = new TurretRig(model, mats, 'simple');
  const { levels } = buildLevels(model, mats, simpleRig);
  const rig = new TurretRig(model, mats);
  const w20Tris = rig.triangles.full;
  assert.equal(levels[0]!.triangles, w20Tris, 'full level triangles = W20 full (22,640 with bolts)');
  assert.equal(levels[2]!.triangles, rig.triangles.simple, 'simple level = W20 simple');
  assert.equal(levels[3]!.triangles, rig.triangles.icon, 'icon = W20 icon');
  assert.ok(levels[1]!.triangles >= 2000 && levels[1]!.triangles <= 4000, `middle ${levels[1]!.triangles} triangles`);
  const rnd = lcg(3);
  const out = { base: new Float32Array(16), pinion: new Float32Array(16), yaw: new Float32Array(16), cradle: new Float32Array(16), barrel: new Float32Array(16) };
  for (let k = 0; k < 6; k++) {
    const x = (rnd() - 0.5) * 100;
    const z = (rnd() - 0.5) * 100;
    const yaw = rnd() * 6.28;
    const pitch = (-5 + rnd() * 50) * DEG;
    const recoil = rnd() * 0.16;
    rig.root.position.set(x, 0.2, z);
    rig.setPose(yaw, pitch, recoil);
    rig.root.updateMatrixWorld(true);
    writeTurret(out, 0, frame, x, 0.2, z, yaw, pitch, recoil);
    const a = w20Vertices(rig);
    const b = levelVertices(levels[0]!, out);
    assert.equal(b.n, a.n, 'vertex count');
    assert.ok(a.c.distanceTo(b.c) < 1e-4, `centroid differs by ${a.c.distanceTo(b.c).toExponential(2)}`);
  }
});

// ---- detail levels ------------------------------------------------------------------------------------

test('detail level: plain thresholds for a new turret, hysteresis band holds the level, no flapping', () => {
  const T = STRESS_THRESHOLDS;
  assert.equal(chooseLevel(LEVEL_NEW, 10), 0);
  assert.equal(chooseLevel(LEVEL_NEW, 50), 1);
  assert.equal(chooseLevel(LEVEL_NEW, 100), 2);
  assert.equal(chooseLevel(LEVEL_NEW, 400), 3);
  for (let t = 0; t < T.length; t++) {
    const th = T[t]!;
    // starting either side, distances jittering within the band never change the level
    for (const startFiner of [true, false]) {
      let l = startFiner ? t : t + 1;
      const rnd = lcg(t * 2 + (startFiner ? 1 : 0));
      let changes = 0;
      for (let k = 0; k < 5000; k++) {
        const d = th * (1 + (rnd() * 2 - 1) * HYSTERESIS * 0.98);
        const n = chooseLevel(l, d);
        if (n !== l) changes++;
        l = n;
      }
      assert.equal(changes, 0, `threshold ${th}: level changed ${changes} times inside the band`);
    }
    // crossing the band each way switches exactly once
    let l = t;
    let switches = 0;
    for (let d = th * 0.8; d <= th * 1.2; d += th * 0.001) {
      const n = chooseLevel(l, d);
      if (n !== l) switches++;
      l = n;
    }
    assert.equal(l, t + 1);
    assert.equal(switches, 1);
    for (let d = th * 1.2; d >= th * 0.8; d -= th * 0.001) {
      const n = chooseLevel(l, d);
      if (n !== l) switches++;
      l = n;
    }
    assert.equal(l, t);
    assert.equal(switches, 2);
  }
  // a zoom straight out passes through every level in order
  let l = LEVEL_NEW;
  const seen: number[] = [];
  for (let d = 5; d < 300; d += 0.5) {
    l = chooseLevel(l, d);
    if (seen[seen.length - 1] !== l) seen.push(l);
  }
  assert.deepEqual(seen, [0, 1, 2, 3]);
});

// ---- effect pools -----------------------------------------------------------------------------------------

test('effect pools never exceed their caps', () => {
  const rnd = lcg(5);
  const shells = new ShellPool();
  const view = alienView(4);
  const grid = new AlienGrid(4);
  grid.build(view);
  let maxShells = 0;
  for (let k = 0; k < 400; k++) {
    for (let j = 0; j < 40; j++) shells.fire(rnd() * 10, 1, rnd() * 10, rnd() * 50, rnd() * 5, rnd() * 50);
    shells.update(1 / 60, view, grid, () => -1e9, () => {});
    maxShells = Math.max(maxShells, shells.n);
    assert.ok(shells.n <= SHELL_CAP, `shells ${shells.n}`);
  }
  assert.equal(maxShells, SHELL_CAP, 'the shell pool fills to its cap');
  assert.ok(shells.reused > 0);

  const casings = new CasingPool();
  const at = new Vector3();
  const out = new Vector3(0, 0, 1);
  const dir = new Vector3(1, 0, 0);
  for (let k = 0; k < 3000; k++) {
    casings.eject(at, out, dir, rnd);
    if (k % 7 === 0) casings.update(1 / 60, () => 0);
    assert.ok(casings.n <= CASING_CAP, `casings ${casings.n}`);
  }
  for (let k = 0; k < 600; k++) casings.update(1 / 60, () => 0);
  assert.equal(casings.n, 0, 'casings expire');

  const wrecks = new Wrecks();
  for (let k = 0; k < 1000; k++) {
    wrecks.add(k, 0, k, 1, 0);
    if (k % 3 === 0) wrecks.update(0.05, () => {});
    assert.ok(wrecks.count <= WRECK_CAP, `wrecks ${wrecks.count}`);
  }

  const lights = new LightPool();
  for (let k = 0; k < 500; k++) {
    lights.flash(k, 0, 0);
    lights.update(0.004);
    assert.ok(lights.active <= LIGHT_CAP);
  }
  assert.equal(lights.lights.length, LIGHT_CAP);
});

test('particle pools stop at their caps', async () => {
  // Particles builds its puff atlas on an OffscreenCanvas; node has none, so stand one in
  const g = globalThis as Record<string, unknown>;
  g.ImageData ??= class {
    data: Uint8ClampedArray;
    constructor(
      readonly width: number,
      readonly height: number,
    ) {
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };
  g.OffscreenCanvas ??= class {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    getContext() {
      return { putImageData() {} };
    }
  };
  const { Particles, PType } = await import('../src/fx/particles.ts');
  const { PARTICLE_CAPS } = await import('../src/stress/effects.ts');
  const fx = new Particles(PARTICLE_CAPS);
  for (let k = 0; k < 20000; k++) {
    fx.spawn({ type: k % 2 ? PType.Smoke : PType.Flash, x: 0, y: 0, z: 0, life: 10, s0: 1, s1: 1, r: 1, g: 1, b: 1, a: 1 });
    fx.explosion(0, 0, 0, 1);
  }
  const u = fx.usage;
  assert.equal(u.smoke, PARTICLE_CAPS.smoke);
  assert.equal(u.glow, PARTICLE_CAPS.glow);
});
