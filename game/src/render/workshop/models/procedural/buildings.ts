// Ported from look/src/models/procedural/buildings.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// Code-built building models. Each kind keeps a distinct silhouette (Richard is colour-blind):
// derrick (mass extractor), drum with dome (generator), crystal spike (rare extractor), glass dome
// with dish (research station), hopper with crane (depot), rollers / twin chimneys / gantry arm
// (shredder / smelter / assembler), sloped armour blocks (wall), long-barrel turret (gun), dome
// with stubby up-angled tube (area cannon), tall needle pylon (beam), heavy turret with a very
// long barrel (heavy cannon), petal cradle round an orb (shield generator).

import { Builder, bolt, cbox, cyl, gear, lathe, prism, profile, sphere, taper, torus, tubeX } from '../kit.ts';
import type { Mats } from '../materials.ts';
import type { ModelDef, PartDef } from '../types.ts';
import type { BuildingKind } from '../../../../sim/kinds.ts';
import { octBase, part } from './common.ts';
import { OctahedronGeometry } from 'three';

type Make = (m: Mats) => ModelDef;

// ---- gun turret (modelled on look/reference/02-gun-turret.png) -----------------------------------
const gun: Make = (m) => {
  const base = new Builder(m);
  const top = octBase(base, 0.96);
  const head = new Builder(m);
  // turret floor and a low gunmetal cradle
  head.add('trim', cyl(0.44, 0.46, 0.07, 28));
  head.add('trim', cbox(0.8, 0.14, 0.42, 0.02), { x: -0.08, y: 0.06 });
  // cheek armour either side: tall boxy blocks set back from the gun, angled front faces,
  // a cap plate on top, copper hinge and latch on the outer face, cyan slit on the front face
  head.mirrorZ((h) => {
    const z = 0.31;
    h.add('ivory', profile([[-0.56, 0.05], [0.1, 0.05], [0.26, 0.2], [0.26, 0.5], [0.1, 0.78], [-0.42, 0.8], [-0.6, 0.6]], 0.3, 0.035), { z });
    h.add('ivory', profile([[-0.5, 0], [0.02, 0], [0.12, 0.08], [-0.44, 0.1]], 0.26, 0.02), { y: 0.79, z: z - 0.01 });
    h.add('trim', cbox(0.36, 0.03, 0.04, 0.006), { x: -0.2, y: 0.865, z: z - 0.04 });
    h.add('copper', cbox(0.14, 0.15, 0.05, 0.015), { x: -0.47, y: 0.45, z: z + 0.15 });
    h.add('trim', cbox(0.05, 0.1, 0.03, 0.008), { x: -0.47, y: 0.46, z: z + 0.18 });
    h.add('trim', cbox(0.06, 0.16, 0.02, 0.006), { x: 0.05, y: 0.2, z: z + 0.15 });
    h.add('copper', cbox(0.07, 0.08, 0.04, 0.01), { x: 0.06, y: 0.21, z: z + 0.165 });
    h.add('glow', cbox(0.012, 0.035, 0.13, 0.004), { x: 0.262, y: 0.3, z: z + 0.04 });
    h.add('trim', cbox(0.012, 0.06, 0.17, 0.004), { x: 0.256, y: 0.285, z: z + 0.04 });
    // inner frame plate facing the gun
    h.add('trim', cbox(0.55, 0.42, 0.04, 0.01), { x: -0.18, y: 0.12, z: z - 0.17 });
  });
  // rear housing bridging the cheeks, with a top plate and dark grooves
  head.add('ivory', cbox(0.36, 0.5, 0.36, 0.03), { x: -0.38, y: 0.08 });
  head.add('ivory', cbox(0.5, 0.08, 0.36, 0.02), { x: -0.25, y: 0.74 });
  head.add('trim', cbox(0.42, 0.03, 0.035, 0.006), { x: -0.25, y: 0.8, z: 0.08 });
  head.add('trim', cbox(0.42, 0.03, 0.035, 0.006), { x: -0.25, y: 0.8, z: -0.08 });
  head.add('copper', cbox(0.12, 0.06, 0.2, 0.012), { x: -0.06, y: 0.76 });
  // mantlet: gunmetal trunnion block, copper gear hubs either side, dark trunnion discs and pins
  head.add('trim', cbox(0.3, 0.36, 0.3, 0.02), { x: 0.12, y: 0.17 });
  for (const zz of [0.12, -0.18]) {
    // smooth copper ring round a dark trunnion disc and pin
    head.add('copper', lathe([[0.13, 0], [0.23, 0], [0.24, 0.02], [0.24, 0.05], [0.23, 0.06], [0.13, 0.06]], 32), { x: 0.2, y: 0.4, z: zz, rx: Math.PI / 2 });
    head.add('trim', cyl(0.13, 0.13, 0.05, 24), { x: 0.2, y: 0.4, z: zz + 0.005, rx: Math.PI / 2 });
    head.add('trim', cyl(0.055, 0.055, 0.08, 12), { x: 0.2, y: 0.4, z: zz + (zz > 0 ? 0.0 : -0.03), rx: Math.PI / 2 });
  }
  head.add('copper', cbox(0.1, 0.1, 0.12, 0.015), { x: 0.3, y: 0.17, z: 0.0 });

  const barrel = new Builder(m);
  // ribbed breech collar, copper recoil sleeve, ivory sleeve with a dark slot, slotted muzzle brake
  barrel.add('trim', tubeX(0.16, 0.26, 22));
  for (let i = 0; i < 4; i++) barrel.add('trim', tubeX(0.168, 0.03, 22), { x: 0.02 + i * 0.06 });
  barrel.add('copper', tubeX(0.13, 0.07, 22), { x: 0.26 });
  barrel.add('trim', tubeX(0.11, 0.08, 18), { x: 0.33 });
  barrel.add('ivory', tubeX(0.095, 0.7, 22, 0.088), { x: 0.41 });
  barrel.add('void', cbox(0.36, 0.022, 0.03, 0.004), { x: 0.62, y: 0.088, ry: 0 });
  barrel.add('void', cbox(0.3, 0.03, 0.022, 0.004), { x: 0.6, z: 0.09 });
  barrel.add('trim', tubeX(0.122, 0.36, 22), { x: 1.08 });
  for (let i = 0; i < 4; i++) {
    for (const sgn of [-1, 1]) barrel.add('void', cbox(0.04, 0.13, 0.014, 0.003), { x: 1.15 + i * 0.07, y: -0.065, z: sgn * 0.115 });
    barrel.add('void', cbox(0.04, 0.014, 0.11, 0.003), { x: 1.15 + i * 0.07, y: 0.114 });
  }
  barrel.add('trim', tubeX(0.128, 0.03, 22), { x: 1.41 });
  barrel.add('void', tubeX(0.075, 0.01, 16), { x: 1.441 });
  const parts: PartDef[] = [
    part('base', base),
    part('head', head, { y: top }, { kind: 'aim' }),
    part('barrel', barrel, { x: 0.22, y: 0.4 }, { kind: 'recoil', dist: 0.12 }, 'head'),
  ];
  return { name: 'gun', parts, radius: 1.6, height: top + 0.9, muzzle: [1.66, 0.4, 0] };
};
// ---- area cannon: dome head with a stubby up-angled mortar tube ---------------------------------
const area: Make = (m) => {
  const base = new Builder(m);
  const top = octBase(base, 0.96, { tier: 0.26 });
  const head = new Builder(m);
  head.add('trim', cyl(0.46, 0.48, 0.07, 24));
  head.add('ivory', lathe([[0.001, 0.62], [0.2, 0.6], [0.38, 0.5], [0.5, 0.3], [0.52, 0.08], [0.46, 0.06], [0.001, 0.06]], 20));
  head.add('trim', torus(0.5, 0.03, 6, 28), { y: 0.2 });
  head.mirrorZ((h) => {
    h.add('trim', cyl(0.13, 0.13, 0.32, 14), { x: -0.18, y: 0.32, z: 0.42, rx: Math.PI / 2 });
    h.add('copper', torus(0.135, 0.02, 6, 16), { x: -0.18, y: 0.32, z: 0.5, rx: Math.PI / 2 });
  });
  head.add('glow', cbox(0.1, 0.025, 0.012, 0.004), { x: 0.3, y: 0.42, z: 0.36, ry: -0.7 });
  const tube = new Builder(m);
  tube.add('trim', tubeX(0.2, 0.3, 20));
  tube.add('copper', tubeX(0.21, 0.07, 20), { x: 0.28 });
  tube.add('ivory', tubeX(0.17, 0.35, 20, 0.15), { x: 0.34 });
  tube.add('trim', tubeX(0.19, 0.08, 20), { x: 0.66 });
  tube.add('void', tubeX(0.12, 0.01, 16), { x: 0.741 });
  const parts: PartDef[] = [
    part('base', base),
    part('head', head, { y: top }, { kind: 'aim' }),
    part('tube', tube, { x: 0.05, y: 0.45, rz: 0.8 }, { kind: 'recoil', dist: 0.08 }, 'head'),
  ];
  return { name: 'area', parts, radius: 1.4, height: top + 1.1, muzzle: [0.6, 0.95, 0] };
};

