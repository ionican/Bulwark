// Render thread: owns the canvas, camera, input and HUD. The simulation lives in the worker; this
// thread only receives snapshots, interpolates them and sends commands back.
//
// URL parameters: ?stress=1 (stress scene), ?sandbox=1 (W24 mechanics sandbox), ?seed=<n>
// (simulation seed, default 1), ?rich=1 (debug: start with 1,000,000 of each resource),
// ?quality=high (default medium). W24 run 3 removed the second renderer and its URL switch.
// The scenario shown is the one in the snapshot: loading a save switches to the save's scenario.

import { Box3, InstancedMesh, Matrix4, Mesh, PerspectiveCamera, Vector3, type Material } from 'three';
import { createRenderer, type Quality } from './render/adapter.ts';
import { measureRenderCost } from './render/cost.ts';
import { Orbit, applyRig, clampRig, pitchFor, worldPerPixel, type Rig } from './render/cameraRig.ts';
import { Gestures } from './input.ts';
import { Ghost } from './render/ghost.ts';
import { DASH_NAMES, QUEUE_MAX_INSTANCES, QueueOverlay, canvasLabel, inspectQueue } from './render/queueView.ts';
import { WaitOverlay, canvasWaitMark, inspectWaiting } from './render/waitView.ts';
import { siteReadout, type SiteReadout } from './render/siteReadout.ts';
import { SiteHover } from './ui/siteHover.ts';
import { waitingCounts, waitingState } from './render/waiting.ts';
import { DragPreview, inspectDrag } from './render/dragPreview.ts';
import { DragPlanCache, beltLineTiles, dragLabel, snapshotSiteSource, type DragPlan, type DragView } from './dragPlan.ts';
import { Tools, gateCommand, runCommand, spawnAtCommand, toolLabel, type ToolName } from './tools.ts';
import { SandboxPanel, debugSpawnVisible, multToSlider } from './ui/sandboxPanel.ts';
import { OVERLAY_NAMES, hideOverlay, overlayMeshes, setOverlayDepthTest } from './render/debugRender.ts';
import { RouteView } from './render/routeView.ts';
import { WorkerWindow } from './workerWindow.ts';
import { ownReservedSite } from './sim/queue.ts';
import { footprintRange, groundHeight } from './render/ground.ts';
import { INSPECT_FRAME, drawnMeshes, entitiesOf, inspectScene, submissionFloor, type InspectFrame } from './render/inspect.ts';
import { LOD_THRESHOLDS } from './render/lod.ts';
import { Interpolator, type MobileView } from './render/interp.ts';
import { maxStepPerTick } from './mobileStep.ts';
import { boxSelect, buildOccupancy, buildingAtScreen, pickScreen, screenToGround, type GroundHit, type Pick, type PickView } from './render/picking.ts';
import { createView, NO_WARMUP, type WarmupReport } from './render/view.ts';
import { inspectPreview } from './render/preview.ts';
import { EffectClock } from './render/anim.ts';
import { idleUnits, nextIdle, type IdleUnits } from './render/idle.ts';
import { IdleColumn, type IdleType } from './ui/idleColumn.ts';
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
import { BF_COMPLETE, BF_UPGRADING, Q_BUILD, Q_MOVE, Q_PRODUCE, Q_RECLAIM, Q_RUN, constructionState, isReserved } from './sim/schema.ts';
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
  queueOf,
  type QueueItem,
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
import { QueuePanel, type QueuePanelUnit } from './ui/queuePanel.ts';

// ---- setup ---------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const scenario: ScenarioName = params.get('stress') === '1' ? 'stress' : params.get('sandbox') === '1' ? 'sandbox' : 'map1';
const seed = (Number(params.get('seed') ?? '1') || 1) >>> 0;

const terrain = map1Terrain();
const adapter = createRenderer(params.get('quality') === 'high' ? 'high' : 'medium');
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
const scene = view.scene;
const entities = view.entities;
// W27: with the model renderer, the placement previews are wireframes of the real models
const ghost = new Ghost(scene, terrain, view.models);
const queueView = new QueueOverlay(scene, terrain, canvasLabel());
// W25b: hourglass markers on sites (and labels on builders) waiting for a short resource.
const waitView = new WaitOverlay(scene, terrain, canvasWaitMark());
// W28: the construction hover readout (render/siteReadout.ts) in a panel by the cursor (ui/siteHover.ts)
const siteHover = new SiteHover();
/** The readout shown, the tick of the snapshot it was worked out on, and whether the previous snapshot is of the same world. */
let siteShown: { readout: SiteReadout; tick: number } | null = null;
let samePrevWorld = false;
let lastRunnerWorld = -1;
const dragPreview = new DragPreview(scene, terrain, view.models);
// W24 run 3: the sandbox panel's "Show routes" (off by default)
const routeView = new RouteView(scene, terrain);
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

// W24 run 2b: one complete frame through the full composer behind the loading screen, so the first
// visible frames do not stall compiling programs (render/view.ts warmUp). `?warmup=0` turns it off.
const warmupOn = params.get('warmup') !== '0';
let warmup: Readonly<WarmupReport> = NO_WARMUP;
if (warmupOn) {
  loading.textContent = 'Preparing the renderer…';
  warmup = await view.warmUp();
}
loading.remove();
/** Startup: ms from navigation start to the first visible frame, and the longest frame in the 10 s after it. */
const startup = { loadingMs: -1, longestFrameMs: 0, windowDone: false, frames: 0 };
/**
 * `__game.inspectNextFrame()` callers. The scene is inspected inside the next frame straight after
 * the scene update, and the answer goes out after that frame is rendered, with the frame's record
 * (render/inspect.ts InspectFrame: tick, pause state, scene-pass submissions and their floor).
 */
type Inspected = ReturnType<typeof inspectScene> & { [INSPECT_FRAME]?: InspectFrame };
/** __game.hideModelMaterials: the entity groups whose materials it hides, and each hidden material's own setting. */
const MODEL_GROUPS = new Set(['building', 'unit', 'alien', 'wreck']);
const hiddenMaterials = new Map<Material, boolean>();
let inspectWaiters: Array<(r: Inspected) => void> = [];
let inspectPending: { rep: ReturnType<typeof inspectScene>; tick: number; waiters: Array<(r: Inspected) => void> } | null = null;
/** The effect clock (render/anim.ts): frame time × speed, 0 while paused, reset on a new world. */
const effectClock = new EffectClock();

// ---- worker --------------------------------------------------------------------------------

const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (msg: ToWorker, transfer: Transferable[] = []) => worker.postMessage(msg, transfer);
const interp = new Interpolator(CAPACITY, { maxStepPerTick });
const occupancy = new Int32Array(terrain.w * terrain.h);
let lastTickMs = 0;
const tickSamples: number[] = [];

