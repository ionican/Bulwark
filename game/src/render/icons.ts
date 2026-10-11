// Strategic-zoom icons for every kind (W24 run 2a). One atlas of 8 × 4 cells, 128 px each, icon
// units ±1.4 per cell (W22/W23's layout), drawn pale with a dark outline so every icon is told
// apart by its shape and outline, never by colour (Richard is colour-blind):
//
//   W23's own icons      wall, gate, mass and rare extractors, bare deposits, engineer, commander
//   W22 kit icons        the five turret kinds: base outline + weapon glyph (bastion circle + bar,
//                        anvil circle + stub, lantern circle + lens, rampart square + bar,
//                        lookout circle + twin bars)
//   new here (W23 style) generator (circle, lightning bolt), research station (flask), depot
//                        (hopper: wide-topped trapezoid), shredder (square, two rollers), smelter
//                        (square, two chimneys), assembler (cog), shield generator (heater shield),
//                        belt (long bar with one chevron), splitter (one in, three chevrons out),
//                        merger (three chevrons in, one out), rusher (arrowhead), hunter (long
//                        thin dart), breaker (wide block with a toothed ram), saboteur (diamond
//                        with an antenna), wreck (jagged scrap outline), core (W29: octagon with a
//                        square window round a diamond)
//
// Icons are flat quads on the ground (W22's iconQuad), turned so the icon's "up" is screen-up, or
// to the turret's aim and the belt's direction; their size is kept at a constant number of pixels.

import { CanvasTexture, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, LinearMipmapLinearFilter, SRGBColorSpace, type Texture } from 'three';
import { ICON_COLS, ICON_HALF, ICON_ROWS, drawIcon, iconMaterial, iconQuad } from './workshop/kit/icons.ts';
import type { IconSpec } from './workshop/kit/kit.ts';
import { writeYaw } from './workshop/stress/turretPose.ts';
import { drawW23Icon, type IconId as W23IconId } from './workshop/w23/icons.ts';

export const ICONS = [
  'wall',
  'gate',
  'mass',
  'rare',
  'massDeposit',
  'rareDeposit',
  'engineer',
  'commander',
  'commanderRing',
  'gun',
  'area',
  'beam',
  'heavy',
  'tempTurret',
  'generator',
  'lab',
  'depot',
  'shredder',
  'smelter',
  'assembler',
  'shield',
  'belt',
  'splitter',
  'merger',
  'rusher',
  'hunter',
  'breaker',
  'saboteur',
  'wreck',
  'core',
] as const;
export type IconName = (typeof ICONS)[number];
export const ICON = Object.fromEntries(ICONS.map((n, i) => [n, i])) as Record<IconName, number>;
const W23_IDS = new Set<string>(['wall', 'gate', 'mass', 'rare', 'massDeposit', 'rareDeposit', 'engineer', 'commander', 'commanderRing']);
const CELL = 128;
const INK = '#120f0d';
const PALE = '#ece6da';

type Ctx = OffscreenCanvasRenderingContext2D;

function solid(c: Ctx, lw = 0.16): void {
  c.lineWidth = lw;
  c.strokeStyle = INK;
  c.lineJoin = 'round';
  c.stroke();
  c.fillStyle = PALE;
  c.fill();
}

function poly(c: Ctx, pts: Array<[number, number]>): void {
  c.beginPath();
  pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
}

/** Chevron pointing along angle `a` (canvas: 0 = right, −π/2 = up), tip at (x, y). */
function chevron(c: Ctx, x: number, y: number, a: number, s: number): void {
  const p = (u: number, v: number): [number, number] => [x + Math.cos(a) * u - Math.sin(a) * v, y + Math.sin(a) * u + Math.cos(a) * v];
  poly(c, [p(0, 0), p(-0.5 * s, -0.42 * s), p(-0.5 * s, -0.16 * s), p(-0.22 * s, 0), p(-0.5 * s, 0.16 * s), p(-0.5 * s, 0.42 * s)]);
  solid(c, 0.08);
}

