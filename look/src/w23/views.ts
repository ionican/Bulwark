// W23 workshop views. Each builds its own World on W17's map 1 terrain (base centre at tile 64, 64,
// on the plateau), with camera presets and, where it moves, a script.
//
//   demo      a walled compound: a 2-deep tier-2 wall ring with a gate on the north side, two mass
//             deposits (map 1's at 54,50 and 72,49) and a rare point outside it. The commander walks
//             out through the gate and builds a 5-tile wall; three engineers walk out to the
//             deposits and build extractors, which start working; a fourth carries salvage in
//             through the gate to a pile; the first engineer then drops a temporary turret. Loops.
//   painter   an empty 28 × 22 grid to paint walls on (painter.ts)
//   lineup    engineer variants, the commander, extractors and bare deposits at close range, named
//   lod       every asset at full, middle, simple and icon detail, one column per level
//   stress    400 wall tiles of mixed depth and tier with 2 gates, 40 engineers, the commander and
//             11 extractors on map 1's deposits, all animating

import { Vector3 } from 'three';
import type { CamView } from '../bench/benchCamera.ts';
import { terrain as map1 } from '../world/layout.ts';
import type { AssetKind } from './lod.ts';
import type { PartSet } from './parts.ts';
import type { Ground } from './rig/biped.ts';
import { HELMET_NAMES, PACK_NAMES, TOOL_NAMES, VARIANTS, type EngAction } from './rig/engineer.ts';
import type { CmdAction } from './rig/commander.ts';
import { CommanderUnit, EngineerUnit, type Site, type Task } from './units.ts';
import { World } from './world.ts';

export type ViewId = 'demo' | 'painter' | 'lineup' | 'lod' | 'stress';
export const VIEW_NAMES: Record<ViewId, string> = { demo: 'Demo', painter: 'Wall painter', lineup: 'Unit line-up', lod: 'Detail levels', stress: 'Stress test' };

export interface Label {
  text: string;
  at: Vector3 | (() => Vector3);
  cls?: string;
}

export interface View {
  id: ViewId;
  world: World;
  cams: { game: CamView; close: () => CamView; strategic: CamView };
  labels: Label[];
  update?(dt: number): void;
  restart?(): void;
}

const DEG = Math.PI / 180;
const NORTH = Math.PI / 2;
const SOUTH = -Math.PI / 2;
const BASE = { x: 64, z: 64 };
const strategic: CamView = { target: [BASE.x + 6, 0, BASE.z - 6], distance: 235, elevation: 65, azimuth: -45, fov: 45 };
const gameCam = (x: number, z: number, az = -30): CamView => ({ target: [x, 0, z], distance: 50, elevation: 68.9, azimuth: az, fov: 45 });

// ---- demo ---------------------------------------------------------------------------------------------

/** Demo timeline length before it loops (seconds). */
export const DEMO_LOOP = 62;

