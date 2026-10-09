# W24 plan review log (append-only)

Plan drafted by Claude (Opus 5.5 · high) via `/spec`, 2026-10-08 16:3x BST. Verify command confirmed red on the current tree (vitest exit 1, no matching test files); baseline `npm test` 77 of 77 pass.

## Round 1 — Codex (GPT-6.1 Sol · high, thread 01a11c08-21e2-7100-b6ef-27f8bd7be7dc)

The plan needs revision: several requirements conflict with existing code, and the verification can fail on missing files while still accepting a weak implementation.

Read-only checks run this session: the missing W24 tests produced **“No test files found, exiting with code 1”**; game typechecking passed; the existing balanced plan won at tick **31,624**, with **5,880 commander HP**. Existing Vitest suites could not execute because their temporary-directory creation was denied (`EPERM`). No files were modified.

1. **“Keep the simulation as it is” conflicts with construction passability.** Every occupied non-belt tile blocks both player movement and alien movement, regardless of completion. Executed probe: an untouched wall site had `progress: 0, walk: 0, open: 0`. Queued sites also reserve occupancy immediately, whereas W23 joins a tile when building starts. Sources: [world.ts:587](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/world.ts:587), [aliens.ts:17](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/aliens.ts:17), [W23 world.ts:154](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/w23/world.ts:154).  
   **Fix:** Define reserved, started and complete states explicitly; test joining and both actors’ passability at each transition, including completion under a moving entity.

2. **Appending `gate` breaks the supposedly frozen `look/` package.** `look` imports the game’s `BuildingKind`, and its `BUILDING_MAKERS: Record<BuildingKind, Make>` has no gate entry. The proposed game-only verification will miss this downstream type error. Sources: [layout.ts:5](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/world/layout.ts:5), [buildings.ts:405](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/models/procedural/buildings.ts:405).  
   **Fix:** Resolve the workshop’s dependency on evolving game types before adding the kind, and include `look` typechecking in verification.

3. **A gate cannot use the existing ordinary-building footprint machinery.** Buildings have one square `size`; placement requires empty ground, removal clears that square, and attack distances and picking use it. A rotated `3 × depth` gate replaces occupied walls. Sources: [world.ts:447](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/world.ts:447), [combat.ts:64](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/combat.ts:64), [picking.ts:41](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/render/picking.ts:41).  
   **Fix:** Specify one footprint representation shared by occupancy, replacement, removal, distance calculations, ghosts, picking and snapshots.

4. **Gate conversion leaves critical ownership and economy rules to the author.** Replacing planned walls can invalidate queued build IDs; replacing damaged or mixed-tier walls can heal them or grant upgrades. W23’s instantaneous painter conversion takes the highest footprint tier and clears damage—it supplies no construction-cost policy. Source: [grid.ts:294](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/w23/walls/grid.ts:294).  
   **Fix:** Initially allow conversion only on finished walls, with explicit HP, tier, additional cost and atomic replacement rules.

5. **“Straight run” understates W23’s actual placement restrictions.** W23 requires continuation beyond **both ends on every row**, plus clear ground immediately before and behind the footprint. Executed probe: a three-tile straight wall refused a gate; extending it to five tiles accepted one. Source: [grid.ts:244](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/w23/walls/grid.ts:244).  
   **Fix:** Adopt the complete predicate and test both axes, depths 1–4, ends, side joins, excessive depth and placement-state changes before application.

6. **Gate passability and flow cost need more than a kind check.** Opening the entire three-column footprint lets player paths cross pylons; changing the shared alien `open` grid could permit diagonal alien crossings. If one gate owns all rows, charging its full HP cost on every row overprices breaking an entity destroyed once. Sources: [layout.ts:170](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/w23/walls/layout.ts:170), [world.ts:606](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/world.ts:606).  
   **Fix:** Define a conservative friendly corridor, separate alien corner blocking, and a documented gate-cost approximation; test pylons, diagonals, deep gates and destruction.

7. **Long wall runs exceed existing order limits.** Each unit holds at most 64 orders; `giveOrder` rejects further additions after sites may already have been created. Executed probe: 70 assignments queued 64 and rejected six. Even a normal 128-tile drag exceeds this limit. Sources: [world.ts:57](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/world.ts:57), [world.ts:422](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/world.ts:422).  
   **Fix:** Represent a run as one resumable order, or preflight available queue/table capacity before creating any sites.

