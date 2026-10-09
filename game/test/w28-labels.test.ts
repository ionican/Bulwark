// W28: the W25b "waiting for <resource>" labels are gone (the hover readout replaces them). The
// hourglass marker on a starved site and the resource readout's "▲SHORT · N sites waiting" stay.

import { describe, expect, it } from 'vitest';
import { Scene, Sprite } from 'three';
import { createWorld } from '../src/sim/scenarios.ts';
import { waitingState } from '../src/render/waiting.ts';
import { WaitOverlay, inspectWaiting } from '../src/render/waitView.ts';
import * as waitView from '../src/render/waitView.ts';
import * as waiting from '../src/render/waiting.ts';
import { economyText } from '../src/ui/hud.ts';
import { camera, snapshotOf } from './w24r2a-fixtures.ts';
import { richardsSequence } from './w25b-fixtures.ts';

describe('W28: no "waiting for" labels; the hourglass and ▲SHORT stay', () => {
  it('a starved site carries an hourglass marker with no words, and no builder carries a label', () => {
    const { w } = richardsSequence(false);
    while (w.tick < 900) w.step();
    const snap = snapshotOf(w);
    const ws = waitingState(snap);
    expect(ws.sites.length).toBeGreaterThan(0);
    const scene = new Scene();
    const o = new WaitOverlay(scene, createWorld(1, 'sandbox').terrain);
    o.update({ camera: camera({ x: 64, z: 62, distance: 40, yaw: 0 }), viewportHeight: 900, snapshot: snap });
    const got = inspectWaiting(scene);
    expect(got.sites.length).toBe(ws.sites.length);
    for (const m of got.sites) {
      expect(m.icon).toBe('hourglass');
      expect(m).not.toHaveProperty('text');
    }
    expect(got).not.toHaveProperty('builders');
    const names: string[] = [];
    scene.traverse((s) => {
      if (s instanceof Sprite && s.visible) names.push(s.name);
      expect(JSON.stringify(s.userData)).not.toMatch(/waiting for/);
    });
    expect(names.filter((n) => n !== 'wait/site')).toEqual([]);
    expect('waitingText' in waiting, 'waitingText removed').toBe(false);
    expect('WAIT_ICON' in waitView).toBe(true);
  });

  it('the resource readout still marks the short resource and the sites waiting on it', () => {
    const text = economyText({ pool: [0, 0, 0], income: [1, 0, 0], spend: [1, 0, 0], short: [true, false, false], waiting: [2, 0, 0], parts: 0, commanderHp: 1, commanderMax: 1, aliens: 0, kills: 0, upkeep: 1, lost: false, won: false });
    expect(text.split('\n')[0]).toMatch(/▲SHORT · 2 sites waiting$/);
  });
});
