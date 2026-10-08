# W24 run 1: author notes

Branch `w24-sandbox`, worktree `~/Projects/worktrees/bulwark-w24/`. Spec: `../PLAN.md` "Run 1".

## Balance at commander build power 8

| Variant | Outcome | End tick | Commander HP |
|---|---|---|---|
| Base commit, BP 10 (Codex round 1; re-run here from a `git archive` copy) | win | 31,624 | 5,880 |
| W24 states, BP 10, before the plan change | win | 31,498 | 5,880 |
| W24 states, BP 8, before the plan change, no f32 snap | win | 31,906 | 2,400 |
| W24 states + f32 snap, BP 8, before the plan change | **loss**, wave 11 | 16,951 (28:15) | 0 |
| **Final: BP 8, core guns (60,59) and (67,59) moved from minute 3 to minute 2** | **win** | **31,468 (52:26)** | **6,000** |
| Same plan, BP 9 / BP 10 / BP 8 without the snap | win / win / win | 32,253 / 31,767 / 31,733 | 6,000 each |

Probe: `BP=<n> VARIANT=<name> npx vitest run --config scripts/vitest.bench.config.ts scripts/balance.test.ts`.

The plan is chaotic at BP 8: a one-tick change in build completion (the f32 snap below) flipped
a win into a loss before the core guns moved. With the core guns at minute 2 it won in all four
variants tried, each with the commander untouched after wave 3.

## Reserved sites stay alien goals

First implementation made reserved sites invisible to aliens (not goals). The balanced plan then
lost at wave 6 even at BP 10: queued-but-unbuilt sites had been acting as decoys for saboteurs
and rushers in W13. The PLAN table only says reserved sites do not block and add no flow cost, so
reserved sites are goals and attack targets as in W13, but are walked over when they are not the
alien's goal. Restoring that gave the BP 10 result above (31,498, 5,880 hp).

## f32 progress snap (economy.ts)

Construction progress is an f32 column. Summing one tick's share leaves a residual of about 1e-6,
so a 100 BP·s site took 201 ticks for one engineer (5 BP), and 101 ticks at 10 BP in W13. A site
with less than 1e-4 of its work left after this tick's share now finishes in the same tick, and
pays for the remainder. Result: 125 / 200 / 56 ticks for criterion 1.

## Snapshot (stress scene, tick 300–700, 400 encodes, median of 3 runs each)

| | Encode, median ms | Bytes |
|---|---|---|
| Base (`0192b27` + plan) | 0.035–0.038 | 40,404 |
| W24 run 1 | 0.039–0.042 | 43,632 |

Added per snapshot: stats 87 × f64, tuning 94 × f64, run table 32 × 4 × i32, fw/fh per building,
attribution (u8, u8, u32) per projectile, origin routes. Bench: `npx vitest run --config scripts/vitest.bench.config.ts scripts/snapbench.test.ts`.

## Existing tests changed

- `test/m3.test.ts` "refuses a save of another version": the message regex named versions 0 and 1;
  it now builds them from `SAVE_VERSION` (bumped 1 → 2).
- `test/picking.test.ts`: `buildingSize` is gone; the test iterates `buildingFootprint(kind)`
  (fw × fh) and passes the snapshot's `fw`, `fh` columns in the pick view.
- `test/plans.ts` (the scripted balanced plan, not a test file): the two core guns at minute 2.

No existing test depended on sites blocking while unbuilt; none needed changing for the
construction states.

## Browser probe (agent-browser, port 8822, session w24-author)

`/?sandbox=1`: setUnlimited, buildRun (9 tiles, detail returned), gate on the finished run
(started → complete, 4,500 hp, 3 × 1), an engineer walked through the gate row at x = 62 only
(the corridor), spawnAt with origin route drawn, tune refusal for a wall's damage, count 60
refused, commander killed by tuned hunters: notice shown, wreck left, respawn every 100 ticks,
outcome stays playing; clearAliens; `stats()` hpFromUnits 36,000 = 6 commanders. `/` (map 1):
spawnAt, setUnlimited and resetSandbox refused with "is a sandbox command (this game is map1)".
`__game.errors` 0 and no page errors.

## Known gaps for later runs

- Alien and unit health bars in the renderer still use the untuned maximum (the HUD's commander
  bar uses the tuned one).
- An unreachable run tile ends that builder's run order (same rule as a single build order); the
  tile stays reserved.
- A gate site is reserved (passable) until a builder reaches it, as every site is: converting
  walls opens the gap until the first build power arrives.
