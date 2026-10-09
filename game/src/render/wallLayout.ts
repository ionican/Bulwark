// Wall and gate topology from snapshots (W24 run 2a, PLAN "Walls and gates"). W23's autotiler
// (workshop/w23/walls/layout.ts) turns a WallGrid into part instances; this module keeps a WallGrid
// in step with the snapshot and rebuilds the instance list only when the layout key changes.
//
// Layout key, one 32-bit code per tile:
//   bits 0–1   identity: 0 none, 1 wall, 2 gate
//   bits 2–3   tier (1–3)
//   bit  4     construction class: 0 reserved, 1 started or complete (started tiles join neighbours)
//   bit  5     gate axis (0 along x, 1 along z)
//   bits 6–8   gate footprint fw, bits 9–11 fh
//   bits 12–14 the tile's x offset in its gate footprint, bits 15–17 its z offset
// Hit points and construction progress are not in the key: they change per-instance data only
// (damage state, build cut), never the topology. `rebuilds` counts topology rebuilds.
//
// Reserved tiles are in the key but not in the grid: they hold their tile without joining (drawn as
// outlines). Wall instances are positioned on their tile's base height (footprintRange top), so the
// instance matrices are computed once per rebuild.

import { Matrix4 } from 'three';
import { B } from '../sim/kinds.ts';
import { BF_COMPLETE, BF_STARTED } from '../sim/schema.ts';
import type { Terrain } from '../sim/terrain.ts';
import { footprintRange } from './ground.ts';
import { wallMatrix } from './workshop/w23/walls/geometry.ts';
import { WallGrid, type Gate } from './workshop/w23/walls/grid.ts';
import { gateInstance, leafOffsets, wallInstances } from './workshop/w23/walls/layout.ts';

/** Gate run axis from the building's dir column (sim/gate.ts: AXIS_X = 0, AXIS_Z = 1). */
export const GATE_AXIS_Z = 1;
/** Gate depth (rows across the run) from its footprint and axis (sim/gate.ts gateDepth). */
export const gateDepthOf = (fw: number, fh: number, dir: number): number => (dir === GATE_AXIS_Z ? fw : fh);

export interface BuildingRows {
  count: number;
  id: Uint32Array;
  kind: Uint8Array;
  tier: Uint8Array;
  flags: Uint8Array;
  dir: Uint8Array;
  tx: Int16Array;
  ty: Int16Array;
  fw: Uint8Array;
  fh: Uint8Array;
}

export interface GatePiece {
  part: string;
  /** World matrix, 16 floats. */
  m: Float32Array;
}

/** A gate's W23 frame: centre and rotation, from which its door leaves are placed (W24 run 2b). */
export interface GateFrame {
  cx: number;
  y: number;
  cz: number;
  rot: number;
}

/** The four door leaves of a gate opened by `open` (0 shut … 1 open, W23 leafOffsets): 16 floats each into `out`. */
export function leafMatrices(f: GateFrame, open: number, out: Float32Array): Float32Array {
  leafOffsets(open).forEach((off, k) => wallMatrix(_c, f.cx, f.y, f.cz, f.rot, off).toArray(out, k * 16));
  return out;
}

const _a = new Matrix4();
const _b = new Matrix4();
const _c = new Matrix4();

export class WallLayout {
  readonly grid: WallGrid;
  private key: Uint32Array;
  private next: Uint32Array;
  /** Topology rebuilds since construction. */
  rebuilds = 0;
  /** Instances in tile order: part id and world matrix (16 floats each). */
  parts: string[] = [];
  matrices = new Float32Array(0);
  /** First instance and instance count per tile. */
  readonly first: Int32Array;
  readonly count: Uint16Array;
  /** Gate pieces (doors closed) by the gate's anchor tile index. */
  readonly gates = new Map<number, GatePiece[]>();
  /** Gate frames by the gate's anchor tile index (the leaves move: run 2b draws them from this). */
  readonly gateFrames = new Map<number, GateFrame>();
  /** Base height of every tile (the highest grid corner: a 1 × 1 footprint's top). */
  readonly base: Float32Array;

  constructor(readonly terrain: Terrain) {
    const n = terrain.w * terrain.h;
    this.grid = new WallGrid(terrain.w, terrain.h);
    this.key = new Uint32Array(n);
    this.next = new Uint32Array(n);
    this.first = new Int32Array(n);
    this.count = new Uint16Array(n);
    this.base = new Float32Array(n);
    for (let z = 0; z < terrain.h; z++) for (let x = 0; x < terrain.w; x++) this.base[z * terrain.w + x] = footprintRange(terrain, x, z, 1, 1).top;
  }

