// Procedural geometry for every entity kind at the three detail levels. No model or image files.
//
//   full   — low-poly model of a few primitives, merged into one vertex-coloured geometry per kind
//   simple — one or two primitives with a distinct silhouette per kind
//   icon   — flat 2D symbol (dark outline plate + pale fill with cut-out glyph), unit radius ~1,
//            lying in the XZ plane with "up" = -Z; the renderer turns it to face screen-up
//
// Kinds differ by shape first (Richard is colour-blind); colour is secondary. Mobile models face +X.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Euler,
  Matrix4,
  OctahedronGeometry,
  Path,
  Quaternion,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ALIEN_KINDS, BUILDING_INFO, BUILDING_KINDS, UNIT_KINDS, type AlienKind, type BuildingKind, type UnitKind } from '../sim/kinds.ts';

export const PALETTE = {
  ink: '#120f0d',
  plate: '#5d6266',
  metal: '#9aa1a7',
  pale: '#e8e2d6',
  earth: '#8f7b58',
  sand: '#b9a77c',
  moss: '#6d7867',
  crystal: '#d9a441',
  rare: '#c9b8f0',
  alien: '#e08a2e',
  alienDark: '#7a3b12',
  alienLight: '#ffd27a',
  friend: '#9ff0d8',
  friendDark: '#3d6b62',
  iconBuilding: '#ece6da',
  iconAlien: '#f2a33a',
  iconFriend: '#a8f5df',
  select: '#fff3a0',
} as const;

// ---- helpers -------------------------------------------------------------------------------

const tmpColor = new Color();

/** Non-indexed copy with uv removed and a constant vertex colour, ready to merge. */
function paint(geo: BufferGeometry, hex: string): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  tmpColor.set(hex).convertSRGBToLinear();
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = tmpColor.r;
    c[i * 3 + 1] = tmpColor.g;
    c[i * 3 + 2] = tmpColor.b;
  }
  g.setAttribute('color', new BufferAttribute(c, 3));
  return g;
}

interface Place {
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  sx?: number;
  sy?: number;
  sz?: number;
}

const m4 = new Matrix4();
const q = new Quaternion();
const e = new Euler();
const v = new Vector3();
const s = new Vector3();

function place(geo: BufferGeometry, p: Place): BufferGeometry {
  e.set(p.rx ?? 0, p.ry ?? 0, p.rz ?? 0);
  q.setFromEuler(e);
  v.set(p.x ?? 0, p.y ?? 0, p.z ?? 0);
  s.set(p.sx ?? 1, p.sy ?? 1, p.sz ?? 1);
  m4.compose(v, q, s);
  geo.applyMatrix4(m4);
  return geo;
}

const part = (geo: BufferGeometry, hex: string, p: Place = {}) => paint(place(geo, p), hex);

function merge(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('mergeGeometries failed');
  g.computeBoundingSphere();
  return g;
}

const box = (w: number, h: number, d: number) => new BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, seg = 8) => new CylinderGeometry(rt, rb, h, seg);
const cone = (r: number, h: number, seg = 4) => new ConeGeometry(r, h, seg);

// ---- belt pieces (face +X; the renderer turns them to their direction) ----------------------

/** Flat arrow in the XZ plane pointing +X, centred on (cx, cz). */
function arrow(cx: number, cz: number, len: number, wid: number, y: number, hex: string, angle = 0): BufferGeometry {
  const pts: Pt[] = [
    [len / 2, 0],
    [-len / 2, wid / 2],
    [-len / 4, 0],
    [-len / 2, -wid / 2],
  ];
  // Shape y maps to world -z after rotateX(-PI/2).
  const g = new ShapeGeometry(shapeFrom(pts)).rotateX(-Math.PI / 2).rotateY(angle).translate(cx, y, cz);
  return paint(g, hex);
}

function beltModel(kind: 'belt' | 'splitter' | 'merger', full: boolean): BufferGeometry {
  const P = PALETTE;
  const parts = [part(box(0.98, 0.12, 0.8), '#45484a', { y: 0.06 })];
  if (full) {
    parts.push(part(box(0.98, 0.16, 0.08), P.metal, { y: 0.08, z: 0.42 }));
    parts.push(part(box(0.98, 0.16, 0.08), P.metal, { y: 0.08, z: -0.42 }));
  }
  if (kind === 'belt') parts.push(arrow(0, 0, 0.6, 0.5, 0.13, P.pale));
  else if (kind === 'splitter') {
    parts.push(part(box(0.3, 0.3, 0.3), P.sand, { y: 0.2 }));
    parts.push(arrow(0, 0.3, 0.35, 0.3, 0.13, P.pale, -Math.PI / 2)); // out to +Z
    parts.push(arrow(0, -0.3, 0.35, 0.3, 0.13, P.pale, Math.PI / 2)); // out to -Z
  } else {
    parts.push(part(box(0.3, 0.3, 0.3), P.moss, { y: 0.2 }));
    parts.push(arrow(0.3, 0, 0.35, 0.3, 0.13, P.pale));
    parts.push(arrow(0, 0.3, 0.3, 0.25, 0.13, P.pale, Math.PI / 2)); // in from +Z
    parts.push(arrow(0, -0.3, 0.3, 0.25, 0.13, P.pale, -Math.PI / 2)); // in from -Z
  }
  return merge(parts);
}

