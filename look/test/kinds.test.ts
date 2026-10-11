// Unit tests for W22 (src/kit/): the 40 kinds and the parts kit, and the four drawing strategies —
// every part of every kind drawn at the same world transform under A, B, C and D (checked against
// an independent object hierarchy), instance membership after kinds and turrets change, W20's kind
// against W21's batches byte for byte, and the icon cells.
// Run: npm test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BufferGeometry, MeshStandardMaterial, Object3D, Texture, type BufferAttribute } from 'three';
import { DEG } from '../src/bench/aim.ts';
import type { TurretMats } from '../src/bench/surface.ts';
import { buildTurret } from '../src/bench/turretModel.ts';
import { TurretRig } from '../src/bench/turretRig.ts';
import { buildLevels } from '../src/stress/turretLevels.ts';
import { buildMiddle } from '../src/stress/turretMid.ts';
import { tbPieces } from '../src/stress/turretLevels.ts';
import { writeTurret } from '../src/stress/turretPose.ts';
import { cellOffset, ICON_COLS, ICON_ROWS } from '../src/kit/icons.ts';
import { GUN, KIND_TABLE, MAT_KEYS, PINION, PITCH, PIVOTS, STATIC, YAW, assignKinds, buildKit, type Kind } from '../src/kit/kit.ts';
import { writePivots } from '../src/kit/pose.ts';
import { Batched, NaivePerKind, STRATEGIES, createStrategies, type DrawnEntry, type KitRenderer } from '../src/kit/strategies.ts';

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function dummyMats(): TurretMats {
  const m = (name: string) => new MeshStandardMaterial({ name });
  const t = { ceramic: m('ceramic'), gunmetal: m('gunmetal'), bronze: m('bronze'), dark: m('dark'), glow: m('glow'), brass: m('brass') };
  return { ...t, all: Object.values(t) };
}

const mats = dummyMats();
const model = buildTurret(mats);
const simpleRig = new TurretRig(model, mats, 'simple');
const kit = buildKit(mats, model, simpleRig);
const atlas = new Texture();

// ---- the kit ------------------------------------------------------------------------------------------

test('kit: 40 kinds with distinct base/head/weapon, 4 bases, 3 rings, 7 heads, 7 weapons, every part used, shared materials only', () => {
  assert.equal(kit.kinds.length, 40);
  const combos = new Set(kit.kinds.map((k) => `${k.base}/${k.head}/${k.weapon}`));
  assert.equal(combos.size, 40, 'no two kinds share base, head and weapon');
  const fam = (f: string) => kit.parts.filter((p) => p.family === f).length;
  assert.equal(fam('base'), 4);
  assert.equal(fam('ring'), 3);
  assert.equal(fam('head'), 7);
  assert.equal(fam('mount'), 7);
  for (const p of kit.parts) {
    assert.ok(p.usedBy.length > 0, `${p.id} unused`);
    for (const lv of p.levels) for (const k of lv.keys()) assert.ok(MAT_KEYS.includes(k), `${p.id}: material ${k}`);
    assert.ok(p.triangles[0] >= p.triangles[1] && p.triangles[1] >= p.triangles[2], `${p.id}: ${p.triangles.join(' / ')} not decreasing`);
  }
  assert.deepEqual(KIND_TABLE[0]!.slice(2), ['octagon', 'toothed', 'cheek', 'long']);
  assert.deepEqual(kit.kinds[0]!.triangles.slice(0, 3), [22640, 2628, 212], "W20's kind keeps W20/W21's triangle counts");
});

test('assignKinds spreads any count evenly over the kinds', () => {
  for (const n of [100, 300, 500]) {
    const a = assignKinds(n, 40);
    const c = new Array(40).fill(0);
    for (const k of a) c[k]++;
    assert.ok(Math.max(...c) - Math.min(...c) <= 1, `${n}: ${Math.min(...c)}–${Math.max(...c)} per kind`);
  }
  assert.ok(assignKinds(300, 1).every((k) => k === 0));
});

// ---- W20's kind against W21 ------------------------------------------------------------------------------