8. **Wall-run ordering and tiers are underspecified.** “Nearest the builders” does not define the reference point for multiple builders, ties or assignments. Ordinary placement always creates tier 1; tier 2/3 normally require researched upgrades and additional costs. Sources: [world.ts:453](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/world.ts:453), [balance.ts:62](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/balance.ts:62).  
   **Fix:** Freeze endpoint/depth conventions and deterministic tie-breaks, and construct selected tiers through the existing paid upgrade sequence.

9. **Sandbox identity is absent from persistent world state.** `ScenarioName` chooses initialisation but is not stored on `World`; loading reconstructs a world from terrain and wave availability. A scenario check attached only to the URL or worker initialisation will misclassify loaded saves. Sources: [scenarios.ts:15](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/scenarios.ts:15), [save.ts:206](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/save.ts:206).  
   **Fix:** Persist and snapshot scenario identity, and test loading sandbox and map1 saves through both entry modes.

10. **The sandbox can permanently stop accepting useful commands.** Commander death sets loss; `World.step()` then returns before applying commands, and the runner stops advancing. Executed probe: a queued command remained queued after loss. Wave completion can also end a sandbox if implemented using the normal schedule. Sources: [world.ts:270](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/world.ts:270), [runner.ts:67](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/runner.ts:67).  
    **Fix:** Explicitly choose sandbox end-state behaviour and provide a tested reset/restart path, including wave replay and pending-spawn clearing.

11. **Exact non-overlapping spawning is not always possible.** The requested radius is undefined; the point may be blocked, surrounded, outside the map or already crowded. Alien allocation throws when its fixed table fills. Sources: [world.ts:528](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/world.ts:528), [table.ts:84](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/table.ts:84).  
    **Fix:** Define bounded deterministic placement search, radius/spacing and capacity limits, with atomic refusal when the full count cannot fit.

12. **Arbitrary spawn routes will not appear in the existing overlay.** Snapshots contain traces from map entry points only; neither the route structure nor `computeRoutes()` describes arbitrary spawn origins. Saboteurs also temporarily pursue nearby engineers instead of following their field. Sources: [world.ts:704](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/world.ts:704), [aliens.ts:118](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/aliens.ts:118).  
    **Fix:** Snapshot bounded traces from selected spawn origins and distinguish predicted field routes from opportunistic pursuit in acceptance tests.

13. **Tuning lacks a supported-field matrix, units and safe bounds.** Alien damage is `dps`, range is `reach`, attack interval is a constant, and movement speeds are stored in tiles **per tick**. Buildings and units have fields that do not apply to every kind. Large HP values expand the flow-field bucket allocation; tiny turret intervals hit the ten-shot-per-tick guard. Sources: [kinds.ts:185](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/kinds.ts:185), [aliens.ts:15](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/aliens.ts:15), [flowfield.ts:44](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/flowfield.ts:44).  
    **Fix:** Specify world-local overrides, applicable fields, display/internal units and finite bounds, including research/tier composition and reset semantics.

14. **Acceptance criteria 5 and 6 contradict existing mechanics.** Doubling raw gun damage does not generally double HP loss: executed against a breaker, 30 → 60 damage produced **5 → 35 HP loss**. Unlimited spending also cannot leave the pool unchanged while income continues: the normal start gained `0.1 mass` and `1 energy` in one tick. Heavy ammunition comes from `parts`, a separate inventory. Sources: [combat.ts:178](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/combat.ts:178), [economy.ts:20](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/economy.ts:20), [combat.ts:248](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/combat.ts:248).  
    **Fix:** Assert raw damage or armour-adjusted expected loss, define tuning of in-flight shots, and test unlimited as zero expenditure with normal income and ammunition bypass.

15. **Stats cannot reliably attribute hits with the current projectile schema.** Projectiles store targets but no source entity/kind. Delayed impacts, splash, destroyed shooters and reused slots require retained attribution; summed live-building stats lose historical damage. Commander kills also invalidate “building totals equal all deaths” unless isolated. Sources: [schema.ts:114](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/schema.ts:114), [combat.ts:331](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/combat.ts:331).  
    **Fix:** Carry source identity/kind through projectiles, retain historical aggregates, and define overkill, shields, kill ownership, clears and reset boundaries.

