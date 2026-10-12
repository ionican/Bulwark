# Plan: W31 — three belt speeds

Branch `w31-belt-speeds` from `main` at `2f6fd0b` (build 170, W30 merged). Worktree `~/Projects/worktrees/bulwark-w31/`. Ticket: Wayfinder Map W31.

## Goal

Richard, after playing build 170: "conveyor belts are too fast. there will be three speeds of conveyor - the fastest goes at this speed, the slowest at half this speed and the middle at 75% of this speed."

Decided by Richard (2026-10-12, this session):

- **Speeds.** Fast = today's belt; Medium = 75% of it; Slow = 50% of it.
- **Getting them.** Slow belts can be built from the start. Research unlocks Medium, then Fast. Engineers upgrade laid belts in place, one speed step per upgrade, as walls and turrets are upgraded.
- **Laying.** The build menu has three belt entries (Slow, Medium, Fast). A locked entry is greyed and labelled with the research it needs. `B` selects the fastest unlocked speed.
- **Upgrading a line.** With the upgrade tool, a drag over belt tiles (the same path as laying a belt) queues an upgrade for every belt tile it crosses. A single click still upgrades one tile.
- **Look.** Each speed shows one (Slow), two (Medium) or three (Fast) chevrons per tile, scrolling at that speed. The hover readout names the speed in words. Colour is never the only signal (Richard is colour-blind).

## What "today's speed" is (measured from the code)

`BELT_TILES_PER_SECOND` is 4 (`model/data/map1.ts` `beltItemsPerSecond`), so the per-tick step is 0.4 tile at 10 ticks/s. But `stepConveyors` (`game/src/sim/conveyor.ts`) caps `itemPos` at 1 and an item entering the next tile starts at 0 (`carry = 0`), and the receiving tile does not advance on the tick it receives (`moved`). An item therefore crosses a tile every **3 ticks: 3.33 tiles/s**, which is what Richard watched. `test/beltRoute.ts:25` uses the same ceiling (`LINE_CAPACITY`).

A plain step of 0.2 and 0.3 tile/tick would give 5 and 4 ticks per tile, which is 60% and 75%, not 50% and 75%. So the speeds are defined as **whole ticks per tile**:

| Speed | Ticks per tile | Tiles/s | Share of today |
|---|---|---|---|
| Fast | 3 | 3.33 | 100% |
| Medium | 4 | 2.5 | 75% |
| Slow | 6 | 1.67 | 50% |

Per-tick steps: Fast keeps today's 0.4 (0 → 0.4 → 0.8 → next tile: 3 ticks, so Fast belts are unchanged tick for tick); Medium 0.25 (4 ticks); Slow 1/6 (6 ticks). Codex ran the current simulation and confirmed 0 → 0.4 → 0.8 → next tile (R4, review round 1). The tiles/s figure (`10 / ticksPerTile`) is the one the renderer scrolls the chevrons at and the readout shows. W30's chevrons scroll at 4 tiles/s, slightly faster than the items. With this change they match.

**Speed is crossing time, not throughput.** A line fed by a producer delivers less than 10/ticksPerTile items/s, because producers run before belts and refill the first tile one tick after it empties (`conveyor.ts:164`). Codex measured a one-tile fixture on `main` at 150 items in 60 s (not 200); with the proposed steps, 86 / 120 / 150 for Slow / Medium / Fast. Those are 57% and 80% of Fast, not 50% and 75%. Richard's "speed" is how fast items move, which is the crossing time. The refill delay stays, because removing it would make today's belt carry more.

## Approach

