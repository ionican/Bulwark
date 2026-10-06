// Column layouts of the three entity tables. The snapshot and (later) the save format are these
// columns in this order, so changing a schema changes SNAPSHOT_VERSION.

import type { FieldSpec } from './table.ts';

export const BUILDING_FIELDS = [
  { name: 'kind', type: 'u8' },
  { name: 'tier', type: 'u8' },
  /** Bit 0: complete. Further bits arrive with M2 (powered, firing, starved). */
  { name: 'flags', type: 'u8' },
  { name: 'tx', type: 'i16' },
  { name: 'ty', type: 'i16' },
  { name: 'hp', type: 'f32' },
  { name: 'progress', type: 'f32' },
] as const satisfies readonly FieldSpec[];

export const ALIEN_FIELDS = [
  { name: 'kind', type: 'u8' },
  { name: 'state', type: 'u8' },
  { name: 'x', type: 'f32' },
  { name: 'z', type: 'f32' },
  /** Unit facing vector (no angle, so the simulation needs no trigonometry). */
  { name: 'fx', type: 'f32' },
  { name: 'fz', type: 'f32' },
  { name: 'hp', type: 'f32' },
  { name: 'goalX', type: 'f32', snap: false },
  { name: 'goalZ', type: 'f32', snap: false },
] as const satisfies readonly FieldSpec[];

export const UNIT_FIELDS = [
  { name: 'kind', type: 'u8' },
  /** 0 idle, 1 moving. */
  { name: 'state', type: 'u8' },
  { name: 'x', type: 'f32' },
  { name: 'z', type: 'f32' },
  { name: 'fx', type: 'f32' },
  { name: 'fz', type: 'f32' },
  { name: 'hp', type: 'f32' },
  { name: 'goalX', type: 'f32', snap: false },
  { name: 'goalZ', type: 'f32', snap: false },
] as const satisfies readonly FieldSpec[];

export const BUILDING_FLAG_COMPLETE = 1;
export const UNIT_IDLE = 0;
export const UNIT_MOVING = 1;