16. **Snapshot/save verification is too narrow.** Layout changes require a snapshot-version change; saves explicitly enumerate additional state. A terminal snapshot omits paths, cooldowns and other future-affecting state, so two terminal snapshots can match despite broken continuation—or ignored commands. Sending stats less frequently also needs a deterministic retention contract. Sources: [schema.ts:1](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/schema.ts:1), [save.ts:107](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/save.ts:107), [determinism.test.ts:22](/Users/codepanda/Projects/worktrees/bulwark-w24/game/test/determinism.test.ts:22).  
    **Fix:** Version the formats, verify command effects and tick advancement, compare intermediate snapshots, and test save/load continuation through gates, tuning, queued runs and in-flight combat.

17. **The renderer port includes a different terrain model and prototype simulation logic.** W17’s mesh uses an analytic canyon heightfield with fixed demo-building flattening; picking uses W13’s rolling heightfield. W23 units advance tasks and construction themselves, while W21 aliens have their own simulation. Copying those controllers violates snapshot-only rendering. Sources: [terrainMesh.ts:14](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/world/terrainMesh.ts:14), [heightfield.ts:134](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/world/heightfield.ts:134), [units.ts:123](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/w23/units.ts:123).  
    **Fix:** Port geometry/materials and pure rigs behind snapshot adapters, use one ground source for mesh/picking/feet, and freeze mappings from game turret kinds to W22 kit models.

18. **Performance acceptance can pass a depleted or mostly invisible scene.** Counts are specified only initially; combat can remove entities. “Hold 55 fps” lacks duration, warm-up, frame-time percentile, visible counts and DPR. The existing game allows DPR 2, while workshop medium caps it at 1. Wall-grid damage changes can trigger full instance-layout rebuilding. Sources: [adapter.ts:20](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/render/adapter.ts:20), [post.ts:25](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/stress/post.ts:25), [world.ts:222](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/w23/world.ts:222).  
    **Fix:** Automate fixed-camera, sustained-population benchmarks with DPR, visible counts, average/1% low FPS and worker timings; separate topology rebuilds from damage/progress updates.

19. **The browser fixture is expensive and does not force wall interaction.** Twenty walls cost 2,000 mass against 600 starting mass and 1/s initial income. An executed equivalent fixture took **1,400.1 simulated seconds**. A short free-standing wall can be bypassed, and the script never explicitly builds the turret whose kills it expects. Source: [map1.ts:35](/Users/codepanda/Projects/worktrees/bulwark-w24/model/data/map1.ts:35), [map1.ts:85](/Users/codepanda/Projects/worktrees/bulwark-w24/model/data/map1.ts:85).  
    **Fix:** Use a funded, bounded fixture with an enclosure or rock-bounded corridor, a specified turret, explicit command acknowledgements and separate tests for resource drain.

20. **The Verify command fails the unbuilt tree but does not discriminate implementation quality.** Missing files cause failure; placeholder tests could remove that failure. The command does not start its server, establish build identity, automate performance, or exercise actual dragging and panel controls—`__game.buildRun` bypasses them. M2 can retain greybox assets and still satisfy the listed automated assertions. Source: [PLAN.md:94](/Users/codepanda/Projects/worktrees/bulwark-w24/PLAN.md:94).  
    **Fix:** Use locked installation, launch/clean up a strict-port server from the tested tree, freeze behavioural assertions, exercise real controls, and require deliberate no-op/solidity mutations to fail.

21. **One author run contains too many independently risky integrations.** M1 alone combines footprint replacement, order management, persistence, tuning, spawning, research overrides and combat attribution; M2 then changes terrain, animation, materials and rendering before those contracts have settled. Source: [PLAN.md:105](/Users/codepanda/Projects/worktrees/bulwark-w24/PLAN.md:105).  
    **Fix:** Make mechanics with greybox rendering, snapshot-driven asset integration, and controls/performance three separately reviewed author runs, with contracts frozen between them.

VERDICT: REVISE
### Claude's response

All 21 findings accepted; the cited lines were spot-checked this session (W23 `checkGateAxis` at `look/src/w23/walls/grid.ts:240–290` read; `look` typecheck passes today, rc 0). PLAN.md rewritten:

