// W24 run 3: the sandbox panel (PLAN "The panel"). On the left under the time controls, shown only
// while the snapshot's scenario is the sandbox. Five tabs — Build, Spawn, Tune, Economy, Stats —
// over the existing sandbox commands; every refusal is shown as a "bad" toast with its reason.
// Values come from the snapshot (redrawn at most 4 times a second, and on the next snapshot after a
// panel command resolves), so resets and loaded saves show without the panel keeping a copy.
// Every state is marked in words or shape as well as by style: the active tab and chosen depth by
// "▸" and an outline, armed tools by "armed", toggles by ON / OFF, all-zero stats rows by "–" cells
// in italics.
//
// The logic (SandboxPanelModel and the functions below it) is pure and tested in
// test/w24r3-panel.test.ts; the DOM half (SandboxPanel) is driven by scripts/check-panel.mjs.

import { map1 } from '../../../model/data/map1.ts';
import { MAX_RUN_DEPTH, SPAWN_AT_MAX, TUNE_MAX, TUNE_MIN } from '../sim/balance.ts';
import type { Command } from '../sim/commands.ts';
import { ALIEN_INFO, ALIEN_KINDS, B, BUILDING_INFO, BUILDING_KINDS, TICK_HZ, UNIT_INFO, UNIT_KINDS, buildingInfo, type AlienKind } from '../sim/kinds.ts';
import { gateBaseHp } from '../sim/gate.ts';
import { BF_COMPLETE } from '../sim/schema.ts';
import { G_INCOME, G_MASS, G_PARTS, G_PARTS_MADE, G_PARTS_USED, G_SCENARIO, G_SPEND, G_UNLIMITED, type Snapshot } from '../sim/snapshot.ts';
import { statsReport } from '../sim/stats.ts';
import {
  TB_HP,
  TUNE_KINDS,
  alienDps,
  alienMaxHp,
  alienSpeed,
  tuneFieldIndex,
  tuneIndex,
  turretDamage,
  turretInterval,
  turretRange,
  unitBuildRate,
  unitMaxHp,
  unitSpeed,
  type TuneTarget,
} from '../sim/tuning.ts';
import { SCENARIO_NAMES } from '../sim/world.ts';
import { snapshotRules } from '../snapshotRules.ts';
import { RESOURCE_NAMES } from '../render/waiting.ts';
import { clampInt, clampSpawnCount, type ToolName } from '../tools.ts';
import { FocusReturn, type Focusable } from './focusReturn.ts';
import { alienIconSvg } from './panels.ts';

export const PANEL_TABS = ['build', 'spawn', 'tune', 'economy', 'stats'] as const;
export type PanelTab = (typeof PANEL_TABS)[number];
const TAB_LABELS: Record<PanelTab, string> = { build: 'Build', spawn: 'Spawn', tune: 'Tune', economy: 'Economy', stats: 'Stats' };

/** Where the panel's commands go (main.ts: the worker), its toasts, and the map tools it arms. */
export interface PanelSink {
  send(cmd: Command): Promise<{ ok: true } | { ok: false; reason: string }>;
  toast(text: string, bad: boolean): void;
  /** Makes `name` the active map tool; false when it cannot be (refused by the scenario). */
  armTool(name: ToolName): boolean;
}

/** Waves the Spawn tab offers: map 1's, as startWave validates them (20: shown 1–20, sent as index 0–19). */
export const WAVES = map1.waves.length;
/** The two-click resets: the second click must come within this many ms. */
export const CONFIRM_MS = 3000;

// ---- pure helpers ----------------------------------------------------------------------------

export const scenarioOf = (s: Snapshot): string => SCENARIO_NAMES[s.globals[G_SCENARIO]!] ?? 'map1';
/** The panel is shown only for a sandbox snapshot. */
export const panelVisible = (s: Snapshot | null): boolean => !!s && scenarioOf(s) === 'sandbox';
/** The DEBUG spawn box (top right) is hidden whenever the panel is shown. */
export const debugSpawnVisible = (s: Snapshot | null): boolean => !panelVisible(s);
/** Wave shown 1–20, sent 0–19. */
export const waveIndex = (wave: number): number => wave - 1;

/** A multiplier on the tune grid: 0.1 steps from 0.1 to 2, 0.5 steps from 2 to 10. */
export function quantiseMult(v: number): number {
  const c = Math.min(TUNE_MAX, Math.max(TUNE_MIN, Number.isFinite(v) ? v : 1));
  return c <= 2 ? Math.max(TUNE_MIN, Math.round(c * 10) / 10) : Math.round(c * 2) / 2;
}
/** Slider position 0..1 → multiplier: logarithmic from 0.1 to 10 (0.5 is 1×), on the grid. */
export const sliderToMult = (p: number): number => quantiseMult(TUNE_MIN * (TUNE_MAX / TUNE_MIN) ** Math.min(1, Math.max(0, p)));
/** Multiplier → slider position 0..1. */
export const multToSlider = (m: number): number => Math.log(m / TUNE_MIN) / Math.log(TUNE_MAX / TUNE_MIN);

