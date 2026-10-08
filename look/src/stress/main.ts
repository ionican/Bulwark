// W21 turret rendering stress test (/stress.html): up to 500 W20 gun turrets on W17's map 1
// terrain, each aiming and firing on its own against 500 alien machines, drawn as instanced
// batches at four detail levels, with a built-in benchmark. See ../../README.md (W21 section).

import { Frustum, Group, Matrix4, NoToneMapping, SRGBColorSpace, Scene, Sphere, Timer, Vector3, WebGLRenderer } from 'three';
import { TextureBank } from '../assets/textures.ts';
import { breechVent, muzzleBlast } from '../bench/effects.ts';
import { BenchCamera, type CamView } from '../bench/benchCamera.ts';
import { createTurretMats } from '../bench/surface.ts';
import { buildTurret } from '../bench/turretModel.ts';
import { TurretRig, type Lod } from '../bench/turretRig.ts';
import { BenchUi } from '../bench/ui.ts';
import { PType, Particles } from '../fx/particles.ts';
import { createMaterials } from '../models/materials.ts';
import { Lighting } from '../render/lighting.ts';
import { Rand } from '../noise.ts';
import { buildTerrain } from '../world/terrainMesh.ts';
import { buildWater } from '../world/water.ts';
import { AlienRenderer, AlienSim, Wrecks, alienModels } from './aliens.ts';
import { LevelBadges } from './badges.ts';
import { formatResults, summarise, type Meta, type Results, type Row, type Sample } from './benchmark.ts';
import { CasingMesh, CasingPool, LightPool, PARTICLE_CAPS, SHELL_CAP, CASING_CAP, LIGHT_CAP, ShellPool, TracerMesh, blastMiddle, blastSimple } from './effects.ts';
import { AlienGrid, MODE_NAMES, TurretBank, type ShotRecord } from './fireControl.ts';
import { LEVEL_NAMES, LEVEL_NEW, STRESS_THRESHOLDS, chooseLevel } from './lod.ts';
import { QUALITY, StressPost, type StressQuality } from './post.ts';
import { buildLevels } from './turretLevels.ts';
import { InstancedTurrets } from './turretInstanced.ts';
import { barrelPoint } from './turretPose.ts';
import { BASE, Ground, LANES, MAX_TURRETS, turretSites } from './world.ts';
import './stress.css';

const DEG = Math.PI / 180;
const ALIEN_CAP = 600;
const COUNTS = [50, 100, 300, 500] as const;
const RIG_LOD: Lod[] = ['full', 'full', 'simple', 'icon'];
const BENCH_HOLD = 10;
const BENCH_MOVE = 2.2;
/**
 * `?dpr=2` stands in for the display's device pixel ratio (the quality cap still applies), to load
 * codepanda's GPU with a Retina laptop's pixel count.
 */
const DPR_FORCED = Number(new URLSearchParams(location.search).get('dpr')) || null;
const pixelRatio = (cap: number) => Math.min(DPR_FORCED ?? (window.devicePixelRatio || 1), cap);

type PresetName = 'close' | 'game' | 'mid' | 'far';

