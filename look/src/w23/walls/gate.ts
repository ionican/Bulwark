// W23 gate doors: open for the player's own units (engineers and the commander), never for aliens.
// Pure logic (no three.js).
//
// Each frame the gate looks for friendly units inside its trigger box — gate space, x along the run
// within the 3-tile width plus half a tile, z across the run within the wall depth plus APPROACH
// tiles on either side. With one inside, the doors drive open; with none, they drive shut, so they
// close behind a unit once it has walked clear. Aliens in the box are ignored: for an alien a gate
// is a wall (aliens.ts in the game treats it as one in the flow-field cost).

import { GATE_WIDTH } from './grid.ts';

export type MoverKind = 'engineer' | 'commander' | 'alien';

export interface Mover {
  kind: MoverKind;
  /** World tile coordinates (tile centres at .5). */
  x: number;
  z: number;
}

/** Friendly units open gates; aliens do not. */
export function opensGates(kind: MoverKind): boolean {
  return kind === 'engineer' || kind === 'commander';
}

/** Tiles in front of and behind the wall from which an approaching unit opens the gate. */
export const APPROACH = 3.2;
/** Full travel time of the doors, seconds. */
export const DOOR_TIME = 1.1;

export class GateDoor {
  /** 0 shut … 1 open. */
  open = 0;
  want = false;
  /** Seconds since the last friendly unit left the trigger box. */
  private clearFor = Infinity;

  constructor(
    /** Centre in world tile coordinates. */
    readonly cx: number,
    readonly cz: number,
    readonly axis: 'x' | 'z',
    readonly depth: number,
  ) {}

  /** Whether a mover at (x, z) is inside the trigger box. */
  inBox(x: number, z: number): boolean {
    const dx = x - this.cx;
    const dz = z - this.cz;
    const u = this.axis === 'x' ? dx : dz;
    const v = this.axis === 'x' ? dz : dx;
    return Math.abs(u) < GATE_WIDTH / 2 + 0.5 && Math.abs(v) < this.depth / 2 + APPROACH;
  }

  update(dt: number, movers: Iterable<Mover>): void {
    let friendly = false;
    for (const m of movers) if (opensGates(m.kind) && this.inBox(m.x, m.z)) friendly = true;
    // a short hold so the doors do not twitch when a unit brushes the edge of the box
    this.clearFor = friendly ? 0 : this.clearFor + dt;
    this.want = friendly || this.clearFor < 0.4;
    const step = dt / DOOR_TIME;
    this.open = Math.max(0, Math.min(1, this.open + (this.want ? step : -step)));
  }

  /** The opening (2 tiles) is clear enough for the commander to walk through. */
  get passable(): boolean {
    return this.open > 0.92;
  }
}
