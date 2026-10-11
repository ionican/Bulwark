# W12 — economy and wave-pacing model

A headless TypeScript simulation of Bulwark's first map. It tests whether the first-pass numbers let a sensible player keep up with the 20-wave list, and whether different strategies lead to different outcomes. It is a design tool with no graphics; the numbers feed later balancing and the W13 greybox.

## Run it

```sh
cd model
npm install
npm test          # type-check, then 20 tests (about 7 s)
npm run model     # 4 strategies × 2 storage variants + sensitivity runs (about 22 s)
```

`npm run model` writes to `model/out/`:

- `<strategy>-<variant>.csv`: one row per tick (10 per second) with the pool of each resource, income, spending, overflow wasted, build efficiency and the limiting resource, builds slowed, engineers, salvage, advanced parts, aliens and threat on the field, defence damage per second, dry heavy cannons and commander HP. These files are 2–4 MB each and are not committed.
- `summary.md`: the outcome table, the storage-cap comparison, where shortages bite (by game minute), breaches and losses, research timing, the drain-rule comparison and a sensitivity table.
- `report.html`: one self-contained page of inline SVG charts, with pool resources, threat, commander HP and parts stock over time for each strategy. Series differ by line style, marker shape and a direct label, not by colour.

All runs use seed 20261006. The same seed gives byte-identical CSVs, and outcomes were the same over seeds 1–6.

## Files

| Path | What it holds |
|---|---|
| `data/map1.ts` | The first-pass number set, with the reasoning in comments: costs, build times, outputs, deposits, engineers, chain, defence and alien stats, the 20 waves |
| `src/sim.ts` | The fixed-tick simulation |
| `src/strategies.ts` | Four build-order policies |
| `src/run.ts` | Entry point for `npm run model`, including the sensitivity changes |
| `src/summary.ts`, `src/report.ts`, `src/csv.ts` | Output writers |
| `test/sim.test.ts` | Determinism, conservation, drain, salvage, running-cost and end-condition tests |

## What the model does each tick

1. Spawns any aliens due from the wave list. Each wave group streams in at a per-kind interval, for example one swarm rusher every 0.25 s.
2. Once per game second, the strategy queues builds, upgrades and research.
3. Adds income to the pool. The commander yields 1 mass and 10 energy per second; each extractor, generator and rare extractor adds its output.
4. Draws energy upkeep. Beam turrets draw it while they have a target, shield generators while aliens are on the field or the shield is recharging, and chain machines while they have input. All energy consumers share one supply ratio, and they draw before construction.
5. Runs the salvage chain: depot salvage to shredder to smelter to assembler, giving advanced parts. Each stage's throughput is machine count ÷ processing time, capped by a one-lane belt of 4 items per second. Four salvage make one part.
6. Reclaims salvage. The strategy's share of engineers moves wreck salvage into the depot while wrecks exist and a depot stands. Those engineers do not build that tick.
7. Drains construction, Forged Alliance style. Builders are the commander (10 build power) and every engineer not reclaiming (5 each). Each builder takes one queue item in priority order, and when builders outnumber items the spare build power is split across them. Every active item, and the current research, requests cost × (build power × tick ÷ build time). For each resource the ratio is the pool ÷ what was requested, capped at 1. Each build progresses at the lowest ratio among the resources it draws. All builds that draw a short resource therefore slow by the same factor and finish later, never stall outright, and never fail.
8. Drops the engineers' temporary turret, which is free, recharges for 75 s and lasts 30 s. It goes on the approach with the most aliens within 40 m.
9. Fires the defences (see below), then removes dead aliens. Each dead alien adds its salvage to the wrecks. Kills are the only source of salvage.
10. Moves the surviving aliens, or lets them attack.
11. Recharges shields at the energy ratio, decays wrecks by 0.4% per second, then applies the storage cap if the run has one: anything above the cap is wasted.
12. Ends the run if the commander is dead (a loss), or if every wave has spawned and no alien remains (a win). A hard stop at 70 minutes counts as a timeout.