// ---- buildings: full models ----------------------------------------------------------------
// Built centred on the footprint at y = 0, footprint side `f` tiles (the kind's default fw; every
// kind but the gate is square). The gate is modelled 3 tiles wide along x and 1 tile deep; the
// renderer stretches it to its depth and turns it to its axis.

/** Gate (W24): two solid pylons, an open centre column (the corridor) under a lintel. */
function gateModel(full: boolean): BufferGeometry {
  const P = PALETTE;
  const parts = [
    part(box(1, 1.3, 1), P.metal, { x: -1, y: 0.65 }),
    part(box(1, 1.3, 1), P.metal, { x: 1, y: 0.65 }),
    part(box(3, 0.22, 0.6), P.ink, { y: 1.5 }),
    // A low sill across the corridor: the gap reads as a way through, not a missing tile.
    part(box(0.9, 0.05, 1), P.plate, { y: 0.025 }),
  ];
  if (full) {
    parts.push(part(box(1.04, 0.14, 1.04), P.ink, { x: -1, y: 1.3 }));
    parts.push(part(box(1.04, 0.14, 1.04), P.ink, { x: 1, y: 1.3 }));
    parts.push(part(box(0.08, 1.1, 0.08), P.pale, { x: -0.45, y: 0.55 }));
    parts.push(part(box(0.08, 1.1, 0.08), P.pale, { x: 0.45, y: 0.55 }));
  }
  return merge(parts);
}

function buildingFull(kind: BuildingKind): BufferGeometry {
  const f = BUILDING_INFO[kind].fw;
  const P = PALETTE;
  const pad = (h = 0.2, hex: string = P.plate) => part(box(f * 0.92, h, f * 0.92), hex, { y: h / 2 });
  switch (kind) {
    case 'massExtractor':
      return merge([
        part(cyl(f * 0.46, f * 0.5, 0.45, 8), P.earth, { y: 0.22, ry: Math.PI / 8 }),
        part(box(0.3, 1.8, 0.3), P.metal, { y: 1.1 }),
        part(box(1.3, 0.1, 0.2), P.pale, { y: 0.6, ry: 0.3 }),
        part(box(1.3, 0.1, 0.2), P.pale, { y: 0.6, ry: 0.3 + Math.PI / 1.5 }),
        part(box(1.3, 0.1, 0.2), P.pale, { y: 0.6, ry: 0.3 + (2 * Math.PI) / 1.5 }),
        part(new OctahedronGeometry(0.16), P.crystal, { y: 2.1 }),
      ]);
    case 'generator':
      return merge([
        pad(),
        part(cyl(0.55, 0.65, 1.1, 12), P.sand, { y: 0.75 }),
        part(new TorusGeometry(0.62, 0.08, 4, 12), P.ink, { y: 0.9, rx: Math.PI / 2 }),
        part(new TorusGeometry(0.62, 0.08, 4, 12), P.ink, { y: 1.15, rx: Math.PI / 2 }),
        part(cone(0.3, 0.5, 6), P.pale, { y: 1.55 }),
      ]);
    case 'rareExtractor':
      return merge([
        part(cyl(f * 0.42, f * 0.48, 0.35, 6), P.plate, { y: 0.17 }),
        part(cone(0.45, 1.6, 6), P.rare, { y: 1.15 }),
        part(box(0.18, 1.2, 0.18), P.metal, { x: 0.65, y: 0.6, z: 0.65 }),
        part(box(0.18, 1.2, 0.18), P.metal, { x: -0.65, y: 0.6, z: -0.65 }),
      ]);
    case 'lab':
      return merge([
        pad(0.25),
        part(new SphereGeometry(1.1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), P.pale, { y: 0.25 }),
        part(box(0.2, 1.4, 0.2), P.metal, { x: 1.0, y: 0.95, z: 1.0 }),
        part(new TorusGeometry(0.35, 0.06, 4, 10), P.ink, { x: 1.0, y: 1.75, z: 1.0, rx: 0.6 }),
      ]);
    case 'depot':
      return merge([
        pad(0.15),
        part(box(1.4, 0.6, 1.4), P.earth, { y: 0.45 }),
        part(box(0.5, 0.35, 0.5), P.sand, { x: -0.35, y: 0.92, z: -0.35 }),
        part(box(0.5, 0.35, 0.5), P.sand, { x: 0.35, y: 0.92, z: 0.3 }),
      ]);
    case 'shredder':
    case 'smelter':
    case 'assembler': {
      const stacks = kind === 'shredder' ? 1 : kind === 'smelter' ? 2 : 3;
      const parts = [pad(0.15), part(box(1.5, 0.7, 1.5), P.moss, { y: 0.5 })];
      for (let i = 0; i < stacks; i++) {
        const x = (i - (stacks - 1) / 2) * 0.45;
        parts.push(part(cyl(0.14, 0.17, 0.8, 6), P.ink, { x, y: 1.2, z: -0.4 }));
      }
      parts.push(part(box(1.6, 0.12, 0.3), P.pale, { y: 0.6, z: 0.78 }));
      return merge(parts);
    }
    case 'wall':
      return merge([
        part(box(1, 1.1, 1), P.metal, { y: 0.55 }),
        part(box(1.04, 0.14, 1.04), P.ink, { y: 1.1 }),
        part(box(0.3, 0.2, 1.04), P.plate, { y: 1.25 }),
      ]);
    case 'gun':
      return merge([
        pad(0.22),
        part(cyl(0.45, 0.55, 0.45, 10), P.metal, { y: 0.45 }),
        part(box(0.55, 0.35, 0.5), P.pale, { y: 0.85 }),
        part(cyl(0.08, 0.09, 0.8, 6), P.ink, { x: 0.0, y: 0.85, z: -0.6, rx: Math.PI / 2 }),
      ]);
    case 'area':
      return merge([
        pad(0.22),
        part(cyl(0.6, 0.7, 0.4, 8), P.metal, { y: 0.42 }),
        part(new SphereGeometry(0.5, 8, 5), P.sand, { y: 0.85 }),
        part(cyl(0.2, 0.24, 0.7, 8), P.ink, { y: 1.05, z: -0.45, rx: Math.PI / 2.6 }),
      ]);
    case 'beam':
      return merge([
        pad(0.22),
        part(cyl(0.3, 0.5, 1.4, 6), P.metal, { y: 0.9 }),
        part(new OctahedronGeometry(0.32), P.pale, { y: 1.85 }),
        part(cyl(0.05, 0.05, 1.2, 4), P.ink, { y: 1.85, z: -0.6, rx: Math.PI / 2 }),
      ]);
    case 'heavy':
      return merge([
        pad(0.3),
        part(cyl(1.0, 1.2, 0.6, 8), P.plate, { y: 0.6, ry: Math.PI / 8 }),
        part(box(1.3, 0.7, 1.2), P.metal, { y: 1.25 }),
        part(cyl(0.2, 0.24, 1.8, 8), P.ink, { y: 1.35, z: -1.2, rx: Math.PI / 2 }),
      ]);
    case 'shield':
      return merge([
        pad(0.22),
        part(cyl(0.25, 0.4, 1.0, 6), P.metal, { y: 0.7 }),
        part(new TorusGeometry(0.7, 0.07, 4, 16), P.pale, { y: 1.3, rx: Math.PI / 2 }),
        part(new TorusGeometry(0.45, 0.06, 4, 12), P.pale, { y: 1.55, rx: Math.PI / 2 }),
        part(new SphereGeometry(0.18, 6, 4), P.rare, { y: 1.75 }),
      ]);
    case 'belt':
    case 'splitter':
    case 'merger':
      return beltModel(kind, true);
    case 'tempTurret':
      return merge([
        part(cyl(0.35, 0.42, 0.3, 6), P.friendDark, { y: 0.15 }),
        part(box(0.35, 0.25, 0.35), P.friend, { y: 0.42 }),
        part(cyl(0.05, 0.05, 0.5, 4), P.ink, { y: 0.42, z: -0.35, rx: Math.PI / 2 }),
      ]);
    case 'gate':
      return gateModel(true);
    case 'core':
      // W29: a stepped block with a tower and four intake chutes, one per side
      return merge([
        pad(0.3),
        part(box(2.2, 0.8, 2.2), P.pale, { y: 0.7 }),
        part(box(1.2, 1.2, 1.2), P.metal, { y: 1.7 }),
        part(new OctahedronGeometry(0.45), P.crystal, { y: 2.6 }),
        ...[0, 1, 2, 3].map((k) => part(box(0.5, 0.3, 0.4), P.ink, { x: [1.25, 0, -1.25, 0][k], z: [0, 1.25, 0, -1.25][k], y: 0.45, ry: (k * Math.PI) / 2 })),
      ]);
  }
}