/** New icons (canvas y down: "up" on screen is −y). */
function drawNew(c: Ctx, id: IconName): void {
  switch (id) {
    case 'generator':
      c.beginPath();
      c.arc(0, 0, 0.9, 0, Math.PI * 2);
      solid(c);
      c.fillStyle = INK;
      poly(c, [[0.12, -0.7], [-0.36, 0.08], [-0.04, 0.08], [-0.18, 0.7], [0.38, -0.12], [0.06, -0.12], [0.2, -0.7]]);
      c.fill();
      break;
    case 'lab':
      // flask: neck, then a wide triangular body
      poly(c, [[-0.2, -0.95], [0.2, -0.95], [0.2, -0.35], [0.85, 0.85], [-0.85, 0.85], [-0.2, -0.35]]);
      solid(c);
      c.fillStyle = INK;
      poly(c, [[-0.42, 0.3], [0.42, 0.3], [0.62, 0.68], [-0.62, 0.68]]);
      c.fill();
      break;
    case 'depot':
      // hopper: wide top, narrow base, a bar across the top
      poly(c, [[-0.95, -0.6], [0.95, -0.6], [0.45, 0.8], [-0.45, 0.8]]);
      solid(c);
      c.fillStyle = INK;
      c.fillRect(-0.95, -0.82, 1.9, 0.18);
      break;
    case 'shredder':
      c.beginPath();
      c.rect(-0.9, -0.7, 1.8, 1.4);
      solid(c);
      for (const x of [-0.4, 0.4]) {
        c.beginPath();
        c.arc(x, 0, 0.32, 0, Math.PI * 2);
        c.fillStyle = INK;
        c.fill();
        c.beginPath();
        c.arc(x, 0, 0.12, 0, Math.PI * 2);
        c.fillStyle = PALE;
        c.fill();
      }
      break;
    case 'smelter':
      // a low block with two tall chimneys
      poly(c, [[-0.9, 0.85], [-0.9, -0.05], [-0.62, -0.05], [-0.62, -0.95], [-0.3, -0.95], [-0.3, -0.05], [0.3, -0.05], [0.3, -0.7], [0.62, -0.7], [0.62, -0.05], [0.9, -0.05], [0.9, 0.85]]);
      solid(c);
      c.fillStyle = INK;
      c.fillRect(-0.55, 0.25, 1.1, 0.22);
      break;
    case 'assembler': {
      // cog
      const pts: Array<[number, number]> = [];
      for (let k = 0; k < 8; k++) {
        const a0 = (k / 8) * Math.PI * 2;
        for (const [da, r] of [[-0.17, 0.62], [-0.11, 0.95], [0.11, 0.95], [0.17, 0.62]] as const) pts.push([Math.cos(a0 + da) * r, Math.sin(a0 + da) * r]);
      }
      poly(c, pts);
      solid(c, 0.12);
      c.beginPath();
      c.arc(0, 0, 0.26, 0, Math.PI * 2);
      c.fillStyle = INK;
      c.fill();
      break;
    }
    case 'shield':
      c.beginPath();
      c.moveTo(-0.8, -0.85);
      c.lineTo(0.8, -0.85);
      c.lineTo(0.8, 0.0);
      c.quadraticCurveTo(0.7, 0.62, 0, 0.98);
      c.quadraticCurveTo(-0.7, 0.62, -0.8, 0.0);
      c.closePath();
      solid(c);
      c.fillStyle = INK;
      c.fillRect(-0.09, -0.6, 0.18, 1.1);
      c.fillRect(-0.5, -0.25, 1.0, 0.18);
      break;
    case 'belt':
      poly(c, [[-0.38, -1.05], [0.38, -1.05], [0.38, 1.05], [-0.38, 1.05]]);
      solid(c, 0.12);
      chevron(c, 0, -0.45, -Math.PI / 2, 0.62);
      break;
    case 'splitter':
      poly(c, [[-0.18, 0.2], [0.18, 0.2], [0.18, 1.05], [-0.18, 1.05]]);
      solid(c, 0.1);
      chevron(c, 0, -0.95, -Math.PI / 2, 0.62);
      chevron(c, -0.85, -0.25, Math.PI, 0.62);
      chevron(c, 0.85, -0.25, 0, 0.62);
      break;
    case 'merger':
      poly(c, [[-0.18, -0.2], [0.18, -0.2], [0.18, -1.05], [-0.18, -1.05]]);
      solid(c, 0.1);
      chevron(c, 0, -1.05, -Math.PI / 2, 0.5);
      chevron(c, 0, 0.35, -Math.PI / 2, 0.62);
      chevron(c, -0.38, 0.05, 0, 0.62);
      chevron(c, 0.38, 0.05, Math.PI, 0.62);
      break;
    case 'rusher':
      poly(c, [[0, -0.95], [0.75, 0.7], [0, 0.3], [-0.75, 0.7]]);
      solid(c);
      break;
    case 'hunter':
      poly(c, [[0, -1.05], [0.3, 0.2], [0.55, 0.85], [0, 0.55], [-0.55, 0.85], [-0.3, 0.2]]);
      solid(c, 0.13);
      break;
    case 'breaker':
      poly(c, [[-0.85, 0.85], [-0.85, -0.35], [-0.55, -0.35], [-0.42, -0.85], [-0.22, -0.45], [0, -0.92], [0.22, -0.45], [0.42, -0.85], [0.55, -0.35], [0.85, -0.35], [0.85, 0.85]]);
      solid(c);
      break;
    case 'saboteur':
      poly(c, [[0, -0.35], [0.8, 0.25], [0, 0.85], [-0.8, 0.25]]);
      solid(c);
      c.strokeStyle = INK;
      c.lineWidth = 0.14;
      c.beginPath();
      c.moveTo(0, -0.35);
      c.lineTo(0, -0.85);
      c.stroke();
      c.beginPath();
      c.arc(0, -0.95, 0.16, 0, Math.PI * 2);
      solid(c, 0.08);
      break;
    case 'wreck':
      poly(c, [[-0.8, 0.3], [-0.5, -0.4], [-0.15, -0.1], [0.1, -0.7], [0.45, -0.25], [0.85, -0.35], [0.6, 0.35], [0.8, 0.7], [0.1, 0.5], [-0.35, 0.75]]);
      solid(c, 0.12);
      break;
    case 'core': {
      const oct: Array<[number, number]> = [];
      for (let k = 0; k < 8; k++) oct.push([Math.cos(((k + 0.5) * Math.PI) / 4) * 1.0, Math.sin(((k + 0.5) * Math.PI) / 4) * 1.0]);
      poly(c, oct);
      solid(c);
      c.fillStyle = INK;
      c.fillRect(-0.48, -0.48, 0.96, 0.96);
      poly(c, [[0, -0.32], [0.32, 0], [0, 0.32], [-0.32, 0]]);
      c.fillStyle = PALE;
      c.fill();
      break;
    }
    default:
      break;
  }
}