const num = (v: number, digits = 1): string => (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(digits));

export interface TuneLabel {
  field: string;
  /** The applied multiplier (from the snapshot). */
  mult: number;
  /** The effective tier-1 value, with research as granted and the multiplier applied. */
  value: number;
  unit: string;
  text: string;
}

/**
 * The effective tier-1 value of each field the kind supports, from the simulation's own accessors
 * (tuning.ts) on the snapshot's multipliers and research. Speeds are stored per tick and shown per
 * second; wall and gate hit points are per tile (gate depth does not apply).
 */
export function tuneLabels(s: Snapshot, target: TuneTarget, kind: number): TuneLabel[] {
  const w = snapshotRules(s);
  const out: TuneLabel[] = [];
  const add = (field: string, value: number, unit: string, digits = 1) => {
    const mult = s.tuning[target][tuneIndex(target, kind, tuneFieldIndex(target, field))]!;
    out.push({ field, mult, value, unit, text: `${num(value, digits)} ${unit}, tier 1` });
  };
  if (target === 'building') {
    const info = buildingInfo(kind);
    const perTile = kind === B.wall || kind === B.gate;
    const base = kind === B.gate ? gateBaseHp(1) : info.hp;
    add('hp', base * w.tuning.b(kind, TB_HP), perTile ? 'hp per tile' : 'hp');
    if (info.weapon) {
      add('damage', turretDamage(w, kind, 1), 'damage per shot');
      add('range', turretRange(w, kind), 'tiles range');
      add('interval', turretInterval(w, kind), 's between shots', 2);
    }
  } else if (target === 'alien') {
    add('hp', alienMaxHp(w, kind), 'hp');
    add('dps', alienDps(w, kind), 'damage per s');
    add('speed', alienSpeed(w, kind) * TICK_HZ, 'tiles/s', 2);
  } else {
    add('hp', unitMaxHp(w, kind), 'hp');
    add('speed', unitSpeed(w, kind) * TICK_HZ, 'tiles/s', 2);
    add('buildRate', unitBuildRate(w, kind), 'build power');
  }
  return out;
}

export interface StatsRow {
  name: string;
  label: string;
  values: number[];
  /** Right-aligned text: "–" for 0, else whole numbers with thousands separators. */
  cells: string[];
  /** Every value is 0 (the row is dimmed and its cells read "–"). */
  zero: boolean;
}

const cell = (v: number): string => (v === 0 ? '–' : Math.round(v).toLocaleString('en-GB'));
const row = (name: string, label: string, values: number[]): StatsRow => ({ name, label, values, cells: values.map(cell), zero: values.every((v) => v === 0) });

/**
 * The Stats tab's tables from statsReport(snapshot.stats), the function behind __game.stats().
 * Shooters: every kind with a weapon (and any other kind with a non-zero counter); aliens: every kind.
 */
export function statsTables(s: Snapshot) {
  const report = statsReport(s.stats);
  const shooters: StatsRow[] = [];
  const kinds: Array<[string, string, boolean]> = [
    ...BUILDING_KINDS.map((k) => [k, BUILDING_INFO[k].label, !!BUILDING_INFO[k].weapon] as [string, string, boolean]),
    ...UNIT_KINDS.map((k) => [k, UNIT_INFO[k].label, !!UNIT_INFO[k].weapon] as [string, string, boolean]),
  ];
  for (const [name, label, armed] of kinds) {
    const r = report.shooters[name]!;
    const values = [r.shots, r.hpRemoved, r.kills];
    if (armed || values.some((v) => v !== 0)) shooters.push(row(name, label, values));
  }
  const aliens = Object.entries(report.aliens).map(([name, a]) => row(name, ALIEN_INFO[name as AlienKind].label, [a.spawned, a.killed, a.hpFromWalls, a.hpFromBuildings, a.hpFromUnits]));
  const absorbedValues = Object.values(report.aliens).map((a) => a.absorbedByShields);
  return { shooters, aliens, absorbed: { label: 'absorbed by shields', values: absorbedValues, cells: absorbedValues.map(cell) } };
}

// ---- the panel's state and commands ---------------------------------------------------------------

