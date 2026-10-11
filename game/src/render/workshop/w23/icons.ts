// Ported from look/src/w23/icons.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// W23 icons and markers. Everything is told apart by shape and outline, never by colour alone
// (Richard is colour-blind): pale fills with a dark outline, as W20–W22's icons.
//
//   ground icons (detail level "icon")  flat quads on the map, one batch per icon (W22 strategy B):
//     wall      filled square (a run of tiles reads as a solid band: the base outline)
//     gate      square with a gap across it between two posts
//     mass      hexagon with a drill cross             (game: extractors on mass deposits)
//     rare      diamond with a three-claw mark
//     deposit   dashed hexagon (mass) / dashed diamond (rare): a buildable spot
//   screen markers (constant pixel size, drawn over everything)
//     engineer  circle with a vertical bar cut out (the game's engineer icon) — shown over engineers
//               at middle and simple detail, where the figure is only a few pixels tall, and as
//               their icon beyond
//     commander five-point star (the game's commander icon), with a ring at strategic zoom
//     gate tool tick in a circle (fits) / cross in a square (does not fit)

import { CanvasTexture, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedBufferGeometry, InstancedMesh, LinearFilter, LinearMipmapLinearFilter, Mesh, PlaneGeometry, SRGBColorSpace, ShaderMaterial, type Matrix4, type Texture } from 'three';
import { iconMaterial, iconQuad } from '../kit/icons.ts';

export const ICON = {
  wall: 0,
  gate: 1,
  mass: 2,
  rare: 3,
  massDeposit: 4,
  rareDeposit: 5,
  engineer: 6,
  commander: 7,
  commanderRing: 8,
  gateOk: 9,
  gateNo: 10,
  beacon: 11,
} as const;
export type IconId = keyof typeof ICON;
const COLS = 8;
const ROWS = 4;
const CELL = 128;

type Ctx = OffscreenCanvasRenderingContext2D;

