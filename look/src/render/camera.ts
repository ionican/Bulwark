// Camera: orbit/zoom with OrbitControls, plus two composed views and an eased transition between
// them: "reference" (oblique, ~43° down, base lower-left and canyon upper-right, as in the
// reference image) and "strategic" (pulled back and steeper, most of map 1 in frame).

import { PerspectiveCamera, Spherical, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface View {
  target: [number, number, number];
  distance: number;
  /** Degrees above the horizon. */
  elevation: number;
  /** Degrees; 0 = camera south (+z) of the target, positive turns towards +x. */
  azimuth: number;
}

export const VIEWS: Record<'reference' | 'strategic', View> = {
  reference: { target: [95, -3, 54], distance: 62, elevation: 42, azimuth: -62 },
  strategic: { target: [92, -4, 40], distance: 230, elevation: 56, azimuth: -62 },
};

export class CameraRig {
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  current: keyof typeof VIEWS = 'reference';
  private tween: { from: View; to: View; t: number; dur: number } | null = null;

  constructor(dom: HTMLElement, aspect: number) {
    this.camera = new PerspectiveCamera(38, aspect, 1, 2000);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 400;
    this.controls.maxPolarAngle = (80 * Math.PI) / 180;
    this.controls.screenSpacePanning = false;
    this.apply(VIEWS.reference);
  }

  private viewNow(): View {
    const off = new Vector3().subVectors(this.camera.position, this.controls.target);
    const s = new Spherical().setFromVector3(off);
    return {
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
      distance: s.radius,
      elevation: 90 - (s.phi * 180) / Math.PI,
      azimuth: (s.theta * 180) / Math.PI,
    };
  }

  apply(v: View): void {
    const phi = ((90 - v.elevation) * Math.PI) / 180;
    const theta = (v.azimuth * Math.PI) / 180;
    this.controls.target.set(...v.target);
    this.camera.position.setFromSpherical(new Spherical(v.distance, phi, theta)).add(this.controls.target);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  go(name: keyof typeof VIEWS, instant = false): void {
    this.current = name;
    if (instant) {
      this.tween = null;
      this.apply(VIEWS[name]);
      return;
    }
    this.tween = { from: this.viewNow(), to: VIEWS[name], t: 0, dur: 1.4 };
  }

  toggle(): void {
    this.go(this.current === 'reference' ? 'strategic' : 'reference');
  }

  get distance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  update(dt: number): void {
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(tw.dur, tw.t + dt);
      let u = tw.t / tw.dur;
      u = u * u * (3 - 2 * u);
      const L = (a: number, b: number) => a + (b - a) * u;
      let da = tw.to.azimuth - tw.from.azimuth;
      da = ((da + 540) % 360) - 180;
      this.apply({
        target: [L(tw.from.target[0], tw.to.target[0]), L(tw.from.target[1], tw.to.target[1]), L(tw.from.target[2], tw.to.target[2])],
        distance: Math.exp(L(Math.log(tw.from.distance), Math.log(tw.to.distance))),
        elevation: L(tw.from.elevation, tw.to.elevation),
        azimuth: tw.from.azimuth + da * u,
      });
      if (tw.t >= tw.dur) this.tween = null;
    } else this.controls.update();
    this.camera.near = Math.max(0.5, this.distance * 0.08);
    this.camera.far = this.distance * 4 + 600;
    this.camera.updateProjectionMatrix();
  }
}