function buildingSimple(kind: BuildingKind): BufferGeometry {
  const f = BUILDING_INFO[kind].fw;
  const P = PALETTE;
  switch (kind) {
    case 'massExtractor':
      return merge([part(cyl(f * 0.45, f * 0.45, 1.0, 8), P.earth, { y: 0.5 })]);
    case 'generator':
      return merge([part(cyl(0.7, 0.7, 1.4, 12), P.sand, { y: 0.7 })]);
    case 'rareExtractor':
      return merge([part(cone(0.8, 2.0, 6), P.rare, { y: 1.0 })]);
    case 'lab':
      return merge([part(new SphereGeometry(1.3, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), P.pale)]);
    case 'depot':
      return merge([part(box(1.7, 0.7, 1.7), P.earth, { y: 0.35 })]);
    case 'shredder':
    case 'smelter':
    case 'assembler': {
      const sides = kind === 'shredder' ? 3 : kind === 'smelter' ? 4 : 5;
      return merge([part(box(1.7, 0.7, 1.7), P.moss, { y: 0.35 }), part(cone(0.6, 0.8, sides), P.pale, { y: 1.1 })]);
    }
    case 'wall':
      return merge([part(box(1, 1.2, 1), P.metal, { y: 0.6 })]);
    case 'gun':
      return merge([part(box(1.6, 0.4, 1.6), P.plate, { y: 0.2 }), part(cyl(0.45, 0.45, 0.6, 8), P.pale, { y: 0.7 })]);
    case 'area':
      return merge([part(box(1.6, 0.4, 1.6), P.plate, { y: 0.2 }), part(new SphereGeometry(0.6, 6, 4), P.sand, { y: 0.8 })]);
    case 'beam':
      return merge([part(box(1.6, 0.4, 1.6), P.plate, { y: 0.2 }), part(cone(0.4, 2.0, 4), P.pale, { y: 1.4 })]);
    case 'heavy':
      return merge([part(box(2.6, 0.6, 2.6), P.plate, { y: 0.3 }), part(box(1.4, 0.9, 1.4), P.metal, { y: 1.05 })]);
    case 'shield':
      return merge([part(box(1.6, 0.4, 1.6), P.plate, { y: 0.2 }), part(new TorusGeometry(0.6, 0.15, 4, 12), P.pale, { y: 1.0, rx: Math.PI / 2 })]);
    case 'tempTurret':
      return merge([part(cyl(0.4, 0.4, 0.5, 6), P.friend, { y: 0.25 })]);
    case 'belt':
    case 'splitter':
    case 'merger':
      return beltModel(kind, false);
    case 'gate':
      return gateModel(false);
    case 'core':
      return merge([part(box(2.4, 1.4, 2.4), P.pale, { y: 0.7 }), part(box(1.2, 1.0, 1.2), P.metal, { y: 1.9 })]);
  }
}