- 1 → explicit reserved / started / complete table, displacement rule, transition tests.
- 2 → `gate` entry added to `look`'s `BUILDING_MAKERS`; `look` typecheck in Verify.
- 3 → rectangular `fw × fh` footprints everywhere `size` was used, with an unchanged-behaviour test per kind.
- 4 → conversion on complete walls only, atomic, tier 1, no refund, cost and hit-point rules fixed.
- 5 → W23 predicate ported verbatim, each refusal case tested.
- 6 → 1-tile friendly corridor (centre column), outer columns solid, no diagonal alien crossing, gate cost spread over depth.
- 7 → one run order per builder over a 32-entry run table; refusal before creation.
- 8 → geometry, tie-breaks and order frozen; drags tier 1 only, upgrades through the paid path.
- 9 → scenario stored in world state, saves and snapshots; tested both directions.
- 10 → no end state in the sandbox; commander respawns after 100 ticks; `resetSandbox`.
- 11 → spiral search, radius 6, spacing 0.8, atomic refusal, count 1–50.
- 12 → up to 8 spawn origins with route traces in the snapshot; route tests avoid saboteurs.
- 13 → tuning as 0.1–10× multipliers with a field matrix; in-flight shots keep their damage.
- 14 → criteria now assert raw damage per shot and zero expenditure with income continuing, parts included.
- 15 → shooter kind and id carried on projectiles; historical per-kind counters; overkill, splash, shields, clears defined.
- 16 → format versions bumped; hash every 100 ticks; save/load continuation test.
- 17, 18, 19, 20 → moved into the run 2 and run 3 outlines (renderer port from snapshots with one ground source; benchmark spec; funded bounded browser fixture; real controls). Not built in run 1.
- 21 → the work is split into three author runs; this plan locks run 1 only.

Rejected: the "mutation testing" half of finding 20 (deliberate no-op mutations must fail). Out of proportion for a personal prototype; the session's own per-criterion read of each test file and its own browser probes cover the same risk.

No round 2: Richard's standing rule is one plan review plus one post-build review for work at this stake (29 Sep). The plan is locked for run 1.

## Act 3 — Build (run 1)

`author` subagent (Opus 5.5 · high), 51 min, commits `b94cd7a`..`1b2ab8f`. Calling session's out-of-band check, 2026-10-08 17:0x: frozen Verify exit 0 (W24 files 8/8, 94 tests; `npm test` 171/171; game build; `look` tsc clean). Test bodies read for stats (sums checked every tick; ≥18 of 20 kills accepted because the sums are exact) and gate passage (route crosses gate, no alien on gate tiles incl. diagonals, passes after destruction). Browser probes on :8822: 26-tile depth-2 run built with free spending (spend 0, mass up by income only); 3 × 2 gate built; engineer crossed only at x = 64.5; 20 rushers spawned and killed, gun credited 6 kills; sandbox commands refused on map 1; 0 errors. Post-build `/adversarial-review` not yet run.

## Act 3 — /simplify and post-build adversarial review (run 1)

`/simplify`: four read-only reviewers (reuse, simplification, efficiency, altitude); 17 merged fixes applied by the run 1 author in `b2d503a`. Calling session's check: frozen Verify green (171/171), 0 test assertion lines changed, 112 snapshot/save fingerprint hashes identical before and after (temporary worktree at `37cb7c6` with the same script), balanced plan tick 31,468, commander 6,000 HP. Skipped by decision: scenario-rules table, full passability unification, footprint-scaling kind property.

`/adversarial-review` (Codex GPT-6.1 Sol · high, thread 01a11c8a-de94-7d00-a707-07c81e7d4ce8), verdict needs-attention, four reproduced failures:
- high: startWave at alien capacity throws 'entity table full' and stops the worker (validate.ts:139).
- high: speed tuning lets a saboteur cross a complete gate in one tick (aliens.ts:91; movement checks only the destination tile).
- medium: apply-time refusals are never reported (worker.ts:65).
- medium: the reservation draw batch caps at 1,024 while three valid max runs make 1,536 (entities.ts:215).
All four accepted; sent to the author test-first. Run 2 waits for these fixes.

### Adversarial findings fixed (run 1)