function sameBytes(a: BufferGeometry, b: BufferGeometry, what: string): void {
  const names = Object.keys(a.attributes).sort();
  assert.deepEqual(names, Object.keys(b.attributes).sort(), `${what}: attributes`);
  for (const n of names) {
    const x = (a.getAttribute(n) as BufferAttribute).array as Float32Array;
    const y = (b.getAttribute(n) as BufferAttribute).array as Float32Array;
    assert.equal(x.length, y.length, `${what}: ${n} length`);
    assert.ok(Buffer.from(x.buffer, x.byteOffset, x.byteLength).equals(Buffer.from(y.buffer, y.byteOffset, y.byteLength)), `${what}: ${n} bytes differ`);
  }
  assert.equal(a.index, null);
  assert.equal(b.index, null);
}

test("W20's kind is W21's geometry byte for byte (full and simple batches; middle parts)", () => {
  const w21 = buildLevels(model, mats, new TurretRig(model, mats, 'simple')).levels;
  const a = new NaivePerKind(kit, atlas);
  const slotPivot: Record<string, number> = { base: STATIC, pinion: PINION, yaw: YAW, cradle: PITCH, barrel: GUN };
  for (const lv of [0, 2]) {
    for (const b of w21[lv]!.batches) {
      const g = a.batchGeometry(0, lv, slotPivot[b.slot]!, b.key as never);
      assert.ok(g, `level ${lv}: no A batch for W21 ${b.slot}/${b.key}`);
      sameBytes(g!, b.geometry, `level ${lv} ${b.slot}/${b.key}`);
    }
    const n = kit.kinds[0]!.placed.reduce((s, pl) => s + pl.part.levels[lv]!.size, 0);
    assert.ok(n >= w21[lv]!.batches.length);
  }
  const mid = buildMiddle();
  const byPart: Record<string, ReturnType<typeof tbPieces>> = {
    'base/octagon': tbPieces(mid.base, mats),
    'pinion/w20': tbPieces(mid.pinion, mats),
    'ring/toothed': tbPieces(mid.ring, mats),
    'head/cheek': tbPieces(mid.head, mats),
    'mount/long': tbPieces(mid.cradle, mats),
    'gun/long': tbPieces(mid.barrel, mats),
  };
  for (const pl of kit.kinds[0]!.placed) {
    const ref = byPart[pl.part.id]!;
    assert.deepEqual([...pl.part.levels[1].keys()], [...ref.keys()], `${pl.part.id}: middle materials`);
    for (const [k, v] of ref) sameBytes(pl.part.levels[1].get(k as never)!, v.geometry, `middle ${pl.part.id}/${k}`);
    assert.deepEqual(pl.off, [0, 0, 0], `${pl.part.id} sits where W20 put it`);
  }
});

test("W20's kind: pivot matrices equal W21's part matrices", () => {
  const rnd = lcg(5);
  const piv = new Float32Array(PIVOTS * 16);
  const w21 = { base: new Float32Array(16), pinion: new Float32Array(16), yaw: new Float32Array(16), cradle: new Float32Array(16), barrel: new Float32Array(16) };
  const frame = { pinionAt: model.pinionAt, pinionRatio: model.pinionRatio, trunnionY: model.trunnionY };
  for (let i = 0; i < 200; i++) {
    const [x, y, z, yaw, pitch, rec] = [(rnd() - 0.5) * 100, rnd(), (rnd() - 0.5) * 100, (rnd() - 0.5) * 12, (rnd() * 50 - 5) * DEG, rnd() * 0.16];
    writePivots(piv, kit.kinds[0]!.frame, x, y, z, yaw, pitch, rec, 0);
    writeTurret(w21, 0, frame, x, y, z, yaw, pitch, rec);
    for (const [name, pv] of [
      ['base', STATIC],
      ['pinion', PINION],
      ['yaw', YAW],
      ['cradle', PITCH],
      ['barrel', GUN],
    ] as const)
      for (let k = 0; k < 16; k++) assert.equal(piv[pv * 16 + k], w21[name][k], `${name}[${k}]`);
  }
});

// ---- strategies: transforms and membership ----------------------------------------------------------------

interface Turret {
  i: number;
  kind: Kind;
  level: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  recoil: number;
  spin: number;
  icon: number;
}

