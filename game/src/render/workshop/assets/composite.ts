// Ported from look/src/assets/composite.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// Textures composed in code from the downloaded photo maps.
// Ivory armour: the Metal016 photo (light painted steel) supplies fine surface detail; panel
// seams with bevelled edges, bolt heads, hairline cracks and chipped paint are generated here and
// folded into the colour, normal and roughness/metal maps. Nothing here is an AI or copied image.

import { CanvasTexture, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, SRGBColorSpace, type ColorSpace } from 'three';
import { Rand, smoothstep } from '../noise.ts';

export interface PanelMaps {
  colour: CanvasTexture<OffscreenCanvas>;
  normal: CanvasTexture<OffscreenCanvas>;
  /** R = ambient occlusion, G = roughness, B = metalness. */
  orm: CanvasTexture<OffscreenCanvas>;
}

function toTexture(img: ImageData, colour: ColorSpace, old?: CanvasTexture<OffscreenCanvas>): CanvasTexture<OffscreenCanvas> {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(img, 0, 0);
  if (old) {
    old.dispose();
    old.image = c;
    old.needsUpdate = true;
    return old;
  }
  const t = new CanvasTexture(c);
  t.colorSpace = colour;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.flipY = false;
  return t;
}

/**
 * @param diff, nor, rough  Metal016 pixels (same size).
 * @param base  ivory paint colour, sRGB 0..255.
 */