export class SandboxPanelModel {
  tab: PanelTab = 'build';
  collapsed = false;
  depth = 1;
  spawnKind = 0;
  count = 8;
  wave = 1;
  routes = false;
  tuneTarget: TuneTarget = 'building';
  tuneKind = 0;
  /** Slider positions dragged but not yet released, by field. */
  private readonly pending = new Map<string, number>();
  private confirm: { full: boolean; at: number } | null = null;
  /** The snapshot the panel last read (the applied multipliers). */
  snapshot: Snapshot | null = null;

  constructor(
    private readonly sink: PanelSink,
    private readonly now: () => number,
  ) {}

  /** Sends one command; a refusal is shown as a "bad" toast with the reason. */
  private async send(cmd: Command): Promise<boolean> {
    const r = await this.sink.send(cmd);
    if (!r.ok) this.sink.toast(`Refused: ${r.reason}`, true);
    return r.ok;
  }

  tabLabels(): string[] {
    return PANEL_TABS.map((t) => (t === this.tab ? `▸ ${TAB_LABELS[t]}` : TAB_LABELS[t]));
  }
  selectTab(t: PanelTab): void {
    this.tab = t;
  }
  collapseLabel(): string {
    return this.collapsed ? '+' : '–';
  }
  toggleCollapse(): void {
    this.collapsed = !this.collapsed;
  }

  // Build
  setDepth(d: number): void {
    this.depth = clampInt(d, 1, MAX_RUN_DEPTH);
  }
  armGate(): boolean {
    return this.sink.armTool('gate');
  }
  cancelRun(run: number): Promise<boolean> {
    return this.send({ t: 'cancelRun', run });
  }

  // Spawn
  setSpawnKind(k: number): void {
    this.spawnKind = k;
  }
  setCount(v: string | number): void {
    this.count = clampSpawnCount(typeof v === 'number' ? v : v.trim() === '' ? Number.NaN : Number(v));
  }
  stepCount(d: number): void {
    this.count = clampSpawnCount(this.count + d);
  }
  armSpawn(): boolean {
    return this.sink.armTool('spawn');
  }
  setWave(n: number): void {
    this.wave = clampInt(n, 1, WAVES);
  }
  startWave(): Promise<boolean> {
    return this.send({ t: 'startWave', index: waveIndex(this.wave) });
  }
  clearAliens(): Promise<boolean> {
    return this.send({ t: 'clearAliens' });
  }
  clearWrecks(): Promise<boolean> {
    return this.send({ t: 'clearWrecks' });
  }
  /** Drawing only: no command. */
  toggleRoutes(): void {
    this.routes = !this.routes;
  }

  // Tune
  setTuneTarget(t: TuneTarget): void {
    if (t !== this.tuneTarget) this.tuneKind = 0;
    this.tuneTarget = t;
    this.pending.clear();
  }
  setTuneKind(k: number): void {
    this.tuneKind = k;
    this.pending.clear();
  }
  /** The slider moved to position `p` (0..1): shown, not sent. */
  tuneDrag(field: string, p: number): void {
    this.pending.set(field, sliderToMult(p));
  }
  /** The multiplier shown for `field`: the dragged one, else the applied one. */
  shownMult(field: string): number {
    const p = this.pending.get(field);
    if (p !== undefined) return p;
    const s = this.snapshot;
    const f = tuneFieldIndex(this.tuneTarget, field);
    return s && f >= 0 ? s.tuning[this.tuneTarget][tuneIndex(this.tuneTarget, this.tuneKind, f)]! : 1;
  }
  dragging(field: string): boolean {
    return this.pending.has(field);
  }
  /** Released: sends the dragged multiplier once (nothing when the slider was not dragged). */
  async tuneCommit(field: string): Promise<boolean> {
    const mult = this.pending.get(field);
    if (mult === undefined) return false;
    this.pending.delete(field);
    return this.send({ t: 'tune', target: this.tuneTarget, kind: this.tuneKind, field, mult });
  }
  tuneResetKind(): Promise<boolean> {
    this.pending.clear();
    return this.send({ t: 'tuneReset', target: this.tuneTarget, kind: this.tuneKind });
  }
  tuneResetAll(): Promise<boolean> {
    this.pending.clear();
    return this.send({ t: 'tuneReset' });
  }

  // Economy
  setUnlimited(on: boolean): Promise<boolean> {
    return this.send({ t: 'setUnlimited', on });
  }
  grantAll(): Promise<boolean> {
    return this.send({ t: 'grantResearch', all: true });
  }
  private confirming(full: boolean): boolean {
    return !!this.confirm && this.confirm.full === full && this.now() - this.confirm.at <= CONFIRM_MS;
  }
  /** First click asks for confirmation; a second click on the same button within 3 s sends. */
  reset(full: boolean): 'confirm' | 'sent' {
    if (this.confirming(full)) {
      this.confirm = null;
      void this.send({ t: 'resetSandbox', full });
      return 'sent';
    }
    this.confirm = { full, at: this.now() };
    return 'confirm';
  }
  resetLabel(full: boolean): string {
    return this.confirming(full) ? 'click again to confirm' : full ? 'Full reset' : 'Reset sandbox';
  }

