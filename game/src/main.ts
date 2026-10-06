// Render thread: owns the canvas, camera, input and HUD. The simulation lives in the worker; this
// thread only receives snapshots, interpolates them and sends commands back.
//
// URL parameters: ?stress=1 (stress scene), ?seed=<n> (simulation seed, default 1).

import { AmbientLight, Color, DirectionalLight, HemisphereLight, PerspectiveCamera, Scene } from 'three';
import { createRenderer } from './render/adapter.ts';
import { applyRig, clampRig, worldPerPixel, type Rig } from './render/cameraRig.ts';
import { EntityRenderer } from './render/entities.ts';
import { LOD_THRESHOLDS } from './render/lod.ts';
import { Interpolator } from './render/interp.ts';
import { boxSelect, buildOccupancy, pickScreen, screenToGround, type Pick, type PickView } from './render/picking.ts';
import { buildTerrainView } from './render/terrainView.ts';
import { ALIEN_INFO, ALIEN_KINDS, BUILDING_INFO, BUILDING_KINDS, UNIT_INFO, UNIT_KINDS, buildingSize } from './sim/kinds.ts';
import { decodeSnapshot, type Snapshot } from './sim/snapshot.ts';
import { heightAt, map1Terrain } from './sim/terrain.ts';
import type { Command } from './sim/commands.ts';
import type { FromWorker, ToWorker } from './sim/protocol.ts';
import type { ScenarioName } from './sim/scenarios.ts';
import { Hud } from './ui/hud.ts';

// ---- setup ---------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const scenario: ScenarioName = params.get('stress') === '1' ? 'stress' : 'demo';
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
send({ type: 'init', seed, scenario });

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
  };
}

// ---- selection -----------------------------------------------------------------------------

let selection: Pick[] = [];

function describe(p: Pick) {
  const kindName = p.type === 'building' ? BUILDING_KINDS[p.kind] : p.type === 'alien' ? ALIEN_KINDS[p.kind] : UNIT_KINDS[p.kind];
  const label =
    p.type === 'building'
      ? BUILDING_INFO[BUILDING_KINDS[p.kind]!].label
      : p.type === 'alien'
        ? ALIEN_INFO[ALIEN_KINDS[p.kind]!].label
        : UNIT_INFO[UNIT_KINDS[p.kind]!].label;
  return { type: p.type, id: p.id, kind: p.kind, kindName: kindName ?? '?', label };
}

function setSelection(next: Pick[], add = false) {
  if (add) {
    const ids = new Set(selection.map((p) => `${p.type}:${p.id}`));
    selection = [...selection, ...next.filter((p) => !ids.has(`${p.type}:${p.id}`))];
  } else selection = next;
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
});
canvas.addEventListener('pointermove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (!drag) return;
  const dx = e.clientX - drag.x;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 5) drag.moved = true;
  if (drag.button === 0 && drag.moved) {
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
    if (d.moved) {
      const view = pickView();
      if (view) setSelection(boxSelect(camera, d.x0, d.y0, e.clientX, e.clientY, vw, vh, terrain, view), e.shiftKey);
    } else selectAt(e.clientX, e.clientY, e.shiftKey);
  } else if (d.button === 2 && !d.moved) {
    const ids = selection.filter((p) => p.type === 'unit').map((p) => p.id);
    const g = screenToGround(camera, e.clientX, e.clientY, vw, vh, terrain);
    if (ids.length && g) command({ t: 'move', ids, x: g.x, z: g.z });
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
window.addEventListener('keydown', (e) => {
  keys.add(e.key.toLowerCase());
  if (e.key === 'Home') setView('far');
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

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
  // Screen-relative pan: "up" moves away from the camera along the ground.
  const speed = rig.distance * 0.9 * dt;
  const c = Math.cos(rig.yaw);
  const s = Math.sin(rig.yaw);
  rig.x += (px * c + pz * s) * speed;
  rig.z += (-px * s + pz * c) * speed;
  rig.yaw += rot * 1.6 * dt;
  applyCamera();
}

// ---- frame loop ----------------------------------------------------------------------------

const frameTimes: number[] = [];
let lastFrame = performance.now();
let hudAt = 0;
let drawCalls = 0;
let frames = 0;

const frameCpu: number[] = [];

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
    entities.update({ camera, viewportHeight: vh, yaw: rig.yaw, snapshot: snap, aliens: interp.aliens, units: interp.units, selection });
  }
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
      scenario: scenario === 'stress' ? 'stress scene' : 'map 1 demo',
    });
  }
}
requestAnimationFrame(frame);

function entityCounts(s: Snapshot | null) {
  return { buildings: s?.buildings.count ?? 0, aliens: s?.aliens.count ?? 0, units: s?.units.count ?? 0 };
}

// ---- debug hook ----------------------------------------------------------------------------

function screenOf(type: 'building' | 'unit' | 'alien', id: number): { x: number; y: number } | null {
  const s = interp.curr;
  if (!s) return null;
  let x: number;
  let z: number;
  if (type === 'building') {
    const r = Array.prototype.indexOf.call(s.buildings.id, id);
    if (r < 0) return null;
    const size = buildingSize(s.buildings.cols.kind[r]!);
    x = s.buildings.cols.tx[r]! + size / 2;
    z = s.buildings.cols.ty[r]! + size / 2;
  } else {
    const v = type === 'unit' ? interp.units : interp.aliens;
    const r = Array.prototype.indexOf.call(v.id, id);
    if (r < 0) return null;
    x = v.x[r]!;
    z = v.z[r]!;
  }
  const p = camera.position.clone().set(x, heightAt(terrain, x, z), z).project(camera);
  return { x: ((p.x + 1) / 2) * vw, y: ((1 - p.y) / 2) * vh };
}

function list(type: 'building' | 'unit' | 'alien') {
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
    }));
  }
  const v = type === 'unit' ? interp.units : interp.aliens;
  return Array.from({ length: v.count }, (_, r) => ({ id: v.id[r]!, kind: v.kind[r]!, x: v.x[r]!, z: v.z[r]! }));
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

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
  selectAt: (x: number, y: number) => selectAt(x, y),
  // Test helpers (debug only): camera control and entity lookup.
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
  list,
};

declare global {
  interface Window {
    __game: typeof game;
  }
}
Object.defineProperty(window, '__game', { value: Object.freeze(game), writable: false });