export function demoView(parts: PartSet, ground: Ground): View {
  const view: View = {
    id: 'demo',
    world: null as unknown as World,
    cams: {
      game: gameCam(64, 56),
      close: () => {
        const c = view.world.commander!;
        return { target: [c.x - 0.2, ground(c.x, c.z) + 1.7, c.z - 1.2], distance: 14, elevation: 20, azimuth: 150, fov: 40 };
      },
      strategic,
    },
    labels: [],
  };
  let t = 0;
  const build = () => {
    const w = new World(40, 36, 50, 50, ground, parts);
    const g = w.grid;
    const T = (x: number, z: number) => w.tileAt(x, z);
    // 2-deep tier-2 ring: outer and inner rectangle outlines
    g.rect(...T(57, 54), ...T(71, 66), 2, false);
    g.rect(...T(58, 55), ...T(70, 65), 2, false);
    const gate = g.placeGate(...T(64, 54));
    if (!gate) throw new Error('demo: gate does not fit');
    // a few scuffs on the ring (damage state 1) and one battered corner (state 2)
    for (const [x, z, d] of [[57, 60, 1], [57, 61, 1], [71, 62, 2], [71, 63, 1], [60, 66, 1]] as const) g.setDamage(...T(x, z), d);
    const mass1 = w.addDeposit('mass', 55, 51);
    const mass2 = w.addDeposit('mass', 73, 50);
    const rare = w.addDeposit('rare', 64.5, 45.5);
    // gate passage: centre (64.5, 55), outside (64.5, 52), inside (64.5, 58)
    const out = (x: number): Array<[number, number]> => [[x, 58], [x, 52.4]];
    const inn = (x: number): Array<[number, number]> => [[x, 52.4], [x, 58]];
    const cmd = w.addCommander(new CommanderUnit(), 64.5, 61.5, NORTH);
    const wallTiles = [66, 67, 68, 69, 70].map((x) => w.wallSite(...T(x, 48), 1));
    cmd.then({ kind: 'wait', s: 1 }, { kind: 'walk', to: [...out(64.5), [68.5, 51.2]] }, { kind: 'face', x: 68.5, z: 48.5 }, ...wallTiles.map((s): Task => ({ kind: 'build', site: s })), { kind: 'wait', s: 2 }, { kind: 'walk', to: [[64.5, 52.4], ...inn(64.5).slice(1), [64.5, 61.5]] }, { kind: 'face', x: 64.5, z: 50 });
    const e1 = w.addEngineer(new EngineerUnit(0, VARIANTS[0]!), 61.5, 60.5, NORTH);
    const e2 = w.addEngineer(new EngineerUnit(1, VARIANTS[1]!), 63.2, 62.6, NORTH);
    const e3 = w.addEngineer(new EngineerUnit(2, VARIANTS[2]!), 66.8, 60.8, NORTH);
    const e4 = w.addEngineer(new EngineerUnit(3, VARIANTS[4]!), 58.6, 43.8, -0.4);
    e4.carrying = true;
    e1.then({ kind: 'wait', s: 4.5 }, { kind: 'walk', to: [[64.1, 58], [64.1, 52.4], [58.2, 52.2], [57.7, 51.2]] }, { kind: 'build', site: w.extractorSite(mass1, Math.PI) }, { kind: 'walk', to: [[57.8, 53.2]] }, { kind: 'face', x: 59.5, z: 54.5 }, { kind: 'drop' }, { kind: 'wait', s: 2 }, { kind: 'walk', to: [[61.5, 52.6]] }, { kind: 'face', x: 64, z: 46 });
    e2.then({ kind: 'wait', s: 6 }, { kind: 'walk', to: [[64.9, 58], [64.9, 52.4], [70.2, 52.6], [71.2, 52.3]] }, { kind: 'build', site: w.extractorSite(mass2, 0) }, { kind: 'wait', s: 1 }, { kind: 'walk', to: [[69.6, 53.0]] }, { kind: 'face', x: 73, z: 50 });
    e3.then({ kind: 'wait', s: 7.5 }, { kind: 'walk', to: [[64.5, 58], [64.5, 52.4], [64.1, 48.6]] }, { kind: 'build', site: w.extractorSite(rare, 0) }, { kind: 'wait', s: 1 }, { kind: 'walk', to: [[62.6, 48.8]] }, { kind: 'face', x: 64.5, z: 45.5 });
    // salvage: carried in from a wreck to the north-west, through the gate, to a pile inside
    const pile = { x: 60.4, y: ground(60.4, 62.4), z: 62.4, n: 2 };
    w.piles.push(pile);
    e4.then({ kind: 'wait', s: 22 }, { kind: 'walk', to: [[60.5, 49.5], [64.7, 52.4], [64.7, 58], [61.2, 61.8]] }, { kind: 'carry', on: false, onDone: () => pile.n++ }, { kind: 'wait', s: 1 }, { kind: 'walk', to: [[62, 59.5]] }, { kind: 'face', x: 64, z: 56 });
    w.update(0);
    view.world = w;
    t = 0;
  };
  view.restart = build;
  view.update = (dt) => {
    t += dt;
    if (t > DEMO_LOOP) build();
  };
  view.labels = [];
  build();
  return view;
}

// ---- painter ------------------------------------------------------------------------------------------

export const PAINTER = { x0: 50, z0: 50, w: 28, h: 22 };

