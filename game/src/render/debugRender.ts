// W24 run 3 (D1): diagnostic controls for the overlays that are depth-tested — construction frames
// (entities.ts) and reserved-site outlines (models.ts), found by their materials' names. The
// browser check (scripts/check-panel.mjs, through __game.debugRender) turns their depth test off
// and on, and hides one, to show by pixels that a building in front hides the overlay behind it.
// They touch only these materials: no other mesh, material or simulation state.

import { Mesh, type Material, type Object3D } from 'three';

export const OVERLAY_NAMES = ['construction-frame', 'reserved-outline'] as const;
export type OverlayName = (typeof OVERLAY_NAMES)[number];

/** Meshes under `root` drawn with the material called `name`, in scene order. */
export function overlayMeshes(root: Object3D, name: string): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh && !Array.isArray(o.material) && (o.material as Material).name === name) out.push(o);
  });
  return out;
}

/** The distinct materials called `name` under `root`. */
function materialsOf(root: Object3D, name: string): Material[] {
  return [...new Set(overlayMeshes(root, name).map((m) => m.material as Material))];
}

/** Sets the overlays' depth test; returns how many materials it set. */
export function setOverlayDepthTest(root: Object3D, on: boolean): number {
  let n = 0;
  for (const name of OVERLAY_NAMES)
    for (const m of materialsOf(root, name)) {
      m.depthTest = on;
      m.needsUpdate = true;
      n++;
    }
  return n;
}

/** Hides (or shows) one overlay by its material; returns how many materials it set. */
export function hideOverlay(root: Object3D, name: string, hide: boolean): number {
  const mats = materialsOf(root, name);
  for (const m of mats) m.visible = !hide;
  return mats.length;
}
