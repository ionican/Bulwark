// Render thread: owns the canvas, camera, input and HUD. The simulation lives in the worker; this
// thread only receives snapshots, interpolates them and sends commands back.
//
// URL parameters: ?stress=1 (stress scene), ?sandbox=1 (W24 mechanics sandbox), ?seed=<n>
// (simulation seed, default 1), ?rich=1 (debug: start with 1,000,000 of each resource),
// ?greybox=1 (W13's greybox renderer, for comparison), ?quality=high (default medium).
// The scenario shown is the one in the snapshot: loading a save switches to the save's scenario.

import { PerspectiveCamera } from 'three';
import { createRenderer, type Quality } from './render/adapter.ts';
import { measureRenderCost } from './render/cost.ts';
import { Orbit, applyRig, clampRig, pitchFor, worldPerPixel, type Rig } from './render/cameraRig.ts';
import { Gestures } from './input.ts';
import { Ghost } from './render/ghost.ts';
import { groundHeight } from './render/ground.ts';
import { entitiesOf, inspectScene } from './render/inspect.ts';
import { LOD_THRESHOLDS } from './render/lod.ts';
import { Interpolator } from './render/interp.ts';
import { boxSelect, buildOccupancy, pickScreen, screenToGround, type GroundHit, type Pick, type PickView } from './render/picking.ts';
import { createView } from './render/view.ts';
import {
  ALIEN_INFO,
  ALIEN_KINDS,
  B,
  BUILDING_INFO,
  BUILDING_KINDS,
  CATEGORY_NAMES,
  U,
  UNIT_INFO,
  UNIT_KINDS,
  buildingInfo,
  buildingFootprint,
  isBelt,
  type BuildingKind,
} from './sim/kinds.ts';
import { BF_COMPLETE, BF_UPGRADING, constructionState, isReserved } from './sim/schema.ts';
import {
  G_COMMANDER_HP,
  G_COMMANDER_ID,
  G_DELIVERED,
  G_ENERGY,
  G_FIELD_BUILDS,
  G_INCOME,
  G_KILLS,
  G_MASS,
  G_OUTCOME,
  G_PARTS,
  G_PARTS_MADE,
  G_PARTS_USED,
  G_PENDING_SPAWNS,
  G_RARE,
  G_RECLAIMED,
  G_SALVAGE_KILLS,
  G_SHORT,
  G_SPEND,
  G_UPKEEP,
  G_BONUS_ENERGY,
  G_BONUS_MASS,
  G_BUILDINGS_LOST,
  G_END_TICK,
  G_NEXT_WAVE,
  G_NEXT_WAVE_TICK,
  G_RESEARCH_CURRENT,
  G_RESEARCH_DONE,
  G_RESEARCH_PROGRESS,
  G_RESEARCH_QUEUED,
  G_RESEARCH_RATE,
  G_SKIPPED_TICKS,
  G_UNITS_LOST,
  G_WAVE_COUNT,
  G_COMMANDER_DEATHS,
  G_RESPAWN_TICK,
  G_RUNS,
  G_SCENARIO,
  G_UNLIMITED,
  decodeSnapshot,
  type Snapshot,
} from './sim/snapshot.ts';
import { CAPACITY, SCENARIO_NAMES } from './sim/world.ts';
import { statsReport } from './sim/stats.ts';
import { TUNE_FIELDS, TUNE_KINDS, TUNE_TARGETS, TU_HP, tuneIndex, type TuneTarget } from './sim/tuning.ts';
import { WRECK_COMMANDER } from './sim/sandbox.ts';
import { map1Terrain } from './sim/terrain.ts';
import { canPlaceOn } from './sim/world.ts';
import type { Command } from './sim/commands.ts';
import type { FromWorker, RunnerInfo, ToWorker } from './sim/protocol.ts';
import { BUILD_REQUIRES, RESEARCH, RESEARCH_INDEX } from './sim/balance.ts';
import { alienKindIndex, buildingKindIndex, entryIndex as entryIndexOf, researchNodeId, tuneKindIndex } from './sim/names.ts';
import { EndScreen, ResearchPanel, Ticker, TimeControls, Toasts } from './ui/panels.ts';
import type { ScenarioName } from './sim/scenarios.ts';
import { Hud } from './ui/hud.ts';
import { BuildBar, TEST_GROUP } from './ui/buildbar.ts';

// ---- setup ---------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const scenario: ScenarioName = params.get('stress') === '1' ? 'stress' : params.get('sandbox') === '1' ? 'sandbox' : 'map1';
const seed = (Number(params.get('seed') ?? '1') || 1) >>> 0;

const terrain = map1Terrain();
const renderMode = params.get('greybox') === '1' ? 'greybox' : 'models';
const adapter = createRenderer(renderMode, params.get('quality') === 'high' ? 'high' : 'medium');
document.body.appendChild(adapter.canvas);
let consoleErrors = 0;
window.addEventListener('error', () => consoleErrors++);
window.addEventListener('unhandledrejection', () => consoleErrors++);

const camera = new PerspectiveCamera(45, 1, 0.5, 1000);
const DEG = Math.PI / 180;
/** Preset views (Home: far). The user owns the tilt afterwards (left-drag). */
const VIEWS = {
  close: { distance: 26, pitch: 50 * DEG },
  mid: { distance: 95, pitch: 66 * DEG },
  far: { distance: 175, pitch: 84 * DEG },
} as const;
// the default game camera keeps W10's elevation for distance 50 (about 69°)
const rig: Rig = { x: terrain.base.x, z: terrain.base.z - 2, distance: 50, yaw: 0, pitch: pitchFor(50) };
const orbit = new Orbit(rig);

const loading = document.createElement('div');
loading.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;color:#f4efe6;font:600 18px system-ui,sans-serif;background:#1d1916;z-index:50';
loading.textContent = 'Loading…';
document.body.appendChild(loading);
const view = await createView(adapter, terrain, camera, CAPACITY, (t) => (loading.textContent = t));
loading.remove();
const scene = view.scene;
const entities = view.entities;
const ghost = new Ghost(scene, terrain);
const hud = new Hud();

let vw = window.innerWidth;
let vh = window.innerHeight;
function resize() {
  vw = window.innerWidth;
  vh = window.innerHeight;
  adapter.setSize(vw, vh);
  camera.aspect = vw / vh;
  applyCamera();
}
function applyCamera() {
  clampRig(rig, terrain.w, terrain.h);
  applyRig(camera, rig, groundHeight(terrain, rig.x, rig.z));
}
window.addEventListener('resize', resize);
resize();

// ---- worker --------------------------------------------------------------------------------

const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (msg: ToWorker, transfer: Transferable[] = []) => worker.postMessage(msg, transfer);
const interp = new Interpolator(CAPACITY);
const occupancy = new Int32Array(terrain.w * terrain.h);
let lastTickMs = 0;
const tickSamples: number[] = [];

