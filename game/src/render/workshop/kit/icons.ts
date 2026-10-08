// Ported from look/src/kit/icons.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// Strategic-zoom icons of the 40 kinds. W20's icon (game/src/render/geometry.ts: round body, barrel
// bar, dark outline, pale fill) generalised: the body outline comes from the base (circle =
// octagonal, square = bunker, ring = low drum, triangle = pylon) and the forward glyph from the
// weapon, so the icon reads by shape. Kinds with the same base and weapon share an icon (25 icons).
//
// Every strategy draws the same thing: a quad turned to the aim, textured from one atlas
// (8 × 4 cells of 128 px). A, B and D bake the cell into the quad's UVs; C draws every icon in one
// batch and passes the cell offset per instance (attribute `iconUv`), computing uv · CELL + iconUv
// in the vertex shader, which is the same arithmetic the baked quads hold.

import { BufferAttribute, BufferGeometry, CanvasTexture, DoubleSide, LinearMipmapLinearFilter, MeshBasicMaterial, SRGBColorSpace, Vector2, type Texture } from 'three';
import type { Glyph, IconSpec, Outline } from './kit.ts';

export const ICON_COLS = 8;
export const ICON_ROWS = 4;
const CELL_PX = 128;
/** Half size of the icon quad in icon units (W20's icon spans about ±1.2). */
export const ICON_HALF = 1.4;
/** Cell size in UV units. */
export const CELL_UV: [number, number] = [1 / ICON_COLS, 1 / ICON_ROWS];

/** UV offset of a cell (bottom-left corner; the atlas is uploaded with flipY, row 0 at the top). */
export function cellOffset(i: number): [number, number] {
  const c = i % ICON_COLS;
  const r = Math.floor(i / ICON_COLS);
  return [c / ICON_COLS, 1 - (r + 1) / ICON_ROWS];
}

/**
 * The icon quad on the ground plane: icon x → turret z, icon y (forward) → turret +X, as W20's
 * icon. `cell` bakes the atlas cell into the UVs; null leaves 0..1 for the per-instance offset.
 */