export function painterView(parts: PartSet, ground: Ground): View {
  const w = new World(PAINTER.x0, PAINTER.z0, PAINTER.w, PAINTER.h, ground, parts);
  const cx = PAINTER.x0 + PAINTER.w / 2;
  const cz = PAINTER.z0 + PAINTER.h / 2;
  return {
    id: 'painter',
    world: w,
    cams: { game: { target: [cx, 0, cz + 0.5], distance: 31, elevation: 60, azimuth: -15, fov: 45 }, close: () => ({ target: [cx - 4, 0.8, cz + 2], distance: 14, elevation: 30, azimuth: -28, fov: 40 }), strategic },
    labels: [],
  };
}

/** The painter's example layout: depths 1, 2 and 4, a block, a gate, mixed tiers and damage. */
export function painterExample(w: World): void {
  const g = w.grid;
  g.clear();
  // 1-deep line (tier 1), 2-deep line (tier 2) with a gate, 4 × 6 block (tier 3)
  g.line(2, 3, 12, 3, 1);
  g.rect(2, 7, 12, 8, 2, true);
  g.placeGate(7, 7);
  g.rect(16, 3, 21, 6, 3, true);
  // mixed tiers in one run, with the three damage states
  const tiers = [1, 1, 1, 2, 2, 2, 3, 3, 3];
  tiers.forEach((t, k) => {
    g.set(2 + k, 13, t);
    g.setDamage(2 + k, 13, k % 3);
  });
  // an L, a T and a cross (thin-wall pieces)
  g.line(15, 11, 25, 11, 1);
  g.line(20, 11, 20, 18, 1);
  g.line(16, 15, 24, 15, 2);
  g.line(25, 11, 25, 18, 1);
}

// ---- line-up ------------------------------------------------------------------------------------------

export interface LineupControls {
  engineers(a: EngAction): void;
  commander(a: CmdAction): void;
  extractors(working: boolean): void;
  construct(): void;
  engAction: EngAction;
  cmdAction: CmdAction;
}