Author commits `e8167ad` (regression tests) and `60ebba6` (fixes). Calling session's check: the new `test/w24-review.test.ts` run on `e8167ad` → 9 of 14 fail (all four findings represented); on `60ebba6` frozen Verify green, `npm test` 185/185; balanced plan wins at tick 31,452, commander 6,000 HP (was 31,468: one engineer move at tick 22,208 used to cut 0.17 tiles across a heavy-cannon corner and now stops short — author's trace, not re-derived); browser on :8822: three conflicting spawnAt → 1 applied, 2 refused with the reason delivered, 0 errors. Run 1 closed.

## Run 2 plan — Round 1, Codex (GPT-6.1 Sol · high, thread 01a11ca2-38f1-79b1-ae59-c638270b2ad4)

Run 2 needs revision. The five turret IDs exist, but several porting and verification contracts remain incomplete.

Read-only checks this session: game and workshop typechecks passed; all five workshop test files passed; the probes below executed successfully. Git status and diff were empty. Workshop performance figures below are recorded results, not measurements rerun here.

1. **Projectile snapshots cannot reliably trigger firing effects.** A gun probe produced `afterFire: 1, afterProjectileStep: 0`: the shot hit before snapshot encoding. The beam probe produced no projectile at all. Worker catch-up also publishes only after several ticks. Shooter attribution exists, but missed shots cannot be reconstructed from it. Sources: [combat.ts:287](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/combat.ts:287), [worker.ts:35](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/worker.ts:35).  
   **Fix:** Explicitly accept best-effort flashes from `BF_FIRING` once per newly observed tick, or separately authorise persistent shot/impact events.

2. **W20 aiming and W21 shells describe different physics from the game.** `solveIntercept` assumes gravity and ballistic flight; game projectiles move horizontally towards a continuously updated target. W21 `ShellPool.update` independently determines alien and ground collisions. Snapshots omit projectile target, destination, speed and flight age, so porting that behaviour would invent trajectories and impacts. Sources: [aim.ts:126](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/bench/aim.ts:126), [effects.ts:97](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/stress/effects.ts:97), [schema.ts:139](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/schema.ts:139), [combat.ts:329](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/combat.ts:329).  
   **Fix:** Specify direct visual aiming for the existing game physics and port effect drawing/pooling without workshop collision or ballistic simulation.

3. **“One ground” currently fails mathematically.** The game uses bilinear heights; its mesh uses two planar triangles per tile. Executed across every map cell centre, 498 exceeded the proposed tolerance; at `(75.5, 13.5)`, mesh height was `2.708135`, sampler height `2.533147`, difference `0.174988` tiles. W21’s `Ground` also interpolates bilinearly. Sources: [terrainView.ts:96](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/render/terrainView.ts:96), [terrain.ts:220](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/terrain.ts:220), [world.ts:70](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/stress/world.ts:70).  
   **Fix:** Use one sampler matching the actual mesh triangles, and test rock boundaries, real screen rays and transformed planted-foot contacts—not merely three height helpers.

4. **The terrain decision leaves substantial new geometry unspecified.** W17’s builder obtains heights and `dark/pave/cliff` shader masks from the analytic field, which imports workshop layout and flattens its fixed buildings. Keeping game terrain is workable, but does not supply those masks, terraced outcrops, an exterior transition or foundations for arbitrary placements on slopes. Equal centre heights cannot prevent a wide building floating or intersecting the ground. Sources: [terrainMesh.ts:49](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/world/terrainMesh.ts:49), [heightfield.ts:134](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/world/heightfield.ts:134), [entities.ts:359](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/render/entities.ts:359).  
   **Fix:** Define game-derived shader masks, rock/scenery geometry, edge stitching and cosmetic foundations while retaining one explicit playable ground surface.

5. **Wall layout depends on more than the occupied tile set.** W23 selects tier-specific faces and joints; `WallGrid.set` increments its version on tier changes. A tier upgrade leaves the tile set unchanged, so the frozen rebuild rule would retain obsolete parts. Reserved-to-started joining and wall-to-gate replacement likewise need explicit structural treatment. Sources: [grid.ts:153](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/w23/walls/grid.ts:153), [layout.ts:107](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/w23/walls/layout.ts:107), [schema.ts:54](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/schema.ts:54).  
   **Fix:** Version layout by joining eligibility, tier, wall/gate identity and gate axis/footprint, with tests for each transition while HP-only changes remain rebuild-free.

