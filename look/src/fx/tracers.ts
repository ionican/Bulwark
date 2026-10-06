// Projectiles and beams as instanced, emissive (HDR) streaks: gun tracers, area-cannon shells on
// a ballistic arc, heavy-cannon slugs, and beam-turret beams. Unlit, so they feed the bloom.

import { BoxGeometry, Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from 'three';

export interface Shot {
  from: Vector3;
  to: Vector3;
  t: number;
  dur: number;
  arc: number;
  len: number;
  width: number;
  colour: Color;
  beam: boolean;
  onHit?: () => void;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _a = new Vector3();
const _b = new Vector3();
const _d = new Vector3();
const _s = new Vector3();
const X = new Vector3(1, 0, 0);

export class Tracers {
  readonly mesh: InstancedMesh;
  private shots: Shot[] = [];
  private colours: InstancedBufferAttribute;

  constructor(cap = 400) {
    const g = new BoxGeometry(1, 1, 1);
    g.translate(0.5, 0, 0);
    const m = new MeshBasicMaterial({ color: 0xffffff, fog: true, toneMapped: false });
    this.mesh = new InstancedMesh(g, m, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.colours = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.colours.setUsage(DynamicDrawUsage);
    this.mesh.instanceColor = this.colours;
  }

  fire(s: Omit<Shot, 't'>): void {
    if (this.shots.length < this.mesh.instanceMatrix.count) this.shots.push({ ...s, t: 0 });
  }

  private pointAt(s: Shot, u: number, out: Vector3): Vector3 {
    out.lerpVectors(s.from, s.to, u);
    out.y += s.arc * 4 * u * (1 - u);
    return out;
  }

  update(dt: number, time: number): void {
    let n = 0;
    const keep: Shot[] = [];
    for (const s of this.shots) {
      s.t += dt;
      if (s.t >= s.dur) {
        s.onHit?.();
        continue;
      }
      keep.push(s);
      if (s.beam) {
        _a.copy(s.from);
        _b.copy(s.to);
      } else {
        const u = s.t / s.dur;
        const span = s.from.distanceTo(s.to);
        const back = Math.min(u, s.len / Math.max(0.01, span));
        this.pointAt(s, u, _b);
        this.pointAt(s, u - back, _a);
      }
      _d.subVectors(_b, _a);
      const len = _d.length();
      if (len < 1e-4) continue;
      _q.setFromUnitVectors(X, _d.divideScalar(len));
      const w = s.beam ? s.width * (0.8 + 0.35 * Math.sin(time * 40 + s.from.x)) : s.width;
      _m.compose(_a, _q, _s.set(len, w, w));
      this.mesh.setMatrixAt(n, _m);
      const fade = s.beam ? Math.min(1, (s.dur - s.t) * 6, s.t * 12) : 1;
      this.colours.setXYZ(n, s.colour.r * fade, s.colour.g * fade, s.colour.b * fade);
      n++;
    }
    this.shots = keep;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colours.needsUpdate = true;
  }
}
