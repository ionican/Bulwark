// Render thread: owns the canvas, camera, input and HUD. The simulation lives in the worker; this
// thread only receives snapshots, interpolates them and sends commands back.
//
// URL parameters: ?stress=1 (stress scene), ?seed=<n> (simulation seed, default 1),
// ?rich=1 (debug: start with 1,000,000 of each resource).

import { AmbientLight, Color, DirectionalLight, HemisphereLight, PerspectiveCamera, Scene } from 'three';
import { createRenderer } from './render/adapter.ts';
import { applyRig, clampRig, worldPerPixel, type Rig } from './render/cameraRig.ts';
import { EntityRenderer } from './render/entities.ts';
import { Ghost } from './render/ghost.ts';
import { LOD_THRESHOLDS } from './render/lod.ts';
import { Interpolator } from './render/interp.ts';
import { boxSelect, buildOccupancy, pickScreen, screenToGround, type Pick, type PickView } from './render/picking.ts';
import { buildTerrainView } from './render/terrainView.ts';
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
  buildingSize,
  isBelt,
  type BuildingKind,
} from './sim/kinds.ts';
import { BF_COMPLETE, BF_UPGRADING } from './sim/schema.ts';
import {
  G_COMMANDER_HP,
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
  decodeSnapshot,
  type Snapshot,
} from './sim/snapshot.ts';
import { heightAt, map1Terrain } from './sim/terrain.ts';
import { canPlaceOn } from './sim/world.ts';
import type { Command } from './sim/commands.ts';
import type { FromWorker, ToWorker } from './sim/protocol.ts';
import type { ScenarioName } from './sim/scenarios.ts';
import { Hud } from './ui/hud.ts';
import { BuildBar, TEST_GROUP } from './ui/buildbar.ts';

// ---- setup ---------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const scenario: ScenarioName = params.get('stress') === '1' ? 'stress' : 'map1';
const seed = (Number(params.get('seed') ?? '1') || 1) >>> 0;

const terrain = map1Terrain();
const adapter = createRenderer();
document.body.appendChild(adapter.canvas);

const scene = new Scene();
scene.background = new Color('#1d1916');
scene.add(new HemisphereLight('#ffe9d2', '#3a2a20', 1.9));
scene.add(new AmbientLight('#ffffff', 0.25));
const sun = new DirectionalLight('#fff0dc', 2.2);
sun.position.set(-40, 90, -30);
scene.add(sun);

const camera = new PerspectiveCamera(45, 1, 0.5, 1000);
const VIEWS = {
  close: { distance: 26 },
  mid: { distance: 95 },
  far: { distance: 175 },
} as const;
const rig: Rig = { x: terrain.base.x, z: terrain.base.z - 2, distance: 50, yaw: 0 };

const terrainView = buildTerrainView(terrain);
scene.add(terrainView.group);
const entities = new EntityRenderer(scene, terrain);
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
  applyRig(camera, rig, heightAt(terrain, rig.x, rig.z));
}
window.addEventListener('resize', resize);
resize();

// ---- worker --------------------------------------------------------------------------------

const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (msg: ToWorker, transfer: Transferable[] = []) => worker.postMessage(msg, transfer);
const interp = new Interpolator();
const occupancy = new Int32Array(terrain.w * terrain.h);
let lastTickMs = 0;
const tickSamples: number[] = [];
let consoleErrors = 0;
window.addEventListener('error', () => consoleErrors++);

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const msg = ev.data;
  if (msg.type !== 'snapshot') return;
  const snap = decodeSnapshot(msg.buffer);
  const dropped = interp.push(snap, performance.now());
  if (dropped) send({ type: 'recycle', buffer: dropped.buffer }, [dropped.buffer]);
  buildOccupancy(
    { count: snap.buildings.count, id: snap.buildings.id, kind: snap.buildings.cols.kind, tx: snap.buildings.cols.tx, ty: snap.buildings.cols.ty },
    terrain.w,
    terrain.h,
    occupancy,
  );
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