6. **The turret table mixes incompatible drawing contracts.** W21’s `InstancedTurrets` uses the single W20 model’s `base/pinion/yaw/cradle/barrel` slots; W22 kinds use six pivots, per-part offsets and recoil scaling. The mappings are valid IDs, but their existence test cannot prove that anvil, lantern or rampart are actually assembled correctly. Sources: [turretLevels.ts:140](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/stress/turretLevels.ts:140), [kit.ts:51](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/kit/kit.ts:51), [strategies.ts:62](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/kit/strategies.ts:62).  
   **Fix:** Select W22 strategy B explicitly, batch by part × material × level, and verify each mapping’s actual parts, footprint transform and muzzle position through yaw/pitch/recoil changes.

7. **The lighting/post port needs an adapter redesign, and the camera source changes controls.** `Lighting` and `StressPost` require a concrete `WebGLRenderer`; the game adapter hides it and exposes no quality or frame-time interface. The listed workshop camera installs `OrbitControls`, unlike the game’s strategic rig and input handling. Sources: [adapter.ts:7](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/render/adapter.ts:7), [lighting.ts:46](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/render/lighting.ts:46), [post.ts:40](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/stress/post.ts:40), [camera.ts:28](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/render/camera.ts:28).  
   **Fix:** Specify the adapter’s composer, quality, resize and timing lifecycle, retaining the game camera and controls.

8. **W20 construction is neither snapshot-driven nor independently instanced.** `Construction` advances its own fixed-duration clock, creates ghost objects around one `TurretRig`, and writes the shared `build` control. Using it directly would synchronise unrelated sites or advance them independently of simulation progress. W23’s per-instance cut and custom depth material provide the appropriate mechanism. Sources: [construction.ts:24](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/bench/construction.ts:24), [construction.ts:52](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/bench/construction.ts:52), [batches.ts:66](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/w23/batches.ts:66).  
   **Fix:** Use snapshot `flags/progress` for per-instance construction cuts and shadows; test two simultaneous sites at different progress values.

9. **Animation adaptation lacks state, time and reset rules.** `AlienRenderer.update` requires `AlienSim` arrays including height, heading, phase and seed; these need render-side derivation. Extractor `working` is not `BF_ACTIVE`—income extractors never receive that flag. Unit `work` refers to either a building or wreck, distinguished by unit state. Stateful planted feet and recoil also need resets after teleport, rewind, load and ID reuse. Sources: [aliens.ts:347](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/stress/aliens.ts:347), [economy.ts:62](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/economy.ts:62), [schema.ts:107](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/sim/schema.ts:107), [biped.ts:202](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/w23/rig/biped.ts:202).  
   **Fix:** Freeze a per-kind animation input matrix, simulation-time clock and generation-aware reset policy, including reclaiming, pause, speed changes and discontinuities.

10. **“Every kind” coverage cannot come solely from the named assets.** W23 icons cover its workshop assets; kit icons cover turrets, leaving other buildings and aliens without the promised source icons. W17 maps both splitter and merger to the ordinary belt model, so “uses its named source” can pass while concealing their different functions. Sources: [icons.ts:20](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/w23/icons.ts:20), [buildings.ts:432](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/models/procedural/buildings.ts:432).  
   **Fix:** Freeze the complete model/icon/fallback inventory before authoring, including explicit distinguishable splitter and merger representations.

11. **The workshop timings do not establish combined-scene performance.** W21 measured turrets plus aliens; W23 measured walls, builders and extractors separately. Both reused the same expensive terrain/post stack. Recorded W21 terrain cost was about 5 ms at the game camera and 13 ms at full zoom; medium still casts terrain shadows. The new terrain/scenery implementation has no geometry or shader budget. Sources: [README.md:130](/Users/codepanda/Projects/worktrees/bulwark-w24/look/README.md:130), [README.md:304](/Users/codepanda/Projects/worktrees/bulwark-w24/look/README.md:304), [post.ts:25](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/stress/post.ts:25).  
   **Fix:** Measure the combined game scene early, define terrain/scenery and post budgets, and add a gated strategic-zoom target.

