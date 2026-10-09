# Workshop sources ported into the game (W24 run 2a)

Copies of the W17–W23 workshop code in `look/src/`, at the same relative paths, so their imports
between each other are unchanged. `look/` itself is not edited and the game does not import from
it at run time. Only geometry, materials, rigs, pure pose maths, lighting and post-processing are
here — never the workshop's simulation or demo controllers (W23 `units.ts` task logic, W23
`world.ts` construction logic, W21 alien movement, W21 `fireControl.ts`, W20 `construction.ts`'s
clock, W17 `camera.ts`'s OrbitControls).

Each file's first line names its source. Files copied unchanged apart from that line:
`assets/composite.ts`, `assets/textures.ts`, `bench/geo.ts`, `bench/surface.ts`,
`bench/turretRig.ts`, `kit/builder.ts`, `kit/parts.ts`, `kit/pose.ts`, `models/kit.ts`,
`models/materials.ts`, `models/procedural/common.ts`, `noise.ts`, `render/fog.ts`,
`render/lighting.ts`, `stress/post.ts`, `stress/turretLevels.ts`, `stress/turretMid.ts`,
`stress/turretPose.ts`, `w23/extractors.ts`, `w23/mats.ts`, `w23/parts.ts`, `w23/rig/*`,
`w23/walls/geometry.ts`, `w23/walls/layout.ts`.

Adapted (each change marked in the file):

| File | Change |
|---|---|
| `bench/turretModel.ts` | W20's gun spec (`bench/brain.ts`, with the ballistic aim solver behind it) is not ported; the two dimensions the model reads are a local constant. |
| `models/types.ts`, `models/procedural/aliens.ts`, `models/procedural/buildings.ts` | Kind name types come from `game/src/sim/kinds.ts` (type-only import) instead of the workshop layout. |
| `models/procedural/buildings.ts` (run 2b) | The smelter's chimney tops are an exported constant (`SMELTER_CHIMNEY_TOPS`) the model is built from, so the game's smoke rises from them. |
| `stress/lod.ts` | Imports the game's `LOD_HYSTERESIS` by its game path. |
| `kit/kit.ts` | `buildKit(…, only)` builds only the listed kinds and the parts they use; each kept kind is identical to the full kit's (tested against `look/` in `test/w24r2a-models.test.ts`). |
| `kit/icons.ts` | `drawIcon` exported, for the game's icon atlas. |
| `w23/batches.ts` | Each batch grows up to a maximum (from the simulation's capacities) and reports `overflowed`; meshes carry `userData.part` and `userData.level`. |
| `w23/lod.ts` | `turret` asset kind (W21's turret thresholds). |
| `w23/walls/grid.ts` | `addGate(gate)`: a gate whose footprint the simulation decided. |
| `w23/icons.ts` | The icon drawing function exported as `drawW23Icon`. |
| `w23/beams.ts` (run 2b) | `commit()` uploads only the streaks written (update ranges), not the whole capacity. |
| `fx/particles.ts` (run 2b) | `PType` is a const object instead of a `const enum`; the puff atlas is a blank texture outside a browser (Node tests); `clear()` drops every particle and emitter (a world reset). |
| `stress/effects.ts` (run 2b) | Only the particle caps and the muzzle blasts. The shell pool (W20's ballistic arc tested against the aliens), casings and muzzle lights are the workshop's fire control and collision, not ported: the game's shots come from the snapshot's projectile rows (`render/effects.ts`). |
| `world/terrainMaterial.ts` | From `world/terrainMesh.ts`: the material only (the mesh builder uses W17's analytic field and layout); paving from a per-tile texture; W17's water bands removed; no rubble on the flats and the sand detail fading with distance (Richard's feedback). |

Not ported: `kit/strategies.ts`. The game draws the kit turrets through `w23/batches.ts`, which is
W22's strategy B (one instanced batch per part × material × detail level, shared by every kind
that uses the part) with W23's per-instance glow, damage and construction cut.
