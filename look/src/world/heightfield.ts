// Procedural heightfield for the map 1 vista. Analytic: height(x, z) can be evaluated anywhere,
// so the terrain mesh, building pads and alien feet all agree.
//
// Shape, in order: a flat upland round the base; the two approach corridors (north, east) and a
// broad basin to the north-east carved 8 tiles down as terraced canyons; branching gullies cut into
// the canyon rims; mesas and spires left standing in the canyons; map 1's rock outcrops raised as
// terraced buttes; shallow bowls on the canyon floor that hold the pools; and every building
// footprint and deposit flattened. Terracing (flat ledge, steep riser) gives the strata steps.
// Units: tiles (1 tile = 2 m). The upland is at height 0.

import { Rand, clamp, fbm, lerp, noise2, ridged, smoothstep } from '../noise.ts';
import { BASE, buildings, outcrops, sizeOf, terrain } from './layout.ts';

export const CANYON_DEPTH = 8;
export const WATER_LEVEL = -8.25;
export const VISTA = { x0: -170, x1: 300, z0: -190, z1: 290 };

/** Alien approach paths (tiles), from far out to the wall line. */
export const PATHS = {
  north: [{ x: 64, z: -90 }, { x: 64, z: -20 }, { x: 64, z: 37.5 }],
  east: [{ x: 230, z: 66 }, { x: 150, z: 64 }, { x: 91, z: 64 }],
};

const NORTH_A = { x: 64, z: -260 };
const EAST_A = { x: 360, z: 64 };
const BASIN = { x: 168, z: -48 };

function distSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const l2 = vx * vx + vz * vz;
  let t = l2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
  t = clamp(t, 0, 1);
  const dx = px - (ax + t * vx);
  const dz = pz - (az + t * vz);
  return Math.sqrt(dx * dx + dz * dz);
}

interface Column {
  x: number;
  z: number;
  r: number;
  top: number;
}

export interface Sample {
  h: number;
  /** 0..1: canyon floor and gully darkening. */
  dark: number;
  /** 0..1: compacted pale ground round the base. */
  pave: number;
  /** 0..1: inside the cliff and mesa relief (rock rather than sand). */
  cliff: number;
}

interface Carve {
  carve: number;
  wide: number;
  dCorr: number;
}

function carveAt(x: number, z: number, wx: number, wz: number): Carve {
  const dB = Math.hypot(x - BASE.x, z - BASE.z);
  // Corridors use the unwarped position (the alien paths are straight) with a noisy width and a
  // small edge warp, so the walls wander but the floor always contains the path.
  const ex = x + 6 * fbm(x * 0.045, z * 0.045, 2);
  const ez = z + 6 * fbm(x * 0.045 + 11, z * 0.045 - 4, 2);
  const wN = 12.5 + 5 * fbm(z * 0.018, 3.3, 3);
  const dN = distSeg(ex, ez, NORTH_A.x, NORTH_A.z, BASE.x, BASE.z);
  const wE = 12.5 + 5 * fbm(x * 0.018, 8.8, 3);
  const dE = distSeg(ex, ez, EAST_A.x, EAST_A.z, BASE.x, BASE.z);
  const dBas = Math.hypot((wx - BASIN.x) * 0.8, wz - BASIN.z) + 16 * fbm(wx * 0.017, wz * 0.017, 3);
  const ramp = smoothstep(29, 48, dB);
  const cN = 1 - smoothstep(wN, wN + 5, dN);
  const cE = 1 - smoothstep(wE, wE + 5, dE);
  const cB = 1 - smoothstep(76, 84, dBas);
  // A second canyon sweeping south-east of the base, for the far vista.
  const dS = Math.hypot((wx - 210) * 0.7, (wz - 210) * 1.1) + 12 * fbm(wx * 0.025 + 4, wz * 0.025, 3);
  const cS = 1 - smoothstep(55, 62, dS);
  // Rim canyon: in the north-to-east sector the plateau ends in a cliff a few tiles beyond the
  // walls. The approach corridors cut through it as gentle ramps (aliens climb those).
  // sector = intersection of two half-planes through the base (edges at -129° and +25°), so the
  // sides are cliffs of constant width rather than angular ramps
  const px = wx - BASE.x;
  const pz = wz - BASE.z;
  const s1 = smoothstep(-2.5, 2.5, -0.629 * pz + 0.778 * px);
  const s2 = smoothstep(-2.5, 2.5, -(0.906 * pz - 0.423 * px));
  const inSector = s1 * s2;
  const dBw = dB + 4 * fbm(x * 0.05 + 3, z * 0.05 - 8, 2);
  const cRim = inSector * smoothstep(34, 36.2, dBw);
  const corrIn = Math.max(cN, cE);
  const open = Math.max(corrIn * ramp, cRim, Math.max(cB, cS) * ramp);
  const carve = open + (ramp - open) * corrIn;
  const wide = Math.max(1 - smoothstep(wN, wN + 22, dN), 1 - smoothstep(wE, wE + 22, dE), 1 - smoothstep(76, 100, dBas), 1 - smoothstep(55, 75, dS), inSector * smoothstep(22, 33, dBw)) * smoothstep(27, 40, dB);
  return { carve, wide, dCorr: Math.min(dN, dE) };
}

