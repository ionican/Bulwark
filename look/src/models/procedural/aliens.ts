// Alien machines: dark gunmetal hulls with orange glow. Distinct silhouettes (Richard is
// colour-blind), following the greybox shape language:
//   rusher   — small low wedge on four walking legs (numerous)
//   hunter   — slim dart over a hover disc with rear fins (fast, fragile)
//   breaker  — big armoured block on two treads with a spiked ram (slow, heavy)
//   saboteur — flattened diamond on short treads with a tall antenna and a drill (economy raider)

import { OctahedronGeometry } from 'three';
import { Builder, cbox, cyl, profile, sphere, taper, torus, tubeX } from '../kit.ts';
import type { Mats } from '../materials.ts';
import type { ModelDef, PartDef } from '../types.ts';
import type { AlienKind } from '../../world/layout.ts';
import { part } from './common.ts';

function rusher(m: Mats): ModelDef {
  const body = new Builder(m);
  body.add('hull', profile([[-0.38, 0.0], [0.42, 0.04], [0.2, 0.2], [-0.3, 0.24]], 0.4, 0.03));
  body.add('hull', taper(cbox(0.3, 0.12, 0.3, 0.02), 0.6), { x: -0.1, y: 0.22 });
  body.add('alienGlow', cbox(0.05, 0.025, 0.18, 0.006), { x: 0.36, y: 0.08 });
  body.add('trim', cbox(0.12, 0.04, 0.44, 0.01), { x: -0.05, y: -0.02 });
  const parts: PartDef[] = [part('body', body, { y: 0.32 }, { kind: 'bob', amp: 0.025, rate: 4 })];
  const leg = () => {
    const l = new Builder(m);
    l.add('hull', cbox(0.05, 0.22, 0.05, 0.01), { y: -0.2, rz: 0.25 });
    l.add('trim', cbox(0.04, 0.2, 0.04, 0.01), { x: 0.05, y: -0.36, rz: -0.35 });
    return l;
  };
  let i = 0;
  // Diagonal pairs move together (trot gait).
  for (const x of [0.2, -0.2]) for (const z of [0.22, -0.22]) parts.push(part(`leg${i++}`, leg(), { x, y: 0.32, z }, { kind: 'gait', phase: x > 0 === z > 0 ? 0 : Math.PI, swing: 0.55, lift: 0.06 }));
  return { name: 'rusher', parts, radius: 0.5, height: 0.6 };
}

function hunter(m: Mats): ModelDef {
  const b = new Builder(m);
  b.add('hull', cyl(0.36, 0.3, 0.07, 16), { y: 0.0 });
  b.add('alienGlow', torus(0.32, 0.02, 4, 18), { y: -0.01 });
  const dart = new OctahedronGeometry(0.2, 0);
  b.add('hull', dart, { x: 0.15, y: 0.3, sx: 3.6, sy: 0.9, sz: 1.0 });
  b.add('trim', cbox(0.3, 0.05, 0.9, 0.02), { x: -0.3, y: 0.3 });
  b.mirrorZ((h) => h.add('hull', profile([[-0.55, 0.25], [-0.2, 0.3], [-0.4, 0.62]], 0.03, 0.005), { z: 0.18 }));
  b.add('alienGlow', tubeX(0.06, 0.04, 8), { x: -0.62, y: 0.3 });
  b.add('alienGlow', cbox(0.08, 0.02, 0.1, 0.005), { x: 0.5, y: 0.36 });
  return { name: 'hunter', parts: [part('body', b, { y: 0.25 }, { kind: 'bob', amp: 0.07, rate: 1.6 })], radius: 0.8, height: 0.9 };
}

function breaker(m: Mats): ModelDef {
  const body = new Builder(m);
  body.add('hull', taper(cbox(1.5, 0.75, 1.05, 0.06, 0.15), 0.85), { y: 0.3 });
  body.add('hull', cbox(0.8, 0.3, 0.75, 0.05), { x: -0.25, y: 1.0 });
  body.add('alienGlow', cbox(0.3, 0.05, 0.6, 0.01), { x: -0.25, y: 1.3 });
  // ram: a wedge with spikes
  body.add('hull', profile([[0.6, 0.3], [1.05, 0.35], [1.25, 0.6], [1.05, 0.9], [0.6, 1.0]], 1.0, 0.05));
  for (const z of [-0.3, 0, 0.3]) body.add('trim', cyl(0.0, 0.08, 0.32, 6), { x: 1.33, y: 0.62, z, rz: -Math.PI / 2 });
  body.add('alienGlow', cbox(0.04, 0.05, 0.7, 0.01), { x: 0.76, y: 0.82 });
  body.mirrorZ((b) => {
    b.add('trim', cbox(1.8, 0.42, 0.28, 0.05, 0.12), { y: 0.0, z: 0.62 });
    b.add('hull', cbox(1.5, 0.1, 0.34, 0.03), { y: 0.42, z: 0.62 });
  });
  const parts: PartDef[] = [part('body', body, { y: 0.05 }, { kind: 'bob', amp: 0.02, rate: 2.2 })];
  let i = 0;
  for (const z of [0.79, -0.79])
    for (const x of [-0.6, -0.2, 0.2, 0.6]) {
      const w = new Builder(m);
      w.add('trim', cyl(0.17, 0.17, 0.06, 10), { rx: Math.PI / 2, z: -0.03 });
      w.add('hull', cbox(0.05, 0.3, 0.07, 0.005), { y: -0.15, z: -0.035 });
      parts.push(part(`wheel${i++}`, w, { x, y: 0.22, z }, { kind: 'spin', axis: 'z', speed: -2.2 }));
    }
  return { name: 'breaker', parts, radius: 1.6, height: 1.4 };
}

function saboteur(m: Mats): ModelDef {
  const body = new Builder(m);
  body.add('hull', new OctahedronGeometry(0.45, 0), { y: 0.3, sy: 0.42, sx: 1.25 });
  body.mirrorZ((b) => b.add('trim', cbox(0.75, 0.2, 0.13, 0.03, 0.06), { y: 0.0, z: 0.3 }));
  body.add('trim', cyl(0.018, 0.025, 0.95, 5), { x: -0.2, y: 0.4 });
  body.add('alienGlow', sphere(0.05, 8, 6), { x: -0.2, y: 1.37 });
  body.add('trim', torus(0.08, 0.012, 4, 10), { x: -0.2, y: 1.1 });
  body.add('alienGlow', cbox(0.04, 0.03, 0.2, 0.006), { x: 0.5, y: 0.34 });
  const drill = new Builder(m);
  drill.add('trim', tubeX(0.1, 0.32, 8, 0.0));
  drill.add('copper', torus(0.09, 0.02, 4, 10), { rz: Math.PI / 2 });
  const parts: PartDef[] = [
    part('body', body, { y: 0.12 }, { kind: 'bob', amp: 0.015, rate: 3 }),
    part('drill', drill, { x: 0.52, y: 0.38 }, { kind: 'spin', axis: 'x', speed: 9 }),
  ];
  return { name: 'saboteur', parts, radius: 0.7, height: 1.5 };
}

export const ALIEN_MAKERS: Record<AlienKind, (m: Mats) => ModelDef> = { rusher, hunter, breaker, saboteur };