## Combat abstraction

Combat is deliberately not spatial. Each approach (north, and east from wave 7) is a single line measured in metres from the base edge (0) out to the spawn point (100 m).

- **Defences** are placed on an approach or at the core. A defence on an approach can hit any alien on that approach within its range: 25 m for the gun turret, 40 m for the area and heavy cannons, 60 m for the beam turret. A core defence hits only aliens that have reached the base, from any approach. Armour is subtracted from each shot's damage, but at least 10% of the shot always gets through. One damage type exists, so defences differ by range, rate of fire, splash and running cost.
- **Target choice.** Defences shoot the nearest alien, except that the beam turret prefers commander hunters and the heavy cannon prefers wall-breakers. An area cannon shot also hits up to 6 more aliens within 4 m of the target, at 60% damage.
- **Walls** stand 10 m out. Swarm rushers and wall-breakers stop at a standing wall and attack it. Wall-breakers deal three times their damage to walls and turrets. Commander hunters and saboteurs slip round walls instead, at half speed for the last 30 m. This stands in for Mindustry's round-or-through flow field: in the model, aliens never route round a wall because it is cheaper.
- **Rare points** sit 50 m out on their approach. Saboteurs stop to attack a rare extractor there, so only beam turrets protect the rare points.
- **Inside the base** (0 m), aliens attack their target category. Commander hunters attack the commander. Rushers and wall-breakers attack that approach's turrets, then core turrets, then economy buildings, then the commander. Saboteurs pick a random economy building, chain machine or engineer, then the commander. A breach therefore wrecks the base before it reaches the commander, as W9 requires.
- **Shields.** A shield generator on an approach shields that approach's turrets; one at the core shields the commander, the economy and the engineers. It absorbs damage scaled by the energy ratio, so with no energy it absorbs nothing. Walls and rare extractors are never shielded.
- **The commander** has a short gun (40 damage per second) that only hits aliens inside the base. Losing the commander loses the map.

## Choices this model makes where the brief left room