// ---- beam turret: tall tapered needle pylon with coil rings and a lens head -------------------
const beam: Make = (m) => {
  const base = new Builder(m);
  const top = octBase(base, 0.9, { tier: 0.24, ring: false });
  base.add('ivory', taper(prism(6, 0.42, 1.9, 0.03), 0.45), { y: top });
  base.add('trim', taper(prism(6, 0.44, 0.22, 0.02), 0.92), { y: top });
  for (let i = 0; i < 3; i++) {
    const y = top + 0.55 + i * 0.4;
    const r = 0.38 - i * 0.07;
    base.add('trim', torus(r, 0.05, 6, 24), { y });
    base.add('glow', torus(r + 0.035, 0.018, 4, 24), { y });
  }
  base.add('copper', cyl(0.17, 0.2, 0.12, 12), { y: top + 1.9 });
  const head = new Builder(m);
  head.add('trim', cyl(0.16, 0.18, 0.1, 12));
  head.mirrorZ((h) => h.add('ivory', profile([[-0.12, 0], [0.2, 0], [0.32, 0.18], [0.1, 0.32], [-0.12, 0.26]], 0.07, 0.015), { z: 0.15 }));
  head.add('crystal', new OctahedronGeometry(0.15, 0), { x: 0.12, y: 0.2, sx: 1.5 });
  head.add('glow', tubeX(0.05, 0.12, 10), { x: 0.3, y: 0.2 });
  const parts: PartDef[] = [part('base', base), part('head', head, { y: top + 2.02 }, { kind: 'aim' })];
  return { name: 'beam', parts, radius: 1.3, height: top + 2.4, muzzle: [0.42, 0.2, 0] };
};

