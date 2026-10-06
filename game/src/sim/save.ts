// Full-state save format, used for wave checkpoints, rewind and "Export save".
//
// Layout (little-endian):
//   u32 SAVE_MAGIC ("BWKS")   u32 SAVE_VERSION   u32 SNAPSHOT_VERSION   u32 JSON byte length
//   JSON (UTF-8) with every scalar, order queue, path, command log and a table of binary blobs,
//   padded to 8 bytes
//   blobs: entity table columns up to each table's high-water slot, free lists, the cost and walk
//   grids, all four flow fields, pool and rate arrays; each blob starts 8-byte aligned
// Everything that affects a future tick is saved, including derived state whose content depends
// on history (flow fields and cost grids are rebuilt on a schedule, unit paths are planned once),
// so a restored world steps exactly as the original would have. The belt processing order is the
// one derived value recomputed on load; it depends only on the buildings present.

import { World, type PendingGroup, type Route } from './world.ts';
import { SNAPSHOT_VERSION } from './snapshot.ts';
import { map1Terrain, type Terrain } from './terrain.ts';
import type { AnyTypedArray, FieldSpec, Table } from './table.ts';
import type { StampedCommand } from './commands.ts';
import type { Order } from './units.ts';

export const SAVE_MAGIC = 0x534b5742; // "BWKS"
export const SAVE_VERSION = 1;

export class SaveVersionError extends Error {}

type BlobType = 'f64' | 'f32' | 'i32' | 'u32' | 'i16' | 'u16' | 'u8' | 'i8';
interface BlobRef {
  name: string;
  type: BlobType;
  offset: number;
  length: number;
}

const typeOf = (a: AnyTypedArray | Float64Array | Int8Array): BlobType =>
  a instanceof Float64Array
    ? 'f64'
    : a instanceof Float32Array
      ? 'f32'
      : a instanceof Int32Array
        ? 'i32'
        : a instanceof Uint32Array
          ? 'u32'
          : a instanceof Int16Array
            ? 'i16'
            : a instanceof Uint16Array
              ? 'u16'
              : a instanceof Int8Array
                ? 'i8'
                : 'u8';

function view(type: BlobType, buf: ArrayBuffer, offset: number, length: number) {
  switch (type) {
    case 'f64': return new Float64Array(buf, offset, length);
    case 'f32': return new Float32Array(buf, offset, length);
    case 'i32': return new Int32Array(buf, offset, length);
    case 'u32': return new Uint32Array(buf, offset, length);
    case 'i16': return new Int16Array(buf, offset, length);
    case 'u16': return new Uint16Array(buf, offset, length);
    case 'i8': return new Int8Array(buf, offset, length);
    case 'u8': return new Uint8Array(buf, offset, length);
  }
}

// JSON keeps -0, NaN and Infinity, so a number round-trips exactly.
const replacer = (_k: string, v: unknown) =>
  typeof v === 'number' && (Object.is(v, -0) || !Number.isFinite(v)) ? { $n: Object.is(v, -0) ? '-0' : String(v) } : v;
const reviver = (_k: string, v: unknown) =>
  v && typeof v === 'object' && '$n' in (v as Record<string, unknown>) && Object.keys(v as object).length === 1 ? Number((v as { $n: string }).$n) : v;

const TABLES = ['buildings', 'aliens', 'units', 'wrecks', 'projectiles'] as const;
type AnyTable = Table<readonly FieldSpec[]>;

