# Bulwark — W17 look test A, W18 look test B, W20 gun-turret bench, W21 turret stress test

One vista of map 1 built from code-made geometry, CC0 photographic textures (Poly Haven, ambientCG) and a full lighting stack, to see how close that gets to `reference/01-mineral-war.jpg` (scene) and `reference/02-gun-turret.png` (building materials and the gun turret). Three.js 0.186, WebGL renderer.

```
npm install
npm run dev      # http://127.0.0.1:8818/          (turret showcase: /?turret=1; W20 bench: /bench.html; W21 stress test: /stress.html)
npm test         # W20 fire-control and W21 stress unit tests (node:test, --experimental-transform-types)
npm run build    # static build in dist/ (index.html, bench.html and stress.html)
npm run fetch-assets   # re-download the textures listed in scripts/fetch-assets.mjs (already committed)
```

Keys: **V** reference angle / strategic zoom-out, **Q** high / medium quality. Mouse: drag to orbit, wheel to zoom, right-drag to pan. The same toggles are buttons in the readout.

## What is in the scene

- **Terrain** (`src/world/heightfield.ts`, `terrainMesh.ts`): an analytic heightfield laid over map 1's real layout (base centre, deposits, entries and rock outcrops are imported read-only from `game/src/sim/terrain.ts`). The base sits on a plateau; beyond the walls the ground drops 8 tiles into a canyon, with ramps where the north and east approach corridors climb to the walls. Mesas, pinnacles, floor shelves and pool bowls are noise fields; every relief is terraced on absolute height, so ledges line up as horizontal strata. The mesh is 721 × 721 vertices, denser over the play area than at the horizon. The material is a patched `MeshStandardMaterial`: the cliff photo projected on the two vertical planes (no stretching) and tinted by height bands for the strata, the sand photo top-projected with two rotated samples and a coarse-mip high-pass against tiling, the dark rock photo triplanar in gullies, pale dust on the canyon floor, turquoise under the water line with a pale rim.
- **Buildings, units, aliens** (`src/models/procedural/`): code-built from chamfered extrusions, lathes, gears and tubes, merged per part with one group per material. Ivory armour uses the Metal016 photo for surface detail, with panel seams, bolt heads, hairline cracks and paint chips composed in code (`src/assets/composite.ts`); chamfer faces carry a `wear` attribute that shows chipped paint over metal. Copper fittings use Metal047B, gunmetal uses metal_plate_02.
- **Effects** (`src/fx/`): instanced camera-facing sprites for smoke, dust, fire, sparks, embers and muzzle flashes (puff atlas generated in code), instanced HDR tracers and beams.
- **Lighting** (`src/render/lighting.ts`, `post.ts`, `fog.ts`): low warm sun with PCF soft shadows; Poly Haven HDRI as image-based light, rotated so its sun agrees with the directional light; a weak hemisphere bounce; exponential-squared haze that starts near the looked-at point and scales with camera distance; `postprocessing` with N8AO, bloom (threshold 1.0, so only emissive strips, glows and fire bloom), ACES filmic tone mapping and SMAA.

Shadows are **one directional shadow map** re-fitted every frame to the view frustum (up to about 2× the camera distance), in a fixed light-space frame with texel snapping so it does not shimmer. 4096² on high, 2048² on medium. No cascades.

Quality: high = 4096² shadows, N8AO "High" at full resolution, textures at full size (2K terrain, 1K buildings), 16× anisotropy, two-sample sand. Medium = 2048² shadows, N8AO "Medium" at half resolution, every texture decoded at half size, 4× anisotropy, one-sample sand.

## Swapping in authored models (W18)

Everything mesh-related goes through `ModelSource` (`src/models/types.ts`): `building(kind, tier?)`, `unit(kind)`, `alien(kind)` return a `ModelDef` — a list of parts, each a geometry with its materials, a pivot and an optional motion (`aim`, `elevate`, `spin`, `bob`, `gait`, `recoil`). `src/scene/modelLayer.ts` instances any `ModelDef` (one `InstancedMesh` per part) and animates the motions from per-instance state; placement, turret aiming, effects anchors and the wave logic only use `ModelDef` fields (`muzzle`, `height`, part names). A glTF source flattens each loaded scene into parts (mesh → part, node transform → pivot) and names the turret head part with motion `aim`, barrels `recoil`, legs `gait`. Terrain, lighting, post, foundation pads, conduits and particles do not depend on the model source. The code-built source is `src/models/procedural/index.ts`; replace the `proceduralSource(mats)` call in `src/main.ts`.

Skinned animation is not part of the contract yet; a glTF with skeletal walk cycles would need a second layer type.

## W18 look test B: generated gun turret

