# W31 plan review log

Append-only. Plan: `PLAN-W31.md`. Critic: Codex gpt-6.1-sol · xhigh, read-only.

## Round 1 — Codex

thread 01a12e91-f972-75a1-9b7f-0d8f71c0e7b6

Revise. **Today’s three-tick crossing claim is correct for unobstructed travel.** I ran the current simulation: an item advances `0 → 0.4 → 0.8 → next tile`. The plan incorrectly equates that crossing time with sustained feeder throughput.

1. **The delivery counts and mixed-line comparison are wrong.** Producers run before belts, so a stocked extractor refills a tile one tick after it empties ([conveyor.ts:164](/Users/codepanda/Projects/worktrees/bulwark-w31/game/src/sim/conveyor.ts:164)). The current one-tile fixture delivered **150**, not 200, items in 60 seconds. Applying the proposed steps **in memory**, retaining the existing ordering, yielded **86/120/150** for Slow/Medium/Fast. A Fast→Slow→Fast line delivered 100 versus 86 for an entirely Slow line: the first tile’s refill delay matters.
   **Fix:** Separate crossing-time, saturated-capacity and producer-fed throughput tests; specify their feeder state and warm-up period.

2. **The browser crossing-time ratios are inverted.** The proposed durations give Medium/Fast = `4/3` and Slow/Fast = `6/3`; the requested `0.75` and `0.5` are speed ratios ([PLAN-W31.md:99](/Users/codepanda/Projects/worktrees/bulwark-w31/PLAN-W31.md:99)).
   **Fix:** Compare inverse crossing durations, or assert duration ratios `4/3` and `2`.

3. **Independent animation caps destroy the advertised speed ratios.** At the specified 0.1-second frame, the actual capped increments are `0.1667, 0.2, 0.1333`; Fast advances least. The browser’s unconditional `0.5 : 0.75 : 1` assertion would reject this planned implementation ([PLAN-W31.md:45](/Users/codepanda/Projects/worktrees/bulwark-w31/PLAN-W31.md:45)).
   **Fix:** Use a common effective frame delta capped at `0.04` game-seconds, and test uncapped ratios separately from capped motion.

4. **Adding research can silently reinterpret old saves.** Research bits and queue entries use array indices ([balance.ts:56](/Users/codepanda/Projects/worktrees/bulwark-w31/game/src/sim/balance.ts:56)); saves restore the numeric values directly ([save.ts:307](/Users/codepanda/Projects/worktrees/bulwark-w31/game/src/sim/save.ts:307)). Inserting the nodes alongside existing economy research changes later nodes’ identities, contradicting “research is unchanged”.
   **Fix:** Make research indices append-only and test an old save containing completed, current and queued research.

5. **One batch command does not solve queue capacity.** Existing validation only checks whether queues are already full; `giveOrder` accepts orders individually up to 64 ([world.ts:697](/Users/codepanda/Projects/worktrees/bulwark-w31/game/src/sim/world.ts:697)). Appending ten targets to a queue containing 60 orders can start upgrades whose work orders are then refused.
   **Fix:** Check the whole batch’s per-engineer capacity before changing upgrade flags; test both 60+10 and a drag exceeding 64 targets.

6. **Already-upgrading belts and repeated drags are undefined.** `upgradeProblem` returns success for an upgrade already underway, and `startUpgrade` simply returns true ([validate.ts:203](/Users/codepanda/Projects/worktrees/bulwark-w31/game/src/sim/validate.ts:203)). Two drags before completion therefore assist the same Medium upgrade rather than queueing Medium then Fast. Duplicate or vanished targets also lack explicit handling.
   **Fix:** Deduplicate targets, skip upgrades already underway, report stale-target skips at application, and state that the second speed step requires the first to finish.

7. **Reserved-site reuse ignores speed.** Site identity currently compares kind, coordinates, direction and footprint—not tier ([queue.ts:231](/Users/codepanda/Projects/worktrees/bulwark-w31/game/src/sim/queue.ts:231)). Selecting Fast over one’s reserved Slow site can silently reuse the Slow site.
   **Fix:** Include tier in reserved-site identity on both threads, with a regression test for an unshifted build at a different speed.

8. **Invalid tiers are absent from verification.** Testing only tiers 2 and 3 leaves `0`, `4`, fractions and invalid numeric values unchecked; those can produce an undefined step or upgrade-table lookup. The debug bypass must only bypass research.
   **Fix:** Reject every explicit tier outside integer `1..3`, reject tiers on other kinds, and test these refusals with `allTiers` enabled.