1. **Speed per belt tile, stored as its tier.** The `belt` kind gets two upgrade tiers through the existing tier machinery (`c.tier`, `info.tiers`, `TIER_REQUIRES`, `upgradeProblem`, `startUpgrade`, `siteWork`): tier 1 = Slow, 2 = Medium, 3 = Fast. Belt tiers change speed only (`hpMult: 1`, `damageMult: 1`). Tables in `sim/kinds.ts` indexed by tier, `BELT_STEP = [_, 1/6, 0.25, 0.4]` and `BELT_TICKS_PER_TILE = [_, 6, 4, 3]` (a test asserts each step crosses in exactly its tick count, including f32 rounding in `itemPos`), replace the single `BELT_TILES_PER_SECOND`/`SPEED`. `stepConveyors` advances each belt tile by its own tier's step. An explicit tier outside integer 1..3, or a tier on any kind but `belt`, is refused by validation. Loading a save with a belt tier outside 1..3 fails with a named error. There is no silent clamp in the conveyor. A mixed-speed line needs no special rule: one item per tile, so a slower tile downstream backs the faster ones up, and line throughput is the slowest tile's.
2. **Splitter and merger.** They stay untiered and move items at the Fast rate (3 ticks per tile), so a junction is never slower than the belts around it. The merger draws with the Fast texture. The splitter keeps W30's still rubber.
3. **Research.** Two new economy nodes in `sim/balance.ts` `RESEARCH`, source `'new'`, sized like the existing economy and intel nodes:
   - `beltMedium` "Medium belts", "belts can be laid or upgraded to Medium (75% speed)", cost [50, 500, 5], 30 s;
   - `beltFast` "Fast belts", "belts can be laid or upgraded to Fast (full speed)", cost [100, 1000, 15], 45 s, requires `beltMedium`.

   `TIER_REQUIRES.belt = ['beltMedium', 'beltFast']`. **Both nodes are appended at the end of `RESEARCH`**, because research bits and queue entries are array indices that saves store as numbers (`balance.ts:56`, `save.ts:307`). The panel may group them under Economy for display, but their indices come after `heavyT2`.
4. **Costs and build time.** A Slow belt keeps today's cost (0.5 mass) and build time (4). Upgrade Slow→Medium: 1 mass, 4. Upgrade Medium→Fast: 2 mass, 4. A belt laid directly at Medium or Fast costs the base plus every upgrade step below it (Medium 1.5 mass, build time 8; Fast 3.5 mass, build time 12), so laying fast is never cheaper than laying slow and upgrading. New numbers, recorded in `balance.ts` with their reason.
5. **Laying at a speed.** The `build` command gains an optional `tier` (belt kind only; default 1). Validation refuses a tier whose research is not done (with the research's name in the reason; the sandbox's `allTiers` debug flag lifts it, as for upgrades). The site is created with that tier and the summed cost and build time from item 4. **Tier is part of reserved-site identity** (`sim/queue.ts:231` today compares kind, tile, direction and footprint), on both the worker and the main-thread preview. A build at a different speed on a tile holding a reserved belt site of another speed is **refused** with a reason ("a Slow belt site is already planned here"), leaving the original site and every queue intact. It is never silently reused. Replacement happens only through the existing W25 rule: if an unshifted order first frees the old site (no unit still has it queued), the new site may then be placed. The drag preview's count-and-cost label (W25) shows the speed and the summed cost.
6. **Build menu.** Three belt entries replace the one: "Belt — Slow", "Belt — Medium", "Belt — Fast". A locked entry is disabled, with "needs Medium belts" or "needs Fast belts" in its text. `B` selects the fastest unlocked entry. Tier is carried through every place that today keys on kind alone: build-button identity (`ui/buildbar.ts:63`), the active tool, and the drag-plan cache (`dragPlan.ts:273`), so switching speed (including while paused) recomputes the preview cost.
7. **Drag-upgrade.** In the upgrade tool, a left-drag plans a path with the same planner the belt drag uses and collects every complete belt tile (kind `belt`, not splitter or merger) on it. Releasing issues **one** command for the whole drag, carrying `{ id, expectedTier }` per target (a new `upgrade` form or a new command; the author picks one), so the W25 queue rule (an unshifted order replaces the queue, Shift appends) applies once per drag, not once per tile. Rules:
   - targets are de-duplicated;
   - a tile is skipped if its next tier is locked, it is at Fast, or it is **already upgrading** (one speed step at a time: Slow → Fast takes a second drag after the first upgrade finishes);
   - **queue capacity is checked for the whole batch per engineer before any upgrade flag is set** (`world.ts:697` accepts orders one at a time up to 64). If the batch does not fit, the command is refused with a reason and no flag changes;
   - a target whose building is gone, or whose tier is no longer `expectedTier` when the command applies, is skipped and counted in the command's report (so a belt upgraded meanwhile to Medium is never sent on to Fast);
   - if every target is skipped, the command changes nothing: an unshifted drag does not clear the queues.

   The live preview counts per destination and its cost ("8 to Medium · 4 to Fast · 3 skipped · 16 mass") and marks skipped tiles with the W25 skipped-tile mark. A click still upgrades one tile.