// ---- heavy cannon: big angled armour head, very long barrel -------------------------------------
const heavy: Make = (m) => {
  const base = new Builder(m);
  const top = octBase(base, 1.42, { tier: 0.42 });
  const head = new Builder(m);
  head.add('trim', cyl(0.62, 0.66, 0.08, 28));
  head.mirrorZ((h) => {
    h.add('ivory', profile([[-0.75, 0.05], [0.4, 0.05], [0.62, 0.25], [0.55, 0.62], [0.1, 0.8], [-0.55, 0.78], [-0.8, 0.5]], 0.36, 0.04), { z: 0.34 });
    h.add('copper', cbox(0.16, 0.16, 0.06, 0.02), { x: -0.5, y: 0.45, z: 0.53 });
    h.add('trim', cbox(0.3, 0.05, 0.03, 0.008), { x: 0.0, y: 0.62, z: 0.52 });
  });
  head.add('glow', cbox(0.18, 0.035, 0.012, 0.004), { x: 0.2, y: 0.42, z: 0.53 });
  head.add('ivory', cbox(0.5, 0.5, 0.4, 0.04), { x: -0.55, y: 0.1 });
  head.add('trim', tubeX(0.24, 0.42, 20), { x: 0.08, y: 0.45, z: -0.21, ry: -Math.PI / 2 });
  head.add('copper', gear(0.1, 0.27, 22, 0.06, 0.03), { x: 0.08, y: 0.45, z: 0.12, rx: Math.PI / 2 });
  const barrel = new Builder(m);
  barrel.add('trim', tubeX(0.2, 0.3, 22));
  barrel.add('copper', tubeX(0.18, 0.1, 22), { x: 0.3 });
  barrel.add('ivory', tubeX(0.15, 1.5, 22, 0.13), { x: 0.4 });
  for (const x of [0.75, 1.25]) barrel.add('copper', tubeX(0.155, 0.05, 22), { x });
  barrel.add('void', cbox(0.9, 0.02, 0.04, 0.004), { x: 0.85, y: 0.14 });
  barrel.add('trim', tubeX(0.17, 0.48, 22), { x: 1.9 });
  for (let i = 0; i < 5; i++) for (const s of [-1, 1]) barrel.add('void', cbox(0.045, 0.18, 0.012, 0.003), { x: 1.97 + i * 0.075, y: -0.09, z: s * 0.162 });
  barrel.add('void', tubeX(0.11, 0.01, 16), { x: 2.381 });
  const parts: PartDef[] = [
    part('base', base),
    part('head', head, { y: top }, { kind: 'aim' }),
    part('barrel', barrel, { x: 0.08, y: 0.45 }, { kind: 'recoil', dist: 0.25 }, 'head'),
  ];
  return { name: 'heavy', parts, radius: 2.4, height: top + 0.9, muzzle: [2.45, 0.45, 0] };
};