9. **The named readout module does not cover finished belts.** `siteReadout` returns null for complete buildings ([siteReadout.ts:100](/Users/codepanda/Projects/worktrees/bulwark-w31/game/src/render/siteReadout.ts:100)); `buildingReadout` currently returns null for healthy belts ([buildingReadout.ts:49](/Users/codepanda/Projects/worktrees/bulwark-w31/game/src/render/buildingReadout.ts:49)).
   **Fix:** Explicitly update `buildingReadout`, testing healthy, damaged, reserved, constructing and upgrading belts.

10. **Tier selection needs distinct identities throughout the UI.** Build buttons are keyed only by kind ([buildbar.ts:63](/Users/codepanda/Projects/worktrees/bulwark-w31/game/src/ui/buildbar.ts:63)); the drag cache also omits tier ([dragPlan.ts:273](/Users/codepanda/Projects/worktrees/bulwark-w31/game/src/dragPlan.ts:273)). Three `belt` entries can overwrite each other, and switching speed while paused can retain stale preview costs. Verify never exercises `B`. Mixed Slow/Medium upgrade selections also cannot truthfully share one “to Medium” label.
    **Fix:** Carry tier through button/tool/cache identity, show per-destination upgrade counts and costs, and test `B` at each unlock plus paused speed switching.

11. **The draw-call estimate is understated.** I baked all six current belt shapes: each has **three** material pieces. Tripling whole models increases a mixed-tier shape from three to nine scene draw calls—**six extra**, not two ([w17Batches.ts:89](/Users/codepanda/Projects/worktrees/bulwark-w31/game/src/render/w17Batches.ts:89)). The existing render fixtures do not exercise all three tiers together.
    **Fix:** Share the static rail/body batches and split only belt surfaces by tier, then benchmark a mixed-tier fixture.

12. **The Node texture-count test cannot inspect today’s real textures.** Node reports `OffscreenCanvas: undefined`; test materials provide empty `Texture` stand-ins ([materials.ts:147](/Users/codepanda/Projects/worktrees/bulwark-w31/game/src/render/materials.ts:147)). Counting a separately generated test canvas could pass while the renderer selects the wrong texture.
    **Fix:** Count chevrons from textures attached to actual drawn browser meshes, and assert per-tier material selection and offsets on straights, corners, joins and the merger.

13. **Save round-trip equality is insufficient for the new behaviour.** Byte-identical reserialization and two fresh deterministic runs do not prove continuation after loading a mixed-tier world. Existing continuation coverage uses untiered belts ([w29-save.test.ts:53](/Users/codepanda/Projects/worktrees/bulwark-w31/game/test/w29-save.test.ts:53)).
    **Fix:** Compare uninterrupted versus restored runs every tick through mixed-speed transfers, blocked junctions, pending batch commands and an upgrade completing.

14. **Route capacity must follow the planned belt speed.** `beltRoutesToCore` currently permits joins using one global capacity and promises full extractor output ([beltRoute.ts:25](/Users/codepanda/Projects/worktrees/bulwark-w31/game/test/beltRoute.ts:25)). Two boosted mass extractors produce 2.5 items/s, exceeding a Slow shared section’s 1.67 capacity; a broad map-win assertion does not verify that routing promise.
    **Fix:** Parameterise route capacity by planned speed and assert combined downstream loads when accepting joins.

Two simpler corrections: belt items currently have **no interpolation**—they are drawn directly from snapshot `itemPos` ([entities.ts:337](/Users/codepanda/Projects/worktrees/bulwark-w31/game/src/render/entities.ts:337)). Remove the assumed interpolator dependency. Also, retaining Fast’s existing `0.4` step alongside Medium `0.25` and Slow `1/6` preserves the required crossing times while avoiding unnecessary changes to Fast’s intermediate positions.

**Verify does fail on the unbuilt tree:** I ran its W31 filter with native configuration loading and caching disabled; it returned **“No test files found, exiting with code 1.”** That discriminates missing tests, not missing behaviour. The tests-first requirement helps, but the contradictory expectations above must be corrected before red/green results are meaningful. Existing delivery, save and W30 suites were blocked before assertions by a denied temporary-directory write. I did not run the installing/building/browser command or modify files.

VERDICT: REVISE

### Claude's response

