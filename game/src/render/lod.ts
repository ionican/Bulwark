// Level-of-detail choice per object by its distance from the camera, with hysteresis so an object
// near a threshold does not flicker. Each object switches on its own distance, so a zoom changes
// the scene gradually from the near edge to the far edge rather than all at once.

export const LOD_FULL = 0;
export const LOD_SIMPLE = 1;
export const LOD_ICON = 2;
export const LOD_LEVELS = 3;

/** Camera distance (world units) at which full -> simple and simple -> icon. */
export const LOD_THRESHOLDS: readonly number[] = [60, 125];
export const LOD_HYSTERESIS = 0.08;

/**
 * Next level for an object currently at `prev` (or 255 for "new object") at distance `dist`.
 * Moving to a coarser level needs dist > threshold × (1 + h); back to finer needs dist < threshold × (1 - h).
 */
export function chooseLod(prev: number, dist: number, thresholds: readonly number[] = LOD_THRESHOLDS, h = LOD_HYSTERESIS): number {
  if (prev >= LOD_LEVELS) {
    let l = 0;
    while (l < thresholds.length && dist > thresholds[l]!) l++;
    return l;
  }
  let l = prev;
  while (l < thresholds.length && dist > thresholds[l]! * (1 + h)) l++;
  while (l > 0 && dist < thresholds[l - 1]! * (1 - h)) l--;
  return l;
}
