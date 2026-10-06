// Map 1 first-pass number set (W12). Every rate is per second of game time.
//
// Scale used throughout:
// - Build time is in build-power-seconds (BP·s). The commander builds at 10 BP, an engineer at 5.
//   A 100 BP·s item takes 10 s with the commander alone, 5 s with the commander plus two engineers.
// - A finished build costs its full `cost`; the cost is drawn evenly over the build (Forged Alliance).
// - Mass income tops out at 9/s (commander 1 + 8 deposits × 1). Over the 52-minute map the balanced
//   strategy earns about 27,000 mass and ends with 43 walls and turrets plus its economy; mass
//   still slows its builds for about 18 minutes, so the player has to choose what to build.
// - Energy is priced at roughly 4–5 energy per mass on buildings, so generators (10 E/s for 60 mass)
//   are the cheap way to unlock spending, and energy weapons compete with construction during waves.
// - Rare material is 0.1/s per contested point, about 250 per point over the map. It gates research
//   and tier-2 upgrades, so holding the rare points is worth defending.

import { res, type MapData } from '../src/types.ts';

const noWeapon = {
  splashTargets: 0,
  splashRadius: 0,
  splashFactor: 0,
  energyPerSecond: 0,
  partsPerShot: 0,
};

export const map1: MapData = {
  name: 'Map 1 (first slice)',
  approaches: ['north', 'east'],
  approachLength: 100, // metres from the spawn point to the base perimeter
  wallLine: 10, // walls stand 10 m out, inside every turret's range
  detourFactor: 0.5, // hunters and saboteurs slip round walls at half speed in the last 30 m
  detourZone: 20,
  rarePointDist: 50, // rare points sit half-way out: only long-range turrets (beam) cover them
  massDeposits: 8,
  rarePoints: { north: 2, east: 1 },
  startStock: res(600, 2000, 20),
  baseStorage: res(600, 3000, 40), // commander's own storage in the capped variant
  wreckDecayPerSecond: 0.004, // unreclaimed wrecks lose ~half their salvage in about 3 minutes
  beltItemsPerSecond: 4, // one-lane belt; rarely the binding limit at these chain sizes
  labRate: 1,

  commander: {
    hp: 6000,
    buildRate: 10,
    income: res(1, 10, 0),
    // Short-range personal gun: hits only aliens that have reached the base.
    weapon: { ...noWeapon, range: 0, damage: 40, shotsPerSecond: 1 },
  },

  engineer: {
    startCount: 2,
    buildRate: 5,
    hp: 200,
    reclaimRate: 3, // one engineer clears a wall-breaker wreck (40 salvage) in ~13 s
  },

  // Engineers' drop turret: free, on a 75 s cooldown, lasts 30 s, a weak gun turret.
  tempTurret: {
    cooldown: 75,
    lifetime: 30,
    hp: 300,
    weapon: { ...noWeapon, range: 25, damage: 20, shotsPerSecond: 2 },
  },

  buildings: {
    // ---- Economy -------------------------------------------------------------------------
    massExtractor: { label: 'Mass extractor', role: 'economy', cost: res(80, 300), buildTime: 100, hp: 600, income: { mass: 1 } },
    generator: { label: 'Energy generator', role: 'economy', cost: res(60, 0), buildTime: 80, hp: 400, income: { energy: 5 } },
    rareExtractor: { label: 'Rare extractor', role: 'economy', cost: res(200, 800), buildTime: 200, hp: 900, income: { rare: 0.1 } },
    // One storage building raises all three caps (capped variant). Pointless when uncapped.
    storage: { label: 'Storage', role: 'economy', cost: res(100, 300), buildTime: 100, hp: 500, storage: { mass: 600, energy: 3000, rare: 60 } },
    lab: { label: 'Research lab', role: 'economy', cost: res(250, 1000), buildTime: 200, hp: 800 },
    engineer: { label: 'Engineer', role: 'unit', cost: res(60, 200), buildTime: 80, hp: 200 },

    // ---- Salvage chain: depot -> shredder -> smelter -> assembler -> advanced parts -----------
    // 1 shredder : 1 smelter : 1 assembler is balanced at 0.2 parts/s from 0.8 salvage/s (4 salvage
    // per part). The strategies build a second smelter, which is spare capacity.
    depot: { label: 'Salvage depot', role: 'chain', cost: res(100, 200), buildTime: 80, hp: 600 },
    shredder: { label: 'Shredder', role: 'chain', cost: res(120, 400), buildTime: 120, hp: 500, machine: { stage: 0, seconds: 2.5, inputPerOutput: 2, energyPerSecond: 3 } },
    smelter: { label: 'Smelter', role: 'chain', cost: res(120, 400), buildTime: 120, hp: 500, machine: { stage: 1, seconds: 5, inputPerOutput: 2, energyPerSecond: 5 } },
    assembler: { label: 'Assembler', role: 'chain', cost: res(150, 500), buildTime: 150, hp: 500, machine: { stage: 2, seconds: 5, inputPerOutput: 1, energyPerSecond: 4 } },

    // ---- Defences --------------------------------------------------------------------------
    // Walls: no weapon. Tiers raise strength only.
    wall: {
      label: 'Wall', role: 'wall', cost: res(100, 150), buildTime: 60, hp: 1500,
      tiers: [
        { hpMult: 2, damageMult: 1, upgradeCost: res(100, 200, 4), upgradeTime: 60, requires: 'wallT2' },
        { hpMult: 3.5, damageMult: 1, upgradeCost: res(150, 400, 10), upgradeTime: 90, requires: 'wallT3' },
      ],
    },
    // Gun turret: cheap, free to run, single target, short range, small shots (weak vs armour).
    gun: {
      label: 'Gun turret', role: 'defence', cost: res(200, 600), buildTime: 150, hp: 800,
      weapon: { ...noWeapon, range: 25, damage: 30, shotsPerSecond: 2 },
      tiers: [{ hpMult: 1.5, damageMult: 1.5, upgradeCost: res(120, 500, 6), upgradeTime: 100, requires: 'gunT2' }],
    },
    // Area cannon: free to run, slow, medium range; each shot also hits up to 6 aliens within 4 m.
    area: {
      label: 'Area cannon', role: 'defence', cost: res(400, 1500), buildTime: 250, hp: 1000,
      weapon: { ...noWeapon, range: 40, damage: 80, shotsPerSecond: 0.5, splashTargets: 6, splashRadius: 4, splashFactor: 0.6 },
      tiers: [{ hpMult: 1.5, damageMult: 1.5, upgradeCost: res(200, 800, 8), upgradeTime: 150, requires: 'areaT2' }],
    },
    // Beam turret: long range, fast small shots, draws 20 E/s while it has a target, picks hunters first.
    beam: {
      label: 'Beam turret', role: 'defence', cost: res(450, 2000, 10), buildTime: 300, hp: 700, requires: 'beam',
      weapon: { ...noWeapon, range: 60, damage: 20, shotsPerSecond: 5, energyPerSecond: 30, prefer: 'hunter' },
    },
    // Heavy cannon: one advanced part per 400-damage shot every 3 s; picks wall-breakers first.
    heavy: {
      label: 'Heavy cannon', role: 'defence', cost: res(600, 2500, 20), buildTime: 350, hp: 1500, requires: 'heavy',
      weapon: { ...noWeapon, range: 40, damage: 400, shotsPerSecond: 1 / 3, partsPerShot: 1, prefer: 'breaker' },
    },
    // Shield generator: a 3000-point shield over turrets on its approach (or, at the core, over the
    // commander and economy). Draws 15 E/s while aliens are on the field or the shield is recharging.
    shield: {
      label: 'Shield generator', role: 'defence', cost: res(500, 2500, 15), buildTime: 300, hp: 600, requires: 'shield',
      shield: { capacity: 3000, regenPerSecond: 40, energyPerSecond: 20 },
    },
  },

  // Research: run one at a time in the lab; each drains its cost over its duration like a build.
  research: {
    beam: { label: 'Beam turret', cost: res(100, 1500, 25), seconds: 60 },
    heavy: { label: 'Heavy cannon', cost: res(150, 2000, 30), seconds: 75 },
    shield: { label: 'Shield generator', cost: res(100, 2000, 30), seconds: 60 },
    gunT2: { label: 'Gun turret tier 2', cost: res(100, 1000, 20), seconds: 45 },
    areaT2: { label: 'Area cannon tier 2', cost: res(150, 1500, 30), seconds: 60 },
    wallT2: { label: 'Wall tier 2', cost: res(80, 800, 15), seconds: 40 },
    wallT3: { label: 'Wall tier 3', cost: res(150, 1500, 40), seconds: 60 },
  },

  aliens: {
    // Cheap, numerous, weak. Walk the approach and stop to chew through walls, then turrets.
    rusher: { label: 'Swarm rusher', hp: 70, armour: 0, speed: 6, dps: 8, structureMult: 1, salvage: 2, target: 'defences', bypassWalls: false, spawnInterval: 0.25 },
    // Fast, fragile; slip round walls and go only for the commander.
    hunter: { label: 'Commander hunter', hp: 260, armour: 2, speed: 13, dps: 40, structureMult: 1, salvage: 6, target: 'commander', bypassWalls: true, spawnInterval: 0.5 },
    // Slow, heavily armoured; 3× damage against walls and turrets.
    breaker: { label: 'Wall-breaker', hp: 1500, armour: 25, speed: 2.5, dps: 25, structureMult: 3, salvage: 40, target: 'defences', bypassWalls: false, spawnInterval: 1.5 },
    // Slip round walls, stop at rare extractors on their approach, then hit economy and engineers.
    saboteur: { label: 'Saboteur', hp: 300, armour: 4, speed: 7, dps: 25, structureMult: 1, salvage: 10, target: 'economy', bypassWalls: true, spawnInterval: 0.6 },
  },

  // 20 hand-written waves. North is open from the start; east opens at wave 7 (18:00). Waves run 3:00 to 51:00.
  waves: [
    { n: 1, at: 180, groups: [{ entry: 'north', kind: 'rusher', count: 16 }] }, // 3:00
    { n: 2, at: 330, groups: [{ entry: 'north', kind: 'rusher', count: 24 }, { entry: 'north', kind: 'hunter', count: 2 }] }, // 5:30
    { n: 3, at: 480, groups: [{ entry: 'north', kind: 'rusher', count: 20 }, { entry: 'north', kind: 'hunter', count: 5 }] }, // 8:00
    { n: 4, at: 630, groups: [{ entry: 'north', kind: 'rusher', count: 24 }, { entry: 'north', kind: 'breaker', count: 3 }] }, // 10:30
    { n: 5, at: 780, groups: [{ entry: 'north', kind: 'saboteur', count: 6 }, { entry: 'north', kind: 'rusher', count: 24 }, { entry: 'north', kind: 'hunter', count: 4 }] }, // 13:00
    { n: 6, at: 930, groups: [{ entry: 'north', kind: 'hunter', count: 8 }, { entry: 'north', kind: 'rusher', count: 30 }, { entry: 'north', kind: 'breaker', count: 2 }] }, // 15:30
    { n: 7, at: 1080, groups: [{ entry: 'east', kind: 'rusher', count: 30 }, { entry: 'east', kind: 'breaker', count: 3 }, { entry: 'north', kind: 'hunter', count: 4 }] }, // 18:00
    { n: 8, at: 1230, groups: [{ entry: 'north', kind: 'rusher', count: 30 }, { entry: 'north', kind: 'breaker', count: 4 }, { entry: 'east', kind: 'saboteur', count: 6 }] }, // 20:30
    { n: 9, at: 1380, groups: [{ entry: 'north', kind: 'hunter', count: 14 }, { entry: 'east', kind: 'rusher', count: 30 }, { entry: 'east', kind: 'breaker', count: 2 }] }, // 23:00
    { n: 10, at: 1530, groups: [{ entry: 'north', kind: 'breaker', count: 6 }, { entry: 'north', kind: 'rusher', count: 30 }, { entry: 'east', kind: 'saboteur', count: 8 }, { entry: 'east', kind: 'hunter', count: 6 }] }, // 25:30
    { n: 11, at: 1680, groups: [{ entry: 'east', kind: 'breaker', count: 7 }, { entry: 'east', kind: 'rusher', count: 35 }, { entry: 'north', kind: 'hunter', count: 12 }] }, // 28:00
    { n: 12, at: 1830, groups: [{ entry: 'north', kind: 'rusher', count: 50 }, { entry: 'north', kind: 'breaker', count: 9 }, { entry: 'east', kind: 'hunter', count: 24 }] }, // 30:30
    { n: 13, at: 1980, groups: [{ entry: 'east', kind: 'saboteur', count: 8 }, { entry: 'east', kind: 'rusher', count: 40 }, { entry: 'east', kind: 'breaker', count: 6 }, { entry: 'north', kind: 'breaker', count: 12 }] }, // 33:00
    { n: 14, at: 2130, groups: [{ entry: 'north', kind: 'hunter', count: 40 }, { entry: 'east', kind: 'breaker', count: 14 }, { entry: 'east', kind: 'rusher', count: 30 }] }, // 35:30
    { n: 15, at: 2280, groups: [{ entry: 'north', kind: 'rusher', count: 70 }, { entry: 'north', kind: 'hunter', count: 8 }, { entry: 'east', kind: 'rusher', count: 70 }, { entry: 'east', kind: 'hunter', count: 8 }] }, // 38:00
    { n: 16, at: 2430, groups: [{ entry: 'north', kind: 'breaker', count: 15 }, { entry: 'north', kind: 'rusher', count: 40 }, { entry: 'east', kind: 'saboteur', count: 12 }, { entry: 'east', kind: 'hunter', count: 32 }] }, // 40:30
    { n: 17, at: 2580, groups: [{ entry: 'north', kind: 'hunter', count: 52 }, { entry: 'north', kind: 'rusher', count: 40 }, { entry: 'east', kind: 'breaker', count: 18 }, { entry: 'east', kind: 'rusher', count: 20 }] }, // 43:00
    { n: 18, at: 2730, groups: [{ entry: 'north', kind: 'breaker', count: 18 }, { entry: 'north', kind: 'rusher', count: 50 }, { entry: 'east', kind: 'breaker', count: 18 }, { entry: 'east', kind: 'rusher', count: 50 }] }, // 45:30
    { n: 19, at: 2880, groups: [{ entry: 'north', kind: 'hunter', count: 40 }, { entry: 'north', kind: 'saboteur', count: 12 }, { entry: 'east', kind: 'hunter', count: 60 }] }, // 48:00
    { n: 20, at: 3060, groups: [{ entry: 'north', kind: 'breaker', count: 24 }, { entry: 'north', kind: 'rusher', count: 70 }, { entry: 'north', kind: 'hunter', count: 32 }, { entry: 'east', kind: 'breaker', count: 24 }, { entry: 'east', kind: 'rusher', count: 70 }, { entry: 'east', kind: 'hunter', count: 32 }] }, // 51:00
  ],
};