// ---- shield generator: three ivory petals cradling a glowing orb, a spinning copper ring --------
const shield: Make = (m) => {
  const base = new Builder(m);
  const top = octBase(base, 0.95, { tier: 0.28, ring: false });
  base.add('trim', cyl(0.18, 0.26, 0.9, 12), { y: top });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    base.add('ivory', profile([[0.12, 0], [0.32, 0.05], [0.52, 0.5], [0.5, 1.15], [0.38, 1.3], [0.36, 0.6], [0.12, 0.25]], 0.22, 0.03), { y: top, ry: -a });
    base.add('glow', cbox(0.02, 0.4, 0.05, 0.005), { x: Math.cos(a) * 0.53, y: top + 0.6, z: Math.sin(a) * 0.53, ry: -a });
  }
  base.add('glow', sphere(0.22, 20, 14), { y: top + 1.05 });
  base.add('trim', torus(0.24, 0.025, 6, 20), { y: top + 0.86 });
  const ring = new Builder(m);
  ring.add('copper', torus(0.62, 0.035, 6, 36));
  for (let i = 0; i < 6; i++) ring.add('trim', cbox(0.1, 0.06, 0.06, 0.01), { x: Math.cos((i * Math.PI) / 3) * 0.62, y: -0.03, z: Math.sin((i * Math.PI) / 3) * 0.62 });
  const parts: PartDef[] = [part('base', base), part('ring', ring, { y: top + 1.05, rx: 0.35 }, { kind: 'spin', axis: 'y', speed: 0.8 })];
  return { name: 'shield', parts, radius: 1.3, height: top + 1.6 };
};

// ---- mass extractor: drilling derrick on an armoured collar ------------------------------------
const massExtractor: Make = (m) => {
  const b = new Builder(m);
  const top = octBase(b, 0.92, { tier: 0.22, ring: false, slit: false });
  b.add('ivory', taper(cbox(0.86, 1.55, 0.86, 0.04, 0.12), 0.42), { y: top });
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) b.add('trim', cyl(0.035, 0.04, 1.65, 6), { x: x * 0.36, y: top, z: z * 0.36, rx: z * 0.17, rz: -x * 0.17 });
  b.add('trim', cbox(0.42, 0.28, 0.42, 0.03), { y: top + 1.5 });
  b.add('copper', cbox(0.2, 0.12, 0.46, 0.02), { y: top + 1.62 });
  b.add('glow', torus(0.27, 0.016, 4, 20), { y: top + 1.0 });
  b.add('glow', cbox(0.012, 0.25, 0.08, 0.003), { x: 0.36, y: top + 0.4 });
  // ore hopper and feed pipe
  b.add('ivory', taper(cbox(0.48, 0.42, 0.4, 0.03), 1.15), { x: -0.62, y: top - 0.1, z: 0.35 });
  b.add('trim', tubeX(0.06, 0.4, 10), { x: -0.55, y: top + 0.25, z: 0.35 });
  for (const s of [-1, 1]) b.add('copper', bolt(0.05, 0.03), { x: -0.62 + s * 0.15, y: top + 0.32, z: 0.35 });
  const piston = new Builder(m);
  piston.add('trim', cyl(0.09, 0.09, 1.1, 12));
  piston.add('copper', cyl(0.12, 0.12, 0.1, 12), { y: 0.95 });
  const parts: PartDef[] = [part('base', b), part('piston', piston, { y: top + 0.5 }, { kind: 'bob', amp: 0.18, rate: 0.6 })];
  return { name: 'massExtractor', parts, radius: 1.3, height: top + 1.8 };
};