let runnerInfo: RunnerInfo = { speed: 1, paused: false, checkpoints: [] };
const rejected: Array<{ reason: string; cmd: Command }> = [];
const notices: string[] = [];
let lastSave: { bytes: number; tick: number; name: string } | null = null;
let pendingDownload = false;
let savedBlobUrl: string | null = null;

/** Commands sent with a ref, waiting for the worker's acceptance or refusal. */
type CommandResult = { ok: true; tick: number; detail?: Record<string, unknown> } | { ok: false; reason: string };
const waiting = new Map<number, (r: CommandResult) => void>();
let nextRef = 1;
let commanderDeathsSeen = 0;

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const msg = ev.data;
  if (msg.type === 'rejected') {
    rejected.push({ reason: msg.reason, cmd: msg.cmd });
    if (rejected.length > 50) rejected.shift();
    // A refusal is reported, not an error: the console shows it as a warning, the toast with a cross.
    console.warn('command refused:', msg.reason, msg.cmd);
    toasts.show(`Refused: ${msg.reason}`, true);
    if (msg.ref !== undefined) {
      waiting.get(msg.ref)?.({ ok: false, reason: msg.reason });
      waiting.delete(msg.ref);
    }
    return;
  }
  if (msg.type === 'accepted') {
    waiting.get(msg.ref)?.({ ok: true, tick: msg.tick, detail: msg.detail });
    waiting.delete(msg.ref);
    return;
  }
  if (msg.type === 'notice' || msg.type === 'error') {
    notices.push(msg.message);
    if (notices.length > 50) notices.shift();
    toasts.show(msg.message, msg.type === 'error');
    return;
  }
  if (msg.type === 'saved') {
    const name = `bulwark-map1-tick${msg.tick}.bulwark`;
    lastSave = { bytes: msg.bytes.byteLength, tick: msg.tick, name };
    if (savedBlobUrl) URL.revokeObjectURL(savedBlobUrl);
    savedBlobUrl = URL.createObjectURL(new Blob([msg.bytes], { type: 'application/octet-stream' }));
    if (pendingDownload) {
      const a = document.createElement('a');
      a.href = savedBlobUrl;
      a.download = name;
      a.click();
    }
    toasts.show(`Saved ${name} (${(msg.bytes.byteLength / 1024).toFixed(0)} KB)`);
    return;
  }
  runnerInfo = msg.runner;
  const snap = decodeSnapshot(msg.buffer);
  const dropped = interp.push(snap, performance.now());
  if (dropped) send({ type: 'recycle', buffer: dropped.buffer }, [dropped.buffer]);
  buildOccupancy(buildingRows(snap), terrain.w, terrain.h, occupancy);
  // Sandbox: the commander fell; say when the next one comes (the simulation carries on).
  const deaths = snap.globals[G_COMMANDER_DEATHS]!;
  if (deaths > commanderDeathsSeen) {
    const due = snap.globals[G_RESPAWN_TICK]!;
    const msgText = `Commander destroyed: its wreck stays, and a new commander arrives at the base in ${Math.max(0, (due - snap.tick) / 10).toFixed(0)} s.`;
    notices.push(msgText);
    toasts.show(msgText, true);
  }
  commanderDeathsSeen = deaths;
  if (msg.ticksRun > 0) {
    lastTickMs = msg.tickMs;
    tickSamples.push(msg.tickMs);
    if (tickSamples.length > 100) tickSamples.shift();
  }
};
worker.onerror = (e) => {
  consoleErrors++;
  console.error('simulation worker error', e.message);
};
send({ type: 'init', seed, scenario, rich: params.get('rich') === '1' });

function command(cmd: Command) {
  send({ type: 'command', cmd });
}

/** Sends a command and resolves with its final result: applied at its tick, or refused with the reason. */
function commandResult(cmd: Command): Promise<CommandResult> {
  const ref = nextRef++;
  return new Promise((resolve) => {
    waiting.set(ref, resolve);
    send({ type: 'command', cmd, ref });
  });
}

function buildingRows(s: Snapshot) {
  const c = s.buildings.cols;
  return { count: s.buildings.count, id: s.buildings.id, kind: c.kind, tx: c.tx, ty: c.ty, fw: c.fw, fh: c.fh };
}

// ---- time, waves, research, saves -------------------------------------------------------------

const toasts = new Toasts();
const ticker = new Ticker();
function togglePause() {
  send({ type: 'pause', paused: !runnerInfo.paused });
  runnerInfo = { ...runnerInfo, paused: !runnerInfo.paused };
}
function setSpeed(speed: number) {
  send({ type: 'speed', speed });
  runnerInfo = { ...runnerInfo, speed };
}
function callEarly() {
  command({ t: 'callWave' });
}
function rewind() {
  send({ type: 'rewind' });
}
function exportSave(download = true) {
  pendingDownload = download;
  send({ type: 'save' });
}
async function importSave(file: File | ArrayBuffer) {
  const bytes = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  send({ type: 'load', bytes }, [bytes]);
}
const research = new ResearchPanel((id) => command({ t: 'research', node: id }));
const timeControls = new TimeControls({
  pause: togglePause,
  speed: setSpeed,
  callEarly,
  rewind,
  research: () => research.toggle(),
  exportSave: () => exportSave(true),
  importSave: (f) => void importSave(f),
});
const endScreen = new EndScreen({ rewind, exportSave: () => exportSave(true), restart: () => location.reload() });

function researchDoneMask(): number {
  return interp.curr?.globals[G_RESEARCH_DONE] ?? 0;
}
/** Research label a building kind (or the upgrade tool) still needs, or null. */
function lockedBy(kind: string): string | null {
  const req = BUILD_REQUIRES[kind];
  if (!req) return null;
  return researchDoneMask() & (1 << RESEARCH_INDEX[req]!) ? null : RESEARCH[RESEARCH_INDEX[req]!]!.label;
}

function pickView(): PickView | null {
  const s = interp.curr;
  if (!s) return null;
  return {
    mapW: terrain.w,
    mapH: terrain.h,
    occupancy,
    buildings: buildingRows(s),
    units: interp.units,
    aliens: interp.aliens,
    wrecks: { count: s.wrecks.count, id: s.wrecks.id, kind: s.wrecks.cols.kind, x: s.wrecks.cols.x, z: s.wrecks.cols.z },
  };
}

// ---- selection -----------------------------------------------------------------------------

let selection: Pick[] = [];

function buildingRow(id: number): number {
  const s = interp.curr;
  if (!s) return -1;
  return Array.prototype.indexOf.call(s.buildings.id, id);
}