/** Reference: an object hierarchy per turret (independent of pose.ts), world matrix per part. */
function reference(t: Turret): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const f = t.kind.frame;
  const root = new Object3D();
  root.position.set(t.x, t.y, t.z);
  if (t.level === 3) {
    const icon = new Object3D();
    icon.position.y = 0.4;
    icon.rotation.y = t.yaw;
    icon.scale.setScalar(t.icon);
    root.add(icon);
    root.updateMatrixWorld(true);
    out.set(`${t.i}|icon|icon`, icon.matrixWorld.elements);
    return out;
  }
  const yawG = new Object3D();
  yawG.rotation.y = t.yaw;
  const pinion = new Object3D();
  pinion.position.set(...f.pinionAt);
  if (t.level === 0) pinion.rotation.y = -t.yaw * f.pinionRatio;
  const cradle = new Object3D();
  cradle.position.y = f.trunnionY;
  cradle.rotation.z = t.pitch;
  const slide = new Object3D();
  slide.position.x = -t.recoil * f.recoilScale;
  slide.rotation.x = t.spin;
  root.add(yawG, pinion);
  yawG.add(cradle);
  cradle.add(slide);
  const nodes: Object3D[] = [];
  for (const pl of t.kind.placed) {
    const n = new Object3D();
    const fam = pl.part.family;
    const parent = fam === 'base' ? root : fam === 'pinion' ? pinion : fam === 'ring' ? (t.level === 0 ? yawG : root) : fam === 'head' ? yawG : fam === 'mount' ? cradle : slide;
    if (fam === 'ring' || fam === 'head') n.position.y = pl.off[1];
    parent.add(n);
    nodes.push(n);
  }
  root.updateMatrixWorld(true);
  t.kind.placed.forEach((pl, k) => {
    for (const key of pl.part.levels[t.level]!.keys()) out.set(`${t.i}|${pl.part.id}|${key}`, nodes[k]!.matrixWorld.elements);
  });
  return out;
}

function frameOf(n: number, kinds: number, seed: number): Turret[] {
  const rnd = lcg(seed);
  const assign = assignKinds(n, kinds, seed);
  return Array.from({ length: n }, (_, i) => ({
    i,
    kind: kit.kinds[assign[i]!]!,
    level: Math.floor(rnd() * 4),
    x: (rnd() - 0.5) * 200,
    y: (rnd() - 0.5) * 4,
    z: (rnd() - 0.5) * 200,
    yaw: (rnd() - 0.5) * 4 * Math.PI,
    pitch: (-5 + rnd() * 50) * DEG,
    recoil: rnd() * 0.16,
    spin: rnd() * 20,
    icon: 1 + rnd() * 3,
  }));
}

function draw(r: KitRenderer, ts: Turret[]): Map<string, DrawnEntry> {
  r.begin();
  for (const t of ts) r.push(t.i, t.kind, t.level, t.x, t.y, t.z, t.yaw, t.pitch, t.recoil, t.spin, 5, t.icon);
  r.commit();
  const out = new Map<string, DrawnEntry>();
  for (const e of r.drawn()) {
    const key = `${e.turret}|${e.part}|${e.mat}`;
    assert.ok(!out.has(key), `${r.id}: ${key} drawn twice`);
    out.set(key, e);
  }
  return out;
}

function check(r: KitRenderer, ts: Turret[], what: string): number {
  const got = draw(r, ts);
  const want = new Map<string, number[]>();
  for (const t of ts) for (const [k, v] of reference(t)) want.set(k, v);
  const missing = [...want.keys()].filter((k) => !got.has(k));
  const extra = [...got.keys()].filter((k) => !want.has(k));
  assert.deepEqual(missing.slice(0, 5), [], `${r.id} ${what}: ${missing.length} part instances missing`);
  assert.deepEqual(extra.slice(0, 5), [], `${r.id} ${what}: ${extra.length} stale or extra part instances`);
  let worst = 0;
  for (const [k, m] of want) {
    const e = got.get(k)!;
    for (let j = 0; j < 16; j++) worst = Math.max(worst, Math.abs(e.m[j]! - m[j]!));
    if (e.part === 'icon') {
      const t = ts[Number(k.split('|')[0])]!;
      const [u, v] = cellOffset(t.kind.icon);
      assert.ok(Math.abs(e.iconUv![0] - u) < 1e-6 && Math.abs(e.iconUv![1] - v) < 1e-6, `${r.id}: turret ${t.i} (${t.kind.name}) icon cell ${e.iconUv} ≠ ${t.kind.icon}`);
    }
  }
  assert.ok(worst < 1e-4, `${r.id} ${what}: matrices differ by ${worst.toExponential(2)}`);
  return want.size;
}