// ---- generator: armoured reactor drum with a glass dome and a spinning vane ring ----------------
const generator: Make = (m) => {
  const b = new Builder(m);
  const top = octBase(b, 0.95, { tier: 0.2, ring: false, slit: false });
  b.add('ivory', lathe([[0.001, 0], [0.64, 0], [0.66, 0.15], [0.66, 0.9], [0.6, 1.05], [0.56, 1.1], [0.001, 1.1]], 28), { y: top });
  for (const y of [0.3, 0.75]) b.add('trim', torus(0.67, 0.035, 6, 32), { y: top + y });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.add('glow', cbox(0.02, 0.36, 0.05, 0.005), { x: Math.cos(a) * 0.665, y: top + 0.36, z: Math.sin(a) * 0.665, ry: -a });
    b.add('copper', cbox(0.06, 0.08, 0.1, 0.01), { x: Math.cos(a) * 0.67, y: top + 0.95, z: Math.sin(a) * 0.67, ry: -a });
  }
  b.add('glass', sphere(0.42, 20, 10, Math.PI / 2), { y: top + 1.1 });
  b.mirrorZ((h) => {
    for (let i = 0; i < 5; i++) h.add('trim', cbox(0.42, 0.5, 0.025, 0.006), { y: top + 0.15, z: 0.72 + i * 0.045 });
    h.add('trim', cbox(0.5, 0.06, 0.24, 0.01), { y: top + 0.65, z: 0.8 });
  });
  const vane = new Builder(m);
  vane.add('trim', torus(0.5, 0.03, 6, 28));
  for (let i = 0; i < 3; i++) vane.add('ivory', cbox(0.5, 0.03, 0.08, 0.01), { x: Math.cos((i * 2 * Math.PI) / 3) * 0.25, z: Math.sin((i * 2 * Math.PI) / 3) * 0.25, ry: -(i * 2 * Math.PI) / 3 });
  vane.add('copper', cyl(0.08, 0.08, 0.08, 12), { y: -0.04 });
  const parts: PartDef[] = [part('base', b), part('vane', vane, { y: top + 1.42 }, { kind: 'spin', axis: 'y', speed: 1.4 })];
  return { name: 'generator', parts, radius: 1.3, height: top + 1.5 };
};

// ---- rare extractor: crystal tap spike held by three claws --------------------------------------
const rareExtractor: Make = (m) => {
  const b = new Builder(m);
  b.add('trim', prism(6, 0.95, 0.08, 0.02));
  b.add('ivory', prism(6, 0.85, 0.24, 0.04), { y: 0.08 });
  b.add('glow', torus(0.42, 0.02, 4, 24), { y: 0.33 });
  b.add('crystal', new OctahedronGeometry(0.34, 0), { y: 1.25, sy: 3.2 });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.3;
    b.add('ivory', profile([[0.25, 0], [0.62, 0], [0.55, 0.9], [0.28, 1.7], [0.2, 1.65], [0.38, 0.85]], 0.14, 0.02), { y: 0.32, ry: -a });
    b.add('copper', cbox(0.08, 0.08, 0.18, 0.01), { x: Math.cos(a) * 0.5, y: 0.9, z: Math.sin(a) * 0.5, ry: -a });
  }
  return { name: 'rareExtractor', parts: [part('base', b)], radius: 1.3, height: 2.5 };
};