function describe(p: Pick) {
  const kindName =
    p.type === 'building' ? BUILDING_KINDS[p.kind] : p.type === 'alien' ? ALIEN_KINDS[p.kind] : p.type === 'wreck' ? 'wreck' : UNIT_KINDS[p.kind];
  let label =
    p.type === 'building'
      ? BUILDING_INFO[BUILDING_KINDS[p.kind]!].label
      : p.type === 'alien'
        ? ALIEN_INFO[ALIEN_KINDS[p.kind]!].label
        : p.type === 'wreck'
          ? `Wreck (${p.kind === WRECK_COMMANDER ? 'Commander' : ALIEN_INFO[ALIEN_KINDS[p.kind]!].label})`
          : UNIT_INFO[UNIT_KINDS[p.kind]!].label;
  if (p.type === 'building') {
    const r = buildingRow(p.id);
    const c = interp.curr!.buildings.cols;
    if (r >= 0 && isReserved(c.flags[r]!)) label += ' (reserved: not started)';
    else if (r >= 0 && (!(c.flags[r]! & BF_COMPLETE) || c.flags[r]! & BF_UPGRADING)) label += ` (building ${(c.progress[r]! * 100).toFixed(0)}%)`;
    else if (r >= 0 && c.tier[r]! > 1) label += ` tier ${c.tier[r]}`;
  }
  return { type: p.type, id: p.id, kind: p.kind, kindName: kindName ?? '?', label };
}

function setSelection(next: Pick[], add = false) {
  if (add) {
    const ids = new Set(selection.map((p) => `${p.type}:${p.id}`));
    selection = [...selection, ...next.filter((p) => !ids.has(`${p.type}:${p.id}`))];
  } else selection = next;
  refreshSelectionPanel();
}

function refreshSelectionPanel() {
  const counts = new Map<string, number>();
  for (const p of selection) {
    const l = describe(p).label;
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  hud.showSelection([...counts].map(([l, n]) => (n > 1 ? `${n} × ${l}` : l)));
}

function selectAt(x: number, y: number, add = false) {
  const view = pickView();
  if (!view) return [];
  const p = pickScreen(camera, x, y, vw, vh, terrain, view);
  setSelection(p ? [p] : [], add);
  return selection.map(describe);
}

/** Selected commander and engineers that are still alive. */
function selectedBuilders(): number[] {
  const live = new Set(Array.from(interp.units.id.subarray(0, interp.units.count)));
  return selection.filter((p) => p.type === 'unit' && live.has(p.id)).map((p) => p.id);
}
function selectedEngineers(): number[] {
  return selection.filter((p) => p.type === 'unit' && p.kind === U.engineer).map((p) => p.id);
}

// ---- build tools ---------------------------------------------------------------------------

let buildMode: { kind: number; dir: number } | null = null;
let upgradeMode = false;

function setBuildMode(kind: BuildingKind | null) {
  upgradeMode = false;
  if (kind === null || !selectedBuilders().length) {
    buildMode = null;
    ghost.hide();
    return;
  }
  buildMode = { kind: B[kind], dir: buildMode?.dir ?? 0 };
}

/** Footprint origin under a ground point, centred on the cursor. */
function footprintAt(kind: number, gx: number, gz: number): [number, number] {
  const [fw, fh] = buildingFootprint(kind);
  return [fw === 1 ? Math.floor(gx) : Math.round(gx - fw / 2), fh === 1 ? Math.floor(gz) : Math.round(gz - fh / 2)];
}

function placeBuild(kind: number, tx: number, ty: number, dir: number, queue: boolean): boolean {
  const ids = selectedBuilders();
  if (!ids.length || !canPlaceOn(terrain, occupancy, kind, tx, ty)) return false;
  command({ t: 'build', ids, kind, tx, ty, dir, queue });
  // Mark the tiles at once so a quick second click does not double-book them.
  const [fw, fh] = buildingFootprint(kind);
  for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) occupancy[(ty + j) * terrain.w + tx + i] = -1;
  return true;
}

function placeBeltLine(kind: number, x0: number, z0: number, x1: number, z1: number, dirIfSingle: number, queue: boolean) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  let first = true;
  if (dx === 0 && dz === 0) {
    placeBuild(kind, x0, z0, dirIfSingle, queue);
    return;
  }
  if (Math.abs(dx) >= Math.abs(dz)) {
    const dir = dx > 0 ? 0 : 2;
    for (let x = x0; x !== x1 + Math.sign(dx); x += Math.sign(dx)) if (placeBuild(kind, x, z0, dir, queue || !first)) first = false;
  } else {
    const dir = dz > 0 ? 1 : 3;
    for (let z = z0; z !== z1 + Math.sign(dz); z += Math.sign(dz)) if (placeBuild(kind, x0, z, dir, queue || !first)) first = false;
  }
}

// ---- input ---------------------------------------------------------------------------------

const canvas = adapter.canvas;
const keys = new Set<string>();
let mouse: { x: number; y: number } | null = null;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

/** Tile under a screen point, or null. */
function tileAtScreen(x: number, y: number): { tx: number; ty: number; g: GroundHit } | null {
  const g = screenToGround(camera, x, y, vw, vh, terrain);
  return g ? { tx: Math.floor(g.x), ty: Math.floor(g.z), g } : null;
}

const gestures = new Gestures(orbit, {
  camera,
  viewportHeight: () => vh,
  building: () => buildMode !== null || upgradeMode,
  click(button, x, y, shift) {
    if (button === 0) {
      if (buildMode) {
        const t = tileAtScreen(x, y);
        if (t) {
          const [tx, ty] = footprintAt(buildMode.kind, t.g.x, t.g.z);
          placeBuild(buildMode.kind, tx, ty, buildMode.dir, shift);
        }
        // Belts stay selected for laying more; other buildings only while Shift is held.
        if (!shift && !isBelt(buildMode.kind)) setBuildMode(null);
        return;
      }
      if (upgradeMode) {
        const view = pickView();
        const p = view ? pickScreen(camera, x, y, vw, vh, terrain, view) : null;
        const ids = selectedEngineers();
        if (p && p.type === 'building' && buildingInfo(p.kind).tiers && ids.length) command({ t: 'upgrade', ids, target: p.id, queue: shift });
        if (!shift) upgradeMode = false;
        return;
      }
      selectAt(x, y, shift);
    } else if (button === 2) {
      if (buildMode || upgradeMode) {
        setBuildMode(null);
        return;
      }
      rightClick(x, y, shift);
    }
  },
  box(x0, y0, x1, y1, shift) {
    const view = pickView();
    if (view) setSelection(boxSelect(camera, x0, y0, x1, y1, vw, vh, terrain, view), shift);
  },
  boxPreview(r) {
    const b = hud.box.style;
    if (!r) {
      b.display = 'none';
      return;
    }
    b.display = 'block';
    b.left = `${Math.min(r.x0, r.x1)}px`;
    b.top = `${Math.min(r.y0, r.y1)}px`;
    b.width = `${Math.abs(r.x1 - r.x0)}px`;
    b.height = `${Math.abs(r.y1 - r.y0)}px`;
  },
  buildDrag(x0, y0, x1, y1, shift) {
    if (!buildMode) return;
    const a = tileAtScreen(x0, y0);
    const b = tileAtScreen(x1, y1);
    if (a && b) {
      if (buildMode.kind === B.wall) {
        // a wall drag lays a run (one order per builder, built tile by tile: run 1's buildRun)
        const ids = selectedBuilders();
        if (ids.length) void commandResult({ t: 'buildRun', ids, from: [a.tx, a.ty], to: [b.tx, b.ty], depth: 1, queue: shift });
      } else if (isBelt(buildMode.kind)) placeBeltLine(buildMode.kind, a.tx, a.ty, b.tx, b.ty, buildMode.dir, shift);
      else {
        const [tx, ty] = footprintAt(buildMode.kind, b.g.x, b.g.z);
        placeBuild(buildMode.kind, tx, ty, buildMode.dir, shift);
      }
    }
    if (!shift && !isBelt(buildMode.kind)) setBuildMode(null);
  },
});
const ptr = (e: PointerEvent) => ({ button: e.button, x: e.clientX, y: e.clientY, shift: e.shiftKey });
canvas.addEventListener('pointerdown', (e) => {
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // a synthetic event (tests) has no active pointer to capture
  }
  if (e.button === 1) e.preventDefault();
  gestures.down(ptr(e));
});
canvas.addEventListener('pointermove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  gestures.move(ptr(e));
});
canvas.addEventListener('pointerup', (e) => gestures.up(ptr(e)));
canvas.addEventListener('pointercancel', () => gestures.cancel());
canvas.addEventListener('pointerleave', () => {
  mouse = null;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(e.clientX, e.clientY, Math.exp(dy * 0.0012));
  },
  { passive: false },
);