export function lineupView(parts: PartSet, ground: Ground): View & { controls: LineupControls } {
  const w = new World(50, 50, 30, 20, ground, parts);
  const row = 60.5;
  const homes: Array<[number, number]> = VARIANTS.map((_, i) => [55.2 + i * 1.25, row]);
  const engs = VARIANTS.map((v, i) => w.addEngineer(new EngineerUnit(i, v), homes[i]![0], homes[i]![1], SOUTH));
  const cmdHome: [number, number] = [65.4, 60.4];
  const cmd = w.addCommander(new CommanderUnit(), cmdHome[0], cmdHome[1], SOUTH);
  const dMass = w.addDeposit('mass', 56.4, 55.2);
  const dRare = w.addDeposit('rare', 60.6, 55.2);
  w.addDeposit('mass', 52.4, 55.2);
  w.addDeposit('rare', 64.4, 55.0);
  w.addExtractor(dMass, 1, 0);
  w.addExtractor(dRare, 1, 0);
  const labels: Label[] = [];
  engs.forEach((e, i) => {
    const v = VARIANTS[i]!;
    labels.push({ text: `<b>Engineer ${i + 1}</b><br>${HELMET_NAMES[v.helmet]}<br>${PACK_NAMES[v.pack]}<br>${TOOL_NAMES[v.tool]}`, at: () => new Vector3(e.x, ground(e.x, e.z) - 0.05, e.z + (i % 2 ? 1.25 : 0.35)), cls: 'unit' });
  });
  labels.push({ text: '<b>Commander</b><br>armoured command mech, about 7 m', at: () => new Vector3(cmd.x, ground(cmd.x, cmd.z), cmd.z + 1.1), cls: 'unit' });
  labels.push({ text: '<b>Mass extractor</b>', at: new Vector3(56.4, ground(56.4, 55.2) + 2.7, 55.2) });
  labels.push({ text: '<b>Rare-material extractor</b>', at: new Vector3(60.6, ground(60.6, 55.2) + 2.4, 55.2) });
  labels.push({ text: '<b>Mass deposit</b><br>bare: build here', at: new Vector3(52.4, ground(52.4, 55.2) + 0.9, 55.2) });
  labels.push({ text: '<b>Rare point</b><br>bare: build here', at: new Vector3(64.4, ground(64.4, 55) + 1.4, 55) });

  // looping practice sites in front of each unit for the build pose
  const loopSite = (x: number, z: number, h: number): Site => {
    const s: Site = { label: 'practice', progress: 0, buildTime: 5, centre: new Vector3(x, ground(x, z), z), height: h, reach: 1, onDone: () => (s.progress = 0) };
    return s;
  };
  const circle = (cx: number, cz: number, r: number, n = 14, start = 0): Array<[number, number]> => Array.from({ length: n + 1 }, (_, k) => {
    const a = start + (k / n) * Math.PI * 2;
    return [cx + Math.sin(a) * r, cz + Math.cos(a) * r] as [number, number];
  });
  const controls: LineupControls = {
    engAction: 'idle',
    cmdAction: 'idle',
    engineers(a) {
      controls.engAction = a;
      engs.forEach((e, i) => {
        e.tasks = [];
        e.tt = 0;
        e.carrying = a === 'carry';
        const [hx, hz] = homes[i]!;
        const loop = (): Task[] => [{ kind: 'walk', to: circle(hx, hz - 0.7, 0.7, 12, 0), run: a === 'run' }, { kind: 'call', fn: () => e.tasks.push(...loop()) }];
        if (a === 'walk' || a === 'run' || a === 'carry') e.then({ kind: 'walk', to: [[hx, hz]] }, ...loop());
        else if (a === 'build') {
          // a wall tile in front of each engineer, printed over and over
          const [tx, tz] = w.tileAt(hx, hz + 1.6);
          const site = w.wallSite(tx, tz, 1 + (i % 3));
          const again = (): Task[] => [{ kind: 'build', site }, { kind: 'call', fn: () => ((site.progress = 0), e.tasks.push(...again())) }];
          e.then({ kind: 'walk', to: [[hx, hz]] }, { kind: 'face', x: hx, z: hz + 2 }, ...again());
        }
        else if (a === 'drop') e.then({ kind: 'walk', to: [[hx, hz]] }, { kind: 'face', x: hx, z: hz + 2 }, { kind: 'drop' }, { kind: 'wait', s: 1.5 }, { kind: 'call', fn: () => w.pods.splice(0, w.pods.length) }, { kind: 'call', fn: () => controls.engineers('drop') });
        else e.then({ kind: 'walk', to: [[hx, hz]] }, { kind: 'face', x: hx, z: hz + 2 });
      });
      if (a !== 'drop') w.pods.length = 0;
      if (a !== 'build') {
        w.grid.clear();
        w.wallSites.clear();
      }
    },
    commander(a) {
      controls.cmdAction = a;
      cmd.tasks = [];
      cmd.tt = 0;
      const [hx, hz] = cmdHome;
      const loop = (): Task[] => [{ kind: 'walk', to: circle(hx, hz - 2.4, 2.4, 16, 0) }, { kind: 'call', fn: () => cmd.tasks.push(...loop()) }];
      const turn = (): Task[] => [{ kind: 'face', x: hx + 5, z: hz }, { kind: 'face', x: hx, z: hz - 5 }, { kind: 'face', x: hx - 5, z: hz }, { kind: 'face', x: hx, z: hz + 5 }, { kind: 'call', fn: () => cmd.tasks.push(...turn()) }];
      if (a === 'walk') cmd.then({ kind: 'walk', to: [[hx, hz]] }, ...loop());
      else if (a === 'turn') cmd.then({ kind: 'walk', to: [[hx, hz]] }, ...turn());
      else if (a === 'build') cmd.then({ kind: 'walk', to: [[hx, hz]] }, { kind: 'face', x: hx, z: hz + 5 }, { kind: 'build', site: loopSite(hx + 1.5, hz + 3.4, 1.4) }, { kind: 'call', fn: () => controls.commander('build') });
      else if (a === 'fire') cmd.then({ kind: 'walk', to: [[hx, hz]] }, { kind: 'face', x: hx, z: hz + 5 }, { kind: 'fire', at: new Vector3(hx + 6, ground(hx + 6, hz + 14) + 0.6, hz + 14), s: 1e9 });
      else cmd.then({ kind: 'walk', to: [[hx, hz]] }, { kind: 'face', x: hx, z: hz + 5 });
    },
    extractors(on) {
      for (const d of w.deposits) if (d.extractor) d.extractor.working = on;
    },
    construct() {
      for (const d of w.deposits) {
        if (!d.extractor) continue;
        d.extractor.built = 0;
        d.extractor.working = false;
      }
      buildT = 0;
    },
  };
  let buildT = 99;
  return {
    id: 'lineup',
    world: w,
    cams: { game: gameCam(61, 58), close: () => ({ target: [59.4, 1.0, 58.2], distance: 18.5, elevation: 17, azimuth: 0, fov: 38 }), strategic },
    labels,
    controls,
    update(dt) {
      if (buildT < 8) {
        buildT += dt;
        for (const d of w.deposits) {
          if (!d.extractor) continue;
          d.extractor.built = Math.min(1, buildT / 7);
          if (d.extractor.built >= 1) d.extractor.working = true;
        }
      }
    },
  };
}

