// Commander (two-legged ivory mech, as in the greybox) and engineers (hover drones).

import { Builder, cbox, cyl, lathe, profile, sphere, torus, tubeX } from '../kit.ts';
import type { Mats } from '../materials.ts';
import type { ModelDef } from '../types.ts';
import { part } from './common.ts';

export function commander(m: Mats): ModelDef {
  const body = new Builder(m);
  // hips and legs (static stance, the whole body bobs)
  body.add('trim', cbox(0.5, 0.3, 0.7, 0.04), { y: 1.05 });
  body.mirrorZ((b) => {
    b.add('ivory', profile([[-0.2, 0.6], [0.18, 0.6], [0.22, 1.05], [-0.14, 1.12]], 0.2, 0.03), { z: 0.38 });
    b.add('trim', cyl(0.08, 0.1, 0.62, 10), { y: 0.05, z: 0.4, rx: 0.06 });
    b.add('ivory', profile([[-0.22, 0.0], [0.34, 0.0], [0.3, 0.12], [0.05, 0.22], [-0.2, 0.18]], 0.3, 0.03), { z: 0.42 });
    b.add('copper', cyl(0.11, 0.11, 0.08, 12), { y: 0.62, z: 0.4, rx: Math.PI / 2 });
  });
  // torso
  body.add('ivory', profile([[-0.45, 1.25], [0.35, 1.25], [0.55, 1.5], [0.48, 1.95], [0.1, 2.15], [-0.4, 2.1], [-0.55, 1.7]], 0.85, 0.05));
  body.add('glass', cbox(0.08, 0.14, 0.42, 0.02), { x: 0.5, y: 1.72 });
  body.add('glow', cbox(0.02, 0.035, 0.36, 0.006), { x: 0.545, y: 1.78 });
  body.add('trim', cbox(0.5, 0.55, 0.6, 0.04), { x: -0.62, y: 1.4 });
  body.add('copper', cyl(0.08, 0.08, 0.3, 10), { x: -0.7, y: 1.95, z: 0.15 });
  body.add('copper', cyl(0.06, 0.06, 0.45, 10), { x: -0.7, y: 1.95, z: -0.15 });
  // shoulder weapon pods
  body.mirrorZ((b) => {
    b.add('ivory', cbox(0.6, 0.32, 0.3, 0.05), { y: 1.75, z: 0.6 });
    b.add('trim', tubeX(0.06, 0.45, 10), { x: 0.25, y: 1.86, z: 0.56 });
    b.add('trim', tubeX(0.06, 0.45, 10), { x: 0.25, y: 1.86, z: 0.66 });
    b.add('glow', cbox(0.02, 0.03, 0.18, 0.005), { x: 0.305, y: 1.8, z: 0.6 });
  });
  return { name: 'commander', parts: [part('body', body, {}, { kind: 'bob', amp: 0.03, rate: 0.5 })], radius: 1.4, height: 2.3 };
}

export function engineer(m: Mats): ModelDef {
  const b = new Builder(m);
  b.add('ivory', lathe([[0.001, 0.0], [0.34, 0.02], [0.42, 0.12], [0.36, 0.24], [0.2, 0.3], [0.001, 0.3]], 16));
  b.add('glow', torus(0.3, 0.025, 4, 20), { y: 0.0 });
  b.add('trim', cbox(0.26, 0.18, 0.24, 0.03), { x: -0.05, y: 0.28 });
  b.add('glass', sphere(0.09, 10, 6), { x: 0.1, y: 0.4 });
  b.add('copper', cbox(0.35, 0.05, 0.06, 0.01), { x: 0.3, y: 0.2, z: 0.12, rz: -0.4 });
  b.add('trim', cyl(0.02, 0.02, 0.25, 6), { x: 0.44, y: 0.0, z: 0.12 });
  return { name: 'engineer', parts: [part('body', b, { y: 0.45 }, { kind: 'bob', amp: 0.08, rate: 0.9 })], radius: 0.6, height: 0.9 };
}
