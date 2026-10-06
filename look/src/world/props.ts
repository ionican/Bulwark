// Ground props: ore chunks on mass deposits, pale crystal clusters on the rare points and
// scattered through the canyons, and fallen boulders at the foot of cliffs. Instanced.

import { BufferAttribute, Euler, Group, IcosahedronGeometry, InstancedMesh, Matrix4, OctahedronGeometry, Quaternion, Vector3, type BufferGeometry, type Material } from 'three';
import { Rand } from '../noise.ts';
import { Builder, cbox, cyl } from '../models/kit.ts';
import type { Mats } from '../models/materials.ts';
import { field, heightAt, WATER_LEVEL } from './heightfield.ts';
import { terrain } from './layout.ts';

function lumpy(detail: number, seed: number, amount: number): BufferGeometry {
  const g = new IcosahedronGeometry(1, detail);
  const p = g.getAttribute('position') as BufferAttribute;
  const r = new Rand(seed);
  const cache = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let k = cache.get(key);
    if (k === undefined) cache.set(key, (k = 1 + r.range(-amount, amount)));
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.7, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

function instanced(geo: BufferGeometry, mat: Material | Material[], mats: Matrix4[]): InstancedMesh {
  const m = new InstancedMesh(geo, mat, Math.max(1, mats.length));
  mats.forEach((x, i) => m.setMatrixAt(i, x));
  m.count = mats.length;
  m.castShadow = true;
  m.receiveShadow = true;
  m.computeBoundingSphere();
  return m;
}

export function buildProps(mats: Mats): Group {
  const g = new Group();
  const r = new Rand(4242);
  const q = new Quaternion();
  const M = (x: number, y: number, z: number, s: [number, number, number], yaw = r.range(0, 6.28), tilt = 0.3) => {
    q.setFromEuler(new Euler(r.range(-tilt, tilt), yaw, r.range(-tilt, tilt), 'YXZ'));
    return new Matrix4().compose(new Vector3(x, y, z), q.clone(), new Vector3(...s));
  };

  // ore on mass deposits
  const ore: Matrix4[] = [];
  for (const d of terrain.deposits) {
    if (d.kind !== 'mass') continue;
    const cx = d.tx + 1;
    const cz = d.ty + 1;
    for (let i = 0; i < 16; i++) {
      const a = r.range(0, 6.28);
      const rr = r.range(1.0, 2.2);
      const x = cx + Math.cos(a) * rr;
      const z = cz + Math.sin(a) * rr;
      const s = r.range(0.08, 0.22);
      ore.push(M(x, heightAt(x, z) + s * 0.2, z, [s, s * r.range(0.8, 1.5), s]));
    }
  }
  const oreGeo = new Builder(mats).add('ore', lumpy(0, 3, 0.25)).build().geometry;
  g.add(instanced(oreGeo, mats.ore, ore));

  // crystals: on the rare points and scattered in the canyons
  const crystals: Matrix4[] = [];
  const cluster = (cx: number, cz: number, n: number, size: number) => {
    for (let i = 0; i < n; i++) {
      const a = r.range(0, 6.28);
      const rr = r.range(0, 1.4) * size;
      const x = cx + Math.cos(a) * rr;
      const z = cz + Math.sin(a) * rr;
      const h = r.range(0.6, 2.2) * size;
      const w = r.range(0.12, 0.28) * size;
      crystals.push(M(x, heightAt(x, z) - 0.1, z, [w, h, w], r.range(0, 6.28), 0.45));
    }
  };
  for (const d of terrain.deposits) if (d.kind === 'rare') cluster(d.tx + 1, d.ty + 1, 22, 1.1);
  for (let k = 0; k < 400 && crystals.length < 600; k++) {
    const x = r.range(-20, 230);
    const z = r.range(-120, 200);
    const s = field.sample(x, z);
    if (s.h > -6.5 || s.h < WATER_LEVEL + 0.3) continue;
    if (field.pathDist(x, z) < 7) continue;
    cluster(x, z, 6 + r.int(10), r.range(0.6, 1.3));
  }
  const cg = new OctahedronGeometry(1, 0);
  cg.translate(0, 1, 0);
  cg.scale(1, 0.5, 1);
  g.add(instanced(new Builder(mats).add('crystal', cg, {}, { wear: false }).build().geometry, mats.crystal, crystals));

  // boulders at cliff feet and scattered
  const boulders: Matrix4[] = [];
  for (let k = 0; k < 6000 && boulders.length < 700; k++) {
    const x = r.range(-40, 240);
    const z = r.range(-140, 220);
    const h0 = heightAt(x, z);
    const slope = Math.abs(heightAt(x + 1.2, z) - heightAt(x - 1.2, z)) + Math.abs(heightAt(x, z + 1.2) - heightAt(x, z - 1.2));
    if (Math.hypot(x - 64, z - 64) < 28) continue;
    if (field.pathDist(x, z) < 5) continue;
    if (slope < 0.5 || slope > 2.2 || h0 < WATER_LEVEL + 0.2) continue;
    const s = r.range(0.2, 0.9);
    boulders.push(M(x, h0 - s * 0.15, z, [s * r.range(0.8, 1.6), s, s * r.range(0.8, 1.4)], r.range(0, 6.28), 0.6));
  }
  const bGeo = lumpy(1, 9, 0.3);
  g.add(instanced(new Builder(mats).add('rock', bGeo, {}, { wear: false }).build().geometry, mats.rock, boulders));
  return g;
}


/** Base clutter: supply crates and lamp posts in the gaps between buildings and conduits. */
export function buildClutter(mats: Mats, footprints: Array<{ x0: number; z0: number; x1: number; z1: number }>, lines: Array<Array<[number, number]>>): Group {
  const g = new Group();
  const r = new Rand(77);
  const free = (x: number, z: number, m: number) => {
    for (const f of footprints) if (x > f.x0 - m && x < f.x1 + m && z > f.z0 - m && z < f.z1 + m) return false;
    for (const l of lines)
      for (let i = 0; i + 1 < l.length; i++) {
        const [ax, az] = l[i]!;
        const [bx, bz] = l[i + 1]!;
        const vx = bx - ax;
        const vz = bz - az;
        const L2 = vx * vx + vz * vz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / L2));
        if (Math.hypot(x - ax - vx * t, z - az - vz * t) < m + 0.3) return false;
      }
    return true;
  };
  const crate = (mat: 'ivory' | 'trim' | 'copper') => {
    const b = new Builder(mats);
    b.add(mat, cbox(0.5, 0.4, 0.42, 0.03));
    b.add('trim', cbox(0.52, 0.06, 0.44, 0.01), { y: 0.17 });
    return b.build();
  };
  const variants = [crate('ivory'), crate('trim'), crate('ivory')];
  const lists: Matrix4[][] = variants.map(() => []);
  const lamps: Matrix4[] = [];
  const q = new Quaternion();
  for (let k = 0; k < 3000 && lists.flat().length < 90; k++) {
    const a = r.range(0, 6.28);
    const d = Math.sqrt(r.next()) * 21;
    const x = 66 + Math.cos(a) * d;
    const z = 62 + Math.sin(a) * d;
    if (!free(x, z, 0.5)) continue;
    const n = 1 + r.int(4);
    for (let i = 0; i < n; i++) {
      const v = r.int(variants.length);
      const ox = (i % 2) * 0.52;
      const oz = Math.floor(i / 2) * 0.45;
      const stack = i === 3 ? 0.4 : 0;
      q.setFromEuler(new Euler(0, r.range(-0.15, 0.15) + a, 0));
      lists[v]!.push(new Matrix4().compose(new Vector3(x + ox, heightAt(x, z) + stack, z + oz), q.clone(), new Vector3(1, 1, 1)));
    }
  }
  for (let k = 0; k < 2000 && lamps.length < 24; k++) {
    const x = r.range(46, 87);
    const z = r.range(43, 84);
    if (!free(x, z, 0.4)) continue;
    lamps.push(new Matrix4().makeTranslation(x, heightAt(x, z), z));
  }
  variants.forEach((v, i) => g.add(instanced(v.geometry, v.material, lists[i]!)));
  const lamp = new Builder(mats).add('trim', cbox(0.14, 0.08, 0.14, 0.01)).add('trim', cylinder(0.035, 1.3)).add('ivory', cbox(0.12, 0.12, 0.12, 0.02), { y: 1.25 }).add('glow', cbox(0.13, 0.04, 0.13, 0, 0), { y: 1.3 }).build();
  g.add(instanced(lamp.geometry, lamp.material, lamps));
  return g;
}

function cylinder(r: number, h: number): BufferGeometry {
  return cyl(r, r, h, 8);
}
