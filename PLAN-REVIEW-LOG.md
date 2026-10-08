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