let runnerInfo: RunnerInfo = { speed: 1, paused: false, world: 0, checkpoints: [] };
const rejected: Array<{ reason: string; cmd: Command }> = [];
const notices: string[] = [];
let lastSave: { bytes: number; tick: number; name: string } | null = null;
let pendingDownload = false;
let savedBlobUrl: string | null = null;

/** Commands sent with a ref, waiting for the worker's acceptance or refusal. */
type CommandResult = { ok: true; tick: number; detail?: Record<string, unknown> } | { ok: false; reason: string };
const waiting = new Map<number, (r: CommandResult) => void>();
/** Refs whose refusal the sender shows itself (the sandbox panel): no second toast here. */
const quietRefs = new Set<number>();
let nextRef = 1;
/** Commands sent to the worker so far (check-panel: input over the panel sends none). */
let commandsSent = 0;
/** W24 run 3: the benchmark's worker timing window (workerWindow.ts). */
const workerWindow = new WorkerWindow();
let commanderDeathsSeen = 0;

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const msg = ev.data;
  if (msg.type === 'rejected') {
    rejected.push({ reason: msg.reason, cmd: msg.cmd });
    if (rejected.length > 50) rejected.shift();
    // A refusal is reported, not an error: the console shows it as a warning, the toast with a cross.
    console.warn('command refused:', msg.reason, msg.cmd);
    if (msg.ref === undefined || !quietRefs.has(msg.ref)) toasts.show(`Refused: ${msg.reason}`, true);
    if (msg.ref !== undefined) {
      waiting.get(msg.ref)?.({ ok: false, reason: msg.reason });
      waiting.delete(msg.ref);
      quietRefs.delete(msg.ref);
    }
    return;
  }
  if (msg.type === 'accepted') {
    waiting.get(msg.ref)?.({ ok: true, tick: msg.tick, detail: msg.detail });
    waiting.delete(msg.ref);
    quietRefs.delete(msg.ref);
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
  const dropped = interp.push(snap, performance.now(), msg.runner.world);
  samePrevWorld = msg.runner.world === lastRunnerWorld;
  // a new world (load, reset, rewind): back to the select tool
  if (!samePrevWorld) tools.worldChanged();
  lastRunnerWorld = msg.runner.world;
  // the worker's clock, on this page's (both count from their own time origin)
  const t = msg.timing;
  workerWindow.record({ ...t, startedAt: t.startedAt - performance.timeOrigin, endedAt: t.endedAt - performance.timeOrigin });
  // W26: the idle units column follows each snapshot
  idleNow = idleUnits(snap);
  idleColumn.update(idleNow);
  if (dropped) send({ type: 'recycle', buffer: dropped.buffer }, [dropped.buffer]);
  buildOccupancy(buildingRows(snap), terrain.w, terrain.h, occupancy);
  updateSiteHover(); // W28: once per snapshot
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
  commandsSent++;
  send({ type: 'command', cmd });
}

/**
 * Sends a command and resolves with its final result: applied at its tick, or refused with the
 * reason. `quiet`: the caller shows a refusal itself (the sandbox panel), so no toast here.
 */
function commandResult(cmd: Command, quiet = false): Promise<CommandResult> {
  const ref = nextRef++;
  commandsSent++;
  if (quiet) quietRefs.add(ref);
  return new Promise((resolve) => {
    waiting.set(ref, resolve);
    send({ type: 'command', cmd, ref });
  });
}

function buildingRows(s: Snapshot) {
  const c = s.buildings.cols;
  return { count: s.buildings.count, id: s.buildings.id, kind: c.kind, tx: c.tx, ty: c.ty, fw: c.fw, fh: c.fh, flags: c.flags, progress: c.progress, tier: c.tier, dir: c.dir };
}
/** C1: a building's pick volume is as tall as the renderer's construction cut span. */
const buildingHeight = (kind: number, tier: number) => view.models.buildHeight(kind, tier);

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
    buildingHeight,
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

// ---- W26: idle units column ----------------------------------------------------------------

let idleNow: IdleUnits = { commander: [], engineer: [] };
/** The unit each type's last click went to (the click cycles in id order from it). */
const idleLast: Record<IdleType, number | null> = { commander: null, engineer: null };
// Shift from the click or from the keyboard (agent-browser's mouse events carry no modifiers; as W25)
const idleColumn = new IdleColumn({ pick: (type, all) => pickIdle(type, all || shiftHeld) });

/** Click: the next idle unit of `type`, selected, the camera centred on it (zoom and elevation kept). Shift: all of them. */
function pickIdle(type: IdleType, all: boolean): number[] {
  const ids = idleNow[type];
  if (ids.length === 0) return [];
  const kind = type === 'commander' ? U.commander : U.engineer;
  if (all) {
    setSelection(ids.map((id) => ({ type: 'unit' as const, id, kind })));
    return [...ids];
  }
  const id = nextIdle(ids, idleLast[type])!;
  idleLast[type] = id;
  setSelection([{ type: 'unit', id, kind }]);
  const r = Array.prototype.indexOf.call(interp.units.id.subarray(0, interp.units.count), id) as number;
  if (r >= 0) {
    orbit.stop();
    rig.x = interp.units.x[r]!;
    rig.z = interp.units.z[r]!;
    applyCamera();
  }
  return [id];
}

// ---- build tools ---------------------------------------------------------------------------

/** The scenario of the running world (the snapshot's; a loaded save brings its own). */
function currentScenario(): string {
  const g = interp.curr?.globals;
  return g ? (SCENARIO_NAMES[g[G_SCENARIO]!] ?? scenario) : scenario;
}
/**
 * W24 run 3: the one active map tool (tools.ts). Gate and spawn are sandbox-only. Choosing a tool
 * ends the previous one; Escape or right click cancels it; a world change returns to select.
 */
const tools = new Tools((name) => (name !== 'gate' && name !== 'spawn') || currentScenario() === 'sandbox');
/** The build tool's rotation (R), kept across tools as before. */
let buildDir = 0;
const buildModeNow = { kind: -1, dir: 0 };
/** The build or wall tool's kind and rotation, or null (the shape main.ts used before run 3). */
function buildTool(): { kind: number; dir: number } | null {
  if (tools.name !== 'build' && tools.name !== 'wall') return null;
  buildModeNow.kind = tools.kind;
  buildModeNow.dir = buildDir;
  return buildModeNow;
}
/**
 * Shift held, from the keyboard. A pointer event's own shiftKey is used too; this also covers input
 * whose pointer events carry no modifiers (agent-browser's mouse with its keydown Shift).
 */
