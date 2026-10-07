// W17 look test A — one vista of Bulwark map 1 built from code-made geometry, CC0 photographic
// textures (Poly Haven, ambientCG) and the full lighting stack. W18 look test B adds a gun turret
// source toggle (code-built or a generated GLB; `?turretSource=`, key T). See ../README.md.

import { NoToneMapping, Raycaster, SRGBColorSpace, Scene, Timer, WebGLRenderer } from 'three';
import { TextureBank, type Quality } from './assets/textures.ts';
import { Particles } from './fx/particles.ts';
import { Tracers } from './fx/tracers.ts';
import { createMaterials, rebuildComposites, beltTextureRef } from './models/materials.ts';
import { proceduralSource } from './models/procedural/index.ts';
import { footprintWidth, loadGltfModel, turretSourceInfo, TURRET_SOURCES, withGun, type LoadedGltf, type TurretLod } from './models/gltf.ts';
import type { ModelDef } from './models/types.ts';
import { CameraRig, type View } from './render/camera.ts';
import { Lighting } from './render/lighting.ts';
import { Post } from './render/post.ts';
import { BaseScene } from './scene/base.ts';
import { Wave } from './scene/wave.ts';
import { Hud } from './ui/hud.ts';
import { showcase } from './showcase.ts';
import { buildClutter, buildProps } from './world/props.ts';
import { buildings, conduits, sizeOf, units } from './world/layout.ts';
import { buildTerrain } from './world/terrainMesh.ts';
import { buildWater } from './world/water.ts';

interface Measure {
  seconds: number;
  frames: number;
  fps: number;
  cpuMsAvg: number;
  cpuMsP95: number;
  frameMsAvg: number;
  frameMsP95: number;
  /** GPU time of the whole frame (EXT_disjoint_timer_query_webgl2); -1 when unavailable. */
  gpuMsAvg: number;
  gpuMsP95: number;
  gpuSamples: number;
}

const look = {
  ready: false,
  errors: [] as string[],
  renderer: '',
  quality: 'high' as Quality,
  view: 'reference' as 'reference' | 'strategic',
  stats: {} as Record<string, number>,
  timings: {} as Record<string, number>,
  setQuality: async (_q: Quality) => {},
  setView: (_v: 'reference' | 'strategic', _instant?: boolean) => {},
  measure: async (_s: number): Promise<Measure> => ({ seconds: 0, frames: 0, fps: 0, cpuMsAvg: 0, cpuMsP95: 0, frameMsAvg: 0, frameMsP95: 0, gpuMsAvg: -1, gpuMsP95: -1, gpuSamples: 0 }),
  freeze: false,
  cam: (_v: View) => {},
  /** W18: active gun turret source, its GLB stats, and the switch. */
  turretSource: 'code',
  turretInfo: null as null | { triangles: number; bytes: number; textureSize: number; lod: TurretLod },
  setTurretSource: async (_id: string) => {},
};
(window as unknown as { __look: typeof look }).__look = look;
window.addEventListener('error', (e) => look.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => look.errors.push(String(e.reason)));