/** Right click with units selected: reclaim a wreck, help an unfinished site, or move. */
function rightClick(x: number, y: number, queue: boolean) {
  const ids = selectedBuilders();
  if (!ids.length) return;
  const view = pickView();
  const g = screenToGround(camera, x, y, vw, vh, terrain);
  const p = view ? pickScreen(camera, x, y, vw, vh, terrain, view) : null;
  if (p?.type === 'wreck') {
    const eng = selectedEngineers();
    if (eng.length) {
      command({ t: 'reclaim', ids: eng, wreck: p.id, queue });
      return;
    }
  }
  if (p?.type === 'building') {
    const r = buildingRow(p.id);
    const c = interp.curr!.buildings.cols;
    if (r >= 0 && (!(c.flags[r]! & BF_COMPLETE) || c.flags[r]! & BF_UPGRADING)) {
      command({ t: 'assist', ids, target: p.id, queue });
      return;
    }
  }
  if (g) command({ t: 'move', ids, x: g.x, z: g.z, queue });
}

const KEY_TO_KIND = new Map<string, BuildingKind>();
for (const k of BUILDING_KINDS) if (BUILDING_INFO[k].key) KEY_TO_KIND.set(BUILDING_INFO[k].key, k);

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) togglePause();
    return;
  }
  if (e.shiftKey && /^Digit[123]$/.test(e.code)) {
    setSpeed(Number(e.code.slice(5)));
    return;
  }
  if (k === 'c' && !e.repeat) {
    callEarly();
    return;
  }
  if (k === 'y' && !e.repeat) {
    research.toggle();
    return;
  }
  if (k === 'h' && !e.repeat) {
    hud.toggleHelp();
    return;
  }
  if (e.key === 'Home') setView('far');
  if (e.key === 'Escape') setBuildMode(null);
  if (k === 'r' && buildMode) buildMode.dir = (buildMode.dir + 1) & 3;
  else if (KEY_TO_KIND.has(k)) setBuildMode(KEY_TO_KIND.get(k)!);
  else if (k === 'u') startUpgrade();
  else if (k === 't') dropTurret();
  else if (k === 'x') stopUnits();
  keys.add(k);
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.key.toLowerCase());
});
window.addEventListener('blur', () => keys.clear());

function startUpgrade() {
  buildMode = null;
  ghost.hide();
  upgradeMode = selectedEngineers().length > 0;
}
function dropTurret() {
  for (const id of selectedEngineers()) command({ t: 'dropTurret', id });
}
function stopUnits() {
  const ids = selectedBuilders();
  if (ids.length) command({ t: 'stop', ids });
}

const bar = new BuildBar(
  {
    build: (k) => setBuildMode(k),
    upgrade: startUpgrade,
    produce: () => {
      const c = selection.find((p) => p.type === 'unit' && p.kind === U.commander);
      if (c) command({ t: 'produce', id: c.id, queue: true });
    },
    dropTurret,
    stop: stopUnits,
    spawn: (kind, entry) => command({ t: 'spawn', kind, entry, count: TEST_GROUP[ALIEN_KINDS[kind]!]! }),
  },
  terrain.entries.map((e) => e.name),
);

function zoomAt(sx: number, sy: number, factor: number) {
  const before = screenToGround(camera, sx, sy, vw, vh, terrain);
  rig.distance *= factor;
  applyCamera();
  const after = screenToGround(camera, sx, sy, vw, vh, terrain);
  if (before && after) {
    rig.x += before.x - after.x;
    rig.z += before.z - after.z;
    applyCamera();
  }
}

function setView(name: keyof typeof VIEWS) {
  orbit.stop();
  rig.distance = VIEWS[name].distance;
  rig.pitch = VIEWS[name].pitch;
  if (name === 'far') {
    rig.x = terrain.w / 2;
    rig.z = terrain.h / 2;
  }
  applyCamera();
}

function steer(dt: number) {
  let px = 0;
  let pz = 0;
  if (keys.has('w') || keys.has('arrowup')) pz -= 1;
  if (keys.has('s') || keys.has('arrowdown')) pz += 1;
  if (keys.has('a') || keys.has('arrowleft')) px -= 1;
  if (keys.has('d') || keys.has('arrowright')) px += 1;
  if (mouse && !gestures.dragging) {
    const edge = 6;
    if (mouse.x <= edge) px -= 1;
    if (mouse.x >= vw - 1 - edge) px += 1;
    if (mouse.y <= edge) pz -= 1;
    if (mouse.y >= vh - 1 - edge) pz += 1;
  }
  let rot = 0;
  if (keys.has('q')) rot -= 1;
  if (keys.has('e')) rot += 1;
  if (!px && !pz && !rot) return;
  const speed = rig.distance * 0.9 * dt;
  const c = Math.cos(rig.yaw);
  const s = Math.sin(rig.yaw);
  rig.x += (px * c + pz * s) * speed;
  rig.z += (-px * s + pz * c) * speed;
  rig.yaw += rot * 1.6 * dt;
  applyCamera();
}