let shiftHeld = false;

/** The build bar or a key picks a building kind (null: back to select). Needs builders selected. */
function setBuildMode(kind: BuildingKind | null) {
  if (kind === null || !selectedBuilders().length) {
    // as before run 3: the build and upgrade tools close (an armed gate or spawn tool stays)
    if (buildTool() || tools.name === 'upgrade') tools.choose('select');
    ghost.hide();
    return;
  }
  tools.choose('build', B[kind]);
}

/** Arms the gate or spawn tool (the sandbox panel's buttons); false outside the sandbox. */
function armTool(name: ToolName): boolean {
  const ok = tools.choose(name);
  if (ok) ghost.hide();
  return ok;
}

/** Footprint origin under a ground point, centred on the cursor. */
function footprintAt(kind: number, gx: number, gz: number): [number, number] {
  const [fw, fh] = buildingFootprint(kind);
  return [fw === 1 ? Math.floor(gx) : Math.round(gx - fw / 2), fh === 1 ? Math.floor(gz) : Math.round(gz - fh / 2)];
}

/**
 * True when (kind, tx, ty, dir) can be ordered now: the tiles are free, or (C2) it is exactly a
 * reserved site the builders hold themselves and the order is unshifted (queue.ts ownReservedSite).
 * `builders` is called only for that second test.
 */
function placeable(kind: number, tx: number, ty: number, dir: number, queue: boolean, builders: () => number[]): boolean {
  if (canPlaceOn(terrain, occupancy, kind, tx, ty)) return true;
  const s = interp.curr;
  if (!s || queue) return false;
  const ids = builders();
  return ids.length > 0 && ownReservedSite(snapshotSiteSource(s, occupancy), ids, kind, tx, ty, dir, false) >= 0;
}

function placeBuild(kind: number, tx: number, ty: number, dir: number, queue: boolean): boolean {
  const ids = selectedBuilders();
  if (!ids.length || !placeable(kind, tx, ty, dir, queue, () => ids)) return false;
  command({ t: 'build', ids, kind, tx, ty, dir, queue });
  // Mark the tiles at once so a quick second click does not double-book them.
  const [fw, fh] = buildingFootprint(kind);
  for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) occupancy[(ty + j) * terrain.w + tx + i] = -1;
  return true;
}

/** A belt line (dragPlan.ts beltLineTiles, the tiles the drag preview shows): the first piece placed takes `queue`, the rest append. */
function placeBeltLine(kind: number, x0: number, z0: number, x1: number, z1: number, dirIfSingle: number, queue: boolean) {
  let first = true;
  for (const [x, z, dir] of beltLineTiles(x0, z0, x1, z1, dirIfSingle)) if (placeBuild(kind, x, z, dir, queue || !first)) first = false;
}

// ---- W25 item 7: live preview of a build-mode drag ----------------------------------------------

/**
 * The drag under way: the cursor (screen) and its end tiles, worked out on pointer moves; the plan,
 * and the inputs it was made from (kind, direction, tiles, tick), so a frame with nothing changed
 * allocates nothing.
 */
let drag: { x1: number; y1: number; from: [number, number]; to: [number, number]; shift: boolean } | null = null;
let dragPlan: DragPlan | null = null;
/** Remakes the plan only when its inputs change (tick, kind, end tiles, direction, Shift, depth). */
const dragPlans = new DragPlanCache();
/** The wall-run depth: the sandbox panel's choice while it is shown, else 1. */
const runDepth = () => (sandboxPanel.shown ? sandboxPanel.model.depth : 1);
const dragLabelEl = document.createElement('div');
dragLabelEl.className = 'pnl draglabel';
dragLabelEl.style.cssText = 'position:fixed;display:none;pointer-events:none;font-size:11px;padding:2px 6px;z-index:9';
document.body.appendChild(dragLabelEl);

/** The snapshot as the run planner reads it (dragPlan.ts DragView). */
function dragView(s: Snapshot): DragView {
  return { terrain, occupancy, kinds: s.buildings.cols.kind, units: { count: s.units.count, id: s.units.id, x: s.units.cols.x, z: s.units.cols.z }, snapshot: s };
}

/**
 * The plan for the drag now: walls and belts only (other kinds place one building on release).
 * Worked out again only when its inputs change (end tiles, tool, direction, Shift, snapshot tick).
 * Shift is the release's rule (the pointer's Shift or the keyboard's): without it the run replaces
 * the builders' queues and keeps their own wall sites it covers (W25c, dragPlan.ts).
 */
function currentDragPlan(): DragPlan | null {
  const s = interp.curr;
  const buildMode = buildTool();
  if (!drag || !buildMode || !s || !(buildMode.kind === B.wall || isBelt(buildMode.kind))) {
    dragPlan = null;
    dragPlans.clear();
    return null;
  }
  const queue = drag.shift || shiftHeld;
  const plan = dragPlans.get(s.tick, buildMode.kind, drag.from, drag.to, buildMode.dir, queue, buildMode.kind === B.wall ? runDepth() : 1, () => ({ view: dragView(s), ids: selectedBuilders() }));
  if (plan !== dragPlan) {
    dragPlan = plan;
    dragLabelEl.textContent = dragLabel(plan);
  }
  return dragPlan;
}

