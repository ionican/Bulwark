// W23 walls: autotiling, joins, depth infill, tiers, gates and doors (src/w23/walls/).
// Run: npm test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Vector3, type BufferAttribute, type BufferGeometry } from 'three';
import { WallGrid, maskOf, pieceFor, type Piece } from '../src/w23/walls/grid.ts';
import { HALF, TIERS, summarise, tileInfo, tileInstances, wallInstances, type WallInst } from '../src/w23/walls/layout.ts';
import { wallBuilders, wallMatrix } from '../src/w23/walls/geometry.ts';
import { GateDoor, opensGates } from '../src/w23/walls/gate.ts';
import { PartSet } from '../src/w23/parts.ts';

// ---- autotiling ------------------------------------------------------------------------------------

test('every 4-neighbour mask maps to the right piece and rotation (E=1, S=2, W=4, N=8)', () => {
  const expected: Array<[number, Piece, number]> = [
    [0b0000, 'post', 0],
    [0b0001, 'end', 0], // arm E
    [0b0010, 'end', 1], // arm S
    [0b0100, 'end', 2], // arm W
    [0b1000, 'end', 3], // arm N
    [0b0101, 'straight', 0], // E–W
    [0b1010, 'straight', 1], // N–S
    [0b0011, 'corner', 0], // E+S
    [0b0110, 'corner', 1], // S+W
    [0b1100, 'corner', 2], // W+N
    [0b1001, 'corner', 3], // N+E
    [0b0111, 'tee', 0], // open N
    [0b1110, 'tee', 1], // open E
    [0b1101, 'tee', 2], // open S
    [0b1011, 'tee', 3], // open W
    [0b1111, 'cross', 0],
  ];
  assert.equal(expected.length, 16);
  for (const [mask, piece, rot] of expected) {
    assert.deepEqual(pieceFor(mask), { piece, rot }, `mask ${mask.toString(2).padStart(4, '0')}`);
    assert.equal(maskOf(piece, rot), mask, `${piece} rot ${rot} arms`);
  }
});

test('the grid reports each tile’s mask from its neighbours', () => {
  const g = new WallGrid(9, 9);
  // a plus sign: centre (4,4) with arms
  for (const [x, z] of [[4, 4], [5, 4], [3, 4], [4, 5], [4, 3]]) g.set(x!, z!, 1);
  assert.deepEqual(pieceFor(g.mask(4, 4)), { piece: 'cross', rot: 0 });
  assert.deepEqual(pieceFor(g.mask(5, 4)), { piece: 'end', rot: 2 }, 'east arm ends, its neighbour is to the west');
  assert.deepEqual(pieceFor(g.mask(4, 3)), { piece: 'end', rot: 1 }, 'north arm ends, its neighbour is to the south');
});

// ---- geometry helpers ------------------------------------------------------------------------------

const parts = new PartSet();
for (const [id, fn] of wallBuilders()) parts.add(id, id.startsWith('gate') ? 'gate' : 'wall', fn);

interface WorldPiece {
  tile: [number, number];
  part: string;
  mat: string;
  pos: Float32Array;
}

/** Full-detail geometry of the given instances, placed in the world (tile centres at .5). */
function world(list: WallInst[]): WorldPiece[] {
  const out: WorldPiece[] = [];
  const m = new Matrix4();
  const v = new Vector3();
  for (const i of list) {
    wallMatrix(m, i.x + 0.5, 0, i.z + 0.5, i.rot, i.off);
    for (const [mat, geo] of parts.get(i.part).levels[0]) {
      const p = (geo as BufferGeometry).getAttribute('position') as BufferAttribute;
      const pos = new Float32Array(p.count * 3);
      for (let k = 0; k < p.count; k++) {
        v.fromBufferAttribute(p, k).applyMatrix4(m);
        pos[k * 3] = v.x;
        pos[k * 3 + 1] = v.y;
        pos[k * 3 + 2] = v.z;
      }
      out.push({ tile: [i.x, i.z], part: i.part, mat, pos });
    }
  }
  return out;
}

