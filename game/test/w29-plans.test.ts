// W29 (PLAN-W29 item 13 and Risks): every extractor in the scripted map 1 plans has a belt that is a
// connected directed chain from a cell whose back faces the extractor to a cell pointing into the
// core, queued at the extractor's priority (its minute, after it in the plan); a line may join an
// earlier extractor's line from behind or the side. The map 1 outcomes
// with belts are test/fullmap.test.ts.

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/scenarios.ts';
import { B, BDX as DX, BDZ as DZ, buildingInfo, isBelt } from '../src/sim/kinds.ts';
import { BALANCED, NO_DEFENCE, type PlanStep } from './plans.ts';

function chains(plan: PlanStep[]): string[] {
  const w = createWorld(1, 'map1');
  const core = w.buildings.slotForId(w.coreId);
  const c = w.buildings.cols;
  const inCore = (x: number, z: number) => x >= c.tx[core]! && x < c.tx[core]! + 3 && z >= c.ty[core]! && z < c.ty[core]! + 3;
  const belts = new Map<string, { dir: number; i: number }>();
  plan.forEach((s, i) => {
    if ('build' in s.act && s.act.build === B.belt) belts.set(`${s.act.at[0]},${s.act.at[1]}`, { dir: s.act.dir ?? 0, i });
  });
  const problems: string[] = [];
  plan.forEach((s, i) => {
    if (!('build' in s.act) || (s.act.build !== B.massExtractor && s.act.build !== B.rareExtractor)) return;
    const [tx, ty] = s.act.at;
    const { fw, fh } = buildingInfo(s.act.build);
    // perimeter cells with the direction pointing away (conveyor.ts output)
    const ring: Array<[number, number, number]> = [];
    for (let k = 0; k < fh; k++) ring.push([tx + fw, ty + k, 0], [tx - 1, ty + k, 2]);
    for (let k = 0; k < fw; k++) ring.push([tx + k, ty + fh, 1], [tx + k, ty - 1, 3]);
    const start = ring.find(([x, z, d]) => belts.get(`${x},${z}`)?.dir === d);
    if (!start) {
      problems.push(`extractor at ${tx},${ty}: no belt whose back faces it`);
      return;
    }
    let [x, z] = start;
    const seen = new Set<string>();
    for (;;) {
      const b = belts.get(`${x},${z}`);
      if (!b) {
        problems.push(`extractor at ${tx},${ty}: the chain breaks at ${x},${z}`);
        return;
      }
      // queued with this extractor (after it, same minute), or part of an earlier extractor's line
      // that this one joins (queued no later): the core has 12 input cells and map 1 has 11
      // extractors, several of them on the same side
      const bs = plan[b.i]!;
      if (b.i > i ? bs.min !== s.min : bs.min > s.min) problems.push(`extractor at ${tx},${ty} (minute ${s.min}, step ${i}): belt ${x},${z} is minute ${bs.min}, step ${b.i}`);
      if (seen.has(`${x},${z}`)) {
        problems.push(`extractor at ${tx},${ty}: the chain loops at ${x},${z}`);
        return;
      }
      seen.add(`${x},${z}`);
      const nx = x + DX[b.dir]!;
      const nz = z + DZ[b.dir]!;
      if (inCore(nx, nz)) break;
      // a belt only takes from behind and the sides: the next tile must not point back at this one
      const n = belts.get(`${nx},${nz}`);
      if (n && (n.dir + 2) % 4 === b.dir) problems.push(`extractor at ${tx},${ty}: ${nx},${nz} faces back into ${x},${z}`);
      x = nx;
      z = nz;
    }
  });
  return problems;
}

describe('W29 scripted belts on map 1', () => {
  it('every extractor of the balanced plan is belted to the core by a directed chain at its priority', () => {
    expect(chains(BALANCED)).toEqual([]);
    expect(BALANCED.some((s) => 'build' in s.act && isBelt(s.act.build))).toBe(true);
  });

  it('the no-defence plan keeps the same belts', () => {
    expect(chains(NO_DEFENCE)).toEqual([]);
  });

  it('every belt tile of the plans stands on free ground clear of the core and of every other planned footprint', () => {
    const w = createWorld(1, 'map1');
    const taken = new Map<string, string>();
    for (const s of BALANCED) {
      if (!('build' in s.act)) continue;
      const { fw, fh, label } = buildingInfo(s.act.build);
      const [tx, ty] = s.act.at;
      for (let j = 0; j < fh; j++)
        for (let i = 0; i < fw; i++) {
          const key = `${tx + i},${ty + j}`;
          expect(taken.get(key), `${label} at ${tx},${ty} overlaps ${taken.get(key)}`).toBeUndefined();
          taken.set(key, `${label} at ${tx},${ty}`);
        }
      expect(w.canPlace(s.act.build, tx, ty), `${label} at ${tx},${ty}`).toBe(true);
    }
  });
});
