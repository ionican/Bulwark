// W23 detail levels per asset: full / middle / simple / icon, chosen per object by its distance
// from the camera with W21's hysteresis rule (stress/lod.ts → the game's ±8 %).
//
// Thresholds (tiles from the camera; the game camera sits about 50 tiles from its target, so its
// view spans roughly 40–80 tiles):
//   walls, gates, extractors, deposits  24 / 85 / 160  (W21's turret thresholds: the whole game
//                                                      view stays at middle detail or better)
//   engineers                            14 / 45 / 95   (1.8 m tall: full detail only in close-ups;
//                                                      at the game camera they are simple models
//                                                      with a marker over them)
//   commander                            40 / 120 / 220 (7 m tall and the unit to protect: full
//                                                      detail through most of the game view)

import { HYSTERESIS, LEVEL_NEW, chooseLevel } from '../stress/lod.ts';

export type AssetKind = 'wall' | 'gate' | 'mass' | 'rare' | 'deposit' | 'engineer' | 'commander';
export const ASSET_KINDS: AssetKind[] = ['wall', 'gate', 'mass', 'rare', 'deposit', 'engineer', 'commander'];
export const ASSET_NAMES: Record<AssetKind, string> = {
  wall: 'Wall tiles',
  gate: 'Gates',
  mass: 'Mass extractors',
  rare: 'Rare-material extractors',
  deposit: 'Deposits (bare)',
  engineer: 'Engineers',
  commander: 'Commander',
};

export const THRESHOLDS: Record<AssetKind, readonly number[]> = {
  wall: [24, 85, 160],
  gate: [24, 85, 160],
  mass: [24, 85, 160],
  rare: [24, 85, 160],
  deposit: [24, 85, 160],
  engineer: [14, 45, 95],
  commander: [40, 120, 220],
};

export const LEVEL_LABELS = ['full', 'middle', 'simple', 'icon'] as const;

/** Detail level per object, kept between frames so the hysteresis applies. */
export class LevelTracker {
  private lv: Uint8Array;

  constructor(
    readonly kind: AssetKind,
    cap = 64,
  ) {
    this.lv = new Uint8Array(cap).fill(LEVEL_NEW);
  }

  /** Level for object i at distance d (forced: a fixed level for the detail-level view). */
  level(i: number, d: number, forced: number | null = null): number {
    if (i >= this.lv.length) {
      const n = new Uint8Array(Math.max(i + 1, this.lv.length * 2)).fill(LEVEL_NEW);
      n.set(this.lv);
      this.lv = n;
    }
    if (forced !== null) {
      this.lv[i] = forced;
      return forced;
    }
    const l = chooseLevel(this.lv[i]!, d, THRESHOLDS[this.kind], HYSTERESIS);
    this.lv[i] = l;
    return l;
  }

  reset(): void {
    this.lv.fill(LEVEL_NEW);
  }
}
