# Plan: W29 — mined resources travel by belt to a core

Branch `w29-belts` from `main` at `d82db0b` (PR #1 merged, build 136). Worktree `~/Projects/worktrees/bulwark-w29-game`. The W24 plan stays in `PLAN.md` as history; this file is the spec for this build.

Sources of the decisions: the W29 entry of the vault note `Projects/Base Defence Game — Wayfinder Map.md` (Richard, 2026-10-10), the belt-cost decision (Richard, 2026-10-11: 0.5 mass per tile, starting pool stays 600), and two answers given while drafting this plan (2026-10-11): salvage does not go into the core; repair works on any damaged building.

## Goal

Mined mass and rare material stop entering the pool the moment they are dug. Each extractor puts what it digs into its own buffer and onto a belt whose back faces it. The belt carries items to a new fixed building, the **core**, and each item enters the shared pool when the core takes it. Energy stays instant. The commander's own income stays instant.

A player in the sandbox (`?sandbox=1`) can build a mass extractor on a deposit, lay a belt from it to the core, and see mass arrive: the items move along the belt, the core's readout counts them, and the pool rises by the delivered amount.

## Approach

### Simulation (`game/src/sim/`)

1. **World option `belts` (boolean).** `new World(...)` defaults to `false`: the instant economy of today, so flat-terrain unit fixtures and old saves keep their meaning. `createWorld(seed, 'map1' | 'sandbox')` sets it to `true` and places the core. `'stress'` stays instant. The option is saved and loaded with the world; a save without it loads as `false`.
2. **Item kinds.** Append `ITEM_MASS = 5` and `ITEM_RARE = 6` to `kinds.ts` (`ITEM_NAMES` too). One mass item carries 1 mass; one rare item carries 1 rare.
3. **Core building.** Append `'core'` to `BUILDING_KINDS` (the order is part of the snapshot format: append only). Footprint 3×3, 4,000 HP, not in the build bar, not buildable, not reclaimable, cannot be upgraded or converted. New role `'core'` so no existing alien goal category treats it as its goal. `createWorld` places it complete on map 1 and in the sandbox, next to the commander's start (`terrain.base`), on tiles that keep clear of the start units and of every building in `test/plans.ts`. The author picks the exact tiles and records them in `balance.ts` with a comment; the W29 model measured belt lengths to (64.5, 64.5), so the core should sit within 3 tiles of that point. The stress scene's random building pool (`scenarios.ts`) excludes the core; a test asserts no `belts: false` scenario contains one.
3a. **The core is impassable, never an obstruction target.** Its footprint is impassable in every flow-field cost grid (like rock), so aliens route round it and never try to break through it, whether it is enabled or disabled. The only way an alien attacks the core is the pass rule in item 8. (Codex round 1: a retained 0-HP building in a corridor trapped an alien shooting it.) Tests: an alien whose route passes the core goes round it; a disabled core never holds an alien in place.
4. **Extractors with belts on.** `stepEconomyIncome` stops adding extractor output to the pool when `w.belts` is true. Instead each complete extractor adds its output per tick to its own buffer (the existing `stock` column, or a new one if `stock`'s type cannot hold a fraction). Buffer cap = `EXTRACTOR_BUFFER_SECONDS` (180) × the extractor's output per second: 180 mass for a mass extractor at today's tuning, 45 rare for a rare extractor. A full buffer stops digging; the excess is not added. Whenever the buffer holds ≥ 1, the extractor puts one item on a belt whose back faces it, using the same `output()` rule machines and the depot use. Tuning multipliers (`w.extractorOutput()`) still apply to the dig rate. Whether an extractor is digging this tick goes into the snapshot (a flag), and the renderer stops the extractor's digging animation when it is not (today `anim.ts` animates on `BF_COMPLETE` alone). `w.incomeRate` reports what entered the pool: delivered mass and rare per second (a rolling average over the last 10 s, kept as a fixed ring of per-tick or per-second delivery counts with its cursor), plus the commander's instant income and energy. The ring and cursor are saved, so a load at any point gives the same later snapshots and HUD rates. The HUD readout labels the rate so that it is clear it counts delivered resources (wording is the author's).
5. **Core intake.** `offer()` in `conveyor.ts` gains a core branch: a complete, enabled core takes `ITEM_MASS` and `ITEM_RARE` from a belt pointing into any of its 12 perimeter cells, one item per input cell per tick, and adds it to `w.pool`. It refuses everything else: a salvage, scrap, alloy or part item waits at the core's edge and the belt backs up. The core keeps running counts of delivered mass and rare for the readout and stats.
6. **Belt cost.** `belt` costs `[0.5, 0, 0]` (was `[2, 0, 0]`); build time unchanged (4 BP·s). Splitter and merger unchanged. This applies in both economy modes. Any cost label that would round 0.5 to 0 or 1 must show "0.5".
7. **Disabled core.** At 0 HP the core is not destroyed: it gets a new flag (`BF_DISABLED`, a free bit in the flags column), stays on the map, refuses all items, and is no longer a valid alien target. The rule lives in one place, the building damage function (`damageBuilding()` in `combat.ts`, which every shot, splash and projectile hit goes through): for the core it clamps HP at 0, sets `BF_DISABLED`, and ignores further damage while disabled; nothing removes the core. Projectiles already in flight when it is disabled do nothing to it. It is re-enabled when repaired to full HP. (Codex round 1: without a clamp two hits took a probe from 1 HP to −199.)
8. **Aliens attack the core in passing.** In `stepAliens`, the core-pass rule runs **before** the "keep shooting a valid target" step, so the retained-target branch cannot extend it. Each alien holds a saved pass state: not started, attacking until tick N (an integer deadline), or spent. An alien that is within its reach of an enabled core and whose pass is not started targets the core and sets its deadline to now + `CORE_PASS_SECONDS` (5 s) in ticks. While attacking, at the deadline, or when the core becomes disabled, the pass becomes spent and the alien drops the core as its target and resumes its own targeting the same tick. A spent alien never targets the core again. Hunters do this too (W29 changes W5: hunters no longer go only for the commander). Walls steer routes as before; nothing else in the flow fields changes apart from item 3a. Tests: the attack lasts exactly 50 ticks (± 1) even though the core stays in reach; it ends early if the core is disabled; a spent alien passing again does not attack.
9. **Belts under alien fire.** Unchanged rule: aliens of the economy category already attack belts (`role: 'floor'`). A belt tile at 0 HP is removed as today, and its item is lost. Delivery stops at the gap until a new tile is laid.
10. **Repair order (new).** A `repair` command and order kind: right-click a complete, damaged, own building with engineers or the commander selected; Shift appends as for other orders. A repairing unit walks into build range and restores HP at `buildPower × maxHp / repairTime` per second, at no resource cost, where `repairTime` is the **instance's own construction time**, `siteWork(kind, false, tier, fw, fh).time` for that building (not `w.workOf`, which returns the upgrade time while `BF_UPGRADING` is set), so a deep gate's footprint scaling counts and the rate does not change during an upgrade; for the core, `CORE_REPAIR_TIME`, 200 BP·s, so the commander alone repairs it from 0 in 25 s). Repair power is accumulated in its own per-building array, separate from `buildPower`, so a building that is both upgrading and being repaired gets both: the upgrade drains its cost as now and the repair adds HP free (Codex round 1: reusing build power on an upgrading gun spent resources and added no HP). The order ends when the building is at full HP or gone. Several units on one building add their power. Repair works on a disabled core. The right-click on a complete damaged building becomes repair; every other right-click keeps its current meaning. Repair works in both economy modes. Tests: repair and upgrade on one building at once, with the repair rate identical before and during the upgrade (checked against `siteWork(..., false, ...)`, an independent oracle); a 12-tile gate repairs at its scaled time (1,080 BP·s).
11. **Numbers in one place.** `balance.ts` gains `BELT_COST_MASS = 0.5`, `EXTRACTOR_BUFFER_SECONDS = 180`, `CORE_HP = 4000`, `CORE_PASS_SECONDS = 5`, `CORE_REPAIR_TIME = 200` and the core position, each with a one-line source comment (W29 model, Richard's 0.5, or "first pass").
12. **Snapshot and save.** Bump the snapshot version and the save version for the new kind, items, flags, buffer, digging flag, pass state, delivery ring, delivered counts, repair orders and power, and the `belts` option. Saves from `main` (every format `d82db0b` loads: save/state formats 3/6 and 2/4–5) still load, as instant-economy worlds, by explicit migration, not by version bumps alone: new columns get defaults, and every per-building-kind array (statistics in `stats.ts` and anything else indexed by kind count) is remapped, because appending `core` shifts the unit and alien indices that follow the building kinds (Codex round 1: copying the old array unchanged read commander shots as core shots). Test: a populated save written by `d82db0b` code (a fixture generated from that commit, with shots, kills and queued orders) loads, its statistics read the same per kind, and it runs on deterministically.

### Scripted plans and tests

13. **`test/plans.ts`.** The balanced plan and any other scripted plan on map 1 add belt runs from each extractor to the core, queued at their extractor's priority (the W29 model's rule). The map-1 balanced plan must still win with belts on (`test/fullmap.test.ts`); the no-defence plan must still lose. Plan *order and timing* may be retuned to get there; balance numbers (costs, HP, outputs, wave lists) may not change beyond item 6. If balanced cannot win without changing a number, STOP and report: that is a design decision for Richard, not the author's.
14. **Existing tests.** A test that breaks only because map 1 or the sandbox now delivers by belt may either opt into `belts: false` (when the test is about something else) or have its expected numbers updated (when it is about the economy). The report lists every changed test with one line saying which and why. No assertion may be deleted to get green.
15. **New tests `test/w29-*.test.ts`** (written first, committed red), covering at least:
    - no extractor income reaches the pool without a belt; the buffer fills to its cap and digging stops;
    - with a belt from extractor to core, an item's travel time is measured **from the tick it is put on the first belt tile** and equals the existing conveyor's tick-quantised rate (today 3 ticks per tile: 0.4 tile per tick with overshoot discarded, so 10 tiles take 3 s and 51 take about 15.3 s, not length ÷ 4). The conveyor's timing is not changed in this build. Conservation over 60 s is checked tick-aligned: pool change = delivered mass + commander income − cumulative spending, where cumulative spending is an exact per-tick sum the test reads from the world (add one to the world if none exists; the HUD's smoothed `__game.pool.spend` is not exact enough), and delivered mass = dug − what is still in the buffer and on the belt;
    - rare items arrive and add rare;
    - a salvage item reaching the core is refused and the belt backs up;
    - a belt cut (tile destroyed) stops delivery; the buffer then fills; re-laying the tile resumes delivery and the stored output flows out;
    - core at 0 HP is disabled, not removed, refuses items, is not targeted; repair to full re-enables it;
    - an alien passing within reach attacks the core for at most 5 s, then resumes its own target; it does not attack the same core again;
    - repair restores HP at the stated rate, costs nothing, stops at full HP, adds across units; Shift queues it;
    - belt cost is 0.5 mass per tile;
    - `belts: false` worlds behave as before (extractor income goes straight to the pool, no core);
    - save → load round trip with belts on reproduces the same future ticks (determinism); a `d82db0b` save loads.