// ---- research station: glass dome with ivory ribs and a spinning dish ---------------------------
const lab: Make = (m) => {
  const b = new Builder(m);
  b.add('trim', cbox(2.9, 0.08, 2.9, 0.02, 0.4));
  b.add('ivory', cbox(2.6, 0.42, 2.6, 0.05, 0.45), { y: 0.08 });
  b.add('glass', sphere(0.95, 28, 14, Math.PI / 2), { x: 0.2, y: 0.5, z: 0.1 });
  for (let i = 0; i < 4; i++) {
    const rib = torus(0.97, 0.04, 6, 32);
    rib.rotateX(Math.PI / 2);
    b.add('ivory', rib, { x: 0.2, y: 0.5, z: 0.1, ry: (i * Math.PI) / 4 }, { wear: false });
  }
  b.add('glow', torus(0.98, 0.02, 4, 40), { x: 0.2, y: 0.52, z: 0.1 });
  b.add('ivory', cbox(0.8, 0.55, 0.7, 0.04), { x: -0.85, y: 0.5, z: -0.8 });
  b.add('trim', cbox(0.5, 0.2, 0.5, 0.02), { x: -0.85, y: 1.05, z: -0.8 });
  b.add('glow', cbox(0.012, 0.05, 0.4, 0.003), { x: -0.444, y: 0.75, z: -0.8 });
  b.add('trim', cyl(0.06, 0.08, 1.0, 8), { x: 0.95, y: 0.5, z: -0.95 });
  const dish = new Builder(m);
  dish.add('ivory', lathe([[0.001, 0.0], [0.15, 0.02], [0.32, 0.09], [0.42, 0.18], [0.4, 0.19], [0.001, 0.03]], 20), { rz: 0.6 });
  dish.add('trim', cyl(0.02, 0.02, 0.3, 6), { rz: 0.6 });
  dish.add('copper', cyl(0.06, 0.06, 0.08, 10), { y: -0.04 });
  const parts: PartDef[] = [part('base', b), part('dish', dish, { x: 0.95, y: 1.55, z: -0.95 }, { kind: 'spin', axis: 'y', speed: 0.5 })];
  return { name: 'lab', parts, radius: 2, height: 1.8 };
};

// ---- salvage depot: open hopper with scrap and a crane arm --------------------------------------
const depot: Make = (m) => {
  const b = new Builder(m);
  b.add('trim', cbox(1.9, 0.08, 1.9, 0.02, 0.2));
  const walls: Array<[number, number, number, number]> = [
    [0, 0.72, 1.7, 0.16],
    [0, -0.72, 1.7, 0.16],
  ];
  for (const [x, z, w, d] of walls) b.add('ivory', cbox(w, 0.7, d, 0.04), { x, y: 0.08, z });
  for (const x of [0.72, -0.72]) b.add('ivory', cbox(0.16, 0.7, 1.3, 0.04), { x, y: 0.08 });
  b.add('trim', cbox(1.3, 0.25, 1.3, 0.02), { y: 0.08 });
  // scrap pile
  const rnd = (i: number) => Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
  for (let i = 0; i < 14; i++) b.add(i % 3 ? 'hull' : 'copper', cbox(0.2 + rnd(i) * 0.25, 0.12 + rnd(i + 3) * 0.15, 0.16 + rnd(i + 5) * 0.2, 0.02), { x: (rnd(i + 7) - 0.5) * 1.0, y: 0.3 + rnd(i + 9) * 0.15, z: (rnd(i + 11) - 0.5) * 1.0, ry: rnd(i + 13) * 3, rz: (rnd(i + 2) - 0.5) * 0.6 });
  for (const z of [0.72, -0.72]) b.add('trim', cbox(1.75, 0.06, 0.2, 0.01), { y: 0.78, z });
  b.add('glow', cbox(0.6, 0.03, 0.012, 0.004), { y: 0.55, z: 0.806 });
  // crane
  b.add('trim', cyl(0.08, 0.1, 1.5, 10), { x: -0.75, y: 0.78, z: 0.75 });
  b.add('copper', cbox(1.3, 0.1, 0.12, 0.02), { x: -0.25, y: 2.2, z: 0.6, ry: 0.4, rz: -0.25 });
  b.add('trim', cyl(0.012, 0.012, 0.9, 4), { x: 0.3, y: 1.45, z: 0.35 });
  return { name: 'depot', parts: [part('base', b)], radius: 1.4, height: 2.3 };
};

// ---- chain machines --------------------------------------------------------------------------
function machineBody(b: Builder, h: number) {
  b.add('trim', cbox(1.9, 0.08, 1.8, 0.02, 0.2));
  b.add('ivory', cbox(1.65, h, 1.55, 0.05, 0.18), { y: 0.08 });
  b.add('trim', cbox(1.7, 0.08, 1.6, 0.02, 0.18), { y: 0.08 + h * 0.45 });
  // belt ports on ±X
  for (const s of [-1, 1]) b.add('trim', cbox(0.12, 0.3, 0.7, 0.02), { x: s * 0.85, y: 0.12 });
}