// ---- aliens and player units ---------------------------------------------------------------

function alienFull(kind: AlienKind): BufferGeometry {
  const P = PALETTE;
  switch (kind) {
    case 'rusher': {
      // Low wedge on four legs.
      const legs = [];
      for (const sx of [-0.15, 0.15]) for (const sz of [-1, 1]) legs.push(part(box(0.05, 0.3, 0.05), P.ink, { x: sx, y: 0.15, z: sz * 0.2, rx: sz * 0.5 }));
      return merge([part(cone(0.25, 0.65, 3), P.alien, { y: 0.32, rz: -Math.PI / 2, sy: 1, sz: 0.6 }), ...legs]);
    }
    case 'hunter':
      // Slim dart over a hover disc.
      return merge([
        part(cyl(0.3, 0.35, 0.08, 8), P.alienDark, { y: 0.2 }),
        part(cone(0.16, 0.9, 4), P.alienLight, { x: 0.05, y: 0.45, rz: -Math.PI / 2 }),
        part(box(0.3, 0.05, 0.6), P.alien, { x: -0.2, y: 0.45 }),
      ]);
    case 'breaker':
      // Armoured block on two treads with a ram.
      return merge([
        part(box(1.2, 0.35, 0.3), P.ink, { y: 0.18, z: 0.45 }),
        part(box(1.2, 0.35, 0.3), P.ink, { y: 0.18, z: -0.45 }),
        part(box(1.1, 0.55, 0.8), P.alien, { y: 0.6 }),
        part(cone(0.45, 0.5, 4), P.alienDark, { x: 0.75, y: 0.55, rz: -Math.PI / 2, ry: Math.PI / 4 }),
        part(box(0.5, 0.25, 0.5), P.alienLight, { x: -0.1, y: 1.0 }),
      ]);
    case 'saboteur':
      // Flat diamond on short treads, with an antenna.
      return merge([
        part(box(0.7, 0.18, 0.12), P.ink, { y: 0.1, z: 0.25 }),
        part(box(0.7, 0.18, 0.12), P.ink, { y: 0.1, z: -0.25 }),
        part(new OctahedronGeometry(0.4), P.alien, { y: 0.35, sy: 0.45 }),
        part(cyl(0.025, 0.025, 0.6, 4), P.alienLight, { x: -0.15, y: 0.65 }),
      ]);
  }
}

function alienSimple(kind: AlienKind): BufferGeometry {
  const P = PALETTE;
  switch (kind) {
    case 'rusher':
      return merge([part(cone(0.3, 0.7, 3), P.alien, { y: 0.3, rz: -Math.PI / 2 })]);
    case 'hunter':
      return merge([part(cone(0.2, 1.0, 4), P.alienLight, { y: 0.4, rz: -Math.PI / 2 })]);
    case 'breaker':
      return merge([part(box(1.2, 0.9, 1.0), P.alien, { y: 0.45 })]);
    case 'saboteur':
      return merge([part(new OctahedronGeometry(0.45), P.alien, { y: 0.4, sy: 0.6 })]);
  }
}

function unitFull(kind: UnitKind): BufferGeometry {
  const P = PALETTE;
  if (kind === 'commander') {
    return merge([
      part(box(0.3, 0.9, 0.3), P.friendDark, { y: 0.45, z: 0.3 }),
      part(box(0.3, 0.9, 0.3), P.friendDark, { y: 0.45, z: -0.3 }),
      part(box(0.9, 0.8, 1.2), P.friend, { y: 1.3 }),
      part(cyl(0.25, 0.3, 0.35, 6), P.pale, { x: 0.15, y: 1.9 }),
      part(box(0.7, 0.18, 0.18), P.ink, { x: 0.45, y: 1.3, z: 0.7 }),
      part(box(0.7, 0.18, 0.18), P.ink, { x: 0.45, y: 1.3, z: -0.7 }),
    ]);
  }
  return merge([
    part(cyl(0.35, 0.4, 0.15, 8), P.friendDark, { y: 0.25 }),
    part(new SphereGeometry(0.28, 8, 5), P.friend, { y: 0.5 }),
    part(box(0.5, 0.08, 0.08), P.pale, { x: 0.3, y: 0.5 }),
  ]);
}

function unitSimple(kind: UnitKind): BufferGeometry {
  const P = PALETTE;
  if (kind === 'commander') return merge([part(cyl(0.6, 0.7, 2.0, 6), P.friend, { y: 1.0 })]);
  return merge([part(new SphereGeometry(0.4, 6, 4), P.friend, { y: 0.45 })]);
}

// ---- icons ---------------------------------------------------------------------------------

export type Pt = [number, number];

