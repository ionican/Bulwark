// W20 gun-turret test bench (/bench.html): the code-built gun turret at full detail on a small
// canyon range, aiming, firing and killing alien machines, with camera presets, slow motion,
// manual aim, detail levels, wireframe, pivots, a construction animation and a side-by-side view
// against the concept image. Lighting, post-processing, haze, terrain material, aliens and
// particles are W17's. See ../../README.md (W20 section).

import { NoToneMapping, SRGBColorSpace, Scene, Timer, Vector2, Vector3, WebGLRenderer, Mesh, RingGeometry, MeshBasicMaterial, AdditiveBlending, Color } from 'three';
import { LOD_THRESHOLDS, chooseLod } from '../../../game/src/render/lod.ts';
import { TextureBank } from '../assets/textures.ts';
import { Particles } from '../fx/particles.ts';
import { createMaterials } from '../models/materials.ts';
import { Lighting } from '../render/lighting.ts';
import { Post } from '../render/post.ts';
import type { AlienKind } from '../world/layout.ts';
import { DEG, ELEVATION, TRAVERSE } from './aim.ts';
import { BenchCamera, PRESETS, type Preset } from './benchCamera.ts';
import { GUN, TurretBrain } from './brain.ts';
import { Construction } from './construction.ts';
import { Casings, Shells, breechVent, muzzleBlast, muzzleLight } from './effects.ts';
import { buildRange, rangeHeight, rayGround } from './range.ts';
import { Recoil, RECOIL } from './recoil.ts';
import { createTurretMats } from './surface.ts';
import { Targets } from './targets.ts';
import { buildTurret } from './turretModel.ts';
import { TurretRig, type Lod } from './turretRig.ts';
import { BenchUi } from './ui.ts';

const CONCEPT_URL = new URL('../../reference/02-gun-turret.png', import.meta.url).href;
/**
 * Concept view: the camera sits where W17's low sun lights the faces turned to it from the front
 * left, as the concept is lit; the turret is turned on its footing so a bolted foot faces the
 * viewer and the barrel points to the viewer's right and slightly towards them, as in the image.
 */
const CONCEPT_POSE = { root: -25 * DEG, yaw: -118 * DEG, pitch: 4 * DEG };
const LOD_NAMES: Lod[] = ['full', 'simple', 'icon'];

interface Measure {
  seconds: number;
  frames: number;
  fps: number;
  cpuMsAvg: number;
  cpuMsP95: number;
  frameMsAvg: number;
}