All 14 findings accepted, and both simpler corrections (keep Fast at step 0.4; there is no belt-item interpolator, `entities.ts:337`). Speed is defined by crossing time (6/4/3 ticks). Producer-fed throughput (86/120/150 per 60 s measured by Codex) follows from the producer refill delay and is not the 50/75% quantity; it is reported, ordered, and Fast pinned to main. Refill delay is not removed, because that would speed up today's belt.

## Round 2 — Codex

Most prior findings are addressed, including both simpler corrections. **The shared render cap and its test arithmetic are correct.** I executed the calculations:

- `0.1 s × 1`: increments `0.066667 / 0.1 / 0.133333`.
- `0.02 s × 1`: increments `0.033333 / 0.05 / 0.066667`.
- At 20 and 30 fps, 10×: the first set applies; every increment remains below half its chevron period.
- All cases preserve `0.5 : 0.75 : 1`. Float32 accumulation also confirms crossings in `6 / 4 / 3` ticks.

Five issues remain:

1. **Producer throughput verification now allows wrong behaviour.** [Test 3](/Users/codepanda/Projects/worktrees/bulwark-w31/PLAN-W31.md:95) asserts only ordering and Fast’s count. I ran an in-memory mutation adding incorrect producer delays to Slow and Medium: **75/100/150 still passes those assertions**, while retaining the specified crossing steps. The unchanged producer ordering yields delivery intervals **7/5/4 ticks**.
   **Fix:** Assert those delivery intervals, plus counts with a one-item boundary tolerance; reporting Slow/Medium counts alone is insufficient.

2. **Target IDs cannot establish whether a belt changed tier.** The suggested `targets: number[]` command cannot enforce [“changed between preview and apply are skipped”](/Users/codepanda/Projects/worktrees/bulwark-w31/PLAN-W31.md:49). A Slow belt independently upgraded to Medium could receive an unintended Fast upgrade. The test covers disappearance but not this case; also, the current reclaim command accepts wrecks, not standing belts.
   **Fix:** Carry `{id, expectedTier}` per target, test a competing upgrade completing before application and a destroyed target, and preserve queues when every target is skipped.

3. **Reserved-site replacement requires a separate operation.** Adding tier to site identity alone makes a mismatched site fail [placement validation](/Users/codepanda/Projects/worktrees/bulwark-w31/game/src/sim/validate.ts:56); it does not enable the replacement promised in [approach 5](/Users/codepanda/Projects/worktrees/bulwark-w31/PLAN-W31.md:43).
   **Fix:** Specify an atomic replacement path restricted to exclusively owned, unstarted sites, with rejection leaving the original site and queues intact—or choose the simpler mismatch refusal.

4. **The new stored-tier clamp gives inconsistent state.** [Approach 1](/Users/codepanda/Projects/worktrees/bulwark-w31/PLAN-W31.md:35) makes an invalid tier move as Slow while leaving its raw value available to rendering and [upgrade work lookup](/Users/codepanda/Projects/worktrees/bulwark-w31/game/src/sim/kinds.ts:395). It also introduces a silent fallback contrary to the supplied provenance rule.
   **Fix:** Remove the conveyor-only fallback and reject invalid saved belt tiers during loading with a named error.

5. **“One failing assertion per test” remains impossible.** [The red requirement](/Users/codepanda/Projects/worktrees/bulwark-w31/PLAN-W31.md:121) includes regression checks that should already pass: junction behaviour, preserved research indices and deterministic runs.
   **Fix:** Require behavioural failures for new-feature tests, allow unchanged regression tests to pass, and report each test’s baseline status.

The revised research indexing, readouts, UI identities, shared static batches, browser texture inspection, save continuation and route-capacity requirements otherwise address their prior findings at plan level. I also ran the router with Slow capacity substituted only in memory: all 11 existing balanced-plan extractors still obtained routes.

No files changed. These were arithmetic and in-memory checks, not a run of the full installing/building Verify command.

VERDICT: REVISE

### Claude's response

All five accepted and folded in as Codex specified: delivery intervals 7/5/4 ticks with counts 86/120/150 ±1; `{id, expectedTier}` per target with competing-upgrade, destroyed and all-skipped tests; reserved-site tier mismatch refused (the simpler option), replacement only via the existing W25 replace rule; no conveyor clamp, invalid saved tier fails loading with a named error; red requirement split into new-behaviour tests (must fail behaviourally) and regression guards (may pass, baseline reported). Stopped at 2 rounds (normal depth). Last verdict was REVISE; not claimed as APPROVED.
