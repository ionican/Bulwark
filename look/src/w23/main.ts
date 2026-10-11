// W23 asset workshop (/assets.html): interlocking walls and gates, mining extractors, engineers and
// the commander mech, on W17's map 1 terrain with W17's lighting and post-processing, W20's
// materials, and W21/W22's instanced batches and detail levels. See ../../README.md (W23).

import { Frustum, Matrix4, NoToneMapping, SRGBColorSpace, Scene, Timer, Vector3, WebGLRenderer } from 'three';
import { TextureBank } from '../assets/textures.ts';
import { BenchCamera, type CamView } from '../bench/benchCamera.ts';
import { Particles } from '../fx/particles.ts';
import { Tracers } from '../fx/tracers.ts';
import { Lighting } from '../render/lighting.ts';
import { LevelBadges } from '../stress/badges.ts';
import { QUALITY, StressPost, type StressQuality } from '../stress/post.ts';
import { Ground } from '../stress/world.ts';
import { buildTerrain } from '../world/terrainMesh.ts';
import { buildWater } from '../world/water.ts';
import { PartBatches } from './batches.ts';
import { Beams } from './beams.ts';
import { extractorBuilders } from './extractors.ts';
import { GroundIcons, ScreenMarkers, w23Atlas } from './icons.ts';
import { ASSET_KINDS, ASSET_NAMES, LEVEL_LABELS, type AssetKind } from './lod.ts';
import { createAssetMats } from './mats.ts';
import { Painter, TOOL_NAMES, type PaintTool } from './painter.ts';
import { PartSet } from './parts.ts';
import { CMD_ACTIONS, CMD_PARTS, CMD_SEGS, commanderBuilders, type CmdAction } from './rig/commander.ts';
import { ENG_ACTIONS, VARIANTS, engineerBuilders, engineerSimple, segmentParts, type EngAction } from './rig/engineer.ts';
import { DEMO_LOOP, VIEW_NAMES, demoView, lineupView, lodView, painterExample, painterView, stressView, type View, type ViewId } from './views.ts';
import { wallBuilders } from './walls/geometry.ts';
import { GATE_WIDTH } from './walls/grid.ts';
import './workshop.css';

const DEG = Math.PI / 180;
type Preset = 'close' | 'game' | 'strategic';

interface Control {
  id: string;
  label: string;
  key?: string;
  state?: () => boolean;
  run: () => void;
}
interface Group {
  title: string;
  views?: ViewId[];
  controls: Control[];
}

const hook = {
  ready: false,
  errors: [] as string[],
  renderer: '',
  stats: {} as Record<string, unknown>,
  api: {} as Record<string, (...a: never[]) => unknown>,
};
(window as unknown as { __assets: typeof hook }).__assets = hook;
window.addEventListener('error', (e) => hook.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => hook.errors.push(String(e.reason)));

