# Plan: W32 — demolish

Branch `w32-demolish` from `main` at `c926e26` (build 179, W31 merged). Worktree `~/Projects/worktrees/bulwark-w32/`. Ticket: Wayfinder Map W32.

## Goal

Richard (2026-10-12): "demolish is an action an engineer takes on a building. it produces rubble that can be immediately absorbed by the engineer and added to core stores."

His choices (AskUserQuestion, 2026-10-12):
- **Refund:** half the mass and rare spent on the building, upgrades included. Energy is not returned.
- **Time:** half the building's build time. The engineer walks over and works on it; other engineers can help.
- **Control:** a Demolish tool in the build bar's Engineers group. Click a building, or drag along a belt line or wall run to queue each piece, with a preview of the refund (the W31 upgrade tool's pattern).
- **Limits:** never the core. Every other finished building can be demolished. Unfinished sites keep today's cancel behaviour.

Rubble is never an object in the world: when the work completes, the refund goes straight into the core's stores (`w.pool`), with no carrying and no salvage chain.

## What exists today (survey of `c926e26`)

- No command removes a finished building. `World.removeBuilding` (`world.ts:805`) clears occupancy, `coreId` and the table slot, then `structureChanged()`. Its callers are alien damage (`removeDead`, no wreck), temp-turret expiry, gate conversion, orphaned reserved sites and `cancelRun`.
- Work on a building is summed build power per slot: `workOnSite` (`units.ts:124`) adds `buildRate` into `w.buildPower` (build/upgrade) or `w.repairPower` (repair); `stepConstruction` / `stepRepair` (`economy.ts:145`, `241`) turn power into progress. Repair is the nearest analogue: work on a finished building with its own power array.
- No per-building spend is recorded; only the global `spentTotal`. What a building cost is derivable from kind, tier and footprint through `siteWork` (`kinds.ts:435`): the laid cost plus each upgrade step's cost (belts: `beltLaidWork(T)` is already the total).
- `w.pool` (Float64, mass/energy/rare) has no cap. The core credits belt deliveries straight into it (`conveyor.ts:102`).
- The u8 `flags` column has no free bit (`schema.ts:48-69`). `SNAPSHOT_VERSION` 7, `SAVE_VERSION` 4. Orders are saved as JSON.
- Keys free: F, I, J, O, Z, Delete, Backspace.

## Approach

1. **Who demolishes.** Engineers only (as with wreck reclaim; Richard said "an engineer"). The commander does not demolish; a demolish command naming only the commander is refused.

2. **Command.** `{ t: 'demolish'; ids: number[]; targets: number[]; queue?: boolean }` — building ids, in drag order. A click sends one target; a drag sends the line. Planned at apply time by `planDemolish(w, cmd)` in `validate.ts`, modelled on `planBeltUpgrades` including its W31 review fixes:
   - recipients: the live engineer ids, each once (`liveUnits` filtered to engineers); none left → refused, nothing changes;
   - each target is skipped, with a counted reason, when: duplicate, gone, or ineligible by the shared static rule `demolishSkip(kind, flags)` in `kinds.ts` (the core; an unfinished site, i.e. not `BF_COMPLETE`). A building already being demolished is **not** skipped: more engineers may join, and a paused demolish resumes;
   - all skipped → refused, queues unchanged (shifted or not);
   - capacity: for every recipient, its existing orders (with `queue`) plus the orders it will actually receive must fit `MAX_ORDERS`, checked before any state changes; otherwise refused. `demolish` is exempt from the generic "every recipient's queue is full" refusal for shifted commands (`validate.ts:31`), which would otherwise refuse a shifted reissue that adds no orders; the planner's deduplicated count is the only capacity check;
   - unshifted replaces the recipients' queues once (the W25 rule, `replaceQueues`), Shift appends; each surviving target gets one `{t:'demolish', id}` order per recipient, except that a recipient that (after the replace step) already holds a demolish order for that target does not get a second one.

