// W25c (review finding 5): the volume each unit and alien kind is picked by — a vertical cylinder
// standing on the ground at the entity's position, `radius` and `height` in tiles. Sized to the
// drawn models at rest, measured from the submitted instances (the union of every part's bounding
// box under its instance matrix, ModelRenderer at level 0, 9 Oct 2026):
//
//   kind       measured height   measured reach from the centre   volume (height, radius)
//   commander  3.715             1.304                            3.8, 1.35
//   engineer   0.940             0.191                            0.95, 0.45 (the simulation's radius)
//   rusher     0.973             0.761                            1.0, 0.8
//   hunter     1.232             1.450                            1.25, 1.5
//   breaker    2.091             2.758                            2.1, 2.8
//   saboteur   2.300             1.298                            2.35, 1.35
//
// The reach is the furthest corner of the model's ground-plane bounding box from the entity's
// position, so the cylinder covers the model at any heading. The radius is never below the
// simulation's own (kinds.ts), so nothing is harder to click than before. test/w25c-picking checks
// the table against a fresh measurement. The volumes do not animate: a stable target to click.

import { A, U, alienInfo, unitInfo } from '../sim/kinds.ts';

export interface PickVolume {
  radius: number;
  height: number;
}

const UNIT_VOLUMES: Record<number, PickVolume> = {
  [U.commander]: { height: 3.8, radius: 1.35 },
  [U.engineer]: { height: 0.95, radius: 0.45 },
};
const ALIEN_VOLUMES: Record<number, PickVolume> = {
  [A.rusher]: { height: 1.0, radius: 0.8 },
  [A.hunter]: { height: 1.25, radius: 1.5 },
  [A.breaker]: { height: 2.1, radius: 2.8 },
  [A.saboteur]: { height: 2.35, radius: 1.35 },
};

export const unitVolume = (kind: number): PickVolume => UNIT_VOLUMES[kind] ?? { height: 1, radius: unitInfo(kind).radius };
export const alienVolume = (kind: number): PickVolume => ALIEN_VOLUMES[kind] ?? { height: 1, radius: alienInfo(kind).radius };
