// Snapshot format: the per-tick state the worker transfers to the render thread.
//
// Layout (little-endian):
//   header    16 × u32 (H_* indices)
//   globals   48 × f64 (G_* indices): pool, rates, parts, commander, counters, scenario
//   stats     STAT_COUNT × f64: the per-kind combat counters (stats.ts), every snapshot (W24)
//   tuning    TUNE_COUNT × f64: the sandbox multipliers, building, alien, unit (tuning.ts; W24)
//   runs      RUN_CAPACITY × 4 × i32: per run-table slot [run id (0 = free), tiles, complete, skipped]
//   buildings id u32[n], then each snapshot column of BUILDING_FIELDS in schema order
//   aliens, units, wrecks, projectiles: the same, from their schemas
//   routes    u16 words: per route [entry, category, n, cell × n]
//   origins   u16 words: per sandbox spawn origin [tile x, tile z, alien kind, category, n, cell × n]
// Every column starts 4-byte aligned. Only live entities are written, in ascending slot order.
// The bytes depend on simulation state only (no timings), so equal state gives byte-identical
// snapshots — the determinism tests compare them.

import { ALIEN_FIELDS, BUILDING_FIELDS, PROJECTILE_FIELDS, UNIT_FIELDS, WRECK_FIELDS } from './schema.ts';
import { BYTES, makeArray, type AnyTypedArray, type ArrayFor, type FieldSpec, type Table } from './table.ts';
import { SCENARIO_NAMES, type World } from './world.ts';
import { STAT_COUNT } from './stats.ts';
import { TUNE_COUNT, TUNE_SIZE } from './tuning.ts';
import { RUN_CAPACITY, runCompleteCount } from './runs.ts';
import { originTile } from './sandbox.ts';

const RUN_WORDS = RUN_CAPACITY * 4;

export const SNAPSHOT_MAGIC = 0x314b5742; // "BWK1"
/** 4 (W24): footprints, construction states, projectile attribution, scenario, stats, tuning, origins. */
export const SNAPSHOT_VERSION = 4;
const HEADER_WORDS = 16;
const HEADER_BYTES = HEADER_WORDS * 4;
export const GLOBAL_COUNT = 48;
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
export const H_ORIGIN_WORDS = 15;

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
export const G_NEXT_WAVE = 24; // index of the next wave to arrive (0..20)
export const G_NEXT_WAVE_TICK = 25; // its start tick (-1 when none left)
export const G_LAST_WAVE_TICK = 26;
export const G_END_TICK = 27;
export const G_RESEARCH_DONE = 28; // bit mask over RESEARCH
export const G_RESEARCH_CURRENT = 29; // node index or -1
export const G_RESEARCH_PROGRESS = 30; // 0..1
export const G_RESEARCH_RATE = 31; // RP per second
export const G_RESEARCH_QUEUED = 32; // bit mask
export const G_BUILDINGS_LOST = 33;
export const G_UNITS_LOST = 34;
export const G_SKIPPED_TICKS = 35;
export const G_BONUS_MASS = 36;
export const G_BONUS_ENERGY = 37;
export const G_WAVE_COUNT = 38;
export const G_SCENARIO = 39; // index into world.ts SCENARIO_NAMES
export const G_UNLIMITED = 40; // 1 while sandbox spending is free
export const G_RUNS = 41; // wall runs in the run table
export const G_RESPAWN_TICK = 42; // sandbox: tick the next commander appears, -1 when none is due
export const G_COMMANDER_DEATHS = 43; // sandbox: commanders lost so far


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

