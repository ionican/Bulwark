// Map 1 terrain drawn from code: a heightfield ground mesh with a canvas-drawn tile texture,
// instanced rock outcrops, deposit pads and entry markers. Static; built once.
// W24 run 2a: this is the greybox view's terrain. The default view draws the ground with W17's
// material (groundView.ts) and the deposits with W23's models (models.ts), and keeps only the entry
// markers and labels from here (`ground: false`). Heights come from the drawn ground (ground.ts).

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Quaternion,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector3,
  Euler,
} from 'three';
import { hash2 } from '../sim/rng.ts';
import { TILE_MASS, TILE_RARE, TILE_ROCK, type Terrain } from '../sim/terrain.ts';
import { groundHeight as heightAt } from './ground.ts';
import { depositGeometry, depositIconGeometry, entryGeometry, rockGeometry } from './geometry.ts';

const PX = 8; // texture pixels per tile

function groundTexture(t: Terrain): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = t.w * PX;
  c.height = t.h * PX;
  const g = c.getContext('2d')!;
  for (let z = 0; z < t.h; z++) {
    for (let x = 0; x < t.w; x++) {
      const tile = t.tiles[z * t.w + x];
      const j = hash2(x, z, 11) < 0.5;
      g.fillStyle = tile === TILE_ROCK ? '#3b302a' : tile === TILE_MASS ? '#5a4630' : tile === TILE_RARE ? '#463c55' : j ? '#2f2823' : '#342c26';
      g.fillRect(x * PX, z * PX, PX, PX);
    }
  }
  // Tile grid, with a stronger line every 8 tiles.
  for (let i = 0; i <= t.w; i++) {
    g.fillStyle = i % 8 === 0 ? 'rgba(255,235,210,0.16)' : 'rgba(255,235,210,0.06)';
    g.fillRect(i * PX - (i % 8 === 0 ? 1 : 0), 0, i % 8 === 0 ? 2 : 1, c.height);
  }
  for (let i = 0; i <= t.h; i++) {
    g.fillStyle = i % 8 === 0 ? 'rgba(255,235,210,0.16)' : 'rgba(255,235,210,0.06)';
    g.fillRect(0, i * PX - (i % 8 === 0 ? 1 : 0), c.width, i % 8 === 0 ? 2 : 1);
  }
  // Base area ring.
  g.strokeStyle = 'rgba(160,240,215,0.35)';
  g.setLineDash([PX * 1.5, PX]);
  g.lineWidth = 3;
  g.beginPath();
  g.arc(t.base.x * PX, t.base.z * PX, 14 * PX, 0, Math.PI * 2);
  g.stroke();
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.flipY = false;
  tex.anisotropy = 8;
  return tex;
}

