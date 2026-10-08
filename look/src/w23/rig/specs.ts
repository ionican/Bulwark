// Leg and gait dimensions (tiles; 1 tile = 2 m).
//
// Engineer: 1.8 m tall (0.9 tiles). Hip joint 0.47 tiles (0.94 m) up, thigh and shin 0.215 each.
//   Walk 0.7 tiles/s (1.4 m/s): cycle 0.62 tiles (two steps of 0.62 m), 60 % stance, so a planted
//   foot travels from 0.19 tiles ahead of the hip to 0.19 behind; at the ends of the stance the
//   pelvis has to drop about 4 cm to keep the foot in reach (the walking bob).
//   Run 1.6 tiles/s (3.2 m/s): cycle 1.0 tile, 38 % stance (a flight phase between steps).
// Commander: about 7 m tall. Hip joint 1.75 tiles up, thigh and shin 0.85 each, feet 0.5 tiles
//   either side. Walk 0.9 tiles/s (1.8 m/s): cycle 2.2 tiles, 62 % stance, 0.22-tile foot lift.

import type { BipedSpec } from './biped.ts';

export const ENGINEER_LEGS: BipedSpec = {
  leg: { thigh: 0.215, shin: 0.215, ankle: 0.045, hipOut: 0.052, hipY: 0.47, footOut: 0.062 },
  walk: { stride: 0.62, duty: 0.6, lift: 0.05 },
  run: { stride: 1.0, duty: 0.38, lift: 0.09 },
  turnR: 0.07,
  settle: 0.8,
};
export const ENGINEER_WALK = 0.7;
export const ENGINEER_RUN = 1.6;

export const COMMANDER_LEGS: BipedSpec = {
  leg: { thigh: 0.85, shin: 0.85, ankle: 0.17, hipOut: 0.42, hipY: 1.75, footOut: 0.5 },
  walk: { stride: 2.2, duty: 0.62, lift: 0.22 },
  run: { stride: 2.2, duty: 0.62, lift: 0.22 },
  turnR: 1.3,
  settle: 1.0,
};
export const COMMANDER_WALK = 0.9;
/** Turn rate on the spot, rad/s. */
export const COMMANDER_TURN = 0.9;