const shredder: Make = (m) => {
  const b = new Builder(m);
  machineBody(b, 0.55);
  b.add('trim', taper(cbox(1.2, 0.45, 1.1, 0.03), 1.35), { y: 0.63 });
  b.add('glow', cbox(0.012, 0.04, 0.6, 0.004), { x: 0.83, y: 0.4 });
  const rollA = new Builder(m);
  rollA.add('hull', cyl(0.2, 0.2, 0.9, 12), { rx: Math.PI / 2, z: -0.45 });
  for (let i = 0; i < 6; i++) rollA.add('copper', torus(0.21, 0.025, 4, 12), { z: -0.35 + i * 0.14, rx: Math.PI / 2 });
  const rollB = new Builder(m);
  rollB.add('hull', cyl(0.2, 0.2, 0.9, 12), { rx: Math.PI / 2, z: -0.45 });
  const parts: PartDef[] = [
    part('base', b),
    part('rollA', rollA, { x: -0.21, y: 0.95 }, { kind: 'spin', axis: 'z', speed: 3 }),
    part('rollB', rollB, { x: 0.21, y: 0.95 }, { kind: 'spin', axis: 'z', speed: -3 }),
  ];
  return { name: 'shredder', parts, radius: 1.3, height: 1.2 };
};

const smelter: Make = (m) => {
  const b = new Builder(m);
  machineBody(b, 0.8);
  for (const z of [-0.35, 0.35]) {
    b.add('trim', cyl(0.17, 0.22, 1.5, 14), { x: -0.35, y: 0.88, z });
    b.add('copper', torus(0.2, 0.03, 6, 16), { x: -0.35, y: 1.3, z });
    b.add('hot', torus(0.15, 0.03, 6, 16), { x: -0.35, y: 2.36, z });
  }
  b.add('hot', cbox(0.012, 0.12, 0.5, 0.004), { x: 0.83, y: 0.35 });
  b.add('ivory', taper(cbox(0.7, 0.4, 1.2, 0.04), 0.7), { x: 0.4, y: 0.88 });
  return { name: 'smelter', parts: [part('base', b)], radius: 1.3, height: 2.4 };
};

const assembler: Make = (m) => {
  const b = new Builder(m);
  machineBody(b, 0.6);
  for (const z of [-0.7, 0.7]) b.add('trim', cbox(0.12, 1.1, 0.12, 0.02), { x: 0, y: 0.68, z });
  b.add('trim', cbox(0.16, 0.14, 1.55, 0.02), { y: 1.75 });
  b.add('glow', cbox(0.6, 0.03, 0.012, 0.004), { y: 0.45, z: 0.786 });
  const arm = new Builder(m);
  arm.add('copper', cyl(0.1, 0.12, 0.12, 12));
  arm.add('ivory', cbox(0.6, 0.12, 0.14, 0.03), { x: 0.25, y: -0.05, rz: -0.5 });
  arm.add('ivory', cbox(0.45, 0.1, 0.12, 0.03), { x: 0.5, y: -0.45, rz: 0.9 });
  arm.add('trim', cyl(0.05, 0.03, 0.15, 8), { x: 0.42, y: -0.62 });
  const parts: PartDef[] = [part('base', b), part('arm', arm, { y: 1.68 }, { kind: 'spin', axis: 'y', speed: 0.7 })];
  return { name: 'assembler', parts, radius: 1.3, height: 1.9 };
};

// ---- belt piece (1 tile, runs along +X) --------------------------------------------------------
const belt: Make = (m) => {
  const b = new Builder(m);
  for (const z of [-0.36, 0.36]) {
    b.add('trim', cbox(1.0, 0.1, 0.08, 0.015, 0), { y: 0.18, z });
    b.add('ivory', cbox(1.0, 0.06, 0.1, 0.015, 0), { y: 0.28, z: z * 1.04 }, { wear: false });
  }
  for (const x of [-0.3, 0.3]) for (const z of [-0.36, 0.36]) b.add('trim', cbox(0.08, 0.18, 0.08, 0.01), { x, z });
  b.add('belt', cbox(1.0, 0.04, 0.62, 0.0, 0), { y: 0.21 });
  for (const x of [-0.45, 0, 0.45]) b.add('trim', cyl(0.05, 0.05, 0.64, 8), { x, y: 0.2, z: -0.32, rx: Math.PI / 2 });
  return { name: 'belt', parts: [part('base', b)], radius: 0.8, height: 0.35 };
};