export function serializeWorld(w: World): Uint8Array {
  const blobs: Array<[string, AnyTypedArray | Float64Array | Int8Array]> = [];
  const tables: Record<string, { count: number; highWater: number }> = {};
  for (const name of TABLES) {
    const st = (w[name] as unknown as AnyTable).exportState();
    tables[name] = { count: st.count, highWater: st.highWater };
    blobs.push([`${name}.free`, st.free], [`${name}.alive`, st.alive], [`${name}.gen`, st.gen]);
    for (const [col, arr] of Object.entries(st.cols)) blobs.push([`${name}.${col}`, arr]);
  }
  blobs.push(
    ['pool', w.pool],
    ['incomeRate', w.incomeRate],
    ['spendRate', w.spendRate],
    ['bonusPaid', w.bonusPaid],
    ['waveTicks', w.waveTicks],
    ['occupancy', w.occupancy],
    ['cost', w.cost],
    ['costBypass', w.costBypass],
    ['open', w.open],
    ['walk', w.walk],
    ['fieldGoal', w.fieldGoal],
    ['fieldDirty', w.fieldDirty],
  );
  w.fields.forEach((f, i) => blobs.push([`field${i}.dist`, f.dist], [`field${i}.dir`, f.dir]));
  const isMap1 = w.terrain === map1Terrain();
  if (!isMap1) blobs.push(['terrain.tiles', w.terrain.tiles], ['terrain.heights', w.terrain.heights]);

  const refs: BlobRef[] = [];
  let off = 0;
  for (const [name, arr] of blobs) {
    off = (off + 7) & ~7;
    refs.push({ name, type: typeOf(arr), offset: off, length: arr.length });
    off += arr.byteLength;
  }
  const state = {
    seed: w.seed,
    rng: w.rng.state,
    tick: w.tick,
    terrain: isMap1
      ? 'map1'
      : { w: w.terrain.w, h: w.terrain.h, deposits: w.terrain.deposits, entries: w.terrain.entries, base: w.terrain.base },
    tables,
    scalars: {
      parts: w.parts,
      upkeep: w.upkeep,
      buildEff: w.buildEff,
      shortMask: w.shortMask,
      kills: w.kills,
      salvageFromKills: w.salvageFromKills,
      salvageReclaimed: w.salvageReclaimed,
      salvageDelivered: w.salvageDelivered,
      partsMade: w.partsMade,
      partsUsed: w.partsUsed,
      outcome: w.outcome,
      commanderId: w.commanderId,
      gridsDirty: w.gridsDirty,
      costDrift: w.costDrift,
      lastCostRefresh: w.lastCostRefresh,
      lastCommanderCell: w.lastCommanderCell,
      lastCommanderRebuild: w.lastCommanderRebuild,
      routesVersion: w.routesVersion,
      fieldBuilds: w.fieldBuilds,
      seq: w.seq,
      nextWave: w.nextWave,
      lastWaveTick: w.lastWaveTick,
      skippedTicks: w.skippedTicks,
      endTick: w.endTick,
      buildingsLost: w.buildingsLost,
      unitsLost: w.unitsLost,
      researchDone: w.researchDone,
      researchCurrent: w.researchCurrent,
      researchProgress: w.researchProgress,
      researchRate: w.researchRate,
      researchEff: w.researchEff,
    },
    fieldMeta: w.fields.map((f) => ({ builtAt: f.builtAt, goalCount: f.goalCount })),
    researchQueue: w.researchQueue,
    orders: w.orders,
    paths: w.paths,
    pathPos: w.pathPos,
    pathKey: w.pathKey,
    routes: w.routes,
    pending: w.pending,
    queue: w.queue,
    log: w.log,
    debug: w.debug,
    blobs: refs,
  };
  const json = new TextEncoder().encode(JSON.stringify(state, replacer));
  const head = 16 + ((json.length + 7) & ~7);
  const out = new Uint8Array(head + off);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, SAVE_MAGIC, true);
  dv.setUint32(4, SAVE_VERSION, true);
  dv.setUint32(8, SNAPSHOT_VERSION, true);
  dv.setUint32(12, json.length, true);
  out.set(json, 16);
  blobs.forEach(([, arr], i) => out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), head + refs[i]!.offset));
  return out;
}