export function iconQuad(cell: number | null): BufferGeometry {
  const H = ICON_HALF;
  const corners: Array<[number, number]> = [
    [-H, -H],
    [H, -H],
    [H, H],
    [-H, -H],
    [H, H],
    [-H, H],
  ];
  const pos = new Float32Array(18);
  const uv = new Float32Array(12);
  const [ox, oy] = cell === null ? [0, 0] : cellOffset(cell);
  const [sx, sy] = cell === null ? [1, 1] : CELL_UV;
  corners.forEach(([ix, iy], k) => {
    pos.set([iy, 0, ix], k * 3);
    const u = (ix + H) / (2 * H);
    const v = (iy + H) / (2 * H);
    uv[k * 2] = u * sx + ox;
    uv[k * 2 + 1] = v * sy + oy;
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  return g;
}

type Path = (c: OffscreenCanvasRenderingContext2D) => void;

function outlinePath(o: Outline): Path {
  const cy = -0.25;
  switch (o) {
    case 'circle':
    case 'ring':
      return (c) => c.arc(0, cy, 0.65, 0, Math.PI * 2);
    case 'square':
      return (c) => c.rect(-0.6, cy - 0.6, 1.2, 1.2);
    case 'triangle':
      return (c) => {
        // apex to the rear, flat edge facing the barrel
        c.moveTo(0, cy - 0.85);
        c.lineTo(0.78, cy + 0.5);
        c.lineTo(-0.78, cy + 0.5);
        c.closePath();
      };
  }
}

function glyphPaths(g: Glyph): Path[] {
  const rect = (x0: number, y0: number, x1: number, y1: number): Path => (c) => c.rect(x0, y0, x1 - x0, y1 - y0);
  const disc = (x: number, y: number, r: number): Path => (c) => {
    c.moveTo(x + r, y);
    c.arc(x, y, r, 0, Math.PI * 2);
  };
  switch (g) {
    case 'bar':
      return [rect(-0.14, 0.2, 0.14, 1.0)];
    case 'twin':
      return [rect(-0.32, 0.2, -0.08, 0.95), rect(0.08, 0.2, 0.32, 0.95)];
    case 'stub':
      return [rect(-0.24, 0.2, 0.24, 0.62), rect(-0.32, 0.56, 0.32, 0.78)];
    case 'rotary':
      return [rect(-0.12, 0.2, 0.12, 0.8), disc(0, 0.92, 0.24)];
    case 'pod':
      return [rect(-0.46, 0.12, 0.46, 0.8)];
    case 'lens':
      return [
        rect(-0.09, 0.2, 0.09, 0.78),
        (c) => {
          c.moveTo(0, 0.68);
          c.lineTo(0.28, 0.94);
          c.lineTo(0, 1.2);
          c.lineTo(-0.28, 0.94);
          c.closePath();
        },
      ];
    case 'quad':
      return [-0.36, -0.13, 0.13, 0.36].map((x) => rect(x - 0.06, 0.2, x + 0.06, 0.9));
  }
}

/** Draws one icon into a cell: dark outline (0.16 units, as W20's icon), pale fill. Exported for the game's atlas (W24 run 2a). */
export function drawIcon(c: OffscreenCanvasRenderingContext2D, spec: IconSpec, cx: number, cy: number): void {
  const s = CELL_PX / (2 * ICON_HALF);
  c.save();
  // icon x right, icon y (forward) up
  c.setTransform(s, 0, 0, -s, cx + CELL_PX / 2, cy + CELL_PX / 2);
  const paths = [outlinePath(spec.outline), ...glyphPaths(spec.glyph)];
  const trace = (p: Path) => {
    c.beginPath();
    p(c);
  };
  c.fillStyle = c.strokeStyle = '#120f0d';
  c.lineWidth = 0.32;
  c.lineJoin = 'round';
  for (const p of paths) {
    trace(p);
    c.fill();
    c.stroke();
  }
  c.fillStyle = '#ece6da';
  for (const p of paths) {
    trace(p);
    c.fill();
  }
  c.fillStyle = '#120f0d';
  if (spec.outline === 'ring') {
    c.beginPath();
    c.arc(0, -0.25, 0.3, 0, Math.PI * 2);
    c.fill();
  }
  if (spec.glyph === 'pod')
    for (const x of [-0.24, 0, 0.24])
      for (const y of [0.32, 0.6]) {
        c.beginPath();
        c.arc(x, y, 0.07, 0, Math.PI * 2);
        c.fill();
      }
  c.restore();
}

/** The atlas (browser only: OffscreenCanvas). */
export function iconAtlas(icons: IconSpec[], anisotropy = 1): CanvasTexture<OffscreenCanvas> {
  const cv = new OffscreenCanvas(CELL_PX * ICON_COLS, CELL_PX * ICON_ROWS);
  const c = cv.getContext('2d')!;
  icons.forEach((spec, i) => drawIcon(c, spec, (i % ICON_COLS) * CELL_PX, Math.floor(i / ICON_COLS) * CELL_PX));
  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  t.anisotropy = anisotropy;
  return t;
}

/**
 * Icon material: unlit, drawn over everything (W20's icon rule). `perInstance` adds the
 * per-instance cell offset (strategy C).
 */
export function iconMaterial(atlas: Texture, perInstance: boolean): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ map: atlas, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide, fog: false, toneMapped: false });
  m.name = perInstance ? 'icon-atlas-indexed' : 'icon-atlas';
  if (perInstance) {
    const cell = new Vector2(...CELL_UV);
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uCell = { value: cell };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 iconUv;\nuniform vec2 uCell;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = uv * uCell + iconUv;');
    };
    m.customProgramCacheKey = () => 'w22-icon-indexed';
  }
  return m;
}

export function iconFor(kindIcon: number): [number, number] {
  return cellOffset(kindIcon);
}
