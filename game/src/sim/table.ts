// Fixed-capacity structure-of-arrays entity tables. One table per entity kind family.
// Each column is a typed array indexed by slot. Slots are reused through a LIFO free list, and a
// 16-bit generation per slot makes a stable entity id: id = (generation << 16) | slot.
// Iteration is always in ascending slot order, which keeps the simulation deterministic.

export type FieldType = 'f32' | 'i32' | 'u32' | 'i16' | 'u16' | 'u8';

export interface FieldSpec {
  readonly name: string;
  readonly type: FieldType;
  /** False: simulation-only state that the snapshot leaves out. Default true. */
  readonly snap?: boolean;
}

export type ArrayFor<T extends FieldType> = T extends 'f32'
  ? Float32Array
  : T extends 'i32'
    ? Int32Array
    : T extends 'u32'
      ? Uint32Array
      : T extends 'i16'
        ? Int16Array
        : T extends 'u16'
          ? Uint16Array
          : Uint8Array;

export type Columns<S extends readonly FieldSpec[]> = { [F in S[number] as F['name']]: ArrayFor<F['type']> };

export type AnyTypedArray = Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Uint8Array;

export const BYTES: Record<FieldType, number> = { f32: 4, i32: 4, u32: 4, i16: 2, u16: 2, u8: 1 };

export function makeArray(type: FieldType, n: number): AnyTypedArray;
export function makeArray(type: FieldType, n: number, buffer: ArrayBuffer, offset: number): AnyTypedArray;
export function makeArray(type: FieldType, n: number, buffer?: ArrayBuffer, offset = 0): AnyTypedArray {
  if (buffer) {
    switch (type) {
      case 'f32': return new Float32Array(buffer, offset, n);
      case 'i32': return new Int32Array(buffer, offset, n);
      case 'u32': return new Uint32Array(buffer, offset, n);
      case 'i16': return new Int16Array(buffer, offset, n);
      case 'u16': return new Uint16Array(buffer, offset, n);
      case 'u8': return new Uint8Array(buffer, offset, n);
    }
  }
  switch (type) {
    case 'f32': return new Float32Array(n);
    case 'i32': return new Int32Array(n);
    case 'u32': return new Uint32Array(n);
    case 'i16': return new Int16Array(n);
    case 'u16': return new Uint16Array(n);
    case 'u8': return new Uint8Array(n);
  }
}

export const slotOf = (id: number): number => id & 0xffff;
export const genOf = (id: number): number => id >>> 16;

export class Table<S extends readonly FieldSpec[]> {
  readonly schema: S;
  readonly capacity: number;
  readonly cols: Columns<S>;
  readonly alive: Uint8Array;
  readonly gen: Uint16Array;
  /** Number of live entities. */
  count = 0;
  /** One past the highest slot ever used; iteration stops here. */
  highWater = 0;
  private readonly free: Int32Array;
  private freeTop = 0;

  constructor(schema: S, capacity: number) {
    if (capacity > 0x10000) throw new Error('table capacity above 65536 does not fit a 16-bit slot');
    this.schema = schema;
    this.capacity = capacity;
    this.alive = new Uint8Array(capacity);
    this.gen = new Uint16Array(capacity);
    this.free = new Int32Array(capacity);
    const cols: Record<string, AnyTypedArray> = {};
    for (const f of schema) cols[f.name] = makeArray(f.type, capacity);
    this.cols = cols as Columns<S>;
  }

  /** Allocates a slot, zeroes its columns and returns the slot. Throws when full. */
  create(): number {
    let slot: number;
    if (this.freeTop > 0) slot = this.free[--this.freeTop]!;
    else if (this.highWater < this.capacity) slot = this.highWater++;
    else throw new Error('entity table full');
    for (const f of this.schema) (this.cols as Record<string, AnyTypedArray>)[f.name]![slot] = 0;
    this.alive[slot] = 1;
    this.count++;
    return slot;
  }

  remove(slot: number): void {
    if (!this.alive[slot]) return;
    this.alive[slot] = 0;
    this.gen[slot] = (this.gen[slot]! + 1) & 0xffff;
    this.free[this.freeTop++] = slot;
    this.count--;
  }

  id(slot: number): number {
    return ((this.gen[slot]! << 16) | slot) >>> 0;
  }

  /** Slot for a live id, or -1 if the entity has gone. */
  slotForId(id: number): number {
    const slot = slotOf(id);
    if (slot >= this.highWater || !this.alive[slot] || this.gen[slot] !== genOf(id)) return -1;
    return slot;
  }
}