// ---- wall (1 tile along X; diagonal instances are stretched by the scene) -----------------------
const wallModel: Make = (m) => {
  const b = new Builder(m);
  b.add('trim', cbox(1.0, 0.12, 0.92, 0.02, 0));
  // cross-section in the YZ plane: sloped faces either side. Built as a profile along X.
  const sec = profile(
    [
      [-0.44, 0],
      [0.44, 0],
      [0.3, 1.05],
      [0.2, 1.2],
      [-0.2, 1.2],
      [-0.3, 1.05],
    ],
    1.0,
    0,
  );
  sec.rotateY(Math.PI / 2);
  b.add('ivory', sec, { y: 0.1 });
  b.add('trim', cbox(1.0, 0.1, 0.46, 0.02, 0), { y: 1.3 });
  b.add('glow', cbox(1.0, 0.03, 0.05, 0.0, 0), { y: 1.4 });
  b.mirrorZ((h) => {
    h.add('trim', cbox(0.08, 0.95, 0.06, 0.01), { x: 0.47, y: 0.12, z: 0.36, rx: -0.13 });
    h.add('copper', bolt(0.035, 0.02), { x: 0.3, y: 0.9, z: 0.27, rx: -1.2 });
    h.add('copper', bolt(0.035, 0.02), { x: -0.3, y: 0.9, z: 0.27, rx: -1.2 });
  });
  return { name: 'wall', parts: [part('base', b)], radius: 1, height: 1.45 };
};

// tier 3 wall: a taller reinforced tower segment in the wall line
export const wallTower: Make = (m) => {
  const b = new Builder(m);
  b.add('trim', cbox(1.1, 0.14, 1.1, 0.02, 0.1));
  b.add('ivory', taper(cbox(1.06, 2.1, 1.06, 0.05, 0.16), 0.78), { y: 0.12 });
  b.add('trim', cbox(0.9, 0.14, 0.9, 0.02, 0.14), { y: 2.2 });
  b.add('ivory', taper(cbox(0.78, 0.4, 0.78, 0.04, 0.12), 0.6), { y: 2.34 });
  b.add('glow', cbox(0.86, 0.04, 0.86, 0, 0.13), { y: 1.62 });
  b.add('trim', cbox(0.9, 0.12, 0.9, 0.015, 0.13), { y: 1.5 });
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    b.add('copper', cbox(0.05, 0.22, 0.24, 0.01), { x: Math.cos(a) * 0.5, y: 0.5, z: Math.sin(a) * 0.5, ry: -a });
    b.add('trim', cbox(0.04, 0.6, 0.1, 0.008), { x: Math.cos(a) * 0.48, y: 0.85, z: Math.sin(a) * 0.48, ry: -a, rz: 0.06 });
  }
  b.add('trim', cyl(0.03, 0.03, 0.6, 6), { x: 0.2, y: 2.7, z: 0.2 });
  b.add('glow', sphere(0.05, 8, 6), { x: 0.2, y: 3.32, z: 0.2 });
  return { name: 'wallTower', parts: [part('base', b)], radius: 1.2, height: 3.4 };
};

const tempTurret: Make = (m) => gun(m);

// W24 placeholder so look/ keeps compiling against the game's BuildingKind: a plain box per pylon
// either side of an open centre. The real gate (W23 walls/gate.ts) is ported in W24 run 2.
const gatePlaceholder: Make = (m) => {
  const b = new Builder(m);
  b.add('ivory', cbox(1, 1.3, 1, 0.02), { x: -1 });
  b.add('ivory', cbox(1, 1.3, 1, 0.02), { x: 1 });
  b.add('trim', cbox(3, 0.2, 0.6, 0.02), { y: 1.4 });
  return { name: 'gate', parts: [part('base', b)], radius: 1.6, height: 1.6 };
};

export const BUILDING_MAKERS: Record<BuildingKind, Make> = {
  massExtractor,
  generator,
  rareExtractor,
  lab,
  depot,
  shredder,
  smelter,
  assembler,
  wall: wallModel,
  gun,
  area,
  beam,
  heavy,
  shield,
  tempTurret,
  belt,
  splitter: belt,
  merger: belt,
  gate: gatePlaceholder,
};
