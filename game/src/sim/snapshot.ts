// Snapshot format: the per-tick state the worker transfers to the render thread.
//
// Layout (little-endian, every column 4-byte aligned):
//   header   16 × u32  (see H_* indices)
//   buildings: id u32[n], then each snapshot column of BUILDING_FIELDS in schema order
//   aliens:    id u32[n], then each snapshot column of ALIEN_FIELDS
//   units:     id u32[n], then each snapshot column of UNIT_FIELDS
// Only live entities are written, in ascending slot order. The bytes depend on simulation state
// only (no timings), so equal state gives byte-identical snapshots — the determinism tests use this.

import { ALIEN_FIELDS, BUILDING_FIELDS, UNIT_FIELDS } from './schema.ts';
import { BYTES, makeArray, type AnyTypedArray, type ArrayFor, type FieldSpec, type Table } from './table.ts';
import type { World } from './world.ts';

export const SNAPSHOT_MAGIC = 0x314b5742; // "BWK1"
export const SNAPSHOT_VERSION = 1;
const HEADER_WORDS = 16;
const HEADER_BYTES = HEADER_WORDS * 4;

export const H_MAGIC = 0;
export const H_VERSION = 1;
export const H_TICK = 2;
export const H_RNG = 3;
export const H_SEED = 4;
export const H_MAP_W = 5;
export const H_MAP_H = 6;
export const H_N_BUILDINGS = 7;
export const H_N_ALIENS = 8;
export const H_N_UNITS = 9;
export const H_BYTES = 10;

type SnapFields<S extends readonly FieldSpec[]> = Exclude<S[number], { snap: false }>;
export type SnapColumns<S extends readonly FieldSpec[]> = { [F in SnapFields<S> as F['name']]: ArrayFor<F['type']> };

export interface Section<S extends readonly FieldSpec[]> {
  count: number;
  id: Uint32Array;
  cols: SnapColumns<S>;
}

export interface Snapshot {
  buffer: ArrayBuffer;
  byteLength: number;
  tick: number;
  rngState: number;
  seed: number;
  mapW: number;
  mapH: number;
  buildings: Section<typeof BUILDING_FIELDS>;
  aliens: Section<typeof ALIEN_FIELDS>;
  units: Section<typeof UNIT_FIELDS>;
}

const align4 = (n: number) => (n + 3) & ~3;
const snapFields = (schema: readonly FieldSpec[]) => schema.filter((f) => f.snap !== false);

function sectionBytes(schema: readonly FieldSpec[], n: number): number {
  let bytes = align4(n * 4);
  for (const f of snapFields(schema)) bytes += align4(n * BYTES[f.type]);
  return bytes;
}

export function snapshotSize(world: World): number {
  return (
    HEADER_BYTES +
    sectionBytes(BUILDING_FIELDS, world.buildings.count) +
    sectionBytes(ALIEN_FIELDS, world.aliens.count) +
    sectionBytes(UNIT_FIELDS, world.units.count)
  );
}

function writeSection(table: Table<readonly FieldSpec[]>, buf: ArrayBuffer, offset: number): number {
  const n = table.count;
  const ids = new Uint32Array(buf, offset, n);
  let k = 0;
  for (let s = 0; s < table.highWater; s++) if (table.alive[s]) ids[k++] = table.id(s);
  offset += align4(n * 4);
  const cols = table.cols as Record<string, AnyTypedArray>;
  for (const f of snapFields(table.schema)) {
    const out = makeArray(f.type, n, buf, offset);
    const src = cols[f.name]!;
    k = 0;
    for (let s = 0; s < table.highWater; s++) if (table.alive[s]) out[k++] = src[s]!;
    offset += align4(n * BYTES[f.type]);
  }
  return offset;
}

/**
 * Writes the world's snapshot into `out` when it is large enough (buffer reuse), otherwise into a
 * new buffer. Returns the buffer written. Bytes past the snapshot's length are left untouched.
 */
export function encodeSnapshot(world: World, out?: ArrayBuffer): ArrayBuffer {
  const size = snapshotSize(world);
  const buf = out && out.byteLength >= size ? out : new ArrayBuffer(Math.max(size, 1024 * Math.ceil(size / 1024)));
  new Uint8Array(buf, 0, size).fill(0);
  const h = new Uint32Array(buf, 0, HEADER_WORDS);
  h[H_MAGIC] = SNAPSHOT_MAGIC;
  h[H_VERSION] = SNAPSHOT_VERSION;
  h[H_TICK] = world.tick;
  h[H_RNG] = world.rng.state;
  h[H_SEED] = world.seed;
  h[H_MAP_W] = world.terrain.w;
  h[H_MAP_H] = world.terrain.h;
  h[H_N_BUILDINGS] = world.buildings.count;
  h[H_N_ALIENS] = world.aliens.count;
  h[H_N_UNITS] = world.units.count;
  h[H_BYTES] = size;
  let off = HEADER_BYTES;
  off = writeSection(world.buildings as unknown as Table<readonly FieldSpec[]>, buf, off);
  off = writeSection(world.aliens as unknown as Table<readonly FieldSpec[]>, buf, off);
  off = writeSection(world.units as unknown as Table<readonly FieldSpec[]>, buf, off);
  if (off !== size) throw new Error(`snapshot size mismatch: wrote ${off}, expected ${size}`);
  return buf;
}

function readSection<S extends readonly FieldSpec[]>(schema: S, n: number, buf: ArrayBuffer, offset: number): [Section<S>, number] {
  const id = new Uint32Array(buf, offset, n);
  offset += align4(n * 4);
  const cols: Record<string, AnyTypedArray> = {};
  for (const f of snapFields(schema)) {
    cols[f.name] = makeArray(f.type, n, buf, offset);
    offset += align4(n * BYTES[f.type]);
  }
  return [{ count: n, id, cols: cols as SnapColumns<S> }, offset];
}

/** Views over a snapshot buffer (no copy). Throws on a foreign or mismatched buffer. */
export function decodeSnapshot(buf: ArrayBuffer): Snapshot {
  const h = new Uint32Array(buf, 0, HEADER_WORDS);
  if (h[H_MAGIC] !== SNAPSHOT_MAGIC) throw new Error('not a Bulwark snapshot');
  if (h[H_VERSION] !== SNAPSHOT_VERSION) throw new Error(`snapshot version ${h[H_VERSION]} not supported`);
  let off = HEADER_BYTES;
  const [buildings, o1] = readSection(BUILDING_FIELDS, h[H_N_BUILDINGS]!, buf, off);
  const [aliens, o2] = readSection(ALIEN_FIELDS, h[H_N_ALIENS]!, buf, o1);
  const [units, o3] = readSection(UNIT_FIELDS, h[H_N_UNITS]!, buf, o2);
  off = o3;
  if (off !== h[H_BYTES]) throw new Error('snapshot length mismatch');
  return {
    buffer: buf,
    byteLength: off,
    tick: h[H_TICK]!,
    rngState: h[H_RNG]!,
    seed: h[H_SEED]!,
    mapW: h[H_MAP_W]!,
    mapH: h[H_MAP_H]!,
    buildings,
    aliens,
    units,
  };
}

/** The used bytes of a snapshot buffer, for comparisons and hashing. */
export const snapshotBytes = (buf: ArrayBuffer): Uint8Array => new Uint8Array(buf, 0, new Uint32Array(buf, 0, HEADER_WORDS)[H_BYTES]!);