const circlePts = (r: number, n = 20, cx = 0, cy = 0): Pt[] =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * Math.PI * 2), cy + r * Math.sin((i / n) * Math.PI * 2)] as Pt);
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const regular = (r: number, n: number, rot = Math.PI / 2): Pt[] =>
  Array.from({ length: n }, (_, i) => [r * Math.cos(rot + (i / n) * Math.PI * 2), r * Math.sin(rot + (i / n) * Math.PI * 2)] as Pt);
const star = (ro: number, ri: number, n: number): Pt[] =>
  Array.from({ length: n * 2 }, (_, i) => {
    const r = i % 2 ? ri : ro;
    const a = Math.PI / 2 + (i / (n * 2)) * Math.PI * 2;
    return [r * Math.cos(a), r * Math.sin(a)] as Pt;
  });
const rev = (p: Pt[]) => [...p].reverse();

export interface IconSpec {
  /** Silhouette; also the dark outline plate, drawn grown by the outline width. */
  outer: Pt[];
  holes?: Pt[][];
  /** Extra solid shapes unioned with the silhouette (each gets its own outline). */
  extra?: Pt[][];
}

function shapeFrom(pts: Pt[], holes: Pt[][] = []): Shape {
  const sh = new Shape(pts.map(([x, y]) => new Vector2(x, y)));
  for (const h of holes) sh.holes.push(new Path(h.map(([x, y]) => new Vector2(x, y))));
  return sh;
}

/** Grows a polygon away from its centroid by `d` (approximate offset; fine for convex-ish icons). */
function grow(pts: Pt[], d: number): Pt[] {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= pts.length;
  cy /= pts.length;
  return pts.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const l = Math.hypot(dx, dy) || 1;
    return [x + (dx / l) * d, y + (dy / l) * d] as Pt;
  });
}

function iconGeometry(spec: IconSpec, fill: string): BufferGeometry {
  const P = PALETTE;
  const flat = (g: BufferGeometry, y: number) => g.rotateX(-Math.PI / 2).translate(0, y, 0);
  const parts: BufferGeometry[] = [];
  const solids = [spec.outer, ...(spec.extra ?? [])];
  for (const p of solids) parts.push(paint(flat(new ShapeGeometry(shapeFrom(grow(p, 0.16))), 0), P.ink));
  parts.push(paint(flat(new ShapeGeometry(shapeFrom(spec.outer, spec.holes)), 0.01), fill));
  for (const p of spec.extra ?? []) parts.push(paint(flat(new ShapeGeometry(shapeFrom(p)), 0.02), fill));
  return merge(parts);
}

const BUILDING_ICONS: Record<BuildingKind, IconSpec> = {
  massExtractor: { outer: rect(-0.9, -0.9, 0.9, 0.9), holes: [rev(circlePts(0.45))] },
  generator: { outer: [[0.15, 1], [-0.65, -0.1], [-0.05, -0.1], [-0.25, -1], [0.65, 0.15], [0.05, 0.15]] },
  rareExtractor: { outer: regular(1, 4), holes: [rev(regular(0.42, 4))] },
  lab: { outer: circlePts(1), holes: [rev(circlePts(0.5))] },
  depot: { outer: rect(-0.9, -0.9, 0.9, 0.9), holes: [rev(rect(-0.45, -0.45, 0.45, 0.45))] },
  shredder: { outer: rect(-0.9, -0.9, 0.9, 0.9), holes: [rev(rect(-0.12, -0.6, 0.12, 0.6))] },
  smelter: { outer: rect(-0.9, -0.9, 0.9, 0.9), holes: [rev(rect(-0.42, -0.6, -0.18, 0.6)), rev(rect(0.18, -0.6, 0.42, 0.6))] },
  assembler: {
    outer: rect(-0.9, -0.9, 0.9, 0.9),
    holes: [rev(rect(-0.6, -0.6, -0.4, 0.6)), rev(rect(-0.1, -0.6, 0.1, 0.6)), rev(rect(0.4, -0.6, 0.6, 0.6))],
  },
  wall: { outer: rect(-0.7, -0.7, 0.7, 0.7) },
  gun: { outer: circlePts(0.65, 16, 0, -0.25), extra: [rect(-0.14, 0.2, 0.14, 1)] },
  area: { outer: star(1, 0.5, 8) },
  beam: { outer: [[0, 1.05], [0.35, -0.2], [0, -0.95], [-0.35, -0.2]] },
  heavy: { outer: regular(0.85, 6, 0), extra: [rect(-0.24, 0.4, 0.24, 1.1)] },
  shield: {
    outer: [...Array.from({ length: 13 }, (_, i) => [Math.cos((i / 12) * Math.PI), -0.6 + 1.4 * Math.sin((i / 12) * Math.PI)] as Pt)],
    holes: [rev([...Array.from({ length: 13 }, (_, i) => [0.55 * Math.cos((i / 12) * Math.PI), -0.45 + 0.85 * Math.sin((i / 12) * Math.PI)] as Pt)])],
  },
  // Belt pieces point along +X in icon space (the renderer turns them to their direction).
  belt: { outer: [[0.9, 0], [-0.1, 0.75], [-0.1, 0.3], [-0.9, 0.3], [-0.9, -0.3], [-0.1, -0.3], [-0.1, -0.75]] },
  splitter: { outer: [[0, 0.95], [0.5, 0.45], [0.2, 0.45], [0.2, -0.45], [0.5, -0.45], [0, -0.95], [-0.5, -0.45], [-0.2, -0.45], [-0.2, 0.45], [-0.5, 0.45]] },
  merger: { outer: [[0.95, 0], [0.4, 0.55], [0.4, 0.25], [-0.9, 0.9], [-0.9, -0.9], [0.4, -0.25], [0.4, -0.55]] },
  tempTurret: { outer: [[-0.25, 0.8], [0.25, 0.8], [0.25, 0.25], [0.8, 0.25], [0.8, -0.25], [0.25, -0.25], [0.25, -0.8], [-0.25, -0.8], [-0.25, -0.25], [-0.8, -0.25], [-0.8, 0.25], [-0.25, 0.25]] },
  // Gate: two pylons and a lintel round an open centre (the corridor).
  gate: { outer: rect(-0.95, -0.75, -0.35, 0.75), extra: [rect(0.35, -0.75, 0.95, 0.75), rect(-0.95, 0.45, 0.95, 0.75)] },
  // W29 core: an octagon with a square hole round a diamond.
  core: { outer: regular(0.95, 8, Math.PI / 8), holes: [rev(rect(-0.45, -0.45, 0.45, 0.45))], extra: [[[0, 0.3], [0.3, 0], [0, -0.3], [-0.3, 0]]] },
};

