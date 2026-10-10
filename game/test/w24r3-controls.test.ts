// W24 run 3, criteria 2 (map side) and 3: one active map tool (src/tools.ts) and the commands the
// map tools send. The tool state machine: select by default; build (a building kind), wall (the
// wall drag), upgrade, gate and spawn; choosing one ends the previous one; a left action without
// Shift returns to select, with Shift the tool stays until Shift is released after a Shift-held
// action (belts stay open, as before); Escape and right click cancel any tool but select (right
// click in select is an order, not a cancel); a world change returns to select; gate and spawn are
// sandbox-only and cannot be active outside it.
// Commands: gate without an axis (the simulation's predicate chooses it), spawnAt with the count
// clamped to 1–50, a wall run with the chosen depth. The drag preview's depth: w24r3-depth.test.ts.

import { describe, expect, it } from 'vitest';
import { B } from '../src/sim/kinds.ts';
import { Tools, gateCommand, runCommand, spawnAtCommand, toolLabel, type ToolName } from '../src/tools.ts';

const sandboxTools = () => new Tools(() => true);
const map1Tools = () => new Tools((t) => t !== 'gate' && t !== 'spawn');

describe('run 3 criterion 3: one active map tool', () => {
  it('select is the default; choosing a tool ends the previous one', () => {
    const t = sandboxTools();
    expect(t.name).toBe('select');
    expect(t.choose('build', B.gun)).toBe(true);
    expect(t.name).toBe('build');
    expect(t.kind).toBe(B.gun);
    t.choose('gate');
    expect(t.name).toBe('gate');
    expect(t.kind).toBe(-1);
    t.choose('spawn');
    expect(t.name).toBe('spawn');
    t.choose('upgrade');
    expect(t.name).toBe('upgrade');
    t.choose('build', B.wall);
    expect(t.name, 'the wall kind from the build bar is the wall drag tool').toBe('wall');
    expect(t.kind).toBe(B.wall);
    t.choose('select');
    expect(t.name).toBe('select');
  });

  for (const name of ['gate', 'spawn', 'upgrade', 'build'] as const) {
    it(`${name}: one action without Shift returns to select; with Shift the tool stays until Shift is released`, () => {
      const t = sandboxTools();
      t.choose(name, name === 'build' ? B.gun : -1);
      t.acted(false);
      expect(t.name).toBe('select');
      t.choose(name, name === 'build' ? B.gun : -1);
      t.acted(true);
      t.acted(true);
      expect(t.name).toBe(name);
      expect(t.shiftActed).toBe(true);
      t.shiftReleased();
      expect(t.name).toBe('select');
      // Shift released with no Shift-held action: the tool stays
      t.choose(name, name === 'build' ? B.gun : -1);
      t.shiftReleased();
      expect(t.name).toBe(name);
      // choosing again forgets an earlier Shift action
      t.acted(true);
      t.choose(name, name === 'build' ? B.gun : -1);
      expect(t.shiftActed).toBe(false);
    });
  }

  it('belts stay open after an unshifted placement and after Shift is released (as before run 3)', () => {
    const t = sandboxTools();
    t.choose('build', B.belt);
    t.acted(false);
    expect(t.name).toBe('build');
    t.acted(true);
    t.shiftReleased();
    expect(t.name).toBe('build');
  });

  it('Escape cancels any tool but select; right click cancels any tool but select and is an order in select', () => {
    for (const name of ['build', 'wall', 'upgrade', 'gate', 'spawn'] as ToolName[]) {
      const t = sandboxTools();
      t.choose(name, name === 'build' ? B.gun : name === 'wall' ? B.wall : -1);
      expect(t.escape(), `${name}: Escape cancels`).toBe(true);
      expect(t.name).toBe('select');
      t.choose(name, name === 'build' ? B.gun : name === 'wall' ? B.wall : -1);
      expect(t.rightClick(), `${name}: right click cancels (consumed)`).toBe(true);
      expect(t.name).toBe('select');
    }
    const t = sandboxTools();
    expect(t.escape(), 'Escape in select: nothing to cancel').toBe(false);
    expect(t.rightClick(), 'right click in select is not consumed: it orders (move, assist, reclaim) or pans').toBe(false);
    expect(t.name).toBe('select');
  });

  it('a world change returns to select; gate and spawn cannot be active outside the sandbox', () => {
    const t = sandboxTools();
    t.choose('spawn');
    t.worldChanged();
    expect(t.name).toBe('select');
    const m = map1Tools();
    expect(m.choose('gate')).toBe(false);
    expect(m.name).toBe('select');
    expect(m.choose('spawn')).toBe(false);
    expect(m.name).toBe('select');
    expect(m.choose('build', B.gun)).toBe(true);
    // a tool the scenario stops allowing (a map 1 save loaded while gate was armed) is dropped
    let sandbox = true;
    const s = new Tools((n) => sandbox || (n !== 'gate' && n !== 'spawn'));
    s.choose('gate');
    sandbox = false;
    s.check();
    expect(s.name).toBe('select');
  });

  it('the panel names the active tool in words', () => {
    const t = sandboxTools();
    expect(toolLabel(t, {})).toMatch(/^Tool: select/);
    t.choose('spawn');
    expect(toolLabel(t, { spawnName: 'rusher', count: 8 })).toBe('Tool: spawn rusher × 8 — click the map');
    t.choose('gate');
    expect(toolLabel(t, {})).toMatch(/^Tool: gate — /);
    t.choose('build', B.wall);
    expect(toolLabel(t, { depth: 3 })).toMatch(/^Tool: wall .*depth 3/);
  });
});

describe('run 3 criterion 2 (map tools): the commands sent', () => {
  it('gate: no axis (the simulation chooses it), the selected builders, queued with Shift', () => {
    const c = gateCommand([4, 5], 12, 30, true);
    expect(c).toEqual({ t: 'gate', ids: [4, 5], tx: 12, ty: 30, queue: true });
    expect('axis' in c).toBe(false);
  });

  it('spawnAt: the tile under the click, the count clamped to 1–50', () => {
    expect(spawnAtCommand(0, 40.5, 20.5, 8)).toEqual({ t: 'spawnAt', kind: 0, x: 40.5, z: 20.5, count: 8 });
    expect(spawnAtCommand(1, 1, 2, 0).count).toBe(1);
    expect(spawnAtCommand(1, 1, 2, 51).count).toBe(50);
    expect(spawnAtCommand(1, 1, 2, 7.6).count).toBe(8);
    expect(spawnAtCommand(1, 1, 2, Number.NaN).count).toBe(1);
  });

  it('wall run: the chosen depth reaches the command', () => {
    for (const depth of [1, 2, 3, 4]) expect(runCommand([1], [10, 10], [20, 10], depth, false)).toEqual({ t: 'buildRun', ids: [1], from: [10, 10], to: [20, 10], depth, queue: false });
  });
});