/** Kit icon spec of each turret kind (from the built kit, by the game kind's icon name). */
export type TurretIconSpecs = Partial<Record<IconName, IconSpec>>;

/** The atlas (browser only: OffscreenCanvas). */
export function buildIconAtlas(turrets: TurretIconSpecs, anisotropy = 1): CanvasTexture<OffscreenCanvas> {
  const cv = new OffscreenCanvas(CELL * ICON_COLS, CELL * ICON_ROWS);
  const c = cv.getContext('2d')!;
  ICONS.forEach((id, i) => {
    const cx = (i % ICON_COLS) * CELL;
    const cy = Math.floor(i / ICON_COLS) * CELL;
    const spec = turrets[id];
    if (spec) {
      drawIcon(c, spec, cx, cy);
      return;
    }
    const s = CELL / (2 * ICON_HALF);
    c.save();
    c.setTransform(s, 0, 0, s, cx + CELL / 2, cy + CELL / 2);
    if (W23_IDS.has(id)) drawW23Icon(c, id as W23IconId);
    else drawNew(c, id);
    c.restore();
  });
  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  t.anisotropy = anisotropy;
  t.name = 'icon-atlas';
  return t;
}

/** Ground icon quads: one instanced batch per icon, growing up to `max` instances each. */
export class IconBatches {
  readonly group = new Group();
  readonly meshes: InstancedMesh[] = [];
  private readonly counts: Int32Array;
  overflowed = false;

  constructor(
    atlas: Texture,
    private readonly max: number,
  ) {
    const mat = iconMaterial(atlas, false);
    this.counts = new Int32Array(ICONS.length);
    ICONS.forEach((id, i) => {
      const m = new InstancedMesh(iconQuad(i), mat, Math.min(64, max));
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.name = `icon/${id}`;
      m.userData.icon = id;
      m.frustumCulled = false;
      m.renderOrder = 20;
      m.count = 0;
      m.visible = false;
      this.group.add(m);
      this.meshes.push(m);
    });
    this.group.name = 'icons';
  }

  begin(): void {
    this.counts.fill(0);
  }

  /** Icon at (x, y, z), its "up" turned to `yaw` (turret convention), `size` tiles across. */
  push(icon: number, x: number, y: number, z: number, yaw: number, size: number): void {
    let m = this.meshes[icon]!;
    const k = this.counts[icon]!;
    if (k >= m.instanceMatrix.count) {
      const cap = m.instanceMatrix.count;
      if (cap >= this.max) {
        this.overflowed = true;
        return;
      }
      const next = new InstancedBufferAttribute(new Float32Array(Math.min(this.max, cap * 2) * 16), 16);
      next.setUsage(DynamicDrawUsage);
      (next.array as Float32Array).set(m.instanceMatrix.array as Float32Array);
      m.instanceMatrix = next;
      m = this.meshes[icon]!;
    }
    writeYaw(m.instanceMatrix.array as Float32Array, k * 16, x, y, z, yaw, size / (2 * ICON_HALF));
    this.counts[icon] = k + 1;
  }

  commit(): void {
    this.meshes.forEach((m, i) => {
      const n = this.counts[i]!;
      m.count = n;
      m.visible = n > 0;
      if (n) {
        m.instanceMatrix.clearUpdateRanges();
        m.instanceMatrix.addUpdateRange(0, n * 16);
        m.instanceMatrix.needsUpdate = true;
      }
    });
  }
}