- **Research:** a fixed research order per strategy. Each item runs in the research lab at a fixed rate and drains its cost like a build, mostly rare material and energy. Unlocks: beam turret, heavy cannon, shield generator, and tier 2 for gun, area cannon and wall, plus wall tier 3. Engineers then upgrade individual buildings through the unlocked tiers, at a cost.
- **Drain rule:** per-resource ratios (step 7), not one global factor. The first number set showed that a global factor lets a rare-starved research item slow every mass-only build. Both rules are compared below.
- **Storage caps (W6's open question):** the capped variant gives the commander 600 mass / 3,000 energy / 40 rare of storage. Each storage building (100 mass, 300 energy) adds 600 / 3,000 / 60, and overflow is wasted. Strategies build storage only in the capped variant.
- **Engineers' turret** is automatic in every strategy, so it does not separate them.
- Not modelled: calling a wave early, pause and speed controls, repair, engineer walking time, belt geometry, nests and the full flow field.

## Strategies

| Strategy | Plan |
|---|---|
| balanced | Half the deposits first, two walls and two gun turrets north, then the lab, a rare point and the salvage chain by minute 5. East is fortified from minute 12 (it opens at 18:00). Then a mix of all six defences on both approaches. 40% of engineers reclaim. |
| greedy | All 8 deposits, 10 generators, all 3 rare points, 6 engineers and the lab at once, with one gun turret until minute 8. Then the balanced defence plan. |
| turtle | Walls and gun turrets only, with wall tiers 2 and 3 and gun tier 2, plus an inner ring of core guns. No salvage chain, heavy cannon, area cannon, beam turret or shield. |
| no-salvage | The balanced plan with no engineers reclaiming. The chain and the heavy cannons are built but receive no parts. |

## Findings (seed 20261006; figures from `out/summary.md`)

| Strategy | Uncapped | Capped |
|---|---|---|
| balanced | won, commander 5,976 / 6,000 HP | won, 5,976 HP |
| greedy | won, 5,388 HP | won, 5,388 HP |
| turtle | lost, wave 20, 52:38 | lost, wave 18, 47:33 |
| no-salvage | lost, wave 9, 23:24 | lost, wave 9, 23:22 |

- **Balanced keeps up, with its slack in defence rather than in economy.** One hunter reached the base all game and did 24 damage. Its build list, however, was slowed for 1,063 s by mass and 910 s by rare material, out of 52 minutes. The salvage chain made 688 parts and the heavy cannons were dry for only 6 s.
- **Greedy also wins, and the opening does not punish it.** With one gun turret until minute 8 it lost 612 commander HP to the hunters in waves 2–3 (30 rushers and 7 hunters reached the base). Its economy then finished research about 3.5 minutes earlier than balanced (heavy cannon at 6:51 against 10:25). The first map's opening is soft.
- **Turtle loses to wall-breakers, not to hunters.** Gun-turret shots of 30 (45 at tier 2) against wall-breaker armour 25 deal 5 (20). 47 wall-breakers reached the base. They destroyed 30 gun turrets, 54 walls and all 8 extractors, and dealt all 6,000 of the commander's damage.
- **No-salvage loses early, on the same build plan as balanced.** The heavy cannons held fire for 242 s without parts. Wave 8's four wall-breakers stripped the north defences, and 15 hunters from wave 9 reached the commander. Reclaiming is the difference between losing at wave 9 and winning.
- **Where shortages bite.** Mass binds in the opening for every strategy (balanced: minutes 1–8), then at 12–17 and 42–49. Rare material binds at 9–11, 15, 18–27 and 31–32 as research and beam and heavy turrets compete for it, and saboteurs destroyed 8 rare extractors in each balanced run. Energy never slowed a balanced build when uncapped (0 s). Its mean pool was 31,600 energy, so at 5 energy per second for a 60-mass generator, energy is too loose to force a choice.
- **Storage caps change little for a sensible player.** Balanced, greedy and no-salvage reach the same outcome under both variants. Caps wasted 45,136 energy for balanced (15.5% of the 290,618 earned) and no mass or rare, and raised its mass-slowed time from 1,063 s to 1,469 s (storage buildings plus the cap). Turtle loses 5 minutes earlier with caps (47:33 against 52:38) and wasted 1,595 mass. Halving what a storage building adds changes no outcome.
- **The drain rule matters more than the storage rule.** Under one global factor, balanced loses at 18:41 (wave 7) in both variants, because rare-starved research slows every build.

### Fragile numbers (from the sensitivity table, uncapped)

- **Mass per extractor.** At 0.8 (from 1), every strategy loses by wave 6 (balanced at 16:08). At 1.2, turtle wins. Mass income is the most sensitive number in the set.
- **Heavy cannon parts per shot.** At 2 (from 1), balanced loses at 48:07 and greedy at 55:01. Late waves depend on parts throughput.
- **Wall-breaker HP and armour.** HP −20% (1,200) or armour 20 (from 25) lets turtle win at 100% HP. HP +20% or armour 30 makes turtle lose earlier (44:53, 38:28). Armour 25 makes gun turrets and beam turrets nearly useless against wall-breakers, so heavy and area cannons become compulsory, which narrows the choice.
- **Late-wave size.** Waves 12–20 at −15% let turtle win.
- **Robust within ±15–20%:** hunter speed, generator output (4 or 6), engineer reclaim rate (2 per second) and storage size.

### Suggested next adjustments (not applied)

- Make energy bind: 5 energy per second for 60 mass is too cheap; try about 3 energy per second per generator, or higher beam and shield upkeep.
- Harden the opening if greed is meant to cost more: more hunters in waves 2–3, or rushers that target economy.
- Lower wall-breaker armour towards 20 if walls-and-guns play should stay viable; keep it at 25 if heavy cannons are meant to be compulsory on map 1.
