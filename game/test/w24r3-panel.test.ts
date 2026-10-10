// W24 run 3, criteria 1, 2 (panel side), 4 and 5: the sandbox panel's logic (ui/sandboxPanel.ts).
//   1  shown only when the snapshot's scenario is the sandbox, through real save and load
//      transitions both ways (SimRunner.load); the DEBUG spawn box is hidden whenever it is shown
//   2  every control sends exactly its command through a fake command sink: tabs and collapse
//      (no command), wall-run depth 1–4, gate and spawn arm their map tool, count clamped to 1–50,
//      wave 1–20 sent as index 0–19, clear aliens and wrecks, routes toggle (no command), tune
//      slider mapping (log position, 0.1 steps to 2, 0.5 steps to 10) sent once on release, reset
//      kind and reset all, free spending, grant all research, the two-click resets (second click
//      within 3 s), cancel run, reset stats; a refusal shows the reason as a "bad" toast
//   4  tune labels: the effective tier-1 value of every supported field, worked out by the
//      simulation's own accessors (tuning.ts) on the snapshot's multipliers and research, speed in
//      tiles per second, wall hit points per tile
//   5  the Stats tables equal statsReport(snapshot.stats) for run 1's scripted fight

import { describe, expect, it } from 'vitest';
import { A, B, BUILDING_KINDS, U, UNIT_INFO, UNIT_KINDS, buildingInfo } from '../src/sim/kinds.ts';
import { createWorld } from '../src/sim/scenarios.ts';
import { SimRunner } from '../src/sim/runner.ts';
import { serializeWorld } from '../src/sim/save.ts';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from '../src/sim/snapshot.ts';
import { statsReport } from '../src/sim/stats.ts';
import { TICK_HZ } from '../src/sim/kinds.ts';
import { alienDps, alienMaxHp, alienSpeed, turretDamage, turretInterval, turretRange, unitBuildRate, unitMaxHp, unitSpeed } from '../src/sim/tuning.ts';
import { World } from '../src/sim/world.ts';
import { flatTerrain } from '../src/sim/terrain.ts';
import type { Command } from '../src/sim/commands.ts';
import {
  PANEL_TABS,
  SandboxPanelModel,
  debugSpawnVisible,
  multToSlider,
  panelVisible,
  quantiseMult,
  sliderToMult,
  statsTables,
  tuneLabels,
  waveIndex,
  type PanelSink,
} from '../src/ui/sandboxPanel.ts';
import { clampSpawnCount } from '../src/tools.ts';

const snap = (w: World): Snapshot => decodeSnapshot(encodeSnapshot(w));

describe('run 3 criterion 1: the panel follows the snapshot scenario', () => {
  it('sandbox → map 1 save → sandbox save: shown, hidden, shown (and the DEBUG spawn box the other way round)', () => {
    const sandbox = createWorld(1, 'sandbox');
    const map1 = createWorld(1, 'map1');
    for (let i = 0; i < 5; i++) map1.step();
    const runner = new SimRunner(sandbox, 0);
    runner.advance(1000);
    expect(panelVisible(snap(runner.world))).toBe(true);
    expect(debugSpawnVisible(snap(runner.world))).toBe(false);
    const sandboxSave = serializeWorld(runner.world);
    runner.load(serializeWorld(map1));
    expect(runner.world.scenario).toBe('map1');
    expect(panelVisible(snap(runner.world))).toBe(false);
    expect(debugSpawnVisible(snap(runner.world))).toBe(true);
    runner.load(sandboxSave);
    expect(runner.world.scenario).toBe('sandbox');
    expect(panelVisible(snap(runner.world))).toBe(true);
    expect(debugSpawnVisible(snap(runner.world))).toBe(false);
    expect(panelVisible(null)).toBe(false);
  });
});