/** Bounding box (y, z) per material of the vertices lying on the plane x = px. */
function sectionX(pieces: WorldPiece[], px: number): Map<string, [number, number, number, number]> {
  const out = new Map<string, [number, number, number, number]>();
  for (const pc of pieces) {
    for (let k = 0; k < pc.pos.length; k += 3) {
      if (Math.abs(pc.pos[k]! - px) > 1e-5) continue;
      const y = pc.pos[k + 1]!;
      const z = pc.pos[k + 2]!;
      const b = out.get(pc.mat) ?? [Infinity, -Infinity, Infinity, -Infinity];
      out.set(pc.mat, [Math.min(b[0], y), Math.max(b[1], y), Math.min(b[2], z), Math.max(b[3], z)]);
    }
  }
  return out;
}

function extentX(pieces: WorldPiece[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const pc of pieces) for (let k = 0; k < pc.pos.length; k += 3) {
    lo = Math.min(lo, pc.pos[k]!);
    hi = Math.max(hi, pc.pos[k]!);
  }
  return [lo, hi];
}

const tileOf = (list: WallInst[], x: number, z: number) => list.filter((i) => i.x === x && i.z === z);

// ---- joins -------------------------------------------------------------------------------------------

test('a straight run has no gaps: the pieces of neighbouring tiles meet on the tile edge with identical cross-sections', () => {
  for (const tier of [1, 2, 3]) {
    const g = new WallGrid(12, 6);
    g.line(2, 3, 8, 3, tier);
    const list = wallInstances(g);
    for (let x = 2; x < 8; x++) {
      const a = world(tileOf(list, x, 3));
      const b = world(tileOf(list, x + 1, 3));
      const edge = x + 1;
      const [, aHi] = extentX(a.filter((p) => !p.part.startsWith('convex') && !p.part.startsWith('cap')));
      const [bLo] = extentX(b.filter((p) => !p.part.startsWith('convex') && !p.part.startsWith('cap')));
      assert.ok(Math.abs(aHi - edge) < 1e-4, `tier ${tier}: tile ${x} body ends at ${aHi}, not on the edge ${edge}`);
      assert.ok(Math.abs(bLo - edge) < 1e-4, `tier ${tier}: tile ${x + 1} body starts at ${bLo}, not on the edge ${edge}`);
      const sa = sectionX(a, edge);
      const sb = sectionX(b, edge);
      assert.ok(sa.has('ceramic') && sa.has('gunmetal') && sa.has('dark'), `tier ${tier}: ivory, gunmetal and core reach the edge at x = ${edge}`);
      assert.deepEqual([...sa.keys()].sort(), [...sb.keys()].sort(), `tier ${tier}: same materials either side of x = ${edge}`);
      for (const [mat, ba] of sa) {
        const bb = sb.get(mat)!;
        for (let k = 0; k < 4; k++) assert.ok(Math.abs(ba[k]! - bb[k]!) < 1e-4, `tier ${tier}, ${mat} at x = ${edge}: ${ba.map((v) => v.toFixed(4))} vs ${bb.map((v) => v.toFixed(4))}`);
      }
    }
    // the middle tiles are straight pieces with one face per side and no corners or caps
    const mid = summarise(tileOf(list, 5, 3));
    assert.deepEqual(mid, { 'core/straight': 1, 'face/full': 2 }, `tier ${tier}: a straight tile is one core and two full faces`);
  }
});