### Renderer and UI (`game/src/render/`, `game/src/ui/`)

16. **Core model**, code-built in the existing W19 style (ivory structure, cyan light strips, as the other buildings), sized to its 3×3 footprint, with a full-detail and a simplified level like the other buildings. A disabled core is shown by a shape or icon change and a text label (for example a hazard marker and "DISABLED"), never by colour alone.
17. **Items on belts.** Mass and rare items are drawn on belts with shapes distinct from each other and from the salvage, scrap, alloy and part items (for example a mass ingot and a rare crystal), not only by colour.
18. **Readouts.** Hover on an extractor: buffer amount against cap and "full — not digging" when full. Hover on the core: HP, delivered mass and rare, and "disabled" when at 0 HP. The resource readout's mass and rare rates count delivered resources. Build bar: belt shows 0.5M.
19. **Repair in the UI.** The cursor or hint shows "repair" over a damaged own building with builders selected; queued repairs appear in the unit's queue list and on the map like other orders.

### Browser check

20. **`game/scripts/check-belts.mjs`** (new, same harness as `check-panel.mjs`, its own port and agent-browser session name, never 8822 or 8830, never `close --all`): opens `?sandbox=1`; with real mouse input selects the commander and engineers, builds a mass extractor on the nearest mass deposit, and lays a belt from the extractor to the core. If the route needs a turn it is laid as legs, the second and later legs with Shift held so they append rather than replace the first leg's unfinished orders, and each leg starts on the cell after the previous leg's end so the corner tile is laid by the outgoing leg and points along it (Codex round 1: overlapping perpendicular drags left the corner facing the first leg and jammed). Before checking delivery it asserts from `__game` that the belt is a directed chain from a cell whose back faces the extractor to a cell pointing into the core. It then runs the game at 3× and asserts, tick-aligned, that (a) before the belt was finished the pool gained no extractor mass (only commander income net of spending), (b) mass items are on the belt, (c) the core's delivered mass rises and the pool change equals delivered mass + commander income − exact cumulative spending; reads the extractor and core hover readouts from the DOM; saves screenshots `w29-belt-laid.png` and `w29-core-delivering.png` to the art-reference folder. It then damages the core to 0 through `__game` debug hooks, asserts it is disabled and that delivery stops, right-clicks it with the engineers selected, and asserts repair re-enables it.
21. **Rendering checks** in `check-render.mjs` (or `check-belts.mjs`): the core is in the rendered inventory; mass and rare items are drawn with their own meshes (today `entities.ts` clamps every item kind above `ITEM_PART` to the part mesh) and their drawn positions move between two frames; a negative control hides those meshes and confirms the check then fails. A full extractor's digging animation is stopped.
22. **Performance with delivery load.** The render benchmark in `check-render.mjs` gains a measured fixture with every map-1 extractor belted to the core, asserting at least 300 occupied belt tiles and that delivery continues through the sampling window; the existing frame and worker-step gates must pass on it. (Codex round 1: today's measured fixture has six belt pieces.)

## Key decisions & tradeoffs

- **A `belts` world option rather than a hard switch.** It keeps the 535 existing tests and old saves meaningful and isolates the change, at the cost of two income paths in `economy.ts`. Rejected: rewriting every map-1 test for belts, which would bury real regressions in expected-number churn.
- **No simulation-fingerprint check this time.** The fingerprint compare (`scripts/fingerprint-compare.mjs`) proves "simulation unchanged", which is false on purpose here: the belt cost changes in both modes and the snapshot format changes. Its job is taken by the determinism and save round-trip tests, the map-1 outcome tests, and the requirement that changed tests are listed.
- **The core takes mass and rare only** (Richard, 2026-10-11). Salvage keeps its own belts to the shredder. Where engineers drop reclaimed salvage onto a belt stays open.
- **Repair for every building** (Richard, 2026-10-11), free of cost. A destroyed belt tile is re-laid, not repaired.
- **Extractor output only by belt.** An extractor touching the core still needs a belt; on map 1 no deposit is within 19 tiles, so this only matters on test terrain.
- **First-pass numbers** (core HP 4,000, pass time 5 s, core repair time 200 BP·s) come from the W29 model or are new; they are in `balance.ts` for tuning.

## Risks & open questions

- **The balanced plan may not win in the game with belts** even though the model said it does at 0.5 per tile: the game has walking builders, real belt routes around rocks, and different rare output (0.25/s against the model's 0.1/s) and commander build power (8 against 10). Item 13 says what the author may and may not change; a loss that only a number change fixes goes back to Richard.
- **Belt routes on map 1** may need turns around rocks. Belt drags lay straight legs; turns are laid as in item 20 (Shift-appended legs, corner laid by the outgoing leg). The scripted plans use the same rule, and a test asserts each scripted belt is a connected directed chain from extractor to core.
- **Core position** must not block an approach corridor or the start units; the author checks the flow fields still reach the commander.
- **Performance:** up to 11 extractors × up to 51-tile belts adds about 500 belt items at most; the conveyor step is already per belt tile. Item 22 measures it.
- **Tests that read `incomeRate`** for extractors will change meaning under belts; item 14 covers them.

## Out of scope

- Depots or radius-limited delivery points (W29 fallback, later research).
- Filter splitters; drones or rail.
- Changes to wave lists, alien kinds, flow fields beyond the core's footprint, or any balance number except the belt cost.
- Where engineers drop reclaimed salvage onto a belt.
- Republishing the public build (done after the PR is merged, as before).

## Verify command (frozen, re-runnable)

```
bash -c 'cd ~/Projects/worktrees/bulwark-w29-game/game && npm ci --no-audit --no-fund >/dev/null && \
npx vitest run "test/w29-" && npm test && npm run build && \
(cd ../look && npm ci --no-audit --no-fund >/dev/null && npx tsc --noEmit) && \
node scripts/check-render.mjs --no-build --shots "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Rick'"'"'s World/Resources/Bulwark Art Reference" && \
node scripts/check-queue.mjs --no-build && \
node scripts/check-panel.mjs --no-build --shots "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Rick'"'"'s World/Resources/Bulwark Art Reference" && \
node scripts/check-belts.mjs --no-build --shots "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Rick'"'"'s World/Resources/Bulwark Art Reference"'
```

Red on the current tree: `npx vitest run "test/w29-"` finds no files (exit 1), and `scripts/check-belts.mjs` does not exist. After the tests-first commit it must fail on the assertions, not on a missing import alone; the author reports one assertion failure per test file from the red run.

## Author split

One author: the `author` subagent (Opus 5.5 · high) via `/implement`, for the simulation, tests, renderer and UI. The core model and item shapes are visual work; Richard signs off the look from the screenshots, which a green Verify does not prove.