function updateDragPreview() {
  const plan = currentDragPlan();
  dragPreview.update(plan, performance.now() / 1000);
  if (!plan || !drag) {
    dragLabelEl.style.display = 'none';
    return;
  }
  dragLabelEl.style.display = '';
  if (dragLabelAt[0] !== drag.x1 || dragLabelAt[1] !== drag.y1) {
    dragLabelAt[0] = drag.x1;
    dragLabelAt[1] = drag.y1;
    dragLabelEl.style.left = `${Math.round(drag.x1 + 18)}px`;
    dragLabelEl.style.top = `${Math.round(drag.y1 + 14)}px`;
  }
}
const dragLabelAt = [NaN, NaN];

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
  building: () => tools.name !== 'select',
  click(button, x, y, shift) {
    if (button === 0) {
      const buildMode = buildTool();
      if (buildMode) {
        const t = tileAtScreen(x, y);
        if (t) {
          const [tx, ty] = footprintAt(buildMode.kind, t.g.x, t.g.z);
          placeBuild(buildMode.kind, tx, ty, buildMode.dir, shift);
        }
        // Belts stay selected for laying more; other buildings only while Shift is held.
        toolActed(shift);
        return;
      }
      if (tools.name === 'upgrade') {
        const view = pickView();
        const p = view ? pickScreen(camera, x, y, vw, vh, terrain, view) : null;
        const ids = selectedEngineers();
        if (p && p.type === 'building' && buildingInfo(p.kind).tiers && ids.length) command({ t: 'upgrade', ids, target: p.id, queue: shift });
        toolActed(shift);
        return;
      }
      if (tools.name === 'gate') {
        // the selected builders (all of them when none is selected); no axis: the simulation picks it
        const t = tileAtScreen(x, y);
        const ids = selectedBuilders();
        if (t) void commandResult(gateCommand(ids.length ? ids : allUnitIds(), t.tx, t.ty, shift));
        toolActed(shift);
        return;
      }
      if (tools.name === 'spawn') {
        const t = tileAtScreen(x, y);
        const m = sandboxPanel.model;
        if (t) void commandResult(spawnAtCommand(m.spawnKind, t.tx + 0.5, t.ty + 0.5, m.count));
        toolActed(shift);
        return;
      }
      selectAt(x, y, shift);
    } else if (button === 2) {
      // any tool but select: right click cancels it (select: an order, as before)
      if (tools.rightClick()) {
        ghost.hide();
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
  buildDragPreview(d) {
    const a = d && tileAtScreen(d.x0, d.y0);
    const b = d && tileAtScreen(d.x1, d.y1);
    // the same end tiles buildDrag sends on release
    drag = d && a && b ? { x1: d.x1, y1: d.y1, from: [a.tx, a.ty], to: [b.tx, b.ty], shift: d.shift } : null;
    if (!drag) dragPlan = null;
  },
  buildDrag(x0, y0, x1, y1, shift) {
    const buildMode = buildTool();
    if (!buildMode) return; // a drag with the upgrade, gate or spawn tool does nothing
    const a = tileAtScreen(x0, y0);
    const b = tileAtScreen(x1, y1);
    if (a && b) {
      if (buildMode.kind === B.wall) {
        // a wall drag lays a run (one order per builder, built tile by tile: run 1's buildRun) at the panel's depth
        const ids = selectedBuilders();
        if (ids.length) void commandResult(runCommand(ids, [a.tx, a.ty], [b.tx, b.ty], runDepth(), shift));
      } else if (isBelt(buildMode.kind)) placeBeltLine(buildMode.kind, a.tx, a.ty, b.tx, b.ty, buildMode.dir, shift);
      else {
        const [tx, ty] = footprintAt(buildMode.kind, b.g.x, b.g.z);
        placeBuild(buildMode.kind, tx, ty, buildMode.dir, shift);
      }
    }
    toolActed(shift);
  },
});
const ptr = (e: PointerEvent) => ({ button: e.button, x: e.clientX, y: e.clientY, shift: e.shiftKey || shiftHeld });
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
  updateSiteHover(true);
});
canvas.addEventListener('pointerup', (e) => {
  // a gesture started on the map and released over the sandbox panel (the canvas holds the
  // pointer) is cancelled: no command, no selection change, no preview left
  if (sandboxPanel.contains(e.clientX, e.clientY)) gestures.cancel();
  else gestures.up(ptr(e));
});
canvas.addEventListener('pointercancel', () => gestures.cancel());
canvas.addEventListener('pointerleave', () => {
  mouse = null;
  updateSiteHover();
});

/**
 * W28: the hover readout for the building site under the cursor, from the last two snapshots.
 * `moved`: the cursor moved; the panel follows it, and the figures are only worked out again when
 * the cursor reaches another building (otherwise they change once per snapshot).
 */
function updateSiteHover(moved = false): void {
  const curr = interp.curr;
  const view = mouse && curr ? pickView() : null;
  const id = view ? buildingAtScreen(camera, mouse!.x, mouse!.y, vw, vh, terrain, view) : -1;
  if (moved && id >= 0 && siteShown?.readout.id === id && siteShown.tick === curr!.tick) {
    siteHover.move(mouse!.x, mouse!.y);
    return;
  }
  const readout = id >= 0 ? siteReadout(samePrevWorld ? interp.prev : null, curr!, id) : null;
  if (!readout) {
    siteShown = null;
    siteHover.hide();
    return;
  }
  siteShown = { readout, tick: curr!.tick };
  siteHover.show(id, readout.lines, mouse!.x, mouse!.y);
}
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

/** After a left action with the tool: without Shift it returns to select (belts stay), with Shift it stays. */
function toolActed(shift: boolean) {
  tools.acted(shift);
  if (!buildTool()) ghost.hide();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') shiftHeld = true;
  // Escape first, before the editable-control filter: it cancels the tool even from the count field
  if (e.key === 'Escape') {
    // a drag under way ends with nothing queued (its release is ignored), then the tool closes
    if (gestures.buildDragging) gestures.cancel();
    if (tools.escape()) ghost.hide();
    return;
  }
  // letters and digits typed into a field or a list go to it, not to shortcuts
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const k = e.key.toLowerCase();
  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    if (!e.repeat) togglePause();
    return;
  }
  // Shift from the event or the keyboard state (agent-browser's keys carry no modifiers; as W25)
  if ((e.shiftKey || shiftHeld) && (/^Digit[123]$/.test(e.code) || /^[123]$/.test(e.key))) {
    setSpeed(/^Digit[123]$/.test(e.code) ? Number(e.code.slice(5)) : Number(e.key));
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
  if (k === 'r' && buildTool()) buildDir = (buildDir + 1) & 3;
  // a held key repeats: picking the same tool again would forget a Shift placement (W25)
  else if (KEY_TO_KIND.has(k) && !e.repeat) setBuildMode(KEY_TO_KIND.get(k)!);
  else if (k === 'u') startUpgrade();
  else if (k === 't') dropTurret();
  else if (k === 'x') stopUnits();
  keys.add(k);
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.key.toLowerCase());
  if (e.key === 'Shift') {
    shiftHeld = false;
    // Shift released after acting with it: the tool closes (belts stay, as before).
    tools.shiftReleased();
    if (!buildTool()) ghost.hide();
  }
});
window.addEventListener('blur', () => {
  keys.clear();
  shiftHeld = false;
});