export function ivoryPanels(diff: ImageData, nor: ImageData, rough: ImageData, base: [number, number, number], anisotropy: number, prev?: PanelMaps): PanelMaps {
  const S = diff.width;
  const px = S / 1024;
  const rnd = new Rand(0x1c0e5);
  // ---- seam layout: 4 columns, each split into 2-4 rows; tiles seamlessly.
  const H = new Float32Array(S * S).fill(1);
  const cols = 4;
  const cw = S / cols;
  const rowsOf: number[][] = [];
  for (let c = 0; c < cols; c++) {
    const n = 2 + rnd.int(3);
    const cuts = new Set<number>([0]);
    while (cuts.size < n) cuts.add(Math.round(rnd.range(0.12, 0.88) * 16) / 16);
    rowsOf.push([...cuts].sort((a, b) => a - b).map((v) => v * S));
  }
  const groove = 2.2 * px;
  const bevel = 5 * px;
  const distToLines = (v: number, lines: number[]) => {
    let d = Infinity;
    for (const l of lines) {
      const a = Math.abs(v - l);
      d = Math.min(d, a, S - a);
    }
    return d;
  };
  const colLines = Array.from({ length: cols }, (_, i) => i * cw);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const c = Math.min(cols - 1, Math.floor(x / cw));
      const d = Math.min(distToLines(x, colLines), distToLines(y, rowsOf[c]!));
      H[y * S + x] = smoothstep(groove, groove + bevel, d);
    }
  }
  // Bolt heads near panel corners.
  const bolts: Array<[number, number]> = [];
  for (let c = 0; c < cols; c++) {
    const rows = rowsOf[c]!;
    for (let r = 0; r < rows.length; r++) {
      const y0 = rows[r]!;
      for (const x0 of [c * cw, (c + 1) * cw]) {
        const ox = x0 === c * cw ? 14 * px : -14 * px;
        bolts.push([x0 + ox, y0 + 14 * px]);
      }
    }
  }
  const boltR = 5 * px;
  for (const [bx, by] of bolts) {
    for (let y = Math.floor(by - boltR - 2); y <= by + boltR + 2; y++) {
      for (let x = Math.floor(bx - boltR - 2); x <= bx + boltR + 2; x++) {
        const d = Math.hypot(x - bx, y - by);
        if (d > boltR + 1.5) continue;
        const xx = ((x % S) + S) % S;
        const yy = ((y % S) + S) % S;
        const dome = Math.sqrt(Math.max(0, 1 - (d / boltR) ** 2));
        H[yy * S + xx] = d < boltR ? 1 + 0.9 * dome : Math.min(H[yy * S + xx]!, 0.75);
      }
    }
  }
  // ---- hairline cracks and paint chips, drawn with canvas strokes into masks.
  const mc = new OffscreenCanvas(S, S);
  const g = mc.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  g.strokeStyle = '#f00';
  g.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    let x = rnd.range(0, S);
    let y = rnd.range(0, S);
    let a = rnd.range(0, Math.PI * 2);
    g.lineWidth = rnd.range(0.7, 1.4) * px;
    g.beginPath();
    g.moveTo(x, y);
    const steps = 10 + rnd.int(26);
    for (let k = 0; k < steps; k++) {
      a += rnd.range(-0.7, 0.7);
      x += Math.cos(a) * 9 * px;
      y += Math.sin(a) * 9 * px;
      g.lineTo(x, y);
      if (rnd.next() < 0.08) {
        // short branch
        g.moveTo(x, y);
        const b = a + rnd.range(-1.4, 1.4);
        g.lineTo(x + Math.cos(b) * 18 * px, y + Math.sin(b) * 18 * px);
        g.moveTo(x, y);
      }
    }
    g.stroke();
  }
  // Chips: irregular blotches hugging seams (G channel).
  g.fillStyle = '#0f0';
  for (let i = 0; i < 16; i++) {
    const c = rnd.int(cols);
    const rows = rowsOf[c]!;
    const onCol = rnd.next() < 0.5;
    const x = onCol ? c * cw + rnd.range(-6, 6) * px : rnd.range(c * cw, (c + 1) * cw);
    const y = onCol ? rnd.range(0, S) : rows[rnd.int(rows.length)]! + rnd.range(-6, 6) * px;
    const r = rnd.range(2.5, 8) * px;
    g.beginPath();
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2;
      const rr = r * rnd.range(0.45, 1.25);
      g.lineTo(x + Math.cos(a) * rr * 1.4, y + Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
  }
  const mask = g.getImageData(0, 0, S, S).data;

  // ---- compose
  const out = new ImageData(S, S);
  const outN = new ImageData(S, S);
  const outR = new ImageData(S, S);
  let mean = 0;
  for (let i = 0; i < S * S; i++) mean += diff.data[i * 4]! * 0.3 + diff.data[i * 4 + 1]! * 0.59 + diff.data[i * 4 + 2]! * 0.11;
  mean /= S * S;
  const sub = [138, 128, 114];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const o = i * 4;
      const h = H[i]!;
      const crack = mask[o]! / 255;
      const chip = mask[o + 1]! / 255;
      const l = (diff.data[o]! * 0.3 + diff.data[o + 1]! * 0.59 + diff.data[o + 2]! * 0.11) / mean;
      const detail = 0.9 + 0.12 * Math.max(-1.5, Math.min(1.5, (l - 1) * 2.2));
      const seamShade = 0.38 + 0.62 * Math.min(1, h);
      let k = detail * seamShade * (1 - 0.5 * crack);
      for (let ch = 0; ch < 3; ch++) {
        let v = base[ch]! * k;
        v = v * (1 - chip) + sub[ch]! * detail * chip;
        out.data[o + ch] = Math.max(0, Math.min(255, v));
      }
      out.data[o + 3] = 255;
      // normal: photo detail (×0.55) + seam/bolt relief from H + crack groove
      const hx = H[y * S + ((x + 1) % S)]! - H[y * S + ((x - 1 + S) % S)]!;
      const hy = H[((y + 1) % S) * S + x]! - H[((y - 1 + S) % S) * S + x]!;
      const cx = mask[(y * S + ((x + 1) % S)) * 4]! - mask[(y * S + ((x - 1 + S) % S)) * 4]!;
      const cy = mask[(((y + 1) % S) * S + x) * 4]! - mask[(((y - 1 + S) % S) * S + x) * 4]!;
      let nx = ((nor.data[o]! / 255) * 2 - 1) * 0.55 - hx * 2.2 / px + (cx / 255) * 0.35;
      let ny = ((nor.data[o + 1]! / 255) * 2 - 1) * 0.55 - hy * 2.2 / px + (cy / 255) * 0.35;
      let nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      outN.data[o] = (nx * 0.5 + 0.5) * 255;
      outN.data[o + 1] = (ny * 0.5 + 0.5) * 255;
      outN.data[o + 2] = (nz * 0.5 + 0.5) * 255;
      outN.data[o + 3] = 255;
      const r0 = rough.data[o]! / 255;
      const ao = 0.45 + 0.55 * Math.min(1, h);
      const rgh = (0.62 + 0.25 * r0) * (1 - chip) + 0.42 * chip;
      outR.data[o] = ao * 255;
      outR.data[o + 1] = Math.min(1, rgh + (1 - Math.min(1, h)) * 0.2) * 255;
      outR.data[o + 2] = chip * 0.85 * 255;
      outR.data[o + 3] = 255;
    }
  }
  const colour = toTexture(out, SRGBColorSpace, prev?.colour);
  const normal = toTexture(outN, NoColorSpace, prev?.normal);
  const orm = toTexture(outR, NoColorSpace, prev?.orm);
  for (const t of [colour, normal, orm]) t.anisotropy = anisotropy;
  return { colour, normal, orm };
}

/** Tileable value-noise texture (R) used for edge-wear masks. Code-generated. */
export function noiseTexture(size = 256): CanvasTexture<OffscreenCanvas> {
  const img = new ImageData(size, size);
  const rnd = new Rand(77);
  const cell = 8;
  const n = size / cell;
  const grid = Array.from({ length: n * n }, () => rnd.next());
  const at = (i: number, j: number) => grid[((j + n) % n) * n + ((i + n) % n)]!;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let v = 0;
      let amp = 0.5;
      let f = 1;
      for (let o = 0; o < 3; o++) {
        const gx = (x / cell) * f;
        const gy = (y / cell) * f;
        const ix = Math.floor(gx);
        const iy = Math.floor(gy);
        const fx = smoothstep(0, 1, gx - ix);
        const fy = smoothstep(0, 1, gy - iy);
        const a = at(ix, iy);
        const b = at(ix + 1, iy);
        const c = at(ix, iy + 1);
        const d = at(ix + 1, iy + 1);
        v += amp * (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy);
        amp *= 0.5;
        f *= 2;
      }
      const o = (y * size + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = (v / 0.875) * 255;
      img.data[o + 3] = 255;
    }
  return toTexture(img, NoColorSpace);
}