/** A panel model over a fake sink that records every command, toast and armed tool. */
function harness(refuse: string | null = null) {
  const sent: Command[] = [];
  const toasts: Array<[string, boolean]> = [];
  const armed: string[] = [];
  let now = 10_000;
  const sink: PanelSink = {
    send: (cmd) => {
      sent.push(cmd);
      return Promise.resolve(refuse ? { ok: false as const, reason: refuse } : { ok: true as const });
    },
    toast: (text, bad) => void toasts.push([text, bad]),
    armTool: (name) => {
      armed.push(name);
      return true;
    },
  };
  const m = new SandboxPanelModel(sink, () => now);
  return { m, sent, toasts, armed, advance: (ms: number) => (now += ms) };
}

describe('run 3 criterion 2: the panel controls send exactly their commands', () => {
  it('five tabs; the active one is marked by "▸" (not colour); collapse and expand send nothing', () => {
    const { m, sent } = harness();
    expect(PANEL_TABS).toEqual(['build', 'spawn', 'tune', 'economy', 'stats']);
    expect(m.tab).toBe('build');
    expect(m.tabLabels()).toEqual(['▸ Build', 'Spawn', 'Tune', 'Economy', 'Stats']);
    m.selectTab('stats');
    expect(m.tabLabels()).toEqual(['Build', 'Spawn', 'Tune', 'Economy', '▸ Stats']);
    expect(m.collapsed).toBe(false);
    expect(m.collapseLabel()).toBe('–');
    m.toggleCollapse();
    expect(m.collapsed).toBe(true);
    expect(m.collapseLabel()).toBe('+');
    m.toggleCollapse();
    expect(m.collapsed).toBe(false);
    expect(sent).toEqual([]);
  });

  it('Build: depth 1–4 (clamped), the gate tool armed by its button, a run cancelled by its ×', async () => {
    const { m, sent, armed } = harness();
    expect(m.depth).toBe(1);
    m.setDepth(3);
    expect(m.depth).toBe(3);
    m.setDepth(9);
    expect(m.depth).toBe(4);
    m.setDepth(0);
    expect(m.depth).toBe(1);
    m.armGate();
    expect(armed).toEqual(['gate']);
    await m.cancelRun(7);
    expect(sent).toEqual([{ t: 'cancelRun', run: 7 }]);
  });

  it('Spawn: kind, count clamped to 1–50, Place arms the spawn tool; waves 1–20 sent as index 0–19; clears; routes toggle sends nothing', async () => {
    const { m, sent, armed } = harness();
    m.setSpawnKind(A.hunter);
    expect(m.spawnKind).toBe(A.hunter);
    m.setCount('12');
    expect(m.count).toBe(12);
    m.setCount(0);
    expect(m.count).toBe(1);
    m.setCount(99);
    expect(m.count).toBe(50);
    m.stepCount(1);
    expect(m.count).toBe(50);
    m.stepCount(-1);
    expect(m.count).toBe(49);
    m.setCount('abc');
    expect(m.count).toBe(1);
    expect(clampSpawnCount(7.6)).toBe(8);
    m.armSpawn();
    expect(armed).toEqual(['spawn']);
    m.setWave(1);
    await m.startWave();
    m.setWave(20);
    await m.startWave();
    m.setWave(25);
    expect(m.wave).toBe(20);
    m.setWave(0);
    expect(m.wave).toBe(1);
    expect(waveIndex(7)).toBe(6);
    await m.clearAliens();
    await m.clearWrecks();
    expect(m.routes).toBe(false);
    m.toggleRoutes();
    expect(m.routes).toBe(true);
    expect(sent).toEqual([{ t: 'startWave', index: 0 }, { t: 'startWave', index: 19 }, { t: 'clearAliens' }, { t: 'clearWrecks' }]);
  });

  it('Tune: logarithmic slider, quantised to 0.1 up to 2 and 0.5 from 2 to 10; sent once on release, not per pixel', async () => {
    expect(sliderToMult(0)).toBeCloseTo(0.1, 9);
    expect(sliderToMult(1)).toBeCloseTo(10, 9);
    expect(sliderToMult(0.5)).toBeCloseTo(1, 9);
    expect(quantiseMult(1.234)).toBeCloseTo(1.2, 9);
    expect(quantiseMult(0.149)).toBeCloseTo(0.1, 9);
    expect(quantiseMult(2.2)).toBeCloseTo(2, 9);
    expect(quantiseMult(3.3)).toBeCloseTo(3.5, 9);
    expect(quantiseMult(9.9)).toBeCloseTo(10, 9);
    expect(quantiseMult(0.01)).toBeCloseTo(0.1, 9);
    expect(quantiseMult(40)).toBeCloseTo(10, 9);
    for (const m of [0.1, 0.5, 1, 2, 3.5, 10]) expect(sliderToMult(multToSlider(m))).toBeCloseTo(m, 9);
    // every slider position lands on the grid
    for (let p = 0; p <= 1; p += 0.01) {
      const v = sliderToMult(p);
      const step = v <= 2 ? 0.1 : 0.5;
      expect(Math.abs(v / step - Math.round(v / step)), `position ${p.toFixed(2)} → ${v}`).toBeLessThan(1e-9);
    }
    const { m, sent } = harness();
    m.setTuneTarget('building');
    m.setTuneKind(B.gun);
    for (let p = 0.5; p <= multToSlider(2) + 1e-9; p += 0.02) m.tuneDrag('damage', p);
    m.tuneDrag('damage', multToSlider(2));
    expect(sent, 'dragging sends nothing').toEqual([]);
    expect(m.shownMult('damage')).toBeCloseTo(2, 9);
    await m.tuneCommit('damage');
    expect(sent).toEqual([{ t: 'tune', target: 'building', kind: B.gun, field: 'damage', mult: 2 }]);
    await m.tuneCommit('damage');
    expect(sent.length, 'a second release with no drag sends nothing').toBe(1);
    await m.tuneResetKind();
    await m.tuneResetAll();
    expect(sent.slice(1)).toEqual([{ t: 'tuneReset', target: 'building', kind: B.gun }, { t: 'tuneReset' }]);
    m.setTuneTarget('unit');
    expect(m.tuneKind, 'a new target starts at its first kind').toBe(0);
  });

  it('Economy: free spending, grant all research, and the two resets each need a second click within 3 s', async () => {
    const { m, sent, advance } = harness();
    await m.setUnlimited(true);
    await m.setUnlimited(false);
    await m.grantAll();
    expect(sent).toEqual([{ t: 'setUnlimited', on: true }, { t: 'setUnlimited', on: false }, { t: 'grantResearch', all: true }]);
    sent.length = 0;
    expect(m.reset(false)).toBe('confirm');
    expect(m.resetLabel(false)).toBe('click again to confirm');
    expect(m.resetLabel(true)).toBe('Full reset');
    advance(2000);
    expect(m.reset(false)).toBe('sent');
    expect(sent).toEqual([{ t: 'resetSandbox', full: false }]);
    expect(m.resetLabel(false)).toBe('Reset sandbox');
    // too late: the confirmation lapses after 3 s
    expect(m.reset(true)).toBe('confirm');
    advance(3500);
    expect(m.resetLabel(true)).toBe('Full reset');
    expect(m.reset(true)).toBe('confirm');
    // a click on the other reset does not confirm this one
    expect(m.reset(false)).toBe('confirm');
    expect(m.reset(true)).toBe('confirm');
    expect(m.reset(true)).toBe('sent');
    expect(sent).toEqual([{ t: 'resetSandbox', full: false }, { t: 'resetSandbox', full: true }]);
  });

  it('Stats: reset stats', async () => {
    const { m, sent } = harness();
    await m.resetStats();
    expect(sent).toEqual([{ t: 'resetStats' }]);
  });

  it('every command refused shows the reason as a bad toast, once', async () => {
    const { m, sent, toasts } = harness('this game is map1');
    await m.startWave();
    await m.clearAliens();
    await m.setUnlimited(true);
    expect(sent.length).toBe(3);
    expect(toasts).toEqual([
      ['Refused: this game is map1', true],
      ['Refused: this game is map1', true],
      ['Refused: this game is map1', true],
    ]);
  });
});

