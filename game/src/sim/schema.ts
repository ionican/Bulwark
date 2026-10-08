// Column layouts of the entity tables. The snapshot and (later) the save format are these
// columns in this order, so changing a schema changes SNAPSHOT_VERSION.
// `snap: false` columns are simulation-only state and stay in the worker.

import type { FieldSpec } from './table.ts';

export const BUILDING_FIELDS = [
  { name: 'kind', type: 'u8' },
  /** 1 = base tier; walls go to 2 and 3. */
  { name: 'tier', type: 'u8' },
  /** BF_* bits. */
  { name: 'flags', type: 'u8' },
  /** Belt pieces: 0 +x, 1 +z, 2 -x, 3 -z. Gates: the run axis, 0 = along x, 1 = along z. */
  { name: 'dir', type: 'u8' },
  /** Anchor tile (lowest x and z of the footprint). */
  { name: 'tx', type: 'i16' },
  { name: 'ty', type: 'i16' },
  /** Footprint in tiles along x and z from the anchor (W24; replaces the kind's square size). */
  { name: 'fw', type: 'u8' },
  { name: 'fh', type: 'u8' },
  { name: 'hp', type: 'f32' },
  { name: 'maxHp', type: 'f32' },
  /** Construction (or upgrade) progress 0..1. */
  { name: 'progress', type: 'f32' },
  /** Builders in range last tick, and the build's supply ratio last tick (0..255 = 0..1). */
  { name: 'builders', type: 'u8' },
  { name: 'eff', type: 'u8' },
  /** Belt pieces: item kind in the slot (0 = empty) and its progress across the tile 0..1. */
  { name: 'item', type: 'u8' },
  { name: 'itemPos', type: 'f32' },
  /** Machines: input items held, output items waiting, work progress 0..1. */
  { name: 'inBuf', type: 'u8' },
  { name: 'outBuf', type: 'u8' },
  { name: 'work', type: 'f32' },
  /** Depot: salvage held. */
  { name: 'stock', type: 'f32' },
  /** Turrets: alien id of the current target + 1 (0 = none). */
  { name: 'target', type: 'u32' },
  /** Shield generator: shield points left. */
  { name: 'shield', type: 'f32' },
  /** Temporary turret: seconds left. */
  { name: 'life', type: 'f32' },
  { name: 'cooldown', type: 'f32', snap: false },
  { name: 'rr', type: 'u8', snap: false },
  { name: 'moved', type: 'i32', snap: false },
] as const satisfies readonly FieldSpec[];

export const BF_COMPLETE = 1;
export const BF_UPGRADING = 2;
/** Fired (or beam drew energy) this tick. */
export const BF_FIRING = 4;
/** Wanted energy or parts this tick and got none. */
export const BF_STARVED = 8;
/** Shield up / machine working. */
export const BF_ACTIVE = 16;
/**
 * W24 construction states. A site with neither BF_STARTED nor BF_COMPLETE is reserved: it holds
 * its tiles against other placements but blocks nobody and is invisible to aliens. The first tick
 * build power reaches it, it becomes started (BF_STARTED): it blocks units and aliens and enters
 * flow costs at its current hit points. A complete building has BF_COMPLETE (and BF_STARTED).
 */
export const BF_STARTED = 32;

export const ALIEN_FIELDS = [
  { name: 'kind', type: 'u8' },
  /** AS_* */
  { name: 'state', type: 'u8' },
  { name: 'x', type: 'f32' },
  { name: 'z', type: 'f32' },
  /** Unit facing vector (no angle, so the simulation needs no trigonometry). */
  { name: 'fx', type: 'f32' },
  { name: 'fz', type: 'f32' },
  { name: 'hp', type: 'f32' },
  /** Offset within a tile so a group does not walk in single file. */
  { name: 'ox', type: 'f32', snap: false },
  { name: 'oz', type: 'f32', snap: false },
  { name: 'tType', type: 'u8', snap: false },
  { name: 'tId', type: 'u32', snap: false },
  { name: 'cooldown', type: 'f32', snap: false },
  /** Stress scene only: wander goal. */
  { name: 'goalX', type: 'f32', snap: false },
  { name: 'goalZ', type: 'f32', snap: false },
] as const satisfies readonly FieldSpec[];

export const AS_MOVING = 0;
export const AS_ATTACKING = 1;

export const UNIT_FIELDS = [
  { name: 'kind', type: 'u8' },
  /** US_* */
  { name: 'state', type: 'u8' },
  { name: 'x', type: 'f32' },
  { name: 'z', type: 'f32' },
  { name: 'fx', type: 'f32' },
  { name: 'fz', type: 'f32' },
  { name: 'hp', type: 'f32' },
  /** Salvage carried. */
  { name: 'carry', type: 'f32' },
  /** Seconds until the temporary turret can be dropped again. */
  { name: 'cooldown', type: 'f32' },
  /** Building or wreck id + 1 being built or reclaimed (0 = none), for drawing work lines. */
  { name: 'work', type: 'u32' },
  { name: 'weaponCd', type: 'f32', snap: false },
  { name: 'goalX', type: 'f32', snap: false },
  { name: 'goalZ', type: 'f32', snap: false },
] as const satisfies readonly FieldSpec[];

export const US_IDLE = 0;
export const US_MOVING = 1;
export const US_BUILDING = 2;
export const US_RECLAIMING = 3;
export const US_UNLOADING = 4;
export const US_WAITING = 5;
/** Kept for M1 code paths. */
export const UNIT_IDLE = US_IDLE;
export const UNIT_MOVING = US_MOVING;

export const WRECK_FIELDS = [
  { name: 'kind', type: 'u8' },
  { name: 'x', type: 'f32' },
  { name: 'z', type: 'f32' },
  { name: 'salvage', type: 'f32' },
] as const satisfies readonly FieldSpec[];

export const PROJECTILE_FIELDS = [
  /** P_* in kinds.ts */
  { name: 'kind', type: 'u8' },
  { name: 'x', type: 'f32' },
  { name: 'z', type: 'f32' },
  { name: 'fx', type: 'f32' },
  { name: 'fz', type: 'f32' },
  /** Target: T_* type and id; last known target position. */
  { name: 'tType', type: 'u8', snap: false },
  { name: 'tId', type: 'u32', snap: false },
  { name: 'tx', type: 'f32', snap: false },
  { name: 'tz', type: 'f32', snap: false },
  { name: 'damage', type: 'f32', snap: false },
  { name: 'speed', type: 'f32', snap: false },
  { name: 'splashTargets', type: 'u8', snap: false },
  { name: 'splashRadius', type: 'f32', snap: false },
  { name: 'splashFactor', type: 'f32', snap: false },
  { name: 'life', type: 'u16', snap: false },
  /**
   * W24 attribution, fixed at the moment of firing: shooter type (T_*), kind and entity id. Kept
   * when the shooter dies or its slot is reused, so a late impact is still credited (stats.ts).
   */
  { name: 'srcType', type: 'u8' },
  { name: 'srcKind', type: 'u8' },
  { name: 'srcId', type: 'u32' },
] as const satisfies readonly FieldSpec[];

/** Entity reference types. */
export const T_NONE = 0;
export const T_ALIEN = 1;
export const T_BUILDING = 2;
export const T_UNIT = 3;