test('A–D draw every part of every kind at the same world transform for random poses (1e-4)', () => {
  const st = createStrategies(kit, atlas, 500);
  const ts = frameOf(400, 40, 11);
  for (const id of STRATEGIES) {
    const n = check(st[id], ts, '400 turrets × 40 kinds');
    assert.ok(n > 3000, `only ${n} part instances checked`);
  }
});

test('per-instance part → batch membership stays right when kinds and turrets are added and removed', () => {
  const st = createStrategies(kit, atlas, 500);
  const frames: Array<[string, Turret[]]> = [
    ['300 × 40 kinds', frameOf(300, 40, 1)],
    ['120 × 40 kinds (180 removed, levels changed)', frameOf(120, 40, 2)],
    ['300 × 1 kind', frameOf(300, 1, 3)],
    ['500 × 40 kinds', frameOf(500, 40, 4)],
    ['60 × 40 kinds, one level', frameOf(60, 40, 5).map((t) => ({ ...t, level: 1 }))],
    ['0 turrets', []],
    ['200 × 40 kinds', frameOf(200, 40, 6)],
  ];
  for (const id of STRATEGIES) for (const [what, ts] of frames) check(st[id], ts, what);
  // BatchedMesh: slots past the frame's count are hidden, so nothing stale is drawn
  const d = st.D as Batched;
  draw(d, frames[1]![1]);
  for (const s of d.visibleSlots()) assert.equal(s.visible, s.count, `${s.name}: ${s.visible} visible slots for ${s.count} instances`);
});

test('icons: one shape per base outline × weapon glyph, index maps to that shape, cells inside the atlas', () => {
  const outline = { octagon: 'circle', bunker: 'square', drum: 'ring', pylon: 'triangle' } as const;
  const glyph = { long: 'bar', twin: 'twin', howitzer: 'stub', rotary: 'rotary', missiles: 'pod', beam: 'lens', flak: 'quad' } as const;
  const seen = new Set<string>();
  kit.icons.forEach((s) => {
    const k = `${s.outline}/${s.glyph}`;
    assert.ok(!seen.has(k), `icon ${k} twice`);
    seen.add(k);
  });
  assert.ok(kit.icons.length <= ICON_COLS * ICON_ROWS);
  for (const k of kit.kinds) assert.deepEqual(kit.icons[k.icon], { outline: outline[k.base], glyph: glyph[k.weapon] }, k.name);
  assert.deepEqual(kit.icons[kit.kinds[0]!.icon], { outline: 'circle', glyph: 'bar' }, "W20's icon: round body, barrel bar");
  // every strategy draws a turret's icon from its kind's cell (checked per instance in check())
  const st = createStrategies(kit, atlas, 500);
  const ts = frameOf(160, 40, 9).map((t) => ({ ...t, level: 3 }));
  for (const id of STRATEGIES) check(st[id], ts, 'icons only');
});

test('draw calls at middle detail, 300 turrets × 40 kinds: A per kind, B per part, C per base × ring pair for the static parts, D per material', () => {
  const st = createStrategies(kit, atlas, 500);
  const ts = frameOf(300, 40, 21).map((t) => ({ ...t, level: 1 }));
  const calls: Record<string, number> = {};
  for (const id of STRATEGIES) {
    draw(st[id], ts);
    calls[id] = st[id].drawCalls;
  }
  // B: one batch per (part, material) of the parts in view
  const pairs = new Set<string>();
  for (const t of ts) for (const pl of t.kind.placed) for (const k of pl.part.levels[1].keys()) pairs.add(`${pl.part.id}/${k}`);
  assert.equal(calls.B, pairs.size, 'B');
  assert.ok(calls.A! > 4 * calls.B!, JSON.stringify(calls));
  assert.ok(calls.D! <= MAT_KEYS.length, `D: ${calls.D}`);
  // C merges base + pinion + ring per base × ring pair: 12 pairs in use outnumber 4 bases + 3 rings + pinion
  assert.ok(calls.C! > calls.B!, JSON.stringify(calls));
});
