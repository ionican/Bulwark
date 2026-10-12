# W32 plan review log (append-only)

Plan: PLAN-W32.md. Codex model gpt-6.1-sol, xhigh, read-only. MAX_ROUNDS 5 (save/snapshot format change).

## Round 1 — Codex

Thread 01a1301f-e935-7603-9b84-8a9df05f33a6.

The plan needs revision. The main blockers are the rule that prevents engineers joining active demolition and the first-tick conflict with construction and repair.

1. **[P1] Active demolition cannot receive helpers, and the preview cannot implement the stated rule.** [PLAN-W32.md:42](/Users/codepanda/Projects/worktrees/bulwark-w32/PLAN-W32.md:42) skips a target whenever another engineer has a demolition order. That refuses a second engineer joining work already under way. Moreover, `demolishSkip(kind, flags, demolish)` cannot distinguish active work from paused progress: that requires inspecting orders, which snapshots expose separately through their queues ([snapshot.ts:162](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/sim/snapshot.ts:162)).
   **Fix:** Drop the global active-target skip; share static eligibility between preview and simulation, and deduplicate orders per recipient when appending.

2. **[P1] Construction and demolition can both advance on the first working tick.** The proposed demolition step runs after repair, while existing unit orders first accumulate power ([world.ts:391](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/sim/world.ts:391), [units.ts:124](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/sim/units.ts:124)). Checking only `demolish > 0` does not suppress work collected before the first demolition progress is recorded. A baseline probe advanced an upgrade from `0.40000000596` to `0.40833333135` before the proposed demolition phase; an almost-finished upgrade could complete and change demolition time and refund.
   **Fix:** After collecting unit power, suppress construction and repair for every slot receiving demolition power before either economy pass runs.

3. **[P2] Gate conversion bypasses demolition state.** `planGate` requires only finished walls ([gate.ts:128](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/sim/gate.ts:128)); conversion immediately removes those walls without refund ([world.ts:675](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/sim/world.ts:675)). It can therefore replace partially demolished walls, discard their progress and invalidate their orders. An in-memory probe with demolition progress attached still returned `ok: true`.
   **Fix:** Refuse gate conversion when any footprint wall has demolition progress or pending demolition work, and test both command orders.

4. **[P2] Older save migration is incomplete.** The plan specifies zero-filling version 4, but versions 2 and 3 remain readable ([save.ts:50](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/sim/save.ts:50)). Every schema column is required during loading, except the explicitly migrated W29 alien columns ([save.ts:281](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/sim/save.ts:281)); all three older versions lack `buildings.demolish`.
   **Fix:** Zero-fill the demolition column and counters for every readable version below 5, while requiring them in version 5.

5. **[P2] A demolishing building with a frozen upgrade will show the upgrade readout.** The renderer tries `siteReadout` before `buildingReadout` ([main.ts:866](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/main.ts:866)). `siteReadout` accepts any building retaining `BF_UPGRADING` ([siteReadout.ts:103](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/render/siteReadout.ts:103)). Adding demolition text only to `buildingReadout` leaves this case displaying upgrade progress and construction intake.
   **Fix:** Give demolition readouts precedence over construction readouts and add a hover test for demolition during an upgrade.

6. **[P2] The temporary turret is not a zero-time kind.** Its `buildTime` is **1**, not 0 ([kinds.ts:171](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/sim/kinds.ts:171)). With the permitted engineer build-rate multiplier of 0.25, the proposed formula takes four working ticks, contradicting the promised first-tick removal.
   **Fix:** Explicitly special-case temporary turrets for first-work-tick removal and test a reduced build rate.

7. **[P3] Stored upgrade progress does not reconstruct exact spending.** Spending uses an f64 increment before progress is rounded into its f32 column ([economy.ts:173](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/sim/economy.ts:173), [economy.ts:224](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/sim/economy.ts:224)). After 48 upgrade ticks, a probe recorded mass spending of `40.00000000000001`, while `progress × cost` reconstructed `39.99999463558197`. The claim “what the frozen upgrade actually drained” is therefore inaccurate.
   **Fix:** Define the refund as nominal cost reconstructed from progress with a bounded tolerance, or persist per-building spending if literal half-spent accuracy is required.

8. **[P2] Browser refund assertions include unrelated economy changes.** [PLAN-W32.md:127](/Users/codepanda/Projects/worktrees/bulwark-w32/PLAN-W32.md:127) requires the pool to rise by exactly the refund, but commander income continues during walking and work ([economy.ts:67](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/sim/economy.ts:67)). A baseline probe gained approximately `0.1` mass in one tick without demolition. Existing belt checks already account for income, deliveries and spending ([check-belts.mjs:91](/Users/codepanda/Projects/worktrees/bulwark-w32/game/scripts/check-belts.mjs:91)).
   **Fix:** Compare tick-aligned pool changes after subtracting income and deliveries and adding spending, alongside the cumulative demolition-refund counter.

The **Verify command’s shell quoting is valid**: substituting read-only command stubs traversed every stage and exited 0. Its W32 selector is consistent with the filenames. The current checkout contains neither W32 tests nor `check-demolish.mjs`, so the claimed behavioural red result remains unproven. I did not install dependencies or run build/browser commands because those write files.

The listed tests have mixed discrimination:

| Tests | Would they catch the unbuilt change? |
|---|---|
| 1–3, 5, 7, 10 | Yes, if they assert accepted commands and the specified positive outcomes, rather than merely unchanged state or helper output. |
| 4 | Refusal plus unchanged state can pass because the baseline refuses an **unknown command**. Assert the intended reason and include an accepted-target control. |
| 6 | Existing destruction already gives no refund and increments losses. First assert positive demolition progress and an active demolition order. |
| 8 | Continuation equality alone can pass without demolition. Assert non-zero progress before saving, preserved queued orders, and actual removal/refund afterwards. |
| 9 | **Does not discriminate as written.** Two baseline runs produced identical snapshots for 100 ticks while both refused demolition and retained the building. Assert successful application, removal and refund before comparing determinism. |

Passing regression guards are fine. Equality between two runs is insufficient evidence that the new behaviour executed. The browser check should also exercise **Backspace**, since Delete alone does not verify the promised Mac shortcut.

No files were modified; the tracked diff remained empty.

VERDICT: REVISE

### Claude's response

All eight findings accepted; none rejected. Plan revised:
1. Active-target skip dropped; `demolishSkip(kind, flags)` is static (core, unfinished) and shared by preview and sim; a recipient never gets a second demolish order for a target it already has.
2. Power suppression: after units collect power, any slot with demolish power or progress has its build and repair power zeroed before the economy passes.
3. Gate conversion refuses walls with demolish progress or a pending demolish order; tested in both command orders.
4. Zero-fill for every readable version below 5 (2, 3, 4).
5. Demolition readout takes precedence over `siteReadout`.
6. Temporary turret special-cased: removed on its first work tick at any build rate.
7. Refund defined as nominal cost reconstructed from f32 progress; tests compare to 1e-6.
8. Browser check asserts the `demolishRefund` counter exactly and the pool delta with income, deliveries and spending accounted for; Backspace exercised as well as Delete.
Test discrimination tightened for tests 4, 6, 8, 9 as listed.

## Round 2 — Codex

All eight prior findings are addressed **at plan level**: helpers can join, first-tick power is suppressed, gate conversion checks pending work, older saves migrate, demolition readouts take precedence, temporary turrets are special-cased, refunds are explicitly nominal, and browser checks account for income. Tests 4, 6, 8 and 9 now require evidence that demolition actually ran ([PLAN-W32.md:114](/Users/codepanda/Projects/worktrees/bulwark-w32/PLAN-W32.md:114)).

Two new edge cases remain:

1. **[P2] The generic capacity check conflicts with deduplicated orders.** The revised planner counts only orders actually added ([PLAN-W32.md:34](/Users/codepanda/Projects/worktrees/bulwark-w32/PLAN-W32.md:34)). An engineer holding 64 orders, including demolition of target A, receives zero new orders from a shifted reissue for A: **64 + 0 fits**. But validation subsequently rejects any shifted command whose recipients all have full queues ([validate.ts:31](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/sim/validate.ts:31)). Executing that check with a successful command-specific preflight reproduced `order queue full (64 orders per unit)`.
   **Fix:** Bypass the generic capacity fallback for demolition, use the planner’s deduplicated capacity calculation, and test shifted reissue at 64 orders.

2. **[P2] A lethally damaged building can complete demolition before destruction removes it.** Sandbox `damage` applies before unit work ([world.ts:658](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/sim/world.ts:658)); dead buildings remain in the table until `removeDead`, after the proposed demolition step ([world.ts:398](/Users/codepanda/Projects/worktrees/bulwark-w32/game/src/sim/world.ts:398)). The plan checks existence and completion flags, but never requires positive HP. A nearly completed demolition could therefore refund a building already killed by an earlier command and count it as demolished rather than lost. A baseline probe confirmed the intermediate state: **live table entry, HP −500**, followed by destruction later that tick.
   **Fix:** Require `hp > 0` before contributing demolition power or crediting a refund; test lethal damage on the finishing tick with no refund and `buildingsLost +1`.

The Verify command remains sound. The strengthened tests would discriminate against an unbuilt feature if implemented as specified, but neither new boundary case is currently listed. No files were modified.

VERDICT: REVISE

### Claude's response

Both accepted. (1) `demolish` exempt from the generic full-queue refusal for shifted commands; the planner's deduplicated count is the only capacity check; test added for a shifted reissue at 64 orders (accepted, adds nothing) and a new target in the same state (refused). (2) A building with hp ≤ 0 gets no demolish power and is never completed or refunded by demolition; test added for lethal damage on the finishing tick.

## Round 3 — Codex

Both round-2 findings are genuinely addressed:

- **Capacity:** demolition bypasses the generic full-queue refusal and uses the deduplicated planner calculation ([plan:34](/Users/codepanda/Projects/worktrees/bulwark-w32/PLAN-W32.md:34)). The new test distinguishes an accepted 64+0 reissue from a refused new target ([plan:122](/Users/codepanda/Projects/worktrees/bulwark-w32/PLAN-W32.md:122)).
- **Lethal damage:** buildings with `hp ≤ 0` receive no demolition power and cannot complete or refund ([plan:52](/Users/codepanda/Projects/worktrees/bulwark-w32/PLAN-W32.md:52)). The finishing-tick test checks no refund, unchanged demolition count and one building lost ([plan:121](/Users/codepanda/Projects/worktrees/bulwark-w32/PLAN-W32.md:121)).

Earlier fixes remain intact. No new blocking findings. The Verify command remains valid, and the planned tests now discriminate against an unbuilt feature. This approves the plan; the W32 tests and browser checker remain unwritten. No files were modified.

VERDICT: APPROVED

Converged: plan locked at round 3.