function startUpgrade() {
  ghost.hide();
  tools.choose(selectedEngineers().length > 0 ? 'upgrade' : 'select');
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
/** The build bar's DEBUG spawn box: hidden while the sandbox panel is shown. */
const debugBox = document.querySelector<HTMLElement>('.dbg');

// ---- W24 run 3: the sandbox panel (ui/sandboxPanel.ts) -------------------------------------------

const sandboxPanel = new SandboxPanel({
  // the panel shows a refusal itself: no second toast from the worker message
  send: (cmd) => commandResult(cmd, true),
  toast: (text, bad) => toasts.show(text, bad),
  armTool,
});

/** The active tool in words, for the panel ("Tool: spawn rusher × 8 — click the map"). */
function toolText(): string {
  const m = sandboxPanel.model;
  return toolLabel(tools, { spawnName: ALIEN_KINDS[m.spawnKind], count: m.count, depth: runDepth(), kindName: tools.kind >= 0 ? buildingInfo(tools.kind).label : undefined });
}

// ---- W24 run 3: D1 diagnostics (__game.debugRender) ---------------------------------------------

/**
 * Renders the scene once without the post stack and reads back rect (CSS px) as luminance 0–255,
 * row by row from the top. The same scene renders to the same pixels, so two captures differ only
 * by what was changed between them (an overlay hidden).
 */
function captureRect(r: { x0: number; y0: number; x1: number; y1: number }) {
  const R = adapter.renderer;
  const dpr = R.getPixelRatio();
  const W = adapter.canvas.width;
  const H = adapter.canvas.height;
  const cl = (v: number, hi: number) => Math.max(0, Math.min(hi, Math.round(v * dpr)));
  const x0 = cl(Math.min(r.x0, r.x1), W);
  const x1 = cl(Math.max(r.x0, r.x1), W);
  const y0 = cl(Math.min(r.y0, r.y1), H);
  const y1 = cl(Math.max(r.y0, r.y1), H);
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  R.setRenderTarget(null);
  R.render(scene, camera);
  const gl = R.getContext();
  const buf = new Uint8Array(w * h * 4);
  if (w && h) gl.readPixels(x0, H - y1, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const data: number[] = new Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = ((h - 1 - y) * w + x) * 4;
      data[y * w + x] = 0.2126 * buf[i]! + 0.7152 * buf[i + 1]! + 0.0722 * buf[i + 2]!;
    }
  return { w, h, data };
}

const _corner = new Vector3();
/** Screen rectangle (CSS px) of the projected corners of boxes; null when none is in front of the camera. */
function screenRect(corners: (v: Vector3, k: number) => boolean): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; corners(_corner, k); k++) {
    _corner.project(camera);
    if (_corner.z > 1) continue;
    const x = ((_corner.x + 1) / 2) * vw;
    const y = ((1 - _corner.y) / 2) * vh;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return x0 <= x1 ? { x0, y0, x1, y1 } : null;
}

/** A building's pick volume (C1: footprint × the renderer's construction height) on screen. */
function buildingScreenBox(id: number) {
  const s = interp.curr;
  const r = buildingRow(id);
  if (!s || r < 0) return null;
  const c = s.buildings.cols;
  const tx = c.tx[r]!;
  const ty = c.ty[r]!;
  const fw = c.fw[r]!;
  const fh = c.fh[r]!;
  const g = footprintRange(terrain, tx, ty, fw, fh);
  const top = g.top + view.models.buildHeight(c.kind[r]!, c.tier[r]!);
  return screenRect((v, k) => k < 8 && !!v.set(k & 1 ? tx + fw : tx, k & 2 ? top : g.bottom, k & 4 ? ty + fh : ty));
}

const _m4 = new Matrix4();
/** The drawn instances of one overlay (by material name) on screen. */
function overlayScreenBox(name: string) {
  const boxes: Box3[] = [];
  for (const m of overlayMeshes(scene, name)) {
    if (!m.visible || !(m instanceof InstancedMesh)) continue;
    m.geometry.computeBoundingBox();
    m.updateMatrixWorld();
    for (let i = 0; i < m.count; i++) {
      m.getMatrixAt(i, _m4);
      boxes.push(m.geometry.boundingBox!.clone().applyMatrix4(_m4.premultiply(m.matrixWorld)));
    }
  }
  return screenRect((v, k) => {
    const b = boxes[k >> 3];
    if (!b) return false;
    v.set(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z);
    return true;
  });
}

// ---- W25: order queues of the selected units ---------------------------------------------------

const queuePanel = new QueuePanel({
  remove: (unit, oid) => void commandResult({ t: 'dequeue', id: unit, order: oid }),
  clear: (unit) => void commandResult({ t: 'clearQueue', ids: [unit] }),
});

/** One queue item in words. */
function queueItemText(s: Snapshot, it: QueueItem): string {
  if (it.kind === Q_MOVE) return `Move to ${it.x.toFixed(0)}, ${it.z.toFixed(0)}`;
  if (it.kind === Q_PRODUCE) return 'Produce an engineer';
  if (it.kind === Q_RECLAIM) return 'Reclaim a wreck';
  if (it.kind === Q_RUN) {
    for (let i = 0; i < s.runs.length; i += 4) if (s.runs[i] === it.run) return `Wall run: ${s.runs[i + 2]}/${s.runs[i + 1]} tiles built`;
    return 'Wall run';
  }
  if (it.kind !== Q_BUILD) return '?';
  const r = Array.prototype.indexOf.call(s.buildings.id, it.target);
  if (r < 0) return 'Build (gone)';
  const c = s.buildings.cols;
  const label = buildingInfo(c.kind[r]!).label;
  const f = c.flags[r]!;
  if (f & BF_COMPLETE) return f & BF_UPGRADING ? `Upgrade ${label} to tier ${c.tier[r]! + 1}` : `${label} (done)`;
  return isReserved(f) ? `Build ${label} (reserved)` : `Build ${label} ${(c.progress[r]! * 100).toFixed(0)}%`;
}

/** W25c queue overlay benchmark under way (runQueueBench), drawn by the frame loop in place of the selection's queues. */
let queueBench: { snap: Snapshot; units: MobileView; all: Pick[]; fewer: Pick[]; change: boolean; times: number[]; stamps: number[]; cpu: number[] } | null = null;

/**
 * W25c benchmark of the queue overlay (scripts/check-queue.mjs). `units` engineers round the base,
 * each with `orders` queued moves spread over the whole map (the seeded spread test/w25c-overlay
 * uses), are made in a world on this thread and drawn by the live overlay in place of the
 * selection's queues: `frames` frames unchanged, then `frames` frames with the selection changing
 * every frame (all of them, then all but one). Per phase: the overlay's update CPU per frame
 * (median, 95th percentile, max), the frame CPU (median) and the frame rate; and what was drawn.
 */