function assetOf(id: string): AssetKind {
  if (id.startsWith('gate')) return 'gate';
  if (id.startsWith('mass') || id.startsWith('flow')) return 'mass';
  if (id.startsWith('rare')) return 'rare';
  if (id.startsWith('deposit')) return 'deposit';
  if (id.startsWith('eng')) return 'engineer';
  if (id.startsWith('cmd')) return 'commander';
  return 'wall';
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const loading = document.getElementById('loading')!;
  const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY.medium.maxDpr));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.info.autoReset = false;
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  hook.renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));

  const bank = new TextureBank();
  bank.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  await bank.load((d, n) => (loading.textContent = `Loading textures… ${d}/${n}`));
  const scene = new Scene();
  const lighting = new Lighting(scene, renderer);
  await lighting.loadEnvironment(bank.hdrUrl, 0.55);
  const mats = createAssetMats(bank);
  loading.textContent = 'Building terrain…';
  await new Promise((r) => setTimeout(r, 0));
  const terrain = buildTerrain(bank, 720);
  scene.add(terrain.mesh);
  const water = buildWater();
  bank.derived.add(water.normal);
  scene.add(water.mesh);
  const groundObj = new Ground(terrain.mesh);
  const ground = (x: number, z: number) => groundObj.height(x, z);

  // ---- parts
  loading.textContent = 'Building parts…';
  await new Promise((r) => setTimeout(r, 0));
  const parts = new PartSet();
  const engSimple = engineerSimple();
  for (const builders of [wallBuilders(), extractorBuilders(), engineerBuilders(), commanderBuilders()]) for (const [id, fn] of builders) parts.add(id, assetOf(id), fn, { shadow: !id.startsWith('flow') && !id.endsWith('/light'), levels: engSimple.has(id) ? { 2: engSimple.get(id)! } : undefined });
  const batches = new PartBatches(parts.parts, mats);
  scene.add(batches.group);
  const atlas = w23Atlas();
  bank.derived.add(atlas);
  const icons = new GroundIcons(atlas);
  const markers = new ScreenMarkers(atlas);
  const beams = new Beams();
  const fx = new Particles({ smoke: 2000, glow: 3000 });
  bank.derived.add(fx.atlas);
  fx.smokeUniforms.uSun.value.copy(lighting.sun.color).multiplyScalar(0.62);
  fx.smokeUniforms.uAmb.value.set(0.34, 0.3, 0.28);
  const tracers = new Tracers(64);
  const badges = new LevelBadges(4096);
  scene.add(icons.group, markers.mesh, beams.mesh, fx.smokeMesh, fx.glowMesh, tracers.mesh, badges.mesh);

  // ---- views
  loading.textContent = 'Building views…';
  await new Promise((r) => setTimeout(r, 0));
  const views: Partial<Record<ViewId, View>> = {};
  const lineup = lineupView(parts, ground);
  views.lineup = lineup;
  const viewOf = (id: ViewId): View => {
    views[id] ??= id === 'demo' ? demoView(parts, ground) : id === 'painter' ? painterView(parts, ground) : id === 'lod' ? lodView(parts, ground) : id === 'stress' ? stressView(parts, ground) : lineup;
    return views[id]!;
  };

  // ---- camera, post
  const cam = new BenchCamera(canvas, window.innerWidth / window.innerHeight);
  cam.controls.maxDistance = 320;
  const post = new StressPost(renderer, scene, cam.camera, canvas.width, canvas.height);
  const s = {
    view: 'demo' as ViewId,
    preset: 'game' as Preset | 'free',
    paused: false,
    timeScale: 1,
    quality: 'medium' as StressQuality,
    badges: false,
  };
  const setQuality = (q: StressQuality) => {
    s.quality = q;
    const spec = QUALITY[q];
    lighting.setShadowSize(spec.shadow);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, spec.maxDpr));
    post.apply(spec);
    post.setSize(window.innerWidth, window.innerHeight);
    terrain.mesh.castShadow = spec.terrainShadow;
  };
  const camFor = (p: Preset): CamView => {
    const v = viewOf(s.view);
    return p === 'game' ? v.cams.game : p === 'strategic' ? v.cams.strategic : v.cams.close();
  };
  const setPreset = (p: Preset, instant = false) => {
    s.preset = p;
    cam.go(camFor(p), instant);
  };

  // ---- painter
  const painter = new Painter(canvas, cam.camera, () => viewOf('painter').world, () => undefined);
  scene.add(painter.outline, painter.dashed, painter.gridLines);
  const setView = (id: ViewId) => {
    s.view = id;
    const v = viewOf(id);
    painter.enabled = id === 'painter';
    // painting takes the left and right buttons; the middle button orbits, the wheel zooms
    cam.controls.mouseButtons = painter.enabled ? { LEFT: -1 as never, MIDDLE: 0, RIGHT: -1 as never } : { LEFT: 0, MIDDLE: 1, RIGHT: 2 };
    document.body.dataset.view = id;
    labels.set(v.labels);
    setPreset(id === 'demo' || id === 'stress' ? 'game' : 'close', true);
    if (id === 'lod') cam.go(v.cams.game, true);
    if (id === 'painter') cam.go(v.cams.game, true);
    for (const t of Object.values(v.world.trackers)) t.reset();
    ui.refresh();
  };

  // ---- labels (HTML, projected each frame)
  const labels = (() => {
    const root = document.createElement('div');
    root.id = 'w23-labels';
    document.body.append(root);
    let list: Array<{ el: HTMLDivElement; l: View['labels'][number] }> = [];
    const v = new Vector3();
    return {
      set(ls: View['labels']) {
        root.replaceChildren();
        list = ls.map((l) => {
          const el = document.createElement('div');
          el.className = `wl ${l.cls ?? ''}`;
          el.innerHTML = l.text;
          root.append(el);
          return { el, l };
        });
      },
      update() {
        const r = canvas.getBoundingClientRect();
        for (const { el, l } of list) {
          v.copy(typeof l.at === 'function' ? l.at() : l.at).project(cam.camera);
          const on = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
          el.style.display = on ? 'block' : 'none';
          if (on) {
            el.style.left = `${r.left + ((v.x + 1) / 2) * r.width}px`;
            el.style.top = `${r.top + ((1 - v.y) / 2) * r.height}px`;
          }
        }
      },
    };
  })();

  // ---- UI
  const ui = (() => {
    const panel = document.createElement('div');
    panel.id = 'bench-panel';
    panel.className = 'panel';
    const readout = document.createElement('div');
    readout.id = 'bench-readout';
    readout.className = 'panel';
    const hint = document.createElement('div');
    hint.id = 'w23-hint';
    hint.className = 'panel';
    document.body.append(panel, readout, hint);
    const buttons: Array<{ el: HTMLButtonElement; c: Control }> = [];
    const groupEls: Array<{ els: HTMLElement[]; views?: ViewId[] }> = [];
    const groups: Group[] = [
      { title: 'View', controls: (Object.keys(VIEW_NAMES) as ViewId[]).map((id, k) => ({ id: `v-${id}`, label: VIEW_NAMES[id], key: String(k + 1), state: () => s.view === id, run: () => setView(id) })) },
      { title: 'Demo', views: ['demo'], controls: [{ id: 'restart', label: 'Restart demo', key: 'R', run: () => viewOf('demo').restart?.() }] },
      {
        title: 'Camera',
        controls: [
          { id: 'close', label: 'Close-up', key: 'C', state: () => s.preset === 'close', run: () => setPreset('close') },
          { id: 'game', label: 'Game camera', key: 'G', state: () => s.preset === 'game', run: () => setPreset('game') },
          { id: 'strategic', label: 'Strategic', key: 'S', state: () => s.preset === 'strategic', run: () => setPreset('strategic') },
        ],
      },
      {
        title: 'Simulation',
        controls: [
          { id: 'pause', label: 'Pause', key: 'Space', state: () => s.paused, run: () => (s.paused = !s.paused) },
          { id: 'ts025', label: '0.25×', state: () => s.timeScale === 0.25, run: () => (s.timeScale = 0.25) },
          { id: 'ts1', label: '1×', state: () => s.timeScale === 1, run: () => (s.timeScale = 1) },
        ],
      },
      { title: 'Quality', controls: (['high', 'medium'] as const).map((q) => ({ id: `q-${q}`, label: q === 'high' ? 'High' : 'Medium', state: () => s.quality === q, run: () => setQuality(q) })) },
      {
        title: 'Painter tool',
        views: ['painter'],
        controls: (Object.keys(TOOL_NAMES) as PaintTool[]).map((t) => ({ id: `tool-${t}`, label: TOOL_NAMES[t], state: () => painter.tool === t, run: () => (painter.tool = t) })),
      },
      { title: 'Tier', views: ['painter'], controls: [1, 2, 3].map((t) => ({ id: `tier-${t}`, label: `Tier ${t}`, state: () => painter.tier === t, run: () => (painter.tier = t) })) },
      { title: 'Damage brush', views: ['painter'], controls: [0, 1, 2].map((d) => ({ id: `dmg-${d}`, label: ['Intact', 'Scuffed', 'Heavy'][d]!, state: () => painter.damage === d, run: () => ((painter.damage = d), (painter.tool = 'damage')) })) },
      {
        title: 'Grid',
        views: ['painter'],
        controls: [
          { id: 'clear', label: 'Clear', run: () => viewOf('painter').world.grid.clear() },
          { id: 'example', label: 'Example layout', run: () => painterExample(viewOf('painter').world) },
        ],
      },
      { title: 'Engineers', views: ['lineup'], controls: ENG_ACTIONS.map((a) => ({ id: `eng-${a}`, label: a === 'drop' ? 'Drop turret' : a[0]!.toUpperCase() + a.slice(1), state: () => lineup.controls.engAction === a, run: () => lineup.controls.engineers(a) })) },
      { title: 'Commander', views: ['lineup'], controls: CMD_ACTIONS.map((a) => ({ id: `cmd-${a}`, label: a[0]!.toUpperCase() + a.slice(1), state: () => lineup.controls.cmdAction === a, run: () => lineup.controls.commander(a) })) },
      {
        title: 'Extractors',
        views: ['lineup'],
        controls: [
          { id: 'ex-on', label: 'Working', run: () => lineup.controls.extractors(true) },
          { id: 'ex-off', label: 'Stopped', run: () => lineup.controls.extractors(false) },
          { id: 'ex-build', label: 'Construct', run: () => lineup.controls.construct() },
        ],
      },
      {
        title: 'Display',
        controls: [
          { id: 'badges', label: 'Detail labels', key: 'L', state: () => s.badges, run: () => (s.badges = !s.badges) },
          { id: 'panels', label: 'Hide panels', key: 'H', run: () => document.body.classList.toggle('nopanels') },
        ],
      },
    ];
    for (const g of groups) {
      const h = document.createElement('div');
      h.className = 'grp';
      h.textContent = g.title;
      const row = document.createElement('div');
      row.className = 'btns';
      for (const c of g.controls) {
        const b = document.createElement('button');
        b.className = 'tg';
        b.dataset.id = c.id;
        b.innerHTML = c.key ? `${c.label} <kbd>${c.key}</kbd>` : c.label;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          c.run();
          refresh();
        });
        row.append(b);
        buttons.push({ el: b, c });
      }
      panel.append(h, row);
      groupEls.push({ els: [h, row], views: g.views });
    }
    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.innerHTML = 'Painter: drag = line or rectangle · shift-drag = filled block · right-drag = erase · middle-drag = orbit · wheel = zoom.<br>Detail labels: F circle = full · M square = middle · S triangle = simple · I diamond = icon.';
    panel.append(legend);
    const refresh = () => {
      for (const { el, c } of buttons) if (c.state) el.setAttribute('aria-pressed', String(c.state()));
      for (const g of groupEls) for (const el of g.els) el.style.display = !g.views || g.views.includes(s.view) ? '' : 'none';
    };
    const setReadout = (rows: Array<[string, string]>, table: string, foot: string) => {
      readout.innerHTML = rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${v}</span></div>`).join('') + table + `<div class="foot">${foot}</div>`;
    };
    return { refresh, setReadout, hint };
  })();

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    cam.camera.aspect = window.innerWidth / window.innerHeight;
    cam.camera.updateProjectionMatrix();
    post.setSize(window.innerWidth, window.innerHeight);
  });
  cam.controls.addEventListener('start', () => (s.preset = 'free'));
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const act: Record<string, () => void> = {
      ' ': () => (s.paused = !s.paused),
      c: () => setPreset('close'),
      g: () => setPreset('game'),
      s: () => setPreset('strategic'),
      r: () => viewOf('demo').restart?.(),
      l: () => (s.badges = !s.badges),
      h: () => document.body.classList.toggle('nopanels'),
      '1': () => setView('demo'),
      '2': () => setView('painter'),
      '3': () => setView('lineup'),
      '4': () => setView('lod'),
      '5': () => setView('stress'),
    };
    const f = act[e.key.toLowerCase()];
    if (f) {
      e.preventDefault();
      f();
      ui.refresh();
    }
  });

  // ---- triangles per asset per level (from the parts)
  const sumTris = (ids: Array<string | null>) => [0, 1, 2].map((lv) => ids.reduce((a, id) => a + (id ? parts.get(id).tris[lv as 0 | 1 | 2] : 0), 0));
  const triTable = () => {
    const engs = VARIANTS.map((v, i) => [`engineer ${i + 1}`, sumTris(segmentParts(v, false))] as const);
    const rows: Array<[string, number[]]> = [
      ['wall: straight tile, tier 1', sumTris(['core/straight', 'face/full/1', 'face/full/1'])],
      ['wall: straight tile, tier 2', sumTris(['core/straight', 'face/full/2', 'face/full/2'])],
      ['wall: straight tile, tier 3', sumTris(['core/straight', 'face/full/3', 'face/full/3'])],
      ['wall: post, tier 2', sumTris(['core/hub', 'face/hub/2', 'face/hub/2', 'face/hub/2', 'face/hub/2', 'convex/2', 'convex/2', 'convex/2', 'convex/2', 'cap/post/2'])],
      ['wall: interior of a thick wall', sumTris(['core/full'])],
      ['gate 3 × 2 (tier-agnostic)', sumTris([...Array(2).fill('gate/floor'), ...Array(4).fill('gate/pylon'), ...Array(4).fill('gate/cap'), ...Array(4).fill('gate/leaf')])],
      ['mass extractor (working)', sumTris(['mass/base', 'mass/drum', 'mass/head', 'mass/fill', 'mass/light', ...Array(6).fill('flow/seg')])],
      ['rare extractor (working, with crystals)', sumTris(['rare/base', 'rare/ring', 'rare/pump', 'rare/light', 'deposit/rareCrystal', ...Array(6).fill('flow/seg')])],
      ['mass deposit (bare)', sumTris(['deposit/massOre', 'deposit/markerMass'])],
      ['rare point (bare)', sumTris(['deposit/rareCrystal', 'deposit/markerRare'])],
      ...engs.map(([n, t]) => [n, t] as [string, number[]]),
      ['commander', sumTris(CMD_SEGS.map((k) => CMD_PARTS[k]))],
    ];
    return rows.map(([n, t]) => ({ asset: n, full: t[0]!, middle: t[1]!, simple: t[2]!, icon: n.startsWith('wall') ? 2 : 2 }));
  };

  // ---- loop
  setQuality('medium'); // default quality is medium (Richard, 2026-10-08)
  setView('demo');
  cam.update(0);
  loading.textContent = 'Compiling shaders…';
  batches.prime(true);
  lighting.update(cam.camera, cam.distance);
  await renderer.compileAsync(scene, cam.camera);
  batches.prime(false);

  const timer = new Timer();
  const frustum = new Frustum();
  const pv = new Matrix4();
  const cpuHist: number[] = [];
  let fpsWin: number[] = [];
  let frames = 0;
  let hudAt = 0;
  const tick = () => {
    requestAnimationFrame(tick);
    const start = performance.now();
    timer.update();
    const dt = Math.min(0.05, timer.getDelta());
    const sdt = s.paused ? 0 : dt * s.timeScale;
    renderer.info.reset();
    const view = viewOf(s.view);
    view.update?.(sdt);
    const world = view.world;
    world.update(sdt);
    cam.update(dt);
    const camera = cam.camera;
    camera.updateMatrixWorld();
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    const wppd = (2 * Math.tan((camera.fov * DEG) / 2)) / Math.max(1, canvas.clientHeight);
    batches.begin();
    icons.begin();
    markers.begin();
    beams.begin();
    if (s.badges) badges.begin();
    painter.update(markers);
    world.draw({ batches, parts, icons, markers, beams, camera, frustum, wppd, fx, tracers, forced: null, sdt, badge: s.badges ? (x, y, z, l) => badges.push(x, y, z, l) : undefined });
    batches.commit();
    icons.commit();
    markers.commit(wppd);
    beams.commit();
    badges.mesh.visible = s.badges;
    if (s.badges) badges.commit(wppd, 20);
    tracers.update(sdt, world.time);
    fx.update(sdt, camera);
    const q = QUALITY[s.quality];
    lighting.update(camera, Math.max(8, cam.distance), Math.min(camera.far, cam.distance * q.shadowReach + 20));
    post.render(dt);
    labels.update();
    if (painter.hint) {
      ui.hint.textContent = painter.hint;
      ui.hint.style.display = 'block';
      ui.hint.style.left = `${painter.hintAt.x + 16}px`;
      ui.hint.style.top = `${painter.hintAt.y + 14}px`;
    } else ui.hint.style.display = 'none';

    const cpuMs = performance.now() - start;
    cpuHist.push(cpuMs);
    if (cpuHist.length > 120) cpuHist.shift();
    fpsWin.push(start);
    fpsWin = fpsWin.filter((t) => start - t < 1000);
    frames++;
    const info = renderer.info.render;
    const counts = Object.fromEntries(ASSET_KINDS.map((k) => [k, [...(batches.stats.get(k)?.objects ?? [0, 0, 0, 0])]]));
    hook.stats = {
      fps: fpsWin.length,
      cpuMs: cpuHist.reduce((a, b) => a + b, 0) / cpuHist.length,
      calls: info.calls,
      triangles: info.triangles,
      partCalls: batches.drawCalls,
      counts,
      view: s.view,
      time: world.time,
      gates: [...world.doors.values()].map((d) => d.open),
      wallTiles: world.grid.count(),
      engineers: world.engineers.length,
      commanders: world.commanders.length,
      extractors: world.deposits.filter((d) => d.extractor).length,
      edits: painter.edits,
      lastGate: painter.lastGate,
    };
    if (start - hudAt > 250) {
      hudAt = start;
      ui.refresh();
      const st = hook.stats as { fps: number; cpuMs: number };
      const table = `<table class="lv"><tr><th>asset</th>${LEVEL_LABELS.map((l) => `<th>${l[0]!.toUpperCase()}</th>`).join('')}</tr>${ASSET_KINDS.filter((k) => (counts[k] as number[]).some((v) => v > 0))
        .map((k) => `<tr><td>${ASSET_NAMES[k]}</td>${(counts[k] as number[]).map((v) => `<td>${v}</td>`).join('')}</tr>`)
        .join('')}</table>`;
      ui.setReadout(
        [
          ['view', VIEW_NAMES[s.view]],
          ['fps', `${st.fps}`],
          ['frame CPU', `${st.cpuMs.toFixed(2)} ms`],
          ['draw calls (all passes)', `${info.calls}`],
          ['triangles (all passes)', `${(info.triangles / 1e6).toFixed(2)} M`],
          ['part batches drawn', `${batches.drawCalls} of ${batches.batchCount}`],
          ['wall tiles · gates', `${world.grid.count()} · ${world.grid.gates.size} (${GATE_WIDTH} wide)`],
          ['gate doors', [...world.doors.values()].map((d) => (d.open > 0.99 ? 'open' : d.open < 0.01 ? 'shut' : `${Math.round(d.open * 100)} %`)).join(' · ') || '—'],
          ...(s.view === 'demo' ? ([['demo time', `${world.time.toFixed(1)} / ${DEMO_LOOP} s`]] as Array<[string, string]>) : []),
          ['time scale', s.paused ? 'paused' : `${s.timeScale}×`],
        ],
        table,
        `${s.quality} quality · ${renderer.getPixelRatio()} dpr · ${canvas.width}×${canvas.height}<br>${hook.renderer}`,
      );
    }
    if (frames === 5) {
      loading.remove();
      hook.ready = true;
    }
  };

  hook.api = {
    view: ((id: ViewId) => setView(id)) as never,
    preset: ((p: Preset, instant = false) => setPreset(p, instant)) as never,
    cam: ((v: CamView) => {
      s.preset = 'free';
      cam.go(v, true);
    }) as never,
    camNow: (() => cam.now()) as never,
    pause: ((v: boolean) => (s.paused = v)) as never,
    timeScale: ((v: number) => (s.timeScale = v)) as never,
    quality: ((q: StressQuality) => setQuality(q)) as never,
    restart: (() => viewOf('demo').restart?.()) as never,
    badges: ((v: boolean) => (s.badges = v)) as never,
    panels: ((v: boolean) => document.body.classList.toggle('nopanels', !v)) as never,
    unitLabels: ((v: boolean) => document.body.classList.toggle('nounitlabels', !v)) as never,
    /** Advances the current view's simulation by `seconds` in fixed steps (for screenshots). */
    advance: ((seconds: number) => {
      const v = viewOf(s.view);
      for (let t = 0; t < seconds; t += 1 / 30) {
        v.update?.(1 / 30);
        v.world.update(1 / 30);
      }
    }) as never,
    painter: (() => ({ tool: painter.tool, tier: painter.tier, damage: painter.damage, edits: painter.edits, tiles: viewOf('painter').world.grid.count(), gates: viewOf('painter').world.grid.gates.size, lastGate: painter.lastGate })) as never,
    painterSet: ((o: { tool?: PaintTool; tier?: number; damage?: number }) => {
      if (o.tool) painter.tool = o.tool;
      if (o.tier) painter.tier = o.tier;
      if (o.damage !== undefined) painter.damage = o.damage;
      ui.refresh();
    }) as never,
    painterExample: (() => painterExample(viewOf('painter').world)) as never,
    painterClear: (() => viewOf('painter').world.grid.clear()) as never,
    /** Screen position (client px) of the centre of a painter grid tile. */
    tileScreen: ((x: number, z: number) => {
      const w = viewOf('painter').world;
      const p = new Vector3(w.ox + x + 0.5, w.tileY[0] ?? 0, w.oz + z + 0.5).project(cam.camera);
      const r = canvas.getBoundingClientRect();
      return [Math.round(r.left + ((p.x + 1) / 2) * r.width), Math.round(r.top + ((1 - p.y) / 2) * r.height)];
    }) as never,
    lineupEngineers: ((a: EngAction) => lineup.controls.engineers(a)) as never,
    lineupEngineer: ((i: number, a: EngAction) => lineup.controls.engineer(i, a)) as never,
    lineupCommander: ((a: CmdAction) => lineup.controls.commander(a)) as never,
    lineupExtractors: ((on: boolean) => lineup.controls.extractors(on)) as never,
    lineupConstruct: (() => lineup.controls.construct()) as never,
    triangles: (() => triTable()) as never,
    /** Client pixel position of a world point. */
    project: ((x: number, y: number, z: number) => {
      const p = new Vector3(x, y, z).project(cam.camera);
      const r = canvas.getBoundingClientRect();
      return [Math.round(r.left + ((p.x + 1) / 2) * r.width), Math.round(r.top + ((1 - p.y) / 2) * r.height)];
    }) as never,
    /** The current view's world (debugging). */
    world: (() => viewOf(s.view).world) as never,
    measure: ((seconds: number) =>
      new Promise((resolve) => {
        const iv: number[] = [];
        const cpu: number[] = [];
        const calls: number[] = [];
        const tris: number[] = [];
        let last = -1;
        const t0 = performance.now();
        const step = (ts: number) => {
          if (last >= 0) {
            iv.push(ts - last);
            cpu.push(hook.stats.cpuMs as number);
            calls.push(hook.stats.calls as number);
            tris.push(hook.stats.triangles as number);
          }
          last = ts;
          if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(step);
          else {
            const sum = iv.reduce((a, b) => a + b, 0);
            const sorted = [...iv].sort((a, b) => a - b);
            const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
            resolve({ frames: iv.length, fps: iv.length / (sum / 1000), low1: 1000 / sorted[Math.floor(0.99 * (sorted.length - 1))]!, frameMs: sum / iv.length, cpuMs: avg(cpu), calls: avg(calls), triangles: avg(tris), counts: hook.stats.counts });
          }
        };
        requestAnimationFrame(step);
      })) as never,
  };
  ui.refresh();
  requestAnimationFrame(tick);
}

main().catch((e) => {
  hook.errors.push(String(e?.stack ?? e));
  const l = document.getElementById('loading');
  if (l) l.textContent = `Failed: ${e}`;
  console.error(e);
});
