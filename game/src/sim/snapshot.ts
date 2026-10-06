// Snapshot format: the per-tick state the worker transfers to the render thread.
//
// Layout (little-endian):
//   header    16 × u32 (H_* indices)
//   globals   32 × f64 (G_* indices): pool, rates, parts, commander, counters
//   buildings id u32[n], then each snapshot column of BUILDING_FIELDS in schema order
//   aliens, units, wrecks, projectiles: the same, from their schemas
//   routes    u16 words: per route [entry, category, n, cell × n]
// Every column starts 4-byte aligned. Only live entities are written, in ascending slot order.
// The bytes depend on simulation state only (no timings), so equal state gives byte-identical
// snapshots — the determinism tests compare them.

import { ALIEN_FIELDS, BUILDING_FIELDS, PROJECTILE_FIELDS, UNIT_FIELDS, WRECK_FIELDS } from './schema.ts';
import { BYTES, makeArray, type AnyTypedArray, type ArrayFor, type FieldSpec, type Table } from './table.ts';
import type { World } from './world.ts';

export const SNAPSHOT_MAGIC = 0x314b5742; // "BWK1"
export const SNAPSHOT_VERSION = 2;
const HEADER_WORDS = 16;
const HEADER_BYTES = HEADER_WORDS * 4;
export const GLOBAL_COUNT = 32;
const GLOBAL_BYTES = GLOBAL_COUNT * 8;

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
export const H_N_WRECKS = 11;
export const H_N_PROJECTILES = 12;
export const H_ROUTE_WORDS = 13;
export const H_ROUTES_VERSION = 14;

export const G_MASS = 0;
export const G_ENERGY = 1;
export const G_RARE = 2;
export const G_INCOME = 3; // 3..5
export const G_SPEND = 6; // 6..8
export const G_PARTS = 9;
export const G_COMMANDER_HP = 10;
export const G_UPKEEP = 11;
export const G_BUILD_EFF = 12;
export const G_SHORT = 13;
export const G_KILLS = 14;
export const G_SALVAGE_KILLS = 15;
export const G_RECLAIMED = 16;
export const G_DELIVERED = 17;
export const G_PARTS_MADE = 18;
export const G_PARTS_USED = 19;
export const G_OUTCOME = 20;
export const G_PENDING_SPAWNS = 21;
export const G_COMMANDER_ID = 22;
export const G_FIELD_BUILDS = 23;

type SnapFields<S extends readonly FieldSpec[]> = Exclude<S[number], { snap: false }>;
export type SnapColumns<S extends readonly FieldSpec[]> = { [F in SnapFields<S> as F['name']]: ArrayFor<F['type']> };

export interface Section<S extends readonly FieldSpec[]> {
  count: number;
  id: Uint32Array;
  cols: SnapColumns<S>;
}

export interface RouteView {
  entry: number;
  category: number;
  cells: Uint16Array;
}

export interface Snapshot {
  buffer: ArrayBuffer;
  byteLength: number;
  tick: number;
  rngState: number;
  seed: number;
  mapW: number;
  mapH: number;
  globals: Float64Array;
  buildings: Section<typeof BUILDING_FIELDS>;
  aliens: Section<typeof ALIEN_FIELDS>;
  units: Section<typeof UNIT_FIELDS>;
  wrecks: Section<typeof WRECK_FIELDS>;
  projectiles: Section<typeof PROJECTILE_FIELDS>;
  routes: RouteView[];
  routesVersion: number;
}

const align4 = (n: number) => (n + 3) & ~3;
const snapFields = (schema: readonly FieldSpec[]) => schema.filter((f) => f.snap !== false);

function sectionBytes(schema: readonly FieldSpec[], n: number): number {
  let bytes = align4(n * 4);
  for (const f of snapFields(schema)) bytes += align4(n * BYTES[f.type]);
  return bytes;
}

function routeWords(world: World): number {
  let n = 0;
  for (const r of world.routes) n += 3 + r.cells.length;
  return n;
}

export function snapshotSize(world: World): number {
  return (
    HEADER_BYTES +
    GLOBAL_BYTES +
    sectionBytes(BUILDING_FIELDS, world.buildings.count) +
    sectionBytes(ALIEN_FIELDS, world.aliens.count) +
    sectionBytes(UNIT_FIELDS, world.units.count) +
    sectionBytes(WRECK_FIELDS, world.wrecks.count) +
    sectionBytes(PROJECTILE_FIELDS, world.projectiles.count) +
    align4(routeWords(world) * 2)
  );
}

type AnyTable = Table<readonly FieldSpec[]>;