async function runQueueBench(nUnits: number, orders: number, frames: number, hold: boolean) {
  const [{ World }, { encodeSnapshot }] = await Promise.all([import('./sim/world.ts'), import('./sim/snapshot.ts')]);
  const w = new World(1, terrain, { waves: false });
  const ids: number[] = [];
  for (let i = 0; i < nUnits; i++) ids.push(w.spawnUnit(U.engineer, 50.5 + (i % 16) * 2, 50.5 + Math.floor(i / 16) * 2));
  let seed = 2654435761;
  const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 2 ** 32);
  for (const id of ids) for (let k = 0; k < orders; k++) w.enqueue({ t: 'move', ids: [id], x: 2.5 + rnd() * 123, z: 2.5 + rnd() * 123, queue: true });
  w.step();
  const snap = decodeSnapshot(encodeSnapshot(w));
  const u = snap.units;
  const units: MobileView = { count: u.count, id: u.id, kind: u.cols.kind, x: Float32Array.from(u.cols.x), z: Float32Array.from(u.cols.z), fx: Float32Array.from(u.cols.fx), fz: Float32Array.from(u.cols.fz) };
  const all: Pick[] = ids.map((id) => ({ type: 'unit', id, kind: U.engineer }));
  const b = { snap, units, all, fewer: all.slice(0, -1), change: false, times: [] as number[], stamps: [] as number[], cpu: [] as number[] };
  const nextFrame = () => new Promise<number>((res) => requestAnimationFrame(res));
  const stats = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    return { median: s[Math.floor(s.length / 2)] ?? 0, p95: s[Math.floor(s.length * 0.95)] ?? 0, max: s[s.length - 1] ?? 0 };
  };
  const phase = async (change: boolean) => {
    b.change = change;
    for (let i = 0; i < 5; i++) await nextFrame(); // settle (the first frame of a phase builds)
    b.times = [];
    b.stamps = [];
    b.cpu = [];
    for (let i = 0; i < frames; i++) await nextFrame();
    const span = (b.stamps[b.stamps.length - 1]! - b.stamps[0]!) / 1000;
    return { updateMs: stats(b.times), frameCpuMs: stats(b.cpu).median, fps: span > 0 ? (b.stamps.length - 1) / span : 0, frames: b.times.length };
  };
  queueBench = b;
  try {
    const still = await phase(false);
    const changing = await phase(true);
    b.change = false;
    await nextFrame();
    await nextFrame();
    const q = inspectQueue(scene);
    return { units: nUnits, orders, still, changing, drawn: { instances: q.instances, labels: q.labels.length, more: q.more, paths: q.paths.length, arrows: q.arrows }, maxInstances: QUEUE_MAX_INSTANCES };
  } finally {
    // `hold`: the synthetic queues stay drawn (unchanged) until queueBenchEnd (a screenshot)
    if (hold) b.change = false;
    else queueBench = null;
  }
}

/** The selected units' queues for the panel, in selection order (the order that picks each line's dashes). */
function selectedQueues(): QueuePanelUnit[] {
  const s = interp.curr;
  if (!s) return [];
  const out: QueuePanelUnit[] = [];
  let nth = -1;
  for (const p of selection) {
    if (p.type !== 'unit') continue;
    nth++;
    const row = Array.prototype.indexOf.call(s.units.id, p.id);
    if (row < 0) continue;
    out.push({
      id: p.id,
      name: `${UNIT_INFO[UNIT_KINDS[p.kind]!].label} ${nth + 1}`,
      lineStyle: DASH_NAMES[nth % DASH_NAMES.length]!,
      items: queueOf(s, row).map((it) => ({ text: queueItemText(s, it), oid: it.oid })),
    });
  }
  return out;
}

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
  const buildMode = buildTool();
  if (!buildMode || !mouse || dragPlan) {
    ghost.hide();
    return;
  }
  const g = screenToGround(camera, mouse.x, mouse.y, vw, vh, terrain);
  if (!g) {
    ghost.hide();
    return;
  }
  const [tx, ty] = footprintAt(buildMode.kind, g.x, g.z);
  // C2: the builders' own reserved site of exactly this kind and place shows as allowed
  const ok = placeable(buildMode.kind, tx, ty, buildMode.dir, shiftHeld, selectedBuilders);
  ghost.show(buildMode.kind, tx, ty, buildMode.dir, ok, worldPerPixel(camera, g.dist, vh), rig.yaw, performance.now() / 1000);
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

/** Startup metrics (run 2b warm-up): the first visible frame, then the longest frame interval for 10 s. */
let startupLast = 0;
function startupFrame(now: number) {
  if (startup.loadingMs < 0) {
    startup.loadingMs = now;
    startupLast = now;
    return;
  }
  if (startup.windowDone) return;
  startup.longestFrameMs = Math.max(startup.longestFrameMs, now - startupLast);
  startupLast = now;
  startup.frames++;
  if (now - startup.loadingMs >= 10000) startup.windowDone = true;
}

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
    effectClock.advance(dt, runnerInfo.speed, runnerInfo.paused, snap.tick, runnerInfo.world);
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
        time: effectClock,
      },
      rig.distance,
      (x, y, z) => worldPerPixel(camera, Math.hypot(x - camera.position.x, y - camera.position.y, z - camera.position.z), vh),
      rig.distance > LOD_THRESHOLDS[1]!,
    );
    if (inspectWaiters.length) {
      // the views and the scene are the ones about to be drawn: no snapshot can arrive in between
      inspectPending = { rep: inspectScene(scene, entitiesOf(snap, interp.aliens, interp.units)), tick: snap.tick, waiters: inspectWaiters };
      inspectWaiters = [];
    }
  }
  if (queueBench) {
    // W25c benchmark (runQueueBench): the synthetic queues in place of the selection's
    const b = queueBench;
    const t0 = performance.now();
    queueView.update({ camera, viewportHeight: vh, snapshot: b.snap, units: b.units, selection: b.change && b.stamps.length % 2 ? b.fewer : b.all });
    b.times.push(performance.now() - t0);
    b.stamps.push(now);
  } else if (snap) queueView.update({ camera, viewportHeight: vh, snapshot: snap, units: interp.units, selection });
  if (snap) waitView.update({ camera, viewportHeight: vh, snapshot: snap });
  updateDragPreview();
  updateGhost();
  // W24 run 3: a tool the scenario stopped allowing is dropped; the panel and the routes follow the snapshot
  tools.check();
  sandboxPanel.update(snap, now);
  if (sandboxPanel.shown) sandboxPanel.setTool({ name: tools.name, label: toolText() });
  routeView.update(snap, sandboxPanel.shown && sandboxPanel.model.routes);
  const dbg = debugSpawnVisible(snap) ? '' : 'none';
  if (debugBox && debugBox.style.display !== dbg) debugBox.style.display = dbg;
  updateMs = performance.now() - tUpdate;
  const floor = inspectPending ? submissionFloor(scene) : null;
  adapter.render(dt);
  drawCalls = adapter.drawCalls();
  if (inspectPending && floor) {
    const sub = adapter.timing.submitted.scene ?? { calls: drawCalls, triangles: adapter.triangles() };
    const f: InspectFrame = { tick: inspectPending.tick, paused: !!runnerInfo?.paused, calls: sub.calls, triangles: sub.triangles, floorCalls: floor.calls, floorTriangles: floor.triangles };
    const out: Inspected = Object.assign(inspectPending.rep, { [INSPECT_FRAME]: f });
    for (const w of inspectPending.waiters) w(out);
    inspectPending = null;
  }
  frames++;
  if (snap) startupFrame(now);
  frameCpu.push(performance.now() - cpu0);
  if (queueBench) queueBench.cpu.push(performance.now() - cpu0);
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
      view: `models · ${adapter.quality}`,
    });
    const g = snap.globals;
    hud.updateEconomy({
      pool: [g[G_MASS]!, g[G_ENERGY]!, g[G_RARE]!],
      income: [g[G_INCOME]!, g[G_INCOME + 1]!, g[G_INCOME + 2]!],
      spend: [g[G_SPEND]!, g[G_SPEND + 1]!, g[G_SPEND + 2]!],
      short: [0, 1, 2].map((k) => (g[G_SHORT]! & (1 << k)) !== 0),
      waiting: waitingCounts(waitView.state),
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
    queuePanel.update(selectedQueues(), hud.aboveSelection());
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
    const buildMode = buildTool();
    const active = buildMode ? BUILDING_KINDS[buildMode.kind]! : tools.name === 'upgrade' ? 'upgrade' : null;
    const hint = buildMode
      ? `Placing ${buildingInfo(buildMode.kind).label}${isBelt(buildMode.kind) ? ' — drag for a line, R rotates' : ''}. Shift queues more; Esc cancels.`
      : tools.name === 'upgrade'
        ? 'Click a wall or turret to upgrade it (tiers need research).'
        : builders
          ? ''
          : 'Select the commander or an engineer to build.';
    const hasCommander = selection.some((p) => p.type === 'unit' && p.kind === U.commander);
    bar.update(builders, selectedEngineers().length > 0, hasCommander, active, hint, lockedBy);
  }
}
requestAnimationFrame(frame);

