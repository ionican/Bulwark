// Bench camera: OrbitControls (left-drag orbit, wheel zoom, right-drag pan) plus eased moves to
// named presets. Each preset also sets the field of view.

import { PerspectiveCamera, Spherical, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface CamView {
  target: [number, number, number];
  distance: number;
  /** Degrees above the horizon. */
  elevation: number;
  /** Degrees; 0 = camera on +z of the target, positive turns towards +x. */
  azimuth: number;
  fov: number;
}

export type Preset = 'game' | 'close' | 'concept' | 'lineup';

export const PRESETS: Record<Preset, CamView> = {
  // the game's camera at its starting zoom (game/src/main.ts: distance 50; cameraRig.ts: 45° fov,
  // pitchFor(50) = 68.9°)
  game: { target: [4, 0, -2], distance: 50, elevation: 68.9, azimuth: -30, fov: 45 },
  close: { target: [0.25, 0.72, 0], distance: 5.6, elevation: 17, azimuth: -38, fov: 30 },
  // the concept image's view: low, long lens, front-left three-quarter, barrel towards the camera
  concept: { target: [0.06, 0.62, 0.02], distance: 4.6, elevation: 17, azimuth: -100, fov: 27 },
  lineup: { target: [3.9, 0.4, 0.3], distance: 11.5, elevation: 26, azimuth: -4, fov: 34 },
};

export class BenchCamera {
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  private tween: { from: CamView; to: CamView; t: number; dur: number } | null = null;

  constructor(dom: HTMLElement, aspect: number) {
    this.camera = new PerspectiveCamera(30, aspect, 0.05, 2000);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 260;
    this.controls.maxPolarAngle = (86 * Math.PI) / 180;
    this.apply(PRESETS.close);
  }

  now(): CamView {
    const off = new Vector3().subVectors(this.camera.position, this.controls.target);
    const s = new Spherical().setFromVector3(off);
    return {
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
      distance: s.radius,
      elevation: 90 - (s.phi * 180) / Math.PI,
      azimuth: (s.theta * 180) / Math.PI,
      fov: this.camera.fov,
    };
  }

  apply(v: CamView): void {
    const phi = ((90 - v.elevation) * Math.PI) / 180;
    const theta = (v.azimuth * Math.PI) / 180;
    this.controls.target.set(...v.target);
    this.camera.position.setFromSpherical(new Spherical(v.distance, phi, theta)).add(this.controls.target);
    this.camera.fov = v.fov;
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  go(v: CamView, instant = false): void {
    if (instant) {
      this.tween = null;
      this.apply(v);
      return;
    }
    this.tween = { from: this.now(), to: v, t: 0, dur: 1.1 };
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
      da = ((((da + 180) % 360) + 360) % 360) - 180;
      this.apply({
        target: [L(tw.from.target[0], tw.to.target[0]), L(tw.from.target[1], tw.to.target[1]), L(tw.from.target[2], tw.to.target[2])],
        distance: Math.exp(L(Math.log(tw.from.distance), Math.log(tw.to.distance))),
        elevation: L(tw.from.elevation, tw.to.elevation),
        azimuth: tw.from.azimuth + da * u,
        fov: L(tw.from.fov, tw.to.fov),
      });
      if (tw.t >= tw.dur) this.tween = null;
    } else this.controls.update();
    this.camera.near = Math.max(0.05, this.distance * 0.01);
    this.camera.far = this.distance * 4 + 600;
    this.camera.updateProjectionMatrix();
  }
}