  // Stats
  resetStats(): Promise<boolean> {
    return this.send({ t: 'resetStats' });
  }
}

// ---- the DOM ------------------------------------------------------------------------------------

const css = `
.sbx{left:8px;top:220px;width:340px;max-height:calc(100vh - 380px);overflow:auto;z-index:4}
.sbx .tabs{display:flex;flex-wrap:wrap;gap:1px;align-items:center}
.sbx .tabs button[data-sbx=collapse]{margin-left:auto;min-width:24px}
.sbx .tool{margin:4px 0 2px;font-size:11px;border-top:1px dashed rgba(244,239,230,.3);padding-top:3px}
.sbx h4{margin:7px 0 2px;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.sbx .row{display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin:2px 0}
.sbx table{border-collapse:collapse;width:100%;font-size:11px}
.sbx th,.sbx td{padding:1px 4px;text-align:right;font-variant-numeric:tabular-nums}
.sbx th:first-child,.sbx td:first-child{text-align:left}
.sbx th{font-weight:400;opacity:.8;border-bottom:1px solid rgba(244,239,230,.3)}
.sbx tr.zero{opacity:.5;font-style:italic}
.sbx input[type=number],.sbx select{font:inherit;color:#f4efe6;background:#2a2420;border:1px solid rgba(244,239,230,.45);border-radius:3px;padding:1px 3px}
.sbx input[type=number]{width:46px}
.sbx .field{display:grid;grid-template-columns:62px 1fr 42px;gap:4px;align-items:center;margin:3px 0}
.sbx .field .val{grid-column:1 / -1;font-size:11px;opacity:.9;margin-top:-2px}
.sbx input[type=range]{width:100%;margin:0}
.sbx .note{font-size:11px;opacity:.85}
.sbx button svg{vertical-align:middle}`;

/** What main.ts gives the panel each frame: the active tool, in words. */
export interface PanelToolState {
  name: ToolName;
  label: string;
}

/** Sets the text only when it differs (an unchanged write still replaces the text node). */
const setText = (el: Element, t: string): void => {
  if (el.textContent !== t) el.textContent = t;
};
/** Shows or hides `el`, writing style.display only when it changes. */
const setShown = (el: HTMLElement, on: boolean): void => {
  const d = on ? '' : 'none';
  if (el.style.display !== d) el.style.display = d;
};

/** The sandbox panel's DOM over a SandboxPanelModel. */
export class SandboxPanel {
  readonly el: HTMLDivElement;
  readonly model: SandboxPanelModel;
  /** Shown (sandbox snapshot). */
  shown = false;
  /** The snapshot tick the panel last drew. */
  tick = -1;
  private lastDraw = -Infinity;
  /** Redraw on the next snapshot regardless of the 4-per-second limit (a panel command resolved). */
  private dirty = true;
  private readonly body: HTMLDivElement;
  private readonly toolEl: HTMLDivElement;
  private readonly sections = new Map<PanelTab, HTMLDivElement>();
  private readonly keys = new Map<string, string>();
  private tool: PanelToolState = { name: 'select', label: '' };
  private tuneKey = '';
  /** The panel's fixed elements, looked up once (only the tune field rows are rebuilt). */
  private readonly els: ReturnType<SandboxPanel['lookUp']>;
  /** The tune field rows of the current target and kind (tuneKey), by field. */
  private readonly fieldEls = new Map<string, { slider: HTMLInputElement; mult: HTMLElement; val: HTMLElement }>();
  /** Gives keyboard focus back after a Tune control is used with the pointer (Codex review 2). */
  private readonly focus = new FocusReturn();