  /** Recomputes the key; rebuilds the topology if it changed. Returns true on a rebuild. */
  update(b: BuildingRows): boolean {
    const w = this.terrain.w;
    const h = this.terrain.h;
    const k = this.next;
    k.fill(0);
    for (let r = 0; r < b.count; r++) {
      const kind = b.kind[r]!;
      if (kind !== B.wall && kind !== B.gate) continue;
      const flags = b.flags[r]!;
      const cls = flags & (BF_STARTED | BF_COMPLETE) ? 1 : 0;
      const tier = Math.max(1, Math.min(3, b.tier[r]!));
      const tx = b.tx[r]!;
      const ty = b.ty[r]!;
      if (kind === B.wall) {
        if (tx >= 0 && ty >= 0 && tx < w && ty < h) k[ty * w + tx] = 1 | (tier << 2) | (cls << 4);
        continue;
      }
      const fw = b.fw[r]!;
      const fh = b.fh[r]!;
      const axis = b.dir[r] === GATE_AXIS_Z ? 1 : 0;
      for (let j = 0; j < fh; j++)
        for (let i = 0; i < fw; i++) {
          const x = tx + i;
          const z = ty + j;
          if (x < 0 || z < 0 || x >= w || z >= h) continue;
          k[z * w + x] = 2 | (tier << 2) | (cls << 4) | (axis << 5) | ((fw & 7) << 6) | ((fh & 7) << 9) | ((i & 7) << 12) | ((j & 7) << 15);
        }
    }
    let same = true;
    for (let i = 0; i < k.length; i++)
      if (k[i] !== this.key[i]) {
        same = false;
        break;
      }
    if (same) return false;
    this.next = this.key;
    this.key = k;
    this.rebuild();
    return true;
  }

  private rebuild(): void {
    const w = this.terrain.w;
    const g = this.grid;
    g.clear();
    this.gates.clear();
    this.gateFrames.clear();
    let gateId = 0;
    for (let i = 0; i < this.key.length; i++) {
      const c = this.key[i]!;
      if (!(c & 16)) continue; // reserved: not part of the topology
      const tier = (c >> 2) & 3;
      const x = i % w;
      const z = Math.floor(i / w);
      if ((c & 3) === 1) g.set(x, z, tier);
      else if ((c & 3) === 2 && ((c >> 12) & 7) === 0 && ((c >> 15) & 7) === 0) {
        // the gate's anchor tile: add the whole gate once
        const axisZ = (c >> 5) & 1;
        const fw = (c >> 6) & 7;
        const fh = (c >> 9) & 7;
        const depth = axisZ ? fw : fh;
        const tiles: Array<[number, number]> = [];
        for (let j = 0; j < fh; j++) for (let ii = 0; ii < fw; ii++) tiles.push([x + ii, z + j]);
        // W23 gate frame: centre tile on the run's middle column; rows lo … hi across the run
        const gate: Gate = axisZ
          ? { id: gateId++, cx: x, cz: z + 1, axis: 'z', lo: 0, hi: depth - 1, tier, tiles }
          : { id: gateId++, cx: x + 1, cz: z, axis: 'x', lo: 0, hi: depth - 1, tier, tiles };
        g.addGate(gate);
        const gi = gateInstance(gate);
        const cx = gi.x + 0.5;
        const cz = gi.z + 0.5;
        const y = footprintRange(this.terrain, x, z, fw, fh).top;
        wallMatrix(_a, cx, y, cz, gi.rot, [0, 0, 0]);
        const pieces: GatePiece[] = gi.parts.map((pc) => ({ part: pc.part, m: new Float32Array(_c.copy(_a).multiply(wallMatrix(_b, pc.off[0], pc.off[1], pc.off[2], pc.rot, [0, 0, 0])).elements) }));
        for (const off of leafOffsets(0)) pieces.push({ part: 'gate/leaf', m: new Float32Array(wallMatrix(_c, cx, y, cz, gi.rot, off).elements) });
        this.gates.set(i, pieces);
        this.gateFrames.set(i, { cx, y, cz, rot: gi.rot });
      }
    }
    const list = wallInstances(g);
    this.parts = list.map((inst) => inst.part);
    this.matrices = new Float32Array(list.length * 16);
    this.first.fill(-1);
    this.count.fill(0);
    list.forEach((inst, n) => {
      const tile = inst.z * w + inst.x;
      wallMatrix(_a, inst.x + 0.5, this.base[tile]!, inst.z + 0.5, inst.rot, inst.off);
      _a.toArray(this.matrices, n * 16);
      if (this.first[tile]! < 0) this.first[tile] = n;
      this.count[tile]!++;
    });
    this.rebuilds++;
  }
}