async function main(): Promise<void> {
  const t0 = performance.now();
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const loading = document.getElementById('loading')!;
  const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.info.autoReset = false;
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  look.renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));

  const bank = new TextureBank();
  bank.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  await bank.load((d, n) => (loading.textContent = `Loading textures… ${d}/${n}`));
  look.timings.texturesMs = performance.now() - t0;

  if (new URLSearchParams(location.search).has('turret')) {
    await showcase(renderer, bank, canvas, () => {
      loading.remove();
      look.ready = true;
    });
    return;
  }

  const scene = new Scene();
  const lighting = new Lighting(scene, renderer);
  await lighting.loadEnvironment(bank.hdrUrl);
  const mats = createMaterials(bank);
  loading.textContent = 'Building terrain…';
  await new Promise((r) => setTimeout(r, 0));
  const terrain = buildTerrain(bank, 720);
  look.timings.terrainMs = terrain.buildMs;
  scene.add(terrain.mesh);
  const water = buildWater();
  bank.derived.add(water.normal);
  scene.add(water.mesh);
  scene.add(buildProps(mats));
  scene.add(
    buildClutter(
      mats,
      buildings.map((b) => ({ x0: b.tx, z0: b.ty, x1: b.tx + sizeOf(b.kind), z1: b.ty + sizeOf(b.kind) })).concat(units.map((u) => ({ x0: u.x - 1.5, z0: u.z - 1.5, x1: u.x + 1.5, z1: u.z + 1.5 }))),
      conduits,
    ),
  );

  const fx = new Particles();
  bank.derived.add(fx.atlas);
  const tracers = new Tracers();
  scene.add(fx.smokeMesh, fx.glowMesh, tracers.mesh);
  const code = proceduralSource(mats);
  // gun turret source: code-built (W17) or a generated GLB fitted to the same footprint
  const params = new URLSearchParams(location.search);
  const lod: TurretLod = params.get('turretLod') === '5k' ? '5k' : '20k';
  const codeGun = code.building('gun');
  const codeFootprint = footprintWidth(codeGun);
  const gunCache = new Map<string, Promise<LoadedGltf>>();
  const gunModel = async (id: string): Promise<{ def: ModelDef; loaded: LoadedGltf | null }> => {
    const info = turretSourceInfo(id);
    if (!info.urls) return { def: codeGun, loaded: null };
    let p = gunCache.get(info.id);
    if (!p) gunCache.set(info.id, (p = loadGltfModel(`gun:${info.id}`, info.urls[lod], codeFootprint, { yaw: info.yaw, anisotropy: bank.anisotropy, override: info.material === 'ivory' ? mats.ivory : undefined })));
    const loaded = await p;
    return { def: loaded.def, loaded };
  };
  const first = turretSourceInfo(params.get('turretSource'));
  loading.textContent = `Loading gun turret (${first.label})…`;
  const firstGun = await gunModel(first.id);
  look.turretSource = first.id;
  look.turretInfo = firstGun.loaded ? { triangles: firstGun.loaded.triangles, bytes: firstGun.loaded.bytes, textureSize: firstGun.loaded.textureSize, lod } : null;
  const src = withGun(code, firstGun.def, first.label);
  const base = new BaseScene(src, mats, fx, tracers);
  const wave = new Wave(src, mats, fx);
  scene.add(base.group, wave.group);

  const rig = new CameraRig(canvas, window.innerWidth / window.innerHeight);
  const post = new Post(renderer, scene, rig.camera, canvas.width, canvas.height);
  post.setQuality('high');
  const hud = new Hud();
  const ray = new Raycaster();

  // sun colour drives the smoke shading
  fx.smokeUniforms.uSun.value.copy(lighting.sun.color).multiplyScalar(0.62);
  fx.smokeUniforms.uAmb.value.set(0.34, 0.3, 0.28);

  const setQuality = async (q: Quality) => {
    look.quality = q;
    lighting.setShadowSize(q === 'high' ? 4096 : 2048);
    post.setQuality(q);
    (terrain.material.userData.uniforms as { uDetail: { value: number } }).uDetail.value = q === 'high' ? 1 : 0;
    await bank.setQuality(q, q === 'high' ? Math.min(16, renderer.capabilities.getMaxAnisotropy()) : 4);
    rebuildComposites(bank);
  };
  const setView = (v: 'reference' | 'strategic', instant = false) => {
    look.view = v;
    rig.go(v, instant);
  };
  const setTurretSource = async (id: string) => {
    const info = turretSourceInfo(id);
    const g = await gunModel(info.id);
    base.replaceModel('gun', g.def);
    look.turretSource = info.id;
    look.turretInfo = g.loaded ? { triangles: g.loaded.triangles, bytes: g.loaded.bytes, textureSize: g.loaded.textureSize, lod } : null;
    const u = new URL(location.href);
    u.searchParams.set('turretSource', info.id);
    history.replaceState(null, '', u);
    await renderer.compileAsync(scene, rig.camera);
  };
  look.setTurretSource = setTurretSource;
  hud.onTurret.push((id) => void setTurretSource(id).catch((e) => look.errors.push(String(e))));
  look.setQuality = setQuality;
  look.setView = setView;
  look.cam = (v: View) => {
    rig.go(rig.current, true);
    rig.apply(v);
  };
  hud.onQuality.push((q) => void setQuality(q));
  hud.onView.push((v) => setView(v));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'v' || e.key === 'V') setView(look.view === 'reference' ? 'strategic' : 'reference');
    if (e.key === 'q' || e.key === 'Q') void setQuality(look.quality === 'high' ? 'medium' : 'high');
    if (e.key === 't' || e.key === 'T') {
      const i = TURRET_SOURCES.findIndex((s) => s.id === look.turretSource);
      void setTurretSource(TURRET_SOURCES[(i + 1) % TURRET_SOURCES.length]!.id).catch((err) => look.errors.push(String(err)));
    }
  });
  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    rig.camera.aspect = window.innerWidth / window.innerHeight;
    rig.camera.updateProjectionMatrix();
    post.setSize(canvas.width, canvas.height);
  });

  loading.textContent = 'Compiling shaders…';
  rig.update(0);
  lighting.update(rig.camera, rig.distance);
  await renderer.compileAsync(scene, rig.camera);
  look.timings.startupMs = performance.now() - t0;

  // ---- loop
  const timer = new Timer();
  let simT = 0;
  const cpu: number[] = [];
  const frameTimes: number[] = [];
  let lastFrame = performance.now();
  let frames = 0;
  let hudAt = 0;
  let mmAt = 0;
  let fpsWindow: number[] = [];
  let recording: { cpu: number[]; frame: number[]; gpu: number[]; start: number } | null = null;
  // GPU frame time from timer queries (resolved a few frames later, disjoint results dropped)
  const gl2 = gl as WebGL2RenderingContext;
  const tq = gl2.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const pendingQ: WebGLQuery[] = [];
  const gpu: number[] = [];

  const rtBytes = () => {
    const w = canvas.width;
    const h = canvas.height;
    const sm = lighting.sun.shadow.mapSize.x;
    const env = lighting.envRT ? lighting.envRT.width * lighting.envRT.height * 8 : 0;
    const aoK = look.quality === 'high' ? 1 : 0.25;
    return w * h * 8 * 2 + w * h * 4 + w * h * 8 * 4 * aoK + w * h * 8 * 0.5 + w * h * 4 * 2 + sm * sm * 4 + env;
  };

  const tick = () => {
    requestAnimationFrame(tick);
    const start = performance.now();
    timer.update();
    const dt = Math.min(0.05, timer.getDelta());
    if (!look.freeze) simT += dt;
    renderer.info.reset();
    rig.update(dt);
    const sdt = look.freeze ? 0 : dt;
    wave.update(simT, sdt);
    base.update(simT, sdt, wave.aliens);
    tracers.update(sdt, simT);
    fx.update(sdt, rig.camera);
    water.update(simT);
    const bt = beltTextureRef();
    if (bt) bt.offset.y = -simT * 0.25;
    lighting.update(rig.camera, rig.distance);
    let q: WebGLQuery | null = null;
    if (tq && pendingQ.length < 6) {
      q = gl2.createQuery();
      gl2.beginQuery(tq.TIME_ELAPSED_EXT, q!);
    }
    post.render(dt);
    if (q && tq) {
      gl2.endQuery(tq.TIME_ELAPSED_EXT);
      pendingQ.push(q);
    }
    while (tq && pendingQ.length && gl2.getQueryParameter(pendingQ[0]!, gl2.QUERY_RESULT_AVAILABLE)) {
      const pq = pendingQ.shift()!;
      const disjoint = gl2.getParameter(tq.GPU_DISJOINT_EXT);
      const ns = gl2.getQueryParameter(pq, gl2.QUERY_RESULT) as number;
      gl2.deleteQuery(pq);
      if (!disjoint) {
        gpu.push(ns / 1e6);
        if (gpu.length > 120) gpu.shift();
        recording?.gpu.push(ns / 1e6);
      }
    }
    const end = performance.now();
    const cpuMs = end - start;
    const frameMs = start - lastFrame;
    lastFrame = start;
    cpu.push(cpuMs);
    frameTimes.push(frameMs);
    if (cpu.length > 240) cpu.shift();
    if (frameTimes.length > 240) frameTimes.shift();
    fpsWindow.push(start);
    fpsWindow = fpsWindow.filter((t) => start - t < 1000);
    if (recording) {
      recording.cpu.push(cpuMs);
      recording.frame.push(frameMs);
    }
    frames++;
    const info = renderer.info.render;
    look.stats = {
      fps: fpsWindow.length,
      cpuMs: cpu.reduce((a, b) => a + b, 0) / cpu.length,
      gpuMs: gpu.length ? gpu.reduce((a, b) => a + b, 0) / gpu.length : -1,
      calls: info.calls,
      triangles: info.triangles,
      texMB: bank.memoryBytes() / 1048576,
      rtMB: rtBytes() / 1048576,
      particles: fx.count,
      frames,
    };
    if (start - hudAt > 250) {
      hudAt = start;
      hud.setStats({
        fps: look.stats.fps!,
        cpuMs: look.stats.cpuMs!,
        gpuMs: look.stats.gpuMs!,
        calls: info.calls,
        triangles: info.triangles,
        texMB: look.stats.texMB!,
        rtMB: look.stats.rtMB!,
        textures: bank.count,
        renderer: look.renderer,
        quality: look.quality,
        view: look.view,
        particles: fx.count,
        turretSource: look.turretSource,
        turretSources: TURRET_SOURCES.map((s) => ({ id: s.id, label: s.label })),
      });
    }
    if (start - mmAt > 200) {
      mmAt = start;
      hud.drawMinimap(
        wave.aliens.map((a) => ({ kind: a.kind, x: a.pos.x, z: a.pos.z, alive: a.alive })),
        rig.camera,
        ray,
      );
    }
    if (frames === 5) {
      loading.remove();
      look.ready = true;
    }
  };

  look.measure = (seconds: number) =>
    new Promise<Measure>((resolve) => {
      recording = { cpu: [], frame: [], gpu: [], start: performance.now() };
      setTimeout(() => {
        const r = recording!;
        recording = null;
        const el = (performance.now() - r.start) / 1000;
        const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] ?? 0;
        const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
        resolve({ seconds: el, frames: r.cpu.length, fps: r.cpu.length / el, cpuMsAvg: avg(r.cpu), cpuMsP95: p95(r.cpu), frameMsAvg: avg(r.frame), frameMsP95: p95(r.frame), gpuMsAvg: r.gpu.length ? avg(r.gpu) : -1, gpuMsP95: r.gpu.length ? p95(r.gpu) : -1, gpuSamples: r.gpu.length });
      }, seconds * 1000);
    });

  tick();
}

main().catch((e) => {
  look.errors.push(String(e?.stack ?? e));
  const l = document.getElementById('loading');
  if (l) l.textContent = `Failed: ${e}`;
  console.error(e);
});