function groundGeometry(t: Terrain): BufferGeometry {
  const s = t.w + 1;
  const pos = new Float32Array(s * (t.h + 1) * 3);
  const uv = new Float32Array(s * (t.h + 1) * 2);
  for (let z = 0; z <= t.h; z++) {
    for (let x = 0; x <= t.w; x++) {
      const i = z * s + x;
      pos[i * 3] = x;
      pos[i * 3 + 1] = t.heights[i]!;
      pos[i * 3 + 2] = z;
      uv[i * 2] = x / t.w;
      uv[i * 2 + 1] = z / t.h;
    }
  }
  const idx = new Uint32Array(t.w * t.h * 6);
  let k = 0;
  for (let z = 0; z < t.h; z++) {
    for (let x = 0; x < t.w; x++) {
      const a = z * s + x;
      const b = a + 1;
      const c = a + s;
      const d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function textSprite(text: string): Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(18,15,13,0.85)';
  g.fillRect(0, 0, 256, 64);
  g.strokeStyle = '#f2a33a';
  g.lineWidth = 4;
  g.strokeRect(2, 2, 252, 60);
  g.fillStyle = '#f4efe6';
  g.font = '600 34px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 34);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const sp = new Sprite(new SpriteMaterial({ map: tex, depthTest: false }));
  sp.renderOrder = 20;
  return sp;
}

export interface TerrainView {
  group: Group;
  /**
   * Per frame: keeps labels and deposit icons at a constant pixel size (`wppAt` = world units per
   * pixel at a point). Deposit icons show when `overview` is true (camera in the icon LOD range).
   */
  update(wppAt: (x: number, y: number, z: number) => number, overview: boolean, yaw: number): void;
}

/** Deposit icon radius in pixels. */
const DEPOSIT_ICON_PX = 8;

export function buildTerrainView(t: Terrain, opts: { ground: boolean } = { ground: true }): TerrainView {
  const group = new Group();
  group.name = opts.ground ? 'greybox/terrain' : 'entries';
  if (opts.ground) group.add(new Mesh(groundGeometry(t), new MeshLambertMaterial({ map: groundTexture(t) })));

  const m = new Matrix4();
  const q = new Quaternion();
  const e = new Euler();
  const p = new Vector3();
  const sc = new Vector3();
  const vc = new MeshLambertMaterial({ vertexColors: true, flatShading: true });

  const depositIcons: Array<{ mesh: InstancedMesh; at: Array<[number, number, number]> }> = [];
  if (opts.ground) {
  // Rocks: one or two jittered boulders per rock tile.
  const rockTiles: number[] = [];
  for (let i = 0; i < t.tiles.length; i++) if (t.tiles[i] === TILE_ROCK) rockTiles.push(i);
  const rocks = new InstancedMesh(rockGeometry(), vc, Math.max(1, rockTiles.length));
  rockTiles.forEach((i, n) => {
    const x = i % t.w;
    const z = Math.floor(i / t.w);
    const cx = x + 0.2 + hash2(x, z, 1) * 0.6;
    const cz = z + 0.2 + hash2(x, z, 2) * 0.6;
    e.set(hash2(x, z, 3) * 0.6, hash2(x, z, 4) * 6.28, hash2(x, z, 5) * 0.6);
    q.setFromEuler(e);
    const s = 0.8 + hash2(x, z, 6) * 0.9;
    sc.set(s, s * (0.7 + hash2(x, z, 7) * 1.1), s);
    p.set(cx, heightAt(t, cx, cz) - 0.15, cz);
    m.compose(p, q, sc);
    rocks.setMatrixAt(n, m);
  });
  rocks.count = rockTiles.length;
  rocks.computeBoundingSphere();
  group.add(rocks);

  const iconMat = new MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false });
  for (const kind of ['mass', 'rare'] as const) {
    const ds = t.deposits.filter((d) => d.kind === kind);
    const mesh = new InstancedMesh(depositGeometry(kind), vc, ds.length);
    const at: Array<[number, number, number]> = [];
    ds.forEach((d, n) => {
      const cx = d.tx + 1;
      const cz = d.ty + 1;
      m.makeTranslation(cx, heightAt(t, cx, cz), cz);
      mesh.setMatrixAt(n, m);
      at.push([cx, heightAt(t, cx, cz) + 0.2, cz]);
    });
    mesh.computeBoundingSphere();
    group.add(mesh);
    const icons = new InstancedMesh(depositIconGeometry(kind), iconMat, ds.length);
    icons.frustumCulled = false;
    icons.renderOrder = 9; // under entity icons
    icons.visible = false;
    group.add(icons);
    depositIcons.push({ mesh: icons, at });
  }

  }

  // Entry markers: chevrons pointing into the map, plus a label.
  const entries = new InstancedMesh(entryGeometry(), new MeshBasicMaterial({ vertexColors: true }), t.entries.length);
  const labels: Array<{ sp: Sprite; x: number; y: number; z: number }> = [];
  t.entries.forEach((en, n) => {
    const cx = en.x + en.dirX * 6;
    const cz = en.z + en.dirZ * 6;
    // Chevron geometry points along +X; rotate +X onto (dirX, dirZ).
    e.set(0, Math.atan2(-en.dirZ, en.dirX), 0);
    q.setFromEuler(e);
    p.set(cx, heightAt(t, cx, cz) + 0.05, cz);
    sc.set(1.4, 1, 1.4);
    m.compose(p, q, sc);
    entries.setMatrixAt(n, m);
    const sp = textSprite(`ENTRY ${en.name.toUpperCase()}`);
    const lx = en.x + en.dirX * 13;
    const lz = en.z + en.dirZ * 13;
    labels.push({ sp, x: lx, y: heightAt(t, lx, lz) + 2, z: lz });
    sp.position.set(lx, heightAt(t, lx, lz) + 2, lz);
    group.add(sp);
  });
  entries.computeBoundingSphere();
  group.add(entries);

  return {
    group,
    update(wppAt, overview, yaw) {
      for (const l of labels) {
        const wpp = wppAt(l.x, l.y, l.z);
        l.sp.scale.set(128 * wpp, 32 * wpp, 1);
      }
      e.set(0, yaw, 0);
      q.setFromEuler(e);
      for (const d of depositIcons) {
        d.mesh.visible = overview;
        if (!overview) continue;
        d.at.forEach(([x, y, z], n) => {
          const k = Math.max(1.2, DEPOSIT_ICON_PX * wppAt(x, y, z));
          p.set(x, y, z);
          sc.set(k, 1, k);
          m.compose(p, q, sc);
          d.mesh.setMatrixAt(n, m);
        });
        d.mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}