// ---- detail levels -------------------------------------------------------------------------------------

export const LOD_COLS = [48, 57, 66, 75];

export function lodView(parts: PartSet, ground: Ground): View {
  const w = new World(42, 44, 40, 24, ground, parts);
  const g = w.grid;
  const labels: Label[] = [];
  const names = ['Full', 'Middle', 'Simple', 'Icon'];
  LOD_COLS.forEach((cx, col) => {
    // wall cluster: a 7-tile tier-2 run with a gate, a tier-3 2-deep stub and a tier-1 corner
    const [tx, tz] = w.tileAt(cx, 49);
    g.line(tx - 3, tz, tx + 3, tz, 2);
    g.placeGate(tx, tz);
    g.rect(tx - 3, tz - 3, tx - 2, tz - 1, 3, true);
    g.line(tx + 3, tz - 1, tx + 3, tz - 3, 1);
    g.line(tx + 3, tz - 3, tx + 1, tz - 3, 1);
    g.setDamage(tx - 3, tz - 3, 2);
    const dm = w.addDeposit('mass', cx - 2, 54.5);
    const dr = w.addDeposit('rare', cx + 2.2, 54.5);
    w.addExtractor(dm, 1);
    w.addExtractor(dr, 1);
    w.addEngineer(new EngineerUnit(col, VARIANTS[col]!), cx - 1.6, 58.6, SOUTH);
    w.addCommander(new CommanderUnit(), cx + 1.8, 59.2, SOUTH);
    labels.push({ text: `<b>${names[col]}</b>`, at: new Vector3(cx, ground(cx, 44) + 2.5, 44.5), cls: 'head' });
  });
  w.levelOf = (_kind: AssetKind, x: number) => {
    let best = 0;
    LOD_COLS.forEach((cx, i) => {
      if (Math.abs(x - cx) < Math.abs(x - LOD_COLS[best]!)) best = i;
    });
    return best;
  };
  return {
    id: 'lod',
    world: w,
    cams: { game: { target: [61.5, 0.6, 54.2], distance: 31, elevation: 36, azimuth: 0, fov: 40 }, close: () => ({ target: [52, 0.8, 55], distance: 16, elevation: 26, azimuth: 0, fov: 40 }), strategic },
    labels,
  };
}

// ---- stress -------------------------------------------------------------------------------------------

export const STRESS_TILES = 400;