W18 asks whether open image-to-3D models run on our own DGX Spark beat W17's code-built gun turret. Provenance, settings, timings and what failed: `public/models/turret/README.md`. Scripts run on the Spark: `scripts/w18-spark/`.

- `?turretSource=code|step1x` picks the gun turret for the vista; **T** or the *Turret* buttons in the readout switch it live (`BaseScene.replaceModel` swaps the gun layer and keeps placement and aim). `?turretLod=20k|5k` picks the GLB level (default 20k).
- `?turret=1` renders every source in turn under the same sun, image-based light, post stack, camera and aim (−66°), and lays the frames out beside the reference image. `?turret=1&turretSource=<id>` shows one source live, as W17 did.
- `src/models/gltf.ts` is the glTF source: GLTFLoader with the meshopt decoder, every mesh flattened into a part, fitted to the W17 frame (ground at y = 0, footprint centre at the origin, footprint width equal to the code-built turret's, barrel turned to +X by finding the point of the upper 60 % farthest from the vertical axis, muzzle at the barrel tip). The generated mesh is one piece, so the whole model, base included, turns to aim; there is no separate head or recoiling barrel.
- Step1X-3D's generated texture was noise (see the models README), so its geometry is drawn with W17's ivory material (`material: 'ivory'` in `TURRET_SOURCES`).

Screens: `_screens/b-turret-compare.png` (20k level), `_screens/b-turret-compare-5k.png`, `_screens/b-vista-code.png`, `_screens/b-vista-step1x.png`.

## Debug hook

`window.__look`: `ready`, `errors`, `turretSource`, `turretInfo`, `setTurretSource(id)`, `renderer`, `quality`, `view`, `stats` (`fps`, `cpuMs`, `gpuMs`, `calls`, `triangles`, `texMB`, `rtMB`, `particles`), `setQuality('high'|'medium')`, `setView('reference'|'strategic', instant?)`, `cam({target, distance, elevation, azimuth})`, `measure(seconds)` → frames, fps, CPU and frame-time averages and 95th percentiles, GPU timer averages, `freeze` (stops the simulation clock).

`gpuMs` comes from `EXT_disjoint_timer_query_webgl2`. On ANGLE-Metal (Apple GPUs) it reads higher than the frame interval while frames hold 60 fps, so it is shown as a relative figure only.

Scale: 1 world unit = 1 tile = 2 m, as in the game. Aliens are drawn at 1.5× their simulation size so they read at RTS distance (`ALIEN_DISPLAY_SCALE` in `src/scene/wave.ts`).

Credits and licences: `CREDITS.md`.

## W20 gun-turret bench (`/bench.html`)

One gun turret at full detail, built in code to `reference/02-gun-turret.png`, aiming, firing and killing alien machines on a small canyon range. Lighting, post-processing, haze, the terrain material, the aliens and the particle system are W17's. Code: `src/bench/`.

### The turret (`src/bench/turretModel.ts`, `turretRig.ts`, `surface.ts`, `geo.ts`)

A hierarchy of separately moving parts: **base** (static) → **pinion** (spins −yaw × 44/12, meshed with the ring) and **yaw pivot** → **slewing ring** + **head** → **cradle** (pitch about the trunnion axis, 0.95 tiles up) → **barrel** (recoil slide along −X). Turret space: +Y up, barrel along +X at yaw 0, 1 unit = 1 tile = 2 m; footprint 2 × 2 tiles.

- Base: gunmetal octagon footing with a rivet line, four bolted feet (bronze hex bolts on washers), eight ivory armour sides of two panels each (vertical face, chamfer, top sloping up to the ring; wedge-cut so they tile the octagon), gunmetal pilasters with a dark channel at the corners, ivory deck, four bronze brackets with gunmetal latches, pinion housing, a cyan indicator light.
- Slewing ring: bronze bearing band, 44-tooth gunmetal ring with chamfered trapezoid teeth, turntable and a bronze bolt circle (the bolts show it turning).
- Head: two cheeks, each a gunmetal core plated with ivory edge plates and two raked side plates, with open seams onto the core; rear housing shell with a roof hatch; bronze hinges, latches and a clamp; cyan slits on the cheek fronts.
- Cradle: bronze trunnion rings with gunmetal hubs and hub bolts, cradle block, ribbed gunmetal recoil housing with a bronze collar, bronze recuperator.
- Barrel: breech block with an ejection port, ivory sleeve with dark slots, muzzle brake built from a rear ring, four bars and top/bottom spines so the five side ports are real openings, and a front ring whose bore runs 0.6 tiles back to a dark end.
- Bolts are one instanced hex bolt (30 triangles) per part and material.
- Surfaces: ivory ceramic-composite from Poly Haven `beige_wall_001` (normal and roughness grain; colour, hairline cracks, chips and grime mottling composed in code, matte, non-metallic); gunmetal and bronze from `metal_plate_02` and `Metal047B`, recoloured in code (photo grain kept, hue and rust blotches dropped). Edge wear is judged per piece before placement (thin chamfer faces): chipped ceramic over dark composite, bare steel on gunmetal, polished bronze on bronze. Metals have a roughness floor so the HDRI sun does not bloom on them.

Triangles: full 22,640 (measured from the geometry, bolts included); simple 212; icon 32. The simple level keeps the pivots so it still aims; the icon is the game's gun icon (`game/src/render/geometry.ts`: round body, barrel bar, dark outline plate, pale fill) drawn on top at max(footprint, 9 px), turned to the aim. "By distance" uses the game's thresholds and hysteresis (`game/src/render/lod.ts`, 60 and 125 tiles).

### Fire control (`src/bench/aim.ts`, `brain.ts`, `recoil.ts`; tests in `test/turret.test.ts`)

- Traverse 60°/s, 240°/s² (continuous, short way round). Elevation 30°/s, 120°/s², −5° to +45°. Each axis commands the fastest rate from which it can still stop on the target (√(2·a·error)), capped at the turn rate, plus the target's own angular rate as feed-forward; the rate changes by at most a·dt per tick, so it eases in and out.
- Leads the target: constant-velocity intercept with a ballistic low arc (shell 50 tiles/s = 100 m/s, gravity 9.81 m/s²), iterated on flight time; the shell starts at the muzzle, 1.493 tiles from the trunnion. **L** turns lead off to show the misses.
- Fires when both axes are within 0.6° of the solution and the gun has cycled: 0.5 s between shots (120 rounds/min). The shell leaves along the barrel's actual direction and is flown on its exact arc and collision-tested against every alien each frame. Range 24 tiles (horizontal). A solution above +45° is followed to the limit but never fired at.
- Recoil: 0.16 tiles (32 cm) back in 0.05 s, 0.04 s hold, 0.4 s return; the casing is ejected and the breech vents when the return starts.
- With no target in range for 1.2 s the turret sweeps ±50° about its last heading at up to 12°/s, barrel at +4°.

### Range and effects (`src/bench/range.ts`, `targets.ts`, `effects.ts`, `construction.ts`)

Analytic heightfield: an arena of radius 31 tiles round the turret, three gullies leading in (bearings 0°, 52°, −58°), terraced walls up to about 9 tiles, boulders at the wall feet, W17's terrain material, and the range ring. Aliens (W17's four kinds, drawn 1.5×) enter at the far end of a gully, walk to its mouth and then straight to a stopping point 5.5–10 tiles out, firing harmless bolts at the turret once they stop. Hits spark; destroyed aliens explode and leave a burning wreck that smokes for 16 s and sinks; auto waves keep five on the range. Firing: forward flash and sparks, a flash and a smoke puff out of each brake port on both sides, a muzzle point light, an HDR tracer, the cyan slits pulsing, a brass casing that tumbles and bounces, a breech vent puff.