3. **Order and work.** New `OrderSpec` variant `{ t: 'demolish'; id }`. `stepUnits` walks the engineer into `buildRange` (`workOnSite`'s path, unreachable → order shifted off) and adds its `buildRate` to a new per-slot `w.demolishPower`. A new `stepDemolition` in `economy.ts` (after `stepRepair`) advances each target's demolish progress by `power × DT / demolishTime` and, at ≥ 1, completes it (5). The order is dropped when its target is gone. Helpers sum, as for building.

4. **Demolish progress and state.** A new f32 building column `demolish` (0..1): 0 = not being demolished. It is set > 0 by the first tick of work, so the "marked" state is "has demolish progress". Progress is kept if every engineer stops or is killed (as a building site keeps its progress); another demolish order resumes it. While `demolish > 0`:
   - the building keeps working (turrets fire, belts move, labs research) until it is removed;
   - it is not a valid target for `build`/`assist` (an upgrade on it), `upgrade`, `upgradeBelts`, `repair` or gate conversion (`gate`): those commands refuse it with a reason, drag plans skip it, and existing build/repair orders on it are dropped on their next step, so an upgrade in progress freezes.
   - **No double work on the first tick.** In the world step, after `stepUnits` has collected power and before `stepConstruction`/`stepRepair` run, every slot that received demolish power this tick or has `demolish > 0` has its `buildPower` and `repairPower` zeroed. So construction and repair never advance on a slot on the same tick that demolition starts.
   - **Gate conversion** (`planGate`, `gate.ts:128`; conversion removes walls at `world.ts:675`) is refused when any wall in the footprint has `demolish > 0` or any unit holds a demolish order on it, with a reason. Tested both ways round: gate first then demolish (the demolish targets are gone, skipped), demolish first then gate (refused).

5. **Completion, refund, time.**
   - `spent(kind, tier, fw, fh) = siteWork(kind, false, 1, fw, fh).cost + Σ_{t=1..tier-1} siteWork(kind, true, t, fw, fh).cost` (belts: equals `beltLaidWork(tier).cost`); `builtTime` is the same sum over `.time`. Gates use their own `siteWork` branch unchanged.
   - Mid-upgrade (`BF_UPGRADING`): add `progress × siteWork(kind, true, tier, …).cost` to the spend, using the stored f32 `progress`. This is the nominal cost of the partial upgrade; it differs from what the f64 drain actually spent by float rounding only (Codex probe: 40.00000000000001 drained vs 39.99999463558197 reconstructed), accepted. The time is not increased.
   - **Refund** = 0.5 × spent mass and 0.5 × spent rare (nominal, as above), added to `w.pool` in one step on the completing tick. Energy: 0. No rounding (the pool is f64; the readout shows one decimal). Tests compare refunds to 1e-6.
   - **Demolish time** = 0.5 × `builtTime` (BP·s, the same unit `siteWork` uses), so at least one tick of work. The **temporary turret** is special-cased: removed on its first tick of demolish work at any build rate (its `buildTime` is 1, `kinds.ts:171`), refund 0.
   - Then `removeBuilding(slot)`. Counted in a new stats counter `demolished` and a cumulative `demolishRefund` (mass, rare) — not in `buildingsLost`.
   - Items inside are lost, as when aliens destroy a building today: the belt piece's item, machine `inBuf`/`outBuf`, depot and extractor `stock`. The preview and readout say "items inside are lost" when there are any.
   - Destroyed by aliens before completion: today's destruction (no refund, no wreck), counted in `buildingsLost`. A building with `hp ≤ 0` (dead but not yet removed by `removeDead`, which runs after the economy step, `world.ts:398`; sandbox `damage` applies before unit work, `world.ts:658`) receives no demolish power and is never completed or refunded by demolition; `removeDead` handles it as a loss.
   - Sandbox `unlimited`: the refund is still credited from the formula (the formula is what the building costs; unlimited mode ignores the pool anyway).

6. **Special kinds.**
   - **Core:** refused everywhere (command, preview, tool hover).
   - **Gate:** demolishable; refund from the gate's own `siteWork` (the walls it was converted from were never refunded at conversion and are not counted now); removal leaves bare ground.
   - **Wall-run members:** ordinary walls; `runs.ts` already tolerates a removed id (`stepRuns` frees it). Only finished walls are targets; a run's unfinished sites keep today's cancel behaviour.
   - **Belts, splitters, mergers:** removal sets `beltsDirty` (via `structureChanged`), neighbours stop offering to the tile (occupancy), the line upstream backs up.
   - **Lab, generator, depot, extractors, machines:** per-tick recomputation already handles their absence (survey §3). Removing the last lab pauses research.
   - **Temporary turret:** demolishable; refund 0, removed on first work.

7. **Tool and UI.**
   - **Key:** `Delete` and `Backspace` (Mac "delete" sends Backspace) select the Demolish tool; the button reads "Demolish [Del]".
   - **Build bar:** "Demolish [Del] click or drag a building" in the Engineers group, enabled when the selection includes an engineer; disabled with "needs an engineer" otherwise (label, not colour).
   - **Click:** on a finished building sends `demolish` with one target; on the core, a site or nothing does nothing (hint text says why).
   - **Drag:** `beltLineTiles` from the press tile to the release tile (as the W31 upgrade drag); every building whose footprint the line touches, deduplicated, in drag order. One `demolish` command on release, reusing the cached preview plan when the tick and tiles match (W31 simplify item 6).
   - **Preview:** a client `planDemolishPreview(view, from, to)` that applies the same static skip rule as `planDemolish` (the shared `demolishSkip(kind, flags)` in `kinds.ts`, as W31's `beltUpgradeSkip`; it needs no order data, so the snapshot suffices); targets marked with a cross shape over their tiles (distinct from the build and upgrade marks by shape); label e.g. "Demolish 8 · +12.5 mass +0 rare · 2 skipped" and "· items inside are lost" when relevant.
   - **Readouts:** hovering a finished building with the tool active shows its refund and time ("Demolish: +2 mass, 2 s"). A building with `demolish > 0` reads "Demolishing 40% · +2 mass when done". The demolish readout takes precedence over `siteReadout` (which `main.ts:866` tries first and which accepts any `BF_UPGRADING` building, `siteReadout.ts:103`), so a building demolished mid-upgrade shows the demolish text, not upgrade progress. Queue text: "Demolish <label>".
   - **Render:** the building is drawn as today until removed; engineers' work lines (`c.work`) already show who is working. No rubble object, no new effect (out of scope).
   - **`__game`:** `demolish(ids, targets, queue?)` resolving with the result and skip counts (as `upgradeBelts`), and `dragPreview` covering a demolish drag (kind `demolish`, counts, refund, label).

8. **Saves and snapshot.** `SNAPSHOT_VERSION` 7 → 8 (new `demolish` column, new stats). `SAVE_VERSION` 4 → 5; 2, 3 and 4 stay in `READABLE`. A save of any readable version below 5 loads with `demolish` 0 for every building (default fill, as the W29 alien columns, `save.ts:281`) and the new counters 0; version 5 requires them. A saved demolish order and a part-demolished building restore exactly. A `demolish` value outside 0..1 or NaN fails the load with a named error (as W31's `SaveBeltTierError`). Tests that pin the versions are updated with a citation.

## Key decisions & tradeoffs

- **Engineers only.** Literal reading of Richard's sentence; the commander keeps building but not demolishing. Easy to widen later.
- **Time and refund both scale with what was built**, including upgrades: a Tier-3 wall takes longer and returns more than a Tier-1 wall. "Half its build time" read as half of the total work that went into it.
- **A new f32 column, not a flag.** The flags byte is full; a progress column carries the state and the progress in one field.
- **Mid-upgrade buildings are demolishable** (otherwise a stalled upgrade would make a building permanent). The partial upgrade's drained cost is included in the refund base.
- **Demolishing freezes upgrades and repair on that building**, so two kinds of work never run on one slot at once.
- **Items inside are lost**, matching destruction by aliens; the preview warns.
- **No cancel-demolish command.** Stop [X] or a replacing order stops the work; the building stays with its progress (it keeps working). A later demolish resumes it.

## Risks & open questions

- **Refund exploit in sandbox `unlimited`:** demolish credits resources that were never spent. Sandbox only; accepted.
- **Balance:** half refunds let a player relocate defences at half cost. The scripted balanced plan never demolishes, so its map-1 result is unchanged; this is a gameplay call for Richard after playing.
- **Footprints larger than 1×1** (machines 2×2, the gate) are targeted once each in a drag, by id.
- **Backspace** in the browser does not navigate in current Chrome/Safari; the handler calls `preventDefault` anyway.

## Out of scope

- Rubble or debris visuals, a demolish animation or sound.
- Cancelling an unfinished site's spend refund (today's cancel behaviour stays).
- Demolishing by the commander, and demolishing enemy structures.
- Refunding items inside buildings.
- The build-bar click-swallowing problem (separate change).

## Verify command (frozen, re-runnable)

```
bash -c 'cd ~/Projects/worktrees/bulwark-w32/game && npm ci --no-audit --no-fund >/dev/null && \
npx vitest run "test/w32-" && npm test && npm run build && \
(cd ../look && npm ci --no-audit --no-fund >/dev/null && npx tsc --noEmit) && \
node scripts/check-render.mjs --no-build && \
node scripts/check-belts.mjs --no-build && \
node scripts/check-belt-speeds.mjs --no-build && \
node scripts/check-demolish.mjs --no-build --shots "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Rick'"'"'s World/Resources/Bulwark Art Reference"'
```

`test/w32-*.test.ts` (written first, red on `c926e26` on a behavioural assertion; regression guards may pass), in Node:

Every test that checks a refusal also runs an accepted control in the same world, and asserts the intended reason text (on `c926e26` a `demolish` command is refused as an unknown command, so "refused, nothing changed" alone would pass). Tests of continuation, determinism and destruction first assert that demolition actually ran: an accepted command, `demolish > 0`, a live demolish order, and, where it completes, removal and the refund.

1. **Refund amounts.** `w.pool` deltas on the completing tick (to 1e-6, with income isolated by comparing against the `demolishRefund` counter) for: wall tier 1, wall tier 3, gun tier 2, a belt laid Fast, a belt laid Slow then upgraded to Fast (same refund as laid Fast), a splitter, a 2×2 machine, a gate, a temporary turret (0). Energy delta 0. Each equals 0.5 × the `siteWork` sum, computed in the test independently from the cost tables.
2. **Mid-upgrade.** A wall at tier 1 whose upgrade to tier 2 is 40% done (a near-complete 99% case too): demolish refund = 0.5 × (tier-1 cost + stored progress × upgrade cost); the upgrade's progress is unchanged from the tick before demolish work starts (first-tick suppression) to removal; its build orders are dropped. Same for a damaged building with a repair order: hp does not change from the first demolish tick.
3. **Time.** One engineer: removal on the tick predicted by 0.5 × built time ÷ build rate (with the economy's snap); two engineers: about half that; a second engineer joining a demolish already under way is accepted and speeds it up. The temporary turret is removed on its first work tick with the engineer build rate tuned to 0.25. Progress is kept when the engineer is stopped and resumes from that value.
4. **Validation.** Refused with the intended reason and no state change: commander-only ids; the core; an unfinished site; no live engineer at apply; all targets skipped (shifted and unshifted); capacity over 64 for any recipient. Duplicate unit ids count once; a recipient never holds two demolish orders for one target. A target destroyed before apply is skipped. Upgrade, upgradeBelts, assist-on-upgrade, repair and gate conversion on a building being demolished (or with a pending demolish order, for the gate) are refused with a reason; gate first then demolish skips the converted walls.
5. **Removal effects.** Occupancy cleared over the footprint; a belt line upstream of a removed belt stops delivering and nothing is duplicated; items inside are gone; a wall run with a demolished member still completes its remaining sites; the last lab removed pauses research; aliens re-target; `buildingsLost` unchanged, `demolished` +1.
6. **Destroyed mid-demolish.** First asserts `demolish > 0` and a live demolish order; then aliens destroy it: no refund (`demolishRefund` unchanged); `buildingsLost` +1; the demolish orders are dropped. Also lethal sandbox `damage` on the tick demolition would have completed: no refund, `demolished` unchanged, `buildingsLost` +1.
   - **Shifted reissue at a full queue.** An engineer holding 64 orders, one of them a demolish of target A, receives a shifted `demolish` of A: accepted, adds nothing, queue still 64. A shifted `demolish` of a new target B in the same state is refused for capacity.
7. **Drag plan.** On a line crossing 6 walls, a 2×2 machine (twice), a wall already being demolished, the core and an unfinished site: 8 targets in drag order (the part-demolished wall included), skipped counts {core 1, site 1}; the preview's targets, counts and refund equal what `planDemolish` applies (shared skip rule); release reuses the cached plan.
8. **Saves.** A build-179 save fixture (version 4, the `make-…-save.ts` pattern) loads with every `demolish` 0 and runs on; versions 2 and 3 load the same way. A world saved mid-demolish (asserted before saving: one building at demolish progress > 0 with two engineers on it, one more demolish order queued) and restored equals the uninterrupted run, compared every tick, and both runs remove both buildings and credit both refunds. A save with `demolish` = 1.5 or NaN fails with a named error.
9. **Determinism.** Two runs of the same command log with demolishes, each first asserted to remove the targets and credit the refunds, produce identical snapshots.
10. **UI.** The Demolish button exists in the Engineers group with keys Delete and Backspace; disabled without an engineer selected (label says why); readout strings for the hover refund and "Demolishing 40%", including on a building demolished mid-upgrade (demolish text wins over the upgrade readout); preview label format; queue text.

`scripts/check-demolish.mjs` (agent-browser, own session `w32demo`, strict port 8844, closes only its own session, never `close --all`), in the sandbox:

- builds a wall run, a gun turret and a belt line with real mouse input; selects the engineers; presses Delete: the Demolish tool is active (button and hint); Escape, then Backspace: active again;
- clicks the gun turret: one demolish order; the readout shows "Demolishing …%"; after completion the turret is gone, the `demolishRefund` counter rose by exactly the expected mass, and the pool change over the same ticks equals that refund plus income and deliveries minus spending (as `check-belts.mjs:91` accounts);
- drags along the belt line: the preview label shows the count and refund; after release and completion every belt tile is empty ground and `demolishRefund` rose by the previewed refund;
- clicking the core with the tool does nothing and the hint says why;
- 0 console errors; screenshots `w32-demolish-tool.png`, `w32-demolish-preview.png`, `w32-demolishing.png` for Richard.

## Author split

One author run (Opus 5.5 · high via `/implement`): tests first (red commit), then the sim (command, order, column, economy step, save), then the tool and UI, then the browser check. Browser session `w32demo`, port 8844 only.