function writeSection(table: AnyTable, buf: ArrayBuffer, offset: number): number {
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

function writeGlobals(world: World, g: Float64Array): void {
  g[G_MASS] = world.pool[0]!;
  g[G_ENERGY] = world.pool[1]!;
  g[G_RARE] = world.pool[2]!;
  for (let k = 0; k < 3; k++) {
    g[G_INCOME + k] = world.incomeRate[k]!;
    g[G_SPEND + k] = world.spendRate[k]!;
  }
  g[G_PARTS] = world.parts;
  const cs = world.commanderSlot();
  g[G_COMMANDER_HP] = cs >= 0 ? world.units.cols.hp[cs]! : 0;
  g[G_UPKEEP] = world.upkeep;
  g[G_BUILD_EFF] = world.buildEff;
  g[G_SHORT] = world.shortMask;
  g[G_KILLS] = world.kills;
  g[G_SALVAGE_KILLS] = world.salvageFromKills;
  g[G_RECLAIMED] = world.salvageReclaimed;
  g[G_DELIVERED] = world.salvageDelivered;
  g[G_PARTS_MADE] = world.partsMade;
  g[G_PARTS_USED] = world.partsUsed;
  g[G_OUTCOME] = world.outcome;
  g[G_PENDING_SPAWNS] = world.pendingSpawns;
  g[G_COMMANDER_ID] = world.commanderId;
  g[G_FIELD_BUILDS] = world.fieldBuilds;
}

/**
 * Writes the world's snapshot into `out` when it is large enough (buffer reuse), otherwise into a
 * new buffer. Returns the buffer written. Bytes past the snapshot's length are left untouched.
 */
export function encodeSnapshot(world: World, out?: ArrayBuffer): ArrayBuffer {
  const size = snapshotSize(world);
  const buf = out && out.byteLength >= size ? out : new ArrayBuffer(Math.max(size, 1024 * Math.ceil(size / 1024)));
  new Uint8Array(buf, 0, size).fill(0);
  const words = routeWords(world);
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
  h[H_N_WRECKS] = world.wrecks.count;
  h[H_N_PROJECTILES] = world.projectiles.count;
  h[H_ROUTE_WORDS] = words;
  h[H_ROUTES_VERSION] = world.routesVersion;
  writeGlobals(world, new Float64Array(buf, HEADER_BYTES, GLOBAL_COUNT));
  let off = HEADER_BYTES + GLOBAL_BYTES;
  off = writeSection(world.buildings as unknown as AnyTable, buf, off);
  off = writeSection(world.aliens as unknown as AnyTable, buf, off);
  off = writeSection(world.units as unknown as AnyTable, buf, off);
  off = writeSection(world.wrecks as unknown as AnyTable, buf, off);
  off = writeSection(world.projectiles as unknown as AnyTable, buf, off);
  const r = new Uint16Array(buf, off, words);
  let k = 0;
  for (const route of world.routes) {
    r[k++] = route.entry;
    r[k++] = route.category;
    r[k++] = route.cells.length;
    for (const c of route.cells) r[k++] = c;
  }
  off += align4(words * 2);
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
  const globals = new Float64Array(buf, HEADER_BYTES, GLOBAL_COUNT);
  const off = HEADER_BYTES + GLOBAL_BYTES;
  const [buildings, o1] = readSection(BUILDING_FIELDS, h[H_N_BUILDINGS]!, buf, off);
  const [aliens, o2] = readSection(ALIEN_FIELDS, h[H_N_ALIENS]!, buf, o1);
  const [units, o3] = readSection(UNIT_FIELDS, h[H_N_UNITS]!, buf, o2);
  const [wrecks, o4] = readSection(WRECK_FIELDS, h[H_N_WRECKS]!, buf, o3);
  const [projectiles, o5] = readSection(PROJECTILE_FIELDS, h[H_N_PROJECTILES]!, buf, o4);
  const words = h[H_ROUTE_WORDS]!;
  const r = new Uint16Array(buf, o5, words);
  const routes: RouteView[] = [];
  for (let k = 0; k < words; ) {
    const n = r[k + 2]!;
    routes.push({ entry: r[k]!, category: r[k + 1]!, cells: r.subarray(k + 3, k + 3 + n) });
    k += 3 + n;
  }
  const end = o5 + align4(words * 2);
  if (end !== h[H_BYTES]) throw new Error('snapshot length mismatch');
  return {
    buffer: buf,
    byteLength: end,
    tick: h[H_TICK]!,
    rngState: h[H_RNG]!,
    seed: h[H_SEED]!,
    mapW: h[H_MAP_W]!,
    mapH: h[H_MAP_H]!,
    globals,
    buildings,
    aliens,
    units,
    wrecks,
    projectiles,
    routes,
    routesVersion: h[H_ROUTES_VERSION]!,
  };
}

/** The used bytes of a snapshot buffer, for comparisons and hashing. */
export const snapshotBytes = (buf: ArrayBuffer): Uint8Array => new Uint8Array(buf, 0, new Uint32Array(buf, 0, HEADER_WORDS)[H_BYTES]!);
