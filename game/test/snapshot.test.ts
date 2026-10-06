import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world.ts';
import { Rng } from '../src/sim/rng.ts';
import { ALIEN_FIELDS, BUILDING_FIELDS, UNIT_FIELDS } from '../src/sim/schema.ts';
import { decodeSnapshot, encodeSnapshot, SNAPSHOT_MAGIC } from '../src/sim/snapshot.ts';
import type { AnyTypedArray, FieldSpec, Table } from '../src/sim/table.ts';

/** A value of the column's type that survives storage exactly, and is never zero. */
function randomValue(type: FieldSpec['type'], r: Rng): number {
  switch (type) {
    case 'f32':
      return Math.fround(r.range(-5000, 5000)) || 1.5;
    case 'i32':
      return (r.int(2 ** 31) - 2 ** 30) | 0 || 3;
    case 'u32':
      return r.int(2 ** 32) >>> 0 || 4;
    case 'i16':
      return r.int(65536) - 32768 || 5;
    case 'u16':
      return r.int(65535) + 1;
    case 'u8':
      return r.int(255) + 1;
  }
}

function fill(table: Table<readonly FieldSpec[]>, n: number, r: Rng) {
  for (let i = 0; i < n; i++) {
    const slot = table.create();
    for (const f of table.schema) (table.cols as Record<string, AnyTypedArray>)[f.name]![slot] = randomValue(f.type, r);
  }
  // Remove every third entity so the snapshot has to skip holes, then reuse some slots.
  for (let s = 0; s < table.highWater; s += 3) table.remove(s);
  for (let i = 0; i < Math.floor(n / 6); i++) {
    const slot = table.create();
    for (const f of table.schema) (table.cols as Record<string, AnyTypedArray>)[f.name]![slot] = randomValue(f.type, r);
  }
}

describe('snapshot encode -> decode', () => {
  const r = new Rng(99);
  const w = new World(1234);
  const tables = {
    buildings: w.buildings as unknown as Table<readonly FieldSpec[]>,
    aliens: w.aliens as unknown as Table<readonly FieldSpec[]>,
    units: w.units as unknown as Table<readonly FieldSpec[]>,
  };
  fill(tables.buildings, 301, r);
  fill(tables.aliens, 517, r);
  fill(tables.units, 23, r);
  for (let i = 0; i < 37; i++) w.rng.next();
  w.tick = 98765;

  const snap = decodeSnapshot(encodeSnapshot(w));

  it('round-trips the header', () => {
    expect(snap.tick).toBe(98765);
    expect(snap.rngState).toBe(w.rng.state);
    expect(snap.seed).toBe(1234);
    expect(snap.mapW).toBe(128);
    expect(snap.mapH).toBe(128);
    expect(snap.buildings.count).toBe(w.buildings.count);
    expect(snap.aliens.count).toBe(w.aliens.count);
    expect(snap.units.count).toBe(w.units.count);
  });

  const cases = [
    ['buildings', BUILDING_FIELDS],
    ['aliens', ALIEN_FIELDS],
    ['units', UNIT_FIELDS],
  ] as const;

  for (const [name, schema] of cases) {
    it(`round-trips every snapshot field of ${name}, in slot order, with ids`, () => {
      const table = tables[name];
      const sec = snap[name] as unknown as { count: number; id: Uint32Array; cols: Record<string, AnyTypedArray> };
      const cols = table.cols as Record<string, AnyTypedArray>;
      const snapFields = (schema as readonly FieldSpec[]).filter((f) => f.snap !== false);
      expect(Object.keys(sec.cols).sort()).toEqual(snapFields.map((f) => f.name).sort());
      let row = 0;
      let checked = 0;
      for (let s = 0; s < table.highWater; s++) {
        if (!table.alive[s]) continue;
        expect(sec.id[row]).toBe(table.id(s));
        for (const f of snapFields) {
          expect(sec.cols[f.name]![row], `${name}.${f.name} row ${row}`).toBe(cols[f.name]![s]);
          checked++;
        }
        row++;
      }
      expect(row).toBe(sec.count);
      expect(checked).toBeGreaterThan(20);
    });
  }

  it('leaves simulation-only fields out', () => {
    expect('goalX' in snap.aliens.cols).toBe(false);
    expect('goalZ' in snap.units.cols).toBe(false);
  });

  it('rejects a buffer that is not a snapshot', () => {
    const bad = new ArrayBuffer(256);
    expect(() => decodeSnapshot(bad)).toThrow();
    const h = new Uint32Array(bad);
    h[0] = SNAPSHOT_MAGIC;
    h[1] = 999;
    expect(() => decodeSnapshot(bad)).toThrow(/version/);
  });
});
