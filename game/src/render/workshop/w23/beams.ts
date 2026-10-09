// Ported from look/src/w23/beams.ts for W24 run 2b (game/src/render/workshop/README: copies, adapted only where noted).
// W23 nano-beams and tracers: instanced HDR streaks (unlit, so they feed the bloom), refilled every
// frame. A beam's width is the larger of its own width and a few pixels at its distance from the
// camera, so an engineer's build beam still reads at the game camera, where the engineer is only a
// few pixels tall.

import { AdditiveBlending, BoxGeometry, Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from 'three';

const _m = new Matrix4();
const _q = new Quaternion();
const _d = new Vector3();
const _s = new Vector3();
const _mid = new Vector3();
const X = new Vector3(1, 0, 0);

export class Beams {
  readonly mesh: InstancedMesh;
  private colours: InstancedBufferAttribute;
  private n = 0;

  constructor(cap = 256) {
    const g = new BoxGeometry(1, 1, 1);
    g.translate(0.5, 0, 0);
    const m = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, blending: AdditiveBlending, depthWrite: false, fog: false });
    this.mesh = new InstancedMesh(g, m, cap);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.colours = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.colours.setUsage(DynamicDrawUsage);
    this.mesh.instanceColor = this.colours;
  }

  begin(): void {
    this.n = 0;
  }

  /**
   * A streak from a to b. `width` in tiles; `minPx` the least width on screen; `wppd` world units
   * per pixel per unit of distance; `cam` the camera position.
   */
  push(a: Vector3, b: Vector3, width: number, colour: Color, intensity: number, cam: Vector3, wppd: number, minPx = 2.2): void {
    if (this.n >= this.mesh.instanceMatrix.count) return;
    _d.subVectors(b, a);
    const len = _d.length();
    if (len < 1e-4) return;
    _q.setFromUnitVectors(X, _d.divideScalar(len));
    _mid.lerpVectors(a, b, 0.5);
    const w = Math.max(width, minPx * wppd * _mid.distanceTo(cam));
    _m.compose(a, _q, _s.set(len, w, w));
    this.mesh.setMatrixAt(this.n, _m);
    this.colours.setXYZ(this.n, colour.r * intensity, colour.g * intensity, colour.b * intensity);
    this.n++;
  }

  commit(): void {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.colours.needsUpdate = true;
    }
  }
}

export const BEAM_CYAN = new Color(0.25, 0.9, 1.0);
export const TRACER = new Color(1.0, 0.75, 0.4);