export const ALIEN_ICONS: Record<AlienKind, IconSpec> = {
  rusher: { outer: [[0, 0.9], [0.75, -0.6], [-0.75, -0.6]] },
  hunter: { outer: [[0, 1], [0.85, -0.8], [0, -0.25], [-0.85, -0.8]] },
  // Heavy block with a pointed ram: reads differently from the hollow hexagon of a mass deposit.
  breaker: { outer: [[0, 1.05], [0.95, 0.3], [0.95, -0.95], [-0.95, -0.95], [-0.95, 0.3]] },
  saboteur: { outer: [[-0.8, 0.85], [0.8, 0.85], [0.12, 0], [0.8, -0.85], [-0.8, -0.85], [-0.12, 0]] },
};

const UNIT_ICONS: Record<UnitKind, IconSpec> = {
  commander: { outer: star(1.1, 0.48, 5) },
  engineer: { outer: circlePts(0.8, 16), holes: [rev(rect(-0.12, -0.45, 0.12, 0.45))] },
};

// ---- selection marker: four corner brackets round a unit square -----------------------------

export function selectionMarkerGeometry(): BufferGeometry {
  const P = PALETTE;
  const parts: BufferGeometry[] = [];
  const L = 0.45;
  const T = 0.2;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const a: Pt[] = rect(Math.min(sx, sx - sx * L), Math.min(sy, sy - sy * T), Math.max(sx, sx - sx * L), Math.max(sy, sy - sy * T));
      const b: Pt[] = rect(Math.min(sx, sx - sx * T), Math.min(sy, sy - sy * L), Math.max(sx, sx - sx * T), Math.max(sy, sy - sy * L));
      for (const r of [a, b]) {
        parts.push(paint(new ShapeGeometry(shapeFrom(grow(r, 0.06))).rotateX(-Math.PI / 2), P.ink));
        parts.push(paint(new ShapeGeometry(shapeFrom(r)).rotateX(-Math.PI / 2).translate(0, 0.01, 0), P.select));
      }
    }
  }
  return merge(parts);
}

// ---- public tables -------------------------------------------------------------------------

export interface KindGeometry {
  full: BufferGeometry;
  simple: BufferGeometry;
  icon: BufferGeometry;
}

export function buildingGeometries(): KindGeometry[] {
  return BUILDING_KINDS.map((k) => ({ full: buildingFull(k), simple: buildingSimple(k), icon: iconGeometry(BUILDING_ICONS[k], PALETTE.iconBuilding) }));
}
export function alienGeometries(): KindGeometry[] {
  return ALIEN_KINDS.map((k) => ({ full: alienFull(k), simple: alienSimple(k), icon: iconGeometry(ALIEN_ICONS[k], PALETTE.iconAlien) }));
}
/** The alien kinds' icon shapes alone (the route origins: render/routeView.ts). */
export function alienIconGeometries(): BufferGeometry[] {
  return ALIEN_KINDS.map((k) => iconGeometry(ALIEN_ICONS[k], PALETTE.iconAlien));
}
export function unitGeometries(): KindGeometry[] {
  return UNIT_KINDS.map((k) => ({ full: unitFull(k), simple: unitSimple(k), icon: iconGeometry(UNIT_ICONS[k], PALETTE.iconFriend) }));
}

/** Entry marker: a broad chevron on the ground pointing along +X (into the map once rotated). */
export function entryGeometry(): BufferGeometry {
  const chev: Pt[] = [[1.5, 0], [-0.5, 2], [-1.5, 2], [0.5, 0], [-1.5, -2], [-0.5, -2]];
  const g = (p: Pt[], hex: string, y: number) => paint(new ShapeGeometry(shapeFrom(p)).rotateX(-Math.PI / 2).translate(0, y, 0), hex);
  const back = chev.map(([x, y]) => [x - 3, y] as Pt);
  return merge([
    g(grow(chev, 0.25), PALETTE.ink, 0.05),
    g(grow(back, 0.25), PALETTE.ink, 0.05),
    g(chev, PALETTE.iconAlien, 0.08),
    g(back, PALETTE.iconAlien, 0.08),
  ]);
}