function pickView(): PickView | null {
  const s = interp.curr;
  if (!s) return null;
  return {
    mapW: terrain.w,
    mapH: terrain.h,
    occupancy,
    buildings: { count: s.buildings.count, id: s.buildings.id, kind: s.buildings.cols.kind, tx: s.buildings.cols.tx, ty: s.buildings.cols.ty },
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
          ? `Wreck (${ALIEN_INFO[ALIEN_KINDS[p.kind]!].label})`
          : UNIT_INFO[UNIT_KINDS[p.kind]!].label;
  if (p.type === 'building') {
    const r = buildingRow(p.id);
    const c = interp.curr!.buildings.cols;
    if (r >= 0 && (!(c.flags[r]! & BF_COMPLETE) || c.flags[r]! & BF_UPGRADING)) label += ` (building ${(c.progress[r]! * 100).toFixed(0)}%)`;
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
let beltDrag: { tx: number; ty: number } | null = null;

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
  const size = buildingSize(kind);
  return size === 1 ? [Math.floor(gx), Math.floor(gz)] : [Math.round(gx - size / 2), Math.round(gz - size / 2)];
}

function placeBuild(kind: number, tx: number, ty: number, dir: number, queue: boolean): boolean {
  const ids = selectedBuilders();
  if (!ids.length || !canPlaceOn(terrain, occupancy, kind, tx, ty)) return false;
  command({ t: 'build', ids, kind, tx, ty, dir, queue });
  // Mark the tiles at once so a quick second click does not double-book them.
  const size = buildingSize(kind);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) occupancy[(ty + j) * terrain.w + tx + i] = -1;
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
let drag: { button: number; x0: number; y0: number; x: number; y: number; moved: boolean; anchor: { x: number; z: number } | null } | null = null;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const anchor = e.button === 1 ? screenToGround(camera, e.clientX, e.clientY, vw, vh, terrain) : null;
  drag = { button: e.button, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false, anchor };
  if (e.button === 1) e.preventDefault();
  if (e.button === 0 && buildMode && isBelt(buildMode.kind)) {
    const g = screenToGround(camera, e.clientX, e.clientY, vw, vh, terrain);
    if (g) beltDrag = { tx: Math.floor(g.x), ty: Math.floor(g.z) };
  }
});
canvas.addEventListener('pointermove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (!drag) return;
  const dx = e.clientX - drag.x;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 5) drag.moved = true;
  if (drag.button === 0 && drag.moved && !buildMode && !upgradeMode) {
    const b = hud.box.style;
    b.display = 'block';
    b.left = `${Math.min(drag.x0, e.clientX)}px`;
    b.top = `${Math.min(drag.y0, e.clientY)}px`;
    b.width = `${Math.abs(e.clientX - drag.x0)}px`;
    b.height = `${Math.abs(e.clientY - drag.y0)}px`;
  } else if (drag.button === 1 && drag.anchor) {
    const cur = screenToGround(camera, e.clientX, e.clientY, vw, vh, terrain);
    if (cur) {
      rig.x += drag.anchor.x - cur.x;
      rig.z += drag.anchor.z - cur.z;
      applyCamera();
    }
  } else if (drag.button === 2 && drag.moved) {
    rig.yaw += dx * 0.006;
    applyCamera();
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  hud.box.style.display = 'none';
  if (d.button === 0) {
    if (buildMode) {
      const g = screenToGround(camera, e.clientX, e.clientY, vw, vh, terrain);
      if (g) {
        if (isBelt(buildMode.kind) && beltDrag) placeBeltLine(buildMode.kind, beltDrag.tx, beltDrag.ty, Math.floor(g.x), Math.floor(g.z), buildMode.dir, e.shiftKey);
        else {
          const [tx, ty] = footprintAt(buildMode.kind, g.x, g.z);
          placeBuild(buildMode.kind, tx, ty, buildMode.dir, e.shiftKey);
        }
      }
      beltDrag = null;
      // Belts stay selected for laying more; other buildings only while Shift is held.
      if (!e.shiftKey && !isBelt(buildMode.kind)) setBuildMode(null);
      return;
    }
    if (upgradeMode) {
      const view = pickView();
      const p = view ? pickScreen(camera, e.clientX, e.clientY, vw, vh, terrain, view) : null;
      const ids = selectedEngineers();
      if (p && p.type === 'building' && buildingInfo(p.kind).tiers && ids.length) command({ t: 'upgrade', ids, target: p.id, queue: e.shiftKey });
      if (!e.shiftKey) upgradeMode = false;
      return;
    }
    if (d.moved) {
      const view = pickView();
      if (view) setSelection(boxSelect(camera, d.x0, d.y0, e.clientX, e.clientY, vw, vh, terrain, view), e.shiftKey);
    } else selectAt(e.clientX, e.clientY, e.shiftKey);
  } else if (d.button === 2 && !d.moved) {
    if (buildMode || upgradeMode) {
      setBuildMode(null);
      return;
    }
    rightClick(e.clientX, e.clientY, e.shiftKey);
  }
});
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
  const k = e.key.toLowerCase();
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
  rig.distance = VIEWS[name].distance;
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
  if (mouse && !drag) {
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

function frame(now: number) {
  requestAnimationFrame(frame);
  const cpu0 = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  frameTimes.push(now);
  while (frameTimes.length && frameTimes[0]! < now - 1000) frameTimes.shift();
  steer(dt);
  const snap = interp.curr;
  if (snap) {
    interp.update(now);
    entities.update({
      camera,
      viewportHeight: vh,
      yaw: rig.yaw,
      snapshot: snap,
      aliens: interp.aliens,
      units: interp.units,
      projectiles: interp.projectiles,
      selection,
      showRoutes: true,
    });
  }
  updateGhost();
  terrainView.update(
    (x, y, z) => worldPerPixel(camera, Math.hypot(x - camera.position.x, y - camera.position.y, z - camera.position.z), vh),
    rig.distance > LOD_THRESHOLDS[1]!,
    rig.yaw,
  );
  adapter.render(scene, camera);
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
      lod: { ...entities.counts },
      distance: rig.distance,
      renderer: adapter.describe(),
      scenario: scenario === 'stress' ? 'stress scene' : 'map 1',
    });
    const g = snap.globals;
    hud.updateEconomy({
      pool: [g[G_MASS]!, g[G_ENERGY]!, g[G_RARE]!],
      income: [g[G_INCOME]!, g[G_INCOME + 1]!, g[G_INCOME + 2]!],
      spend: [g[G_SPEND]!, g[G_SPEND + 1]!, g[G_SPEND + 2]!],
      short: [0, 1, 2].map((k) => (g[G_SHORT]! & (1 << k)) !== 0),
      parts: g[G_PARTS]!,
      commanderHp: g[G_COMMANDER_HP]!,
      commanderMax: UNIT_INFO.commander.hp,
      aliens: snap.aliens.count,
      kills: g[G_KILLS]!,
      upkeep: g[G_UPKEEP]!,
      lost: g[G_OUTCOME] === 1,
    });
    refreshSelectionPanel();
    const builders = selectedBuilders().length > 0;
    const active = buildMode ? BUILDING_KINDS[buildMode.kind]! : upgradeMode ? 'upgrade' : null;
    const hint = buildMode
      ? `Placing ${buildingInfo(buildMode.kind).label}${isBelt(buildMode.kind) ? ' — drag for a line, R rotates' : ''}. Esc cancels.`
      : upgradeMode
        ? 'Click a wall to upgrade it.'
        : builders
          ? ''
          : 'Select the commander or an engineer to build.';
    bar.update(builders, selectedEngineers().length > 0, active, hint);
  }
}
requestAnimationFrame(frame);

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
    const size = buildingSize(s.buildings.cols.kind[r]!);
    x = s.buildings.cols.tx[r]! + size / 2;
    z = s.buildings.cols.ty[r]! + size / 2;
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
  const p = camera.position.clone().set(x, heightAt(terrain, x, z), z).project(camera);
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
      dir: b.cols.dir[r]!,
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
    return Array.from({ length: w.count }, (_, r) => ({ id: w.id[r]!, kind: w.cols.kind[r]!, x: w.cols.x[r]!, z: w.cols.z[r]!, salvage: w.cols.salvage[r]! }));
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