describe('run 3 criterion 4: tune labels show the effective tier-1 value', () => {
  // A sandbox world with multipliers set and Field Engineering granted, through real commands.
  const w = createWorld(1, 'sandbox');
  w.enqueue({ t: 'tune', target: 'building', kind: B.gun, field: 'damage', mult: 2 });
  w.enqueue({ t: 'tune', target: 'building', kind: B.gun, field: 'range', mult: 1.5 });
  w.enqueue({ t: 'tune', target: 'building', kind: B.gun, field: 'interval', mult: 0.5 });
  w.enqueue({ t: 'tune', target: 'building', kind: B.gun, field: 'hp', mult: 3 });
  w.enqueue({ t: 'tune', target: 'building', kind: B.wall, field: 'hp', mult: 2.5 });
  w.enqueue({ t: 'tune', target: 'alien', kind: A.rusher, field: 'speed', mult: 2 });
  w.enqueue({ t: 'tune', target: 'alien', kind: A.rusher, field: 'dps', mult: 0.5 });
  w.enqueue({ t: 'tune', target: 'unit', kind: U.engineer, field: 'buildRate', mult: 2 });
  w.enqueue({ t: 'tune', target: 'unit', kind: U.engineer, field: 'speed', mult: 1.5 });
  w.enqueue({ t: 'grantResearch', node: 'fieldEng' });
  w.step();
  const s = snap(w);
  const byField = (target: 'building' | 'alien' | 'unit', kind: number) => Object.fromEntries(tuneLabels(s, target, kind).map((l) => [l.field, l]));

  it('gun turret: hit points, damage per shot, range in tiles, interval in seconds, each with its multiplier', () => {
    const L = byField('building', B.gun);
    expect(Object.keys(L)).toEqual(['hp', 'damage', 'range', 'interval']);
    expect(L.hp!.value).toBeCloseTo(buildingInfo(B.gun).hp * 3, 6);
    expect(L.damage!.value).toBeCloseTo(turretDamage(w, B.gun, 1), 9);
    expect(L.damage!.value).toBeCloseTo(buildingInfo(B.gun).weapon!.damage * 2, 6);
    expect(L.range!.value).toBeCloseTo(turretRange(w, B.gun), 9);
    expect(L.interval!.value).toBeCloseTo(turretInterval(w, B.gun), 9);
    expect(L.damage!.mult).toBe(2);
    for (const l of Object.values(L)) expect(l.text, l.field).toMatch(/tier 1/);
    expect(L.damage!.text).toMatch(/per shot/);
    expect(L.range!.text).toMatch(/tiles/);
    expect(L.interval!.text).toMatch(/ s\b/);
  });

  it('a building with no weapon lists hit points only; a wall’s hit points are per tile', () => {
    const L = byField('building', B.wall);
    expect(Object.keys(L)).toEqual(['hp']);
    expect(L.hp!.value).toBeCloseTo(buildingInfo(B.wall).hp * 2.5, 6);
    expect(L.hp!.text).toMatch(/per tile/);
    expect(Object.keys(byField('building', B.generator))).toEqual(['hp']);
  });

  it('rusher: hit points, damage per second, speed in tiles per second (stored per tick × 10)', () => {
    const L = byField('alien', A.rusher);
    expect(Object.keys(L)).toEqual(['hp', 'dps', 'speed']);
    expect(L.hp!.value).toBeCloseTo(alienMaxHp(w, A.rusher), 9);
    expect(L.dps!.value).toBeCloseTo(alienDps(w, A.rusher), 9);
    expect(L.speed!.value).toBeCloseTo(alienSpeed(w, A.rusher) * TICK_HZ, 9);
    expect(L.speed!.text).toMatch(/tiles\/s/);
  });

  it('engineer: build power with Field Engineering (1.5×) and the buildRate multiplier; speed converted', () => {
    const L = byField('unit', U.engineer);
    expect(Object.keys(L)).toEqual(['hp', 'speed', 'buildRate']);
    expect(L.buildRate!.value).toBeCloseTo(unitBuildRate(w, U.engineer), 9);
    expect(w.researched('fieldEng')).toBe(true);
    expect(L.buildRate!.value).toBeCloseTo(UNIT_INFO.engineer.buildRate * 1.5 * 2, 6);
    expect(L.speed!.value).toBeCloseTo(unitSpeed(w, U.engineer) * TICK_HZ, 9);
    expect(L.hp!.value).toBeCloseTo(unitMaxHp(w, U.engineer), 9);
    expect(L.buildRate!.text).toMatch(/build power/);
  });
});