/** Terraces on absolute height: horizontal strata, each a flat ledge then a steep riser. */
function strata(h: number, step: number, ledge: number): number {
  const s = h / step;
  const k = Math.floor(s);
  return (k + smoothstep(ledge, 0.96, s - k)) * step;
}

class Field {
  private columns: Column[] = [];
  private flats: Array<{ x0: number; z0: number; x1: number; z1: number; m: number; h: number }> = [];
  private pools: Array<{ x: number; z: number; r: number }> = [];

  constructor() {
    const rnd = new Rand(0xb01a);
    // Spires and stacks: candidates kept only on the canyon floor, clear of the alien paths.
    for (let tries = 0; tries < 4000 && this.columns.length < 110; tries++) {
      const x = rnd.range(-40, 270);
      const z = rnd.range(-170, 250);
      const c = carveAt(x, z, x, z);
      if (c.carve < 0.8) continue;
      if (this.pathDist(x, z) < 8) continue;
      if (Math.hypot(x - BASE.x, z - BASE.z) < 48) continue;
      if (this.columns.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 5)) continue;
      const k = rnd.next();
      // pinnacles, low buttes, broad stacks
      if (k < 0.55) this.columns.push({ x, z, r: rnd.range(0.9, 2.2), top: rnd.range(-3, 5) });
      else if (k < 0.92) this.columns.push({ x, z, r: rnd.range(2.5, 5), top: rnd.range(-5, 1) });
      else this.columns.push({ x, z, r: rnd.range(5, 8), top: rnd.range(-3, 3) });
    }
    // Map 1 rock outcrops → terraced buttes.
    for (const o of outcrops) this.columns.push({ x: o.x, z: o.z, r: o.r * 1.15 + 0.4, top: 3.2 + o.r * 1.9 });
    // Pools: shallow bowls on the canyon floor.
    for (const [x, z, r] of [
      [70, 6, 7], [58, -18, 9], [66, -48, 8], [118, 58, 7], [140, 70, 10], [178, 60, 8],
      [140, -20, 12], [176, -60, 14], [200, -20, 9], [120, -40, 8], [215, 190, 11], [190, 230, 9],
    ] as const) this.pools.push({ x, z, r });
    // Flatten every building footprint and deposit to its own natural height.
    const rect = (x0: number, z0: number, s: number, m: number) => {
      const cx = x0 + s / 2;
      const cz = z0 + s / 2;
      this.flats.push({ x0: x0 - 0.3, z0: z0 - 0.3, x1: x0 + s + 0.3, z1: z0 + s + 0.3, m, h: this.natural(cx, cz).h });
    };
    for (const b of buildings) rect(b.tx, b.ty, sizeOf(b.kind), b.kind === 'wall' ? 1.2 : 2.2);
    for (const d of terrain.deposits) rect(d.tx, d.ty, 2, 3);
  }

  pathDist(x: number, z: number): number {
    let d = Infinity;
    for (const p of [PATHS.north, PATHS.east]) {
      for (let i = 0; i + 1 < p.length; i++) d = Math.min(d, distSeg(x, z, p[i]!.x, p[i]!.z, p[i + 1]!.x, p[i + 1]!.z));
    }
    return d;
  }

  natural(x: number, z: number): Sample {
    const wx = x + 16 * fbm(x * 0.008, z * 0.008, 3) + 2.5 * noise2(x * 0.06, z * 0.06);
    const wz = z + 16 * fbm(x * 0.008 + 31.7, z * 0.008 - 12.2, 3) + 2.5 * noise2(x * 0.06 + 9, z * 0.06 + 3);
    const dB = Math.hypot(x - BASE.x, z - BASE.z);
    const c = carveAt(x, z, wx, wz);

    // Gullies: ridged channels running out from the canyon rims into the upland.
    const g = ridged(wx * 0.04, wz * 0.04, 3);
    const gully = smoothstep(0.78, 0.94, g) * c.wide * (1 - smoothstep(0.85, 1, c.carve));
    const carve = Math.max(c.carve, gully * 0.75 * c.wide);

    // Smooth relief first (canyons down, mesas and columns up), then horizontal strata.
    let r = -CANYON_DEPTH * carve;
    const mN = fbm(wx * 0.019 + 5, wz * 0.019 - 7, 4);
    const t = lerp(lerp(0.5, 0.26, smoothstep(50, 120, dB)), 0.18, smoothstep(0.3, 1, c.carve));
    const keepOut = smoothstep(50, 66, dB) * smoothstep(9, 17, this.pathDist(x, z));
    const mMask = smoothstep(t, t + 0.022, mN) * keepOut;
    if (mMask > 0) {
      const top = 9 + 7 * fbm(wx * 0.006 + 2, wz * 0.006 - 9, 2) + 0.6 * fbm(x * 0.05, z * 0.05, 2);
      r = lerp(r, top, mMask);
    }
    for (const col of this.columns) {
      const dx = wx - col.x;
      const dz = wz - col.z;
      const lim = col.r * 1.6 + 3;
      if (dx > lim || dx < -lim || dz > lim || dz < -lim) continue;
      const d = Math.sqrt(dx * dx + dz * dz) + col.r * 0.3 * noise2(x * 0.22, z * 0.22) + col.r * 0.25 * noise2(x * 0.06 + 9, z * 0.06);
      // flat top, steep sides, flared foot
      const s = Math.max(0, 1 - d / (col.r * 1.5));
      const prof = 0.3 * smoothstep(0, 0.25, s) + 0.7 * smoothstep(0.17, 0.27, s);
      if (prof > 0) r = Math.max(r, lerp(r, col.top, prof));
    }
    const floorness = smoothstep(0.85, 1, c.carve) * (1 - mMask);
    const rough = smoothstep(0.6, 2.2, Math.abs(r)) * (1 - floorness);
    r += rough * (0.7 * noise2(x * 0.16, z * 0.16) + 0.35 * noise2(x * 0.5, z * 0.5));
    const ledge = 0.22 + 0.3 * (0.5 + 0.5 * noise2(x * 0.03 + 50, z * 0.03));
    let h = lerp(lerp(r, strata(r, 1.6, ledge), 0.9), r, floorness);

    const dune = (0.12 + 0.88 * smoothstep(20, 36, dB)) * (0.45 * fbm(x * 0.045, z * 0.045, 3) + 0.12 * noise2(x * 0.3, z * 0.3));
    const floorN = 0.55 * fbm(x * 0.035 + 7, z * 0.035, 3) + 0.15 * noise2(x * 0.22, z * 0.22);
    // eroded terraces on the canyon floor: one or two raised shelves with sharp edges, kept off the paths
    const fA = fbm(wx * 0.028 + 40, wz * 0.028 - 20, 4);
    const shelves = 1.5 * smoothstep(0.08, 0.13, fA) + 1.4 * smoothstep(0.42, 0.47, fA);
    const pathClear = smoothstep(6, 12, this.pathDist(x, z));
    h += dune * (1 - rough) * (1 - floorness) + (floorN + shelves * pathClear) * floorness;

    // Pool bowls on the canyon floor.
    if (floorness > 0) {
      for (const p of this.pools) {
        const d = Math.hypot(wx - p.x, wz - p.z) + 3 * noise2(x * 0.08, z * 0.08);
        if (d < p.r) h -= 1.15 * floorness * (1 - smoothstep(0, p.r, d) ** 2);
      }
    }

    const dark = clamp(gully * 1.2 + 0.6 * smoothstep(0.55, 0.95, c.carve) * (1 - floorness), 0, 1);
    const pave = 0.8 * smoothstep(17, 11, dB + 3 * noise2(x * 0.08, z * 0.08));
    const cliff = smoothstep(0.4, 1.6, Math.abs(r)) * (1 - floorness);
    return { h, dark, pave, cliff };
  }

  sample(x: number, z: number): Sample {
    const s = this.natural(x, z);
    // paved ground follows the buildings (inside the walls) rather than a circle round the base
    let pave = s.pave;
    for (const f of this.flats) {
      const reach = Math.max(f.m, 4.5);
      if (x < f.x0 - reach || x > f.x1 + reach || z < f.z0 - reach || z > f.z1 + reach) continue;
      const ex = Math.max(f.x0 - x, 0, x - f.x1);
      const ez = Math.max(f.z0 - z, 0, z - f.z1);
      const d = Math.hypot(ex, ez);
      const w = 1 - smoothstep(0, f.m, d);
      s.h = lerp(s.h, f.h, w);
      s.dark *= 1 - w;
      s.cliff *= 1 - w;
      pave = Math.max(pave, 1 - smoothstep(1.2, 4.5, d + 1.2 * noise2(x * 0.3, z * 0.3)));
    }
    s.pave = pave;
    return s;
  }

  height(x: number, z: number): number {
    return this.sample(x, z).h;
  }
}

export const field = new Field();
export const heightAt = (x: number, z: number) => field.height(x, z);