function updateGhost() {
  if (!buildMode || !mouse) {
    ghost.hide();
    return;
  }
  const g = screenToGround(camera, mouse.x, mouse.y, vw, vh, terrain);
  if (!g) {
    ghost.hide();
    return;
  }
  const [tx, ty] = footprintAt(buildMode.kind, g.x, g.z);
  const ok = canPlaceOn(terrain, occupancy, buildMode.kind, tx, ty);
  ghost.show(buildMode.kind, tx, ty, buildMode.dir, ok, worldPerPixel(camera, g.dist, vh), rig.yaw);
}

// ---- frame loop ----------------------------------------------------------------------------

const frameTimes: number[] = [];
const frameCpu: number[] = [];
let lastFrame = performance.now();
let hudAt = 0;
let drawCalls = 0;
let frames = 0;
/** CPU ms of the last frame's scene update (interpolation, instance filling, lighting fit). */
let updateMs = 0;

let costRunning = false;
function frame(now: number) {
  requestAnimationFrame(frame);
  if (costRunning) return;
  const cpu0 = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  frameTimes.push(now);
  while (frameTimes.length && frameTimes[0]! < now - 1000) frameTimes.shift();
  steer(dt);
  if (orbit.update()) applyCamera();
  const snap = interp.curr;
  const tUpdate = performance.now();
  if (snap) {
    interp.update(now);
    view.update(
      {
        camera,
        viewportHeight: vh,
        yaw: rig.yaw,
        snapshot: snap,
        aliens: interp.aliens,
        units: interp.units,
        projectiles: interp.projectiles,
        selection,
        // walking advances by distance; paused, nothing moves and the feet do not settle
        dt: runnerInfo.paused ? 0 : dt,
      },
      rig.distance,
      (x, y, z) => worldPerPixel(camera, Math.hypot(x - camera.position.x, y - camera.position.y, z - camera.position.z), vh),
      rig.distance > LOD_THRESHOLDS[1]!,
    );
  }
  updateGhost();
  updateMs = performance.now() - tUpdate;
  adapter.render(dt);
  drawCalls = adapter.drawCalls();
  frames++;
  frameCpu.push(performance.now() - cpu0);
  if (frameCpu.length > 120) frameCpu.shift();
  if (now - hudAt > 250 && snap) {
    hudAt = now;
    hud.update({
      fps: frameTimes.length,
      tickMs: lastTickMs,
      tick: snap.tick,
      drawCalls,
      triangles: adapter.triangles(),
      counts: entityCounts(snap),
      lod: lodCounts(),
      distance: rig.distance,
      renderer: adapter.describe(),
      scenario: { map1: 'map 1', stress: 'stress scene', empty: 'empty map', sandbox: 'sandbox (map 1)' }[SCENARIO_NAMES[snap.globals[G_SCENARIO]!] ?? 'map1'],
      view: renderMode === 'greybox' ? 'greybox' : `models · ${adapter.quality}`,
    });
    const g = snap.globals;
    hud.updateEconomy({
      pool: [g[G_MASS]!, g[G_ENERGY]!, g[G_RARE]!],
      income: [g[G_INCOME]!, g[G_INCOME + 1]!, g[G_INCOME + 2]!],
      spend: [g[G_SPEND]!, g[G_SPEND + 1]!, g[G_SPEND + 2]!],
      short: [0, 1, 2].map((k) => (g[G_SHORT]! & (1 << k)) !== 0),
      parts: g[G_PARTS]!,
      commanderHp: g[G_COMMANDER_HP]!,
      // Sandbox tuning scales the commander's maximum (unit table, commander row, hp field).
      commanderMax: UNIT_INFO.commander.hp * snap.tuning.unit[tuneIndex('unit', U.commander, TU_HP)]!,
      aliens: snap.aliens.count,
      kills: g[G_KILLS]!,
      upkeep: g[G_UPKEEP]!,
      lost: g[G_OUTCOME] === 1,
      won: g[G_OUTCOME] === 2,
    });
    refreshSelectionPanel();
    ticker.update({
      tick: snap.tick,
      nextWave: g[G_NEXT_WAVE]!,
      nextWaveTick: g[G_NEXT_WAVE_TICK]!,
      waveCount: g[G_WAVE_COUNT]!,
      aliens: snap.aliens.count,
      preview: g[G_RESEARCH_DONE]! & (1 << RESEARCH_INDEX.scanners!) ? 2 : 1,
      sandbox: SCENARIO_NAMES[g[G_SCENARIO]!] === 'sandbox',
    });
    timeControls.update({
      paused: runnerInfo.paused,
      speed: runnerInfo.speed,
      canCall: g[G_NEXT_WAVE]! < g[G_WAVE_COUNT]! && g[G_OUTCOME] === 0,
      checkpoints: runnerInfo.checkpoints.length,
      time: snap.tick,
      bonus: [g[G_BONUS_MASS]!, g[G_BONUS_ENERGY]!],
    });
    research.update({
      done: g[G_RESEARCH_DONE]!,
      queued: g[G_RESEARCH_QUEUED]!,
      current: g[G_RESEARCH_CURRENT]!,
      progress: g[G_RESEARCH_PROGRESS]!,
      rate: g[G_RESEARCH_RATE]!,
      pool: [g[G_MASS]!, g[G_ENERGY]!, g[G_RARE]!],
    });
    const cps = runnerInfo.checkpoints;
    endScreen.update({
      outcome: g[G_OUTCOME]!,
      endTick: g[G_END_TICK]!,
      wave: g[G_NEXT_WAVE]!,
      waveCount: g[G_WAVE_COUNT]!,
      kills: g[G_KILLS]!,
      buildingsLost: g[G_BUILDINGS_LOST]!,
      unitsLost: g[G_UNITS_LOST]!,
      canRewind: cps.length > 0,
      rewindWave: cps.length ? cps[cps.length - 1]!.wave : 0,
    });
    const builders = selectedBuilders().length > 0;
    const active = buildMode ? BUILDING_KINDS[buildMode.kind]! : upgradeMode ? 'upgrade' : null;
    const hint = buildMode
      ? `Placing ${buildingInfo(buildMode.kind).label}${isBelt(buildMode.kind) ? ' — drag for a line, R rotates' : ''}. Esc cancels.`
      : upgradeMode
        ? 'Click a wall or turret to upgrade it (tiers need research).'
        : builders
          ? ''
          : 'Select the commander or an engineer to build.';
    const hasCommander = selection.some((p) => p.type === 'unit' && p.kind === U.commander);
    bar.update(builders, selectedEngineers().length > 0, hasCommander, active, hint, lockedBy);
  }
}
requestAnimationFrame(frame);

/** Objects per detail level last frame (model view: full, middle, simple, icon; greybox: W13's three). */
function lodCounts(): { full: number; middle?: number; simple: number; icon: number; culled: number } {
  return view.models ? { ...view.models.counts } : { ...entities.counts };
}

function entityCounts(s: Snapshot | null) {
  return {
    buildings: s?.buildings.count ?? 0,
    aliens: s?.aliens.count ?? 0,
    units: s?.units.count ?? 0,
    wrecks: s?.wrecks.count ?? 0,
    projectiles: s?.projectiles.count ?? 0,
  };
}

