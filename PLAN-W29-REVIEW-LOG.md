# W29 plan review log (append-only)

- 2026-10-11 — Plan drafted by /spec (Claude Opus 5.5 · xhigh) from the W29 decisions in the vault Wayfinder map, Richard's belt-cost choice (0.5 mass per tile) and two answers given while drafting (salvage stays off the core; repair for every building). MAX_ROUNDS = 2 (game simulation; no auth, schema-migration or payment risk).

## Round 1 — Codex (GPT-6.1 Sol · xhigh, thread 01a129f1-2170-78a1-95ec-aaa8536de6ab)

(A first attempt, thread 01a129e7-d1d8-74b1-aa7b-54be90c34df9, was stopped by the 10-minute shell limit before it answered.)

The plan needs revision. Using its filter and include pattern, Vitest 5.0.3 returned `No test files found, exiting with code 1`; `check-belts.mjs` is also absent. Verify therefore fails on the unbuilt tree, but several proposed checks would reject correct behaviour or miss defects. I ran read-only, in-memory probes; no files were modified and the full installing/building command was not run.

1. **[P1] The five-second core attack can run indefinitely.** Item 8 inserts its logic after a branch that shoots any valid existing target and immediately continues. Once the core becomes that target, its timer is bypassed. ([aliens.ts:93](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/aliens.ts:93))  
   **Fix:** Process core-pass expiry before ordinary target retention, using a saved integer tick deadline and spent flag.

2. **[P1] An indestructible core conflicts with break-through routing.** Flow fields assign solid buildings finite traversal costs; aliens attack buildings blocking their next step. A probe retaining a zero-HP 3×3 building in a rock corridor produced ten shots and no movement over ten seconds. Disabled or spent cores can therefore trap aliens. ([world.ts:941](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/world.ts:941), [aliens.ts:164](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/aliens.ts:164))  
   **Fix:** Treat the permanent core footprint as impassable in both cost grids and exclude it from ordinary obstruction attacks.

3. **[P1] Save compatibility needs semantic migration, beyond version bumps.** New columns currently cause “Save is missing…” errors. Appending a building also shifts unit and alien statistics: copying the old array unchanged reinterprets commander shots as core shots. A populated-state probe confirmed that shift. ([save.ts:244](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/save.ts:244), [stats.ts:32](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/stats.ts:32))  
   **Fix:** Explicitly migrate save/state formats 3/6 and 2/4–5, default new columns, remap statistics, and test a populated genuine old save.

4. **[P2] The ten-second delivery history is missing from the save requirements.** Delivered totals and the current `incomeRate` cannot establish which arrivals expire next. Resetting that history on load changes subsequent snapshots and HUD rates. ([save.ts:100](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/save.ts:100))  
   **Fix:** Save the delivery window, cursor and startup state; compare every subsequent tick across loads near window boundaries.

5. **[P2] Retaining the core does not prevent negative HP.** `damageBuilding()` subtracts damage without clamping, and existing projectiles can still hit a retained building. A probe took HP from 1 to −199 with two hits, invalidating the stated repair duration. ([combat.ts:222](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/combat.ts:222), [combat.ts:322](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/combat.ts:322))  
   **Fix:** Centralise core disabling in damage handling, clamp HP to zero, and ignore further damage while disabled.

6. **[P2] The arrival-time assertion assumes transport the code does not implement.** Belts advance 0.4 tile per tick, discard overshoot and require three ticks per tile. Measured transit was 3 seconds for ten tiles and 15.3 seconds for 51, versus the proposed 2.5 and 12.75. Starting from extractor completion also adds item-production delay. ([conveyor.ts:177](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/conveyor.ts:177))  
   **Fix:** Measure from item insertion and expect existing tick-quantised travel, or explicitly authorise and test a conveyor timing change.

7. **[P2] Repair power must remain separate from upgrade power.** Upgrading buildings retain `BF_COMPLETE`. Reusing existing builder work routes power into paid construction: a damaged upgrading gun gained no HP and spent resources in the probe. ([units.ts:119](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/units.ts:119), [economy.ts:119](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/economy.ts:119))  
   **Fix:** Accumulate repair power separately and test simultaneous repair and upgrade on one building.

8. **[P2] The pool-conservation oracle omits commander income and lacks exact spending.** The commander adds 1 mass/s; a ten-second no-extractor probe gained 10 mass. `__game.pool.spend` exposes a smoothed rate, unsuitable for exact spending subtraction. This affects both the browser assertion and the 60-second conservation test. ([economy.ts:48](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/economy.ts:48), [main.ts:1555](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/main.ts:1555))  
   **Fix:** Compare tick-aligned pool, delivery and cumulative-spending deltas, explicitly accounting for commander income.

9. **[P2] Appending `core` also puts cores into the instant-economy stress scene.** Its random building pool includes every kind except four explicit exclusions, conflicting with the promised core-free `belts: false` behaviour. ([scenarios.ts:50](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/scenarios.ts:50))  
   **Fix:** Exclude core from stress generation and assert that instant-economy scenarios contain none.

