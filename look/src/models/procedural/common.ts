// Shared building blocks for the code-built models: the stepped octagonal turret base (ivory
// armour segments, gunmetal inserts, copper bolts on gunmetal feet) and part helpers.

import { Matrix4 } from 'three';
import { Builder, bolt, cbox, cyl, gear, prism, profile, tfMatrix, type Tf } from '../kit.ts';
import type { Mats } from '../materials.ts';
import type { Motion, PartDef } from '../types.ts';

export function part(name: string, b: Builder, pivot: Tf | Matrix4 = {}, motion: Motion = { kind: 'static' }, parent?: string): PartDef {
  const { geometry, material } = b.build();
  return { name, geometry, material, pivot: pivot instanceof Matrix4 ? pivot : tfMatrix(pivot), motion, parent, castShadow: true };
}

/**
 * Stepped octagonal base. r = outer radius of the armour ring (tiles). Returns the top height.
 * Eight sloped ivory segments with gunmetal inserts at the corners, on a gunmetal plinth with
 * bolted feet at the diagonals; an inner ivory step, a copper band and a toothed slewing ring.
 */
export function octBase(b: Builder, r: number, opts: { tier?: number; feet?: boolean; ring?: boolean; slit?: boolean } = {}): number {
  const tier = opts.tier ?? 0.34 * r;
  const plinthH = 0.07 * r + 0.03;
  // plinth
  b.add('trim', prism(8, r * 1.03, plinthH, 0.02, true), { ry: 0 });
  // feet with copper bolts at the four diagonals
  if (opts.feet !== false) {
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const fx = Math.cos(a) * r * 0.98;
      const fz = Math.sin(a) * r * 0.98;
      b.add('trim', cbox(0.3 * r, plinthH * 1.15, 0.26 * r, 0.02), { x: fx, z: fz, ry: -a });
      for (const s of [-1, 1]) {
        const bx = fx + Math.cos(a) * 0.06 * r - Math.sin(a) * s * 0.07 * r;
        const bz = fz + Math.sin(a) * 0.06 * r + Math.cos(a) * s * 0.07 * r;
        b.add('copper', bolt(0.05 * r + 0.012, 0.04), { x: bx, y: plinthH * 1.15, z: bz });
      }
    }
  }
  // eight armour segments: radial cross-section with a sloped top, inner radius 0.55 r
  const side = 2 * r * Math.sin(Math.PI / 8) * 0.96;
  const depth = r * 0.42;
  const segH = tier;
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const apothem = r * Math.cos(Math.PI / 8);
    const seg = profile(
      [
        [0, 0],
        [depth, 0],
        [depth, segH * 0.62],
        [depth - depth * 0.38, segH],
        [0, segH * 1.04],
      ],
      side - 0.07 * r,
      0.025,
    );
    b.add('ivory', seg, tfMatrix({ x: Math.cos(a) * (apothem - depth), y: plinthH, z: Math.sin(a) * (apothem - depth), ry: -a }));
    // gunmetal insert at the octagon corner
    const ca = a + Math.PI / 8;
    b.add('trim', cbox(0.07 * r, segH * 0.66, 0.15 * r, 0.012), { x: Math.cos(ca) * (r * 0.92), y: plinthH, z: Math.sin(ca) * (r * 0.93), ry: -ca });
    b.add('trim', cbox(0.045 * r, segH * 0.55, 0.06 * r, 0.01), { x: Math.cos(ca) * (r * 0.97), y: plinthH, z: Math.sin(ca) * (r * 0.99), ry: -ca });
  }
  if (opts.slit !== false) {
    // a small cyan status slit on the front-right segment
    const a = -Math.PI / 4;
    const ap = r * Math.cos(Math.PI / 8);
    b.add('glow', cbox(0.016, 0.035 * r, 0.12 * r, 0.004), { x: Math.cos(a) * (ap + 0.004), y: plinthH + segH * 0.42, z: Math.sin(a) * (ap + 0.004), ry: -a });
  }
  let top = plinthH + segH;
  // inner step
  b.add('ivory', prism(8, r * 0.64, segH * 0.32, 0.02), { y: plinthH + segH * 0.45 });
  top = plinthH + segH * 0.77;
  if (opts.ring !== false) {
    // copper band, gunmetal collar and the toothed slewing ring
    b.add('copper', cyl(r * 0.66, r * 0.67, 0.05 * r + 0.012, 40), { y: top - 0.01 });
    b.add('trim', cyl(r * 0.57, r * 0.57, 0.04 * r + 0.01, 32), { y: top + 0.045 * r + 0.01 });
    const gy = top + 0.085 * r + 0.02;
    b.add('trim', gear(r * 0.42, r * 0.6, 40, 0.06 * r + 0.01, 0.035 * r), { y: gy });
    // copper brackets with gunmetal latches at four points round the ring
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      b.add('copper', cbox(0.2 * r, 0.1 * r, 0.16 * r, 0.015), { x: Math.cos(a) * r * 0.68, y: top - 0.03, z: Math.sin(a) * r * 0.68, ry: -a });
      b.add('trim', cbox(0.06 * r, 0.12 * r, 0.07 * r, 0.01), { x: Math.cos(a) * r * 0.7, y: top - 0.01, z: Math.sin(a) * r * 0.7, ry: -a });
    }
    top = gy + 0.06 * r + 0.01;
  }
  return top;
}

export type { Mats };
