// On-screen readout, quality and view toggles, a static icon command bar (mock) and a live
// minimap. Shapes, not colours, separate kinds on the minimap and in the icons (colour-blind).

import { Vector3, type PerspectiveCamera, type Raycaster } from 'three';
import './style.css';
import { field, WATER_LEVEL } from '../world/heightfield.ts';
import { buildings, centreOf, sizeOf, terrain, type AlienKind } from '../world/layout.ts';

export interface HudStats {
  fps: number;
  cpuMs: number;
  /** -1 when the timer query extension is missing. */
  gpuMs: number;
  calls: number;
  triangles: number;
  texMB: number;
  rtMB: number;
  textures: number;
  renderer: string;
  quality: 'high' | 'medium';
  view: 'reference' | 'strategic';
  particles: number;
}

const ICON = (body: string) => `<svg viewBox="0 0 32 32" fill="none" stroke="#efe6d6" stroke-width="1.6" stroke-linejoin="round">${body}</svg>`;
const ICONS: Array<[string, string, string]> = [
  ['Wall', '1', ICON('<path d="M4 24h24M6 24V12l4-3h12l4 3v12" /><path d="M6 15h20" />')],
  ['Gun turret', '2', ICON('<path d="M5 25h22l-3-6H8z" /><rect x="10" y="12" width="10" height="7" /><path d="M20 15h9" stroke-width="2.4" />')],
  ['Area cannon', '3', ICON('<path d="M5 25h22l-3-5H8z" /><path d="M9 20a7 7 0 0 1 14 0" /><path d="M16 15l7-8" stroke-width="3" />')],
  ['Beam turret', '4', ICON('<path d="M9 27h14l-3-4h-8z" /><path d="M14 23l1-16h2l1 16" /><circle cx="16" cy="5" r="2" fill="#7fe8ff" stroke="none" />')],
  ['Heavy cannon', '5', ICON('<path d="M3 26h20l-3-5H6z" /><rect x="6" y="13" width="11" height="8" /><path d="M17 16h13" stroke-width="3" />')],
  ['Shield generator', '6', ICON('<path d="M4 26a12 12 0 0 1 24 0" stroke-dasharray="3 2" /><path d="M12 26l1-8h6l1 8" /><circle cx="16" cy="15" r="2.5" />')],
  ['Mass extractor', 'M', ICON('<path d="M7 27h18" /><path d="M11 27l3-20h4l3 20" /><path d="M12 19h8M13 13h6" />')],
  ['Generator', 'G', ICON('<rect x="9" y="12" width="14" height="14" rx="2" /><path d="M9 12a7 5 0 0 1 14 0" /><path d="M16 15v8M13 19h6" />')],
  ['Salvage depot', 'P', ICON('<path d="M5 26h22M7 26l2-10h14l2 10" /><path d="M23 16V6h-9l-3 4" />')],
  ['Research station', 'L', ICON('<path d="M4 26h24" /><path d="M7 26a9 9 0 0 1 18 0" /><path d="M24 14l4-6M26 6l3 3" />')],
];

export class Hud {
  private stats = document.createElement('div');
  private mm = document.createElement('canvas');
  private mmBg: ImageData | null = null;
  readonly onQuality: Array<(q: 'high' | 'medium') => void> = [];
  readonly onView: Array<(v: 'reference' | 'strategic') => void> = [];
  private readonly X0 = -12;
  private readonly X1 = 140;
  private readonly Z0 = -12;
  private readonly Z1 = 140;

  constructor() {
    this.stats.id = 'stats';
    this.stats.className = 'panel';
    document.body.appendChild(this.stats);

    const bar = document.createElement('div');
    bar.id = 'cmdbar';
    bar.className = 'panel';
    ICONS.forEach(([title, key, svg], i) => {
      if (i === 6) {
        const s = document.createElement('div');
        s.className = 'sep';
        bar.appendChild(s);
      }
      const b = document.createElement('div');
      b.className = 'cb';
      b.title = title;
      b.innerHTML = `${svg}<span>${key}</span>`;
      bar.appendChild(b);
    });
    document.body.appendChild(bar);

    const mmp = document.createElement('div');
    mmp.id = 'minimap';
    mmp.className = 'panel';
    this.mm.width = 210;
    this.mm.height = 210;
    mmp.appendChild(this.mm);
    document.body.appendChild(mmp);

    const hint = document.createElement('div');
    hint.id = 'hint';
    hint.className = 'panel';
    hint.textContent = 'V: reference / strategic view · Q: quality · drag: orbit · wheel: zoom · right-drag: pan';
    document.body.appendChild(hint);
  }

  private bg(): ImageData {
    if (this.mmBg) return this.mmBg;
    const W = this.mm.width;
    const img = new ImageData(W, W);
    const hs = new Float32Array(W * W);
    for (let j = 0; j < W; j++)
      for (let i = 0; i < W; i++) hs[j * W + i] = field.height(this.X0 + ((i + 0.5) / W) * (this.X1 - this.X0), this.Z0 + ((j + 0.5) / W) * (this.Z1 - this.Z0));
    for (let j = 0; j < W; j++)
      for (let i = 0; i < W; i++) {
        const h = hs[j * W + i]!;
        const dx = hs[j * W + Math.min(W - 1, i + 1)]! - hs[j * W + Math.max(0, i - 1)]!;
        const dz = hs[Math.min(W - 1, j + 1) * W + i]! - hs[Math.max(0, j - 1) * W + i]!;
        const shade = Math.max(0.35, Math.min(1.3, 0.95 - 0.12 * (dx + dz * 0.6)));
        let c: [number, number, number] = h < WATER_LEVEL ? [70, 170, 165] : [150 + h * 3, 85 + h * 3, 55 + h * 2];
        c = c.map((v) => Math.max(0, Math.min(255, v * shade))) as [number, number, number];
        const o = (j * W + i) * 4;
        img.data[o] = c[0];
        img.data[o + 1] = c[1];
        img.data[o + 2] = c[2];
        img.data[o + 3] = 255;
      }
    this.mmBg = img;
    return img;
  }