12. **The benchmark can still pass a mostly invisible or idle scene.** Criterion 8 reports visible counts but gates only population. Its camera pose and entity placement are unspecified, and nothing requires engineers to build, turrets to fire or aliens to attack. A scene containing the target population outside the view can pass. Source: [PLAN.md:159](/Users/codepanda/Projects/worktrees/bulwark-w24/PLAN.md:159).  
   **Fix:** Freeze camera coordinates, placements, per-kind visible/LOD minima and activity counters, and fail when any required condition drops during measurement.

13. **Reserved-wall capacity does not exercise the expensive wall renderer.** The 1,536-tile fixture draws outlines, bypassing W23’s multi-part wall geometry. It also misses finished walls, gates, construction cuts and strategic icons; workshop `GroundIcons` defaults to only 1,024 instances per icon. Sources: [entities.ts:380](/Users/codepanda/Projects/worktrees/bulwark-w24/game/src/render/entities.ts:380), [icons.ts:202](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/w23/icons.ts:202).  
   **Fix:** Test reserved, started and completed maximum runs across tiers and LODs, counting actual submitted part instances and checking every subordinate buffer’s capacity.

14. **Verify does not discriminate a hollow implementation sufficiently.** `renderInfo()` can report source names, triangles and counts independently of drawn objects—the existing W23 `count()` already accepts caller-supplied object counts. The frozen command neither specifies server/build identity nor executes the separate fingerprint comparison; that script is explicitly outside `npm test`. Four screenshots cannot establish every-kind coverage. Sources: [batches.ts:134](/Users/codepanda/Projects/worktrees/bulwark-w24/look/src/w23/batches.ts:134), [fingerprint.test.ts:1](/Users/codepanda/Projects/worktrees/bulwark-w24/game/scripts/fingerprint.test.ts:1), [PLAN.md:165](/Users/codepanda/Projects/worktrees/bulwark-w24/PLAN.md:165).  
   **Fix:** Make Verify launch and clean up the tested build, automate baseline fingerprints, inspect actual scene geometry/materials/transforms, and require hidden-mesh, greybox, frozen-animation and wrong-mapping mutations to fail.

15. **One author run still contains several independently risky integrations.** This is a renderer/post interface change, a new terrain implementation, two different instancing systems, snapshot animation reconstruction, effects adaptation and verification infrastructure—not just copying accepted assets. Source: [PLAN.md:133](/Users/codepanda/Projects/worktrees/bulwark-w24/PLAN.md:133).  
   **Fix:** Split into separately reviewed runs for ground/post and static models, snapshot-driven walls/rigs, then combat effects and combined performance.

VERDICT: REVISE
### Claude's response

Accepted 1–13 and 15; the run 2 section is rewritten and split into 2a (ground, lighting/post, static models, walls/gates, construction, icons) and 2b (animation, effects, combined performance gate, outline only):
1, 2 → 2b: direct aiming with the game's flat physics; flashes best-effort from the firing flag once per observed tick; no workshop collision or ballistic solver.
3 → one sampler equal to the mesh triangles; test vs mesh, screen-ray picks, feet and bases.
4 → game-derived shader masks, terraced outcrops on rock, stitched exterior scenery, cosmetic plinths; 2a terrain and post budgets.
5 → wall layout key includes tier, construction class, gate identity, axis and footprint; one test per transition.
6 → W22 strategy B for all five turret kinds; per-kind part list, footprint and yaw-pivot tests.
7 → adapter owns renderer, composer, quality, resize and timing; game camera and controls stay.
8 → W23 per-instance cut driven by snapshot progress; two-site test.
9 → 2b animation input matrix, sim-time clock, reset rules; extractor "working" = complete.
10 → frozen model and icon inventory; splitter and merger distinct.
11, 12 → budgets measured in 2a; gated combined benchmark with frozen pose, visibility minima and activity counters in 2b.
13 → capacity fixtures in every state, tier and detail level, counting submitted part instances.
14 → partly: Verify now builds and serves its own tree, runs the fingerprint comparison against `60ebba6`, and tests inspect the actual scene graph rather than a renderer self-report. Rejected: required mutation tests (out of proportion for a personal prototype; the calling session reads the tests and looks at the screenshots).
15 → split as above.