Construction (**B**): footprint outline, wireframe ghost of the whole turret, the solid turret clipped above a rising build height (shadows clipped too) with a cyan band below the cut and sparks off it; at the top the lights come on, the head swings to its heading and the gun lifts; then fire control takes over.

### Controls (buttons in the right panel; keys in brackets)

Simulation: Pause (**Space**), 0.1× (**1**), 0.25× (**2**), 1× (**3**). Camera: Game camera (**G**: the game's starting camera — 45° lens, distance 50, pitch 68.9° from `pitchFor`), Close-up (**C**), Vs concept (**X**: left half live render at the concept's camera, right half the concept image; the turret is turned on its footing so W17's low sun lights it from the front left as in the image). Mouse: left-drag orbit, wheel zoom, right-drag pan. Turret: Manual aim (**M**: follows the mouse point on the ground; a click that is not a drag fires), Fire (**F**), Lead target (**L**), Construct (**B**). Targets: Spawn one (**T**), Spawn group (**Y**), Clear (**Delete**/**Backspace**), Auto waves (**A**). Display: Full (**D** cycles), Simple, Icon, By distance, Line-up (**U**: full, simple and icon side by side), Wireframe (**W**), Pivots (**P**).

Readout: fps, frame CPU ms, draw calls, frame triangles, turret triangles at the current level, yaw/pitch and the wanted yaw/pitch, mode (idle, scan, track, manual, build) and lead, target (kind, id, distance, HP), shots/hits/kills, aliens/wrecks, time scale, renderer.

Debug hook `window.__bench`: `ready`, `errors`, `renderer`, `stats`, `state`, and `api` (`preset`, `cam`, `timeScale`, `pause`, `manual`, `aimAt`, `fire`, `pauseAfterShot`, `lead`, `spawn`, `spawnPath`, `group`, `clear`, `auto`, `lod`, `wire`, `pivots`, `construct`, `compare`, `lineup`, `measure`, `triangles`, `parts`).

Screens: `_screens/w20-closeup.png`, `w20-vs-concept.png`, `w20-firing-slowmo.png`, `w20-range.png`, `w20-lod.png`, `w20-construction.png`, `w20-track-1..3.png`.

## W21 turret rendering stress test (`/stress.html`)

Up to 500 W20 gun turrets on W17's map 1 terrain (same terrain, lighting, haze and post-processing), each aiming and firing on its own against 500 alien machines (W17's four procedural kinds) that advance in waves along five lanes. Code: `src/stress/`; tests: `test/stress.test.ts`.