export interface OriginRouteView {
  /** Spawn origin tile. */
  x: number;
  z: number;
  kind: number;
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
  /** Per-kind combat counters (stats.ts statsReport reads it). */
  stats: Float64Array;
  /** Sandbox multipliers, one view per target table (tuning.ts tuneIndex addresses them). */
  tuning: { building: Float64Array; alien: Float64Array; unit: Float64Array };
  /** Wall run table: per slot [id (0 = free), tiles, complete, skipped]. */
  runs: Int32Array;
  originRoutes: OriginRouteView[];
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

function originWords(world: World): number {
  let n = 0;
  for (const r of world.originRoutes) n += 5 + r.cells.length;
  return n;
}


export function snapshotSize(world: World): number {
  return (
    HEADER_BYTES +
    GLOBAL_BYTES +
    STAT_COUNT * 8 +
    TUNE_COUNT * 8 +
    RUN_WORDS * 4 +
    sectionBytes(BUILDING_FIELDS, world.buildings.count) +
    sectionBytes(ALIEN_FIELDS, world.aliens.count) +
    sectionBytes(UNIT_FIELDS, world.units.count) +
    sectionBytes(WRECK_FIELDS, world.wrecks.count) +
    sectionBytes(PROJECTILE_FIELDS, world.projectiles.count) +
    align4(routeWords(world) * 2) +
    align4(originWords(world) * 2)
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
  g[G_NEXT_WAVE] = world.nextWave;
  g[G_NEXT_WAVE_TICK] = world.nextWave < world.waveTicks.length ? world.waveTicks[world.nextWave]! : -1;
  g[G_LAST_WAVE_TICK] = world.lastWaveTick;
  g[G_END_TICK] = world.endTick;
  g[G_RESEARCH_DONE] = world.researchDone;
  g[G_RESEARCH_CURRENT] = world.researchCurrent;
  g[G_RESEARCH_PROGRESS] = world.researchProgress;
  g[G_RESEARCH_RATE] = world.researchRate;
  let queued = 0;
  for (const i of world.researchQueue) queued |= 1 << i;
  g[G_RESEARCH_QUEUED] = queued;
  g[G_BUILDINGS_LOST] = world.buildingsLost;
  g[G_UNITS_LOST] = world.unitsLost;
  g[G_SKIPPED_TICKS] = world.skippedTicks;
  g[G_BONUS_MASS] = world.bonusPaid[0]!;
  g[G_BONUS_ENERGY] = world.bonusPaid[1]!;
  g[G_WAVE_COUNT] = world.waveTicks.length;
  g[G_SCENARIO] = SCENARIO_NAMES.indexOf(world.scenario);
  g[G_UNLIMITED] = world.unlimited ? 1 : 0;
  let runs = 0;
  for (const r of world.runs) if (r) runs++;
  g[G_RUNS] = runs;
  g[G_RESPAWN_TICK] = world.commanderRespawnTick;
  g[G_COMMANDER_DEATHS] = world.commanderDeaths;
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
  const owords = originWords(world);
  h[H_ORIGIN_WORDS] = owords;
  writeGlobals(world, new Float64Array(buf, HEADER_BYTES, GLOBAL_COUNT));
  let off = HEADER_BYTES + GLOBAL_BYTES;
  new Float64Array(buf, off, STAT_COUNT).set(world.stats);
  off += STAT_COUNT * 8;
  const tn = new Float64Array(buf, off, TUNE_COUNT);
  tn.set(world.tuning.building, 0);
  tn.set(world.tuning.alien, TUNE_SIZE.building);
  tn.set(world.tuning.unit, TUNE_SIZE.building + TUNE_SIZE.alien);
  off += TUNE_COUNT * 8;
  const rw = new Int32Array(buf, off, RUN_WORDS);
  world.runs.forEach((run, i) => {
    if (!run) return;
    rw[i * 4] = run.id;
    rw[i * 4 + 1] = run.sites.length;
    rw[i * 4 + 2] = runCompleteCount(world, run);
    rw[i * 4 + 3] = run.skipped;
  });
  off += RUN_WORDS * 4;
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
  const o = new Uint16Array(buf, off, owords);
  k = 0;
  for (const route of world.originRoutes) {
    const origin = world.spawnOrigins[route.origin]!;
    const [tx, tz] = originTile(world, origin);
    o[k++] = tx;
    o[k++] = tz;
    o[k++] = origin.kind;
    o[k++] = route.category;
    o[k++] = route.cells.length;
    for (const c of route.cells) o[k++] = c;
  }
  off += align4(owords * 2);
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
  const stats = new Float64Array(buf, HEADER_BYTES + GLOBAL_BYTES, STAT_COUNT);
  const t0 = HEADER_BYTES + GLOBAL_BYTES + STAT_COUNT * 8;
  const tuning = {
    building: new Float64Array(buf, t0, TUNE_SIZE.building),
    alien: new Float64Array(buf, t0 + TUNE_SIZE.building * 8, TUNE_SIZE.alien),
    unit: new Float64Array(buf, t0 + (TUNE_SIZE.building + TUNE_SIZE.alien) * 8, TUNE_SIZE.unit),
  };
  const runs = new Int32Array(buf, t0 + TUNE_COUNT * 8, RUN_WORDS);
  const off = t0 + TUNE_COUNT * 8 + RUN_WORDS * 4;
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
  const o6 = o5 + align4(words * 2);
  const owords = h[H_ORIGIN_WORDS]!;
  const or = new Uint16Array(buf, o6, owords);
  const originRoutes: OriginRouteView[] = [];
  for (let k = 0; k < owords; ) {
    const n = or[k + 4]!;
    originRoutes.push({ x: or[k]!, z: or[k + 1]!, kind: or[k + 2]!, category: or[k + 3]!, cells: or.subarray(k + 5, k + 5 + n) });
    k += 5 + n;
  }
  const end = o6 + align4(owords * 2);
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
    stats,
    tuning,
    runs,
    originRoutes,
  };
}

/** The used bytes of a snapshot buffer, for comparisons and hashing. */
export const snapshotBytes = (buf: ArrayBuffer): Uint8Array => new Uint8Array(buf, 0, new Uint32Array(buf, 0, HEADER_WORDS)[H_BYTES]!);
