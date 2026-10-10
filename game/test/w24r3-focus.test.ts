// Codex review 2 (W24 run 3): a Tune slider or the Tune kind list, once operated with the pointer,
// gives keyboard focus back to the game, so Space and the tool keys work at once (no map click
// needed). A control focused from the keyboard (Tab) keeps focus, so it can still be edited with
// the keys. The browser half (real clicks and keys) is in scripts/check-panel.mjs.
//
// No DOM in this suite: the elements are minimal stand-ins whose focus is tracked by a fake
// document; nothing here calls blur() itself — only the panel's FocusReturn does.

import { describe, expect, it } from 'vitest';
import { FocusReturn, editingTarget } from '../src/ui/focusReturn.ts';

interface FakeEl {
  tagName: string;
  type?: string;
  blur(): void;
}

function page() {
  const body: FakeEl = { tagName: 'BODY', blur() {} };
  const doc = { activeElement: body as FakeEl };
  const el = (tagName: string, type?: string): FakeEl => {
    const e: FakeEl = {
      tagName,
      type,
      blur() {
        if (doc.activeElement === e) doc.activeElement = body;
      },
    };
    return e;
  };
  const deferred: Array<() => void> = [];
  const focus = new FocusReturn((fn) => deferred.push(fn));
  /** The browser's own default actions: a press focuses the control it lands on. */
  const press = (e: FakeEl) => {
    doc.activeElement = e;
    focus.pointerDown(e);
  };
  const release = () => {
    focus.pointerUp();
    // the event loop runs on: deferred work happens before the next key event
    while (deferred.length) deferred.shift()!();
  };
  /** A key reaches the game's shortcuts (main.ts keydown) unless the focused element is being edited. */
  const reachesGame = () => !editingTarget(doc.activeElement);
  return { doc, el, focus, press, release, reachesGame, body };
}

describe('Codex review 2: Tune controls do not keep keyboard focus after pointer use', () => {
  it('slider: dragged with the pointer, then Space and a tool key reach the game at once', () => {
    const p = page();
    const slider = p.el('INPUT', 'range');
    p.press(slider);
    p.focus.changed(slider);
    p.release();
    expect(p.doc.activeElement, 'focus left the slider').toBe(p.body);
    expect(p.reachesGame(), 'Space').toBe(true);
    expect(p.reachesGame(), 'U').toBe(true);
  });

  it('slider: a press and release with no value change also gives focus back', () => {
    const p = page();
    const slider = p.el('INPUT', 'range');
    p.press(slider);
    p.release();
    expect(p.reachesGame()).toBe(true);
  });

  it('kind list: chosen with the pointer, focus returns once the choice is made (not while it is open)', () => {
    const p = page();
    const select = p.el('SELECT');
    p.press(select);
    p.release();
    expect(p.doc.activeElement, 'the list stays focused while open').toBe(select);
    p.focus.changed(select);
    expect(p.reachesGame(), 'Space and the tool keys after the choice').toBe(true);
  });

  it('a control focused from the keyboard (Tab) keeps focus and is edited with the keys', () => {
    const p = page();
    const slider = p.el('INPUT', 'range');
    p.doc.activeElement = slider; // Tab
    p.focus.keyDown();
    p.focus.changed(slider); // an arrow key moved it
    p.release();
    expect(p.doc.activeElement).toBe(slider);
    expect(p.reachesGame(), 'keys stay with the slider').toBe(false);
  });

  it('the spawn count field (a number input) keeps focus after a click, for typing', () => {
    const p = page();
    const count = p.el('INPUT', 'number');
    p.press(count);
    p.release();
    p.focus.changed(count);
    expect(p.doc.activeElement).toBe(count);
  });
});
