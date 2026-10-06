// Shallow turquoise pools: one transparent plane at the water level; the terrain shader tints
// the bed below it and draws the pale mineral rim. Ripples are a code-generated normal map
// scrolled in two directions.

import { CanvasTexture, Color, Mesh, MeshStandardMaterial, NoColorSpace, PlaneGeometry, RepeatWrapping, Vector2 } from 'three';
import { Rand } from '../noise.ts';
import { VISTA, WATER_LEVEL } from './heightfield.ts';

function rippleNormals(size = 256): CanvasTexture<OffscreenCanvas> {
  const r = new Rand(31);
  const h = new Float32Array(size * size);
  const waves = Array.from({ length: 14 }, () => ({ kx: r.int(9) - 4, ky: r.int(9) - 4, p: r.range(0, 6.28), a: r.range(0.3, 1) }));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const w of waves) v += w.a * Math.sin(((w.kx * x + w.ky * y) / size) * Math.PI * 2 * 2 + w.p);
      h[y * size + x] = v;
    }
  const img = new ImageData(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = h[y * size + ((x + 1) % size)]! - h[y * size + ((x - 1 + size) % size)]!;
      const dy = h[((y + 1) % size) * size + x]! - h[((y - 1 + size) % size) * size + x]!;
      const n = [-dx * 0.25, -dy * 0.25, 1];
      const l = Math.hypot(n[0]!, n[1]!, n[2]!);
      const o = (y * size + x) * 4;
      img.data[o] = ((n[0]! / l) * 0.5 + 0.5) * 255;
      img.data[o + 1] = ((n[1]! / l) * 0.5 + 0.5) * 255;
      img.data[o + 2] = ((n[2]! / l) * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
  const c = new OffscreenCanvas(size, size);
  c.getContext('2d')!.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = NoColorSpace;
  t.flipY = false;
  return t;
}

export function buildWater(): { mesh: Mesh; update: (t: number) => void; normal: CanvasTexture<OffscreenCanvas> } {
  const normal = rippleNormals();
  const w = VISTA.x1 - VISTA.x0;
  const d = VISTA.z1 - VISTA.z0;
  normal.repeat.set(w / 7, d / 7);
  const mat = new MeshStandardMaterial({
    name: 'water',
    color: new Color('#7fd8cf'),
    roughness: 0.07,
    metalness: 0,
    transparent: true,
    opacity: 0.5,
    normalMap: normal,
    normalScale: new Vector2(0.25, 0.25),
    depthWrite: false,
  });
  const g = new PlaneGeometry(w, d, 1, 1);
  g.rotateX(-Math.PI / 2);
  const mesh = new Mesh(g, mat);
  mesh.position.set((VISTA.x0 + VISTA.x1) / 2, WATER_LEVEL, (VISTA.z0 + VISTA.z1) / 2);
  mesh.receiveShadow = true;
  mesh.renderOrder = 2;
  mesh.name = 'water';
  return {
    mesh,
    normal,
    update: (t: number) => {
      normal.offset.set(t * 0.004, t * 0.0027);
    },
  };
}
