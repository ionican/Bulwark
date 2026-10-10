// W24 run 3 (Codex review 2): keyboard focus after the sandbox panel's Tune controls. A slider or
// the kind list operated with the pointer gives focus back to the page once the pointer is done
// (a slider: on release; the list: once a choice is made, not while it is open), so Space and the
// tool keys work at once. A control focused from the keyboard (Tab) keeps focus, so the keys still
// edit it. The spawn count field is not a Tune control: a click there is for typing.
// Pure apart from the elements it is handed (test/w24r3-focus.test.ts).

/** What FocusReturn needs of an element. */
export interface Focusable {
  tagName: string;
  type?: string;
  blur(): void;
}

/** True when keys typed with `t` focused belong to it (a field or a list), not to game shortcuts. */
export function editingTarget(t: { tagName?: string } | null | undefined): boolean {
  const tag = t?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

const isSlider = (t: Focusable) => t.tagName === 'INPUT' && t.type === 'range';
/** The Tune tab's controls: its sliders and its kind list. */
const isTuneControl = (t: Focusable | null): t is Focusable => !!t && (isSlider(t) || t.tagName === 'SELECT');

export class FocusReturn {
  /** The Tune control the pointer last pressed, until it gives focus back or a key is used. */
  private pressed: Focusable | null = null;

  /** `defer`: runs after the current event's handlers (the slider's change event comes after release). */
  constructor(private readonly defer: (fn: () => void) => void = (fn) => setTimeout(fn, 0)) {}

  /** A pointer press inside the panel on `target`. */
  pointerDown(target: Focusable | null): void {
    this.pressed = isTuneControl(target) ? target : null;
  }

  /** A key pressed inside the panel: the focused control is being used from the keyboard. */
  keyDown(): void {
    this.pressed = null;
  }

  /** The pointer released anywhere: a slider it pressed gives focus back. */
  pointerUp(): void {
    const t = this.pressed;
    if (!t || !isSlider(t)) return;
    this.pressed = null;
    this.defer(() => t.blur());
  }

  /** `target` committed a value (change): a Tune control the pointer chose with gives focus back. */
  changed(target: Focusable): void {
    if (target !== this.pressed) return;
    this.pressed = null;
    target.blur();
  }
}
