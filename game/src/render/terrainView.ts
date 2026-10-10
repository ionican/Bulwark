// Map 1 entry markers and their labels, drawn from code. Static; built once.
// W24 run 3 (G): the greybox ground, rocks and deposit pads that were built here are gone; the game
// draws the ground with W17's material (groundView.ts) and the deposits with W23's models
// (models.ts). Heights come from the drawn ground (ground.ts).

import { CanvasTexture, Euler, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, SRGBColorSpace, Sprite, SpriteMaterial, Vector3 } from 'three';
import type { Terrain } from '../sim/terrain.ts';
import { groundHeight as heightAt } from './ground.ts';
import { entryGeometry } from './geometry.ts';

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
  /** Per frame: keeps the entry labels at a constant pixel size (`wppAt` = world units per pixel at a point). */
  update(wppAt: (x: number, y: number, z: number) => number): void;
}

export function buildTerrainView(t: Terrain): TerrainView {
  const group = new Group();
  group.name = 'entries';
  const m = new Matrix4();
  const q = new Quaternion();
  const e = new Euler();
  const p = new Vector3();
  const sc = new Vector3();

  // Entry markers: chevrons pointing into the map, plus a label.
  const entries = new InstancedMesh(entryGeometry(), new MeshBasicMaterial({ vertexColors: true }), t.entries.length);
  entries.name = 'terrain/entries';
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
    update(wppAt) {
      for (const l of labels) {
        const wpp = wppAt(l.x, l.y, l.z);
        l.sp.scale.set(128 * wpp, 32 * wpp, 1);
      }
    },
  };
}