### Drawing

- **Instanced batches** (`turretLevels.ts`, `turretInstanced.ts`, `turretPose.ts`): per detail level, one `InstancedMesh` per moving part (base, pinion, yaw = slewing ring + head, cradle, barrel) and material. All meshes of one part share one instance-matrix buffer, filled from zero each frame with the turret's yaw, pitch and recoil (`writeTurret`). Bolts are placed into their part's geometry of the same material; emissive slits use a glow material whose emissive is scaled by the instance colour, so each turret's slits pulse with its own shots. Draw calls in the scene pass: 19 (full) + 16 (middle) + 5 (simple) + 1 (icon), whatever the turret count.
- **Detail levels** (`lod.ts`): full 22,640 triangles (W20's model, bolts included) · middle 2,628 (`turretMid.ts`: same parts and pivots, no bolts, chamfers, gear teeth, brake ports, ribs or small fittings) · simple 212 and icon 32 (W20's). Chosen per turret by camera distance with the game's hysteresis rule (±8 %): full < 24 tiles, middle < 85 (the whole game-camera view), simple < 160, icon beyond.
- **Shadows**: one directional map (W17's, re-fitted to the view each frame) reaching 1.6 × the camera distance + 20 tiles on high (1.3× medium, 1.0× low) instead of W17's 2.1× + 30; only full- and middle-detail turrets cast, and only their ivory, gunmetal and bronze batches (on low, only full detail).
- **Per-turret meshes** switch: W20's own `TurretRig` per turret (full for full and middle distance, then simple, icon), for comparison.

### Simulation (`fireControl.ts`, `aliens.ts`, `effects.ts`)

- W20's target choice, lead, aim solver, fire test and recoil in typed arrays (`TurretBank`), step for step the same arithmetic as `TurretBrain` + `Recoil` (the tests compare them exactly over 2,400 ticks). Target search through a uniform 8-tile grid of the aliens, rebuilt each frame.
- Update rate: every frame for visible turrets at full or middle detail; every 2nd frame at simple detail; every 4th frame for icons and turrets outside the view (staggered by index, with the summed time step).
- Aliens: W20's constant-speed legs, ground height read from the W17 terrain mesh's own grid; hit points 4× W20's so the front line builds up and keeps the turrets busy.
- Effect caps: 1,024 shells in flight (oldest reused), 256 casings (full-detail turrets only, 6 s), 2 muzzle point lights, 4,000 smoke + 4,000 glow particles, 96 wrecks (12 newest burn). Muzzle effects by the firing turret's level: W20's full blast and breech vent at full detail; one flash, two side flashes and one puff at middle; one flash at simple; tracer only for icons and off-view turrets.

### Controls and hook

Panel buttons: turret count 50 / 100 / 300 / 500, per-turret meshes, quality high / medium / low, camera presets (close-up **C**, game camera **G**, mid zoom-out **M**, full zoom-out **F**), Vs W20 turret (the instanced turret beside W20's per-object one, same pose), pause (**Space**), time scale 0.25–2×, lead, detail labels (**L**: circle F full, square M middle, triangle S simple, diamond I icon), Run benchmark, Show results (with Copy results). Mouse: left-drag orbit, wheel zoom, right-drag pan. Quality: high = 4096² shadows, N8AO High full resolution, bloom, pixel ratio up to 1.5; medium = 2048², N8AO Medium half resolution, bloom, pixel ratio 1; low = 1024², no AO, no bloom, pixel ratio 1, terrain casts no shadow.

`window.__stress`: `ready`, `errors`, `renderer`, `stats`, `results`, `runBenchmark()` (flies close-up → game camera → mid → full zoom-out, holds each 10 s with the combat running, resolves with `{ meta, rows, text }`), and `api` (`count`, `quality`, `perTurret`, `preset`, `cam`, `pause`, `timeScale`, `bands`, `compare`, `forceLevel`, `measure(s)`, `diag({...})` to switch parts of the frame off). `?dpr=2` stands in for the display's pixel ratio.

### Results on codepanda (M1 Max, 24-core GPU, headless Chrome, 1440×900, pixel ratio 1)

Benchmark, 60 Hz frame cap (fps avg / 1% low; JavaScript ms per frame):

| run | close-up | game camera | mid zoom | full zoom |
|---|---|---|---|---|
| 300 turrets, high | 60.0 / 59.5 · 2.1 ms | 60.0 / 59.5 · 2.7 ms | 60.0 / 59.5 · 2.7 ms | 48.5 / 29.9 · 2.3 ms |
| 300 turrets, medium | 60.0 / 59.5 · 2.4 ms | 60.0 / 59.5 · 2.7 ms | 60.0 / 59.5 · 2.5 ms | 55.2 / 29.9 · 2.6 ms |
| 500 turrets, high | 59.9 / 59.5 · 2.3 ms | 60.0 / 59.5 · 2.7 ms | 60.0 / 59.5 · 2.4 ms | 49.1 / 29.9 · 2.7 ms |
| 100 turrets, W20 per-turret meshes, high | 60.0 / 59.5 · 5.4 ms | 35.1 / 29.9 · 28.1 ms (8,064 draw calls) | 48.9 / 29.9 · 6.5 ms | 51.2 / 29.9 · 4.0 ms |

Without the frame cap (`--disable-gpu-vsync`), 300 turrets at the game camera: 103 fps on high, 142 on medium, 175 on low; 500 turrets: 99 high, 127 medium. Switching parts off at the game camera on high: turrets cost about 1 ms of the ~10 ms frame, ambient occlusion about 3 ms, shadows about 2.5 ms, W17's terrain about 5 ms; at the full zoom-out the terrain costs about 13 ms of 17. With the laptop's pixel count (`?dpr=2`, 1728×1117 CSS → 2592×1675 on high): game camera 34–47 fps on high (ambient occlusion and terrain about 10 ms each), 120 fps on medium.

Screens: `_screens/w21-close.png` (W21 instanced beside W20 per-object, same pose), `w21-game.png`, `w21-mid.png`, `w21-far.png`, `w21-lod-bands.png`.

## W22 turret kinds: 40 kinds from a shared parts kit, four drawing strategies (`/stress.html`)

Richard's question after W21: what if there were 40 different kinds of turret? The W21 stress page now mixes 40 kinds evenly over 100–500 turrets and draws them by one of four strategies, switchable at runtime, on the same benchmark. W21's single-kind mode stays as "1 kind (W20)" with W21's own batches as strategy "W21". Code: `src/kit/`; tests: `test/kinds.test.ts`. Dev server: `npm run dev` → `http://127.0.0.1:8819/stress.html`.

### Parts kit (`src/kit/parts.ts`, `builder.ts`, `kit.ts`)

Every part is described once and built at full, middle and simple detail by a level-aware builder (`PB`): full keeps chamfers with W20's edge wear, bolts and fine fittings; middle drops bolts and fine pieces, chamfers and wear, and uses 40 % of the segments (W21's middle rules); simple keeps only the major pieces at 20 % of the segments. All parts use the one shared material set: ivory ceramic, gunmetal, bronze, cyan glow, plus W20's dark (bores and slots). W20's own parts come from W20's model, W21's middle builder and W20's simple level, the same calls W21 makes, so W20's kind is byte-for-byte W21's geometry (tested).

Part frames: a base has a seat height; a ring stands on it and is drawn without turning at middle and simple detail (its geometry there is rotationally symmetric); a head stands on the ring, turns with the yaw and sets the trunnion height; a weapon is a mount (pitches) and a gun (recoils, spins or stays fixed). Each kind's frame lifts the shared parts onto its own stack (`placed[].off`), so one ring geometry serves a 0.26-tile drum and a 1.12-tile pylon.

Triangles per part, full / middle / simple:

| part | tris | part | tris |
|---|---|---|---|
| Octagonal stepped base (W20) | 6,956 / 800 / 104 | Rounded dome head | 4,268 / 986 / 84 |
| Pinion (W20, with the octagonal base) | 560 / 40 / 0 | Twin-gun box head | 1,338 / 216 / 44 |
| Square bunker base | 3,184 / 432 / 192 | Missile yoke head | 1,584 / 344 / 112 |
| Low ring drum base | 4,140 / 1,036 / 104 | Artillery deck head | 1,792 / 280 / 104 |
| Tall pylon base | 4,724 / 1,048 / 188 | Beam emitter housing head | 4,244 / 1,345 / 114 |
| Toothed slewing ring (W20) | 3,004 / 224 / 0 | Sensor mast head | 1,268 / 372 / 76 |
| Armoured collar ring | 2,416 / 668 / 32 | Long barrel (W20): cradle + barrel | 3,676 / 516 / 0 + 3,824 / 448 / 96 |
| Flat turntable ring | 2,648 / 576 / 32 | Twin barrels: mount + gun | 1,428 / 432 / 84 + 2,184 / 768 / 216 |
| Cheek-armour head (W20) | 4,620 / 600 / 12 | Short howitzer: mount + gun | 1,220 / 472 / 112 + 1,360 / 472 / 124 |
| Rotary cluster: mount + gun (spins) | 1,328 / 384 / 88 + 1,312 / 484 / 80 | Missile pod: mount only (fixed) | 1,660 / 512 / 48 |
| Beam lens: mount + lens (fixed) | 2,364 / 912 / 64 + 768 / 260 / 104 | Flak quad: mount + gun | 1,036 / 248 / 84 + 1,408 / 384 / 24 |

The 40 kinds (`KIND_TABLE` in `kit.ts`; base · ring · head · weapon; no two share base, head and weapon) run from 9,076 to 22,640 triangles at full detail, 1,864–3,933 at middle and 212–596 at simple. Kind 1, Bastion, is W20's turret unchanged (22,640 / 2,628 / 212). Icons: W20's icon generalised — body outline from the base (circle octagonal, square bunker, ring drum, triangle pylon) and a forward glyph from the weapon (bar, twin bars, stub, bar with disc, wide pod, bar with diamond lens, four bars); 25 distinct icons in one 8 × 4 atlas.

### Strategies (`src/kit/strategies.ts`)

- **A naive per kind**: each kind has its own instanced batches per part × material × level (parts on the same pivot at the same offset share a batch, as W21 merges ring and head); one icon batch per kind.
- **B shared parts**: one instanced batch per part × material × level across every kind that uses the part; one icon batch per distinct icon.
- **C shared + merged levels**: B, plus at middle and simple detail the static parts of a kind (base, pinion, ring) merged into one plinth mesh per base × ring pair, and every icon in one batch with the atlas cell per instance.
- **D BatchedMesh**: one `THREE.BatchedMesh` per material × level holding every part geometry of that material and level, plus one for the icons. Instance matrices go straight into BatchedMesh's matrix texture; slots past the frame's count are hidden.

All four take the same per-turret calls and draw the same parts at the same transforms: the tests compare every part instance of 400 random turrets under A–D against an independent object hierarchy (within 1e-4), check instance membership through seven frames that add and remove turrets and switch between 1 and 40 kinds, and check each icon's atlas cell. Screen comparison on a paused frame (1440 × 900, high): at the close-up, game camera and mid zoom-out, A, B, C and D differ in at most 4 pixels by more than 2 levels out of 255. At the full zoom-out icons overlap, and overlapping icons are layered in batch order (A by kind, B by icon, C and D by turret), so A and B differ from C/D in about 10,000–15,000 pixels there; C and D match to 10 pixels.

Fire control is W20's for every kind, with the turret's fire-control height raised to its kind's trunnion; muzzle effects start at the kind's own muzzle. Rotary guns spin at 28 rad/s while the gun is cycling and 3 rad/s otherwise; missile pods and beam lenses do not recoil.

Views: **Kit: 40 kinds** (**K**) lines the kinds up in an 8 × 5 grid at full detail with their names, drawn through the current strategy; **Shared parts** (**P**) lays out every part on its own with its name, the number of kinds using it and its full-detail triangles (weapons pulled apart: mount low, gun high).

Controls and hook: Kinds (40 / 1), Drawing strategy (A, B, C, D, W21 batches), View, **Run all strategies** (A–D, plus W21 with 1 kind, back to back at the current count and quality; one table; **Copy results** copies it). Each benchmark run now starts from the same battle (random streams reseeded, turrets and aliens reset), so strategies run one after another meet the same combat. `window.__stress.runBenchmark({strategy, count, kinds, quality})`, `runAll({count, kinds, quality})` → `{ runs, text }`, `api.strategy`, `api.kinds`, `api.view`, `api.kit()`, `api.multiDraw()`. New columns: update ms (JavaScript writing instance data), submit ms (JavaScript inside the render call), scene and shadow draw calls measured by wrapping the render pass and `WebGLShadowMap.render`, turret calls, kinds in view. `?nomultidraw=1` hides `WEBGL_multi_draw` from three.js.

### Results on codepanda (M1 Max, ANGLE Metal, headless Chrome 154, 1440 × 900, pixel ratio 1)

Raw tables: `results/w22/`. Cells: fps avg / 1% low · update / submit ms · scene / shadow draw calls. 60 Hz frame cap unless stated.

**300 × 40 kinds, high**

| strategy | close-up | game camera | mid zoom | full zoom |
|---|---|---|---|---|
| A | 55.6 / 29.9 · 0.10 / 3.54 · 343 / 278 | 49.9 / 29.9 · 0.30 / 4.24 · 745 / 604 | 58.2 / 29.9 · 0.34 / 3.15 · 372 / 81 | 50.9 / 29.9 · 0.09 / 4.08 · 126 / 81 |
| B | 60.0 / 59.5 · 0.07 / 2.94 · 152 / 145 | 60.0 / 59.5 · 0.24 / 2.72 · 146 / 154 | 60.0 / 59.5 · 0.27 / 2.63 · 95 / 81 | 50.8 / 29.9 · 0.05 / 3.60 · 96 / 81 |
| C | 60.0 / 59.5 · 0.07 / 3.04 · 152 / 145 | 60.0 / 59.5 · 0.20 / 2.80 · 172 / 170 | 60.0 / 59.5 · 0.25 / 2.69 · 113 / 81 | 50.7 / 29.9 · 0.06 / 2.83 · 48 / 81 |
| D | 60.0 / 59.5 · 0.07 / 2.48 · 46 / 74 | 46.5 / 29.9 · 0.36 / 2.47 · 51 / 84 | 50.2 / 29.9 · 0.37 / 2.61 · 50 / 81 | 49.3 / 29.9 · 0.04 / 2.82 · 48 / 81 |

**300 × 40 kinds, medium**

| strategy | close-up | game camera | mid zoom | full zoom |
|---|---|---|---|---|
| A | 60.0 / 59.5 · 0.10 / 3.38 · 343 / 278 | 60.0 / 59.5 · 0.31 / 3.97 · 745 / 604 | 58.3 / 30.0 · 0.36 / 3.08 · 372 / 81 | 57.9 / 29.9 · 0.09 / 3.83 · 126 / 81 |
| B | 60.0 / 59.5 · 0.07 / 3.02 · 152 / 145 | 60.0 / 59.5 · 0.23 / 2.67 · 146 / 154 | 60.0 / 59.5 · 0.27 / 2.62 · 95 / 81 | 60.0 / 59.5 · 0.05 / 3.34 · 96 / 81 |
| C | 60.0 / 59.5 · 0.07 / 2.95 · 152 / 145 | 60.0 / 59.5 · 0.20 / 2.79 · 172 / 170 | 60.0 / 59.5 · 0.25 / 2.62 · 113 / 81 | 60.0 / 59.5 · 0.05 / 2.62 · 48 / 81 |
| D | 60.0 / 59.5 · 0.07 / 2.64 · 46 / 74 | 60.0 / 59.5 · 0.29 / 2.15 · 51 / 84 | 60.0 / 59.5 · 0.31 / 2.28 · 50 / 81 | 60.0 / 59.5 · 0.05 / 2.62 · 48 / 81 |

**500 × 40 kinds, high**

| strategy | close-up | game camera | mid zoom | full zoom |
|---|---|---|---|---|
| A | 60.0 / 59.5 · 0.11 / 2.98 · 262 / 178 | 48.6 / 29.9 · 0.41 / 4.31 · 745 / 604 | 59.2 / 30.0 · 0.51 / 2.95 · 372 / 81 | 50.6 / 29.9 · 0.12 / 4.06 · 126 / 81 |
| B | 60.0 / 59.5 · 0.06 / 2.89 · 111 / 75 | 60.0 / 59.5 · 0.31 / 2.70 · 146 / 154 | 60.0 / 59.5 · 0.41 / 2.61 · 95 / 81 | 50.6 / 29.9 · 0.08 / 3.60 · 96 / 81 |
| C | 60.0 / 59.5 · 0.07 / 2.99 · 111 / 75 | 60.0 / 59.5 · 0.27 / 2.82 · 172 / 170 | 60.0 / 59.5 · 0.37 / 2.63 · 113 / 81 | 51.0 / 29.9 · 0.08 / 2.84 · 48 / 81 |
| D | 60.0 / 59.5 · 0.07 / 2.63 · 13 / 9 | 60.0 / 59.5 · 0.39 / 2.02 · 51 / 84 | 60.0 / 59.5 · 0.45 / 2.11 · 50 / 81 | 48.4 / 29.9 · 0.08 / 2.85 · 48 / 81 |

**300 × 1 kind (W20), high** — W21's case

| strategy | close-up | game camera | mid zoom | full zoom |
|---|---|---|---|---|
| W21 | 60.0 / 59.5 · 0.07 / 2.75 · 60 / 84 | 60.0 / 59.5 · 0.15 / 2.49 · 62 / 93 | 60.0 / 59.5 · 0.15 / 2.58 · 51 / 81 | 51.0 / 29.9 · 0.08 / 2.75 · 47 / 81 |
| A | 60.0 / 59.5 · 0.08 / 2.84 · 60 / 84 | 60.0 / 59.5 · 0.25 / 2.57 · 62 / 93 | 60.0 / 59.5 · 0.27 / 2.60 · 51 / 81 | 51.0 / 29.9 · 0.08 / 2.93 · 48 / 81 |
| B | 60.0 / 59.5 · 0.04 / 2.75 · 63 / 86 | 60.0 / 59.5 · 0.21 / 2.49 · 64 / 95 | 60.0 / 59.5 · 0.20 / 2.56 · 51 / 81 | 50.8 / 29.9 · 0.05 / 2.89 · 48 / 81 |
| C | 60.0 / 59.5 · 0.04 / 2.84 · 63 / 86 | 60.0 / 59.5 · 0.18 / 2.51 · 61 / 92 | 60.0 / 59.5 · 0.21 / 2.56 · 51 / 81 | 50.8 / 29.9 · 0.05 / 2.88 · 48 / 81 |
| D | 59.6 / 59.5 · 0.05 / 2.63 · 46 / 74 | 60.0 / 59.5 · 0.26 / 2.13 · 51 / 84 | 60.0 / 59.5 · 0.22 / 2.36 · 48 / 81 | 49.1 / 29.9 · 0.05 / 2.94 · 48 / 81 |

**Without the frame cap** (`--disable-gpu-vsync --disable-frame-rate-limit`), 300 turrets, high, fps avg at close-up / game camera / mid / full: 40 kinds — A 84.0 / 92.7 / 72.2 / 56.7, B 84.7 / 97.8 / 72.8 / 56.9, C 84.8 / 97.5 / 72.7 / 55.9, D 84.9 / 90.1 / 71.5 / 54.4; 1 kind — W21 83.2 / 101.4 / 73.0 / 56.4, D 81.1 / 92.0 / 72.1 / 55.5. Uncapped, submit ms includes the time WebGL calls block on the GPU, so it is not a CPU cost there. D without `WEBGL_multi_draw` (`?nomultidraw=1`, uncapped): 83.5 / 76.3 / 69.1 / 56.4 fps with 863 / 7,191 / 2,640 / 1,398 draw calls in all passes.

### What the numbers say

- **Draw calls are not the limit on this machine; the terrain, ambient occlusion and shadows are** (W21: about 1 ms of a 10 ms game-camera frame is turrets). 40 kinds under B cost about 3 % of uncapped game-camera frame rate against W21's one kind (97.8 against 101.4 fps).
- **A** multiplies draw calls by the kinds in view: 745 scene + 604 shadow at the game camera against B's 146 + 154. It drops below 60 fps on high at the game camera with 300 and 500 turrets (49.9, 48.6) and at the close-up (55.6); its JavaScript submit time is the highest (4.2–4.3 ms).
- **B** holds 60 fps everywhere except the full zoom-out on high, which every strategy and W21 itself miss (about 51 fps, terrain-bound, as in W21).
- **C** removes 25 icon batches (full zoom-out: 48 scene calls against B's 96, submit 2.83 ms against 3.60) but adds batches at middle detail: merging base, pinion and ring per base × ring pair gives 12 plinths in use against 4 bases + 3 rings + 1 pinion, so 172 scene calls at the game camera against B's 146. Its icon batching is worth keeping; its plinth merge is not, with this many base × ring pairs.
- **D** has the fewest JavaScript calls (5 turret calls, lowest submit ms when capped: 2.0–2.5) but is the slowest on the GPU side at the game camera: 90.1 fps uncapped against B's 97.8, and 92.0 against W21's 101.4 with one kind. Each part instance is one entry in the multi-draw list (about 4,000 at the game camera — the count three.js issues when the extension is missing), and each vertex reads its matrix from a texture. Capped on high at 300 turrets it measured 46.5 and 45.2 fps at the game camera in two runs, yet 60 fps at 500 turrets and on medium; that spread is unexplained.
- `WEBGL_multi_draw` is available in this Chrome (ANGLE Metal). Without it three.js 0.186 logs one warning and issues one draw per instance with a `_gl_DrawID` uniform (`WebGLRenderer.renderBufferDirect`); D still renders correctly, at 76 fps uncapped. Safari was not run: caniuse, MDN and the web-features data list `WEBGL_multi_draw` in Safari and iOS Safari from 15 (WebKit bug 219139, landed r271679); Firefox does not support it (bug 1536673), so D falls back to per-instance draws there.

Screens: `_screens/w22-kit.png` (the 40 kinds, named), `w22-parts.png` (shared parts with names, kinds using them and triangles), `w22-game.png` (300 mixed turrets at the game camera in combat), `w22-close.png`.