8. **Hover readout.** The building readout shows "Conveyor belt · Slow (1.7 tiles/s)" / "Medium (2.5 tiles/s)" / "Fast (3.3 tiles/s)" for every belt state: healthy, damaged, reserved, constructing and upgrading (with the speed it is going to). This means changing `render/buildingReadout.ts` (it returns null for a healthy belt today, `buildingReadout.ts:49`) as well as `render/siteReadout.ts` (null for complete buildings, `siteReadout.ts:100`).
9. **Render: three chevron textures and three phases.** The W30 chevron texture becomes three textures (one, two, three chevrons per tile; one texture repeat is still one tile of travel), each on its own belt-surface material. **Only the belt-surface piece is split by tier.** Each belt shape bakes into three material pieces (`w17Batches.ts:89`, Codex counted). The rail and body pieces stay shared across tiers, so a mixed-tier shape costs at most two extra draw calls, not six. `BeltFlow` uses one capped game-time delta per frame, `g = min(rawSeconds × speed, 0.04)` game-seconds, and advances each tier's phase by `g × tilesPerSecond(tier)`. That keeps the 0.5 : 0.75 : 1 ratio under the cap, and every tier stays below half its chevron period per frame (Fast 0.133 < 0.167, Medium 0.1 < 0.25, Slow 0.067 < 0.5). Paused, reset and rewind behave as in W30. `__game.beltFlow()` reports, from the drawn meshes, each tier's material, texture, chevron count and offset, and the three phases. Belt items are drawn straight from snapshot `itemPos` (`render/entities.ts:337`), with no interpolation, so item drawing needs no change.
10. **Saves.** Belt tier is already in the saved `tier` column, so the save format does not change. A save from build 170 loads with every belt at tier 1, i.e. Slow. That is intended (Richard: belts are too fast), and its research is unchanged. If the author finds the snapshot or save version must change after all, they bump it with a round-trip test and say why.
11. **Scripted plans (`test/plans.ts`, `test/beltRoute.ts`).** Belts in every map-1 plan are Slow. `beltRoute.ts`'s single `LINE_CAPACITY` becomes a capacity per planned speed, and the router accepts a join only if the combined producer output downstream fits that section's capacity (two boosted mass extractors at 2.5 items/s exceed a Slow section). A test asserts the combined downstream load on every accepted join. The balanced plan must still win map 1 and the no-defence plan must still lose (`test/fullmap.test.ts`). Plan order and timing may be retuned, and the balanced plan may research `beltMedium`/`beltFast` and upgrade if it needs to. Balance numbers outside items 3–4 may not change. **If the balanced plan cannot win without changing a number, STOP and report**: that is Richard's decision.

## Key decisions & tradeoffs

- **Ticks per tile, not tiles per second.** Only whole ticks per tile give exactly 50% and 75% at 10 ticks/s with the current one-item-per-tile rule. Carrying the overshoot into the next tile would make 2 and 3 tiles/s exact, but it would also speed today's belt up from 3.33 to 4 tiles/s, against "the fastest goes at this speed".
- **The tier column, not a new belt kind.** Reuses the upgrade path, research gating, the save column, picking and the readout. Three kinds would need upgrades to replace a building.
- **One speed step per upgrade.** Matches walls. Taking a Slow line to Fast is two drags. Laying new belts at Fast is one step.
- **Junctions at Fast, untiered.** Simpler than tiering splitters and mergers. The cost: a Slow line through a merger runs at Slow speed on its belts and briefly faster through the merger tile. Richard can reverse this at sign-off.
- **Old saves become Slow.** The alternative (load old belts as Fast to preserve their behaviour) means a version branch in the loader for a game with no players yet.
- **Simulation output changes on purpose.** Fast belts are identical tick for tick (step 0.4), but map-1 plans now lay Slow belts, the research list grows and the plans change. The W12/W29 fingerprint compare does not apply (as in W29). Determinism and save round-trip tests and the map-1 outcomes replace it. Every changed existing test is listed with its reason in the author's report.

