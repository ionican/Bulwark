// Binary min-heap of (key, value) pairs on typed arrays. Keys are doubles; ties must be broken by
// the caller folding a tiebreaker into the key so that pop order is deterministic.

export class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;

  constructor(capacity: number) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  clear(): void {
    this.size = 0;
  }

  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.keys.length * 2);
      k.set(this.keys);
      const v = new Int32Array(this.vals.length * 2);
      v.set(this.vals);
      this.keys = k;
      this.vals = v;
    }
    let i = this.size++;
    const keys = this.keys;
    const vals = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= key) break;
      keys[i] = keys[p]!;
      vals[i] = vals[p]!;
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  /** Key of the top item. */
  peekKey(): number {
    return this.keys[0]!;
  }

  /** Removes the top item and returns its value. */
  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0]!;
    const n = --this.size;
    if (n > 0) {
      const k = keys[n]!;
      const v = vals[n]!;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1]! < keys[c]!) c++;
        if (keys[c]! >= k) break;
        keys[i] = keys[c]!;
        vals[i] = vals[c]!;
        i = c;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return top;
  }
}