  drawMinimap(aliens: Array<{ kind: AlienKind; x: number; z: number; alive: boolean }>, camera: PerspectiveCamera, ray: Raycaster): void {
    const g = this.mm.getContext('2d')!;
    g.putImageData(this.bg(), 0, 0);
    const W = this.mm.width;
    const sx = (x: number) => ((x - this.X0) / (this.X1 - this.X0)) * W;
    const sz = (z: number) => ((z - this.Z0) / (this.Z1 - this.Z0)) * W;
    // map edge
    g.strokeStyle = 'rgba(240,230,210,0.35)';
    g.strokeRect(sx(0), sz(0), sx(128) - sx(0), sz(128) - sz(0));
    // buildings: pale filled squares
    g.fillStyle = '#efe6d6';
    for (const b of buildings) {
      const c = centreOf(b);
      const s = Math.max(1.6, (sizeOf(b.kind) / (this.X1 - this.X0)) * W);
      g.fillRect(sx(c.x) - s / 2, sz(c.z) - s / 2, s, s);
    }
    // aliens: dark outlined triangles (rushers small dots, breakers larger squares)
    for (const a of aliens) {
      if (!a.alive) continue;
      const x = sx(a.x);
      const y = sz(a.z);
      g.fillStyle = '#111';
      g.strokeStyle = '#ffb27a';
      g.lineWidth = 1;
      g.beginPath();
      if (a.kind === 'breaker') g.rect(x - 3, y - 3, 6, 6);
      else if (a.kind === 'rusher') g.arc(x, y, 1.6, 0, 6.283);
      else {
        g.moveTo(x, y - 3.2);
        g.lineTo(x + 3, y + 2.4);
        g.lineTo(x - 3, y + 2.4);
        g.closePath();
      }
      g.fill();
      g.stroke();
    }
    // entries: arrows
    for (const e of terrain.entries) {
      g.fillStyle = '#ffd9b0';
      g.beginPath();
      const x = sx(e.x);
      const y = sz(e.z);
      g.moveTo(x + e.dirX * 7, y + e.dirZ * 7);
      g.lineTo(x - e.dirZ * 4, y + e.dirX * 4);
      g.lineTo(x + e.dirZ * 4, y - e.dirX * 4);
      g.fill();
    }
    // camera footprint on the ground plane y = 0
    const pts: Vector3[] = [];
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      ray.setFromCamera({ x: u, y: v } as never, camera);
      const d = ray.ray.direction;
      const o = ray.ray.origin;
      const t = d.y < -0.01 ? (0 - o.y) / d.y : 600;
      pts.push(o.clone().addScaledVector(d, Math.min(t, 600)));
    }
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1.2;
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(sx(p.x), sz(p.z)) : g.moveTo(sx(p.x), sz(p.z))));
    g.closePath();
    g.stroke();
  }

  setStats(s: HudStats): void {
    const row = (k: string, v: string) => `<div class="row"><span class="k">${k}</span><span>${v}</span></div>`;
    this.stats.innerHTML =
      `<div style="font-weight:600;margin-bottom:4px">W17 look test A — code-built + CC0 photo textures</div>` +
      row('fps', s.fps.toFixed(1)) +
      row('frame CPU', `${s.cpuMs.toFixed(2)} ms`) +
      row('GPU timer (relative)', s.gpuMs < 0 ? 'n/a' : `${s.gpuMs.toFixed(1)} ms`) +
      row('draw calls', String(s.calls)) +
      row('triangles', s.triangles.toLocaleString('en-GB')) +
      row('GPU mem (textures)', `${s.texMB.toFixed(0)} MB est. (${s.textures})`) +
      row('GPU mem (render targets)', `${s.rtMB.toFixed(0)} MB est.`) +
      row('particles', String(s.particles)) +
      `<div class="gpu">${s.renderer}</div>` +
      `<div class="btns">` +
      `<button class="tg" data-q="high" aria-pressed="${s.quality === 'high'}">High</button>` +
      `<button class="tg" data-q="medium" aria-pressed="${s.quality === 'medium'}">Medium</button>` +
      `<button class="tg" data-v="reference" aria-pressed="${s.view === 'reference'}">Reference angle</button>` +
      `<button class="tg" data-v="strategic" aria-pressed="${s.view === 'strategic'}">Strategic</button>` +
      `</div>`;
    this.stats.querySelectorAll<HTMLButtonElement>('button[data-q]').forEach((b) => (b.onclick = () => this.onQuality.forEach((f) => f(b.dataset.q as 'high' | 'medium'))));
    this.stats.querySelectorAll<HTMLButtonElement>('button[data-v]').forEach((b) => (b.onclick = () => this.onView.forEach((f) => f(b.dataset.v as 'reference' | 'strategic'))));
  }
}