/** Rebuilds a world from serializeWorld() bytes. Throws SaveVersionError for a foreign or old save. */
export function deserializeWorld(input: Uint8Array | ArrayBuffer): World {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 16) throw new SaveVersionError('This file is not a Bulwark save (too short).');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== SAVE_MAGIC) throw new SaveVersionError('This file is not a Bulwark save.');
  const version = dv.getUint32(4, true);
  const snapVersion = dv.getUint32(8, true);
  if (version !== SAVE_VERSION || snapVersion !== SNAPSHOT_VERSION)
    throw new SaveVersionError(
      `This save is version ${version} (state format ${snapVersion}); this build reads version ${SAVE_VERSION} (state format ${SNAPSHOT_VERSION}) only.`,
    );
  const jsonLen = dv.getUint32(12, true);
  const state = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + jsonLen)), reviver);
  const head = 16 + ((jsonLen + 7) & ~7);
  // Copy the blob area so typed-array views are aligned whatever the input's offset.
  const area = bytes.slice(head).buffer;
  const blob = new Map<string, ArrayLike<number>>();
  for (const r of state.blobs as BlobRef[]) blob.set(r.name, view(r.type, area, r.offset, r.length));
  const get = (name: string) => {
    const b = blob.get(name);
    if (!b) throw new SaveVersionError(`Save is missing ${name}.`);
    return b;
  };

  let terrain: Terrain;
  if (state.terrain === 'map1') terrain = map1Terrain();
  else {
    const t = state.terrain;
    terrain = { ...t, tiles: Uint8Array.from(get('terrain.tiles')), heights: Float32Array.from(get('terrain.heights')) };
  }
  const waveTicks = get('waveTicks');
  const w = new World(state.seed, terrain, { waves: waveTicks.length > 0 });
  w.rng.state = state.rng;
  w.tick = state.tick;
  for (const name of TABLES) {
    const meta = state.tables[name];
    const t = w[name] as unknown as AnyTable;
    const cols: Record<string, ArrayLike<number>> = {};
    for (const f of t.schema) cols[f.name] = get(`${name}.${f.name}`);
    t.importState({ count: meta.count, highWater: meta.highWater, free: get(`${name}.free`), alive: get(`${name}.alive`), gen: get(`${name}.gen`), cols });
  }
  w.pool.set(get('pool'));
  w.incomeRate.set(get('incomeRate'));
  w.spendRate.set(get('spendRate'));
  w.bonusPaid.set(get('bonusPaid'));
  w.waveTicks.set(waveTicks);
  w.occupancy.set(get('occupancy'));
  w.cost.set(get('cost'));
  w.costBypass.set(get('costBypass'));
  w.open.set(get('open'));
  w.walk.set(get('walk'));
  w.fieldGoal.set(get('fieldGoal'));
  w.fieldDirty.set(get('fieldDirty'));
  w.fields.forEach((f, i) => {
    f.dist.set(get(`field${i}.dist`));
    f.dir.set(get(`field${i}.dir`));
    f.builtAt = state.fieldMeta[i].builtAt;
    f.goalCount = state.fieldMeta[i].goalCount;
  });
  Object.assign(w, state.scalars);
  w.researchQueue = state.researchQueue;
  w.orders.length = 0;
  w.orders.push(...(state.orders as Order[][]));
  w.paths.length = 0;
  w.paths.push(...(state.paths as Array<number[] | null>));
  w.pathPos.length = 0;
  w.pathPos.push(...(state.pathPos as number[]));
  w.pathKey.length = 0;
  w.pathKey.push(...(state.pathKey as string[]));
  w.routes = state.routes as Route[];
  w.pending = state.pending as PendingGroup[];
  w.queue = state.queue as StampedCommand[];
  w.log.length = 0;
  w.log.push(...(state.log as StampedCommand[]));
  Object.assign(w.debug, state.debug);
  w.beltsDirty = true; // the belt order depends only on the buildings present
  return w;
}
