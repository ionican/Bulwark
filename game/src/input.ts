// Pointer gestures on the game view (W24 run 2a, Richard's feedback: the workshop camera's feel).
//
//   left-drag            orbit: yaw and tilt (OrbitControls' LEFT = ROTATE)
//   right-drag           pan on the ground plane (RIGHT = PAN)
//   middle-drag          dolly (MIDDLE = DOLLY); the wheel zooms towards the cursor (main.ts)
//   Shift + left-drag    box selection
//   left-drag in a build mode (building, upgrading)  lays the line or run; never orbits
//                        (W23's painter takes the left button the same way)
//   click (moved ≤ 5 px) left: select or place; right: order or cancel. A click never moves the
//                        camera: nothing is sent to the orbit until the pointer has moved more than
//                        5 px, and then the whole movement since the press is.
//
// No DOM here: main.ts forwards pointer events, the tests drive it directly.

import type { PerspectiveCamera } from 'three';
import type { Orbit } from './render/cameraRig.ts';

export interface PointerIn {
  button: number;
  x: number;
  y: number;
  shift: boolean;
}

export type DragMode = 'orbit' | 'pan' | 'dolly' | 'box' | 'build';

export interface GestureHost {
  camera: PerspectiveCamera;
  viewportHeight(): number;
  /** A build or upgrade tool is active (left-drag lays a line or run). */
  building(): boolean;
  /** Pointer released without moving more than the threshold. */
  click(button: number, x: number, y: number, shift: boolean): void;
  /** Shift + left-drag released: the screen rectangle. */
  box(x0: number, y0: number, x1: number, y1: number, shift: boolean): void;
  /** Box outline while dragging (null to hide). */
  boxPreview(rect: { x0: number; y0: number; x1: number; y1: number } | null): void;
  /** Left-drag in a build mode released: from the press to the release point. */
  buildDrag(x0: number, y0: number, x1: number, y1: number, shift: boolean): void;
}

/** Movement (|dx| + |dy|, CSS pixels) beyond which a press is a drag, not a click. */
export const DRAG_THRESHOLD = 5;

export class Gestures {
  private press: { button: number; x0: number; y0: number; x: number; y: number; shift: boolean; mode: DragMode; moved: boolean } | null = null;

  constructor(
    readonly orbit: Orbit,
    readonly host: GestureHost,
  ) {}

  get dragging(): DragMode | null {
    return this.press?.moved ? this.press.mode : null;
  }

  down(e: PointerIn): void {
    const mode: DragMode = e.button === 1 ? 'dolly' : e.button === 2 ? 'pan' : this.host.building() ? 'build' : e.shift ? 'box' : 'orbit';
    this.press = { button: e.button, x0: e.x, y0: e.y, x: e.x, y: e.y, shift: e.shift, mode, moved: false };
  }

  move(e: PointerIn): void {
    const p = this.press;
    if (!p) return;
    if (!p.moved && Math.abs(e.x - p.x0) + Math.abs(e.y - p.y0) > DRAG_THRESHOLD) {
      p.moved = true;
      p.x = p.x0;
      p.y = p.y0;
    }
    if (!p.moved) return;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    p.x = e.x;
    p.y = e.y;
    const h = this.host.viewportHeight();
    if (p.mode === 'orbit') this.orbit.rotate(dx, dy, h);
    else if (p.mode === 'pan') this.orbit.pan(dx, dy, this.host.camera, h);
    else if (p.mode === 'dolly') this.orbit.dolly(dy);
    else if (p.mode === 'box') this.host.boxPreview({ x0: p.x0, y0: p.y0, x1: e.x, y1: e.y });
  }

  up(e: PointerIn): void {
    const p = this.press;
    this.press = null;
    if (!p) return;
    if (p.mode === 'box') this.host.boxPreview(null);
    if (!p.moved) {
      this.host.click(p.button, e.x, e.y, e.shift);
      return;
    }
    if (p.mode === 'box') this.host.box(p.x0, p.y0, e.x, e.y, e.shift);
    else if (p.mode === 'build') this.host.buildDrag(p.x0, p.y0, e.x, e.y, e.shift);
  }

  cancel(): void {
    if (this.press?.mode === 'box') this.host.boxPreview(null);
    this.press = null;
  }
}