  constructor(sink: PanelSink, now: () => number = () => performance.now()) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    // commands resolve at their tick; the snapshot after that shows the result at once
    const marked: PanelSink = {
      send: (cmd) =>
        sink.send(cmd).then((r) => {
          this.dirty = true;
          return r;
        }),
      toast: (t, bad) => sink.toast(t, bad),
      armTool: (name) => sink.armTool(name),
    };
    this.model = new SandboxPanelModel(marked, now);
    this.el = document.createElement('div');
    this.el.className = 'pnl sbx';
    this.el.style.display = 'none';
    this.el.innerHTML = `<div class="tabs">${PANEL_TABS.map((t) => `<button data-tab="${t}">${TAB_LABELS[t]}</button>`).join('')}<button data-sbx="collapse" title="Collapse or expand the panel">–</button></div>
<div class="tool" data-sbx="tool"></div><div data-sbx="body"></div>`;
    this.body = this.el.querySelector('[data-sbx="body"]')!;
    this.toolEl = this.el.querySelector('[data-sbx="tool"]')!;
    for (const t of PANEL_TABS) {
      const sec = document.createElement('div');
      sec.dataset.section = t;
      sec.innerHTML = this.sectionHtml(t);
      this.body.appendChild(sec);
      this.sections.set(t, sec);
    }
    // Input isolation: nothing over the panel reaches the map (the canvas never sees these events,
    // and window-level listeners do not see them either).
    for (const ev of ['pointerdown', 'pointerup', 'mousedown', 'wheel', 'dblclick']) this.el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('input', (e) => this.onInput(e));
    this.el.addEventListener('change', (e) => this.onChange(e));
    this.el.addEventListener('pointerdown', (e) => this.focus.pointerDown(e.target as Focusable | null));
    this.el.addEventListener('keydown', () => this.focus.keyDown());
    // capture: a release outside the panel (a slider dragged past its end) counts too
    window.addEventListener('pointerup', () => this.focus.pointerUp(), true);
    document.body.appendChild(this.el);
    this.els = this.lookUp();
    // under the time-controls box: placed again whenever that box changes size (its status line
    // fills in and wraps after the first frames) or the window does, not on every redraw
    this.layout();
    const timec = document.querySelector('.timec');
    if (timec) new ResizeObserver(() => this.layout()).observe(timec);
    window.addEventListener('resize', () => this.layout());
  }

  private lookUp() {
    const q = <T extends Element = HTMLElement>(sel: string): T => this.el.querySelector(sel) as T;
    const all = (sel: string) => Array.from(this.el.querySelectorAll<HTMLButtonElement>(sel));
    return {
      tabs: all('button[data-tab]'),
      collapse: q('button[data-sbx="collapse"]'),
      gate: q('button[data-sbx="gate"]'),
      place: q('button[data-sbx="place"]'),
      depths: all('button[data-depth]'),
      runs: q('[data-sbx="runs"]'),
      spawnKinds: all('button[data-spawn-kind]'),
      count: q<HTMLInputElement>('input[data-sbx="count"]'),
      wave: q('[data-sbx="wave"]'),
      routes: q('button[data-sbx="routes"]'),
      tuneTargets: all('button[data-tune-target]'),
      tuneKind: q<HTMLSelectElement>('select[data-sbx="tune-kind"]'),
      fields: q('[data-sbx="fields"]'),
      unlimited: q('button[data-sbx="unlimited"]'),
      resources: q('[data-sbx="resources"]'),
      producers: q('[data-sbx="producers"]'),
      reset: q('button[data-sbx="reset"]'),
      resetFull: q('button[data-sbx="reset-full"]'),
      shooters: q('table[data-sbx="shooters"]'),
      aliens: q('table[data-sbx="aliens"]'),
    };
  }

  /** True when the screen point is over the shown panel. */
  contains(x: number, y: number): boolean {
    if (!this.shown) return false;
    const r = this.el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  /** The active map tool, in words (cheap: the DOM is touched only when it changes). */
  setTool(t: PanelToolState): void {
    if (t.name === this.tool.name && t.label === this.tool.label) return;
    this.tool = t;
    this.toolEl.textContent = t.label;
    this.drawArmed();
  }

  /** A new snapshot (or none): shown or hidden, and redrawn at most 4 times a second. */
  update(s: Snapshot | null, now: number): void {
    const shown = panelVisible(s);
    if (shown !== this.shown) {
      this.shown = shown;
      this.el.style.display = shown ? '' : 'none';
      if (shown) this.layout();
      this.dirty = true;
    }
    if (!s || !shown) return;
    this.model.snapshot = s;
    if (!this.dirty && now - this.lastDraw < 250) return;
    this.dirty = false;
    this.lastDraw = now;
    this.draw(s);
    this.tick = s.tick;
  }

  /** Under the time controls: at construction, when the panel is shown, and when the box or the window resizes. */
  private layout(): void {
    const t = document.querySelector('.timec');
    const top = t && `${Math.round(t.getBoundingClientRect().bottom + 8)}px`;
    if (top && this.el.style.top !== top) this.el.style.top = top;
  }

  private sectionHtml(t: PanelTab): string {
    switch (t) {
      case 'build':
        return `<h4>Wall run depth</h4><div class="row">${Array.from({ length: MAX_RUN_DEPTH }, (_, i) => i + 1).map((d) => `<button data-depth="${d}">${d}</button>`).join('')}<span class="note">rows (wall tool: key 1)</span></div>
<h4>Gate</h4><div class="row"><button data-sbx="gate"></button><span class="note">click a finished wall</span></div>
<h4>Wall runs</h4><div data-sbx="runs" class="note"></div>
<div class="note">Buildings: the build bar at the bottom.</div>`;
      case 'spawn':
        return `<h4>Alien</h4><div class="row">${ALIEN_KINDS.map((k, i) => `<button data-spawn-kind="${k}" data-kind-index="${i}">${alienIconSvg(k, 14)} ${ALIEN_INFO[k].label.split(' ').pop()}</button>`).join('')}</div>
<div class="row">count <button data-sbx="count-down" title="one fewer">−</button><input type="number" data-sbx="count" min="1" max="${SPAWN_AT_MAX}" step="1" value="8"><button data-sbx="count-up" title="one more">+</button><button data-sbx="place"></button></div>
<h4>Waves</h4><div class="row">wave <button data-sbx="wave-down">−</button><span data-sbx="wave"></span><button data-sbx="wave-up">+</button><button data-sbx="start-wave">Start wave</button></div>
<div class="row"><button data-sbx="clear-aliens">Clear aliens</button><button data-sbx="clear-wrecks">Clear wrecks</button><button data-sbx="routes"></button></div>`;
      case 'tune':
        return `<div class="row"><button data-tune-target="building">Buildings</button><button data-tune-target="alien">Aliens</button><button data-tune-target="unit">Units</button></div>
<div class="row">kind <select data-sbx="tune-kind"></select></div><div data-sbx="fields"></div>
<div class="row"><button data-sbx="tune-reset-kind">Reset kind</button><button data-sbx="tune-reset-all">Reset all</button></div>
<div class="note">Values are for tier 1, with research as granted.</div>`;
      case 'economy':
        return `<div class="row"><button data-sbx="unlimited"></button></div><div data-sbx="resources"></div>
<h4>Producing buildings</h4><div data-sbx="producers" class="note"></div>
<div class="row"><button data-sbx="grant-all">Grant all research</button></div>
<div class="row"><button data-sbx="reset"></button><button data-sbx="reset-full"></button></div>`;
      case 'stats':
        return `<h4>Shooters</h4><table data-sbx="shooters"></table><h4>Aliens</h4><table data-sbx="aliens"></table>
<div class="row"><button data-sbx="reset-stats">Reset stats</button></div>`;
    }
  }

  /** Sets innerHTML only when it changed (a click on a rebuilt button would be lost). */
  private html(key: string, el: Element, html: string): void {
    if (this.keys.get(key) === html) return;
    this.keys.set(key, html);
    el.innerHTML = html;
  }

  private mark(b: HTMLElement, on: boolean, text: string): void {
    const t = on ? `▸ ${text}` : text;
    if (b.textContent !== t) b.textContent = t;
    b.classList.toggle('on', on);
  }

  private drawArmed(): void {
    this.mark(this.els.gate, this.tool.name === 'gate', this.tool.name === 'gate' ? 'Gate tool — armed' : 'Gate tool');
    this.mark(this.els.place, this.tool.name === 'spawn', this.tool.name === 'spawn' ? 'Place — armed' : 'Place');
  }

  private draw(s: Snapshot): void {
    const m = this.model;
    // tabs and collapse
    const labels = m.tabLabels();
    this.els.tabs.forEach((b, i) => {
      setText(b, labels[i]!);
      b.classList.toggle('on', b.dataset.tab === m.tab);
    });
    setText(this.els.collapse, m.collapseLabel());
    setShown(this.body, !m.collapsed);
    for (const [t, sec] of this.sections) setShown(sec, t === m.tab);
    this.drawArmed();
    if (m.collapsed) return;
    if (m.tab === 'build') this.drawBuild(s);
    else if (m.tab === 'spawn') this.drawSpawn();
    else if (m.tab === 'tune') this.drawTune(s);
    else if (m.tab === 'economy') this.drawEconomy(s);
    else this.drawStats(s);
  }

  private drawBuild(s: Snapshot): void {
    for (const b of this.els.depths) this.mark(b, Number(b.dataset.depth) === this.model.depth, b.dataset.depth!);
    // builders per run: units with an order of that run in their queue
    const builders = new Map<number, number>();
    const qv = s.queues;
    const seen = new Set<number>();
    for (let r = 0; r < s.units.count; r++) {
      seen.clear();
      for (let i = qv.first[r]!, end = i + qv.count[r]!; i < end; i++) if (qv.run[i]! > 0) seen.add(qv.run[i]!);
      for (const run of seen) builders.set(run, (builders.get(run) ?? 0) + 1);
    }
    const rows: string[] = [];
    for (let i = 0; i < s.runs.length; i += 4) {
      const id = s.runs[i]!;
      if (id <= 0) continue;
      const n = builders.get(id) ?? 0;
      rows.push(`<div class="row">run ${id}: ${s.runs[i + 2]} / ${s.runs[i + 1]} tiles, ${n} ${n === 1 ? 'builder' : 'builders'} <button data-cancel-run="${id}" title="Cancel the run's remaining reserved tiles">×</button></div>`);
    }
    this.html('runs', this.els.runs, rows.length ? rows.join('') : 'none');
  }

  private drawSpawn(): void {
    const m = this.model;
    // the chosen kind carries "▸" in front of its icon and the outline
    for (const b of this.els.spawnKinds) {
      const k = b.dataset.spawnKind as AlienKind;
      const on = Number(b.dataset.kindIndex) === m.spawnKind;
      b.classList.toggle('on', on);
      this.html(`kind-${k}`, b, `${on ? '▸ ' : ''}${alienIconSvg(k, 14)} ${ALIEN_INFO[k].label.split(' ').pop()}`);
    }
    const count = this.els.count;
    if (document.activeElement !== count && count.value !== String(m.count)) count.value = String(m.count);
    setText(this.els.wave, `${m.wave} of ${WAVES}`);
    this.mark(this.els.routes, m.routes, `Show routes: ${m.routes ? 'ON' : 'OFF'}`);
  }

  private drawTune(s: Snapshot): void {
    const m = this.model;
    for (const b of this.els.tuneTargets) {
      const on = b.dataset.tuneTarget === m.tuneTarget;
      this.mark(b, on, { building: 'Buildings', alien: 'Aliens', unit: 'Units' }[b.dataset.tuneTarget as TuneTarget]);
    }
    const kinds = TUNE_KINDS[m.tuneTarget];
    const key = `${m.tuneTarget}:${m.tuneKind}`;
    const select = this.els.tuneKind;
    const labels = this.kindLabels(m.tuneTarget);
    this.html(`kinds-${m.tuneTarget}`, select, kinds.map((k, i) => `<option value="${k}">${labels[i]}</option>`).join(''));
    if (select.value !== kinds[m.tuneKind]) select.value = kinds[m.tuneKind]!;
    const fields = tuneLabels(s, m.tuneTarget, m.tuneKind);
    const box = this.els.fields;
    if (key !== this.tuneKey) {
      this.tuneKey = key;
      box.innerHTML = fields
        .map((f) => `<div class="field" data-tune-field="${f.field}"><span>${f.field}</span><input type="range" min="0" max="1000" step="1"><span class="mult"></span><span class="val"></span></div>`)
        .join('');
      this.fieldEls.clear();
      for (const el of box.querySelectorAll<HTMLElement>('[data-tune-field]'))
        this.fieldEls.set(el.dataset.tuneField!, { slider: el.querySelector<HTMLInputElement>('input[type=range]')!, mult: el.querySelector<HTMLElement>('.mult')!, val: el.querySelector<HTMLElement>('.val')! });
    }
    for (const f of fields) {
      const row = this.fieldEls.get(f.field);
      if (!row) continue;
      const shown = m.shownMult(f.field);
      if (!m.dragging(f.field)) {
        const v = String(Math.round(multToSlider(f.mult) * 1000));
        if (row.slider.value !== v) row.slider.value = v;
      }
      setText(row.mult, `${num(shown)}×`);
      const value = String(f.value);
      if (row.val.dataset.value !== value) row.val.dataset.value = value;
      setText(row.val, f.text);
    }
  }

  private kindLabels(t: TuneTarget): string[] {
    if (t === 'building') return BUILDING_KINDS.map((k) => BUILDING_INFO[k].label);
    if (t === 'alien') return ALIEN_KINDS.map((k) => ALIEN_INFO[k].label);
    return UNIT_KINDS.map((k) => UNIT_INFO[k].label);
  }

  private drawEconomy(s: Snapshot): void {
    const m = this.model;
    const g = s.globals;
    const on = g[G_UNLIMITED] === 1;
    this.mark(this.els.unlimited, on, `Free spending: ${on ? 'ON' : 'OFF'}`);
    const f = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-GB') : num(v));
    const res = `<table><tr><th></th><th>pool</th><th>income /s</th><th>spending /s</th></tr>${RESOURCE_NAMES
      .map((n, k) => `<tr><td>${n}</td><td>${f(g[G_MASS + k]!)}</td><td>${f(g[G_INCOME + k]!)}</td><td>${f(g[G_SPEND + k]!)}</td></tr>`)
      .join('')}<tr><td>parts</td><td>${f(g[G_PARTS]!)}</td><td colspan="2">made ${f(g[G_PARTS_MADE]!)}, used ${f(g[G_PARTS_USED]!)}</td></tr></table>`;
    this.html('resources', this.els.resources, res);
    const counts = new Map<number, number>();
    const c = s.buildings.cols;
    for (let r = 0; r < s.buildings.count; r++) {
      const k = c.kind[r]!;
      if (c.flags[r]! & BF_COMPLETE && buildingInfo(k).role === 'economy') counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const prod = [...counts].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${n} × ${buildingInfo(k).label}`);
    this.html('producers', this.els.producers, prod.length ? prod.join('<br>') : 'none');
    setText(this.els.reset, m.resetLabel(false));
    setText(this.els.resetFull, m.resetLabel(true));
  }

  private drawStats(s: Snapshot): void {
    const t = statsTables(s);
    const tr = (r: StatsRow) => `<tr data-row="${r.name}"${r.zero ? ' class="zero"' : ''}><td>${r.label}</td>${r.cells.map((x) => `<td>${x}</td>`).join('')}</tr>`;
    this.html('shooters', this.els.shooters, `<tr><th>kind</th><th>shots</th><th>hp removed</th><th>kills</th></tr>${t.shooters.map(tr).join('')}`);
    this.html(
      'aliens',
      this.els.aliens,
      `<tr><th>kind</th><th>spawned</th><th>killed</th><th>hp walls</th><th>hp bldgs</th><th>hp units</th></tr>${t.aliens.map(tr).join('')}<tr data-row="absorbed"><td>${t.absorbed.label}</td>${t.absorbed.cells.map((x) => `<td>${x}</td>`).join('')}</tr>`,
    );
  }

  private onClick(e: MouseEvent): void {
    e.stopPropagation();
    const b = (e.target as HTMLElement).closest('button');
    if (!b || !this.el.contains(b)) return;
    // a clicked button does not keep focus: Space then pauses rather than pressing it again
    b.blur();
    const m = this.model;
    const d = b.dataset;
    if (d.tab) m.selectTab(d.tab as PanelTab);
    else if (d.depth) m.setDepth(Number(d.depth));
    else if (d.cancelRun) void m.cancelRun(Number(d.cancelRun));
    else if (d.spawnKind) m.setSpawnKind(Number(d.kindIndex));
    else if (d.tuneTarget) m.setTuneTarget(d.tuneTarget as TuneTarget);
    else
      switch (d.sbx) {
        case 'collapse':
          m.toggleCollapse();
          break;
        case 'gate':
          m.armGate();
          break;
        case 'count-down':
          m.stepCount(-1);
          break;
        case 'count-up':
          m.stepCount(1);
          break;
        case 'place':
          m.armSpawn();
          break;
        case 'wave-down':
          m.setWave(m.wave - 1);
          break;
        case 'wave-up':
          m.setWave(m.wave + 1);
          break;
        case 'start-wave':
          void m.startWave();
          break;
        case 'clear-aliens':
          void m.clearAliens();
          break;
        case 'clear-wrecks':
          void m.clearWrecks();
          break;
        case 'routes':
          m.toggleRoutes();
          break;
        case 'tune-reset-kind':
          void m.tuneResetKind();
          break;
        case 'tune-reset-all':
          void m.tuneResetAll();
          break;
        case 'unlimited':
          void m.setUnlimited(!(m.snapshot?.globals[G_UNLIMITED] === 1));
          break;
        case 'grant-all':
          void m.grantAll();
          break;
        case 'reset':
          m.reset(false);
          break;
        case 'reset-full':
          m.reset(true);
          break;
        case 'reset-stats':
          void m.resetStats();
          break;
      }
    this.dirty = true;
    if (m.snapshot) this.update(m.snapshot, performance.now());
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLInputElement;
    const field = t.closest<HTMLElement>('[data-tune-field]')?.dataset.tuneField;
    if (field && t.type === 'range') {
      this.model.tuneDrag(field, Number(t.value) / Number(t.max));
      const el = t.closest('[data-tune-field]')!.querySelector('.mult')!;
      el.textContent = `${num(this.model.shownMult(field))}×`;
    } else if (t.dataset.sbx === 'count' && t.value.trim() !== '' && Number.isFinite(Number(t.value))) this.model.setCount(t.value);
  }

  private onChange(e: Event): void {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const field = t.closest<HTMLElement>('[data-tune-field]')?.dataset.tuneField;
    if (field && t instanceof HTMLInputElement && t.type === 'range') void this.model.tuneCommit(field);
    else if (t.dataset.sbx === 'count') {
      this.model.setCount(t.value);
      t.value = String(this.model.count);
    } else if (t.dataset.sbx === 'tune-kind') this.model.setTuneKind(Math.max(0, TUNE_KINDS[this.model.tuneTarget].indexOf(t.value as never)));
    this.focus.changed(t);
    this.dirty = true;
  }
}