## Risks & open questions

- **Economy.** A Slow line fed by one producer carries about 1.43 items/s (86 per 60 s, Codex's in-memory run). Merged lines are capped by item 11's router. Item 11's STOP rule covers a lost map.
- **Item motion at Slow.** Items jump from snapshot to snapshot (no interpolation, 10 per second). At Slow they move 1/6 tile per jump, smaller than today's, so they look smoother, not worse.
- **Instancing.** Only belt surfaces split by tier; check `check-render.mjs` with a mixed-tier fixture.
- **Readout precision.** 3.33 is shown as 3.3. The words Slow / Medium / Fast are the primary label.

## Out of scope

- Splitter and merger tiers.
- Belt look at strategic zoom (icons stay as they are).
- Changing any other balance number, any other unit, or W30's still splitter.

## Verify command (frozen, re-runnable)

```
bash -c 'cd ~/Projects/worktrees/bulwark-w31/game && npm ci --no-audit --no-fund >/dev/null && \
npx vitest run "test/w31-" && npm test && npm run build && \
(cd ../look && npm ci --no-audit --no-fund >/dev/null && npx tsc --noEmit) && \
node scripts/check-render.mjs --no-build && \
node scripts/check-belts.mjs --no-build && \
node scripts/check-belt-flow.mjs --no-build && \
node scripts/check-belt-speeds.mjs --no-build --shots "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Rick'"'"'s World/Resources/Bulwark Art Reference"'
```

`test/w31-*.test.ts` (written first, red before the change), in Node:

1. **Crossing time.** On an unobstructed line, an item entering a tile enters the next after exactly 6 (Slow), 4 (Medium), 3 (Fast) ticks, with `itemPos` as stored (f32). Fast's per-tick positions equal `main`'s (0, 0.4, 0.8; constant in the test citing `2f6fd0b`).
2. **Saturated capacity.** A pre-filled long line of each tier, sink always accepting: after a 10 s warm-up, items leave at one per 6 / 4 / 3 ticks.
3. **Producer-fed throughput.** One extractor (stock held full) feeding a one-tile line into the core: after warm-up, consecutive deliveries are exactly 7 (Slow), 5 (Medium) and 4 (Fast) ticks apart (crossing time plus the one-tick producer refill), and the 60 s counts are 86, 120 and 150 within 1. Fast's 150 is re-measured on `main` by the author and pinned with that citation.
4. **Mixed line.** Fast → Slow → Fast and all-Slow lines, saturated: same leave rate (Slow's); no item lost or duplicated.
5. **Junctions.** Splitter and merger cross in 3 ticks and have no tiers (`upgrade` refused with a reason).
6. **Tier validation.** `build` with tier 2 or 3 and `upgrade` of a belt to Medium or Fast are refused before the research and accepted after; `beltFast` refuses before `beltMedium`; reasons name the research. Tiers 0, 4, 1.5, NaN, a string, and any tier on a non-belt kind are refused, also with `allTiers` on.
7. **Costs.** A Medium belt site drains 1.5 mass with build time 8; Fast 3.5 and 12; upgrades 1 and 2 mass, 4 each.
8. **Reserved-site identity.** A shifted Fast build on the tile of a reserved Slow belt site is refused with a reason and leaves the site and queues intact; an unshifted Fast build whose replace step frees the Slow site places a Fast site; a save with a belt tier of 0 or 4 fails to load with a named error.
9. **Drag-upgrade command.** One command over 10 belt tiles including a splitter, a Fast belt, a duplicate and one already upgrading: 6 upgrades queued, the rest skipped with counts; unshifted replaces the queue, Shift appends; engineers finish and all 6 read Medium. Capacity: an engineer with 60 queued orders plus a 10-target batch is refused with no upgrade flag changed; a drag of more than 64 targets is refused the same way. Stale targets: a target destroyed before apply is skipped; a target whose competing upgrade to Medium completes before apply (its `expectedTier` was Slow) is skipped, not sent to Fast; a command whose targets are all skipped leaves every queue unchanged, shifted or not.
10. **Research indices.** `RESEARCH` ids `wallT2`..`heavyT2` keep their indices from `main`; a build-170 save with completed, current and queued research loads with the same research state.
11. **Saves.** A build-170 save fixture (`make-d82db0b-save.ts` pattern) loads with belts at tier 1 and they cross in 6 ticks. Continuation: a mixed-tier world run uninterrupted equals the same world saved and restored mid-run, compared every tick through mixed-speed transfers, a blocked junction, a pending batch upgrade and an upgrade completing.
12. **Determinism.** Two runs of the same mixed-tier command log produce identical snapshots.
13. **Belt routes.** `beltRoute.ts` refuses a join whose combined downstream producer output exceeds the section's planned-speed capacity; the balanced plan's routes all pass that check.
14. **Render phase.** With the shared capped delta: 0.1 s frames at speed 1 advance phases by 0.0667 / 0.1 / 0.1333 (all capped at 0.04 game-s, ratio 0.5 : 0.75 : 1); 0.02 s frames advance 0.0333 / 0.05 / 0.0667; 0 while paused; no jump on reset or rewind; at 20 and 30 fps at 10×, every tier's step is > 0 and below half its chevron period.
15. **Readout.** `buildingReadout`/`siteReadout` give "Slow (1.7 tiles/s)", "Medium (2.5 tiles/s)", "Fast (3.3 tiles/s)" for healthy, damaged, reserved and constructing belts, and the destination speed while upgrading.
16. **UI identity.** The three belt buttons have distinct ids; the drag-plan cache key includes tier (a paused switch Slow → Fast changes the preview cost); `B` selects Slow, then Medium, then Fast as each research completes.

`scripts/check-belt-speeds.mjs` (agent-browser, own session `w31speed`, strict port 8843, closes only its own session, never `close --all`), in the sandbox:

- the build menu shows three belt entries; Medium and Fast are disabled with their research named; pressing `B` selects Slow; after granting each research (sandbox command) the entries enable and `B` selects the new fastest;
- lays one line of each speed with real mouse drags from the build menu buttons, a merger feeding one of them; measures in the page each line's crossing **duration** from snapshots: Medium/Fast = 4/3 and Slow/Fast = 2 within 5%;
- per-tier render from the drawn meshes (`__game.beltFlow()`): each straight, corner, join and the merger draws the material of its own tier; counting chevrons along the centre column of the texture actually attached gives 1, 2, 3; offsets advance at 0.5 : 0.75 : 1 while running and stop while paused;
- drag-upgrades the Slow line with the upgrade tool and real mouse: the preview label shows the per-destination count; after the engineers finish, every tile reads Medium in the hover readout;
- `check-render.mjs` runs with a mixed-tier fixture; the draw-call count is reported;
- 0 console errors; close-ups `w31-belt-slow.png`, `w31-belt-medium.png`, `w31-belt-fast.png`, `w31-build-menu.png`, `w31-upgrade-drag.png` for Richard.

`check-belt-flow.mjs` (W30) is updated for per-tier phases. Its existing assertions and negative controls stay.

Red on the current tree: `npx vitest run "test/w31-"` finds no files (exit 1), and `scripts/check-belt-speeds.mjs` does not exist. After the tests-first commit, every test for new behaviour (1–3, 6–9, 11 continuation with tiers, 13–16) fails on a behavioural assertion, not a missing import alone. Regression guards that should already pass on `main` (5's junction timing, 10, 12) may pass. The author reports each test's baseline status.

Look-and-feel needs Richard's sign-off on the screenshots and in the game. The Verify proves function only.

## Author split

All to `/implement` (the `author` subagent, Opus 5.5 · high). Bulwark is not IMS, so `/sveltify` does not apply. The visual part (chevron counts, the build-menu entries) is small and checked by the screenshots above.