No round 2 (Richard's one-plan-review rule, 29 Sep). Run 2a locked.

## Act 3 — Build (run 2a)

`author` subagent (Opus 5.5 · high), 64 min, commits `bca659c`..`25405f2` (103 files, +13,754 / −131). Calling session's out-of-band check, 2026-10-08 ~20:3x: frozen Verify exit 0 — 2a tests 43/43, `npm test` 228/228, build, `look` tsc, fingerprint vs `60ebba6` identical (68 / 14 / 30 hashes), check-render: 0 console errors on map 1, sandbox, stress; 25 of 25 inventory kinds with models and icons, 0 greybox; terrain + scenery 2.71 ms (budget 5), post 2.48 ms (budget 3.5); stress scene paused 140 fps uncapped at the game camera, 115 at full zoom-out. `git diff d0ff07f..HEAD -- game/src/sim model look` empty; no existing test assertion changed. Screenshots viewed by the calling session: models read well close up; weak points — the playable map reads as a flat square board with straight cut edges and blocky flat-topped scenery (far from the reference image); W13 route arrows clutter every view; aliens near-black; repeating dark blotches in the ground texture. Visual sign-off pending Richard.

### Run 2a follow-up (Richard's feedback)

Author commits `39dcf77`, `fe171f0`, `2064dbb`. Calling session's check, 21:4x (machine load average 16–25 from other sessions): frozen Verify exit 0 — 2a tests 56/56, `npm test` 241/241, fingerprint strict-identical to `60ebba6` (terrain heights are storage only), check-render 0 console errors, 25/25 kinds modelled; real-mouse input checks pass (click selects without camera move; Shift-drag box-selects; build-mode drag queues a 10-tile run; left-drag orbits; right-drag pans). Terrain + scenery 4.16 ms median (3.69 / 5.04 / 4.16) against 5 ms on a loaded machine — re-measure quiet; post 2.07 ms. Walking: 40 engineers + 300 aliens, scene update 0.60 ms CPU. Screenshots viewed: tilted view close to the reference (haze, mesas); routes gone; aliens readable; map edge irregular with terraced walls; some distant peaks are sharp low-poly spikes; undulation subtle in the wide view. Old `w24-2a-*` screenshots were deleted by the author and replaced by `w24-2a2-*`.

## W25 — build queue (Supreme Commander style) and live drag preview

Author commits `e1286f0` (tests, red 13/25 before the change), `87ee3e6`, `5c42b65`. Calling session's check, 22:4x: frozen Verify exit 0 — w25 tests 41/41, `npm test` 282/282, build, look tsc, fingerprint with the queue section stripped identical to `60ebba6`, check-render and check-queue all pass with real mouse input (Shift-queue, panel remove, unshifted replace removes orphaned reserved sites and keeps started ones, mid-drag preview drawn before release and matching the sites after release, Esc cancels). No pre-existing test assertion changed. Balanced plan wins at tick 31,439 (was 31,452), commander 6,000 HP: the scripted plan's unshifted assist now removes an orphaned reserved rebuild site under the new replace rule — accepted by Claude as the intended consequence of Richard's rule. Screenshots `w25-queue-*.png` viewed.

## W25b — waiting markers and Stop clears the queue

Author commits `fad7718` (tests, red), `d1b55fc`, `b1bdc5b`. Cause of Richard's "freeze" (confirmed by Richard: "the mass ran out"): starting mass ~600 gone by tick ~280; walls cost 100 mass on 1 mass/s income. The simulation was correct; the player could not see why. Calling session's check, 05:5x 9 Oct: frozen Verify exit 0 — w25b 14/14, `npm test` 297/297, fingerprint (queue stripped) identical, check-render and check-queue pass (hourglass "waiting for mass" on 2 sites, 2 builder labels, readout "▲SHORT · 2 sites waiting", markers clear on supply, Stop removes 11 reserved tiles and the run and keeps 8 started). Changed assertions: only the two old "Stop keeps reserved sites" tests, reversed per Richard. Balanced plan 31,439 / 6,000 HP unchanged. Page-load stall: author traced it to three.js first-use shader compilation on the main thread (2.2–2.4 s, only with 5+ game tabs open); the worker kept ticking; not fixed — pre-compiling shaders at startup is the fix path.