// ---- debug hook ----------------------------------------------------------------------------

type EntityType = 'building' | 'unit' | 'alien' | 'wreck';

function screenOf(type: EntityType, id: number): { x: number; y: number } | null {
  const s = interp.curr;
  if (!s) return null;
  let x: number;
  let z: number;
  if (type === 'building') {
    const r = buildingRow(id);
    if (r < 0) return null;
    x = s.buildings.cols.tx[r]! + s.buildings.cols.fw[r]! / 2;
    z = s.buildings.cols.ty[r]! + s.buildings.cols.fh[r]! / 2;
  } else if (type === 'wreck') {
    const r = Array.prototype.indexOf.call(s.wrecks.id, id);
    if (r < 0) return null;
    x = s.wrecks.cols.x[r]!;
    z = s.wrecks.cols.z[r]!;
  } else {
    const v = type === 'unit' ? interp.units : interp.aliens;
    const r = Array.prototype.indexOf.call(v.id.subarray(0, v.count), id);
    if (r < 0) return null;
    x = v.x[r]!;
    z = v.z[r]!;
  }
  return worldToScreen(x, z);
}

function worldToScreen(x: number, z: number) {
  const p = camera.position.clone().set(x, groundHeight(terrain, x, z), z).project(camera);
  return { x: ((p.x + 1) / 2) * vw, y: ((1 - p.y) / 2) * vh };
}