10. **[P2] “Two drags” does not specify a working belt turn.** Overlapping perpendicular drags leave the corner facing along the first leg; the second placement is skipped. My probe jammed there. An unshifted second drag also replaces unfinished first-leg orders. ([main.ts:574](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/main.ts:574), [world.ts:643](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/world.ts:643))  
    **Fix:** Specify Shift-appended legs with the corner created by the outgoing leg, and assert directed connectivity before delivery checks.

11. **[P2] “The kind’s build time” is ambiguous for gates.** Gate construction time scales with footprint: a twelve-tile gate takes 1,080 BP·s, while its per-kind value is 270. Using the latter repairs a deep gate four times faster relative to its construction work. ([kinds.ts:317](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/kinds.ts:317))  
    **Fix:** Use the instance’s original construction time, including gate footprint scaling, or explicitly specify the faster repair rule.

12. **[P2] The performance check does not exercise the added conveyor workload.** Its measured fixture has six belt pieces without a delivery network; passing it does not establish performance with several hundred occupied belts. ([check-render.mjs:344](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/scripts/check-render.mjs:344))  
    **Fix:** Add a measured delivery fixture with asserted occupied-belt counts and sustained delivery throughout sampling.

13. **[P2] Verify does not establish the Goal’s visible item movement.** Snapshot items and DOM counters can pass while rendering is wrong. The renderer currently clamps all item kinds above `ITEM_PART` to the part mesh, and the browser inventory excludes core. ([entities.ts:308](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/render/entities.ts:308), [check-render.mjs:82](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/scripts/check-render.mjs:82))  
    **Fix:** Assert core rendering and distinct moving mass/rare meshes, with a negative check that fails when those meshes are hidden.

14. **[P2] Full extractors will still visibly dig.** Existing extractor motion depends solely on `BF_COMPLETE`; the plan specifies a “not digging” readout without changing that animation rule. ([anim.ts:346](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/render/anim.ts:346))  
    **Fix:** Expose actual digging activity in snapshots and stop extractor motion when its buffer is full.

VERDICT: REVISE
### Claude's response (round 1)

All 14 findings accepted; none rejected. Each was checked against the cited code before accepting.

- 1 → item 8 rewritten: the pass rule runs before target retention, with a saved integer deadline and spent state; tests for exactly 50 ticks and early end on disable.
- 2 → new item 3a: the core is impassable in every cost grid and never an obstruction target.
- 3 → item 12: explicit migration of every format `d82db0b` loads, defaults for new columns, remap of per-kind statistics; populated old-save fixture test.
- 4 → item 4: the 10 s delivery ring and cursor are saved.
- 5 → item 7: the core rule lives in `damageBuilding()`: clamp at 0, set disabled, ignore further damage.
- 6 → item 15: travel measured from insertion at the existing tick-quantised rate (3 ticks per tile); conveyor timing unchanged.
- 7 → item 10: repair power in its own array; test repair plus upgrade on one building.
- 8 → items 15 and 20: tick-aligned conservation including commander income and an exact cumulative-spending sum.
- 9 → item 3: the stress scene excludes the core; test that no instant-economy scenario has one.
- 10 → item 20 and Risks: Shift-appended legs, corner laid by the outgoing leg, directed-chain assertion before delivery checks.
- 11 → item 10: repair time is the instance's construction time, so gate footprint scaling counts.
- 12 → new item 22: measured delivery fixture with ≥ 300 occupied belt tiles.
- 13 → new item 21: core in the rendered inventory, distinct moving mass and rare meshes, negative control.
- 14 → items 4 and 21: digging flag in the snapshot; the animation stops when the buffer is full.

## Round 2 — Codex (resumed thread 01a129f1-2170-78a1-95ec-aaa8536de6ab)

13 of the 14 prior findings are addressed in the revised plan. Finding 11 remains partially unresolved; I found no additional serious issues.

1. **[P2] Repair time still changes during upgrades.** [Item 10]( /Users/codepanda/Projects/worktrees/bulwark-w29-game/PLAN-W29.md:27) specifies original construction time but directs the author to `w.workOf()`, which selects upgrade time when `BF_UPGRADING` is set. ([world.ts:821](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/world.ts:821), [kinds.ts:317](/Users/codepanda/Projects/worktrees/bulwark-w29-game/game/src/sim/kinds.ts:317)) Read-only probes returned gun times **150 → 100 BP·s** and twelve-tile gate times **1,080 → 720 BP·s**: following that instruction makes repairs 50% faster during upgrades.  
   **Fix:** Use `siteWork(kind, false, tier, fw, fh).time`, with the core override, and assert identical repair rates before and during an upgrade.

Verify’s shell syntax passes. Re-running its W29 filter with existing Vitest 5.0.3 returned **“No test files found, exiting with code 1”**; `check-belts.mjs` remains absent. It therefore fails on the unbuilt tree. The revised assertions address the previous delivery, rendering and save/load observability gaps; the repair-rate test needs the independent oracle above. I did not run the installing/building command or modify files.

VERDICT: REVISE
### Claude's response (round 2)

Accepted: item 10 now names `siteWork(kind, false, tier, fw, fh).time` and the test checks the rate is the same before and during an upgrade. Round 2 was the last round (MAX_ROUNDS = 2). The one open finding was a precise one-line correction, applied as Codex wrote it, so no round 3 was run. Plan locked 2026-10-11.