export function stressView(parts: PartSet, ground: Ground): View {
  const w = new World(14, 10, 104, 104, ground, parts);
  const g = w.grid;
  const T = (x: number, z: number) => w.tileAt(x, z);
  // 2-deep tier-2 ring round the base, gates north and east
  g.rect(...T(52, 52), ...T(76, 76), 2, false);
  g.rect(...T(53, 53), ...T(75, 75), 2, false);
  g.placeGate(...T(64, 52));
  g.placeGate(...T(76, 64));
  // tier-3 4-deep block on the north approach; tier-1 lines west and south; a 2-deep mixed line east
  g.rect(...T(57, 43), ...T(71, 46), 3, true);
  g.line(...T(45, 56), ...T(45, 72), 1);
  g.line(...T(56, 84), ...T(72, 84), 1);
  for (let z = 56; z <= 72; z++) {
    const t = z < 62 ? 1 : z < 67 ? 2 : 3;
    g.set(...T(84, z), t);
    g.set(...T(85, z), t);
  }
  // fill to 400 with short 1- and 2-deep segments round the outside, mixed tiers
  const extra: Array<[number, number, number, number, number]> = [
    [40, 80, 50, 80, 1], [40, 81, 50, 81, 2], [80, 88, 92, 88, 3], [78, 40, 90, 40, 1], [78, 41, 90, 41, 2], [38, 46, 38, 60, 3], [92, 46, 92, 56, 1], [60, 92, 76, 92, 2], [60, 93, 76, 93, 2], [96, 66, 96, 80, 3], [30, 64, 30, 78, 2],
  ];
  for (const [x0, z0, x1, z1, t] of extra) {
    if (g.count() >= STRESS_TILES) break;
    const [ax, az] = T(x0, z0);
    const [bx, bz] = T(x1, z1);
    if (ax === bx) {
      for (let z = az; z <= bz && g.count() < STRESS_TILES; z++) g.set(ax, z, t);
    } else for (let x = ax; x <= bx && g.count() < STRESS_TILES; x++) g.set(x, az, t);
  }
  // damage on a few stretches
  for (let k = 0; k < 40; k++) g.setDamage(...T(52 + (k % 25), 52 + Math.floor(k / 25) * 24), 1 + (k % 2));
  // map 1's eleven deposits, every one with a working extractor
  for (const d of map1.deposits) w.addExtractor(w.addDeposit(d.kind, d.tx + 1, d.ty + 1), 1, (d.tx * 7 + d.ty) % 4 * (Math.PI / 2));
  // 40 engineers: walking loops inside and outside the ring, some building, some carrying
  let seed = 23;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const wallTiles: Array<[number, number]> = [];
  for (let z = 0; z < g.h; z++) for (let x = 0; x < g.w; x++) if (g.plainWall(x, z)) wallTiles.push([x, z]);
  for (let i = 0; i < 40; i++) {
    const e = w.addEngineer(new EngineerUnit(i, VARIANTS[i % VARIANTS.length]!), 0, 0, 0);
    const inside = i % 2 === 0;
    const r = inside ? 3 + rnd() * 7 : 14 + rnd() * 12;
    const a = rnd() * Math.PI * 2;
    const x = BASE.x + Math.cos(a) * r;
    const z = BASE.z + Math.sin(a) * r;
    e.place(x, z, rnd() * 6, ground);
    if (i < 8) {
      // builders: a looping practice site beside a wall tile
      const [tx, tz] = wallTiles[Math.floor(rnd() * wallTiles.length)]!;
      const c = w.tileCentre(tx, tz);
      const s: Site = { label: 'repair', progress: rnd(), buildTime: 6, centre: c, height: 1.6, reach: 1.2, onDone: () => (s.progress = 0) };
      e.place(c.x + 1.6, c.z + 0.4, Math.PI, ground);
      const again = (): Task[] => [{ kind: 'build', site: s }, { kind: 'call', fn: () => e.tasks.push(...again()) }];
      e.then(...again());
    } else {
      e.carrying = i % 10 === 9;
      const pts: Array<[number, number]> = Array.from({ length: 6 }, () => {
        const rr = inside ? 3 + rnd() * 7 : 14 + rnd() * 12;
        const aa = rnd() * Math.PI * 2;
        return [BASE.x + Math.cos(aa) * rr, BASE.z + Math.sin(aa) * rr];
      });
      const loop = (): Task[] => [{ kind: 'walk', to: [...pts.map((p) => [...p] as [number, number])], run: i % 7 === 3 }, { kind: 'call', fn: () => e.tasks.push(...loop()) }];
      e.then(...loop());
    }
  }
  const cmd = w.addCommander(new CommanderUnit(), 64, 66, NORTH);
  const cloop = (): Task[] => [{ kind: 'walk', to: [[60, 62], [68, 60], [70, 68], [60, 70]] }, { kind: 'call', fn: () => cmd.tasks.push(...cloop()) }];
  cmd.then(...cloop());
  return {
    id: 'stress',
    world: w,
    cams: { game: gameCam(66, 60, -45), close: () => ({ target: [cmd.x, 1.5, cmd.z], distance: 16, elevation: 30, azimuth: -30, fov: 40 }), strategic },
    labels: [],
  };
}

export { DEG };
