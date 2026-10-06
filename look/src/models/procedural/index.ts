// The code-built model source for W17. W18 replaces this module with a glTF-backed ModelSource.

import type { Mats } from '../materials.ts';
import type { ModelDef, ModelSource } from '../types.ts';
import type { AlienKind, BuildingKind } from '../../world/layout.ts';
import { ALIEN_MAKERS } from './aliens.ts';
import { BUILDING_MAKERS, wallTower } from './buildings.ts';
import { commander, engineer } from './units.ts';

export function proceduralSource(m: Mats): ModelSource {
  const cache = new Map<string, ModelDef>();
  const get = (key: string, make: () => ModelDef) => {
    let d = cache.get(key);
    if (!d) cache.set(key, (d = make()));
    return d;
  };
  return {
    name: 'procedural (code-built)',
    building: (k: BuildingKind, tier = 1) => (k === 'wall' && tier >= 3 ? get('b:wallTower', () => wallTower(m)) : get(`b:${k}`, () => BUILDING_MAKERS[k](m))),
    unit: (k) => get(`u:${k}`, () => (k === 'commander' ? commander(m) : engineer(m))),
    alien: (k: AlienKind) => get(`a:${k}`, () => ALIEN_MAKERS[k](m)),
  };
}