describe('run 3 criterion 5: the Stats tables equal statsReport', () => {
  // Run 1's stats fixture (test/w24-stats.test.ts fight()): two guns, an area cannon and a
  // temporary turret against 14 rushers, 4 hunters and 2 breakers.
  const w = new World(5, flatTerrain(48, 48, { base: { x: 24, z: 44 } }), { waves: false });
  w.pool.set([1e6, 1e6, 1e6]);
  w.placeBuilding(B.gun, 20, 30, true);
  w.placeBuilding(B.gun, 26, 30, true);
  w.placeBuilding(B.area, 23, 33, true);
  const eng = w.spawnUnit(U.engineer, 23.5, 37.5);
  w.enqueue({ t: 'dropTurret', id: eng });
  w.step();
  for (let i = 0; i < 14; i++) w.spawnAlien(A.rusher, 16 + i, 8 + (i % 3) * 0.7);
  for (let i = 0; i < 4; i++) w.spawnAlien(A.hunter, 20 + i * 2, 5);
  w.spawnAlien(A.breaker, 21, 3);
  w.spawnAlien(A.breaker, 27, 3);
  for (let i = 0; i < 1500; i++) w.step();
  const s = snap(w);
  const report = statsReport(s.stats);
  const t = statsTables(s);

  it('shooter rows: shots, hit points removed and kills of each building and unit kind', () => {
    expect(report.shooters.gun!.kills).toBeGreaterThan(0);
    const names = [...BUILDING_KINDS, ...UNIT_KINDS];
    for (const row of t.shooters) {
      const r = report.shooters[row.name]!;
      expect(r, row.name).toBeDefined();
      expect(row.values, row.name).toEqual([r.shots, r.hpRemoved, r.kills]);
    }
    // every kind with a non-zero counter has its row
    for (const n of names) {
      const r = report.shooters[n]!;
      if (r.shots || r.hpRemoved || r.kills) expect(t.shooters.map((x) => x.name), n).toContain(n);
    }
  });

  it('alien rows: spawned, killed, hit points removed from walls and gates, other buildings and units; absorbed by shields its own row', () => {
    for (const row of t.aliens) {
      const r = report.aliens[row.name]!;
      expect(row.values, row.name).toEqual([r.spawned, r.killed, r.hpFromWalls, r.hpFromBuildings, r.hpFromUnits]);
    }
    expect(t.aliens.map((r) => r.name)).toEqual(Object.keys(report.aliens));
    expect(t.absorbed.label).toBe('absorbed by shields');
    expect(t.absorbed.values).toEqual(Object.values(report.aliens).map((a) => a.absorbedByShields));
  });

  it('numbers right-aligned with thousands separators; an all-zero row shows "–" and is marked dimmed', () => {
    for (const row of [...t.shooters, ...t.aliens]) {
      row.values.forEach((v, i) => {
        expect(row.cells[i], `${row.name} ${i}`).toBe(v === 0 ? '–' : Math.round(v).toLocaleString('en-GB'));
      });
      expect(row.zero, row.name).toBe(row.values.every((v) => v === 0));
    }
    expect(t.shooters.some((r) => r.zero), 'at least one dimmed (all-zero) row').toBe(true);
    expect(t.shooters.some((r) => !r.zero)).toBe(true);
  });
});
