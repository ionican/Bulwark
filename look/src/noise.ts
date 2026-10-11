// Seeded 2D gradient noise, fractal sums and a small PRNG. Pure maths, no DOM.

export class Rand {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    // mulberry32
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

export function hash2i(x: number, y: number, salt = 0): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(salt | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const GRAD: Float32Array = (() => {
  const g = new Float32Array(512);
  for (let i = 0; i < 256; i++) {
    const a = (i / 256) * Math.PI * 2;
    g[i * 2] = Math.cos(a);
    g[i * 2 + 1] = Math.sin(a);
  }
  return g;
})();

const PERM: Uint8Array = (() => {
  const r = new Rand(0x5eed1);
  const p = new Uint8Array(512);
  const base = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = r.int(i + 1);
    [base[i], base[j]] = [base[j]!, base[i]!];
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255]!;
  return p;
})();

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Perlin gradient noise, roughly in [-0.7, 0.7]. */
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const X = xi & 255;
  const Y = yi & 255;
  const g = (ix: number, iy: number, dx: number, dy: number) => {
    const h = PERM[PERM[ix]! + iy]! * 2;
    return GRAD[h]! * dx + GRAD[h + 1]! * dy;
  };
  const u = fade(xf);
  const v = fade(yf);
  const a = g(X, Y, xf, yf);
  const b = g(X + 1, Y, xf - 1, yf);
  const c = g(X, Y + 1, xf, yf - 1);
  const d = g(X + 1, Y + 1, xf - 1, yf - 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal sum, normalised to roughly [-1, 1]. */
export function fbm(x: number, y: number, octaves = 4, lac = 2.03, gain = 0.5): number {
  let s = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    s += amp * noise2(x, y);
    norm += amp;
    amp *= gain;
    x = x * lac + 17.3;
    y = y * lac - 9.1;
  }
  return (s / norm) * 1.45;
}

/** Ridged fractal in [0, 1]: sharp crests where the noise crosses zero. */
export function ridged(x: number, y: number, octaves = 3): number {
  let s = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(x, y) * 1.4);
    s += amp * n * n;
    norm += amp;
    amp *= 0.5;
    x = x * 2.1 + 5.7;
    y = y * 2.1 + 1.3;
  }
  return s / norm;
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