const kindIndex = (k: string | number, names: readonly string[]) => (typeof k === 'number' ? k : names.indexOf(k));
const allUnitIds = () => Array.from(interp.units.id.subarray(0, interp.units.count));
const entryIndex = (e: string | number | undefined) => (e === undefined ? 0 : typeof e === 'number' ? e : terrain.entries.findIndex((x) => x.name === e));

const game = {
  get ready() {
    return interp.curr !== null && frames > 2;
  },
  get scenario() {
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
    return { ...entities.counts };
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
  get outcome() {
    return interp.curr?.globals[G_OUTCOME] === 1 ? 'lost' : 'playing';
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
  get stats() {
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
  /** Test helpers: issue commands without the mouse. `ids` defaults to every commander and engineer. */
  cmd: {
    build: (kind: string | number, tx: number, ty: number, opts: { dir?: number; ids?: number[]; queue?: boolean } = {}) =>
      command({ t: 'build', ids: opts.ids ?? allUnitIds(), kind: kindIndex(kind, BUILDING_KINDS), tx, ty, dir: opts.dir ?? 0, queue: opts.queue ?? true }),
    move: (ids: number[] | null, x: number, z: number) => command({ t: 'move', ids: ids ?? allUnitIds(), x, z }),
    reclaim: (ids: number[] | null, wreck: number) =>
      command({ t: 'reclaim', ids: ids ?? allUnitIds().filter((id) => interp.units.kind[Array.prototype.indexOf.call(interp.units.id, id)] === U.engineer), wreck }),
    assist: (ids: number[] | null, target: number) => command({ t: 'assist', ids: ids ?? allUnitIds(), target }),
    upgrade: (ids: number[] | null, target: number) => command({ t: 'upgrade', ids: ids ?? allUnitIds(), target }),
    dropTurret: (id: number) => command({ t: 'dropTurret', id }),
    stop: (ids: number[] | null) => command({ t: 'stop', ids: ids ?? allUnitIds() }),
    spawn: (kind: string | number, entry?: string | number, count?: number) => {
      const k = kindIndex(kind, ALIEN_KINDS);
      command({ t: 'spawn', kind: k, entry: entryIndex(entry), count: count ?? TEST_GROUP[ALIEN_KINDS[k]!]! });
    },
  },
  camera: {
    get: (): Rig => ({ ...rig }),
    set: (r: Partial<Rig>) => {
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
