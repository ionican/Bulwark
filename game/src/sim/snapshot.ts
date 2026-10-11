// Snapshot format: the per-tick state the worker transfers to the render thread.
//
// Layout (little-endian):
//   header    16 × u32 (H_* indices)
//   globals   56 × f64 (G_* indices): pool, rates, parts, commander, counters, scenario, belts
//   stats     STAT_COUNT × f64: the per-kind combat counters (stats.ts), every snapshot (W24)
//   tuning    TUNE_COUNT × f64: the sandbox multipliers, building, alien, unit (tuning.ts; W24)
//   runs      RUN_CAPACITY × 4 × i32: per run-table slot [run id (0 = free), tiles, complete, skipped]
//   buildings id u32[n], then each snapshot column of BUILDING_FIELDS in schema order
//   aliens, units, wrecks, projectiles: the same, from their schemas
//   routes    u16 words: per route [entry, category, n, cell × n]
//   origins   u16 words: per sandbox spawn origin [tile x, tile z, alien kind, category, n, cell × n]
//   queues    (W25) u32 × units: each unit's order count, in the units section's row order; then
//             for all n queued orders (G_QUEUE_ORDERS), unit by unit in queue order, the columns
//             kind i32 (schema.ts Q_*), target i32 (building or wreck id, a run's claimed tile;
//             -1 none), run i32 (run id, 0 none), x f32, z f32 (where it points: queue.ts orderPosition),
//             oid u32 (W25c: the order's id, units.ts Order.oid; `dequeue` names it); then (W25c) the
//             runs' unfinished sites, i32 words: per run in run-table order [run id, n, site id × n]
//             (the drag preview's replacement rule, queue.ts ownWallSites, reads them).
//             G_QUEUE_BYTES holds the section's length in bytes.
// Every column starts 4-byte aligned. Only live entities are written, in ascending slot order.
// The bytes depend on simulation state only (no timings), so equal state gives byte-identical
// snapshots — the determinism tests compare them.

import { ALIEN_FIELDS, BF_COMPLETE, BUILDING_FIELDS, G_BELTS, G_CORE_ID, G_CORE_MASS, G_CORE_RARE, G_RESEARCH_DONE, G_SHORT, G_SPENT, PROJECTILE_FIELDS, UNIT_FIELDS, WRECK_FIELDS } from './schema.ts';
import { BYTES, makeArray, type AnyTypedArray, type ArrayFor, type FieldSpec, type Table } from './table.ts';
import { SCENARIO_NAMES, type World } from './world.ts';
import { STAT_COUNT } from './stats.ts';
import { TUNE_COUNT, TUNE_SIZE } from './tuning.ts';
import { RUN_CAPACITY, runCompleteCount } from './runs.ts';
import { originTile } from './sandbox.ts';
import { orderKind, orderPosition, orderTarget } from './queue.ts';

const RUN_WORDS = RUN_CAPACITY * 4;

export const SNAPSHOT_MAGIC = 0x314b5742; // "BWK1"
/**
 * 4 (W24): footprints, construction states, projectile attribution, scenario, stats, tuning, origins.
 * 5 (W25): the unit order queues, as a section after the origins (scripts/fingerprint-compare.mjs
 * --strip-queue removes it again to compare with version 4).
 * 6 (W25c): order ids in the queue section, and G_QUEUE_BYTES, its length (so --strip-queue can
 * remove it whatever it holds).
 * 7 (W29): the core kind, mass and rare items, BF_DISABLED and BF_IDLE, the extractor buffer in the
 * stock column, the repair order kind (Q_REPAIR), and globals 46–52 (belts on, the core's id,
 * delivered mass and rare, exact cumulative spending); 56 globals.
 */
export const SNAPSHOT_VERSION = 7;
const HEADER_WORDS = 16;
const HEADER_BYTES = HEADER_WORDS * 4;
export const GLOBAL_COUNT = 56;
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
export { G_SHORT }; // 13, defined in schema.ts (render code reads it)
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
export { G_RESEARCH_DONE }; // 28, bit mask over RESEARCH; defined in schema.ts (snapshotRules.ts reads it)
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
export const G_QUEUE_ORDERS = 44; // W25: orders in the queue section, all units
export const G_QUEUE_BYTES = 45; // W25c: length of the queue section in bytes
// W29 globals 46–52 are in schema.ts (render code reads them): G_BELTS, G_CORE_ID, G_CORE_MASS, G_CORE_RARE, G_SPENT


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
  /** W25: unit order queues (layout above); `first` is each unit row's first order, worked out on decode. */
  queues: QueueView;
}

export interface QueueView {
  /** Per unit row: orders queued, and the index of its first one in the order columns. */
  count: Uint32Array;
  first: Uint32Array;
  kind: Int32Array;
  target: Int32Array;
  run: Int32Array;
  x: Float32Array;
  z: Float32Array;
  /** W25c: order ids (units.ts Order.oid). */
  oid: Uint32Array;
  /** W25c: per run [run id, n, unfinished site id × n], run-table order (runSitesOf reads it). */
  runSites: Int32Array;
}

/** W25c: the unfinished site ids of run `run` in the snapshot (empty when it is not in the table). */
export function runSitesOf(s: Snapshot, run: number): Int32Array {
  const w = s.queues.runSites;
  for (let k = 0; k < w.length; k += 2 + w[k + 1]!) if (w[k] === run) return w.subarray(k + 2, k + 2 + w[k + 1]!);
  return new Int32Array(0);
}