function poly(c: Ctx, n: number, r: number, rot = 0): void {
  c.beginPath();
  for (let k = 0; k < n; k++) {
    const a = rot + (k / n) * Math.PI * 2;
    if (k) c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    else c.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  c.closePath();
}

function star(c: Ctx, R: number, r: number): void {
  c.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? r : R;
    if (k) c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else c.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  c.closePath();
}

const INK = '#120f0d';
const PALE = '#ece6da';

/** Fill pale with a dark outline (the current path). */
function solid(c: Ctx, lw = 0.16): void {
  c.lineWidth = lw;
  c.strokeStyle = INK;
  c.lineJoin = 'round';
  c.stroke();
  c.fillStyle = PALE;
  c.fill();
}

/** Adapted for the game (W24 run 2a): exported, so the game's atlas draws the same icons. */
export function drawW23Icon(c: Ctx, id: IconId): void {
  switch (id) {
    case 'wall':
      // fills the whole cell, so neighbouring tiles join into one band (the base outline)
      c.fillStyle = PALE;
      c.fillRect(-1.4, -1.4, 2.8, 2.8);
      c.fillStyle = INK;
      c.fillRect(-0.18, -0.18, 0.36, 0.36);
      break;
    case 'gate':
      c.beginPath();
      c.rect(-0.95, -0.55, 1.9, 1.1);
      solid(c, 0.14);
      c.fillStyle = INK;
      c.fillRect(-0.45, -0.6, 0.9, 1.2);
      c.beginPath();
      c.rect(-0.45, -0.12, 0.9, 0.24);
      solid(c, 0.08);
      break;
    case 'mass':
      poly(c, 6, 0.9);
      solid(c);
      c.fillStyle = INK;
      c.fillRect(-0.12, -0.55, 0.24, 1.1);
      c.fillRect(-0.55, -0.12, 1.1, 0.24);
      break;
    case 'rare':
      poly(c, 4, 0.95);
      solid(c);
      c.strokeStyle = INK;
      c.lineWidth = 0.18;
      c.beginPath();
      for (let k = 0; k < 3; k++) {
        const a = -Math.PI / 2 + (k * 2 * Math.PI) / 3;
        c.moveTo(0, 0);
        c.lineTo(Math.cos(a) * 0.5, Math.sin(a) * 0.5);
      }
      c.stroke();
      break;
    case 'massDeposit':
    case 'rareDeposit':
      if (id === 'massDeposit') poly(c, 6, 0.85);
      else poly(c, 4, 0.9);
      c.setLineDash([0.28, 0.16]);
      c.lineWidth = 0.3;
      c.strokeStyle = INK;
      c.stroke();
      c.lineWidth = 0.14;
      c.strokeStyle = PALE;
      c.stroke();
      c.setLineDash([]);
      break;
    case 'engineer':
      c.beginPath();
      c.arc(0, 0, 0.8, 0, Math.PI * 2);
      solid(c);
      c.fillStyle = INK;
      c.fillRect(-0.13, -0.5, 0.26, 1.0);
      break;
    case 'commander':
      star(c, 1.0, 0.44);
      solid(c, 0.14);
      break;
    case 'commanderRing':
      c.beginPath();
      c.arc(0, 0, 0.92, 0, Math.PI * 2);
      c.lineWidth = 0.14;
      c.strokeStyle = INK;
      c.stroke();
      star(c, 0.72, 0.31);
      solid(c, 0.12);
      break;
    case 'gateOk':
      c.beginPath();
      c.arc(0, 0, 0.85, 0, Math.PI * 2);
      solid(c);
      c.strokeStyle = INK;
      c.lineWidth = 0.22;
      c.beginPath();
      c.moveTo(-0.45, 0.02);
      c.lineTo(-0.12, 0.38);
      c.lineTo(0.48, -0.36);
      c.stroke();
      break;
    case 'gateNo':
      c.beginPath();
      c.rect(-0.8, -0.8, 1.6, 1.6);
      solid(c);
      c.strokeStyle = INK;
      c.lineWidth = 0.22;
      c.beginPath();
      c.moveTo(-0.42, -0.42);
      c.lineTo(0.42, 0.42);
      c.moveTo(0.42, -0.42);
      c.lineTo(-0.42, 0.42);
      c.stroke();
      break;
    case 'beacon':
      poly(c, 3, 0.9, -Math.PI / 2);
      solid(c);
      break;
  }
}

/** The atlas: 8 × 4 cells of 128 px, icon units ±1.4 per cell (as W22's). */
export function w23Atlas(): CanvasTexture<OffscreenCanvas> {
  const cv = new OffscreenCanvas(CELL * COLS, CELL * ROWS);
  const c = cv.getContext('2d')!;
  for (const [id, i] of Object.entries(ICON)) {
    const s = CELL / (2 * 1.4);
    c.save();
    c.setTransform(s, 0, 0, s, (i % COLS) * CELL + CELL / 2, Math.floor(i / COLS) * CELL + CELL / 2);
    drawW23Icon(c, id as IconId);
    c.restore();
  }
  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  return t;
}

/** Ground icons: one instanced quad batch per icon, on the map, drawn over the scene. */
export class GroundIcons {
  readonly group = new Group();
  private meshes: InstancedMesh[] = [];
  private counts: number[] = [];

  constructor(atlas: Texture, cap = 1024) {
    const mat = iconMaterial(atlas, false);
    for (let i = 0; i < Object.keys(ICON).length; i++) {
      const m = new InstancedMesh(iconQuad(i), mat, cap);
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.frustumCulled = false;
      m.renderOrder = 20;
      m.count = 0;
      m.visible = false;
      this.group.add(m);
      this.meshes.push(m);
      this.counts.push(0);
    }
    this.group.name = 'w23-icons';
  }

  begin(): void {
    this.counts.fill(0);
  }

  push(icon: number, m: Matrix4): void {
    const mesh = this.meshes[icon]!;
    const k = this.counts[icon]!;
    if (k >= mesh.instanceMatrix.count) return;
    mesh.setMatrixAt(k, m);
    this.counts[icon] = k + 1;
  }

  commit(): void {
    this.meshes.forEach((m, i) => {
      m.count = this.counts[i]!;
      m.visible = m.count > 0;
      if (m.count) m.instanceMatrix.needsUpdate = true;
    });
  }

  get drawCalls(): number {
    return this.counts.filter((c) => c > 0).length;
  }
}

/** Screen markers: camera-facing, constant size in pixels, drawn over everything. */
export class ScreenMarkers {
  readonly mesh: Mesh;
  private pos: InstancedBufferAttribute;
  private cell: InstancedBufferAttribute;
  private geo: InstancedBufferGeometry;
  private mat: ShaderMaterial;
  private n = 0;

  constructor(atlas: Texture, cap = 512) {
    const quad = new PlaneGeometry(1, 1);
    this.geo = new InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.geo.setAttribute('uv', quad.getAttribute('uv'));
    this.pos = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.pos.setUsage(DynamicDrawUsage);
    // cell index, size in px
    this.cell = new InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    this.cell.setUsage(DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.pos);
    this.geo.setAttribute('iCell', this.cell);
    this.geo.instanceCount = 0;
    const t = atlas.clone();
    t.minFilter = LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    this.mat = new ShaderMaterial({
      uniforms: { tAtlas: { value: t }, uWppd: { value: 0.001 } },
      vertexShader: /* glsl */ `
        attribute vec3 iPos; attribute vec2 iCell; uniform float uWppd;
        varying vec2 vUv;
        void main() {
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          mv.xy += position.xy * iCell.y * uWppd * -mv.z;
          gl_Position = projectionMatrix * mv;
          float c = mod(iCell.x, ${COLS}.0);
          float r = floor(iCell.x / ${COLS}.0);
          vUv = vec2((uv.x + c) / ${COLS}.0, 1.0 - (r + 1.0 - uv.y) / ${ROWS}.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tAtlas; varying vec2 vUv;
        void main() { vec4 c = texture2D(tAtlas, vUv); if (c.a < 0.08) discard; gl_FragColor = c; }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
  }

  begin(): void {
    this.n = 0;
  }

  push(x: number, y: number, z: number, icon: number, px: number): void {
    if (this.n >= this.cell.count) return;
    const a = this.pos.array as Float32Array;
    a.set([x, y, z], this.n * 3);
    (this.cell.array as Float32Array).set([icon, px], this.n * 2);
    this.n++;
  }

  commit(wppd: number): void {
    this.geo.instanceCount = this.n;
    this.pos.needsUpdate = true;
    this.cell.needsUpdate = true;
    this.mat.uniforms.uWppd!.value = wppd;
    this.mesh.visible = this.n > 0;
  }
}