function list(type: EntityType) {
  const s = interp.curr;
  if (!s) return [];
  if (type === 'building') {
    const b = s.buildings;
    return Array.from({ length: b.count }, (_, r) => ({
      id: b.id[r]!,
      kind: b.cols.kind[r]!,
      kindName: BUILDING_KINDS[b.cols.kind[r]!],
      tx: b.cols.tx[r]!,
      ty: b.cols.ty[r]!,
      fw: b.cols.fw[r]!,
      fh: b.cols.fh[r]!,
      dir: b.cols.dir[r]!,
      state: constructionState(b.cols.flags[r]!),
      complete: (b.cols.flags[r]! & BF_COMPLETE) !== 0,
      progress: b.cols.progress[r]!,
      hp: b.cols.hp[r]!,
      tier: b.cols.tier[r]!,
      item: b.cols.item[r]!,
      stock: b.cols.stock[r]!,
      inBuf: b.cols.inBuf[r]!,
    }));
  }
  if (type === 'wreck') {
    const w = s.wrecks;
    return Array.from({ length: w.count }, (_, r) => ({
      id: w.id[r]!,
      kind: w.cols.kind[r]!,
      kindName: w.cols.kind[r] === WRECK_COMMANDER ? 'commander' : ALIEN_KINDS[w.cols.kind[r]!],
      x: w.cols.x[r]!,
      z: w.cols.z[r]!,
      salvage: w.cols.salvage[r]!,
    }));
  }
  const v = type === 'unit' ? interp.units : interp.aliens;
  const sec = type === 'unit' ? s.units : s.aliens;
  return Array.from({ length: v.count }, (_, r) => ({
    id: v.id[r]!,
    kind: v.kind[r]!,
    kindName: type === 'unit' ? UNIT_KINDS[v.kind[r]!] : ALIEN_KINDS[v.kind[r]!],
    x: v.x[r]!,
    z: v.z[r]!,
    hp: sec.cols.hp[r]!,
    state: sec.cols.state[r]!,
  }));
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const allUnitIds = () => Array.from(interp.units.id.subarray(0, interp.units.count));
const entryIndex = (e: string | number | undefined) => entryIndexOf(terrain.entries, e);

const game = {
  get ready() {
    return interp.curr !== null && frames > 2;
  },
  /** The scenario of the running world (from the snapshot: a loaded save brings its own). */
  get scenario() {
    const g = interp.curr?.globals;
    return g ? SCENARIO_NAMES[g[G_SCENARIO]!] : scenario;
  },
  /** The scenario asked for in the URL. */
  get urlScenario() {
    return scenario;
  },
  get tick() {
    return interp.curr?.tick ?? 0;
  },
  get entityCounts() {
    return entityCounts(interp.curr);
  },
  get lastTickMs() {
    return lastTickMs;
  },
  /** Median worker tick time (step + encode) over the last 100 ticks. */
  get medianTickMs() {
    return median(tickSamples);
  },
  /** Slowest worker tick (step + encode) among the last 100. */
  get maxTickMs() {
    return tickSamples.length ? Math.max(...tickSamples) : 0;
  },
  get tickSamples() {
    return tickSamples.length;
  },
  get drawCalls() {
    return drawCalls;
  },
  get lodLevelCounts() {
    return lodCounts();
  },
  get fps() {
    return frameTimes.length;
  },
  /** Median main-thread time per frame (interpolate, fill instances, submit draw calls) over 120 frames. */
  get frameCpuMs() {
    return median(frameCpu);
  },
  get renderer() {
    return adapter.describe();
  },
  get errors() {
    return consoleErrors;
  },
  get selected() {
    return selection.map(describe);
  },
  get pool() {
    const g = interp.curr?.globals;
    if (!g) return null;
    const names = ['mass', 'energy', 'rare'] as const;
    return {
      mass: g[G_MASS]!,
      energy: g[G_ENERGY]!,
      rare: g[G_RARE]!,
      income: { mass: g[G_INCOME]!, energy: g[G_INCOME + 1]!, rare: g[G_INCOME + 2]! },
      spend: { mass: g[G_SPEND]!, energy: g[G_SPEND + 1]!, rare: g[G_SPEND + 2]! },
      short: names.filter((_, k) => (g[G_SHORT]! & (1 << k)) !== 0),
      upkeep: g[G_UPKEEP]!,
    };
  },
  get parts() {
    return interp.curr?.globals[G_PARTS] ?? 0;
  },
  get commanderHp() {
    return interp.curr?.globals[G_COMMANDER_HP] ?? 0;
  },
  /** Sandbox: commanders lost so far, and the tick the next one appears (-1 when none is due). */
  get commanderRespawn() {
    const g = interp.curr?.globals;
    return g ? { deaths: g[G_COMMANDER_DEATHS]!, dueTick: g[G_RESPAWN_TICK]! } : null;
  },
  get unlimited() {
    return (interp.curr?.globals[G_UNLIMITED] ?? 0) === 1;
  },
  /** Wall runs in the run table: id, tiles, tiles complete, tiles skipped when laid. */
  get runs() {
    const s = interp.curr;
    if (!s) return [];
    const out = [];
    for (let i = 0; i < s.runs.length; i += 4) if (s.runs[i]! > 0) out.push({ id: s.runs[i]!, tiles: s.runs[i + 1]!, complete: s.runs[i + 2]!, skipped: s.runs[i + 3]! });
    if (out.length !== (s.globals[G_RUNS] ?? 0)) throw new Error('run table and run count disagree');
    return out;
  },
  /** Sandbox multipliers that differ from 1, by target, kind and field. */
  get tuning() {
    const t = interp.curr?.tuning;
    if (!t) return null;
    const out: Array<{ target: TuneTarget; kind: string; field: string; mult: number }> = [];
    for (const target of TUNE_TARGETS) {
      TUNE_KINDS[target].forEach((kind, k) =>
        TUNE_FIELDS[target].forEach((field, f) => {
          const m = t[target][tuneIndex(target, k, f)]!;
          if (m !== 1) out.push({ target, kind, field, mult: m });
        }),
      );
    }
    return out;
  },
  /** Recent sandbox spawn origins and the predicted route from each. */
  get originRoutes() {
    const s = interp.curr;
    if (!s) return [];
    return s.originRoutes.map((r) => ({ x: r.x, z: r.z, kind: ALIEN_KINDS[r.kind], category: CATEGORY_NAMES[r.category], length: r.cells.length, cells: Array.from(r.cells) }));
  },
  /**
   * W24: per-kind combat counters (per shooter kind: shots, hit points removed, kills; per alien
   * kind: spawned, killed, hit points removed from walls and gates, other buildings, units, and
   * absorbed by shields), with the W13 totals (`counters`: kills, salvage, parts) alongside.
   * Before W24 `stats` was a getter holding the W13 totals; they are now `counters` and in here.
   */
  stats: () => (interp.curr ? { ...game.counters!, ...statsReport(interp.curr.stats) } : null),
  get outcome() {
    const o = interp.curr?.globals[G_OUTCOME];
    return o === 2 ? 'won' : o === 1 ? 'lost' : 'playing';
  },
  get alienCounts() {
    const out: Record<string, number> = Object.fromEntries(ALIEN_KINDS.map((k) => [k, 0]));
    const s = interp.curr;
    if (s) for (let r = 0; r < s.aliens.count; r++) out[ALIEN_KINDS[s.aliens.cols.kind[r]!]!]!++;
    return out;
  },
  get pendingSpawns() {
    return interp.curr?.globals[G_PENDING_SPAWNS] ?? 0;
  },
  get counters() {
    const g = interp.curr?.globals;
    if (!g) return null;
    return {
      kills: g[G_KILLS]!,
      salvageFromKills: g[G_SALVAGE_KILLS]!,
      salvageReclaimed: g[G_RECLAIMED]!,
      salvageDelivered: g[G_DELIVERED]!,
      partsMade: g[G_PARTS_MADE]!,
      partsUsed: g[G_PARTS_USED]!,
      fieldBuilds: g[G_FIELD_BUILDS]!,
    };
  },
  /** Construction sites and upgrades under way. */
  get buildQueue() {
    const s = interp.curr;
    if (!s) return [];
    const c = s.buildings.cols;
    const out = [];
    for (let r = 0; r < s.buildings.count; r++) {
      const upgrading = (c.flags[r]! & BF_UPGRADING) !== 0;
      if (c.flags[r]! & BF_COMPLETE && !upgrading) continue;
      out.push({
        id: s.buildings.id[r]!,
        kind: BUILDING_KINDS[c.kind[r]!],
        tx: c.tx[r]!,
        ty: c.ty[r]!,
        upgrading,
        progress: c.progress[r]!,
        builders: c.builders[r]!,
        supply: c.eff[r]! / 255,
      });
    }
    return out;
  },
  /** Predicted routes: per entry and target category, the tiles from the entry to the goal. */
  get routes() {
    const s = interp.curr;
    if (!s) return [];
    return s.routes.map((r) => {
      const last = r.cells[r.cells.length - 1] ?? 0;
      return {
        entry: terrain.entries[r.entry]?.name,
        category: CATEGORY_NAMES[r.category],
        length: r.cells.length,
        end: { x: (last % terrain.w) + 0.5, z: Math.floor(last / terrain.w) + 0.5 },
        cells: Array.from(r.cells),
      };
    });
  },
  get ghost() {
    return ghost.state ? { ...ghost.state, kindName: BUILDING_KINDS[ghost.state.kind] } : null;
  },
  get buildMode() {
    return buildMode ? BUILDING_KINDS[buildMode.kind] : upgradeMode ? 'upgrade' : null;
  },
  selectAt: (x: number, y: number) => selectAt(x, y),
  get speed() {
    return runnerInfo.speed;
  },
  get paused() {
    return runnerInfo.paused;
  },
  get checkpoints() {
    return runnerInfo.checkpoints.map((c) => ({ ...c }));
  },
  /** Next wave (1-based), ticks until it arrives, and the bonus paid so far for calling waves early. */
  get wave() {
    const g = interp.curr?.globals;
    if (!g) return null;
    return {
      next: g[G_NEXT_WAVE]! + 1,
      of: g[G_WAVE_COUNT]!,
      startsAtTick: g[G_NEXT_WAVE_TICK]!,
      ticksToGo: g[G_NEXT_WAVE_TICK]! >= 0 ? g[G_NEXT_WAVE_TICK]! - (interp.curr?.tick ?? 0) : -1,
      skippedTicks: g[G_SKIPPED_TICKS]!,
      bonus: { mass: g[G_BONUS_MASS]!, energy: g[G_BONUS_ENERGY]! },
    };
  },
  get research() {
    const g = interp.curr?.globals;
    if (!g) return null;
    const done = g[G_RESEARCH_DONE]!;
    return {
      done: RESEARCH.filter((_, i) => done & (1 << i)).map((n) => n.id),
      current: g[G_RESEARCH_CURRENT]! >= 0 ? RESEARCH[g[G_RESEARCH_CURRENT]!]!.id : null,
      progress: g[G_RESEARCH_PROGRESS]!,
      queued: RESEARCH.filter((_, i) => g[G_RESEARCH_QUEUED]! & (1 << i)).map((n) => n.id),
      rpPerSecond: g[G_RESEARCH_RATE]!,
      panelOpen: research.open,
    };
  },
  get endState() {
    const g = interp.curr?.globals;
    if (!g) return null;
    return { outcome: g[G_OUTCOME] === 2 ? 'won' : g[G_OUTCOME] === 1 ? 'lost' : 'playing', endTick: g[G_END_TICK]!, buildingsLost: g[G_BUILDINGS_LOST]!, unitsLost: g[G_UNITS_LOST]! };
  },
  /** Commands the worker refused, with the reason (most recent last). */
  get rejected() {
    return rejected.map((r) => ({ ...r }));
  },
  get notices() {
    return [...notices];
  },
  get lastSave() {
    return lastSave ? { ...lastSave } : null;
  },
  /** Time and save controls, for tests (the same calls the buttons and keys make). */
  control: {
    pause: () => togglePause(),
    speed: (s: number) => setSpeed(s),
    rewind: () => rewind(),
    save: () => exportSave(false),
    /** Loads the bytes of the last save made with save() (or export). */
    loadLastSave: async () => {
      if (!savedBlobUrl) throw new Error('no save made yet');
      await importSave(await (await fetch(savedBlobUrl)).arrayBuffer());
    },
    loadBytes: (bytes: ArrayBuffer) => importSave(bytes),
  },
  /** Test helpers: issue commands without the mouse. `ids` defaults to every commander and engineer. */
  cmd: {
    build: (kind: string | number, tx: number, ty: number, opts: { dir?: number; ids?: number[]; queue?: boolean } = {}) =>
      command({ t: 'build', ids: opts.ids ?? allUnitIds(), kind: buildingKindIndex(kind), tx, ty, dir: opts.dir ?? 0, queue: opts.queue ?? true }),
    move: (ids: number[] | null, x: number, z: number) => command({ t: 'move', ids: ids ?? allUnitIds(), x, z }),
    reclaim: (ids: number[] | null, wreck: number) =>
      command({ t: 'reclaim', ids: ids ?? allUnitIds().filter((id) => interp.units.kind[Array.prototype.indexOf.call(interp.units.id, id)] === U.engineer), wreck }),
    assist: (ids: number[] | null, target: number) => command({ t: 'assist', ids: ids ?? allUnitIds(), target }),
    upgrade: (ids: number[] | null, target: number) => command({ t: 'upgrade', ids: ids ?? allUnitIds(), target }),
    dropTurret: (id: number) => command({ t: 'dropTurret', id }),
    research: (node: string) => command({ t: 'research', node: researchNodeId(node) }),
    produce: () => command({ t: 'produce', id: interp.curr?.globals[G_COMMANDER_ID] ?? -1, queue: true }),
    callWave: () => callEarly(),
    stop: (ids: number[] | null) => command({ t: 'stop', ids: ids ?? allUnitIds() }),
    spawn: (kind: string | number, entry?: string | number, count?: number) => {
      const k = alienKindIndex(kind);
      command({ t: 'spawn', kind: k, entry: entryIndex(entry), count: count ?? TEST_GROUP[ALIEN_KINDS[k]!]! });
    },
  },
  // ---- W24: wall runs, gates and the sandbox commands. Each sends one command and resolves with
  // { ok: true, tick, detail? } once it has been applied at its tick, or { ok: false, reason } if it
  // was refused when sent or at its tick (while paused, it resolves after resuming).
  /** Debug (W24 run 2a fixtures): places a complete building at once, as the simulation's `place` command. */
  place: (kind: string | number, tx: number, ty: number, dir = 0) => commandResult({ t: 'place', kind: buildingKindIndex(kind), tx, ty, dir }),
  buildRun: (from: [number, number], to: [number, number], depth = 1, opts: { ids?: number[]; queue?: boolean } = {}) =>
    commandResult({ t: 'buildRun', ids: opts.ids ?? allUnitIds(), from, to, depth, queue: opts.queue ?? false }),
  cancelRun: (run: number) => commandResult({ t: 'cancelRun', run }),
  gate: (tx: number, ty: number, opts: { ids?: number[]; axis?: 'x' | 'z'; queue?: boolean } = {}) =>
    commandResult({ t: 'gate', ids: opts.ids ?? allUnitIds(), tx, ty, axis: opts.axis, queue: opts.queue ?? false }),
  spawnAt: (kind: string | number, x: number, z: number, count = 1) => commandResult({ t: 'spawnAt', kind: alienKindIndex(kind), x, z, count }),
  tune: (target: TuneTarget, kind: string | number, field: string, mult: number) =>
    commandResult({ t: 'tune', target, kind: tuneKindIndex(target, kind), field, mult }),
  tuneReset: (target?: TuneTarget, kind?: string | number) =>
    commandResult({ t: 'tuneReset', target, kind: target !== undefined && kind !== undefined ? tuneKindIndex(target, kind) : undefined }),
  setUnlimited: (on: boolean) => commandResult({ t: 'setUnlimited', on }),
  grantResearch: (node: string) => commandResult(node === 'all' ? { t: 'grantResearch', all: true } : { t: 'grantResearch', node: researchNodeId(node) }),
  startWave: (index: number) => commandResult({ t: 'startWave', index }),
  clearAliens: () => commandResult({ t: 'clearAliens' }),
  clearWrecks: () => commandResult({ t: 'clearWrecks' }),
  resetStats: () => commandResult({ t: 'resetStats' }),
  resetSandbox: (full = false) => commandResult({ t: 'resetSandbox', full }),
  // ---- W24 run 2a: renderer
  /** 'models' (default) or 'greybox' (?greybox=1). */
  renderMode,
  get quality(): Quality {
    return adapter.quality;
  },
  setQuality: (q: Quality) => {
    adapter.setQuality(q);
    return adapter.quality;
  },
  /** Drawing buffer size and pixel ratio. */
  get viewport() {
    return { css: [vw, vh], buffer: [adapter.canvas.width, adapter.canvas.height], pixelRatio: adapter.renderer.getPixelRatio() };
  },
  /** CPU ms of the last frame: scene update, then each render pass (composer passes, or 'scene'). */
  get timing() {
    return { updateMs, renderMs: adapter.timing.renderMs, passes: { ...adapter.timing.passes } };
  },
  /** Wall topology rebuilds so far (layout key changes); null in the greybox view. */
  get wallRebuilds() {
    return view.models?.walls.rebuilds ?? null;
  },
  /** A batch dropped an instance past its capacity (model view and overlays). */
  get overflowed() {
    return (view.models?.overflowed ?? false) || entities.overflowed;
  },
  /**
   * Scene inspection (render/inspect.ts): per kind, what the scene graph actually holds on that
   * kind's entities — model and icon instances, greybox instances, mesh and material names, and how
   * many of the kind's entities got a model or icon.
   */
  inspect: () => {
    const s = interp.curr;
    if (!s) return null;
    return inspectScene(scene, entitiesOf(s, interp.aliens, interp.units));
  },
  /**
   * GPU+CPU cost by forced-completion timing (render/cost.ts): blocks of `frames` renders of each
   * configuration (the ground, the post stack and each post pass on and off), in 7 interleaved
   * rounds, medians. Pauses the frame loop while it runs (about 10 s).
   */
  renderCost: (frames = 15) => measureRenderCost(adapter, view, camera, frames, (on) => (costRunning = on)),
  camera: {
    get: (): Rig => ({ ...rig }),
    set: (r: Partial<Rig>) => {
      orbit.stop();
      Object.assign(rig, r);
      applyCamera();
      return { ...rig };
    },
    view: (name: keyof typeof VIEWS) => {
      setView(name);
      return { ...rig };
    },
  },
  screenOf,
  worldToScreen,
  list,
};

declare global {
  interface Window {
    __game: typeof game;
  }
}
Object.defineProperty(window, '__game', { value: Object.freeze(game), writable: false });