export interface QueueItem {
  kind: number;
  target: number;
  run: number;
  x: number;
  z: number;
  /** W25c: the order's id, which `dequeue` names. */
  oid: number;
}

/** The queue of unit row `row`, first order first. */
export function queueOf(s: Snapshot, row: number): QueueItem[] {
  const q = s.queues;
  const out: QueueItem[] = [];
  for (let i = q.first[row]!, end = i + q.count[row]!; i < end; i++) out.push({ kind: q.kind[i]!, target: q.target[i]!, run: q.run[i]!, x: q.x[i]!, z: q.z[i]!, oid: q.oid[i]! });
  return out;
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

/** Orders queued over all live units. */
function queuedOrders(world: World): number {
  let n = 0;
  for (let s = 0; s < world.units.highWater; s++) if (world.units.alive[s]) n += world.orders[s]?.length ?? 0;
  return n;
}

/** Unfinished site ids of a run, in its build order (W25c: the queue section lists them). */
function openSites(world: World, sites: readonly number[], out?: Int32Array, at = 0): number {
  let n = 0;
  for (const id of sites) {
    const s = world.buildings.slotForId(id);
    if (s < 0 || world.buildings.cols.flags[s]! & BF_COMPLETE) continue;
    if (out) out[at + n] = id;
    n++;
  }
  return n;
}

/** Words of the queue section's run-site list (W25c). */
function runSiteWords(world: World): number {
  let n = 0;
  for (const r of world.runs) if (r) n += 2 + openSites(world, r.sites);
  return n;
}

/** Bytes of the queue section: a count per unit, six 4-byte columns per order, the run-site words. */
const queueBytes = (units: number, orders: number, runWords: number) => units * 4 + orders * 6 * 4 + runWords * 4;


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
    align4(originWords(world) * 2) +
    queueBytes(world.units.count, queuedOrders(world), runSiteWords(world))
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
  g[G_QUEUE_ORDERS] = queuedOrders(world);
  g[G_QUEUE_BYTES] = queueBytes(world.units.count, g[G_QUEUE_ORDERS]!, runSiteWords(world));
  g[G_BELTS] = world.belts ? 1 : 0;
  g[G_CORE_ID] = world.coreId;
  g[G_CORE_MASS] = world.delivered[0]!;
  g[G_CORE_RARE] = world.delivered[1]!;
  for (let k = 0; k < 3; k++) g[G_SPENT + k] = world.spentTotal[k]!;
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
  off = writeQueues(world, buf, off);
  if (off !== size) throw new Error(`snapshot size mismatch: wrote ${off}, expected ${size}`);
  return buf;
}

function writeQueues(world: World, buf: ArrayBuffer, offset: number): number {
  const units = world.units;
  const n = queuedOrders(world);
  const count = new Uint32Array(buf, offset, units.count);
  offset += units.count * 4;
  const kind = new Int32Array(buf, offset, n);
  const target = new Int32Array(buf, offset + n * 4, n);
  const run = new Int32Array(buf, offset + n * 8, n);
  const x = new Float32Array(buf, offset + n * 12, n);
  const z = new Float32Array(buf, offset + n * 16, n);
  const oid = new Uint32Array(buf, offset + n * 20, n);
  let row = 0;
  let k = 0;
  for (let s = 0; s < units.highWater; s++) {
    if (!units.alive[s]) continue;
    const orders = world.orders[s] ?? [];
    count[row++] = orders.length;
    for (const o of orders) {
      kind[k] = orderKind(o);
      target[k] = orderTarget(o);
      run[k] = o.t === 'run' ? o.run : 0;
      const [px, pz] = orderPosition(world, s, o);
      x[k] = px;
      z[k] = pz;
      oid[k] = o.oid;
      k++;
    }
  }
  offset += n * 24;
  const words = new Int32Array(buf, offset, runSiteWords(world));
  let at = 0;
  for (const r of world.runs) {
    if (!r) continue;
    const m = openSites(world, r.sites, words, at + 2);
    words[at] = r.id;
    words[at + 1] = m;
    at += 2 + m;
  }
  return offset + at * 4;
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
  const o7 = o6 + align4(owords * 2);
  const nUnits = h[H_N_UNITS]!;
  const nOrders = globals[G_QUEUE_ORDERS]!;
  const count = new Uint32Array(buf, o7, nUnits);
  const q0 = o7 + nUnits * 4;
  const first = new Uint32Array(nUnits);
  for (let r = 1; r < nUnits; r++) first[r] = first[r - 1]! + count[r - 1]!;
  const queues: QueueView = {
    count,
    first,
    kind: new Int32Array(buf, q0, nOrders),
    target: new Int32Array(buf, q0 + nOrders * 4, nOrders),
    run: new Int32Array(buf, q0 + nOrders * 8, nOrders),
    x: new Float32Array(buf, q0 + nOrders * 12, nOrders),
    z: new Float32Array(buf, q0 + nOrders * 16, nOrders),
    oid: new Uint32Array(buf, q0 + nOrders * 20, nOrders),
    runSites: new Int32Array(buf, q0 + nOrders * 24, (globals[G_QUEUE_BYTES]! - queueBytes(nUnits, nOrders, 0)) / 4),
  };
  const end = o7 + globals[G_QUEUE_BYTES]!;
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
    queues,
  };
}

/** The used bytes of a snapshot buffer, for comparisons and hashing. */
export const snapshotBytes = (buf: ArrayBuffer): Uint8Array => new Uint8Array(buf, 0, new Uint32Array(buf, 0, HEADER_WORDS)[H_BYTES]!);
