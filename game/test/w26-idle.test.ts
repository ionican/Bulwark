// W26, criterion 1: the idle set (render/idle.ts) from snapshot fixtures. Idle = a commander or an
// engineer with state US_IDLE and 0 orders in the snapshot's queue section. US_WAITING (waiting for
// resources), moving, building and reclaiming are not idle; nor is an idle-state unit with a queued
// order. Aliens and buildings never appear. Ids are listed in id order (the column's click cycle).

import { describe, expect, it } from 'vitest';
import { A, B, U } from '../src/sim/kinds.ts';
import { US_BUILDING, US_IDLE, US_MOVING, US_RECLAIMING, US_WAITING } from '../src/sim/schema.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { World } from '../src/sim/world.ts';
import { idleUnits, nextIdle } from '../src/render/idle.ts';
import { terrain } from './w24r2a-fixtures.ts';

function fixture() {
  const w = new World(1, terrain, { waves: false });
  const cmd = w.spawnUnit(U.commander, 64.5, 64.5);
  const e = Array.from({ length: 7 }, (_, i) => w.spawnUnit(U.engineer, 50.5 + i * 2, 70.5));
  w.spawnAlien(A.rusher, 60.5, 40.5);
  w.placeBuilding(B.gun, 66, 56, true);
  const s = decodeSnapshot(encodeSnapshot(w));
  const row = (id: number) => Array.prototype.indexOf.call(s.units.id, id) as number;
  const st = s.units.cols.state;
  for (let r = 0; r < s.units.count; r++) st[r] = US_IDLE;
  // e0, e1 idle; e2 waiting for resources; e3 idle state but one queued order; e4 moving; e5 building; e6 reclaiming
  st[row(e[2]!)] = US_WAITING;
  s.queues.count[row(e[3]!)] = 1;
  st[row(e[4]!)] = US_MOVING;
  st[row(e[5]!)] = US_BUILDING;
  st[row(e[6]!)] = US_RECLAIMING;
  return { s, cmd, e };
}

describe('W26 criterion 1: the idle set from a snapshot', () => {
  it('exactly the US_IDLE commanders and engineers with no queued orders, in id order', () => {
    const { s, cmd, e } = fixture();
    const idle = idleUnits(s);
    expect(idle.commander).toEqual([cmd]);
    expect(idle.engineer).toEqual([e[0]!, e[1]!].sort((a, b) => a - b));
  });

  it('waiting, queued, moving, building and reclaiming units are excluded; aliens and buildings never appear', () => {
    const { s, e } = fixture();
    const idle = idleUnits(s);
    for (const id of e.slice(2)) expect(idle.engineer).not.toContain(id);
    const all = [...idle.commander, ...idle.engineer];
    for (let r = 0; r < s.aliens.count; r++) expect(all).not.toContain(s.aliens.id[r]);
    for (let r = 0; r < s.buildings.count; r++) expect(all).not.toContain(s.buildings.id[r]);
    expect(Object.keys(idle).sort()).toEqual(['commander', 'engineer']);
  });

  it('a commander that is busy leaves the set on the next snapshot', () => {
    const { s, cmd } = fixture();
    s.units.cols.state[Array.prototype.indexOf.call(s.units.id, cmd)] = US_MOVING;
    expect(idleUnits(s).commander).toEqual([]);
  });

  it('a click cycles through the idle units of a type in id order, wrapping round, and skips ids that went busy', () => {
    const ids = [3, 9, 12];
    expect(nextIdle(ids, null)).toBe(3);
    expect(nextIdle(ids, 3)).toBe(9);
    expect(nextIdle(ids, 9)).toBe(12);
    expect(nextIdle(ids, 12)).toBe(3);
    // the last one clicked went busy (not in the list): the next id after it
    expect(nextIdle(ids, 10)).toBe(12);
    expect(nextIdle([], 4)).toBe(null);
  });
});