// ---- M2: items, wrecks, projectiles, beams, shields, construction, routes, ghost -------------

/**
 * Belt items, indexed by item kind (0 unused): salvage chunk, scrap cube, alloy ingot, part, mass
 * ingot, rare crystal. Each stands on y = 0, which entities.ts puts on the belt's top surface (W29b:
 * at y 0.12 above the ground they were inside the belt model and hidden). Sizes fit between the
 * rails (0.62 apart) and read at the game camera (distance 30).
 */
export function itemGeometries(): BufferGeometry[] {
  const P = PALETTE;
  return [
    merge([part(box(0.1, 0.1, 0.1), P.ink)]),
    merge([part(new DodecahedronGeometry(0.17, 0), '#b07a4a', { y: 0.15 })]),
    merge([part(box(0.24, 0.24, 0.24), '#a8a8a0', { y: 0.12 })]),
    merge([part(box(0.36, 0.16, 0.2), '#d9c27a', { y: 0.08 })]),
    merge([part(cyl(0.18, 0.18, 0.1, 6), P.pale, { y: 0.05 }), part(cyl(0.07, 0.07, 0.12, 6), P.ink, { y: 0.06 })]),
    // W29 mass: an ingot (a long block with a narrower raised top), told from the scrap cube by its shape
    merge([part(box(0.5, 0.12, 0.28), '#9a9a94', { y: 0.06 }), part(box(0.38, 0.1, 0.18), '#c8c8c0', { y: 0.17 })]),
    // W29 rare: a tall crystal (a stretched octahedron)
    merge([part(new OctahedronGeometry(0.2), P.crystal, { y: 0.3, sy: 1.5 })]),
  ];
}

/** Wreck: a heap of dark shards (models) and a flat X (icon). */
export function wreckGeometry(): KindGeometry {
  const P = PALETTE;
  const shards = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    shards.push(part(cone(0.18, 0.5, 4), i % 2 ? P.alienDark : '#3a3430', { x: Math.cos(a) * 0.3, y: 0.15, z: Math.sin(a) * 0.3, rx: 0.9 * Math.sin(a), rz: 0.9 * Math.cos(a) }));
  }
  shards.push(part(box(0.5, 0.15, 0.4), '#3a3430', { y: 0.07, ry: 0.4 }));
  const full = merge(shards);
  const simple = merge([part(new DodecahedronGeometry(0.4, 0), '#4a3a30', { y: 0.15, sy: 0.4 })]);
  const xs: Pt[] = [[-0.9, -0.6], [-0.6, -0.9], [0, -0.3], [0.6, -0.9], [0.9, -0.6], [0.3, 0], [0.9, 0.6], [0.6, 0.9], [0, 0.3], [-0.6, 0.9], [-0.9, 0.6], [-0.3, 0]];
  const icon = iconGeometry({ outer: xs }, '#8a8078');
  return { full, simple, icon };
}

/** Projectiles by P_* kind: bullet, shell, heavy slug, alien shot. All face +X. */
export function projectileGeometries(): BufferGeometry[] {
  return [
    merge([part(box(0.35, 0.08, 0.08), '#fff6b8')]),
    merge([part(new SphereGeometry(0.16, 6, 4), '#ffe08a')]),
    merge([part(box(0.6, 0.18, 0.18), '#ffffff'), part(cone(0.12, 0.25, 4), '#ffd27a', { x: 0.42, rz: -Math.PI / 2 })]),
    merge([part(new OctahedronGeometry(0.13), '#ff8a3a', { sx: 1.8 })]),
  ];
}

/** Unit-length bar along +X (beam, build and reclaim lines). */
export function lineGeometry(thick: number, hex: string): BufferGeometry {
  return merge([part(box(1, thick, thick), hex, { x: 0.5 })]);
}

export function shieldDomeGeometry(): BufferGeometry {
  return new SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2);
}

/** Dashed ring of radius 1 in the XZ plane. */
export function dashedRingGeometry(dashes = 24, width = 0.04): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < dashes; i++) {
    const a0 = (i / dashes) * Math.PI * 2;
    const a1 = a0 + (Math.PI * 2) / dashes * 0.55;
    const pts: Pt[] = [];
    for (let k = 0; k <= 4; k++) pts.push([Math.cos(a0 + ((a1 - a0) * k) / 4), Math.sin(a0 + ((a1 - a0) * k) / 4)]);
    for (let k = 4; k >= 0; k--) pts.push([(1 - width) * Math.cos(a0 + ((a1 - a0) * k) / 4), (1 - width) * Math.sin(a0 + ((a1 - a0) * k) / 4)]);
    parts.push(paint(new ShapeGeometry(shapeFrom(pts)).rotateX(-Math.PI / 2), '#e6f2ff'));
  }
  return merge(parts);
}