/** Objects per detail level last frame (full, middle, simple, icon). */
function lodCounts(): { full: number; middle?: number; simple: number; icon: number; culled: number } {
  return { ...view.models.counts };
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
    const b = buildTool();
    return b ? BUILDING_KINDS[b.kind] : tools.name === 'upgrade' ? 'upgrade' : null;
  },
  /** W24 run 3: the active map tool (tools.ts), its building kind and its words in the panel. */
  get tool() {
    return { name: tools.name, kind: tools.kind >= 0 ? (BUILDING_KINDS[tools.kind] ?? null) : null, label: toolText() };
  },
  /** W24 run 3: the sandbox panel's state, and the slider position (0..1) of a multiplier. */
  get sandboxPanel() {
    const m = sandboxPanel.model;
    return { shown: sandboxPanel.shown, tick: sandboxPanel.tick, tab: m.tab, collapsed: m.collapsed, depth: m.depth, count: m.count, routes: m.routes, sliderFor: (mult: number) => multToSlider(mult) };
  },
  /** Commands sent to the worker so far. */
  get commandsSent() {
    return commandsSent;
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
  /** The view: 'models' (run 3 removed the other one). */
  get renderMode() {
    return 'models';
  },
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
  /** CPU ms of the last frame: scene update, then each composer pass. */
  get timing() {
    return { updateMs, renderMs: adapter.timing.renderMs, passes: { ...adapter.timing.passes } };
  },
  /** Wall topology rebuilds so far (layout key changes). */
  get wallRebuilds() {
    return view.models.walls.rebuilds;
  },
  /** A batch dropped an instance past its capacity (model view and overlays). */
  get overflowed() {
    return view.models.overflowed || entities.overflowed;
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
   * `inspect()` taken inside the next frame, straight after the scene update, so the drawing and the
   * entities it was drawn from match (between frames a new snapshot can re-point the interpolated
   * views to aliens spawned since, not yet drawn).
   */
  inspectNextFrame: () => new Promise<Inspected>((res) => inspectWaiters.push(res)),
  /**
   * W24 review, the gate's negative check (scripts/check-render.mjs): hides every material of every
   * mesh that draws an entity (userData.group building, unit, alien or wreck), or restores them.
   * Returns the number of meshes changed.
   */
  hideModelMaterials: (hide: boolean) => {
    let n = 0;
    scene.traverse((o) => {
      if (!(o instanceof Mesh) || !MODEL_GROUPS.has(o.userData.group)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (hide && !hiddenMaterials.has(m)) hiddenMaterials.set(m, m.visible);
        m.visible = hide ? false : (hiddenMaterials.get(m) ?? m.visible);
      }
      n++;
    });
    if (!hide) hiddenMaterials.clear();
    return n;
  },
  /**
   * GPU+CPU cost by forced-completion timing (render/cost.ts): blocks of `frames` renders of each
   * configuration (the ground, the post stack and each post pass on and off), in 7 interleaved
   * rounds, medians. Pauses the frame loop while it runs (about 10 s).
   */
  renderCost: (frames = 15) => measureRenderCost(adapter, view, camera, frames, (on) => (costRunning = on)),
  /**
   * W24 run 2b warm-up: whether it was on (`?warmup=0` turns it off) and ran, the meshes primed, ms
   * compiling and rendering the warm-up frame and its composer passes; then the startup figures:
   * ms from navigation start to the first visible frame, and the longest frame interval in the
   * 10 s after it (`windowDone` once the 10 s are over).
   */
  get warmup() {
    return { enabled: warmupOn, ...warmup, passes: [...warmup.passes], ...startup };
  },
  /**
   * W24 run 2b: what is moving on screen. Running totals of frames with a visible builder beaming,
   * a visible turret firing (flash or beam), a visible shot, a visible alien attacking, and a visible
   * gate's doors opening and closing; `now` is the last frame's flags; `effects` the effect clock.
   */
  get activity() {
    const m = view.models;
    return { ...m.activity, now: { ...m.activityNow }, clock: { t: effectClock.t, dt: effectClock.dt } };
  },
  /** W27: the wireframe previews read back from the scene (render/preview.ts inspectPreview). */
  inspectPreview: () => inspectPreview(scene),
  /** W26: the idle units by type (id order), as the column shows them. */
  get idle() {
    return { commander: [...idleNow.commander], engineer: [...idleNow.engineer] };
  },
  /** W26: the column as drawn: per type, shown or hidden and the count on the button. */
  get idleColumn() {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('.idle button')).map((b) => ({ type: b.dataset.idle, shown: b.style.display !== 'none', count: Number(b.dataset.count ?? 0) }));
  },

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
  // ---- W25: build queue
  /** Every unit's queue from the snapshot: kind name, target id, run id, position, order id. */
  get queues() {
    const s = interp.curr;
    if (!s) return [];
    const names = ['move', 'build', 'run', 'produce', 'reclaim'];
    return Array.from({ length: s.units.count }, (_, row) => ({
      id: s.units.id[row]!,
      orders: queueOf(s, row).map((it) => ({ kind: names[it.kind] ?? String(it.kind), target: it.target, run: it.run, x: it.x, z: it.z, oid: it.oid, text: queueItemText(s, it) })),
    }));
  },
  /**
   * W25 item 7: the drag preview — the plan (tiles to build, tiles skipped, label) and what the
   * scene holds for it (render/dragPreview.ts inspectDrag: outline and cross centres). Null when no
   * drag is under way.
   */
  get dragPreview() {
    if (!dragPlan || !drag) return null;
    return {
      kind: BUILDING_KINDS[dragPlan.kind],
      build: dragPlan.build.map(([x, y, dir]) => [x, y, dir]),
      skipped: dragPlan.skipped.map(([x, y]) => [x, y]),
      label: dragLabelEl.textContent,
      refused: dragPlan.refused,
      drawn: inspectDrag(scene),
    };
  },
  /** W25b: sites and builders waiting for a short resource, from the snapshot (render/waiting.ts). */
  get waiting() {
    return interp.curr ? waitingState(interp.curr) : null;
  },
  /** W25b: the waiting markers read back from the scene graph (render/waitView.ts inspectWaiting). */
  inspectWaiting: () => inspectWaiting(scene),
  /**
   * W28: the construction hover panel: shown or not, the building, the snapshot tick its figures
   * come from, its text lines (read from the page), and the intake per resource (null: paused or
   * measuring).
   */
  get siteHover() {
    const r = siteShown?.readout;
    return {
      visible: siteHover.el.style.display === 'block',
      id: r?.id ?? -1,
      tick: siteShown?.tick ?? -1,
      lines: [...siteHover.el.children].map((d) => d.textContent ?? ''),
      intake: r ? Object.fromEntries(r.intake.map((i) => [i.resource, i.perSecond])) : {},
      note: r?.intakeNote ?? '',
    };
  },
  /** The resource readout as drawn (text). */
  get resourceReadout() {
    return document.querySelector('.hud.res')?.textContent ?? '';
  },
  /** W25c: the queue overlay benchmark (runQueueBench). */
  queueBench: (units = 40, orders = 64, frames = 120, hold = false) => runQueueBench(units, orders, frames, hold),
  /** Ends a queueBench run with `hold`: the overlay draws the selection's queues again. */
  queueBenchEnd: () => void (queueBench = null),
  /** The queue drawing read back from the scene graph (render/queueView.ts inspectQueue). */
  inspectQueue: () => inspectQueue(scene),
  /** Ground positions (x, z) of the reserved-site outlines (the ghosts) drawn last frame, read from the scene. */
  reservedOutlines: (): Array<[number, number]> =>
    drawnMeshes(scene)
      .filter((d) => d.name === 'reserved-outline')
      .flatMap((d) => Array.from({ length: d.count }, (_, i): [number, number] => [d.worlds[i * 16 + 12]!, d.worlds[i * 16 + 14]!])),
  /** The queue panel as shown: per unit, its name, line style and item texts. */
  get queuePanel() {
    return selectedQueues().map((u) => ({ id: u.id, name: u.name, lineStyle: u.lineStyle, items: u.items.map((i) => i.text) }));
  },
  get shiftHeld() {
    return shiftHeld;
  },
  /** W25: a placement was made with Shift since the build tool was picked (releasing Shift closes it). */
  get shiftPlaced() {
    return tools.shiftActed;
  },
  // ---- W24 run 3
  /** The map: size, base, entries, and ground heights as the renderer stands buildings on them. */
  terrainInfo: {
    w: terrain.w,
    h: terrain.h,
    base: { ...terrain.base },
    entries: terrain.entries.map((e) => ({ name: e.name, x: e.x, z: e.z })),
    footprintTop: (tx: number, ty: number, fw: number, fh: number) => footprintRange(terrain, tx, ty, fw, fh).top,
    height: (x: number, z: number) => groundHeight(terrain, x, z),
  },
  /** One tile: its type and ground height at its centre. */
  tileInfo: (x: number, z: number) => {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tz < 0 || tx >= terrain.w || tz >= terrain.h) return { type: 'outside', height: 0 };
    const t = terrain.tiles[tz * terrain.w + tx]!;
    return { type: ['ground', 'rock', 'mass', 'rare'][t] ?? String(t), height: groundHeight(terrain, tx + 0.5, tz + 0.5) };
  },
  /** Screen point (CSS px) of world point (x, y, z). */
  worldToScreenY: (x: number, y: number, z: number) => {
    const p = new Vector3(x, y, z).project(camera);
    return { x: ((p.x + 1) / 2) * vw, y: ((1 - p.y) / 2) * vh };
  },
  /**
   * The benchmark's worker timing window (workerWindow.ts): start() at the start of a measured
   * window, stop() at its end returns the report (tick-weighted median and maximum per-tick step
   * time, encoding, ticks, seconds, dropped batches by reason).
   */
  workerWindow: {
    start: () => workerWindow.start(performance.now(), runnerInfo.world),
    stop: () => workerWindow.stop(performance.now()),
  },
  /**
   * D1 diagnostics (render/debugRender.ts), view settings only: hide one depth-tested overlay, turn
   * their depth test off and on, count what each draws, and read back a rectangle of a plain render
   * of the scene (no post stack, so two renders of the same scene are identical) as luminance.
   */
  debugRender: {
    names: [...OVERLAY_NAMES],
    hideOverlay: (name: string, hide = true) => hideOverlay(scene, name, hide),
    overlayDepthTest: (on: boolean) => setOverlayDepthTest(scene, on),
    drawn: (name: string) => overlayMeshes(scene, name).reduce((a, m) => a + (m.visible ? (m instanceof InstancedMesh ? m.count : 1) : 0), 0),
    capture: (rect: { x0: number; y0: number; x1: number; y1: number }) => captureRect(rect),
    screenBox: (id: number) => buildingScreenBox(id),
    overlayScreenBox: (name: string) => overlayScreenBox(name),
  },
  /** Removes order `order` (its id, as `queues` lists it) from unit `id`'s queue (resolves with the final result). */
  dequeue: (id: number, order: number) => commandResult({ t: 'dequeue', id, order }),
  clearQueue: (ids: number[]) => commandResult({ t: 'clearQueue', ids }),
};

declare global {
  interface Window {
    __game: typeof game;
  }
}
Object.defineProperty(window, '__game', { value: Object.freeze(game), writable: false });