test('2 × 2 and 4 × 4 blocks fill in: infill at every inner corner, faces only on the outline, no interior posts', () => {
  for (const n of [2, 4]) {
    const g = new WallGrid(12, 12);
    g.rect(3, 3, 3 + n - 1, 3 + n - 1, 2, true);
    const list = wallInstances(g);
    const s = summarise(list);
    // each inner block corner is filled by its four tiles' quadrants, or by core/full inside
    const infillQuads = (s['core/infill'] ?? 0) + 4 * (s['core/full'] ?? 0);
    assert.equal(infillQuads, 4 * (n - 1) ** 2, `${n}×${n}: filled quadrants`);
    for (let z = 3; z < 3 + n; z++)
      for (let x = 3; x < 3 + n; x++) {
        const info = tileInfo(g, x, z);
        const interior = x > 3 && x < 3 + n - 1 && z > 3 && z < 3 + n - 1;
        if (interior) assert.equal(info.infill, 15, `${n}×${n}: interior tile ${x},${z} filled on all quadrants`);
      }
    assert.equal(Object.keys(s).filter((k) => k.startsWith('cap/')).length, 0, `${n}×${n}: no posts or junction caps`);
    assert.equal(s.convex, 4, `${n}×${n}: four outer corners`);
    assert.equal(s.concave ?? 0, 0, `${n}×${n}: no inner corners`);
    // total face length = the outline of the solid block: 4 sides of (n − 1 + 2·HALF)
    const len: Record<string, number> = { 'face/full': 1, 'face/hub': 2 * HALF, 'face/prev': 0.5 - HALF, 'face/next': 0.5 - HALF };
    let faces = 0;
    for (const i of list) faces += len[i.part.replace(/\/\d$/, '')] ?? 0;
    assert.ok(Math.abs(faces - 4 * (n - 1 + 2 * HALF)) < 1e-9, `${n}×${n}: face length ${faces}`);
    // and no face on an interior tile
    for (const i of list) {
      const interior = i.x > 3 && i.x < 3 + n - 1 && i.z > 3 && i.z < 3 + n - 1;
      if (interior) assert.ok(i.part.startsWith('core/'), `${n}×${n}: interior tile ${i.x},${i.z} has ${i.part}`);
    }
    if (n === 4) assert.ok((s.buttress ?? 0) > 0, 'a 4-deep wall gets buttresses on its outer faces');
  }
});

test('a 1-deep wall gets no infill and no buttresses; a 2-deep line gets buttresses on both outer faces', () => {
  const g = new WallGrid(14, 8);
  g.line(1, 2, 10, 2, 1);
  const s1 = summarise(wallInstances(g));
  assert.equal(s1['core/infill'] ?? 0, 0);
  assert.equal(s1.buttress ?? 0, 0);
  g.clear();
  g.rect(1, 2, 10, 3, 1, true);
  const list = wallInstances(g);
  const b = list.filter((i) => i.part.startsWith('buttress'));
  assert.ok(b.some((i) => i.z === 2 && i.rot === 3) && b.some((i) => i.z === 3 && i.rot === 1), 'buttresses face north on row 2 and south on row 3');
  // the deck is continuous: the inner row edges are covered by infill, not faces
  assert.ok(!list.some((i) => i.z === 2 && i.part.startsWith('face') && i.rot === 1), 'no face between the two rows');
});

test('erasing a tile updates its neighbours: the run splits into two ends', () => {
  const g = new WallGrid(12, 6);
  g.line(2, 3, 6, 3, 1);
  assert.equal(tileInfo(g, 3, 3).piece, 'straight');
  assert.equal(tileInfo(g, 5, 3).piece, 'straight');
  const inst = (x: number, z: number) => {
    const l: WallInst[] = [];
    tileInstances(g, x, z, l);
    return l;
  };
  const before3 = summarise(inst(3, 3));
  g.erase(4, 3);
  assert.deepEqual(pieceFor(g.mask(3, 3)), { piece: 'end', rot: 2 }, 'west part now ends towards the west neighbour');
  assert.deepEqual(pieceFor(g.mask(5, 3)), { piece: 'end', rot: 0 });
  const after3 = summarise(inst(3, 3));
  assert.notDeepEqual(after3, before3);
  assert.equal(after3['face/hub'], 3, 'the cut end shows its hub on three sides');
  assert.equal(after3.convex, 2, 'two outer corners at the new end');
  assert.equal(after3['cap/end'], 1);
});

