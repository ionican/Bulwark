# Bulwark — W17 look test A

One vista of map 1 built from code-made geometry, CC0 photographic textures (Poly Haven, ambientCG) and a full lighting stack, to see how close that gets to `reference/01-mineral-war.jpg` (scene) and `reference/02-gun-turret.png` (building materials and the gun turret). Three.js 0.186, WebGL renderer.

```
npm install
npm run dev      # http://127.0.0.1:8815/          (turret showcase: /?turret=1)
npm run build    # static build in dist/
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

## Debug hook

`window.__look`: `ready`, `errors`, `renderer`, `quality`, `view`, `stats` (`fps`, `cpuMs`, `gpuMs`, `calls`, `triangles`, `texMB`, `rtMB`, `particles`), `setQuality('high'|'medium')`, `setView('reference'|'strategic', instant?)`, `cam({target, distance, elevation, azimuth})`, `measure(seconds)` → frames, fps, CPU and frame-time averages and 95th percentiles, GPU timer averages, `freeze` (stops the simulation clock).

`gpuMs` comes from `EXT_disjoint_timer_query_webgl2`. On ANGLE-Metal (Apple GPUs) it reads higher than the frame interval while frames hold 60 fps, so it is shown as a relative figure only.

Scale: 1 world unit = 1 tile = 2 m, as in the game. Aliens are drawn at 1.5× their simulation size so they read at RTS distance (`ALIEN_DISPLAY_SCALE` in `src/scene/wave.ts`).

Credits and licences: `CREDITS.md`.