const bench = {
  ready: false,
  errors: [] as string[],
  renderer: '',
  stats: {} as Record<string, number>,
  state: {} as Record<string, unknown>,
  api: {} as Record<string, (...a: never[]) => unknown>,
};
(window as unknown as { __bench: typeof bench }).__bench = bench;
window.addEventListener('error', (e) => bench.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => bench.errors.push(String(e.reason)));

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const loading = document.getElementById('loading')!;
  const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.info.autoReset = false;
  renderer.localClippingEnabled = true;
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  bench.renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));

  const bank = new TextureBank();
  bank.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  await bank.load((d, n) => (loading.textContent = `Loading textures… ${d}/${n}`));

  const scene = new Scene();
  const lighting = new Lighting(scene, renderer);
  await lighting.loadEnvironment(bank.hdrUrl, 0.55);
  const mats = createMaterials(bank);
  const tm = createTurretMats(bank);
  loading.textContent = 'Building range…';
  await new Promise((r) => setTimeout(r, 0));
  const range = buildRange(bank, mats, GUN.range);
  scene.add(range.group);

  // ---- turret
  const model = buildTurret(tm);
  const rig = new TurretRig(model, tm);
  scene.add(rig.root);
  const brain = new TurretBrain([0, 0, 0]);
  brain.yaw.angle = 20 * DEG;
  const recoil = new Recoil();
  const fx = new Particles();
  bank.derived.add(fx.atlas);
  const construction = new Construction(rig, fx);
  // line-up copies (simple, icon) for the detail-level comparison
  const lineup = [new TurretRig(model, tm, 'simple'), new TurretRig(model, tm, 'icon')];
  lineup[0]!.root.position.set(3.1, 0, 0);
  lineup[1]!.root.position.set(6.2, 0, 0);
  for (const l of lineup) {
    l.root.visible = false;
    l.iconFixed = true;
    scene.add(l.root);
  }

  // ---- effects and targets
  const shells = new Shells();
  const casings = new Casings(tm.brass);
  const flash = muzzleLight();
  scene.add(fx.smokeMesh, fx.glowMesh, shells.mesh, casings.mesh, flash);
  fx.smokeUniforms.uSun.value.copy(lighting.sun.color).multiplyScalar(0.62);
  fx.smokeUniforms.uAmb.value.set(0.34, 0.3, 0.28);
  const targets = new Targets(mats, fx);
  scene.add(targets.group);
  const reticle = new Mesh(new RingGeometry(0.35, 0.5, 32).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: new Color(0.4, 2.2, 3), transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false, toneMapped: false }));
  reticle.visible = false;
  scene.add(reticle);
  targets.onAlienShot.push((from) => {
    const to = new Vector3(0, GUN.trunnionHeight + (Math.random() - 0.3) * 0.4, 0).add(new Vector3((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5));
    const dir = to.clone().sub(from).normalize();
    // stop at the armour, roughly 0.6 tiles out from the axis
    const end = to.clone().addScaledVector(dir, -0.55);
    shells.enemyBolt([from.x, from.y, from.z], [end.x, end.y, end.z], 18, (at) => fx.sparks(at.x, at.y, at.z, 6, 4, dir.clone().negate()));
  });

  // ---- camera, post, UI
  const cam = new BenchCamera(canvas, window.innerWidth / window.innerHeight);
  const post = new Post(renderer, scene, cam.camera, canvas.width, canvas.height);
  post.setQuality('high');
  const conceptImg = document.createElement('img');
  conceptImg.id = 'concept';
  conceptImg.src = CONCEPT_URL;
  conceptImg.alt = 'Concept image look/reference/02-gun-turret.png';
  document.body.append(conceptImg);
  const caps = {
    left: cap('W20 code-built turret · live render, concept camera', 'cmp'),
    right: cap('Concept · reference/02-gun-turret.png (910 × 512)', 'cmp'),
    lod: LOD_NAMES.map((n) => cap(n, 'lod')),
  };

  const s = {
    paused: false,
    timeScale: 1,
    lodMode: 'full' as Lod | 'auto',
    autoLevel: 255,
    wire: false,
    pivots: false,
    compare: false,
    lineup: false,
    preset: 'close' as Preset,
    lights: 1,
    flash: 0,
  };

  const resize = () => {
    let w = window.innerWidth;
    let h = window.innerHeight;
    if (s.compare) {
      w = Math.round(window.innerWidth / 2);
      h = Math.round((w * 512) / 910);
    }
    renderer.setSize(w, h, false);
    cam.camera.aspect = w / h;
    cam.camera.updateProjectionMatrix();
    post.setSize(canvas.width, canvas.height);
  };
  window.addEventListener('resize', resize);

  const setPreset = (p: Preset, instant = false) => {
    s.preset = p;
    cam.go(PRESETS[p], instant);
  };
  const setCompare = (on: boolean) => {
    s.compare = on;
    document.body.classList.toggle('compare', on);
    resize();
    if (on) {
      setLineup(false);
      setPreset('concept', true);
    }
    targets.group.visible = !on;
    range.ring.visible = !on;
    rig.root.rotation.y = on ? CONCEPT_POSE.root : 0;
    brain.enabled = !on && !construction.active;
  };
  const setLineup = (on: boolean) => {
    s.lineup = on;
    document.body.classList.toggle('lineup', on);
    for (const l of lineup) l.root.visible = on;
    brain.enabled = !on && !construction.active;
    if (on) {
      if (s.compare) setCompare(false);
      setPreset('lineup');
    }
  };
  const setLod = (l: Lod | 'auto') => {
    s.lodMode = l;
    s.autoLevel = 255;
  };
  const setWire = (on: boolean) => {
    s.wire = on;
    rig.setWireframe(on);
  };
  const setPivots = (on: boolean) => {
    s.pivots = on;
    rig.setPivots(on);
  };
  const construct = () => {
    if (s.compare) setCompare(false);
    brain.enabled = false;
    construction.start();
  };
  const fire = () => {
    brain.fireOnce = true;
  };
  const setManual = (on: boolean) => {
    brain.manual = on;
    reticle.visible = on && !!brain.manualPoint;
  };

  const ui = new BenchUi([
    {
      title: 'Simulation',
      controls: [
        { id: 'play', label: 'Pause', key: 'Space', state: () => s.paused, run: () => (s.paused = !s.paused) },
        { id: 'ts01', label: '0.1×', key: '1', state: () => s.timeScale === 0.1, run: () => (s.timeScale = 0.1) },
        { id: 'ts025', label: '0.25×', key: '2', state: () => s.timeScale === 0.25, run: () => (s.timeScale = 0.25) },
        { id: 'ts1', label: '1×', key: '3', state: () => s.timeScale === 1, run: () => (s.timeScale = 1) },
      ],
    },
    {
      title: 'Camera',
      controls: [
        { id: 'game', label: 'Game camera', key: 'G', state: () => s.preset === 'game' && !s.compare, run: () => setPreset('game') },
        { id: 'close', label: 'Close-up', key: 'C', state: () => s.preset === 'close' && !s.compare, run: () => setPreset('close') },
        { id: 'compare', label: 'Vs concept', key: 'X', state: () => s.compare, run: () => setCompare(!s.compare) },
      ],
    },
    {
      title: 'Turret',
      controls: [
        { id: 'manual', label: 'Manual aim', key: 'M', state: () => brain.manual, run: () => setManual(!brain.manual) },
        { id: 'fire', label: 'Fire', key: 'F', run: fire },
        { id: 'lead', label: 'Lead target', key: 'L', state: () => brain.lead, run: () => (brain.lead = !brain.lead) },
        { id: 'build', label: 'Construct', key: 'B', state: () => construction.active, run: construct },
      ],
    },
    {
      title: 'Targets',
      controls: [
        { id: 'spawn1', label: 'Spawn one', key: 'T', run: () => void targets.spawn() },
        { id: 'spawnG', label: 'Spawn group', key: 'Y', run: () => targets.spawnGroup(5) },
        { id: 'clear', label: 'Clear', key: 'Del', run: () => targets.clear() },
        { id: 'auto', label: 'Auto waves', key: 'A', state: () => targets.auto, run: () => (targets.auto = !targets.auto) },
      ],
    },
    {
      title: 'Display',
      controls: [
        { id: 'lodFull', label: 'Full', key: 'D', state: () => s.lodMode === 'full', run: () => setLod('full') },
        { id: 'lodSimple', label: 'Simple', state: () => s.lodMode === 'simple', run: () => setLod('simple') },
        { id: 'lodIcon', label: 'Icon', state: () => s.lodMode === 'icon', run: () => setLod('icon') },
        { id: 'lodAuto', label: 'By distance', state: () => s.lodMode === 'auto', run: () => setLod('auto') },
        { id: 'lineup', label: 'Line-up', key: 'U', state: () => s.lineup, run: () => setLineup(!s.lineup) },
        { id: 'wire', label: 'Wireframe', key: 'W', state: () => s.wire, run: () => setWire(!s.wire) },
        { id: 'pivots', label: 'Pivots', key: 'P', state: () => s.pivots, run: () => setPivots(!s.pivots) },
      ],
    },
  ]);

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    const act: Record<string, () => void> = {
      ' ': () => (s.paused = !s.paused),
      '1': () => (s.timeScale = 0.1),
      '2': () => (s.timeScale = 0.25),
      '3': () => (s.timeScale = 1),
      g: () => setPreset('game'),
      c: () => setPreset('close'),
      x: () => setCompare(!s.compare),
      m: () => setManual(!brain.manual),
      f: fire,
      l: () => (brain.lead = !brain.lead),
      b: construct,
      t: () => void targets.spawn(),
      y: () => targets.spawnGroup(5),
      delete: () => targets.clear(),
      backspace: () => targets.clear(),
      a: () => (targets.auto = !targets.auto),
      d: () => setLod(LOD_NAMES[(LOD_NAMES.indexOf(s.lodMode as Lod) + 1) % 3]!),
      u: () => setLineup(!s.lineup),
      w: () => setWire(!s.wire),
      p: () => setPivots(!s.pivots),
    };
    const f = act[k];
    if (f) {
      e.preventDefault();
      f();
      ui.refresh();
    }
  });

  // manual aim: the mouse point on the ground; a click that is not a drag fires
  const ndc = new Vector2();
  let downAt: [number, number] | null = null;
  canvas.addEventListener('pointermove', (e) => {
    if (!brain.manual) return;
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const o = cam.camera.position.clone();
    const d = new Vector3(ndc.x, ndc.y, 0.5).unproject(cam.camera).sub(o).normalize();
    const hit = rayGround(o, d);
    if (hit) {
      brain.manualPoint = [hit.x, hit.y + 0.3, hit.z];
      reticle.position.set(hit.x, hit.y + 0.05, hit.z);
      reticle.visible = true;
    }
  });
  canvas.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
  canvas.addEventListener('pointerup', (e) => {
    if (brain.manual && downAt && e.button === 0 && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 5) fire();
    downAt = null;
  });

  // ---- initial targets: a few already walking in
  targets.spawn('rusher', 0, 32);
  targets.spawn('hunter', 1, 44);
  targets.spawn('breaker', 2, 28);
  targets.spawn('saboteur', 0, 52);

  loading.textContent = 'Compiling shaders…';
  setPreset('close', true);
  cam.update(0);
  lighting.update(cam.camera, cam.distance);
  await renderer.compileAsync(scene, cam.camera);

  // ---- loop
  const timer = new Timer();
  const cpu: number[] = [];
  let fpsWindow: number[] = [];
  let frames = 0;
  let hudAt = 0;
  let simT = 0;
  let recording: { cpu: number[]; frame: number[]; start: number } | null = null;
  let lastFrame = performance.now();
  const tmp = new Vector3();
  const tmp2 = new Vector3();
  const side = new Vector3();
  let killsAtStart = 0;
  const rnd = Math.random;
  /** Screenshot helper: pause the simulation this many sim-seconds after the next shot. */
  let pauseAfterShot: number | null = null;
  let pauseAt: number | null = null;

  const tick = () => {
    requestAnimationFrame(tick);
    const start = performance.now();
    timer.update();
    const dt = Math.min(0.05, timer.getDelta());
    const sdt = s.paused ? 0 : dt * s.timeScale;
    simT += sdt;
    renderer.info.reset();
    cam.update(dt);

    // fire control and the turret's pose
    const shots = brain.update(sdt, targets.brainTargets());
    const eject = recoil.update(sdt);
    let yaw = brain.yaw.angle;
    let pitch = brain.pitch.angle;
    const over = construction.update(sdt, { yaw, pitch });
    s.lights = over ? over.lights : 1;
    if (over) {
      yaw = over.yaw;
      pitch = over.pitch;
    } else if (!brain.enabled && !s.compare && !s.lineup) brain.enabled = true;
    if (s.compare) {
      yaw = CONCEPT_POSE.yaw;
      pitch = CONCEPT_POSE.pitch;
    } else if (s.lineup) {
      // line-up holds one pose so the three levels read side by side
      yaw = -50 * DEG;
      pitch = 6 * DEG;
    }
    rig.setPose(yaw, pitch, recoil.offset);
    for (const l of lineup) l.setPose(yaw, pitch, recoil.offset);
    rig.root.updateMatrixWorld(true);

    if (shots.length && pauseAfterShot !== null) {
      pauseAt = simT + pauseAfterShot;
      pauseAfterShot = null;
    }
    if (pauseAt !== null && simT >= pauseAt) {
      s.paused = true;
      pauseAt = null;
    }
    for (const shot of shots) {
      recoil.fire();
      shells.fire(shot.from, shot.vel);
      const muzzle = rig.muzzleWorld(tmp);
      const dir = rig.barrelDir([1, 0, 0], tmp2);
      rig.barrelDir([0, 0, 1], side);
      const ports = model.brakePorts.map((x) => rig.barrelPoint([x, 0, 0], new Vector3()));
      muzzleBlast(fx, muzzle, dir, side, ports, rnd);
      flash.position.copy(muzzle).addScaledVector(dir, 0.3);
      s.flash = 1;
    }
    if (eject) {
      const at = rig.barrelPoint(model.ejectPort, new Vector3());
      const out = rig.barrelDir([0, 0, 1], new Vector3());
      casings.eject(at, out, rig.barrelDir([1, 0, 0], new Vector3()));
      breechVent(fx, at, out);
    }
    s.flash = Math.max(0, s.flash - sdt * 14);
    flash.intensity = 60 * s.flash * s.flash;
    tm.glow.emissiveIntensity = s.lights * (4.5 + 14 * recoil.pulse);

    targets.update(simT, sdt);
    const tlist = targets.alive.map((a) => ({ id: a.id, pos: [a.aim.x, a.aim.y, a.aim.z] as [number, number, number], radius: a.radius }));
    shells.update(sdt, tlist, (h, friendly) => {
      if (!friendly) return;
      if (h.id !== null) {
        const a = targets.byId(h.id);
        if (a) targets.hit(a, h.at, 1);
      } else {
        fx.sparks(h.at.x, h.at.y, h.at.z, 5, 4);
        fx.explosion(h.at.x, h.at.y - 0.2, h.at.z, 0.25);
      }
    });
    casings.update(sdt);

    // detail level: fixed, or by camera distance with the game's thresholds and hysteresis
    let lod: Lod;
    if (s.lodMode === 'auto') {
      s.autoLevel = chooseLod(s.autoLevel, cam.camera.position.length());
      lod = LOD_NAMES[s.autoLevel]!;
    } else lod = s.lodMode;
    if (rig.lod !== lod) rig.setLod(lod);
    const dist = cam.camera.position.distanceTo(rig.root.position);
    const wpp = (2 * dist * Math.tan((cam.camera.fov * DEG) / 2)) / Math.max(1, canvas.clientHeight);
    rig.updateIcon(wpp);
    for (const l of lineup) l.updateIcon(wpp);

    fx.update(sdt, cam.camera);
    lighting.update(cam.camera, Math.max(8, cam.distance));
    post.render(dt);

    // captions
    if (s.lineup) {
      const pts = [rig.root.position, lineup[0]!.root.position, lineup[1]!.root.position];
      const tris = rig.triangles;
      pts.forEach((p, i) => {
        const v = p.clone().setY(-0.35).project(cam.camera);
        const r = canvas.getBoundingClientRect();
        const el = caps.lod[i]!;
        el.style.left = `${r.left + ((v.x + 1) / 2) * r.width}px`;
        el.style.top = `${r.top + ((1 - v.y) / 2) * r.height}px`;
        el.textContent = `${LOD_NAMES[i]} · ${Math.round(tris[LOD_NAMES[i]!]).toLocaleString('en-GB')} triangles`;
      });
    }
    if (s.compare) {
      const r = canvas.getBoundingClientRect();
      caps.left.style.left = `${r.left + 6}px`;
      caps.left.style.top = `${r.top + 6}px`;
      caps.right.style.left = `${r.right + 6}px`;
      caps.right.style.top = `${r.top + 6}px`;
    }

    // stats
    const end = performance.now();
    const cpuMs = end - start;
    cpu.push(cpuMs);
    if (cpu.length > 120) cpu.shift();
    fpsWindow.push(start);
    fpsWindow = fpsWindow.filter((t) => start - t < 1000);
    if (recording) {
      recording.cpu.push(cpuMs);
      recording.frame.push(start - lastFrame);
    }
    lastFrame = start;
    frames++;
    const info = renderer.info.render;
    bench.stats = { fps: fpsWindow.length, cpuMs: cpu.reduce((a, b) => a + b, 0) / cpu.length, calls: info.calls, triangles: info.triangles, particles: fx.count, frames };
    const tgt = brain.target ? targets.byId(brain.target.id) : undefined;
    bench.state = {
      yaw: brain.yaw.angle / DEG,
      pitch: brain.pitch.angle / DEG,
      wantYaw: brain.wantYaw / DEG,
      wantPitch: brain.wantPitch / DEG,
      mode: construction.active ? 'build' : brain.mode,
      target: tgt ? { id: tgt.id, kind: tgt.kind, dist: Math.hypot(tgt.pos.x, tgt.pos.z), x: tgt.pos.x, z: tgt.pos.z, hp: tgt.hp } : null,
      shots: brain.shots,
      hits: shells.hits,
      kills: targets.kills,
      alive: targets.alive.length,
      wrecks: targets.wreckCount,
      casings: casings.count,
      recoil: recoil.offset,
      lod: rig.lod,
      timeScale: s.timeScale,
      paused: s.paused,
      simT,
      build: construction.active ? construction.t : null,
    };
    if (start - hudAt > 250) {
      hudAt = start;
      ui.refresh();
      const st = bench.state;
      ui.setReadout(
        [
          ['fps', `${bench.stats.fps}`],
          ['frame CPU', `${bench.stats.cpuMs!.toFixed(2)} ms`],
          ['draw calls', `${info.calls}`],
          ['triangles (frame)', info.triangles.toLocaleString('en-GB')],
          ['turret triangles', `${Math.round(rig.triangles[rig.lod]).toLocaleString('en-GB')} (${rig.lod})`],
          ['yaw / pitch', `${(st.yaw as number).toFixed(1)}° / ${(st.pitch as number).toFixed(1)}°`],
          ['wanted', `${(st.wantYaw as number).toFixed(1)}° / ${(st.wantPitch as number).toFixed(1)}°`],
          ['mode', `${st.mode}${brain.lead ? ' · lead' : ' · no lead'}`],
          ['target', tgt ? `${tgt.kind} #${tgt.id} · ${Math.hypot(tgt.pos.x, tgt.pos.z).toFixed(1)} tiles · ${tgt.hp} HP` : '—'],
          ['shots / hits / kills', `${brain.shots} / ${shells.hits} / ${targets.kills}`],
          ['aliens / wrecks', `${targets.alive.length} / ${targets.wreckCount}`],
          ['time', `${s.paused ? 'paused' : `${s.timeScale}×`}`],
        ],
        `Traverse ${(TRAVERSE.maxRate / DEG).toFixed(0)}°/s · elevation ${(ELEVATION.maxRate / DEG).toFixed(0)}°/s, ${(ELEVATION.min! / DEG).toFixed(0)}° to +${(ELEVATION.max! / DEG).toFixed(0)}° · ${(60 / GUN.interval).toFixed(0)} rounds/min · range ${GUN.range} tiles · recoil ${(RECOIL.travel * 2 * 100).toFixed(0)} cm<br>${bench.renderer}`,
      );
    }
    if (frames === 5) {
      loading.remove();
      bench.ready = true;
      killsAtStart = targets.kills;
    }
  };

  const measure = (seconds: number) =>
    new Promise<Measure>((resolve) => {
      recording = { cpu: [], frame: [], start: performance.now() };
      setTimeout(() => {
        const r = recording!;
        recording = null;
        const el = (performance.now() - r.start) / 1000;
        const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
        const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] ?? 0;
        resolve({ seconds: el, frames: r.cpu.length, fps: r.cpu.length / el, cpuMsAvg: avg(r.cpu), cpuMsP95: p95(r.cpu), frameMsAvg: avg(r.frame) });
      }, seconds * 1000);
    });

  (bench as unknown as { scene: Scene }).scene = scene;
  bench.api = {
    preset: ((p: Preset, instant = false) => setPreset(p, instant)) as never,
    cam: ((v: (typeof PRESETS)['close']) => cam.go(v, true)) as never,
    timeScale: ((v: number) => (s.timeScale = v)) as never,
    pause: ((v: boolean) => (s.paused = v)) as never,
    manual: ((v: boolean) => setManual(v)) as never,
    aimAt: ((x: number, z: number) => {
      brain.manualPoint = [x, rangeHeight(x, z) + 0.3, z];
      reticle.position.set(x, rangeHeight(x, z) + 0.05, z);
      reticle.visible = brain.manual;
    }) as never,
    fire: fire as never,
    pauseAfterShot: ((d: number) => (pauseAfterShot = d)) as never,
    lead: ((v: boolean) => (brain.lead = v)) as never,
    spawn: ((kind?: AlienKind, gully?: number, dist?: number) => targets.spawn(kind, gully, dist)?.id ?? null) as never,
    group: (() => targets.spawnGroup(5)) as never,
    clear: (() => targets.clear()) as never,
    auto: ((v: boolean) => (targets.auto = v)) as never,
    lod: ((l: Lod | 'auto') => setLod(l)) as never,
    wire: ((v: boolean) => setWire(v)) as never,
    pivots: ((v: boolean) => setPivots(v)) as never,
    construct: construct as never,
    compare: ((v: boolean) => setCompare(v)) as never,
    lineup: ((v: boolean) => setLineup(v)) as never,
    measure: measure as never,
    triangles: (() => rig.triangles) as never,
    parts: (() =>
      rig.fullMeshes.map((m) => {
        const g = m.geometry;
        const t = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
        const n = (m as unknown as { count?: number }).count ?? 1;
        return [m.name, t * n];
      })) as never,
    killsSinceReady: (() => targets.kills - killsAtStart) as never,
    camNow: (() => cam.now()) as never,
    lodThresholds: (() => LOD_THRESHOLDS) as never,
  };
  ui.refresh();
  tick();
}

function cap(text: string, cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = `cap ${cls}`;
  d.textContent = text;
  document.body.append(d);
  return d;
}

main().catch((e) => {
  bench.errors.push(String(e?.stack ?? e));
  const l = document.getElementById('loading');
  if (l) l.textContent = `Failed: ${e}`;
  console.error(e);
});