test('mixed tiers in one run join: shared core section, and a joint over every face step', () => {
  const g = new WallGrid(14, 6);
  const tiers = [1, 1, 2, 2, 3, 3];
  tiers.forEach((t, k) => g.set(2 + k, 3, t));
  const list = wallInstances(g);
  const joints = list.filter((i) => i.part.startsWith('joint'));
  assert.equal(joints.length, 4, 'two tier changes × two faces');
  assert.deepEqual(joints.map((j) => j.tier).sort(), [2, 2, 3, 3], 'the higher tier adds the joint');
  for (const [x, tLo, tHi] of [[3, 1, 2], [5, 2, 3]] as const) {
    const edge = x + 1;
    const a = world(tileOf(list, x, 3).filter((i) => !i.part.startsWith('joint')));
    const b = world(tileOf(list, x + 1, 3).filter((i) => !i.part.startsWith('joint')));
    // the core (dark skin and gunmetal deck plate) runs on unchanged
    const ca = sectionX(a.filter((p) => p.part.startsWith('core')), edge);
    const cb = sectionX(b.filter((p) => p.part.startsWith('core')), edge);
    for (const mat of ['dark', 'gunmetal']) for (let k = 0; k < 4; k++) assert.ok(Math.abs(ca.get(mat)![k]! - cb.get(mat)![k]!) < 1e-4, `core ${mat} at x = ${edge}`);
    // the joint covers both faces' cross-sections at the edge
    const faceExtent = (pcs: WorldPiece[]) => {
      let zMax = 0;
      let yMax = 0;
      for (const pc of pcs) if (pc.part.startsWith('face')) for (let k = 0; k < pc.pos.length; k += 3) if (Math.abs(pc.pos[k]! - edge) < 1e-5) {
        zMax = Math.max(zMax, Math.abs(pc.pos[k + 2]! - 3.5));
        yMax = Math.max(yMax, pc.pos[k + 1]!);
      }
      return { zMax, yMax };
    };
    const fa = faceExtent(a);
    const fb = faceExtent(b);
    assert.ok(fb.zMax > fa.zMax, `tier ${tHi} armour is thicker than tier ${tLo}`);
    const jw = world(joints.filter((j) => j.x === x + 1));
    let jz = 0;
    let jy = 0;
    let jxLo = Infinity;
    let jxHi = -Infinity;
    for (const pc of jw) for (let k = 0; k < pc.pos.length; k += 3) {
      jz = Math.max(jz, Math.abs(pc.pos[k + 2]! - 3.5));
      jy = Math.max(jy, pc.pos[k + 1]!);
      jxLo = Math.min(jxLo, pc.pos[k]!);
      jxHi = Math.max(jxHi, pc.pos[k]!);
    }
    assert.ok(jz >= Math.max(fa.zMax, fb.zMax), `joint reaches ${jz} out, faces ${fa.zMax} / ${fb.zMax}`);
    assert.ok(jy >= Math.max(fa.yMax, fb.yMax), `joint stands ${jy} high over parapets ${fa.yMax} / ${fb.yMax}`);
    assert.ok(jxLo < edge && jxHi > edge, 'the joint straddles the tile edge');
  }
  assert.ok(TIERS[3]!.face > TIERS[2]!.face && TIERS[2]!.face > TIERS[1]!.face);
});

// ---- gates -------------------------------------------------------------------------------------------

