// W24 run 2b: wallLayout.ts leafMatrices writes W23's door leaves (look/src/w23/walls/layout.ts
// leafOffsets, placed by walls/geometry.ts wallMatrix) without allocating; it must place them
// exactly where W23 does, at every opening and turn.

import { Matrix4 } from 'three';
import { describe, expect, it } from 'vitest';
import { leafMatrices } from '../src/render/wallLayout.ts';
import { wallMatrix } from '../src/render/workshop/w23/walls/geometry.ts';
import { leafOffsets } from '../src/render/workshop/w23/walls/layout.ts';

describe('gate door leaves', () => {
  it('match W23 leafOffsets + wallMatrix for every opening and rotation', () => {
    const out = new Float32Array(64);
    const m = new Matrix4();
    for (const rot of [-1, 0, 1, 2, 3, 5])
      for (const open of [-0.2, 0, 0.25, 0.5, 1, 1.4]) {
        const f = { cx: 40.5, y: 1.25, cz: 61.5, rot };
        leafMatrices(f, open, out);
        leafOffsets(open).forEach((off, k) => {
          wallMatrix(m, f.cx, f.y, f.cz, f.rot, off);
          for (let i = 0; i < 16; i++) expect(out[k * 16 + i], `rot ${rot} open ${open} leaf ${k} [${i}]`).toBeCloseTo(m.elements[i]!, 5);
        });
      }
  });
});