const stress = {
  ready: false,
  errors: [] as string[],
  renderer: '',
  stats: {} as Record<string, number | string | number[]>,
  results: null as Results | null,
  runBenchmark: async (): Promise<Results> => {
    throw new Error('not ready');
  },
  api: {} as Record<string, (...a: never[]) => unknown>,
};
(window as unknown as { __stress: typeof stress }).__stress = stress;
window.addEventListener('error', (e) => stress.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => stress.errors.push(String(e.reason)));

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const loading = document.getElementById('loading')!;
  const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
  renderer.setPixelRatio(pixelRatio(QUALITY.high.maxDpr));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.info.autoReset = false;
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  stress.renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));

  const bank = new TextureBank();
  bank.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  await bank.load((d, n) => (loading.textContent = `Loading textures… ${d}/${n}`));

  const scene = new Scene();
  const lighting = new Lighting(scene, renderer);
  await lighting.loadEnvironment(bank.hdrUrl, 0.55);
  const mats = createMaterials(bank);
  const tm = createTurretMats(bank);
  tm.glow.emissiveIntensity = 4.5;
  loading.textContent = 'Building terrain…';
  await new Promise((r) => setTimeout(r, 0));
  const terrain = buildTerrain(bank, 720);
  scene.add(terrain.mesh);
  const water = buildWater();
  bank.derived.add(water.normal);
  scene.add(water.mesh);
  const ground = new Ground(terrain.mesh);
  const groundH = (x: number, z: number) => ground.height(x, z);

  // ---- turrets
  loading.textContent = 'Building turret levels…';
  await new Promise((r) => setTimeout(r, 0));
  const model = buildTurret(tm);
  const simpleRig = new TurretRig(model, tm, 'simple');
  const { levels } = buildLevels(model, tm, simpleRig);
  const frame = { pinionAt: model.pinionAt, pinionRatio: model.pinionRatio, trunnionY: model.trunnionY };
  const turretGroup = new Group();
  turretGroup.name = 'turrets-instanced';
  scene.add(turretGroup);
  const turrets = new InstancedTurrets(levels, MAX_TURRETS, turretGroup);
  const sites = turretSites(ground, MAX_TURRETS);
  const bankT = new TurretBank(MAX_TURRETS);
  const level = new Uint8Array(MAX_TURRETS).fill(LEVEL_NEW);
  const vis = new Uint8Array(MAX_TURRETS);
  const acc = new Float64Array(MAX_TURRETS);
  // W20 per-object turrets for the comparison mode (built on demand)
  const rigGroup = new Group();
  rigGroup.name = 'turrets-per-object';
  scene.add(rigGroup);
  const rigs: TurretRig[] = [];
  const compareRig = new TurretRig(model, tm);
  compareRig.root.visible = false;
  scene.add(compareRig.root);

  // ---- aliens and effects
  const models = alienModels(mats);
  const sim = new AlienSim(ALIEN_CAP, models, ground);
  const grid = new AlienGrid(ALIEN_CAP);
  const alienDraw = new AlienRenderer(models, ALIEN_CAP, mats, ground);
  scene.add(alienDraw.group);
  const fx = new Particles(PARTICLE_CAPS);
  bank.derived.add(fx.atlas);
  fx.smokeUniforms.uSun.value.copy(lighting.sun.color).multiplyScalar(0.62);
  fx.smokeUniforms.uAmb.value.set(0.34, 0.3, 0.28);
  const shells = new ShellPool(SHELL_CAP);
  const tracers = new TracerMesh(SHELL_CAP);
  const casings = new CasingPool(CASING_CAP);
  const casingMesh = new CasingMesh(tm.brass, CASING_CAP);
  const lights = new LightPool(LIGHT_CAP);
  const wrecks = new Wrecks();
  const badges = new LevelBadges(MAX_TURRETS);
  scene.add(fx.smokeMesh, fx.glowMesh, tracers.mesh, casingMesh.mesh, badges.mesh, ...lights.lights);
  const rnd = (() => {
    const r = new Rand(4242);
    return () => r.next();
  })();
  /** Wrecks that still burn (fire and plume emitters), newest last; at most 12. */
  const burning: Array<{ slot: number; emitters: ReturnType<Particles['addEmitter']>[] }> = [];
  const stopBurning = (slot: number) => {
    const k = burning.findIndex((b) => b.slot === slot);
    if (k < 0) return;
    for (const e of burning[k]!.emitters) fx.removeEmitter(e);
    burning.splice(k, 1);
  };

  // ---- camera, post, UI
  const cam = new BenchCamera(canvas, window.innerWidth / window.innerHeight);
  cam.controls.maxDistance = 320;
  const post = new StressPost(renderer, scene, cam.camera, canvas.width, canvas.height);

  const s = {
    count: 300,
    quality: 'high' as StressQuality,
    perTurret: false,
    paused: false,
    timeScale: 1,
    preset: 'game' as PresetName | 'free',
    bands: false,
    compare: false,
    /** Debug: draw every turret at one level (null = by distance). */
    force: null as number | null,
  };
  const presets: Record<PresetName, CamView> = {} as Record<PresetName, CamView>;
  const cmp = { c: 0, d: 1, yaw: 0, pitch: 4 * DEG };
  const killTimes: number[] = [];
  let shotsWindow: number[] = [];

  const computePresets = () => {
    const n = s.count;
    const front = (deg: number) => {
      // outermost turret within ±20° of a bearing from the base centre
      let best = 0;
      let bestR = -1;
      for (let i = 0; i < n; i++) {
        const b = Math.atan2(-(sites[i]!.z - BASE.z), sites[i]!.x - BASE.x) / DEG;
        let d = b - deg;
        d = ((d + 540) % 360) - 180;
        if (Math.abs(d) < 20 && sites[i]!.r > bestR) {
          bestR = sites[i]!.r;
          best = i;
        }
      }
      return best;
    };
    // the north corridor's front: aliens climb the ramp and hold here
    const c = front(78);
    const cs = sites[c]!;
    // from inside the base, looking out past the front-line turret towards the aliens; high enough
    // (24°) for the line of sight to clear the heads of the turrets in between
    const ob = Math.atan2(-(cs.z - BASE.z), cs.x - BASE.x);
    const inward = Math.atan2(-Math.cos(ob), Math.sin(ob)) / DEG;
    presets.close = { target: [cs.x + Math.cos(ob) * 0.8, cs.y + 0.8, cs.z - Math.sin(ob) * 0.8], distance: 8.5, elevation: 24, azimuth: inward - 30, fov: 35 };
    const gx = BASE.x + Math.cos(45 * DEG) * 14;
    const gz = BASE.z - Math.sin(45 * DEG) * 14;
    presets.game = { target: [gx, 0, gz], distance: 50, elevation: 68.9, azimuth: -45, fov: 45 };
    presets.mid = { target: [gx, 0, gz], distance: 115, elevation: 60, azimuth: -45, fov: 45 };
    presets.far = { target: [BASE.x + 12, 0, BASE.z - 12], distance: 235, elevation: 65, azimuth: -45, fov: 45 };
    // comparison pair: the close-up turret and its nearest neighbour across the view
    let d = -1;
    let dBest = Infinity;
    for (let i = 0; i < n; i++) {
      if (i === c) continue;
      const dist = Math.hypot(sites[i]!.x - cs.x, sites[i]!.z - cs.z);
      // prefer a neighbour roughly north-west / south-east of it (across a north-east view)
      const ang = Math.atan2(-(sites[i]!.z - cs.z), sites[i]!.x - cs.x) / DEG;
      const off = Math.min(Math.abs(((ang - 135 + 540) % 360) - 180), Math.abs(((ang + 45 + 540) % 360) - 180));
      const score = dist + off * 0.02;
      if (dist < 3.2 && score < dBest) {
        dBest = score;
        d = i;
      }
    }
    cmp.c = c;
    cmp.d = d >= 0 ? d : c === 0 ? 1 : 0;
  };

  const setCount = (n: number) => {
    s.count = n;
    bankT.n = n;
    for (let i = 0; i < n; i++) {
      const p = sites[i]!;
      const out = Math.atan2(-(p.z - BASE.z), p.x - BASE.x);
      bankT.init(i, p.x, p.y, p.z, out + (rnd() - 0.5) * 0.8);
    }
    level.fill(LEVEL_NEW);
    acc.fill(0);
    sim.holdRadius = sites[n - 1]!.r + 3.5;
    sim.clear();
    sim.prefill(sim.population);
    shells.clear();
    casings.clear();
    for (const b of [...burning]) stopBurning(b.slot);
    wrecks.clear();
    computePresets();
    syncRigs();
  };

  const syncRigs = () => {
    if (!s.perTurret) {
      rigGroup.visible = false;
      return;
    }
    while (rigs.length < s.count) {
      const r = new TurretRig(model, tm);
      rigs.push(r);
      rigGroup.add(r.root);
    }
    rigs.forEach((r, i) => (r.root.visible = i < s.count));
    rigGroup.visible = true;
  };

  const setQuality = (q: StressQuality) => {
    s.quality = q;
    const spec = QUALITY[q];
    lighting.setShadowSize(spec.shadow);
    renderer.setPixelRatio(pixelRatio(spec.maxDpr));
    post.apply(spec);
    post.setSize(window.innerWidth, window.innerHeight);
    terrain.mesh.castShadow = spec.terrainShadow;
    // low: only full-detail turrets cast shadows
    turrets.levels[1]!.meshes.forEach((m, k) => (m.castShadow = q !== 'low' && levels[1]!.batches[k]!.castShadow));
  };

  const setPreset = (p: PresetName, instant = false) => {
    s.preset = p;
    cam.go(presets[p], instant);
  };

  const setPerTurret = (on: boolean) => {
    s.perTurret = on;
    level.fill(LEVEL_NEW);
    syncRigs();
  };

  const setCompare = (on: boolean) => {
    s.compare = on;
    if (on && s.perTurret) setPerTurret(false);
    document.body.classList.toggle('cmp21', on);
    // effects frozen in mid-air would cross the pair
    for (const m of [fx.smokeMesh, fx.glowMesh, tracers.mesh]) m.visible = !on;
    compareRig.root.visible = on;
    if (!on) return;
    s.paused = true;
    let c = sites[cmp.c]!;
    let d = sites[cmp.d]!;
    // camera square to the pair, on the side away from the base centre (nothing in between); the
    // instanced turret on the left, W20's on the right
    let ax = d.x - c.x;
    let az = d.z - c.z;
    const l = Math.hypot(ax, az);
    ax /= l;
    az /= l;
    // camera offset o = (−az, ax) puts c on the left; flip the pair if that faces the base
    if (-az * ((c.x + d.x) / 2 - BASE.x) + ax * ((c.z + d.z) / 2 - BASE.z) < 0) {
      [cmp.c, cmp.d] = [cmp.d, cmp.c];
      [c, d] = [d, c];
      ax = -ax;
      az = -az;
    }
    const ox = -az;
    const oz = ax;
    compareRig.root.position.set(d.x, d.y, d.z);
    // barrel to the viewer's right and turned 25° towards the camera
    const bx = ax * Math.cos(25 * DEG) + ox * Math.sin(25 * DEG);
    const bz = az * Math.cos(25 * DEG) + oz * Math.sin(25 * DEG);
    cmp.yaw = Math.atan2(-bz, bx);
    cmp.pitch = 4 * DEG;
    // centred a little towards W20's turret so both barrels are in frame
    cam.go({ target: [(c.x + d.x) / 2 + ax * 0.5, Math.max(c.y, d.y) + 0.62, (c.z + d.z) / 2 + az * 0.5], distance: 10, elevation: 16, azimuth: Math.atan2(ox, oz) / DEG, fov: 24 }, true);
    s.preset = 'free';
  };

  const ui = new BenchUi([
    {
      title: 'Turrets',
      controls: [
        ...COUNTS.map((n) => ({ id: `n${n}`, label: `${n}`, state: () => s.count === n, run: () => setCount(n) })),
        { id: 'perTurret', label: 'Per-turret meshes', state: () => s.perTurret, run: () => setPerTurret(!s.perTurret) },
      ],
    },
    {
      title: 'Quality',
      controls: (['high', 'medium', 'low'] as const).map((q) => ({ id: `q-${q}`, label: q[0]!.toUpperCase() + q.slice(1), state: () => s.quality === q, run: () => setQuality(q) })),
    },
    {
      title: 'Camera',
      controls: [
        { id: 'close', label: 'Close-up', key: 'C', state: () => s.preset === 'close', run: () => setPreset('close') },
        { id: 'game', label: 'Game camera', key: 'G', state: () => s.preset === 'game', run: () => setPreset('game') },
        { id: 'mid', label: 'Mid zoom-out', key: 'M', state: () => s.preset === 'mid', run: () => setPreset('mid') },
        { id: 'far', label: 'Full zoom-out', key: 'F', state: () => s.preset === 'far', run: () => setPreset('far') },
        { id: 'compare', label: 'Vs W20 turret', state: () => s.compare, run: () => setCompare(!s.compare) },
      ],
    },
    {
      title: 'Simulation',
      controls: [
        { id: 'pause', label: 'Pause', key: 'Space', state: () => s.paused, run: () => (s.paused = !s.paused) },
        ...[0.25, 0.5, 1, 2].map((v) => ({ id: `ts${v}`, label: `${v}×`, state: () => s.timeScale === v, run: () => (s.timeScale = v) })),
        { id: 'lead', label: 'Lead target', state: () => bankT.lead, run: () => (bankT.lead = !bankT.lead) },
      ],
    },
    {
      title: 'Display',
      controls: [{ id: 'bands', label: 'Detail labels', key: 'L', state: () => s.bands, run: () => (s.bands = !s.bands) }],
    },
    {
      title: 'Benchmark',
      controls: [
        { id: 'bench', label: 'Run benchmark', run: () => void stress.runBenchmark().catch((e) => stress.errors.push(String(e))) },
        { id: 'showRes', label: 'Show results', run: () => resultsEl.classList.toggle('show', !!stress.results) },
      ],
    },
  ]);
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.textContent = 'Detail labels: F circle = full · M square = middle · S triangle = simple · I diamond = icon';
  ui.panel.append(legend);

  // results overlay and benchmark progress
  const resultsEl = document.createElement('div');
  resultsEl.id = 'results';
  resultsEl.className = 'panel';
  const pre = document.createElement('pre');
  const btnRow = document.createElement('div');
  btnRow.className = 'btns';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'tg';
  copyBtn.textContent = 'Copy results';
  copyBtn.id = 'copy-results';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tg';
  closeBtn.textContent = 'Close';
  const copyNote = document.createElement('span');
  copyNote.className = 'note';
  btnRow.append(copyBtn, closeBtn, copyNote);
  resultsEl.append(pre, btnRow);
  document.body.append(resultsEl);
  closeBtn.addEventListener('click', () => resultsEl.classList.remove('show'));
  copyBtn.addEventListener('click', async () => {
    const text = stress.results?.text ?? '';
    try {
      await navigator.clipboard.writeText(text);
      copyNote.textContent = 'Copied.';
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      copyNote.textContent = ok ? 'Copied.' : 'Copy failed: select the text and copy it by hand.';
    }
  });
  const progress = document.createElement('div');
  progress.id = 'bench-progress';
  progress.className = 'panel';
  document.body.append(progress);
  const caps = ['W21 · instanced batches', 'W20 · per-object meshes'].map((t) => {
    const d = document.createElement('div');
    d.className = 'cap cmp2';
    d.textContent = t;
    document.body.append(d);
    return d;
  });

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    cam.camera.aspect = window.innerWidth / window.innerHeight;
    cam.camera.updateProjectionMatrix();
    post.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);
  cam.controls.addEventListener('start', () => (s.preset = 'free'));
  window.addEventListener('keydown', (e) => {
    if (e.repeat || bench) return;
    const act: Record<string, () => void> = {
      ' ': () => (s.paused = !s.paused),
      c: () => setPreset('close'),
      g: () => setPreset('game'),
      m: () => setPreset('mid'),
      f: () => setPreset('far'),
      l: () => (s.bands = !s.bands),
    };
    const f = act[e.key.toLowerCase()];
    if (f) {
      e.preventDefault();
      f();
      ui.refresh();
    }
  });

  // ---- kills, hits
  sim.onKill = (_slot, kind, x, y, z) => {
    killTimes.push(simT);
    const big = kind === 2 ? 1.5 : kind === 0 ? 0.75 : 1;
    const d = cam.camera.position.distanceTo(_v.set(x, y, z));
    if (d < 110) fx.explosion(x, y, z, big);
    else fx.spawn({ type: PType.Flash, x, y: y + 0.5, z, life: 0.2, s0: 2.5 * big, s1: 4 * big, r: 8, g: 5, b: 2.4, a: 1, drag: 0 });
    const w = wrecks.add(x, y, z, big * 0.8, rnd() * 6.28);
    if (w.replaced >= 0) stopBurning(w.replaced);
    if (d < 140) {
      if (burning.length >= 12) stopBurning(burning[0]!.slot);
      const p = _v.set(x, y + 0.3, z);
      burning.push({ slot: w.slot, emitters: [fx.addEmitter('fire', p, big * 0.56), fx.addEmitter('plume', p, big * 0.72)] });
    }
  };
  const onShellHit = (slot: number, x: number, y: number, z: number) => {
    const d = cam.camera.position.distanceTo(_v.set(x, y, z));
    if (slot >= 0) {
      sim.hit(slot, 1);
      if (d < 140) fx.sparks(x, y, z, d < 40 ? 6 : d < 90 ? 3 : 1, 6);
    } else if (d < 90) fx.sparks(x, y, z, 3, 4);
  };

  // ---- shots: effects by the firing turret's detail level
  const P = new Float64Array(3);
  const muzzleV = new Vector3();
  const dirV = new Vector3();
  const sideV = new Vector3();
  const portVs = model.brakePorts.map(() => new Vector3());
  const ejectV = new Vector3();
  const effectsForShot = (i: number, lv: number) => {
    const x = bankT.px[i]!;
    const y = bankT.py[i]!;
    const z = bankT.pz[i]!;
    const yaw = bankT.yaw[i]!;
    const pitch = bankT.pitch[i]!;
    const r = bankT.rOff[i]!;
    const ty = model.trunnionY;
    barrelPoint(P, 0, x, y, z, yaw, pitch, ty, r, model.muzzle[0], 0, 0);
    muzzleV.set(P[0]!, P[1]!, P[2]!);
    dirV.set(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.sin(yaw) * Math.cos(pitch));
    sideV.set(Math.sin(yaw), 0, Math.cos(yaw));
    if (lv === 0) {
      model.brakePorts.forEach((px, k) => {
        barrelPoint(P, 0, x, y, z, yaw, pitch, ty, r, px, 0, 0);
        portVs[k]!.set(P[0]!, P[1]!, P[2]!);
      });
      muzzleBlast(fx, muzzleV, dirV, sideV, portVs, rnd);
      lights.flash(muzzleV.x + dirV.x * 0.3, muzzleV.y + dirV.y * 0.3, muzzleV.z + dirV.z * 0.3);
    } else if (lv === 1) {
      barrelPoint(P, 0, x, y, z, yaw, pitch, ty, r, model.brakePorts[2]!, 0, 0);
      portVs[0]!.set(P[0]!, P[1]!, P[2]!);
      blastMiddle(fx, muzzleV.x, muzzleV.y, muzzleV.z, dirV, sideV, portVs[0]!);
    } else if (lv === 2) blastSimple(fx, muzzleV.x, muzzleV.y, muzzleV.z, dirV);
  };
  const effectsForEject = (i: number) => {
    const yaw = bankT.yaw[i]!;
    const pitch = bankT.pitch[i]!;
    barrelPoint(P, 0, bankT.px[i]!, bankT.py[i]!, bankT.pz[i]!, yaw, pitch, model.trunnionY, bankT.rOff[i]!, ...model.ejectPort);
    ejectV.set(P[0]!, P[1]!, P[2]!);
    sideV.set(Math.sin(yaw), 0, Math.cos(yaw));
    dirV.set(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.sin(yaw) * Math.cos(pitch));
    casings.eject(ejectV, sideV, dirV, rnd);
    breechVent(fx, ejectV, sideV);
  };

  // ---- benchmark
  let bench: null | {
    segs: Array<{ name: string; view: CamView }>;
    k: number;
    phase: 'move' | 'hold';
    t: number;
    samples: Sample[];
    rows: Row[];
    resolve: (r: Results) => void;
  } = null;

  const meta = (): Meta => ({
    date: new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }),
    turrets: s.count,
    aliens: sim.population,
    mode: s.perTurret ? 'per-turret meshes' : 'instanced',
    quality: s.quality,
    dpr: renderer.getPixelRatio(),
    dprForced: DPR_FORCED !== null,
    canvas: [canvas.width, canvas.height],
    css: [window.innerWidth, window.innerHeight],
    renderer: stress.renderer,
    userAgent: navigator.userAgent,
    thresholds: STRESS_THRESHOLDS,
  });

  stress.runBenchmark = () =>
    new Promise<Results>((resolve) => {
      if (s.compare) setCompare(false);
      resultsEl.classList.remove('show');
      s.paused = false;
      s.timeScale = 1;
      cam.controls.enabled = false;
      const segs = (['close', 'game', 'mid', 'far'] as const).map((p) => ({ name: { close: 'close-up', game: 'game cam', mid: 'mid zoom', far: 'full zoom' }[p], view: presets[p] }));
      bench = { segs, k: 0, phase: 'move', t: 0, samples: [], rows: [], resolve };
      cam.go(segs[0]!.view);
      s.preset = 'close';
      progress.classList.add('show');
      ui.refresh();
    });

  // ---- loop state
  const timer = new Timer();
  const frustum = new Frustum();
  const pv = new Matrix4();
  const sphere = new Sphere();
  const _v = new Vector3();
  const res = { shot: null as ShotRecord | null, eject: false };
  let simT = 0;
  let frames = 0;
  let hudAt = 0;
  let lastTs = -1;
  const cpuHist: number[] = [];
  let fpsWindow: number[] = [];

  setCount(300);
  setQuality('high');
  setPreset('game', true);
  cam.update(0);

  // compile every program up front: make each batch visible with one instance
  loading.textContent = 'Compiling shaders…';
  for (const l of turrets.levels)
    for (const m of l.meshes) {
      m.count = 1;
      m.visible = true;
    }
  lighting.update(cam.camera, cam.distance);
  await renderer.compileAsync(scene, cam.camera);
  for (const l of turrets.levels)
    for (const m of l.meshes) {
      m.count = 0;
      m.visible = false;
    }

  const tick = (ts: number) => {
    requestAnimationFrame(tick);
    const start = performance.now();
    const interval = lastTs < 0 ? 16.7 : ts - lastTs;
    lastTs = ts;
    timer.update();
    const dt = Math.min(0.05, timer.getDelta());
    const sdt = s.paused ? 0 : dt * s.timeScale;
    simT += sdt;
    renderer.info.reset();
    cam.update(dt);
    const camera = cam.camera;
    camera.updateMatrixWorld();
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    const cp = camera.position;
    const n = s.count;

    // aliens move; the grid indexes them for target search and shell hits
    sim.update(sdt);
    grid.build(sim.view);

    // detail level and visibility per turret
    const counts = [0, 0, 0, 0];
    let culled = 0;
    for (let i = 0; i < n; i++) {
      const x = bankT.px[i]!;
      const y = bankT.py[i]! + 0.8;
      const z = bankT.pz[i]!;
      const d = Math.hypot(x - cp.x, y - cp.y, z - cp.z);
      level[i] = s.force ?? chooseLevel(level[i]!, d);
      sphere.center.set(x, y, z);
      // generous radius: a turret just outside the view still casts its shadow into it
      sphere.radius = level[i]! <= 1 ? 4 : 1.8;
      vis[i] = frustum.intersectsSphere(sphere) ? 1 : 0;
      if (vis[i]) counts[level[i]!]!++;
      else culled++;
    }

    // fire control: every frame for visible turrets at full or middle detail, every 2nd frame at
    // simple detail, every 4th frame for icons and turrets outside the view (staggered by index)
    let updates = 0;
    for (let i = 0; i < n; i++) {
      acc[i]! += sdt;
      if (acc[i]! <= 0) continue;
      const lv = level[i]!;
      const cad = !vis[i] ? 4 : lv <= 1 ? 1 : lv === 2 ? 2 : 4;
      if ((frames + i) % cad !== 0) continue;
      bankT.update(i, acc[i]!, sim.view, grid, res);
      acc[i] = 0;
      updates++;
      if (res.shot) {
        const sh = res.shot;
        shells.fire(sh.from[0], sh.from[1], sh.from[2], sh.vel[0], sh.vel[1], sh.vel[2]);
        shotsWindow.push(simT);
        if (vis[i]) effectsForShot(i, lv);
      }
      if (res.eject && vis[i] && lv === 0) effectsForEject(i);
    }
    shells.update(sdt, sim.view, grid, groundH, onShellHit);
    casings.update(sdt, groundH);
    lights.update(sdt);
    wrecks.update(sdt, (slot) => stopBurning(slot));
    for (let k = burning.length - 1; k >= 0; k--) if (wrecks.age[burning[k]!.slot]! > 9) stopBurning(burning[k]!.slot);

    // drawing
    const wppd = (2 * Math.tan((camera.fov * DEG) / 2)) / Math.max(1, canvas.clientHeight);
    turrets.begin();
    if (s.bands) badges.begin();
    for (let i = 0; i < n; i++) {
      if (!vis[i]) continue;
      const x = bankT.px[i]!;
      const y = bankT.py[i]!;
      const z = bankT.pz[i]!;
      let yaw = bankT.yaw[i]!;
      let pitch = bankT.pitch[i]!;
      let rec = bankT.rOff[i]!;
      let lv = level[i]!;
      if (s.compare) {
        if (i === cmp.d) continue;
        if (i === cmp.c) {
          yaw = cmp.yaw;
          pitch = cmp.pitch;
          rec = 0;
          lv = 0;
        }
      }
      const glow = 4.5 + 14 * bankT.pulse(i);
      const dist = Math.hypot(x - cp.x, y + 0.4 - cp.y, z - cp.z);
      const iconScale = Math.max(1, 9 * wppd * dist);
      if (!s.perTurret) turrets.push(lv, frame, x, y, z, yaw, pitch, rec, glow, iconScale);
      else {
        const r = rigs[i]!;
        r.root.position.set(x, y, z);
        r.setPose(yaw, pitch, rec);
        if (r.lod !== RIG_LOD[lv]) r.setLod(RIG_LOD[lv]!);
        r.updateIcon(wppd * dist);
        r.root.visible = true;
      }
      if (s.bands) badges.push(x, y + 2.3, z, lv);
    }
    if (s.perTurret) for (let i = 0; i < n; i++) if (!vis[i]) rigs[i]!.root.visible = false;
    turrets.commit();
    if (s.compare) {
      compareRig.setPose(cmp.yaw, cmp.pitch, 0);
      compareRig.setLod('full');
    }
    badges.mesh.visible = s.bands;
    if (s.bands) badges.commit(wppd, 26);
    const aliensDrawn = alienDraw.update(sim, simT, frustum);
    alienDraw.setWrecks(wrecks);
    tracers.update(shells, cp, wppd, 2.2);
    if (s.compare) tracers.mesh.visible = false;
    casingMesh.update(casings);
    fx.update(sdt, camera);
    const q = QUALITY[s.quality];
    lighting.update(camera, Math.max(8, cam.distance), Math.min(camera.far, cam.distance * q.shadowReach + 20));
    post.render(dt);

    // comparison captions
    if (s.compare) {
      [cmp.c, cmp.d].forEach((i, k) => {
        const v = _v.set(sites[i]!.x, sites[i]!.y - 0.25, sites[i]!.z).project(camera);
        const r = canvas.getBoundingClientRect();
        caps[k]!.style.left = `${r.left + ((v.x + 1) / 2) * r.width}px`;
        caps[k]!.style.top = `${r.top + ((1 - v.y) / 2) * r.height}px`;
      });
    }

    // stats
    const cpuMs = performance.now() - start;
    cpuHist.push(cpuMs);
    if (cpuHist.length > 120) cpuHist.shift();
    fpsWindow.push(start);
    fpsWindow = fpsWindow.filter((t) => start - t < 1000);
    shotsWindow = shotsWindow.filter((t) => simT - t < 1);
    while (killTimes.length && simT - killTimes[0]! > 1) killTimes.shift();
    frames++;
    const info = renderer.info.render;
    const usage = fx.usage;
    const turretDraws = s.perTurret ? -1 : turrets.drawCalls;
    stress.stats = {
      fps: fpsWindow.length,
      cpuMs: cpuHist.reduce((a, b) => a + b, 0) / cpuHist.length,
      calls: info.calls,
      triangles: info.triangles,
      turretDraws,
      turretTriangles: s.perTurret ? -1 : turrets.trianglesSubmitted,
      levels: counts,
      culled,
      aliensAlive: sim.alive,
      aliensDrawn,
      shells: shells.n,
      smoke: usage.smoke,
      glow: usage.glow,
      casings: casings.n,
      wrecks: wrecks.count,
      lights: lights.active,
      shotsPerS: shotsWindow.length,
      killsPerS: killTimes.length,
      updates,
      frames,
      simT,
    };

    if (bench) {
      const b = bench;
      if (b.phase === 'move') {
        b.t += dt;
        if (b.t >= BENCH_MOVE) {
          b.phase = 'hold';
          b.t = 0;
          b.samples = [];
        }
      } else {
        b.samples.push({ interval, cpu: cpuMs, calls: info.calls, triangles: info.triangles, levels: counts, culled, aliensDrawn, aliensAlive: sim.alive, shells: shells.n, particles: usage.smoke + usage.glow, turretDraws: Math.max(0, turretDraws), updates });
        b.t += interval / 1000;
        if (b.t >= BENCH_HOLD) {
          b.rows.push(summarise(b.segs[b.k]!.name, b.samples));
          b.k++;
          if (b.k < b.segs.length) {
            b.phase = 'move';
            b.t = 0;
            cam.go(b.segs[b.k]!.view);
            s.preset = (['close', 'game', 'mid', 'far'] as const)[b.k]!;
          } else {
            const m = meta();
            const results: Results = { meta: m, rows: b.rows, text: formatResults(m, b.rows) };
            stress.results = results;
            pre.textContent = results.text;
            resultsEl.classList.add('show');
            progress.classList.remove('show');
            cam.controls.enabled = true;
            bench = null;
            b.resolve(results);
          }
        }
      }
      if (bench) progress.textContent = `Benchmark: ${bench.segs[bench.k]!.name} · ${bench.phase === 'move' ? 'moving' : `${bench.t.toFixed(1)} / ${BENCH_HOLD} s`} · segment ${bench.k + 1} of ${bench.segs.length}`;
    }

    if (start - hudAt > 250) {
      hudAt = start;
      ui.refresh();
      const st = stress.stats;
      const modeCounts = [0, 0, 0];
      for (let i = 0; i < n; i++) modeCounts[bankT.mode[i]!]!++;
      ui.setReadout(
        [
          ['fps', `${st.fps}`],
          ['frame CPU', `${(st.cpuMs as number).toFixed(2)} ms`],
          ['draw calls (all passes)', `${info.calls}`],
          ['triangles (all passes)', `${(info.triangles / 1e6).toFixed(2)} M`],
          ['turret batches drawn', s.perTurret ? 'per-object' : `${turretDraws} · ${((st.turretTriangles as number) / 1e6).toFixed(2)} M tris`],
          ['turrets F / M / S / I', `${counts.join(' / ')} · ${culled} off view`],
          ['fire control', MODE_NAMES.map((m, k) => `${modeCounts[k]} ${m}`).join(' · ')],
          ['updates this frame', `${updates} of ${n}`],
          ['aliens alive / drawn', `${sim.alive} / ${aliensDrawn}`],
          ['shots / kills per s', `${st.shotsPerS} / ${st.killsPerS}`],
          ['shells in flight', `${shells.n} / ${shells.cap}`],
          ['particles smoke / glow', `${usage.smoke} / ${usage.glow} (cap ${usage.smokeCap} each)`],
          ['casings / wrecks', `${casings.n} / ${wrecks.count}`],
          ['view', `${renderer.getPixelRatio()} dpr · ${canvas.width}×${canvas.height}`],
        ],
        `${s.count} turrets · ${s.perTurret ? 'W20 per-object meshes' : 'instanced'} · ${s.quality} · levels ${levels.map((l) => `${l.name} ${l.triangles.toLocaleString('en-GB')}`).join(', ')} triangles<br>${stress.renderer}`,
      );
    }
    if (frames === 5) {
      loading.remove();
      stress.ready = true;
    }
  };

  stress.api = {
    count: ((n: number) => setCount(n)) as never,
    quality: ((q: StressQuality) => setQuality(q)) as never,
    perTurret: ((v: boolean) => setPerTurret(v)) as never,
    preset: ((p: PresetName, instant = false) => setPreset(p, instant)) as never,
    cam: ((v: CamView) => {
      s.preset = 'free';
      cam.go(v, true);
    }) as never,
    camNow: (() => cam.now()) as never,
    pause: ((v: boolean) => (s.paused = v)) as never,
    timeScale: ((v: number) => (s.timeScale = v)) as never,
    bands: ((v: boolean) => (s.bands = v)) as never,
    compare: ((v: boolean) => setCompare(v)) as never,
    forceLevel: ((l: number | null) => {
      s.force = l;
      level.fill(l ?? LEVEL_NEW);
    }) as never,
    /** Frame intervals and CPU time over `seconds` (no camera move). */
    measure: ((seconds: number) =>
      new Promise((resolve) => {
        const iv: number[] = [];
        const cpu: number[] = [];
        let last = -1;
        const t0 = performance.now();
        const step = (ts: number) => {
          if (last >= 0) {
            iv.push(ts - last);
            cpu.push(stress.stats.cpuMs as number);
          }
          last = ts;
          if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(step);
          else {
            const sum = iv.reduce((a, b) => a + b, 0);
            const sorted = [...iv].sort((a, b) => a - b);
            resolve({ fps: iv.length / (sum / 1000), low1: 1000 / sorted[Math.floor(0.99 * (sorted.length - 1))]!, frameMs: sum / iv.length, calls: stress.stats.calls, triangles: stress.stats.triangles });
          }
        };
        requestAnimationFrame(step);
      })) as never,
    /** Diagnosis switches: turn parts of the frame off to find the bottleneck. */
    diag: ((o: { shadows?: boolean; ao?: boolean; bloom?: boolean; terrain?: boolean; aliens?: boolean; turrets?: boolean; particles?: boolean; terrainShadow?: boolean }) => {
      if (o.shadows !== undefined) lighting.sun.castShadow = o.shadows;
      if (o.ao !== undefined) post.ao.enabled = o.ao;
      if (o.bloom !== undefined) post.apply({ ...QUALITY[s.quality], ao: post.ao.enabled ? QUALITY[s.quality].ao : 'off', bloom: o.bloom });
      if (o.terrain !== undefined) terrain.mesh.visible = o.terrain;
      if (o.terrainShadow !== undefined) terrain.mesh.castShadow = o.terrainShadow;
      if (o.aliens !== undefined) alienDraw.group.visible = o.aliens;
      if (o.turrets !== undefined) turretGroup.visible = o.turrets;
      if (o.particles !== undefined) fx.smokeMesh.visible = fx.glowMesh.visible = o.particles;
    }) as never,
    levels: (() => levels.map((l) => ({ name: l.name, triangles: l.triangles, batches: l.batches.length, shadowBatches: l.batches.filter((b) => b.castShadow).length }))) as never,
    presets: (() => presets) as never,
    lanes: (() => LANES.map((l) => l.name)) as never,
    sites: (() => sites.slice(0, s.count).map((p) => [p.x, p.y, p.z])) as never,
    thresholds: (() => STRESS_THRESHOLDS) as never,
    levelNames: (() => LEVEL_NAMES) as never,
  };
  ui.refresh();
  requestAnimationFrame(tick);
}

main().catch((e) => {
  stress.errors.push(String(e?.stack ?? e));
  const l = document.getElementById('loading');
  if (l) l.textContent = `Failed: ${e}`;
  console.error(e);
});