test('gate placement accepts straight runs of the right length and rejects everything else', () => {
  const g = new WallGrid(16, 16);
  g.line(1, 3, 7, 3, 2); // 7 tiles: x 1..7
  assert.equal(g.checkGate(4, 3).ok, true, 'middle of a 7-tile run');
  assert.equal(g.checkGate(4, 3).axis, 'x');
  assert.equal(g.checkGate(3, 3).ok, true, '3 + 1 tile of wall on each side is enough');
  assert.equal(g.checkGate(2, 3).ok, false, 'no wall past the west end');
  assert.equal(g.checkGate(6, 3).ok, false, 'no wall past the east end');
  assert.equal(g.checkGate(4, 4).ok, false, 'not on wall');

  g.clear();
  g.line(1, 3, 4, 3, 1); // 4 tiles: too short for 3 + 1 + 1
  for (let x = 1; x <= 4; x++) assert.equal(g.checkGate(x, 3).ok, false, `4-tile run at ${x}`);

  g.clear();
  // an L: x 1..7 on row 3, then down from x = 7
  g.line(1, 3, 7, 3, 1);
  g.line(7, 3, 7, 9, 1);
  assert.equal(g.checkGate(6, 3).ok, false, 'into a corner');
  assert.equal(g.checkGate(7, 4).ok, false, 'round a corner');
  assert.equal(g.checkGate(7, 6).ok, true, 'straight leg of the L, N–S');
  assert.equal(g.checkGate(7, 6).axis, 'z');

  g.clear();
  // a T: a branch leaves the middle of the run
  g.line(1, 3, 9, 3, 1);
  g.line(5, 4, 5, 8, 1);
  assert.equal(g.checkGate(5, 3).ok, false, 'a branch joins the side');
  assert.match(g.checkGate(5, 3).reason, /straight run/);
  assert.equal(g.checkGate(3, 3).ok, true, 'away from the branch');

  g.clear();
  // 2-deep and 4-deep walls: the gate goes through the full depth
  g.rect(1, 3, 9, 4, 2, true);
  const c2 = g.checkGate(5, 3);
  assert.equal(c2.ok, true);
  assert.equal(c2.hi - c2.lo + 1, 2, 'depth 2');
  assert.equal(c2.tiles.length, 6);
  assert.equal(g.checkGate(5, 4).ok, true, 'from the other row too');
  g.clear();
  g.rect(1, 3, 9, 6, 3, true);
  const c4 = g.checkGate(5, 4);
  assert.equal(c4.ok, true);
  assert.equal(c4.hi - c4.lo + 1, 4);
  g.clear();
  g.rect(1, 3, 9, 7, 3, true);
  assert.equal(g.checkGate(5, 5).ok, false, '5 deep is too deep');
});

test('a placed gate joins the wall on both sides and erasing it removes it', () => {
  const g = new WallGrid(16, 8);
  g.line(1, 3, 9, 3, 2);
  const gate = g.placeGate(5, 3)!;
  assert.ok(gate);
  assert.deepEqual(gate.tiles.map(([x]) => x).sort(), [4, 5, 6]);
  // the walls either side still join to the gate: straight pieces with an arm into it
  assert.equal(tileInfo(g, 3, 3).piece, 'straight');
  assert.equal(tileInfo(g, 7, 3).piece, 'straight');
  // gate tiles draw no wall pieces
  assert.equal(wallInstances(g).filter((i) => i.x >= 4 && i.x <= 6).length, 0);
  // a second gate cannot overlap
  assert.equal(g.checkGate(5, 3).ok, false);
  g.erase(4, 3);
  assert.equal(g.gates.size, 0);
  assert.equal(g.solid(5, 3), false, 'the gate tiles are cleared');
});

test('a gate opens for an engineer and the commander, closes behind them, and stays shut to aliens', () => {
  assert.equal(opensGates('engineer'), true);
  assert.equal(opensGates('commander'), true);
  assert.equal(opensGates('alien'), false);
  const door = new GateDoor(10.5, 6.5, 'x', 2);
  const run = (seconds: number, movers: Array<{ kind: 'engineer' | 'commander' | 'alien'; x: number; z: number }>) => {
    for (let t = 0; t < seconds; t += 1 / 60) door.update(1 / 60, movers);
  };
  run(3, [{ kind: 'alien', x: 10.5, z: 4.0 }]);
  assert.equal(door.open, 0, 'an alien at the gate: shut');
  run(3, [{ kind: 'alien', x: 10.5, z: 6.5 }]);
  assert.equal(door.open, 0, 'an alien in the opening: still shut');
  run(1.5, [{ kind: 'engineer', x: 10.5, z: 4.0 }]);
  assert.equal(door.open, 1, 'an engineer approaching: open');
  assert.equal(door.passable, true);
  run(3, [{ kind: 'engineer', x: 10.5, z: 14 }]);
  assert.equal(door.open, 0, 'closed behind the engineer once clear');
  run(1.5, [{ kind: 'commander', x: 10, z: 9.0 }, { kind: 'alien', x: 11, z: 9 }]);
  assert.equal(door.open, 1, 'the commander opens it (an alien next to him does not stop it)');
  run(0.3, [{ kind: 'alien', x: 10.5, z: 6.5 }]);
  assert.ok(door.open > 0.5, 'doors take time to close');
  run(2, [{ kind: 'alien', x: 10.5, z: 6.5 }]);
  assert.equal(door.open, 0);
});