/** Construction frame: a dashed square round a unit footprint (shape differs from the selection brackets). */
export function constructionFrameGeometry(): BufferGeometry {
  const P = PALETTE;
  const parts: BufferGeometry[] = [];
  const n = 4;
  const t = 0.08;
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < n; i++) {
      const a = -1 + (2 * i) / n + 0.06;
      const b = a + 2 / n - 0.18;
      const r: Pt[] = side === 0 ? rect(a, 1 - t, b, 1) : side === 1 ? rect(a, -1, b, -1 + t) : side === 2 ? rect(-1, a, -1 + t, b) : rect(1 - t, a, 1, b);
      parts.push(paint(new ShapeGeometry(shapeFrom(r)).rotateX(-Math.PI / 2), P.sand));
    }
  }
  // Two diagonal struts across the corners: reads as "scaffold".
  parts.push(paint(new ShapeGeometry(shapeFrom([[-1, -1], [-0.85, -1], [-0.55, -0.7], [-0.7, -0.7]])).rotateX(-Math.PI / 2), P.sand));
  parts.push(paint(new ShapeGeometry(shapeFrom([[1, 1], [0.85, 1], [0.55, 0.7], [0.7, 0.7]])).rotateX(-Math.PI / 2), P.sand));
  return merge(parts);
}

/**
 * Route markers per alien target category, shaped like the icon of the alien kind that uses it:
 * commander = hunter chevron, defences = rusher triangle, walls and turrets = breaker block,
 * economy = saboteur bow-tie. They point along the route ("up" = -Z, turned by the renderer).
 */
export function routeMarkerGeometries(): BufferGeometry[] {
  // Hollow (a light rim round a dark centre), so a marker never reads as a live alien icon,
  // which is solid. The difference is shape, not colour.
  const fill = '#ffb347';
  const hollow = (spec: IconSpec): IconSpec => {
    const pts = spec.outer;
    let cx = 0;
    let cy = 0;
    for (const [x, y] of pts) {
      cx += x;
      cy += y;
    }
    cx /= pts.length;
    cy /= pts.length;
    return { outer: pts, holes: [rev(pts.map(([x, y]) => [cx + (x - cx) * 0.45, cy + (y - cy) * 0.45] as Pt))] };
  };
  return [
    iconGeometry(hollow(ALIEN_ICONS.hunter), fill),
    iconGeometry(hollow(ALIEN_ICONS.rusher), fill),
    iconGeometry(hollow(ALIEN_ICONS.breaker), fill),
    iconGeometry(hollow(ALIEN_ICONS.saboteur), fill),
  ];
}

/** Ghost marks: a tick (placement allowed) and a cross (not allowed), flat, unit radius. */
export function ghostMarkGeometry(ok: boolean): BufferGeometry {
  const tick: Pt[] = [[-0.9, 0.05], [-0.55, 0.4], [-0.25, 0.1], [0.55, 0.9], [0.9, 0.55], [-0.25, -0.6]];
  const cross: Pt[] = [[-0.9, -0.6], [-0.6, -0.9], [0, -0.3], [0.6, -0.9], [0.9, -0.6], [0.3, 0], [0.9, 0.6], [0.6, 0.9], [0, 0.3], [-0.6, 0.9], [-0.9, 0.6], [-0.3, 0]];
  return iconGeometry({ outer: ok ? tick : cross }, ok ? '#a8f5df' : '#ffd0a0');
}

/** Square outline round a unit footprint: solid (valid) or dashed (invalid). */
export function ghostOutlineGeometry(ok: boolean): BufferGeometry {
  if (!ok) return constructionFrameGeometry();
  const t = 0.1;
  const parts = [rect(-1, 1 - t, 1, 1), rect(-1, -1, 1, -1 + t), rect(-1, -1, -1 + t, 1), rect(1 - t, -1, 1, 1)].map((r) =>
    paint(new ShapeGeometry(shapeFrom(r)).rotateX(-Math.PI / 2), '#a8f5df'),
  );
  return merge(parts);
}

/**
 * W32 demolish mark: a square outline round a unit footprint with thin diagonals from corner to
 * corner. It differs by shape from the ghost's plain outline (build, upgrade) and from the skip mark
 * (dashed outline with a small cross in the middle), so it reads without colour.
 */
export function demolishMarkGeometry(): BufferGeometry {
  const t = 0.1;
  const hex = '#ffb08a';
  const flat = (pts: Pt[]) => paint(new ShapeGeometry(shapeFrom(pts)).rotateX(-Math.PI / 2), hex);
  const parts = [rect(-1, 1 - t, 1, 1), rect(-1, -1, 1, -1 + t), rect(-1, -1, -1 + t, 1), rect(1 - t, -1, 1, 1)].map(flat);
  // the diagonals, each a thin band ending inside the outline's corners
  const h = t * 0.6;
  const e = 1 - t;
  parts.push(flat([[-e, -e + h], [-e + h, -e], [e, e - h], [e - h, e]]));
  parts.push(flat([[e - h, -e], [e, -e + h], [-e + h, e], [-e, e - h]]));
  return merge(parts);
}

/**
 * Reserved site (W24): a dotted outline round a unit footprint (scaled to the footprint). Dots, not
 * the construction frame's dashes or the ghost's solid line, so the three states differ by shape.
 */
export function reservedOutlineGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const n = 8;
  const d = 0.07;
  for (let i = 0; i <= n; i++) {
    const a = -1 + (2 * i) / n;
    for (const [x, y] of [[a, 1], [a, -1], [1, a], [-1, a]] as Pt[]) parts.push(paint(new ShapeGeometry(shapeFrom(rect(x - d, y - d, x + d, y + d))).rotateX(-Math.PI / 2), '#a8f5df'));
  }
  return merge(parts);
}

/** Health bar: unit-length strip along +X (back plate and fill are separate meshes). */
export function barGeometry(): BufferGeometry {
  return merge([part(box(1, 0.06, 0.16), '#ffffff', { x: 0.5 })]);
}
