// Debug labels for the detail levels: a badge above each drawn turret whose shape and letter name
// its level (full = circle "F", middle = square "M", simple = triangle "S", icon = diamond "I"),
// so the bands read without relying on colour. Camera-facing, constant size on screen, drawn on
// top of everything.

import { CanvasTexture, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, PlaneGeometry, ShaderMaterial, DynamicDrawUsage, LinearFilter } from 'three';

const CELL = 64;

function atlas(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = CELL * 4;
  c.height = CELL;
  const g = c.getContext('2d')!;
  const fill = ['#f4efe6', '#7fe0ff', '#ffc65a', '#ff8f8f'];
  const letters = ['F', 'M', 'S', 'I'];
  for (let i = 0; i < 4; i++) {
    const ox = i * CELL;
    const cx = ox + CELL / 2;
    const cy = CELL / 2;
    g.beginPath();
    if (i === 0) g.arc(cx, cy, 26, 0, Math.PI * 2);
    else if (i === 1) g.rect(cx - 24, cy - 24, 48, 48);
    else if (i === 2) {
      g.moveTo(cx, cy - 28);
      g.lineTo(cx + 28, cy + 22);
      g.lineTo(cx - 28, cy + 22);
      g.closePath();
    } else {
      g.moveTo(cx, cy - 29);
      g.lineTo(cx + 29, cy);
      g.lineTo(cx, cy + 29);
      g.lineTo(cx - 29, cy);
      g.closePath();
    }
    g.fillStyle = fill[i]!;
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = '#120f0d';
    g.stroke();
    g.fillStyle = '#120f0d';
    g.font = 'bold 30px ui-sans-serif, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(letters[i]!, cx, cy + (i === 2 ? 6 : 1));
  }
  const t = new CanvasTexture(c);
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  return t;
}

export class LevelBadges {
  readonly mesh: Mesh;
  private pos: InstancedBufferAttribute;
  private cell: InstancedBufferAttribute;
  private geo: InstancedBufferGeometry;
  private n = 0;
  private mat: ShaderMaterial;

  constructor(cap: number) {
    const quad = new PlaneGeometry(1, 1);
    this.geo = new InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.geo.setAttribute('uv', quad.getAttribute('uv'));
    this.pos = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.pos.setUsage(DynamicDrawUsage);
    this.cell = new InstancedBufferAttribute(new Float32Array(cap), 1);
    this.cell.setUsage(DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.pos);
    this.geo.setAttribute('iCell', this.cell);
    this.geo.instanceCount = 0;
    this.mat = new ShaderMaterial({
      uniforms: { tAtlas: { value: atlas() }, uPx: { value: 18 }, uWppd: { value: 0.001 } },
      vertexShader: /* glsl */ `
        attribute vec3 iPos; attribute float iCell; uniform float uPx; uniform float uWppd;
        varying vec2 vUv;
        void main() {
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          mv.xy += position.xy * uPx * uWppd * -mv.z;
          gl_Position = projectionMatrix * mv;
          vUv = vec2((uv.x + iCell) / 4.0, uv.y);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tAtlas; varying vec2 vUv;
        void main() { vec4 c = texture2D(tAtlas, vUv); if (c.a < 0.1) discard; gl_FragColor = vec4(c.rgb * 1.0, c.a); }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 40;
    this.mesh.visible = false;
  }

  begin(): void {
    this.n = 0;
  }

  push(x: number, y: number, z: number, level: number): void {
    if (this.n >= this.cell.count) return;
    const a = this.pos.array as Float32Array;
    a[this.n * 3] = x;
    a[this.n * 3 + 1] = y;
    a[this.n * 3 + 2] = z;
    (this.cell.array as Float32Array)[this.n] = level;
    this.n++;
  }

  commit(wppd: number, px: number): void {
    this.geo.instanceCount = this.n;
    this.pos.needsUpdate = true;
    this.cell.needsUpdate = true;
    this.mat.uniforms.uWppd!.value = wppd;
    this.mat.uniforms.uPx!.value = px;
  }
}
